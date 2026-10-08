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
  const fallos =
    resumirFallos({ stdout: sinAnsi(aceptacionOut), stderr: sinAnsi(aceptacionErr) }) ?? null;
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
