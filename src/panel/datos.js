/**
 * Lectura (SOLO LECTURA) del estado de los trabajos para el panel en vivo.
 *
 * POR QUÉ: el panel no debe poder alterar ni frenar al orquestador. Por eso
 * únicamente lee los mismos archivos que éste escribe (`job.json`, logs y
 * `events.jsonl`) y nunca los abre para escritura ni toma el lock del servidor.
 * Un archivo ausente o a medio escribir se tolera: devuelve vacío, no explota.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resumirFallos } from '../core/fallos.js';
import { verificarCambios } from '../core/scope.js';
import { diffDeTrabajo } from './diff.js';

const TERMINALES = new Set(['succeeded', 'failed', 'cancelled', 'rejected', 'lost', 'merged']);
const ACTIVOS = new Set(['provisioning', 'running', 'verifying']);

/** Segundos sin salida a partir de los cuales el indicador pasa a amarillo / rojo. */
export const UMBRAL_AMARILLO_S = 120;
export const UMBRAL_ROJO_S = 300;

/** Máximo de bytes de log que se envían al navegador (la cola). */
const MAX_BYTES_LOG = 60_000;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** @returns {string} directorio de estado, igual que el del orquestador */
export function directorioEstado(env = process.env) {
  return (
    env.ORQ_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'opencode-orchestrator')
  );
}

function leerJson(archivo) {
  try {
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch {
    return null;
  }
}

function mtimeMs(archivo) {
  try {
    return fs.statSync(archivo).mtimeMs;
  } catch {
    return 0;
  }
}

/** Lee los últimos `max` bytes de un archivo como texto (vacío si no existe). */
export function leerCola(archivo, max = MAX_BYTES_LOG) {
  let fd;
  try {
    fd = fs.openSync(archivo, 'r');
    const { size } = fs.fstatSync(fd);
    const inicio = Math.max(0, size - max);
    const buffer = Buffer.alloc(size - inicio);
    fs.readSync(fd, buffer, 0, buffer.length, inicio);
    let texto = buffer.toString('utf8');
    if (inicio > 0) texto = `[... recortado ...]\n${texto.slice(texto.indexOf('\n') + 1)}`;
    return texto;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Quita secuencias de color ANSI del transcript de opencode. */
export function sinAnsi(texto) {
  return texto.replace(ANSI, '');
}

/** Valida que el id sea un nombre de carpeta simple (evita salir del directorio). */
export function idValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * Semáforo de atasco a partir de segundos sin salida.
 * @param {number|null} segundos
 * @returns {'verde'|'amarillo'|'rojo'|null}
 */
export function semaforo(segundos) {
  if (segundos === null) return null;
  if (segundos > UMBRAL_ROJO_S) return 'rojo';
  if (segundos > UMBRAL_AMARILLO_S) return 'amarillo';
  return 'verde';
}

/** Última vez (ms epoch) que algún log del trabajo recibió salida. */
function ultimaSalidaMs(dir) {
  return Math.max(
    mtimeMs(path.join(dir, 'stderr.log')),
    mtimeMs(path.join(dir, 'stdout.log')),
    mtimeMs(path.join(dir, 'aceptacion.log')),
    mtimeMs(path.join(dir, 'aceptacion.err.log')),
  );
}

function finDelTrabajo(dir) {
  try {
    const lineas = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    for (let i = lineas.length - 1; i >= 0; i -= 1) {
      const evento = JSON.parse(lineas[i]);
      if (evento.tipo === 'fin') return evento.ocurridoEn;
    }
  } catch {
    // sin eventos todavía
  }
  return null;
}

/** Resumen liviano de un trabajo (sin el prompt completo). */
export function resumenDeTrabajo(baseDir, id, ahora = Date.now()) {
  const dir = path.join(baseDir, id);
  const job = leerJson(path.join(dir, 'job.json'));
  if (!job) return null;
  const terminal = TERMINALES.has(job.estado);
  const fin = terminal ? (finDelTrabajo(dir) ?? mtimeMs(path.join(dir, 'job.json'))) : null;
  const ultima = ultimaSalidaMs(dir);
  const segundosSinSalida =
    ACTIVOS.has(job.estado) && ultima > 0 ? Math.max(0, Math.round((ahora - ultima) / 1000)) : null;
  const inicio = job.creadoEn ?? null;
  return {
    id: job.id ?? id,
    titulo: job.titulo ?? '',
    estado: job.estado,
    modo: job.mode ?? null,
    modelo: job.modelo ?? null,
    rama: job.rama ?? null,
    writes: job.writes ?? [],
    creadoEn: inicio,
    finEn: fin,
    duracionS: inicio ? Math.max(0, Math.round(((fin ?? ahora) - inicio) / 1000)) : null,
    segundosSinSalida,
    semaforo: semaforo(segundosSinSalida),
    motivoFin: job.motivoFin ?? null,
    error: job.error ?? null,
    // Por qué sigue en cola (motivo + ids que lo frenan), lo calcula el planificador.
    espera: job.estado === 'queued' ? (job.espera ?? null) : null,
  };
}

/** Lista los trabajos, los activos primero y luego por antigüedad descendente. */
export function listarTrabajos(baseDir, ahora = Date.now()) {
  let ids = [];
  try {
    ids = fs.readdirSync(baseDir);
  } catch {
    return [];
  }
  const resumenes = ids
    .filter(idValido)
    .map((id) => resumenDeTrabajo(baseDir, id, ahora))
    .filter(Boolean);
  const peso = (j) => (TERMINALES.has(j.estado) ? 1 : 0);
  return resumenes.sort((a, b) => peso(a) - peso(b) || (b.creadoEn ?? 0) - (a.creadoEn ?? 0));
}

/** Detalle de un trabajo: transcript del agente, respuesta final y fallos de la aceptación. */
export function detalleDeTrabajo(baseDir, id, ahora = Date.now()) {
  if (!idValido(id)) return null;
  const resumen = resumenDeTrabajo(baseDir, id, ahora);
  if (!resumen) return null;
  const dir = path.join(baseDir, id);
  const job = leerJson(path.join(dir, 'job.json')) ?? {};
  const aceptacionOut = leerCola(path.join(dir, 'aceptacion.log'));
  const aceptacionErr = leerCola(path.join(dir, 'aceptacion.err.log'));
  const aceptacion = job.resultado?.aceptacion ?? null;
  // Solo hay "fallos" si la aceptación terminó y falló: un log parcial en curso
  // (o uno verde con tests que mencionan "fail") no debe alarmar.
  const fallo = aceptacion !== null && aceptacion.ejecutada === true && aceptacion.exit !== 0;
  const fallos = fallo
    ? (resumirFallos({ stdout: sinAnsi(aceptacionOut), stderr: sinAnsi(aceptacionErr) }) ?? null)
    : null;
  return {
    ...resumen,
    cwd: job.cwd ?? null,
    worktree: job.worktree ?? null,
    prompt: job.prompt ?? '',
    transcript: sinAnsi(leerCola(path.join(dir, 'stderr.log'))),
    respuesta: sinAnsi(leerCola(path.join(dir, 'stdout.log'))),
    aceptacion: aceptacion
      ? {
          cmd: aceptacion.cmd ?? null,
          ejecutada: aceptacion.ejecutada ?? null,
          exit: aceptacion.exit ?? null,
        }
      : null,
    fallos,
    aceptacionCola: sinAnsi(aceptacionOut).slice(-6000),
    advertencias: job.resultado?.advertencias ?? [],
    archivos: job.resultado?.archivos ?? job.resultado?.cambios ?? [],
  };
}

/**
 * Id de trabajo exigido por las rutas NUEVAS del panel: alfanumérico corto (los ids
 * generados son 8 hex). Es MÁS estricto que `idValido` para que ninguna ruta nueva
 * pueda usarse para salir del directorio de trabajo.
 */
export const ID_PANEL = /^[a-z0-9]{6,16}$/i;

/** @returns {boolean} si el id cumple el formato estricto de las rutas nuevas */
export function idDePanel(id) {
  return typeof id === 'string' && ID_PANEL.test(id);
}

/**
 * Lee el `job.json` crudo de un trabajo (para quien necesita campos que el resumen
 * no expone, p. ej. `repo`, `baseCommit` o `rama`).
 * @param {string} baseDir
 * @param {string} id
 * @returns {object|null}
 */
export function leerTrabajo(baseDir, id) {
  if (!idValido(id)) return null;
  return leerJson(path.join(baseDir, id, 'job.json'));
}

/**
 * Resumen global del panel: cuántos trabajos hay en cada estado y el último evento.
 * @param {string} baseDir directorio `jobs`
 * @param {{ ahora?: number, registro?: object|null, concurrencia?: number|null }} [opciones]
 *   `concurrencia` viene del perfil si el panel la conoce; si no, se informa `null`.
 * @returns {object}
 */
export function estadoDelPanel(baseDir, { ahora = Date.now(), registro = null, concurrencia = null } = {}) {
  const trabajos = listarTrabajos(baseDir, ahora);
  /** @type {Record<string, number>} */
  const porEstado = {};
  for (const trabajo of trabajos) {
    porEstado[trabajo.estado] = (porEstado[trabajo.estado] ?? 0) + 1;
  }
  const ultimoEvento = registro ? (registro.listar({ limite: 1 })[0] ?? null) : null;
  return {
    ahora,
    concurrencia,
    corriendo: porEstado.running ?? 0,
    enCola: porEstado.queued ?? 0,
    verificando: porEstado.verifying ?? 0,
    total: trabajos.length,
    porEstado,
    ultimoEvento,
  };
}

/**
 * Patrones protegidos del perfil tal como quedaron en la config del trabajo.
 *
 * POR QUÉ leer `opencode.jsonc` del propio trabajo: el panel no conoce el perfil,
 * pero el gestor ya volcó ahí las reglas `edit`; las de tipo `deny` (salvo `*`) son
 * exactamente los protegidos, sin tener que re-resolver el perfil.
 * @param {string} dir directorio del trabajo
 * @returns {string[]}
 */
export function protegidasDelTrabajo(dir) {
  const config = leerJson(path.join(dir, 'opencode.jsonc'));
  const agente = config?.agent && typeof config.agent === 'object' ? Object.values(config.agent)[0] : null;
  const edit = agente?.permission?.edit;
  if (!edit || typeof edit !== 'object') return [];
  return Object.entries(edit)
    .filter(([clave, valor]) => valor === 'deny' && clave !== '*')
    .map(([clave]) => clave);
}

/**
 * Alcance declarado, archivos tocados y resultado de un trabajo para la UI.
 *
 * Reutiliza `job.json` (writes, resultado) y, si el worktree/rama siguen ahí, el diff
 * git para saber qué archivos tocó y cuáles quedaron fuera de `writes`/protegidos.
 *
 * @param {string} baseDir directorio `jobs`
 * @param {string} id
 * @param {{ ahora?: number, diff?: typeof diffDeTrabajo }} [opciones] `diff` inyectable para tests
 * @returns {Promise<object|null>} `null` si el trabajo no existe o el id es inválido
 */
export async function alcanceDeTrabajo(baseDir, id, { ahora = Date.now(), diff = diffDeTrabajo } = {}) {
  if (!idValido(id)) return null;
  const resumen = resumenDeTrabajo(baseDir, id, ahora);
  if (!resumen) return null;
  const dir = path.join(baseDir, id);
  const job = leerJson(path.join(dir, 'job.json')) ?? {};
  const resultado = job.resultado ?? {};
  const writes = Array.isArray(job.writes) ? job.writes : [];
  const protegidas = Array.isArray(job.protegidas)
    ? job.protegidas
    : Array.isArray(resultado.protegidas)
      ? resultado.protegidas
      : protegidasDelTrabajo(dir);

  // Preferimos el diff real del worktree (estado por archivo); si ya no está, usamos
  // la lista que dejó el resultado del trabajo.
  let tocados = [];
  const diffRes = await diff(job);
  if (diffRes.disponible) {
    tocados = diffRes.archivos.map(({ ruta, estado }) => ({ ruta, estado }));
  } else if (Array.isArray(resultado.archivos)) {
    tocados = resultado.archivos.map((ruta) => ({ ruta, estado: 'modificado' }));
  }

  const violaciones = Array.isArray(resultado.violaciones)
    ? resultado.violaciones
    : verificarCambios({ archivosCambiados: tocados.map((t) => t.ruta), writes, protegidos: protegidas, modo: job.mode ?? 'safe' }).violaciones;

  return {
    writes,
    protegidas,
    tocados,
    fuera: violaciones.map((v) => v.ruta),
    mutaciones: resultado.mutaciones ?? null,
    revision: resultado.revision ?? null,
  };
}

/**
 * Eventos del registro global filtrados por trabajo (vacío si no hay registro).
 * @param {object|null} registro
 * @param {string} id
 * @param {{ limite?: number }} [opciones]
 * @returns {object[]}
 */
export function eventosDeTrabajo(registro, id, { limite = 200 } = {}) {
  return registro ? registro.listar({ jobId: id, limite }) : [];
}
