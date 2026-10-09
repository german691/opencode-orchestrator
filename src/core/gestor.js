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
import { aRutaDelServidor } from '../rutas.js';
import {
  construirArgs,
  construirPrompt,
  entornoDeTrabajo,
  escribirConfigDeTrabajo,
  generarConfigDeTrabajo,
  resolverModo,
} from './opencode.js';
import { resumirFallos } from './fallos.js';
import { leerManifiesto, ejecutarMutaciones, nombreManifiesto } from './mutaciones.js';
import { ejecutarParalelo, normalizarParalelo } from './paralelo.js';
import { elegibles } from './planificador.js';
import { cargarPerfil, perfilPorDefecto, resolverRaizWorktrees } from './profile.js';
import { decidirReanudacion, esFalloDeTransporte, textoAdvertencia } from './reanudacion.js';
import { crearProveedor } from './recursos.js';
import { ejecutar } from './runner.js';
import { verificarCambios, escriturasEnRutaProtegida } from './scope.js';
import {
  cambiosDelWorktree,
  commitearTrabajo,
  crearWorktree,
  avanzarBase,
  eliminarWorktree,
  integrar,
  raizGit,
  sincronizarIntegracion,
  trasladarCambios,
} from './workspace.js';

/** Nombre del archivo de perfil en la raíz del repositorio objetivo. */
export const ARCHIVO_PERFIL = '.opencode-orchestrator.json';

/** Nombre del agente en línea que se genera para cada trabajo. */
const NOMBRE_AGENTE = 'orq';

const DEFECTOS = Object.freeze({
  concurrencia: 3,
  // Cada cuánto se revisa si el agente se salió del alcance mientras trabaja (0 = no vigilar).
  vigilanciaAlcanceMs: 30 * 1000,
  // Minutos sin escribir NADA tras los cuales se corta al agente (0 = sin límite).
  sinProgresoMs: 10 * 60 * 1000,
  timeoutMs: 30 * 60 * 1000,
  idleTimeoutMs: 10 * 60 * 1000,
  aceptacionTimeoutMs: 10 * 60 * 1000,
  graceMs: 5000,
  esperaMaximaMs: 60 * 1000,
  modelo: 'opencode-go/deepseek-v4.1-flash',
  autor: 'opencode-orchestrator <orquestador@localhost>',
});

/** Tope de salida que se acumula de un comando de mutación para un eventual diagnóstico. */
const TOPE_SALIDA_COMANDO = 8000;

/**
 * ¿Es una aceptación válida? Un comando literal (texto) o una compuerta en fragmentos (objeto
 * `{ paralelo }`). Se usa para elegir la aceptación por defecto del perfil sin romper strings.
 * @param {unknown} valor
 * @returns {boolean}
 */
function esAceptacionValida(valor) {
  return typeof valor === 'string' || (valor !== null && typeof valor === 'object' && !Array.isArray(valor));
}

/**
 * Recurso que consume una aceptación paralela (`{ paralelo: { recurso } }`), o `null`.
 * Ese recurso se provisiona por fragmento, no como instancia única del trabajo.
 * @param {unknown} aceptacion
 * @returns {string|null}
 */
function recursoDeAceptacionParalela(aceptacion) {
  if (!aceptacion || typeof aceptacion !== 'object' || Array.isArray(aceptacion)) return null;
  const recurso = aceptacion.paralelo?.recurso;
  return typeof recurso === 'string' && recurso !== '' ? recurso : null;
}

/** Mensaje legible de un error cualquiera. */
function mensajeDeError(error) {
  return error instanceof Error ? error.message : String(error);
}

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
   * @param {{ registrar: (ev: object) => boolean, listar: (f?: object) => object[] }} [opciones.registro] registro global de eventos (auditoría)
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
    vigilanciaAlcanceMs = DEFECTOS.vigilanciaAlcanceMs,
    sinProgresoMs,
    ejecutarPsql,
    autor = DEFECTOS.autor,
    registro = null,
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
    this.vigilanciaAlcanceMs = vigilanciaAlcanceMs;
    // Registro global de auditoría (opcional): si falta, registrar es un no-op.
    this.registro = registro;
    // undefined = rige el del perfil (o el por defecto); los tests lo acortan.
    this.sinProgresoMs = sinProgresoMs;

    /** @type {Map<string, object>} copia en memoria de los trabajos (espejo del almacén) */
    this.trabajos = new Map();
    /** @type {string[]} ids en cola, en orden de llegada */
    this.cola = [];
    /** @type {Set<string>} ids en ejecución */
    this.corriendo = new Set();
    /** @type {Map<string, AbortController>} cancelación por trabajo */
    this.controles = new Map();
    /** @type {Map<string, string>} actor que pidió la cancelación de un trabajo en curso */
    this.actores = new Map();
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

  /**
   * Persiste un parche y mantiene la copia en memoria. Si el parche CAMBIA el
   * estado, deja constancia en el registro global de auditoría (`job.estado`):
   * centralizarlo acá cubre todas las transiciones sin repetir la llamada.
   */
  #guardar(id, parche, actor = 'servidor') {
    const previo = this.trabajos.get(id);
    const actualizado = this.almacen.actualizar(id, parche);
    this.trabajos.set(id, actualizado);
    if (parche && parche.estado !== undefined && parche.estado !== previo?.estado) {
      this.#evento({
        tipo: 'job.estado',
        jobId: id,
        estado: actualizado.estado,
        anterior: previo?.estado ?? null,
        actor,
      });
    }
    return actualizado;
  }

  /** Registra un evento del trabajo (best-effort: un log roto no tumba el trabajo). */
  #eventoDeTrabajo(id, evento) {
    try {
      this.almacen.agregarEvento(id, evento);
    } catch {
      /* ignora */
    }
  }

  /**
   * Registra un evento en el registro global de auditoría. Best-effort: la
   * observabilidad NUNCA debe frenar la operación que se intenta registrar (el
   * registro devuelve `false` ante un fallo de E/S; un tipo inválido no debería
   * llegar acá, pero tampoco puede tumbar el trabajo).
   */
  #evento(evento) {
    if (!this.registro) return;
    try {
      this.registro.registrar(evento);
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
   * @param {{ actor?: string }} [opciones] `actor` del evento de auditoría (p. ej. `herramienta:coding`)
   * @returns {Promise<object>} el trabajo creado (estado `queued`)
   * @throws {ErrorDeGestor} si la entrada es inválida
   */
  async enviar(spec = {}, { actor = 'servidor' } = {}) {
    if (this.cerrado) throw new ErrorDeGestor('El servidor se está cerrando: no acepta trabajos nuevos');
    // `solo_aceptacion`: no corre al agente, solo la aceptación sobre un worktree (compuerta sobre la
    // integración, o re-verificación de un trabajo rechazado ya arreglado). No necesita prompt.
    // Algunos clientes con el esquema de la herramienta en caché mandan los booleanos como texto
    // ("true"): se aceptan, o `solo_aceptacion` se ignoraría y correría al agente sin querer.
    const soloAceptacion = spec.solo_aceptacion === true || spec.solo_aceptacion === 'true';
    if (soloAceptacion && (typeof spec.prompt !== 'string' || spec.prompt.trim() === '')) {
      spec = { ...spec, prompt: 'Solo aceptación (no se ejecuta el agente).' };
    }
    if (typeof spec.prompt !== 'string' || spec.prompt.trim() === '') {
      throw new ErrorDeGestor('`prompt` es obligatorio');
    }
    if (spec.base !== undefined && spec.base !== 'base' && spec.base !== 'integracion') {
      throw new ErrorDeGestor("`base` debe ser 'base' o 'integracion'");
    }
    // `desde_job`: retoma el trabajo de otro (rechazado o caído) sin repetir al agente: el worktree
    // nuevo parte del mismo commit base y recibe los archivos que dejó el anterior.
    let origen = null;
    if (spec.desde_job !== undefined && spec.desde_job !== null) {
      origen = this.trabajos.get(String(spec.desde_job)) ?? null;
      if (!origen) throw new ErrorDeGestor(`desde_job: no existe el trabajo '${spec.desde_job}'`);
      if (!esTerminal(origen.estado)) {
        throw new ErrorDeGestor(`desde_job: el trabajo '${origen.id}' sigue ${origen.estado}; esperá a que termine`);
      }
      if (origen.isolation !== 'worktree' || !origen.worktree || origen.limpiado || !fs.existsSync(origen.worktree)) {
        throw new ErrorDeGestor(`desde_job: el trabajo '${origen.id}' no conserva su worktree (¿ya se limpió?)`);
      }
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
    const cwd = path.resolve(aRutaDelServidor(spec.cwd));
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

    // Solo-aceptación y retomar un trabajo necesitan SIEMPRE un worktree propio.
    const exigeWorktree = soloAceptacion || origen !== null;
    const isolation = spec.isolation === undefined ? (modo === 'readonly' && !exigeWorktree ? 'none' : 'worktree') : spec.isolation;
    if (isolation !== 'worktree' && isolation !== 'none') {
      throw new ErrorDeGestor("`isolation` debe ser 'worktree' o 'none'");
    }
    if (exigeWorktree && isolation !== 'worktree') {
      throw new ErrorDeGestor('`solo_aceptacion` y `desde_job` requieren isolation: worktree');
    }

    const lista = (valor, campo, porDefecto) => {
      if (valor === undefined) return porDefecto;
      if (!Array.isArray(valor) || valor.some((v) => typeof v !== 'string' || v.trim() === '')) {
        throw new ErrorDeGestor(`\`${campo}\` debe ser un array de textos no vacíos`);
      }
      return valor;
    };
    // Retomar un trabajo hereda su alcance si el envío no declara otro.
    const writes = modo === 'readonly' ? [] : lista(spec.writes, 'writes', origen?.writes ?? []);
    if (modo === 'safe' && writes.length === 0 && !(soloAceptacion && origen === null)) {
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
    // Un `writes` que cae dentro de una ruta protegida nunca se podría integrar: se rechaza
    // acá, antes de gastar una corrida entera del agente y de la aceptación.
    const choques = escriturasEnRutaProtegida(writes, perfil.protected ?? []);
    if (choques.length > 0) {
      const detalle = choques.map((c) => `\`${c.write}\` (protegido por \`${c.protegido}\`)`).join(', ');
      throw new ErrorDeGestor(
        `\`writes\` apunta a rutas protegidas del perfil: ${detalle}. El trabajo sería rechazado al terminar; ` +
          'ajustá `writes` o el perfil.',
      );
    }
    const resources = lista(spec.resources, 'resources', origen?.resources ?? []);
    for (const nombre of resources) {
      if (!perfil.resources || !Object.hasOwn(perfil.resources, nombre)) {
        throw new ErrorDeGestor(`Recurso desconocido '${nombre}' (el perfil declara: ${Object.keys(perfil.resources ?? {}).join(', ') || 'ninguno'})`);
      }
    }
    const after = lista(spec.after, 'after', []);
    for (const dep of after) {
      if (!this.trabajos.has(dep)) throw new ErrorDeGestor(`after: no existe el trabajo '${dep}'`);
    }
    const files = lista(spec.files, 'files', []).map((f) => aRutaDelServidor(f));

    // Aceptación: clave del perfil o comando literal; sin nada, la de 'default' si existe,
    // salvo en readonly: un trabajo que no escribe no tiene nada que aceptar y el comando
    // por defecto (lint, tests) correría en vano sobre el árbol real. Una `accept` explícita sí corre.
    let aceptacion = null;
    if (spec.accept !== undefined && spec.accept !== null && spec.accept !== '') {
      if (typeof spec.accept !== 'string') throw new ErrorDeGestor('`accept` debe ser un texto');
      aceptacion = Object.hasOwn(perfil.accept ?? {}, spec.accept) ? perfil.accept[spec.accept] : spec.accept;
    } else if (origen?.aceptacion) {
      aceptacion = origen.aceptacion; // retomar: la misma aceptación que el trabajo original
    } else if (modo !== 'readonly' && esAceptacionValida(perfil.accept?.default)) {
      aceptacion = perfil.accept.default;
    }
    if (soloAceptacion && !aceptacion) {
      throw new ErrorDeGestor('`solo_aceptacion` necesita una `accept` (comando o clave del perfil): sin ella no hay nada que correr');
    }

    const num = (valor, nombre, porDefecto) => {
      if (valor === undefined || valor === null) return porDefecto;
      if (!Number.isFinite(valor) || valor < 0) throw new ErrorDeGestor(`\`${nombre}\` debe ser un número no negativo`);
      return valor;
    };

    const trabajo = this.almacen.crear({
      estado: 'queued',
      titulo:
        typeof spec.title === 'string'
          ? spec.title.slice(0, 120)
          : soloAceptacion
            ? origen
              ? `Verificación de ${origen.id}`
              : 'Compuerta sobre la integración'
            : spec.prompt.trim().split('\n')[0].slice(0, 80),
      prompt: spec.prompt,
      soloAceptacion,
      desdeJob: origen ? origen.id : null,
      baseElegida: spec.base ?? null,
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
      // Sin `timeout_ms` en el envío rige el del perfil (p. ej. 1 h para backend con suites largas).
      timeoutMs: num(spec.timeout_ms, 'timeout_ms', perfil.timeoutMs ?? DEFECTOS.timeoutMs),
      idleTimeoutMs: num(spec.idle_timeout_ms, 'idle_timeout_ms', DEFECTOS.idleTimeoutMs),
      encoladoEn: Date.now(),
    });
    this.trabajos.set(trabajo.id, trabajo);
    this.cola.push(trabajo.id);
    this.almacen.auditar({ accion: 'enviar', id: trabajo.id, mode: modo, isolation, writes, cwd: cwdReal, prompt: spec.prompt });
    this.#evento({ tipo: 'job.creado', jobId: trabajo.id, actor, detalle: { titulo: trabajo.titulo, modo, writes } });
    this.#eventoDeTrabajo(trabajo.id, { tipo: 'encolado' });
    this.#bombear();
    return trabajo;
  }

  /**
   * Registra en la auditoría global el arranque del servidor y la recuperación de
   * trabajos huérfanos de una ejecución anterior (`almacen.marcarPerdidos`). Es
   * best-effort: nunca lanza.
   *
   * @param {{ recuperados?: string[] }} [opciones] ids reconciliados al arrancar
   */
  registrarArranque({ recuperados = [] } = {}) {
    this.#evento({ tipo: 'servidor.arranque', detalle: { concurrencia: this.concurrencia, modelo: this.modelo } });
    if (Array.isArray(recuperados) && recuperados.length > 0) {
      this.#evento({ tipo: 'servidor.recuperacion', detalle: { recuperados } });
    }
  }

  /** Lanza los trabajos que el planificador declara elegibles. */
  #bombear() {
    if (this.cerrado) return;
    const recursos = {};
    for (const id of [...this.cola, ...this.corriendo]) {
      for (const nombre of this.trabajos.get(id)?.resources ?? []) recursos[nombre] = this.concurrencia;
    }
    const { arrancar, bloqueados, esperas } = elegibles({
      cola: this.cola,
      corriendo: [...this.corriendo],
      concurrencia: this.concurrencia,
      trabajos: this.trabajos,
      ahora: Date.now(),
      recursos,
      serializarEscrituras: true,
      esperaMaximaMs: this.esperaMaximaMs,
    });

    // Se guarda POR QUÉ espera cada trabajo en cola (solo si cambió, para no reescribir
    // job.json en cada pasada): el listado y el panel lo muestran en vez de un "queued" mudo.
    for (const id of this.cola) {
      const espera = esperas.get(id) ?? null;
      const actual = this.trabajos.get(id)?.espera ?? null;
      if (JSON.stringify(espera) !== JSON.stringify(actual)) {
        this.#guardar(id, { espera });
        // El motivo de espera del planificador se registra solo cuando cambia, para
        // no inundar la auditoría con la misma causa en cada pasada.
        if (espera) this.#evento({ tipo: 'job.espera', jobId: id, motivo: espera.motivo, detalle: espera });
      }
    }

    for (const { id, motivo } of bloqueados) {
      this.cola = this.cola.filter((x) => x !== id);
      this.#guardar(id, { estado: 'cancelled', motivoFin: 'dependencia_fallida', detalleFin: motivo });
      this.#evento({ tipo: 'job.cancelado', jobId: id, motivo: 'dependencia_fallida' });
      this.#eventoDeTrabajo(id, { tipo: 'cancelado', motivo: 'dependencia_fallida' });
      this.#notificar(id);
    }
    for (const id of arrancar) {
      this.cola = this.cola.filter((x) => x !== id);
      if (this.trabajos.get(id)?.espera) this.#guardar(id, { espera: null });
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
   * Rama desde la que parte el worktree de un trabajo. Con `jobBase: 'integracion'` parte de
   * la rama de integración (ya sincronizada con la base), así los trabajos encadenados ven lo
   * que se integró antes aunque el usuario todavía no haya avanzado la base. Si no se puede
   * sincronizar (conflicto, árbol sucio) cae a la base y deja constancia en los eventos.
   */
  async #baseDelTrabajo(id, job, perfil) {
    // Retomar un trabajo: mismo commit de partida que el original (así sus archivos aplican limpio).
    const origen = job.desdeJob ? this.trabajos.get(job.desdeJob) : null;
    if (origen?.baseCommit) return origen.baseCommit;
    if ((job.baseElegida ?? perfil.jobBase) !== 'integracion') return perfil.baseBranch;
    try {
      const { rootDirIntegracion } = this.#raices(perfil);
      const sync = await sincronizarIntegracion({
        repoRaiz: job.repo,
        integrationBranch: perfil.integrationBranch,
        base: perfil.baseBranch,
        rootDirIntegracion,
      });
      if (sync.ok) return perfil.integrationBranch;
      this.#eventoDeTrabajo(id, { tipo: 'base_integracion_no_sincronizable', conflictos: sync.conflictos });
    } catch (error) {
      this.#eventoDeTrabajo(id, { tipo: 'base_integracion_no_sincronizable', error: String(error?.message ?? error) });
    }
    return perfil.baseBranch;
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
      this.#eventoDeTrabajo(id, { tipo: 'provisionando' });
      let job = this.trabajos.get(id);
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
        const baseDelTrabajo = await this.#baseDelTrabajo(id, job, perfil);
        const wt = await crearWorktree({
          repoRaiz: job.repo,
          base: baseDelTrabajo,
          jobId: id,
          rootDir,
          link: perfil.worktrees.link,
          linkConCopia: perfil.worktrees.linkConCopia,
          setup: perfil.worktrees.setup,
          env: { ...perfil.env },
          signal: ctl.signal,
        });
        raizTrabajo = wt.ruta;
        baseCommit = wt.baseCommit;
        enlaces = wt.enlacesCreados ?? [];
        this.#guardar(id, { worktree: wt.ruta, rama: wt.rama, baseCommit, enlacesCreados: enlaces });
        if (job.desdeJob) {
          const origen = this.trabajos.get(job.desdeJob);
          const traslado = await trasladarCambios({
            desde: origen.worktree,
            hacia: wt.ruta,
            baseCommit: origen.baseCommit,
            ignorar: origen.enlacesCreados ?? [],
          });
          this.#eventoDeTrabajo(id, { tipo: 'cambios_trasladados', desde: origen.id, ...traslado });
        }
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

      // 2) Recursos exclusivos por trabajo. Un recurso que consume una aceptación paralela
      // se provisiona POR FRAGMENTO dentro de `ejecutarParalelo` (una base por shard): acá
      // se omite la instancia única para no crear una base de más.
      const recursoParalelo = recursoDeAceptacionParalela(job.aceptacion);
      const envRecursos = {};
      for (const nombre of job.resources) {
        if (nombre === recursoParalelo) continue;
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
      const entornoBaseDelTrabajo = entornoDeTrabajo({
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
      // PWD heredado apuntaría al directorio de arranque del servidor y el agente lo tomaría
      // por su carpeta de trabajo (observado en vivo): se fija al cwd real del trabajo.
      const entorno = { ...entornoBaseDelTrabajo, PWD: cwdTrabajo };
      const prompt = construirPrompt({
        prompt: job.prompt,
        modo: job.mode,
        writes: job.writes,
        reads: job.reads,
        protegidos,
        rutaTrabajo: cwdTrabajo,
        prefijo: perfil.promptPrefix,
      });
      const args = construirArgs({
        prompt,
        modo: job.mode,
        modelo: job.modelo,
        files: job.files,
        agente: NOMBRE_AGENTE,
      });

      // 4) Ejecución de opencode. El agente puede morir por corte de transporte (socket
      // cerrado) DESPUÉS de escribir; según lo que haya dejado conviene CONTINUAR con el
      // pipeline normal (verificación + aceptación) o RELANZAR una vez. Por eso la corrida
      // se encapsula y puede repetirse con el MISMO prompt en el MISMO worktree.
      this.#guardar(id, { estado: 'running' });
      this.#eventoDeTrabajo(id, { tipo: 'ejecutando' });

      // Advertencias acumuladas antes de la verificación final: la reanudación por corte
      // de transporte agrega la suya acá y el pipeline normal la reexpone.
      const advertencias = [];

      /** Corre el agente UNA vez, con su vigilante de alcance/progreso. */
      const correrAgente = async () => {
        // Vigilancia de alcance DURANTE la ejecución: si el agente toca algo fuera de `writes` (o
        // protegido) y sigue ahí en dos revisiones seguidas, se lo detiene en vez de dejarlo
        // trabajar una hora para rechazarlo al final. Dos revisiones evitan cortar a un agente que
        // creó un archivo de paso y lo borra enseguida.
        const senalAgente = new AbortController();
        const reenviarAborto = () => senalAgente.abort();
        ctl.signal.addEventListener('abort', reenviarAborto, { once: true });
        let violacionTemprana = null;
        let sinProgreso = null;
        let vigilante = null;
        // Falta de PROGRESO: un agente que solo explora (lee, busca) y no escribe nada durante mucho
        // tiempo no está avanzando (visto en vivo: 21 minutos sin una sola escritura). Se lo corta para
        // relanzar la tarea con instrucciones precisas. 0 = sin límite. No aplica a readonly (no escribe).
        const limiteSinProgreso = this.sinProgresoMs ?? perfil.sinProgresoMs ?? DEFECTOS.sinProgresoMs;
        const iniciadoEn = Date.now();
        let huboEscrituras = false;
        if (!job.soloAceptacion && this.vigilanciaAlcanceMs > 0) {
          let firmaPrevia = '';
          let revisando = false;
          vigilante = setInterval(async () => {
            if (revisando || violacionTemprana || sinProgreso) return;
            revisando = true;
            try {
              const { archivos } = await cambiosDelWorktree({ ruta: raizTrabajo, baseCommit, ignorar: enlaces });
              const propios = archivos.filter((archivo) => {
                if (!previos.has(archivo)) return true;
                return hashDeArchivo(path.join(raizTrabajo, archivo)) !== previos.get(archivo);
              });
              if (propios.length > 0) huboEscrituras = true;
              const transcurrido = Date.now() - iniciadoEn;
              if (!huboEscrituras && job.mode !== 'readonly' && limiteSinProgreso > 0 && transcurrido > limiteSinProgreso) {
                sinProgreso = { transcurridoMs: transcurrido, limiteMs: limiteSinProgreso };
                this.#eventoDeTrabajo(id, { tipo: 'sin_progreso', ...sinProgreso });
                senalAgente.abort();
                return;
              }
              const v = verificarCambios({ archivosCambiados: propios, writes: job.writes, protegidos, modo: job.mode });
              const firma = v.ok ? '' : JSON.stringify(v.violaciones);
              if (firma !== '' && firma === firmaPrevia) {
                violacionTemprana = v.violaciones;
                this.#eventoDeTrabajo(id, { tipo: 'alcance_temprano', violaciones: v.violaciones });
                senalAgente.abort();
              }
              firmaPrevia = firma;
            } catch {
              /* una revisión fallida no tumba el trabajo: la verificación final sigue siendo la garantía */
            } finally {
              revisando = false;
            }
          }, this.vigilanciaAlcanceMs);
          vigilante.unref?.();
        }

        let resultadoProceso;
        try {
          resultadoProceso = job.soloAceptacion
            ? { motivo: 'exit', code: 0, signal: null, duracionMs: 0 }
            : await ejecutar({
                cmd: this.opencode.cmd,
                args: [...this.opencode.argsPrefijo, ...args],
                cwd: cwdTrabajo,
                env: entorno,
                stdoutPath: rutas.stdout,
                stderrPath: rutas.stderr,
                timeoutMs: job.timeoutMs,
                idleTimeoutMs: job.idleTimeoutMs,
                graceMs: this.graceMs,
                signal: senalAgente.signal,
                // Persistir el grupo y su identidad SIN ventana de pérdida (S1).
                onLanzado: ({ pid, pgid }) => {
                  try {
                    this.#guardar(id, { pid, pgid, identidad: identidadDeProceso(pgid) });
                  } catch {
                    /* el trabajo sigue; el reinicio lo marcará perdido */
                  }
                },
              });
        } finally {
          if (vigilante) clearInterval(vigilante);
          ctl.signal.removeEventListener('abort', reenviarAborto);
        }
        return { resultadoProceso, sinProgreso, violacionTemprana };
      };

      let proceso;
      for (;;) {
        const { resultadoProceso, sinProgreso, violacionTemprana } = await correrAgente();
        if (sinProgreso && !ctl.signal.aborted) {
          proceso = { motivo: 'detenido_por_falta_de_progreso', exit: null, senal: null, duracionMs: resultadoProceso.duracionMs };
          this.#eventoDeTrabajo(id, { tipo: 'proceso_terminado', ...proceso });
          const minutos = Math.round(sinProgreso.transcurridoMs / 60000);
          return this.#terminar(id, 'failed', {
            proceso,
            archivos: [],
            advertencias: [
              `Detenido: el agente no escribió NINGÚN archivo en ${minutos} min (solo exploró). No hay nada que retomar con ` +
                '`desde_job`. Relanzá la tarea con un prompt ACOTADO: indicá los archivos y las líneas exactas donde cambiar ' +
                '(buscalos vos antes con grep) y pedile que empiece a escribir enseguida.',
            ],
            motivoFin: 'sin_progreso',
          });
        }
        if (violacionTemprana && !ctl.signal.aborted) {
          proceso = { motivo: 'detenido_por_alcance', exit: null, senal: null, duracionMs: resultadoProceso.duracionMs };
          this.#eventoDeTrabajo(id, { tipo: 'proceso_terminado', ...proceso });
          // La máquina de estados exige pasar por `verifying` antes de rechazar.
          this.#guardar(id, { estado: 'verifying' });
          this.#eventoDeTrabajo(id, { tipo: 'verificando' });
          const { archivos, resumen } = await cambiosDelWorktree({ ruta: raizTrabajo, baseCommit, ignorar: enlaces });
          return this.#terminar(id, 'rejected', {
            proceso,
            archivos,
            resumen,
            violaciones: violacionTemprana,
            advertencias: [
              'Detenido TEMPRANO: el agente tocó archivos fuera de `writes` (o protegidos) y persistió en ello. ' +
                'Ajustá `writes` o la tarea; con `desde_job` podés retomar lo que dejó sin repetir todo.',
            ],
            motivoFin: 'alcance',
          });
        }
        proceso = {
          motivo: resultadoProceso.motivo,
          exit: resultadoProceso.code,
          senal: resultadoProceso.signal,
          duracionMs: resultadoProceso.duracionMs,
        };
        this.#eventoDeTrabajo(id, { tipo: 'proceso_terminado', ...proceso });

        if (resultadoProceso.motivo === 'cancelado') return this.#terminar(id, 'cancelled', { proceso, motivoFin: 'cancelado' });
        if (resultadoProceso.motivo === 'timeout' || resultadoProceso.motivo === 'idle') {
          return this.#terminar(id, 'failed', { proceso, motivoFin: resultadoProceso.motivo });
        }
        if (resultadoProceso.motivo === 'error_al_lanzar') {
          return this.#terminar(id, 'failed', { proceso, motivoFin: 'error_al_lanzar', error: resultadoProceso.mensaje });
        }
        if (resultadoProceso.code === 0) break; // salida limpia: sigue el pipeline normal

        // Fallo del agente: ¿fue un corte de transporte tras el que conviene CONTINUAR (ya
        // dejó cambios en alcance) o RELANZAR (no dejó nada)? Los cortes deliberados del
        // servidor (timeout, cancelado, alcance, sin progreso) ya salieron por los returns.
        const fallo = {
          codigo: resultadoProceso.code,
          motivo: resultadoProceso.motivo,
          stderr: leerColaArchivo(rutas.stderr, 8192),
          stdout: leerColaArchivo(rutas.stdout, 8192),
          duracionMs: resultadoProceso.duracionMs,
        };
        const actual = await this.#alcanceDeTrabajo({
          raizTrabajo,
          baseCommit,
          enlaces,
          previos,
          writes: job.writes,
          protegidos,
          modo: job.mode,
        });
        const decision = decidirReanudacion({
          fallo,
          hayCambiosEnAlcance: actual.alcance.ok && actual.archivos.length > 0,
          relanzamientosPrevios: job.relanzamientos ?? 0,
          config: perfil.reanudacion,
        });
        if (decision.accion === 'continuar') {
          advertencias.push(textoAdvertencia(decision, fallo));
          this.#evento({ tipo: 'job.reanudado', jobId: id, motivo: decision.motivo });
          break;
        }
        if (decision.accion === 'relanzar') {
          const relanzamientos = (job.relanzamientos ?? 0) + 1;
          job = this.#guardar(id, { relanzamientos });
          this.#evento({ tipo: 'job.reintento', jobId: id, motivo: decision.motivo, detalle: { relanzamientos } });
          continue; // mismo worktree, mismo prompt, mismo entorno
        }
        return this.#terminar(id, 'failed', { proceso, motivoFin: 'exit_distinto_de_cero' });
      }

      // 5) Verificación de alcance (la garantía real, §4)
      this.#guardar(id, { estado: 'verifying' });
      this.#eventoDeTrabajo(id, { tipo: 'verificando' });
      const {
        archivos: archivosTrabajo,
        resumen,
        alcance,
      } = await this.#alcanceDeTrabajo({ raizTrabajo, baseCommit, enlaces, previos, writes: job.writes, protegidos, modo: job.mode });
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

      // 5b) Mutaciones del agente: si declaró `.orq/mutaciones.json`, el servidor aplica cada
      // cambio, corre su comando y RESTAURA el original. Va después del alcance y antes de la
      // aceptación: un test que no falla con la mutación es evidencia de tests débiles, no un
      // cambio del trabajo (por eso el archivo mutado se restaura siempre).
      let mutaciones = null;
      const rutaManifiesto = path.join(raizTrabajo, nombreManifiesto);
      if ((perfil.mutaciones?.habilitado ?? true) && fs.existsSync(rutaManifiesto)) {
        const timeoutMutacionesMs = perfil.mutaciones?.timeoutMs ?? 300000;
        let manifiesto = null;
        try {
          manifiesto = leerManifiesto(rutaManifiesto, raizTrabajo);
        } catch (error) {
          // Un manifiesto inválido es un error del agente, no del servidor: se advierte y se sigue.
          advertencias.push(`manifiesto de mutaciones inválido: ${mensajeDeError(error)}`);
        }
        if (manifiesto) {
          let resultadoMutaciones = null;
          try {
            resultadoMutaciones = await ejecutarMutaciones({
              worktree: raizTrabajo,
              manifiesto,
              // Solo se muta lo que el trabajo puede escribir y no está protegido.
              permitido: (archivo) =>
                verificarCambios({
                  archivosCambiados: [archivo],
                  writes: job.writes,
                  protegidos,
                  modo: job.mode,
                }).ok,
              // Mismo mecanismo y entorno que la aceptación (incluidas las variables de recursos).
              correr: (comando, { timeoutMs } = {}) =>
                this.#correrComando(comando, {
                  cwd: cwdTrabajo,
                  env: entorno,
                  timeoutMs: timeoutMs ?? timeoutMutacionesMs,
                  ctl,
                }),
              timeoutMs: timeoutMutacionesMs,
            });
          } catch (error) {
            if (error?.codigo === 'RESTAURACION_FALLIDA') {
              // El worktree quedó corrupto: NUNCA se commitea; el trabajo falla con el detalle.
              return this.#terminar(id, 'failed', {
                proceso,
                archivos: archivosTrabajo,
                resumen,
                advertencias,
                motivoFin: 'error_interno',
                error: `No se pudo restaurar un archivo mutado: ${mensajeDeError(error)}`,
              });
            }
            advertencias.push(`no se pudieron ejecutar las mutaciones: ${mensajeDeError(error)}`);
          }
          if (resultadoMutaciones) {
            mutaciones = {
              detectadas: resultadoMutaciones.detectadas,
              total: resultadoMutaciones.total,
              restauradoOk: resultadoMutaciones.restauradoOk,
              detalle: resultadoMutaciones.detalle,
            };
            for (const item of resultadoMutaciones.detalle ?? []) {
              if (item.estado === 'no_detectada') {
                advertencias.push(
                  `MUTACION NO DETECTADA: ${item.archivo} con ${item.comando}: el test no falla si se rompe esto`,
                );
              } else if (item.estado === 'no_permitida') {
                advertencias.push(`MUTACION NO PERMITIDA: ${item.archivo} no está dentro de los writes del trabajo; se omitió`);
              }
            }
            this.#evento({
              tipo: 'job.mutaciones',
              jobId: id,
              detectadas: mutaciones.detectadas,
              total: mutaciones.total,
              restauradoOk: mutaciones.restauradoOk,
            });
            this.#eventoDeTrabajo(id, {
              tipo: 'job.mutaciones',
              detectadas: mutaciones.detectadas,
              total: mutaciones.total,
              restauradoOk: mutaciones.restauradoOk,
            });
            // `exigirTodas`: una mutación no detectada deja el trabajo rechazado (sin commit).
            const noDetectadas = (resultadoMutaciones.detalle ?? []).filter((d) => d.estado === 'no_detectada').length;
            if ((perfil.mutaciones?.exigirTodas ?? false) && noDetectadas > 0) {
              return this.#terminar(id, 'rejected', {
                proceso,
                archivos: archivosTrabajo,
                resumen,
                advertencias,
                mutaciones,
                motivoFin: 'mutacion',
              });
            }
          }
        }
      }

      // 6) Aceptación
      let aceptado = { cmd: null, ejecutada: false };
      if (job.aceptacion) {
        if (typeof job.aceptacion === 'string') {
          const salida = await ejecutar({
            cmd: '/bin/sh',
            args: ['-c', job.aceptacion],
            cwd: cwdTrabajo,
            env: entorno,
            stdoutPath: path.join(rutas.dir, 'aceptacion.log'),
            stderrPath: path.join(rutas.dir, 'aceptacion.err.log'),
            // Tope de la aceptación: el del perfil (la compuerta completa pasa de 10 min) o el por defecto.
            timeoutMs: perfil.aceptacionTimeoutMs ?? DEFECTOS.aceptacionTimeoutMs,
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
          // Solo si falló: el bloque de fallos (qué test, qué error) suele estar en stderr o en
          // medio del stdout; sin esto había que abrir los logs a mano para saber por qué se rechazó.
          if (salida.motivo !== 'exit' || salida.code !== 0) {
            aceptado.fallos = resumirFallos({
              stdout: leerColaArchivo(path.join(rutas.dir, 'aceptacion.log'), 400_000),
              stderr: leerColaArchivo(path.join(rutas.dir, 'aceptacion.err.log'), 400_000),
            });
          }
          if (salida.motivo === 'cancelado') return this.#terminar(id, 'cancelled', { proceso, motivoFin: 'cancelado', aceptacion: aceptado, mutaciones });
          if (salida.motivo !== 'exit' || salida.code !== 0) {
            return this.#terminar(id, 'rejected', {
              proceso,
              archivos: archivosTrabajo,
              resumen,
              aceptacion: aceptado,
              advertencias,
              mutaciones,
              motivoFin: 'aceptacion',
            });
          }
        } else {
          // Compuerta en fragmentos: cada shard corre con SU propia instancia del recurso.
          const paralelo = await this.#aceptacionParalela({ id, job, perfil, cwdTrabajo, entorno, rutas, ctl });
          aceptado = paralelo.aceptado;
          if (paralelo.cancelado) {
            return this.#terminar(id, 'cancelled', { proceso, motivoFin: 'cancelado', aceptacion: aceptado, mutaciones });
          }
          if (!paralelo.ok) {
            return this.#terminar(id, 'rejected', {
              proceso,
              archivos: archivosTrabajo,
              resumen,
              aceptacion: aceptado,
              advertencias,
              mutaciones,
              motivoFin: 'aceptacion',
            });
          }
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
        mutaciones,
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
          this.#eventoDeTrabajo(id, { tipo: 'error_al_liberar_recurso', error: String(error?.message ?? error) });
        }
      }
    }
  }

  /**
   * Archivos modificados por el trabajo (descontando los que ya estaban antes) y el
   * resultado de verificar ese cambio contra `writes`/`protected`. Se usa tanto en la
   * decisión de reanudación como en la verificación final, para no divergir.
   *
   * @param {object} opciones
   * @returns {Promise<{ archivos: string[], resumen: object, alcance: object }>}
   */
  async #alcanceDeTrabajo({ raizTrabajo, baseCommit, enlaces, previos, writes, protegidos, modo }) {
    const { archivos, resumen } = await cambiosDelWorktree({ ruta: raizTrabajo, baseCommit, ignorar: enlaces });
    const archivosTrabajo = archivos.filter((archivo) => {
      if (!previos.has(archivo)) return true;
      return hashDeArchivo(path.join(raizTrabajo, archivo)) !== previos.get(archivo);
    });
    const alcance = verificarCambios({ archivosCambiados: archivosTrabajo, writes, protegidos, modo });
    return { archivos: archivosTrabajo, resumen, alcance };
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

  /**
   * Corre un comando de shell en el worktree con el MISMO mecanismo que la aceptación:
   * `/bin/sh -c`, grupo de procesos propio, tope de tiempo y cancelación por `ctl.signal`.
   * Devuelve la forma que espera `ejecutarMutaciones` (`codigo`, `salida`, `timeout`).
   *
   * @param {string} comando
   * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, ctl: AbortController, logBase?: string }} opciones
   * @returns {Promise<{ codigo: number|null, salida: string, timeout: boolean }>}
   */
  async #correrComando(comando, { cwd, env, timeoutMs, ctl, logBase }) {
    let salida = '';
    const resultado = await ejecutar({
      cmd: '/bin/sh',
      args: ['-c', comando],
      cwd,
      env,
      stdoutPath: logBase ? `${logBase}.out.log` : undefined,
      stderrPath: logBase ? `${logBase}.err.log` : undefined,
      timeoutMs,
      graceMs: this.graceMs,
      signal: ctl.signal,
      onSalida: (evento) => {
        salida += evento.texto;
        // Se guarda solo la cola: un test verboso no debe acumular un buffer sin tope.
        if (salida.length > TOPE_SALIDA_COMANDO) salida = salida.slice(-TOPE_SALIDA_COMANDO);
      },
    });
    return { codigo: resultado.code, salida, timeout: resultado.motivo === 'timeout' };
  }

  /**
   * Ejecuta una aceptación en fragmentos paralelos (`{ paralelo }`): provisiona una
   * instancia del recurso por fragmento, corre los comandos y libera SIEMPRE cada
   * instancia. Devuelve el resultado con la forma que consume `formato.js` y los topes
   * de salida compacta ya aplicados por `ejecutarParalelo` (fallidos primero).
   *
   * @param {object} opciones
   * @returns {Promise<{ aceptado: object, ok: boolean, cancelado: boolean }>}
   */
  async #aceptacionParalela({ id, job, perfil, cwdTrabajo, entorno, rutas, ctl }) {
    const spec = job.aceptacion;
    const normalizado = normalizarParalelo(spec);
    const timeoutMs = normalizado.timeoutMs ?? perfil.aceptacionTimeoutMs ?? DEFECTOS.aceptacionTimeoutMs;

    this.#eventoDeTrabajo(id, {
      tipo: 'aceptacion_paralela',
      fase: 'inicio',
      fragmentos: normalizado.shards,
    });

    const resultado = await ejecutarParalelo({
      spec,
      ejecutar: async (comando, { env: envFragmento, indice }) => {
        // El entorno del fragmento (su base) se SUMA al entorno del trabajo.
        return this.#correrComando(comando, {
          cwd: cwdTrabajo,
          env: { ...entorno, ...envFragmento },
          timeoutMs,
          ctl,
          logBase: path.join(rutas.dir, `aceptacion-${indice}`),
        });
      },
      provisionar: async (indice) => {
        if (!normalizado.recurso) return { env: {} };
        const proveedor = crearProveedor(perfil.resources[normalizado.recurso], {
          env: this.entornoBase,
          ejecutarPsql: this.ejecutarPsql,
        });
        const recurso = await proveedor.provisionar({ id, shard: indice });
        return { env: recurso.env, liberar: recurso.liberar };
      },
      // Liberar siempre: si el fragmento falló, su base no debe quedar viva.
      liberar: async (datos) => {
        if (datos && typeof datos.liberar === 'function') await datos.liberar();
      },
    });

    this.#eventoDeTrabajo(id, {
      tipo: 'aceptacion_paralela',
      fase: 'fin',
      fragmentos: normalizado.shards,
      ok: resultado.ok,
    });

    const aceptado = {
      cmd: normalizado.comando,
      ejecutada: true,
      exit: resultado.ok ? 0 : 1,
      motivo: 'exit',
      fragmentos: normalizado.shards,
      // Fallidos primero (ya ordenado por `ejecutarParalelo`); `formato.js` recorta las líneas.
      cola: resultado.salidaCombinada,
    };
    return { aceptado, ok: resultado.ok, cancelado: ctl.signal.aborted };
  }

  /** Cierra el trabajo en un estado terminal persistiendo el resultado. */
  #terminar(id, estado, datos = {}) {
    const actual = this.trabajos.get(id);
    if (!actual || esTerminal(actual.estado)) return;
    // El actor puede venir de una cancelación pedida por una herramienta MCP.
    const actor = this.actores.get(id) ?? 'servidor';
    this.actores.delete(id);
    const guardado = this.#guardar(id, { estado, resultado: datos, motivoFin: datos.motivoFin ?? null, error: datos.error ?? null }, actor);
    const duracionMs = (guardado.finEn ?? Date.now()) - (guardado.inicioEn ?? guardado.creadoEn ?? 0);
    this.#eventoDeTrabajo(id, { tipo: 'fin', estado, motivo: datos.motivoFin ?? null });
    this.#evento({ tipo: 'job.fin', jobId: id, estado, motivo: datos.motivoFin ?? null, actor, detalle: { duracionMs } });
    if (estado === 'cancelled') {
      this.#evento({ tipo: 'job.cancelado', jobId: id, motivo: datos.motivoFin ?? null, actor });
    }
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

  /**
   * Espera a que termine ALGUNO de varios trabajos (o venza el tiempo). Si alguno ya terminó,
   * responde de inmediato. Devuelve los ids terminados y los que siguen activos, para que el
   * cliente no tenga que sondear de a uno (cada sondeo cuesta una vuelta entera).
   *
   * @param {string[]} ids
   * @param {number} ms
   * @returns {Promise<{ terminados: string[], activos: string[] }>}
   */
  async esperarAlguno(ids, ms) {
    const unicos = [...new Set(ids)];
    for (const id of unicos) this.obtener(id); // valida que existan, con mensaje claro
    const particion = () => ({
      terminados: unicos.filter((id) => esTerminal(this.trabajos.get(id).estado)),
      activos: unicos.filter((id) => !esTerminal(this.trabajos.get(id).estado)),
    });
    if (particion().terminados.length > 0 || particion().activos.length === 0) return particion();
    await Promise.race(unicos.map((id) => this.esperar(id, ms)));
    return particion();
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
   * @param {{ actor?: string }} [opciones] actor del evento de auditoría
   * @returns {Promise<object>} el trabajo tras cancelarlo (o tal cual si ya terminó)
   */
  async cancelar(id, { actor = 'servidor' } = {}) {
    const trabajo = this.obtener(id);
    if (esTerminal(trabajo.estado)) return trabajo;
    if (trabajo.estado === 'queued' && this.cola.includes(id)) {
      this.cola = this.cola.filter((x) => x !== id);
      this.#guardar(id, { estado: 'cancelled', motivoFin: 'cancelado_en_cola' }, actor);
      this.#evento({ tipo: 'job.cancelado', jobId: id, motivo: 'cancelado_en_cola', actor });
      this.#eventoDeTrabajo(id, { tipo: 'cancelado', motivo: 'cancelado_en_cola' });
      this.#notificar(id);
      this.#bombear();
      return this.trabajos.get(id);
    }
    // La cancelación de un trabajo en curso la cierra #terminar; el actor viaja en el
    // mapa para que el job.estado/job.cancelado queden atribuidos a la herramienta.
    this.actores.set(id, actor);
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
   * @param {{ avanzarBase?: boolean, actor?: string }} [opciones]
   * @returns {Promise<{ ok: boolean, sha?: string, conflictos?: string[], motivo?: string }>}
   */
  async integrar(id, { avanzarBase: avanzar = false, actor = 'servidor' } = {}) {
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
      this.#guardar(id, { estado: 'merged', integradoSha: resultado.sha, integradoEn: perfil.integrationBranch }, actor);
      this.#eventoDeTrabajo(id, { tipo: 'integrado', sha: resultado.sha, rama: perfil.integrationBranch });
      this.#evento({ tipo: 'merge', jobId: id, actor, detalle: { rama: perfil.integrationBranch, sha: resultado.sha } });
      this.almacen.auditar({ accion: 'integrar', id, sha: resultado.sha, rama: perfil.integrationBranch });
      // Opt-in: avanzar la base con fast-forward. Un fallo acá NO deshace la integración (ya está
      // hecha en la rama de integración): se informa el motivo y el usuario avanza a mano.
      let base = null;
      if (avanzar) {
        base = await avanzarBase({
          repoRaiz: trabajo.repo,
          base: perfil.baseBranch,
          integrationBranch: perfil.integrationBranch,
        }).catch((error) => ({ ok: false, motivo: String(error?.message ?? error) }));
        this.almacen.auditar({ accion: 'avanzar_base', id, ok: base.ok, sha: base.sha, motivo: base.motivo });
        this.#evento({ tipo: 'avanzar_base', jobId: id, actor, detalle: { ok: base.ok, sha: base.sha, motivo: base.motivo } });
      }
      return { ok: true, sha: resultado.sha, rama: perfil.integrationBranch, baseAvanzada: base, base: perfil.baseBranch };
    }
    this.#eventoDeTrabajo(id, { tipo: 'integracion_con_conflictos', conflictos: resultado.conflictos });
    return { ok: false, conflictos: resultado.conflictos, motivo: resultado.motivo };
  }

  /**
   * Elimina worktrees y ramas de trabajos terminados.
   * @param {{ ids?: string[], antiguedadMs?: number, actor?: string }} [opciones]
   * @returns {Promise<string[]>} ids limpiados
   */
  async limpiar({ ids, antiguedadMs = 0, actor = 'servidor' } = {}) {
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
        this.#eventoDeTrabajo(trabajo.id, { tipo: 'error_al_limpiar', error: String(error?.message ?? error) });
      }
    }
    this.#evento({ tipo: 'cleanup', actor, detalle: { ids: limpiados, cantidad: limpiados.length } });
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
      repo = await raizGit(path.resolve(aRutaDelServidor(cwd)));
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
      this.#evento({ tipo: 'job.cancelado', jobId: id, motivo: 'servidor_cerrado' });
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
