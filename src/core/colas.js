/**
 * Lectura de la COLA (final) de un archivo de log, compartida por el gestor, el
 * almacén y el panel.
 *
 * POR QUÉ un módulo aparte: la misma operación (leer los últimos bytes de un log
 * sin cargar el archivo entero, tolerando un corte en medio de un carácter
 * multibyte) estaba duplicada en tres lugares y ya había divergido en detalles
 * (el panel agrega un marcador de recorte; el gestor y el almacén no). Un único
 * punto evita que las tres copias se separen con el tiempo.
 */
import fs from 'node:fs';

/**
 * Lee los últimos `bytes` de un archivo SIN leerlo entero (open + fstat + read
 * desde el offset). Si el corte cayó en medio de un carácter multibyte, descarta
 * los bytes de continuación iniciales para no devolver basura.
 *
 * @param {string} archivo ruta absoluta (ya validada por el llamador)
 * @param {{ bytes?: number, recortar?: boolean }} [opciones] `bytes` = cuántos
 *   bytes del final (0/ausente = nada); `recortar` = si quedó contenido afuera,
 *   anteponer el marcador `[... recortado ...]` y descartar la primera línea
 *   (posiblemente partida). El panel usa `recortar`; el resto no.
 * @returns {string}
 */
export function leerColaDeArchivo(archivo, { bytes = 0, recortar = false } = {}) {
  const cantidad = Number.isInteger(bytes) && bytes > 0 ? bytes : 0;
  if (cantidad === 0) return '';

  let fd;
  try {
    fd = fs.openSync(archivo, 'r');
  } catch {
    return ''; // archivo ausente: vacío, nunca lanza
  }
  try {
    const tamano = fs.fstatSync(fd).size;
    const aLeer = Math.min(cantidad, tamano);
    if (aLeer === 0) return '';
    const buffer = Buffer.alloc(aLeer);
    fs.readSync(fd, buffer, 0, aLeer, tamano - aLeer);
    let inicio = 0;
    while (inicio < buffer.length && (buffer[inicio] & 0xc0) === 0x80) inicio += 1;
    let texto = buffer.subarray(inicio).toString('utf8');
    if (recortar && tamano > aLeer) {
      texto = `[... recortado ...]\n${texto.slice(texto.indexOf('\n') + 1)}`;
    }
    return texto;
  } finally {
    fs.closeSync(fd);
  }
}
