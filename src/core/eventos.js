/**
 * Registro de eventos global del servidor (auditoría append-only en JSONL).
 *
 * POR QUÉ un archivo global aparte del `audit.log` y de los `events.jsonl` por
 * trabajo: centraliza en un único lugar el rastro de lo que hace el servidor
 * (arranques, transiciones de trabajos, merges, limpiezas) para poder auditarlo
 * o mostrarlo en el panel sin tocar el estado de los trabajos.
 *
 * POR QUÉ nunca lanza por fallo de E/S: la auditoría es observabilidad, no puede
 * frenar la operación que intenta registrarse. Un disco lleno, un directorio sin
 * permiso o una ruta ocupada devuelven `false` y el servidor sigue.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Tipos de evento válidos. Cualquier otro se rechaza al registrar. */
export const TIPOS = Object.freeze([
  'servidor.arranque',
  'servidor.recuperacion',
  'job.creado',
  'job.estado',
  'job.espera',
  'job.fin',
  'job.reintento',
  'job.reanudado',
  'job.cancelado',
  'job.mutaciones',
  'job.revision',
  'merge',
  'avanzar_base',
  'cleanup',
  'pizarron.post',
]);

/** Tamaño (bytes) a partir del cual `eventos.jsonl` se rota a `eventos.1.jsonl`. */
const TOPE_BYTES = 5 * 1024 * 1024;

/** Tamaño máximo (bytes) del campo `detalle` serializado. */
const LIMITE_DETALLE_BYTES = 4 * 1024;

/** Nombre del archivo principal y del único respaldo de rotación. */
const ARCHIVO = 'eventos.jsonl';
const ARCHIVO_ROTADO = 'eventos.1.jsonl';

/**
 * Trunca un texto por BYTES sin partir un carácter multibyte (retrocede hasta el
 * inicio del carácter si el corte cayó dentro de una secuencia UTF-8).
 * @param {string} texto
 * @param {number} max
 * @returns {string}
 */
function truncarBytes(texto, max) {
  const buffer = Buffer.from(texto, 'utf8');
  if (buffer.length <= max) return texto;
  let corte = max;
  while (corte > 0 && (buffer[corte] & 0xc0) === 0x80) corte -= 1;
  return buffer.subarray(0, corte).toString('utf8');
}

/**
 * Serializa `detalle` y, si supera el límite, lo reemplaza por su versión
 * truncada. POR QUÉ truncar: un detalle (p. ej. un diff o un error largo) no debe
 * hacer crecer sin límite una línea del registro.
 * @param {unknown} detalle
 * @returns {unknown}
 */
function limitarDetalle(detalle) {
  if (detalle === undefined) return undefined;
  let serializado;
  if (typeof detalle === 'string') {
    serializado = detalle;
  } else {
    try {
      serializado = JSON.stringify(detalle);
    } catch {
      serializado = String(detalle);
    }
  }
  if (typeof serializado !== 'string' || Buffer.byteLength(serializado, 'utf8') <= LIMITE_DETALLE_BYTES) {
    return detalle;
  }
  return truncarBytes(serializado, LIMITE_DETALLE_BYTES);
}

/**
 * Crea un registro de eventos sobre `<dir>/eventos.jsonl`.
 *
 * @param {{ dir: string, ahora?: () => number }} opciones `dir` es el directorio
 *   de estado; `ahora` permite inyectar el reloj en los tests.
 * @returns {{ registrar: (ev: object) => boolean, listar: (filtros?: object) => object[], tipos: readonly string[] }}
 */
export function crearRegistroEventos({ dir, ahora = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('crearRegistroEventos: falta el directorio (dir)');
  }
  const archivo = path.join(dir, ARCHIVO);
  const rotado = path.join(dir, ARCHIVO_ROTADO);

  /** Rota el archivo si ya superó el tope, conservando un solo respaldo. */
  function rotarSiHaceFalta() {
    let tamano;
    try {
      tamano = fs.statSync(archivo).size;
    } catch {
      return; // todavía no existe: nada que rotar
    }
    if (tamano <= TOPE_BYTES) return;
    try {
      // rename sobrescribe el respaldo anterior: se conserva una sola rotación.
      fs.renameSync(archivo, rotado);
    } catch {
      // si no se puede rotar se sigue anexando al mismo archivo
    }
  }

  /**
   * Agrega un evento. Valida `tipo` (error de programación: lanza) y devuelve
   * `false` ante cualquier fallo de E/S (no debe romper la operación auditada).
   * @param {object} [evento]
   * @returns {boolean} si se persistió
   */
  function registrar(evento = {}) {
    if (evento === null || typeof evento !== 'object' || Array.isArray(evento)) {
      throw new Error('evento inválido: se espera un objeto');
    }
    const { tipo } = evento;
    if (!TIPOS.includes(tipo)) {
      throw new Error(`tipo de evento desconocido: ${JSON.stringify(tipo)} (ver TIPOS en src/core/eventos.js)`);
    }
    const actor = typeof evento.actor === 'string' && evento.actor !== '' ? evento.actor : 'servidor';
    const completo = { ts: ahora(), tipo };
    for (const campo of ['jobId', 'estado', 'anterior', 'motivo']) {
      if (evento[campo] !== undefined) completo[campo] = evento[campo];
    }
    const detalle = limitarDetalle(evento.detalle);
    if (detalle !== undefined) completo.detalle = detalle;
    completo.actor = actor;

    try {
      fs.mkdirSync(dir, { recursive: true });
      rotarSiHaceFalta();
      fs.appendFileSync(archivo, `${JSON.stringify(completo)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lee, filtra y ordena los eventos. Tolera líneas corruptas o a medio escribir
   * (las ignora). Por defecto devuelve los 200 más recientes.
   * @param {{ jobId?: string, tipo?: string, desde?: number, hasta?: number, limite?: number, orden?: 'asc'|'desc' }} [filtros]
   * @returns {object[]}
   */
  function listar({ jobId, tipo, desde, hasta, limite = 200, orden = 'desc' } = {}) {
    let texto;
    try {
      texto = fs.readFileSync(archivo, 'utf8');
    } catch {
      return []; // sin registro todavía
    }
    const eventos = [];
    for (const linea of texto.split('\n')) {
      if (linea.trim() === '') continue;
      let evento;
      try {
        evento = JSON.parse(linea);
      } catch {
        continue; // línea corrupta: se ignora sin fallar
      }
      if (evento === null || typeof evento !== 'object') continue;
      if (jobId !== undefined && evento.jobId !== jobId) continue;
      if (tipo !== undefined && evento.tipo !== tipo) continue;
      if (desde !== undefined && !(evento.ts >= desde)) continue;
      if (hasta !== undefined && !(evento.ts <= hasta)) continue;
      eventos.push(evento);
    }
    if (orden !== 'asc') eventos.reverse();
    const tope = Number.isInteger(limite) && limite >= 0 ? limite : 200;
    return eventos.slice(0, tope);
  }

  return { registrar, listar, tipos: TIPOS };
}
