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
import { leerColaDeArchivo } from './colas.js';
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
import { leerManifiesto, ejecutarMutaciones, nombreManifiesto, recuperarMutacionPendiente, TEXTO_MUTACION_RECUPERADA } from './mutaciones.js';
import { ejecutarParalelo, normalizarParalelo } from './paralelo.js';
import { motivoAporteInvalido } from './pizarron.js';
import { elegibles } from './planificador.js';
import { cargarPerfil, perfilPorDefecto, resolverRaizWorktrees } from './profile.js';
import { expandirReceta } from './recetas.js';
import { decidirReanudacion, esFalloDeTransporte, textoAdvertencia } from './reanudacion.js';
import { construirPromptRevision, debeRevisar, parsearVeredicto, resumenRevision } from './revisor.js';
import { crearProveedor } from './recursos.js';
import { resolverIdentidad } from './identidadGit.js';
import { ejecutar } from './runner.js';
import { verificarCambios, escriturasEnRutaProtegida } from './scope.js';
import {
  cambiosDelWorktree,
  commitearTrabajo,
  crearWorktree,
  avanzarBase,
  DIR_ORQ,
  eliminarWorktree,
  integrar,
  raizGit,
  refrescarCopiaPizarron,
  sincronizarIntegracion,
  trasladarCambios,
} from './workspace.js';

/** Nombre del archivo de perfil en la raíz del repositorio objetivo. */
export const ARCHIVO_PERFIL = '.opencode-orchestrator.json';

/** Nombre del agente en línea que se genera para cada trabajo. */
const NOMBRE_AGENTE = 'orq';

const DEFECTOS = Object.freeze({
  // Tope GLOBAL por defecto (el del servidor); el tope POR REPO es `perfil.concurrency`.
  concurrencia: 8,
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

/** Tope de tiempo del revisor automático (5 min): es acotado y nunca debe colgar el trabajo. */
const REVISION_TIMEOUT_MS = 5 * 60 * 1000;

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
   * @param {object} [opciones.pizarron] pizarrón compartido (`crearPizarron`); opcional
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
    pizarron = null,
    maxEnMemoria = 500,
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
    // Pizarrón compartido (opcional): si falta, se desactiva por completo.
    this.pizarron = pizarron;
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
    /** @type {Set<string>} trabajos cuyo aporte inválido ya se avisó (una vez por trabajo) */
    this.aportesInvalidosAvisados = new Set();
    /** @type {Set<string>} trabajos cuyo refresco fallido del pizarrón ya se avisó (una vez) */
    this.pizarronesRefrescoAvisado = new Set();
    /** @type {Set<string>} repos ya avisados por no tener `user.name`/`user.email` (una vez) */
    this.identidadesAvisadas = new Set();
    /** @type {number|null} última versión del pizarrón copiada a los worktrees activos */
    this.pizarronVersionCopiada = null;
    /** @type {number} cantidad de fallos al registrar eventos globales (para loguear el 1º y cada 100) */
    this.fallosDeEvento = 0;
    this.cerrado = false;
    /** @type {number} tope de trabajos que el gestor carga en memoria al arrancar */
    this.maxEnMemoria = Number.isInteger(maxEnMemoria) && maxEnMemoria > 0 ? maxEnMemoria : 500;
    /** @type {number} trabajos que quedaron solo en disco (no cargados en memoria) */
    this.trabajosEnDisco = 0;
    /** @type {NodeJS.Timeout|null} timer de la retención de logs (unref) */
    this.timerRetencion = null;

    const inicial = this.almacen.listar({ maxEnMemoria: this.maxEnMemoria });
    this.trabajosEnDisco = inicial.omitidos ?? 0;
    for (const trabajo of inicial.trabajos) this.trabajos.set(trabajo.id, trabajo);
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
   * observabilidad NUNCA debe frenar la operación que se intenta registrar.
   *
   * POR QUÉ deja rastro en stderr (el 1º fallo y luego uno cada 100): un registro que
   * falla en silencio deja al servidor sin auditoría sin que nadie se entere. Se dosifica
   * para que un fallo persistente (disco lleno) no inunde el log.
   */
  #evento(evento) {
    if (!this.registro) return;
    try {
      const persistido = this.registro.registrar(evento);
      if (persistido === false) this.#reportarFalloDeEvento('el registro devolvió false (fallo de E/S)');
    } catch (error) {
      this.#reportarFalloDeEvento(mensajeDeError(error));
    }
  }

  /** Cuenta un fallo de registro y lo escribe en stderr el 1º y cada 100. Nunca lanza. */
  #reportarFalloDeEvento(detalle) {
    this.fallosDeEvento += 1;
    if (this.fallosDeEvento !== 1 && this.fallosDeEvento % 100 !== 0) return;
    try {
      process.stderr.write(`[opencode-orchestrator] fallo al registrar evento (${this.fallosDeEvento}): ${detalle}\n`);
    } catch {
      /* sin stderr no hay a dónde avisar */
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

  /**
   * Identidad git con la que firmar los commits de un repo (perfil > `git config` > fallback).
   * Si cae al fallback avisa UNA vez por repo: los commits no quedarán a nombre del dueño.
   * @param {object} perfil
   * @param {string} repo
   * @returns {{ nombre: string, email: string, origen: string }}
   */
  #identidadDe(perfil, repo) {
    const identidad = resolverIdentidad({ repo, perfilAutor: perfil?.autor });
    if (identidad.origen === 'fallback' && !this.identidadesAvisadas.has(repo)) {
      this.identidadesAvisadas.add(repo);
      process.stderr.write(
        'sin user.name/user.email en el repo: los commits saldrán como opencode-orchestrator\n',
      );
    }
    return identidad;
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
    // `receta`: nombre de una receta del perfil que se expande con `params` (el prompt
    // resultante puede no venir en la llamada, por eso se difiere la exigencia de prompt).
    const conReceta = typeof spec.receta === 'string' && spec.receta !== '';
    let soloAceptacion = spec.solo_aceptacion === true || spec.solo_aceptacion === 'true';
    if (soloAceptacion && (typeof spec.prompt !== 'string' || spec.prompt.trim() === '')) {
      spec = { ...spec, prompt: 'Solo aceptación (no se ejecuta el agente).' };
    }
    if (!conReceta && (typeof spec.prompt !== 'string' || spec.prompt.trim() === '')) {
      throw new ErrorDeGestor('`prompt` es obligatorio');
    }
    if (spec.base !== undefined && spec.base !== 'base' && spec.base !== 'integracion') {
      throw new ErrorDeGestor("`base` debe ser 'base' o 'integracion'");
    }
    // `desde_job`: retoma el trabajo de otro (rechazado o caído) sin repetir al agente: el worktree
    // nuevo parte del mismo commit base y recibe los archivos que dejó el anterior.
    let origen = null;
    if (spec.desde_job !== undefined && spec.desde_job !== null) {
      // `this.obtener` (y no el mapa en memoria): con la retención, un trabajo viejo
      // puede estar solo en disco y `enviar` debe leerlo bajo demanda en vez de decir
      // que no existe.
      try {
        origen = this.obtener(String(spec.desde_job));
      } catch {
        origen = null;
      }
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

    // Expansión de la receta: el prompt final es el de la receta más las notas que hayan
    // venido en la llamada; los campos explícitos de la llamada pisan a los de la receta.
    if (conReceta) {
      const definicion = perfil.recetas?.[spec.receta];
      if (!definicion) {
        const declaradas = Object.keys(perfil.recetas ?? {});
        throw new ErrorDeGestor(
          `receta desconocida '${spec.receta}' (el perfil declara: ${declaradas.join(', ') || 'ninguna'})`,
        );
      }
      let expandida;
      try {
        expandida = expandirReceta(definicion, spec.params ?? {});
      } catch (error) {
        throw new ErrorDeGestor(`receta '${spec.receta}': ${mensajeDeError(error)}`);
      }
      const notas =
        typeof spec.prompt === 'string' && spec.prompt.trim() !== ''
          ? `\n\nNotas adicionales:\n${spec.prompt}`
          : '';
      spec = {
        ...spec,
        prompt: `${expandida.prompt}${notas}`,
        mode: spec.mode !== undefined ? spec.mode : expandida.mode,
        writes: spec.writes !== undefined ? spec.writes : expandida.writes,
        reads: spec.reads !== undefined ? spec.reads : expandida.reads,
        resources: spec.resources !== undefined ? spec.resources : expandida.resources,
        accept: spec.accept !== undefined ? spec.accept : expandida.accept,
        solo_aceptacion: spec.solo_aceptacion !== undefined ? spec.solo_aceptacion : expandida.solo_aceptacion,
      };
      soloAceptacion = spec.solo_aceptacion === true || spec.solo_aceptacion === 'true';
    }

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
      // Igual que `desde_job`: resolver con `obtener` para no depender de la retención.
      // Además lo cachea en memoria, así el planificador ve su estado real.
      try {
        this.obtener(dep);
      } catch {
        throw new ErrorDeGestor(`after: no existe el trabajo '${dep}'`);
      }
    }
    const files = lista(spec.files, 'files', []).map((f) => aRutaDelServidor(f));

    // Aceptación: clave del perfil o comando literal; sin nada, la de 'default' si existe,
    // salvo en readonly: un trabajo que no escribe no tiene nada que aceptar y el comando
    // por defecto (lint, tests) correría en vano sobre el árbol real. Una `accept` explícita sí corre.
    let aceptacion = null;
    if (spec.accept !== undefined && spec.accept !== null && spec.accept !== '') {
      if (typeof spec.accept === 'string') {
        aceptacion = Object.hasOwn(perfil.accept ?? {}, spec.accept) ? perfil.accept[spec.accept] : spec.accept;
      } else if (esAceptacionValida(spec.accept)) {
        // Compuerta en fragmentos pasada directamente (p. ej. desde una receta del perfil).
        aceptacion = spec.accept;
      } else {
        throw new ErrorDeGestor('`accept` debe ser un texto o un objeto { paralelo }');
      }
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

    // Revalidación de cierre: entre el chequeo inicial y acá hubo `await`s (git, perfil).
    // Si el servidor empezó a cerrar en el medio, el trabajo quedaría encolado para
    // siempre (`cerrar()` ya vació la cola); se rechaza con un error claro.
    if (this.cerrado) throw new ErrorDeGestor('El servidor se está cerrando: no acepta trabajos nuevos');

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
      // Opt-in del perfil: el planificador no lo arranca mientras haya un trabajo
      // succeeded del mismo repo, sin integrar, que solape sus writes.
      esperarIntegracion: perfil.esperarIntegracion === true,
      // Tope de concurrencia POR REPO (el `concurrency` del perfil): el planificador lo
      // aplica además del tope global del servidor. Se guarda en el job como `esperarIntegracion`.
      concurrenciaRepo: perfil.concurrency,
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
      // Un trabajo que murió en medio de una mutación deja su worktree mutado. Al
      // recuperarlo se restaura el original (verificando sha256) para no confundir ese
      // cambio con trabajo real. Se registra una advertencia por cada restauración.
      for (const id of recuperados) {
        let trabajo;
        try {
          trabajo = this.obtener(id);
        } catch {
          continue;
        }
        if (!trabajo?.worktree) continue;
        const recuperacion = recuperarMutacionPendiente(trabajo.worktree);
        if (!recuperacion.recuperado) continue;
        this.#evento({
          tipo: 'servidor.recuperacion',
          jobId: id,
          detalle: { mutacionPendienteRecuperada: recuperacion.archivo, advertencia: TEXTO_MUTACION_RECUPERADA },
        });
        this.#eventoDeTrabajo(id, {
          tipo: 'mutacion_pendiente_recuperada',
          archivo: recuperacion.archivo,
          advertencia: TEXTO_MUTACION_RECUPERADA,
        });
      }
    }
  }

  /** Lanza los trabajos que el planificador declara elegibles. */
  #bombear() {
    if (this.cerrado) return;
    // Los recursos son POR TRABAJO: cada trabajo provisiona su propia instancia (p. ej.
    // `postgres-db` con `{job}` en el nombre, una base por trabajo), así que dos trabajos
    // que piden el mismo recurso NO se excluyen entre sí. La capacidad de cada recurso se
    // fija al tope de concurrencia (`this.concurrencia`): el recurso no serializa por sí
    // solo; lo que acota es el tope global/por repo. Si un recurso necesitara exclusión
    // real habría que declararlo con capacidad 1 (hoy no hay ningún recurso así).
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
        identidad: this.#identidadDe(perfil, job.repo),
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
    /** Perfil del repo, para usarlo también en el `finally` (pizarrón best-effort). */
    let perfilDelTrabajo = null;
    try {
      // Primero la transición: desde 'queued' solo se puede ir a provisioning o cancelled,
      // así que cualquier error posterior (p. ej. un perfil inválido) puede terminar en failed.
      this.#guardar(id, { estado: 'provisioning' });
      this.#eventoDeTrabajo(id, { tipo: 'provisionando' });
      // Advertencias acumuladas durante el pipeline; se declaran acá arriba porque la
      // recuperación de una mutación pendiente (desde_job) puede agregar una.
      const advertencias = [];
      let job = this.trabajos.get(id);
      const perfil = await this.#perfilDe(job.repo);
      perfilDelTrabajo = perfil;
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
          pizarron: perfil.pizarron?.habilitado === true ? this.pizarron : null,
        });
        raizTrabajo = wt.ruta;
        baseCommit = wt.baseCommit;
        enlaces = wt.enlacesCreados ?? [];
        this.#guardar(id, { worktree: wt.ruta, rama: wt.rama, baseCommit, enlacesCreados: enlaces, pizarronHabilitado: perfil.pizarron?.habilitado === true });
        if (job.desdeJob) {
          const origen = this.trabajos.get(job.desdeJob);
          // ANTES de trasladar: si el trabajo origen murió en medio de una mutación,
          // su worktree quedó mutado. Se restaura el original para no trasladar (ni
          // commitear después) ese cambio ajeno al trabajo.
          const recuperacion = recuperarMutacionPendiente(origen.worktree);
          if (recuperacion.recuperado) {
            advertencias.push(TEXTO_MUTACION_RECUPERADA);
            this.#eventoDeTrabajo(id, {
              tipo: 'mutacion_pendiente_recuperada',
              archivo: recuperacion.archivo,
              advertencia: TEXTO_MUTACION_RECUPERADA,
            });
            this.#evento({ tipo: 'job.mutaciones', jobId: id, mutacionPendienteRecuperada: recuperacion.archivo });
          }
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
        pizarron: perfil.pizarron?.habilitado === true,
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
              // Aporte del pizarrón durante la corrida: así los demás agentes ven los
              // contratos en cuanto se publican, sin esperar al fin del trabajo.
              this.#fusionarAportePizarron(id, raizTrabajo, perfil);
              // Y se repone la copia en los worktrees ACTIVOS si el documento cambió.
              this.#refrescarPizarronEnActivos();
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
                maxLogBytes: perfil.logs?.maxBytes,
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
          stderr: leerColaDeArchivo(rutas.stderr, { bytes: 8192 }),
          stdout: leerColaDeArchivo(rutas.stdout, { bytes: 8192 }),
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
                  maxLogBytes: perfil.logs?.maxBytes,
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
            maxLogBytes: perfil.logs?.maxBytes,
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
            cola: leerColaDeArchivo(path.join(rutas.dir, 'aceptacion.log'), { bytes: 2000 }),
          };
          // Solo si falló: el bloque de fallos (qué test, qué error) suele estar en stderr o en
          // medio del stdout; sin esto había que abrir los logs a mano para saber por qué se rechazó.
          if (salida.motivo !== 'exit' || salida.code !== 0) {
            aceptado.fallos = resumirFallos({
              stdout: leerColaDeArchivo(path.join(rutas.dir, 'aceptacion.log'), { bytes: 400_000 }),
              stderr: leerColaDeArchivo(path.join(rutas.dir, 'aceptacion.err.log'), { bytes: 400_000 }),
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

      // 6b) Revisor automático (opcional): un trabajo `safe` que ya pasó alcance y aceptación
      // puede ser contrastado por un agente de solo lectura. Se corre de forma SECUENCIAL
      // (no consume cupo de concurrencia del perfil: no entra a la cola) y es best-effort:
      // un fallo, timeout o respuesta ilegible NUNCA falla el trabajo.
      const revision = await this.#revisar(id, {
        job,
        perfil,
        raizTrabajo,
        baseCommit,
        archivosTrabajo,
        cwdTrabajo,
        entorno,
        rutas,
        ctl,
        advertencias,
      });
      // El revisor es un proceso más: si el trabajo se canceló mientras corría, se respeta.
      if (ctl.signal.aborted) {
        return this.#terminar(id, 'cancelled', { proceso, motivoFin: 'cancelado', advertencias });
      }

      // 7) Commit SOLO de lo verificado (con aislamiento) y fin
      let commit = null;
      if (job.isolation === 'worktree') {
        commit = await commitearTrabajo({
          ruta: raizTrabajo,
          mensaje: `orq(${id}): ${job.titulo}`,
          autor: this.autor,
          identidad: this.#identidadDe(perfil, job.repo),
          soloArchivos: archivosTrabajo,
        });
      }
      this.#terminar(id, 'succeeded', {
        proceso,
        archivos: archivosTrabajo,
        resumen,
        aceptacion: aceptado,
        advertencias,
        mutaciones,
        commit,
        ...(revision ? { revision } : {}),
      });
      // Auto-integración (opt-in del perfil): se resuelve ANTES de notificar el fin, así
      // quien espera el trabajo ya lo ve `merged` (o `succeeded` con la advertencia).
      await this.#autoIntegrar(id, perfil);
      return;
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
      // Al terminar CUALQUIER trabajo (aunque falle) se fusiona su aporte al pizarrón. Es
      // best-effort y va antes de liberar recursos para no depender de ellos.
      const trabajoFinal = this.trabajos.get(id);
      if (trabajoFinal?.worktree) this.#fusionarAportePizarron(id, trabajoFinal.worktree, perfilDelTrabajo);
      // Tras fusionar, se repone la copia en los demás trabajos ACTIVOS (best-effort).
      this.#refrescarPizarronEnActivos();
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
   * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, ctl: AbortController, logBase?: string, maxLogBytes?: number }} opciones
   * @returns {Promise<{ codigo: number|null, salida: string, timeout: boolean }>}
   */
  async #correrComando(comando, { cwd, env, timeoutMs, ctl, logBase, maxLogBytes }) {
    let salida = '';
    const resultado = await ejecutar({
      cmd: '/bin/sh',
      args: ['-c', comando],
      cwd,
      env,
      stdoutPath: logBase ? `${logBase}.out.log` : undefined,
      stderrPath: logBase ? `${logBase}.err.log` : undefined,
      maxLogBytes,
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
          maxLogBytes: perfil.logs?.maxBytes,
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

  /**
   * Fusiona el aporte del trabajo (`.orq/aporte.json`) en el pizarrón compartido.
   *
   * POR QUÉ best-effort y sin lanzar: el pizarrón es una comodidad de coordinación; un
   * archivo corrupto, un pizarrón ausente o un perfil que lo deshabilita NUNCA deben
   * afectar al trabajo. Solo se registra el evento cuando el aporte agregó o chocó algo.
   *
   * @param {string} id
   * @param {string} raizTrabajo worktree del trabajo
   * @param {object} perfil perfil del repo (puede ser null en el finally temprano)
   * @returns {void}
   */
  #fusionarAportePizarron(id, raizTrabajo, perfil) {
    if (!this.pizarron || perfil?.pizarron?.habilitado !== true) return;
    if (typeof raizTrabajo !== 'string' || raizTrabajo === '') return;
    try {
      const rutaAporte = path.join(raizTrabajo, DIR_ORQ, 'aporte.json');
      // Validación ANTES de leer: cada vigilancia (30 s) relee el aporte; un archivo
      // gigante o un enlace que escapa del worktree se ignora sin cargarlo en memoria.
      // El aviso se emite UNA sola vez por trabajo (el archivo no cambia de tamaño solo).
      const motivo = motivoAporteInvalido(rutaAporte, raizTrabajo);
      if (motivo) {
        if (!this.aportesInvalidosAvisados.has(id)) {
          this.aportesInvalidosAvisados.add(id);
          this.#evento({ tipo: 'pizarron.aporte_invalido', jobId: id, motivo });
          this.#eventoDeTrabajo(id, { tipo: 'pizarron.aporte_invalido', motivo });
        }
        return;
      }
      // Tope de entradas por trabajo: el aporte entero podría inundar el pizarrón. Se
      // recorta a un archivo temporal en el estado del trabajo (pizarron.js no se toca).
      const rutaRecortada = this.#aporteRecortado(id, rutaAporte, perfil.pizarron?.maxEntradasPorTrabajo);
      const res = this.pizarron.fusionarAporte(id, rutaRecortada ?? rutaAporte, { raizWorktree: raizTrabajo });
      const fusionadas = res?.fusionadas ?? 0;
      const conflictos = res?.conflictos ?? 0;
      if (fusionadas > 0 || conflictos > 0) {
        this.#evento({ tipo: 'pizarron.post', jobId: id, fusionadas, conflictos });
        this.#eventoDeTrabajo(id, { tipo: 'pizarron.post', fusionadas, conflictos });
      }
    } catch {
      /* el pizarrón jamás debe afectar al trabajo */
    }
  }

  /**
   * Reescribe la COPIA de solo contenido del pizarrón en los worktrees de los trabajos
   * ACTIVOS (running/verifying) cuyo pizarrón esté habilitado, cuando cambió la `version()`
   * del documento vivo. Es best-effort: los errores se ignoran y se avisa UNA sola vez por
   * trabajo. Nunca escribe en worktrees de trabajos terminados: solo recorre `this.corriendo`,
   * que se vacía al terminar el pipeline.
   *
   * POR QUÉ: una copia creada al inicio quedaría desactualizada y el agente leería contratos
   * viejos. El refresco reemplaza al symlink anterior, que además permitía escribir a través
   * del enlace y corromper el pizarrón compartido o el estado.
   *
   * @returns {void}
   */
  #refrescarPizarronEnActivos() {
    if (!this.pizarron) return;
    let version;
    try {
      version = this.pizarron.version();
    } catch {
      return;
    }
    if (version === this.pizarronVersionCopiada) return;
    for (const id of this.corriendo) {
      const trabajo = this.trabajos.get(id);
      if (!trabajo?.worktree || trabajo.pizarronHabilitado !== true) continue;
      const ok = refrescarCopiaPizarron({ worktree: trabajo.worktree, pizarron: this.pizarron });
      if (!ok && !this.pizarronesRefrescoAvisado.has(id)) {
        this.pizarronesRefrescoAvisado.add(id);
        this.#eventoDeTrabajo(id, { tipo: 'pizarron.refresco_fallido' });
      }
    }
    this.pizarronVersionCopiada = version;
  }

  /**
   * Devuelve la ruta de un aporte RECORTADO a las primeras `max` entradas, escrito en el
   * directorio de estado del trabajo, o `null` si no hace falta recortar.
   *
   * POR QUÉ una copia: `pizarron.js` lee un archivo, así que para aplicar el tope sin
   * tocar su API se le pasa este temporal. Si el aporte ya entra en el tope, se devuelve
   * `null` y se usa el original (se preserva el comportamiento actual).
   *
   * @param {string} id
   * @param {string} rutaAporte ruta del `.orq/aporte.json` del worktree
   * @param {number|undefined} max tope de entradas por trabajo
   * @returns {string|null}
   */
  #aporteRecortado(id, rutaAporte, max) {
    if (!Number.isInteger(max) || max < 1) return null;
    let aporte;
    try {
      aporte = JSON.parse(fs.readFileSync(rutaAporte, 'utf8'));
    } catch {
      return null; // ausente o corrupto: que lo maneje el pizarrón como hasta ahora
    }
    if (aporte === null || typeof aporte !== 'object' || Array.isArray(aporte)) return null;
    if (!Array.isArray(aporte.entradas) || aporte.entradas.length <= max) return null;
    try {
      const destino = path.join(this.almacen.rutasDeLogs(id).dir, 'aporte-recortado.json');
      fs.writeFileSync(destino, JSON.stringify({ ...aporte, entradas: aporte.entradas.slice(0, max) }));
      return destino;
    } catch {
      return null;
    }
  }

  /**
   * Auto-integración (opt-in del perfil `autoIntegrar`): cuando un trabajo `safe` con
   * commit termina `succeeded` y cumple las condiciones, se integra solo en la rama de
   * integración reutilizando `integrar` (misma lógica que `opencode_merge`; nunca avanza
   * la base). Ante conflicto queda `succeeded` con una advertencia y el motivo.
   *
   * @param {string} id
   * @param {object|null} perfil
   * @returns {Promise<void>}
   */
  async #autoIntegrar(id, perfil) {
    const config = perfil?.autoIntegrar;
    if (config?.habilitado !== true) return;
    const trabajo = this.trabajos.get(id);
    if (!trabajo || trabajo.estado !== 'succeeded' || trabajo.mode !== 'safe') return;
    const resultado = trabajo.resultado ?? {};
    if (!resultado.commit) return; // sin commit no hay nada que integrar
    if (config.requiereRevisor && resultado.revision?.veredicto !== 'APRUEBA') {
      this.#eventoDeTrabajo(id, { tipo: 'autointegracion_omitida', motivo: 'revision_no_aprueba' });
      return;
    }
    const advertencias = Array.isArray(resultado.advertencias) ? resultado.advertencias : [];
    if (config.soloSinAdvertencias && advertencias.length > 0) {
      this.#eventoDeTrabajo(id, { tipo: 'autointegracion_omitida', motivo: 'con_advertencias' });
      return;
    }
    let res;
    try {
      res = await this.integrar(id, { actor: 'servidor:auto' });
    } catch (error) {
      res = { ok: false, motivo: mensajeDeError(error) };
    }
    const actual = this.trabajos.get(id);
    if (res.ok) {
      // `integrar` ya dejó `merged` y registró el evento `merge` con actor 'servidor:auto'.
      this.#guardar(id, { resultado: { ...actual.resultado, autoIntegrado: true, autoIntegradoEn: res.rama } }, 'servidor:auto');
      this.#eventoDeTrabajo(id, { tipo: 'autointegrado', sha: res.sha, rama: res.rama });
      return;
    }
    const motivo =
      res.motivo === 'base_no_sincronizable'
        ? 'no se pudo sincronizar la base dentro de la integración'
        : Array.isArray(res.conflictos) && res.conflictos.length > 0
          ? `conflictos: ${res.conflictos.join(', ')}`
          : res.motivo ?? 'no se pudo integrar';
    const advert =
      `No se pudo integrar automáticamente (${motivo}). Queda succeeded: integralo con opencode_merge.`;
    this.#guardar(id, { resultado: { ...actual.resultado, advertencias: [...advertencias, advert] } }, 'servidor:auto');
    this.#eventoDeTrabajo(id, { tipo: 'autointegracion_fallida', motivo: res.motivo ?? null, conflictos: res.conflictos ?? null });
  }

  /**
   * Ejecuta el revisor automático de solo lectura sobre un trabajo ya verificado.
   *
   * POR QUÉ un agente readonly apuntando al MISMO worktree: no hace falta uno nuevo (no
   * escribe) y el revisor debe ver exactamente lo que quedó en el árbol del trabajo. Su
   * fallo no puede tumbar el trabajo: cualquier problema devuelve INDETERMINADO con una
   * advertencia, y jamás se propaga una excepción.
   *
   * @param {string} id
   * @param {object} opciones
   * @returns {Promise<object|null>} `{veredicto, observaciones, crudo, resumen}` o null si no aplica
   */
  async #revisar(id, { job, perfil, raizTrabajo, baseCommit, archivosTrabajo, cwdTrabajo, entorno, rutas, ctl, advertencias }) {
    const config = perfil.revisor;
    const corresponde = debeRevisar({
      modo: job.mode,
      estado: 'succeeded',
      config,
      archivos: archivosTrabajo,
      soloAceptacion: job.soloAceptacion,
    });
    if (!corresponde) return null;

    // El diff puede ser grande: se acota con `maxDiffBytes` DENTRO del prompt, no acá.
    let diff = '';
    try {
      diff = await git(['diff', '--no-color', baseCommit], raizTrabajo);
    } catch (error) {
      advertencias.push(`no se pudo calcular el diff para la revisión: ${mensajeDeError(error)}`);
    }

    const modeloRevision = config.modelo ?? job.modelo;
    const promptRevision = construirPromptRevision({
      tarea: job.prompt,
      writes: job.writes,
      archivos: archivosTrabajo,
      diff,
      reglas: config.reglas,
      plantilla: config.prompt,
      maxDiffBytes: config.maxDiffBytes,
    });

    let revision = { veredicto: 'INDETERMINADO', observaciones: [], crudo: '' };
    try {
      const rutaConfigRevision = escribirConfigDeTrabajo(
        path.join(rutas.dir, 'revision'),
        generarConfigDeTrabajo({
          modo: 'readonly',
          writes: [],
          protegidos: perfil.protected ?? [],
          modelo: modeloRevision,
          nombreAgente: NOMBRE_AGENTE,
        }),
      );
      const entornoRevision = {
        ...entornoDeTrabajo({
          rutaConfig: rutaConfigRevision,
          base: {
            ...entorno,
            ORQ_JOB_ID: id,
            ORQ_WORKTREE: raizTrabajo,
            ORQ_BRANCH: this.trabajos.get(id).rama ?? '',
          },
        }),
        PWD: cwdTrabajo,
      };
      const args = construirArgs({
        prompt: promptRevision,
        modo: 'readonly',
        modelo: modeloRevision,
        files: [],
        agente: NOMBRE_AGENTE,
      });
      let salida = '';
      const resultado = await ejecutar({
        cmd: this.opencode.cmd,
        args: [...this.opencode.argsPrefijo, ...args],
        cwd: cwdTrabajo,
        env: entornoRevision,
        stdoutPath: path.join(rutas.dir, 'revision.log'),
        stderrPath: path.join(rutas.dir, 'revision.err.log'),
        maxLogBytes: perfil.logs?.maxBytes,
        timeoutMs: REVISION_TIMEOUT_MS,
        graceMs: this.graceMs,
        signal: ctl.signal,
        onSalida: (evento) => {
          salida += evento.texto;
          // Mismo tope que `#correrComando`: una respuesta enorme no debe acumularse
          // sin límite en memoria mientras el revisor corre.
          if (salida.length > TOPE_SALIDA_COMANDO) salida = salida.slice(-TOPE_SALIDA_COMANDO);
        },
      });
      if (resultado.motivo !== 'exit' || resultado.code !== 0) {
        const motivo = resultado.code !== null && resultado.code !== undefined ? `${resultado.motivo} (exit ${resultado.code})` : resultado.motivo;
        advertencias.push(`el revisor automático no terminó bien (${motivo}); la revisión queda INDETERMINADA`);
        revision = { veredicto: 'INDETERMINADO', observaciones: [], crudo: salida.slice(0, 1000) };
      } else {
        revision = parsearVeredicto(salida);
        if (revision.veredicto === 'INDETERMINADO') {
          advertencias.push('no se pudo interpretar la respuesta del revisor automático; la revisión queda INDETERMINADA');
        }
      }
    } catch (error) {
      advertencias.push(`el revisor automático falló (${mensajeDeError(error)}); la revisión queda INDETERMINADA`);
      revision = { veredicto: 'INDETERMINADO', observaciones: [], crudo: '' };
    }

    revision.resumen = resumenRevision(revision);
    const detalle = { veredicto: revision.veredicto, observaciones: revision.observaciones.length };
    this.#evento({ tipo: 'job.revision', jobId: id, ...detalle });
    this.#eventoDeTrabajo(id, { tipo: 'job.revision', ...detalle });
    return revision;
  }

  /** Cierra el trabajo en un estado terminal persistiendo el resultado. */
  #terminar(id, estado, datos = {}) {
    const actual = this.trabajos.get(id);
    if (!actual || esTerminal(actual.estado)) return;
    // El actor puede venir de una cancelación pedida por una herramienta MCP.
    const actor = this.actores.get(id) ?? 'servidor';
    this.actores.delete(id);
    // `integrable` (para el planificador): solo un `succeeded` CON commit se puede integrar.
    // Un succeeded sin commit (el agente no escribió nada) o una compuerta sin commit no
    // debe frenar a los que solapan writes (de lo contrario la cola se traba para siempre).
    const integrable = estado === 'succeeded' && Boolean(datos.commit);
    const guardado = this.#guardar(
      id,
      { estado, resultado: datos, motivoFin: datos.motivoFin ?? null, error: datos.error ?? null, integrable },
      actor,
    );
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
    let trabajo = this.trabajos.get(id);
    if (!trabajo) {
      // Los trabajos más antiguos no se cargan en memoria (retención); se leen del
      // disco bajo demanda y quedan cacheados para las siguientes consultas.
      try {
        trabajo = this.almacen.leer(id) ?? undefined;
      } catch {
        trabajo = undefined;
      }
      if (trabajo) this.trabajos.set(id, trabajo);
    }
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
    return leerColaDeArchivo(path.join(this.almacen.rutasDeLogs(id).dir, 'aceptacion.log'), { bytes });
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
      identidad: this.#identidadDe(perfil, trabajo.repo),
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
      // Con `esperarIntegracion`, los trabajos frenados por este ya pueden arrancar.
      this.#bombear();
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
   * Purga los logs PESADOS de los trabajos TERMINADOS hace más de los días que
   * declara la retención del perfil de su repo, conservando `job.json`. Registra un
   * evento global `cleanup` con la cantidad y los bytes liberados. Best-effort.
   *
   * @param {{ ahora?: number }} [opciones]
   * @returns {Promise<{ cantidad: number, bytes: number }>}
   */
  async purgarLogsAntiguos({ ahora = Date.now() } = {}) {
    let cantidad = 0;
    let bytes = 0;
    // Se recorren TODOS los trabajos del disco (no solo los cargados en memoria): los
    // más viejos son justamente los candidatos a purgar.
    const todos = this.almacen.listar({ maxEnMemoria: 0 }).trabajos;
    /** @type {Map<string, object|null>} */
    const perfiles = new Map();
    for (const trabajo of todos) {
      if (!esTerminal(trabajo.estado)) continue;
      let perfil = perfiles.get(trabajo.repo);
      if (perfil === undefined) {
        try {
          perfil = await this.#perfilDe(trabajo.repo);
        } catch {
          perfil = null;
        }
        perfiles.set(trabajo.repo, perfil);
      }
      const dias = perfil?.retencion?.dias ?? 30;
      const limite = ahora - dias * 24 * 60 * 60 * 1000;
      if ((trabajo.finEn ?? 0) >= limite) continue;
      const res = this.almacen.purgarLogsDeTrabajo(trabajo.id);
      cantidad += res.cantidad;
      bytes += res.bytes;
    }
    if (cantidad > 0) this.#evento({ tipo: 'cleanup', detalle: { motivo: 'retencion', cantidad, bytes } });
    return { cantidad, bytes };
  }

  /**
   * Inicia la retención de logs: una purga inmediata y luego cada `intervaloMs`
   * (6 h por defecto). El timer es `unref()` para no mantener vivo el proceso, y
   * `cerrar()` lo cancela.
   *
   * @param {{ intervaloMs?: number }} [opciones]
   * @returns {void}
   */
  iniciarRetencion({ intervaloMs = 6 * 60 * 60 * 1000 } = {}) {
    if (this.timerRetencion) return;
    void this.purgarLogsAntiguos().catch(() => {});
    this.timerRetencion = setInterval(() => {
      void this.purgarLogsAntiguos().catch(() => {});
    }, intervaloMs);
    this.timerRetencion.unref?.();
  }

  /**
   * Cierre ordenado: no acepta más trabajos, descarta la cola y cancela lo que corre
   * (matando los grupos) esperando a que liberen sus recursos.
   * @param {number} [esperaMs=20000]
   */
  async cerrar(esperaMs = 20000) {
    this.cerrado = true;
    if (this.timerRetencion) {
      clearInterval(this.timerRetencion);
      this.timerRetencion = null;
    }
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

