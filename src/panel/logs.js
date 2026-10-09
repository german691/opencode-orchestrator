/**
 * Lectura por rangos de los logs de un trabajo para el panel en vivo.
 *
 * POR QUÉ por rangos de bytes y no leer el archivo entero: la consola del agente y
 * la de aceptación pueden crecer mucho, y el navegador solo necesita el tramo nuevo.
 * Se devuelven offsets en BYTES (`siguiente`) para que el cliente pida el próximo
 * trozo con `desde = siguiente` sin releer lo ya visto ni perder nada si el archivo
 * sigue creciendo entre pedidos.
 *
 * El corte se ajusta a borde de línea y de carácter UTF-8: una línea a medias se
 * completa en la próxima lectura y un carácter multibyte partido nunca se muestra
 * como basura.
 */
import fs from 'node:fs';
import { sinAnsi } from './datos.js';

/** Máximo de bytes que se pueden pedir de una sola vez. */
export const LIMITE_MAX = 65536;

/**
 * Fuentes lógicas del panel y el archivo del trabajo que alimentan cada una.
 * POR QUÉ un mapa fijo: la fuente nunca llega a formar una ruta, así una cadena
 * arbitraria no puede salirse del directorio del trabajo.
 */
export const FUENTES = Object.freeze({
  agente: 'stderr.log', // consola/transcript del agente opencode
  aceptacion: 'aceptacion.log', // stdout de la compuerta de aceptación
  stderr: 'aceptacion.err.log', // stderr de la compuerta de aceptación
});

/**
 * Nombre de archivo de una fuente lógica; `null` si la fuente no existe.
 * @param {unknown} fuente
 * @returns {string|null}
 */
export function archivoDeFuente(fuente) {
  return Object.hasOwn(FUENTES, fuente) ? FUENTES[fuente] : null;
}

/**
 * Retrocede un buffer hasta el último carácter UTF-8 completo. Se usa solo cuando
 * NO se llegó al final del archivo y el corte pudo partir una secuencia multibyte.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function recortarUtf8(buffer) {
  let i = buffer.length;
  if (i === 0) return buffer;
  let continuacion = 0;
  while (continuacion < 3 && i - 1 - continuacion >= 0 && (buffer[i - 1 - continuacion] & 0xc0) === 0x80) {
    continuacion += 1;
  }
  const inicio = i - 1 - continuacion;
  const lead = buffer[inicio];
  let esperado;
  if ((lead & 0x80) === 0) esperado = 1;
  else if ((lead & 0xe0) === 0xc0) esperado = 2;
  else if ((lead & 0xf0) === 0xe0) esperado = 3;
  else if ((lead & 0xf8) === 0xf0) esperado = 4;
  else return buffer.subarray(0, inicio); // byte inicial inválido: lo descartamos
  return i - inicio >= esperado ? buffer : buffer.subarray(0, inicio);
}

/**
 * Lee hasta `limite` bytes del archivo a partir del offset `desde`.
 *
 * @param {string} archivo ruta absoluta (ya validada por el llamador)
 * @param {{ desde?: number, limite?: number, ansi?: boolean }} [opciones]
 *   `desde`/`limite` en bytes; `ansi: true` conserva las secuencias de color.
 * @returns {{ texto: string, desde: number, siguiente: number, tamano: number, fin: boolean }}
 *   `siguiente` es el offset a pasar en la próxima lectura; `fin` indica que no
 *   queda nada por leer (aunque después el archivo crezca).
 */
export function leerRango(archivo, { desde = 0, limite = LIMITE_MAX, ansi = false } = {}) {
  const vacio = { texto: '', desde: 0, siguiente: 0, tamano: 0, fin: true };
  let fd;
  try {
    fd = fs.openSync(archivo, 'r');
  } catch {
    // Sin fuente todavía: devolver vacío deja al cliente seguir sondeando sin romperse.
    return vacio;
  }
  try {
    const tamano = fs.fstatSync(fd).size;
    const deseado = Number.isFinite(desde) ? Math.max(0, Math.trunc(desde)) : 0;
    const inicio = Math.min(deseado, tamano);
    const tope = Number.isFinite(limite) && limite > 0 ? Math.min(Math.trunc(limite), LIMITE_MAX) : LIMITE_MAX;
    const cantidad = Math.min(tope, tamano - inicio);
    if (cantidad <= 0) {
      return { texto: '', desde: inicio, siguiente: tamano, tamano, fin: true };
    }

    const buffer = Buffer.alloc(cantidad);
    const leidos = fs.readSync(fd, buffer, 0, cantidad, inicio);
    let trozo = buffer.subarray(0, leidos);

    // Si `desde` cayó dentro de un carácter, saltamos los bytes de continuación.
    let arranque = 0;
    if (inicio > 0) {
      while (arranque < trozo.length && (trozo[arranque] & 0xc0) === 0x80) arranque += 1;
      trozo = trozo.subarray(arranque);
    }

    let fin = inicio + leidos >= tamano;
    if (!fin) {
      // No llegamos al final: recortamos hasta el último salto de línea para no
      // devolver media línea; el offset queda al inicio de la línea incompleta.
      const salto = trozo.lastIndexOf(0x0a);
      if (salto >= 0) trozo = trozo.subarray(0, salto + 1);
      trozo = recortarUtf8(trozo);
    }

    let texto = trozo.toString('utf8');
    if (!ansi) texto = sinAnsi(texto);
    const siguiente = inicio + arranque + trozo.length;
    return { texto, desde: inicio, siguiente, tamano, fin: siguiente >= tamano };
  } finally {
    fs.closeSync(fd);
  }
}
