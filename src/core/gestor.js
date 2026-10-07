/**
 * Gestor de trabajos (§3, §5, §8, §9): une planificador, worktrees, recursos,
 * adaptador de opencode, runner, alcance y almacén en un ciclo de vida completo.
 *
 * Ciclo: queued -> provisioning -> running -> verifying -> succeeded | rejected | failed,
 * con `cancelled` y `lost` posibles en cualquier punto. Cada transición se persiste
 * (el almacén valida la máquina de estados) y se deja como evento del trabajo.
 *
 * POR QUÉ el gestor NO decide políticas: el planificador (puro) decide quién arranca,
 * el alcance (puro) decide qué es una violación y el perfil declara el entorno. El
 * gestor solo ejecuta esas decisiones en orden y se asegura de LIBERAR todo (recursos,
 * grupo de procesos) pase lo que pase.
 *
 * POR QUÉ el commit usa `soloArchivos`: lo que genera el comando de aceptación (cachés,
 * logs) nunca debe colarse en el commit; solo entra lo que ya pasó la verificación
 * de alcance.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { esTerminal } from './estados.js';
import { compilar } from './glob.js';
import { identidadDeProceso } from './identidad.js';
import {
  construirArgs,
  construirPrompt,
  entornoDeTrabajo,
  escribirConfigDeTrabajo,
  generarConfigDeTrabajo,
  resolverModo,
} from './opencode.js';
import { elegibles } from './planificador.js';
import { cargarPerfil, perfilPorDefecto, resolverRaizWorktrees } from './profile.js';
import { crearProveedor } from './recursos.js';
import { ejecutar } from './runner.js';
import { verificarCambios } from './scope.js';
import {
  cambiosDelWorktree,
  commitearTrabajo,
  crearWorktree,
  eliminarWorktree,
  integrar,
  raizGit,
} from './workspace.js';

/** Nombre del archivo de perfil en la raíz del repositorio objetivo. */
export const ARCHIVO_PERFIL = '.opencode-orchestrator.json';

/** Nombre del agente en línea que se genera para cada trabajo. */
const NOMBRE_AGENTE = 'orq';

const DEFECTOS = Object.freeze({
  concurrencia: 3,
  timeoutMs: 30 * 60 * 1000,
  idleTimeoutMs: 10 * 60 * 1000,
  aceptacionTimeoutMs: 10 * 60 * 1000,
  graceMs: 5000,
  esperaMaximaMs: 60 * 1000,
  modelo: 'opencode-go/deepseek-v4.1-flash',
  autor: 'opencode-orchestrator <orquestador@localhost>',
});

/** Lee el sha de HEAD de un repositorio (para la base de trabajos sin aislamiento). */
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/** Hash SHA-256 del contenido de un archivo (o `null` si no existe/no es legible). */
function hashDeArchivo(ruta) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Copia del entorno SIN las credenciales de administración de los recursos.
 *
 * POR QUÉ: la URL de administración de Postgres (`adminUrlEnv`, p. ej. ORQ_PG_ADMIN_URL) puede
 * crear y borrar CUALQUIER base. Solo la usa el gestor para provisionar; si llegara al entorno
 * del trabajo, un agente con shell podría saltarse la barrera de nombres `_test` y borrar una
 * base real. El trabajo recibe únicamente la URL de SU base (la que exporta el recurso).
 *
 * @param {NodeJS.ProcessEnv} entorno
 * @param {object} perfil
 * @returns {NodeJS.ProcessEnv}
 */
export function sinSecretosDeAdministracion(entorno, perfil) {
  const copia = { ...entorno };
  delete copia.ORQ_PG_ADMIN_URL;
  for (const recurso of Object.values(perfil?.resources ?? {})) {
    if (recurso && typeof recurso.adminUrlEnv === 'string') delete copia[recurso.adminUrlEnv];
  }
  return copia;
}

/** Error de uso del gestor (entrada inválida del cliente): se reporta tal cual, sin traza. */
export class ErrorDeGestor extends Error {
  /** @param {string} mensaje */
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorDeGestor';
  }
}

/**
 * Gestor de trabajos. Una instancia por servidor.
 */
export class Gestor {
  /**
   * @param {object} opciones
   * @param {import('./store.js').AlmacenDeTrabajos} opciones.almacen almacén persistente
   * @param {{ cmd: string, argsPrefijo?: string[] }} opciones.opencode ejecutable de opencode
   * @param {number} [opciones.concurrencia] tope de trabajos simultáneos
   * @param {NodeJS.ProcessEnv} [opciones.entornoBase] entorno heredado por los trabajos
   * @param {string} [opciones.modelo] modelo por defecto
   * @param {string} [opciones.home] home (raíz de los worktrees por defecto)
   * @param {number} [opciones.graceMs] margen SIGTERM -> SIGKILL
   * @param {number} [opciones.esperaMaximaMs] umbral anti-inanición del planificador
   * @param {Function} [opciones.ejecutarPsql] psql inyectable (tests)
   * @param {string} [opciones.autor] autor de los commits de los trabajos
   */
  constructor({
    almacen,
    opencode,
    concurrencia = DEFECTOS.concurrencia,
    entornoBase = process.env,
    modelo = DEFECTOS.modelo,
    home = os.homedir(),
    graceMs = DEFECTOS.graceMs,
    esperaMaximaMs = DEFECTOS.esperaMaximaMs,
    ejecutarPsql,
    autor = DEFECTOS.autor,
  } = {}) {
    if (!almacen) throw new ErrorDeGestor('El gestor necesita un almacén de trabajos');
    if (!opencode || typeof opencode.cmd !== 'string' || opencode.cmd === '') {
      throw new ErrorDeGestor('El gestor necesita el ejecutable de opencode ({ cmd, argsPrefijo })');
    }
    if (!Number.isInteger(concurrencia) || concurrencia < 1 || concurrencia > 16) {
      throw new ErrorDeGestor('La concurrencia debe ser un entero entre 1 y 16');
    }
    this.almacen = almacen;
    this.opencode = { cmd: opencode.cmd, argsPrefijo: opencode.argsPrefijo ?? [] };
    this.concurrencia = concurrencia;
    this.entornoBase = entornoBase;
    this.modelo = modelo;
    this.home = home;
    this.graceMs = graceMs;
    this.esperaMaximaMs = esperaMaximaMs;
    this.ejecutarPsql = ejecutarPsql;
    this.autor = autor;

    /** @type {Map<string, object>} copia en memoria de los trabajos (espejo del almacén) */
    this.trabajos = new Map();
    /** @type {string[]} ids en cola, en orden de llegada */
    this.cola = [];
    /** @type {Set<string>} ids en ejecución */
    this.corriendo = new Set();
    /** @type {Map<string, AbortController>} cancelación por trabajo */
    this.controles = new Map();
    /** @type {Map<string, Set<() => void>>} esperadores de fin de trabajo */
    this.esperadores = new Map();
    /** @type {Map<string, Promise<void>>} ejecuciones en curso (para cerrar limpiamente) */
    this.ejecuciones = new Map();
    /** @type {Map<string, { mtime: number, perfil: object }>} cache de perfiles por repo */
    this.perfiles = new Map();
    this.cerrado = false;

    for (const trabajo of this.almacen.listar().trabajos) this.trabajos.set(trabajo.id, trabajo);
  }

  // ---------------------------------------------------------------------------
  // Utilidades internas
  // ---------------------------------------------------------------------------

  /** Persiste un parche y mantiene la copia en memoria. */
  #guardar(id, parche) {
    const actualizado = this.almacen.actualizar(id, parche);
    this.trabajos.set(id, actualizado);
    return actualizado;
  }

  /** Registra un evento del trabajo (best-effort: un log roto no tumba el trabajo). */
  #evento(id, evento) {
    try {
      this.almacen.agregarEvento(id, evento);
    } catch {
      /* ignora */
    }
  }

  /** Despierta a quienes esperan el fin del trabajo. */
  #notificar(id) {
    const grupo = this.esperadores.get(id);
    if (!grupo) return;
    this.esperadores.delete(id);
    for (const despertar of grupo) despertar();
  }

  /**
   * Carga (con caché por mtime) el perfil del repo. Sin archivo: perfil por defecto
   * seguro con `baseBranch` = rama actual (el usuario no declaró otra).
   *
   * @param {string} repoRaiz
   * @returns {Promise<object>}
   * @throws {ErrorDeGestor} si el perfil es inválido
   */
  async #perfilDe(repoRaiz) {
    const archivo = path.join(repoRaiz, ARCHIVO_PERFIL);
    const nombre = path.basename(repoRaiz);
    let stat = null;
    try {
      stat = fs.statSync(archivo);
    } catch {
      /* sin archivo */
    }
    const clave = stat ? stat.mtimeMs : -1;
    const cacheado = this.perfiles.get(repoRaiz);
    if (cacheado && cacheado.mtime === clave) return cacheado.perfil;

    let perfil;
    if (stat) {
      try {
        perfil = cargarPerfil(fs.readFileSync(archivo, 'utf8'), { nombreRepo: nombre });
      } catch (error) {
        const detalle = Array.isArray(error?.errores) ? error.errores.join('; ') : error.message;
        throw new ErrorDeGestor(`Perfil inválido (${archivo}): ${detalle}`);
      }
    } else {
      perfil = perfilPorDefecto(nombre);
      try {
        const actual = await git(['symbolic-ref', '--short', '-q', 'HEAD'], repoRaiz);
        if (actual) perfil.baseBranch = actual;
      } catch {
        /* HEAD desacoplado: se queda la base por defecto */
      }
    }
    this.perfiles.set(repoRaiz, { mtime: clave, perfil });
    return perfil;
  }

  /** Rutas de worktrees y de integración de un perfil. */
  #raices(perfil) {
    const rootDir = resolverRaizWorktrees(perfil, this.home);
    return { rootDir, rootDirIntegracion: path.join(rootDir, '_integracion') };
  }

  // ---------------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------------

  /**
   * Valida y encola un trabajo.
   *
   * @param {object} spec especificación (§3)
   * @returns {Promise<object>} el trabajo creado (estado `queued`)
   * @throws {ErrorDeGestor} si la entrada es inválida
   */
  async enviar(spec = {}) {
    if (this.cerrado) throw new ErrorDeGestor('El servidor se está cerrando: no acepta trabajos nuevos');
    if (typeof spec.prompt !== 'string' || spec.prompt.trim() === '') {
      throw new ErrorDeGestor('`prompt` es obligatorio');
    }
    let modo;
    try {
      modo = spec.mode === undefined ? 'safe' : String(spec.mode).toLowerCase();
      resolverModo(modo);
    } catch (error) {
      throw new ErrorDeGestor(error.message);
    }
    if (typeof spec.cwd !== 'string' || spec.cwd.trim() === '') {
      throw new ErrorDeGestor('`cwd` es obligatorio (ruta del repositorio)');
    }
    const cwd = path.resolve(spec.cwd);
    if (!fs.existsSync(cwd)) throw new ErrorDeGestor(`cwd no existe: ${cwd}`);

    let repo;
    try {
      repo = await raizGit(cwd);
    } catch (error) {
      throw new ErrorDeGestor(error.message);
    }
    const cwdReal = fs.realpathSync(cwd);
    const relativo = path.relative(repo, cwdReal);
    if (relativo.startsWith('..') || path.isAbsolute(relativo)) {
      throw new ErrorDeGestor('cwd debe estar dentro del repositorio');
    }
    const perfil = await this.#perfilDe(repo);

    const isolation = spec.isolation === undefined ? (modo === 'readonly' ? 'none' : 'worktree') : spec.isolation;
    if (isolation !== 'worktree' && isolation !== 'none') {
      throw new ErrorDeGestor("`isolation` debe ser 'worktree' o 'none'");
    }

    const lista = (valor, campo, porDefecto) => {
      if (valor === undefined) return porDefecto;
      if (!Array.isArray(valor) || valor.some((v) => typeof v !== 'string' || v.trim() === '')) {
        throw new ErrorDeGestor(`\`${campo}\` debe ser un array de textos no vacíos`);
      }
      return valor;
    };
    const writes = modo === 'readonly' ? [] : lista(spec.writes, 'writes', []);
    if (modo === 'safe' && writes.length === 0) {
      throw new ErrorDeGestor('En modo safe `writes` es obligatorio: declará qué patrones puede modificar');
    }
    const reads = lista(spec.reads, 'reads', ['**']);
    // Fallar al ENVIAR y no más tarde: un patrón inválido (absoluto, con "..") jamás debe
    // llegar a la cola ni a la configuración del agente.
    for (const [campo, patrones] of [['writes', writes], ['reads', reads]]) {
      for (const patron of patrones) {
        try {
          compilar(patron);
        } catch (error) {
          throw new ErrorDeGestor(`\`${campo}\` contiene un patrón inválido (${patron}): ${error.message}`);
        }
      }
    }
    const resources = lista(spec.resources, 'resources', []);
    for (const nombre of resources) {
      if (!perfil.resources || !Object.hasOwn(perfil.resources, nombre)) {
        throw new ErrorDeGestor(`Recurso desconocido '${nombre}' (el perfil declara: ${Object.keys(perfil.resources ?? {}).join(', ') || 'ninguno'})`);
      }
    }
    const after = lista(spec.after, 'after', []);
    for (const dep of after) {
      if (!this.trabajos.has(dep)) throw new ErrorDeGestor(`after: no existe el trabajo '${dep}'`);
    }
    const files = lista(spec.files, 'files', []);

    // Aceptación: clave del perfil o comando literal; sin nada, la de 'default' si existe.
    let aceptacion = null;
    if (spec.accept !== undefined && spec.accept !== null && spec.accept !== '') {
      if (typeof spec.accept !== 'string') throw new ErrorDeGestor('`accept` debe ser un texto');
      aceptacion = Object.hasOwn(perfil.accept ?? {}, spec.accept) ? perfil.accept[spec.accept] : spec.accept;
    } else if (perfil.accept && typeof perfil.accept.default === 'string') {
      aceptacion = perfil.accept.default;
    }

    const num = (valor, nombre, porDefecto) => {
      if (valor === undefined || valor === null) return porDefecto;
      if (!Number.isFinite(valor) || valor < 0) throw new ErrorDeGestor(`\`${nombre}\` debe ser un número no negativo`);
      return valor;
    };

    const trabajo = this.almacen.crear({
      estado: 'queued',
      titulo: typeof spec.title === 'string' ? spec.title.slice(0, 120) : spec.prompt.trim().split('\n')[0].slice(0, 80),
      prompt: spec.prompt,
      cwd: cwdReal,
      cwdRelativo: relativo,
      repo,
      repoNombre: perfil.name,
      mode: modo,
      isolation,
      reads,
      writes,
      resources,
      after,
      files,
      aceptacion,
      modelo: spec.model ?? this.modelo,
      prioridad: Number.isFinite(spec.prioridad) ? spec.prioridad : 0,
      timeoutMs: num(spec.timeout_ms, 'timeout_ms', DEFECTOS.timeoutMs),
      idleTimeoutMs: num(spec.idle_timeout_ms, 'idle_timeout_ms', DEFECTOS.idleTimeoutMs),
      encoladoEn: Date.now(),
    });
    this.trabajos.set(trabajo.id, trabajo);
    this.cola.push(trabajo.id);
    this.almacen.auditar({ accion: 'enviar', id: trabajo.id, mode: modo, isolation, writes, cwd: cwdReal, prompt: spec.prompt });
    this.#evento(trabajo.id, { tipo: 'encolado' });
    this.#bombear();
    return trabajo;
  }

  /** Lanza los trabajos que el planificador declara elegibles. */
  #bombear() {
    if (this.cerrado) return;
    const recursos = {};
    for (const id of [...this.cola, ...this.corriendo]) {
      for (const nombre of this.trabajos.get(id)?.resources ?? []) recursos[nombre] = this.concurrencia;
    }
    const { arrancar, bloqueados } = elegibles({
      cola: this.cola,
      corriendo: [...this.corriendo],
      concurrencia: this.concurrencia,
      trabajos: this.trabajos,
      ahora: Date.now(),
      recursos,
      serializarEscrituras: true,
      esperaMaximaMs: this.esperaMaximaMs,
    });

    for (const { id, motivo } of bloqueados) {
      this.cola = this.cola.filter((x) => x !== id);
      this.#guardar(id, { estado: 'cancelled', motivoFin: 'dependencia_fallida', detalleFin: motivo });
      this.#evento(id, { tipo: 'cancelado', motivo: 'dependencia_fallida' });
      this.#notificar(id);
    }
    for (const id of arrancar) {
      this.cola = this.cola.filter((x) => x !== id);
      this.corriendo.add(id);
      const ctl = new AbortController();
      this.controles.set(id, ctl);
      const ejecucion = this.#ejecutar(id, ctl).finally(() => {
        this.corriendo.delete(id);
        this.controles.delete(id);
        this.ejecuciones.delete(id);
        this.#notificar(id);
        this.#bombear();
      });
      this.ejecuciones.set(id, ejecucion);
    }
  }

  /**
   * Pipeline completo de un trabajo. NUNCA lanza: cualquier error termina el trabajo
   * en `failed` con el mensaje, y los recursos se liberan siempre.
   */
  async #ejecutar(id, ctl) {
    const liberadores = [];
    try {
      // Primero la transición: desde 'queued' solo se puede ir a provisioning o cancelled,
      // así que cualquier error posterior (p. ej. un perfil inválido) puede terminar en failed.
      this.#guardar(id, { estado: 'provisioning' });
      this.#evento(id, { tipo: 'provisionando' });
      const job = this.trabajos.get(id);
      const perfil = await this.#perfilDe(job.repo);
      const { rootDir } = this.#raices(perfil);
      const rutas = this.almacen.rutasDeLogs(id);

      // 1) Espacio de trabajo
      let raizTrabajo = job.repo;
      let baseCommit;
      let enlaces = [];
      /** Archivos ya modificados en el árbol real ANTES de empezar (solo sin aislamiento). */
      const previos = new Map();
      if (job.isolation === 'worktree') {
        const wt = await crearWorktree({
          repoRaiz: job.repo,
          base: perfil.baseBranch,
          jobId: id,
          rootDir,
          link: perfil.worktrees.link,
          setup: perfil.worktrees.setup,
          env: { ...perfil.env },
          signal: ctl.signal,
        });
        raizTrabajo = wt.ruta;
        baseCommit = wt.baseCommit;
        enlaces = wt.enlacesCreados ?? [];
        this.#guardar(id, { worktree: wt.ruta, rama: wt.rama, baseCommit, enlacesCreados: enlaces });
      } else {
        baseCommit = await git(['rev-parse', 'HEAD'], job.repo);
        const antes = await cambiosDelWorktree({ ruta: job.repo, baseCommit });
        for (const archivo of antes.archivos) previos.set(archivo, hashDeArchivo(path.join(job.repo, archivo)));
        this.#guardar(id, { baseCommit });
      }
      if (ctl.signal.aborted) return this.#terminar(id, 'cancelled', { motivoFin: 'cancelado' });
      const cwdTrabajo = path.join(raizTrabajo, job.cwdRelativo);

      // Con aislamiento, el árbol REAL no debería cambiar mientras el trabajo corre: si
      // cambia, el agente pudo salir del worktree (p. ej. con una ruta absoluta por shell).
      // Es una ADVERTENCIA, no un rechazo: una edición manual del usuario produce lo mismo.
      const arbolRealAntes = job.isolation === 'worktree' ? await this.#instantaneaDelArbolReal(job.repo) : null;

      // 2) Recursos exclusivos por trabajo
      const envRecursos = {};
      for (const nombre of job.resources) {
        const proveedor = crearProveedor(perfil.resources[nombre], {
          env: this.entornoBase,
          ejecutarPsql: this.ejecutarPsql,
        });
        const recurso = await proveedor.provisionar({ id });
        liberadores.push(recurso.liberar);
        Object.assign(envRecursos, recurso.env);
      }
      if (ctl.signal.aborted) return this.#terminar(id, 'cancelled', { motivoFin: 'cancelado' });

      // 3) Configuración del agente (alcance) y entorno
      const protegidos = perfil.protected ?? [];
      const config = generarConfigDeTrabajo({
        modo: job.mode,
        writes: job.writes,
        protegidos,
        modelo: job.modelo,
        nombreAgente: NOMBRE_AGENTE,
      });
      const rutaConfig = escribirConfigDeTrabajo(rutas.dir, config);
      const entorno = entornoDeTrabajo({
        rutaConfig,
        base: {
          ...sinSecretosDeAdministracion(this.entornoBase, perfil),
          ...perfil.env,
          ...envRecursos,
          ORQ_JOB_ID: id,
          ORQ_WORKTREE: raizTrabajo,
          ORQ_BRANCH: this.trabajos.get(id).rama ?? '',
        },
      });
      const prompt = construirPrompt({
        prompt: job.prompt,
        modo: job.mode,
        writes: job.writes,
        reads: job.reads,
        protegidos,
        rutaTrabajo: cwdTrabajo,
      });
      const args = construirArgs({
        prompt,
        modo: job.mode,
        modelo: job.modelo,
        files: job.files,
        agente: NOMBRE_AGENTE,
      });

      // 4) Ejecución de opencode
      this.#guardar(id, { estado: 'running' });
      this.#evento(id, { tipo: 'ejecutando' });
      const resultadoProceso = await ejecutar({
        cmd: this.opencode.cmd,
        args: [...this.opencode.argsPrefijo, ...args],
        cwd: cwdTrabajo,
        env: entorno,
        stdoutPath: rutas.stdout,
        stderrPath: rutas.stderr,
        timeoutMs: job.timeoutMs,
        idleTimeoutMs: job.idleTimeoutMs,
        graceMs: this.graceMs,
        signal: ctl.signal,
        // Persistir el grupo y su identidad SIN ventana de pérdida (S1).
        onLanzado: ({ pid, pgid }) => {
          try {
            this.#guardar(id, { pid, pgid, identidad: identidadDeProceso(pgid) });
          } catch {
            /* el trabajo sigue; el reinicio lo marcará perdido */
          }
        },
      });
      const proceso = {
        motivo: resultadoProceso.motivo,
        exit: resultadoProceso.code,
        senal: resultadoProceso.signal,
        duracionMs: resultadoProceso.duracionMs,
      };
      this.#evento(id, { tipo: 'proceso_terminado', ...proceso });

      if (resultadoProceso.motivo === 'cancelado') return this.#terminar(id, 'cancelled', { proceso, motivoFin: 'cancelado' });
      if (resultadoProceso.motivo === 'timeout' || resultadoProceso.motivo === 'idle') {
        return this.#terminar(id, 'failed', { proceso, motivoFin: resultadoProceso.motivo });
      }
      if (resultadoProceso.motivo === 'error_al_lanzar') {
        return this.#terminar(id, 'failed', { proceso, motivoFin: 'error_al_lanzar', error: resultadoProceso.mensaje });
      }
      if (resultadoProceso.code !== 0) {
        return this.#terminar(id, 'failed', { proceso, motivoFin: 'exit_distinto_de_cero' });
      }

      // 5) Verificación de alcance (la garantía real, §4)
      this.#guardar(id, { estado: 'verifying' });
      this.#evento(id, { tipo: 'verificando' });
      const { archivos, resumen } = await cambiosDelWorktree({ ruta: raizTrabajo, baseCommit, ignorar: enlaces });
      const archivosTrabajo = archivos.filter((archivo) => {
        if (!previos.has(archivo)) return true;
        return hashDeArchivo(path.join(raizTrabajo, archivo)) !== previos.get(archivo);
      });
      const alcance = verificarCambios({
        archivosCambiados: archivosTrabajo,
        writes: job.writes,
        protegidos,
        modo: job.mode,
      });
      const advertencias = [];
      if (arbolRealAntes) {
        const tocados = await this.#cambiosEnElArbolReal(job.repo, arbolRealAntes);
        if (tocados.length > 0) {
          advertencias.push(
            `El árbol principal cambió mientras corría el trabajo (${tocados.slice(0, 10).join(', ')}` +
              `${tocados.length > 10 ? `, +${tocados.length - 10} más` : ''}): el agente pudo salir del worktree; ` +
              'también puede deberse a una edición manual o a otro trabajo sin aislamiento. Revisalo.',
          );
        }
      }
      if (!alcance.ok) {
        return this.#terminar(id, 'rejected', {
          proceso,
          archivos: archivosTrabajo,
          resumen,
          violaciones: alcance.violaciones,
          advertencias,
          motivoFin: 'alcance',
        });
      }

      // 6) Aceptación
      let aceptado = { cmd: null, ejecutada: false };
      if (job.aceptacion) {
        const salida = await ejecutar({
          cmd: '/bin/sh',
          args: ['-c', job.aceptacion],
          cwd: cwdTrabajo,
          env: entorno,
          stdoutPath: path.join(rutas.dir, 'aceptacion.log'),
          stderrPath: path.join(rutas.dir, 'aceptacion.err.log'),
          timeoutMs: DEFECTOS.aceptacionTimeoutMs,
          graceMs: this.graceMs,
          signal: ctl.signal,
        });
        aceptado = {
          cmd: job.aceptacion,
          ejecutada: true,
          exit: salida.code,
          motivo: salida.motivo,
          cola: leerColaArchivo(path.join(rutas.dir, 'aceptacion.log'), 2000),
        };
        if (salida.motivo === 'cancelado') return this.#terminar(id, 'cancelled', { proceso, motivoFin: 'cancelado', aceptacion: aceptado });
        if (salida.motivo !== 'exit' || salida.code !== 0) {
          return this.#terminar(id, 'rejected', {
            proceso,
            archivos: archivosTrabajo,
            resumen,
            aceptacion: aceptado,
            advertencias,
            motivoFin: 'aceptacion',
          });
        }
      }

      // 7) Commit SOLO de lo verificado (con aislamiento) y fin
      let commit = null;
      if (job.isolation === 'worktree') {
        commit = await commitearTrabajo({
          ruta: raizTrabajo,
          mensaje: `orq(${id}): ${job.titulo}`,
          autor: this.autor,
          soloArchivos: archivosTrabajo,
        });
      }
      return this.#terminar(id, 'succeeded', {
        proceso,
        archivos: archivosTrabajo,
        resumen,
        aceptacion: aceptado,
        advertencias,
        commit,
      });
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      try {
        const actual = this.trabajos.get(id);
        if (actual && !esTerminal(actual.estado)) {
          this.#terminar(id, ctl.signal.aborted ? 'cancelled' : 'failed', {
            motivoFin: ctl.signal.aborted ? 'cancelado' : 'error_interno',
            error: mensaje,
          });
        }
      } catch {
        /* nada más que hacer */
      }
    } finally {
      for (const liberar of liberadores.reverse()) {
        try {
          await liberar();
        } catch (error) {
          this.#evento(id, { tipo: 'error_al_liberar_recurso', error: String(error?.message ?? error) });
        }
      }
    }
  }

  /** Foto del árbol REAL (archivos modificados y su hash) para detectar escapes del worktree. */
  async #instantaneaDelArbolReal(repo) {
    try {
      const head = await git(['rev-parse', 'HEAD'], repo);
      const { archivos } = await cambiosDelWorktree({ ruta: repo, baseCommit: head });
      return { head, hashes: new Map(archivos.map((a) => [a, hashDeArchivo(path.join(repo, a))])) };
    } catch {
      return null; // sin foto no hay comparación: no se advierte nada
    }
  }

  /** Archivos del árbol real que cambiaron respecto de una foto anterior. */
  async #cambiosEnElArbolReal(repo, antes) {
    const ahora = await this.#instantaneaDelArbolReal(repo);
    if (!ahora) return [];
    const cambios = [];
    if (ahora.head !== antes.head) cambios.push('(HEAD movido)');
    for (const [archivo, hash] of ahora.hashes) {
      if (!antes.hashes.has(archivo) || antes.hashes.get(archivo) !== hash) cambios.push(archivo);
    }
    for (const archivo of antes.hashes.keys()) if (!ahora.hashes.has(archivo)) cambios.push(archivo);
    return cambios;
  }

  /** Cierra el trabajo en un estado terminal persistiendo el resultado. */
  #terminar(id, estado, datos = {}) {
    const actual = this.trabajos.get(id);
    if (!actual || esTerminal(actual.estado)) return;
    this.#guardar(id, { estado, resultado: datos, motivoFin: datos.motivoFin ?? null, error: datos.error ?? null });
    this.#evento(id, { tipo: 'fin', estado, motivo: datos.motivoFin ?? null });
    this.almacen.auditar({ accion: 'fin', id, estado, motivo: datos.motivoFin ?? null });
  }

  /**
   * Espera hasta `ms` a que el trabajo termine.
   * @param {string} id
   * @param {number} ms
   * @returns {Promise<object|null>} el trabajo terminado, o `null` si sigue activo
   */
  esperar(id, ms) {
    const trabajo = this.trabajos.get(id);
    if (!trabajo) return Promise.reject(new ErrorDeGestor(`No existe el trabajo '${id}'`));
    if (esTerminal(trabajo.estado)) return Promise.resolve(trabajo);
    return new Promise((resolve) => {
      let hecho = false;
      const fin = () => {
        if (hecho) return;
        hecho = true;
        clearTimeout(temporizador);
        // Si venció por tiempo el cierre sigue registrado: se quita para que los sondeos
        // repetidos (opencode_wait cada ~45 s) no acumulen esperadores sin límite.
        const grupo = this.esperadores.get(id);
        if (grupo) {
          grupo.delete(fin);
          if (grupo.size === 0) this.esperadores.delete(id);
        }
        resolve(esTerminal(this.trabajos.get(id)?.estado) ? this.trabajos.get(id) : null);
      };
      const temporizador = setTimeout(fin, Math.max(0, ms));
      if (!this.esperadores.has(id)) this.esperadores.set(id, new Set());
      this.esperadores.get(id).add(fin);
    });
  }

  /** @param {string} id @returns {object} */
  obtener(id) {
    const trabajo = this.trabajos.get(id);
    if (!trabajo) throw new ErrorDeGestor(`No existe el trabajo '${id}'`);
    return trabajo;
  }

  /**
   * Cancela un trabajo: en cola se descarta; en ejecución mata el grupo de procesos.
   * @param {string} id
   * @returns {Promise<object>} el trabajo tras cancelarlo (o tal cual si ya terminó)
   */
  async cancelar(id) {
    const trabajo = this.obtener(id);
    if (esTerminal(trabajo.estado)) return trabajo;
    if (trabajo.estado === 'queued' && this.cola.includes(id)) {
      this.cola = this.cola.filter((x) => x !== id);
      this.#guardar(id, { estado: 'cancelled', motivoFin: 'cancelado_en_cola' });
      this.#evento(id, { tipo: 'cancelado', motivo: 'cancelado_en_cola' });
      this.#notificar(id);
      this.#bombear();
      return this.trabajos.get(id);
    }
    this.controles.get(id)?.abort();
    const fin = await this.esperar(id, 15000);
    return fin ?? this.trabajos.get(id);
  }

  /** Lista los trabajos (más recientes primero) con filtro opcional por estado. */
  listar({ estado, limite = 50 } = {}) {
    let lista = [...this.trabajos.values()].sort((a, b) => (b.creadoEn ?? 0) - (a.creadoEn ?? 0));
    if (estado) lista = lista.filter((t) => t.estado === estado);
    return lista.slice(0, limite);
  }

  /** Resumen de carga del gestor. */
  resumen() {
    return {
      concurrencia: this.concurrencia,
      corriendo: [...this.corriendo],
      enCola: [...this.cola],
    };
  }

  /** Cola de un log del trabajo. */
  logs(id, canal = 'stdout', bytes = 4000) {
    this.obtener(id);
    return this.almacen.leerCola(id, canal, bytes);
  }

  /** Cola del log de la aceptación de un trabajo. */
  logsAceptacion(id, bytes = 4000) {
    this.obtener(id);
    return leerColaArchivo(path.join(this.almacen.rutasDeLogs(id).dir, 'aceptacion.log'), bytes);
  }

  /**
   * Integra un trabajo `succeeded` en la rama de integración del perfil (§9).
   * @param {string} id
   * @returns {Promise<{ ok: boolean, sha?: string, conflictos?: string[], motivo?: string }>}
   */
  async integrar(id) {
    const trabajo = this.obtener(id);
    if (trabajo.estado !== 'succeeded') {
      throw new ErrorDeGestor(`Solo se integran trabajos succeeded (este está ${trabajo.estado})`);
    }
    if (trabajo.isolation !== 'worktree' || !trabajo.rama) {
      throw new ErrorDeGestor('Este trabajo no tiene rama propia: nada que integrar');
    }
    if (!trabajo.resultado?.commit) {
      throw new ErrorDeGestor('El trabajo no produjo ningún commit: nada que integrar');
    }
    if ((trabajo.resultado.violaciones ?? []).length > 0) {
      throw new ErrorDeGestor('El trabajo tiene violaciones de alcance: no se integra');
    }
    const perfil = await this.#perfilDe(trabajo.repo);
    const { rootDirIntegracion } = this.#raices(perfil);
    const resultado = await integrar({
      repoRaiz: trabajo.repo,
      rama: trabajo.rama,
      integrationBranch: perfil.integrationBranch,
      base: perfil.baseBranch,
      rootDirIntegracion,
    });
    if (resultado.ok) {
      this.#guardar(id, { estado: 'merged', integradoSha: resultado.sha, integradoEn: perfil.integrationBranch });
      this.#evento(id, { tipo: 'integrado', sha: resultado.sha, rama: perfil.integrationBranch });
      this.almacen.auditar({ accion: 'integrar', id, sha: resultado.sha, rama: perfil.integrationBranch });
      return { ok: true, sha: resultado.sha, rama: perfil.integrationBranch };
    }
    this.#evento(id, { tipo: 'integracion_con_conflictos', conflictos: resultado.conflictos });
    return { ok: false, conflictos: resultado.conflictos };
  }

  /**
   * Elimina worktrees y ramas de trabajos terminados.
   * @param {{ ids?: string[], antiguedadMs?: number }} [opciones]
   * @returns {Promise<string[]>} ids limpiados
   */
  async limpiar({ ids, antiguedadMs = 0 } = {}) {
    const limpiados = [];
    const ahora = Date.now();
    for (const trabajo of [...this.trabajos.values()]) {
      if (!esTerminal(trabajo.estado) || !trabajo.worktree || trabajo.limpiado) continue;
      if (ids && !ids.includes(trabajo.id)) continue;
      if (ahora - (trabajo.finEn ?? 0) < antiguedadMs) continue;
      const perfil = await this.#perfilDe(trabajo.repo);
      const { rootDir } = this.#raices(perfil);
      try {
        await eliminarWorktree({ repoRaiz: trabajo.repo, ruta: trabajo.worktree, rama: trabajo.rama, borrarRama: true, rootDir });
        this.#guardar(trabajo.id, { limpiado: true });
        limpiados.push(trabajo.id);
      } catch (error) {
        this.#evento(trabajo.id, { tipo: 'error_al_limpiar', error: String(error?.message ?? error) });
      }
    }
    return limpiados;
  }

  /**
   * Perfil resuelto de un repositorio (para la herramienta `opencode_profile`).
   * @param {string} cwd
   * @returns {Promise<{ repo: string, archivo: string, existe: boolean, perfil: object }>}
   * @throws {ErrorDeGestor} si cwd no es un repo o el perfil es inválido
   */
  async verPerfil(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '') throw new ErrorDeGestor("`cwd` es obligatorio");
    let repo;
    try {
      repo = await raizGit(path.resolve(cwd));
    } catch (error) {
      throw new ErrorDeGestor(error.message);
    }
    const perfil = await this.#perfilDe(repo);
    const archivo = path.join(repo, ARCHIVO_PERFIL);
    return { repo, archivo, existe: fs.existsSync(archivo), perfil };
  }

  /**
   * Mata SIN esperar y de forma SÍNCRONA los grupos de procesos de los trabajos que
   * corren. Es la última red de seguridad (se invoca desde el evento `exit` del
   * proceso, donde ya no se puede esperar): evita dejar huérfanos si el servidor cae.
   */
  matarTodoSincrono() {
    for (const id of this.corriendo) {
      const pgid = this.trabajos.get(id)?.pgid;
      if (!Number.isInteger(pgid) || pgid <= 0) continue;
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* ya no existe */
      }
    }
  }

  /**
   * Cierre ordenado: no acepta más trabajos, descarta la cola y cancela lo que corre
   * (matando los grupos) esperando a que liberen sus recursos.
   * @param {number} [esperaMs=20000]
   */
  async cerrar(esperaMs = 20000) {
    this.cerrado = true;
    for (const id of [...this.cola]) {
      this.#guardar(id, { estado: 'cancelled', motivoFin: 'servidor_cerrado' });
      this.#notificar(id);
    }
    this.cola = [];
    for (const ctl of this.controles.values()) ctl.abort();
    await Promise.race([
      Promise.allSettled([...this.ejecuciones.values()]),
      new Promise((resolve) => setTimeout(resolve, esperaMs)),
    ]);
  }
}

/** Últimos `bytes` de un archivo de texto (vacío si no existe). */
function leerColaArchivo(ruta, bytes) {
  try {
    const fd = fs.openSync(ruta, 'r');
    try {
      const tamano = fs.fstatSync(fd).size;
      const aLeer = Math.min(bytes, tamano);
      if (aLeer === 0) return '';
      const buffer = Buffer.alloc(aLeer);
      fs.readSync(fd, buffer, 0, aLeer, tamano - aLeer);
      let inicio = 0;
      while (inicio < buffer.length && (buffer[inicio] & 0xc0) === 0x80) inicio += 1;
      return buffer.subarray(inicio).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
