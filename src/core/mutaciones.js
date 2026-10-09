/**
 * Mutaciones del servidor (Fase 3, §13): el agente DECLARA en un manifiesto qué
 * texto cambiar, con qué reemplazo y qué comando correr, y el servidor aplica el
 * cambio, corre el comando y RESTAURA siempre el original.
 *
 * POR QUÉ existe este módulo: hoy los agentes mutan archivos a mano y los
 * restauran; si el proceso muere a mitad de camino el archivo queda mutado. Al
 * declarar la mutación, la restauración queda en un `finally` con verificación
 * por sha256, de modo que una mutación no puede "quedar pegada" ni siquiera ante
 * un error o un timeout del comando.
 *
 * POR QUÉ trabajamos con Buffer y no con texto: los archivos pueden ser binarios
 * o usar CRLF; cualquier decodificación/re-codificación alteraría bytes ajenos al
 * reemplazo. Buscamos y sustituimos byte a byte y restauramos la copia EXACTA.
 *
 * POR QUÉ la mutación se considera DETECTADA si el comando sale distinto de 0 (o
 * expira): la idea es comprobar que la suite de tests "nota" el cambio. Un comando
 * que termina en 0 tras la mutación significa que los tests NO la detectaron.
 *
 * Este módulo es independiente a propósito: no conoce el Gestor. Otro trabajo lo
 * conecta al ciclo de vida del servidor.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Ruta del manifiesto, relativa a la raíz del worktree. */
export const nombreManifiesto = '.orq/mutaciones.json';

/** Tope de mutaciones por manifiesto: acota el tiempo total de la corrida. */
const MAX_MUTACIONES = 20;

/**
 * Hash sha256 (hex) de un contenido binario. Se usa para comparar el archivo
 * restaurado con el original sin depender del sistema de archivos.
 * @param {Buffer} contenido
 * @returns {string}
 */
function sha256(contenido) {
  return createHash('sha256').update(contenido).digest('hex');
}

/**
 * Comprueba que el contenido de `absoluta` sea byte a byte el de `original`.
 * @param {string} absoluta
 * @param {string} esperado hash sha256 esperado
 * @returns {boolean}
 */
function coincideHash(absoluta, esperado) {
  try {
    return sha256(fs.readFileSync(absoluta)) === esperado;
  } catch {
    return false;
  }
}

/**
 * Valida y normaliza la ruta declarada de una mutación.
 *
 * Una `archivo` debe ser relativa, sin `..`, y su destino real (tras resolver
 * enlaces) debe quedar DENTRO del worktree. POR QUÉ con realpath: un enlace
 * simbólico dentro del worktree puede apuntar a un archivo externo; validar solo
 * el texto dejaría pasar una escritura fuera del aislamiento.
 *
 * @param {string} raizReal worktree ya resuelto con realpath
 * @param {unknown} archivo
 * @param {number} indice posición (0-based) para el mensaje
 * @returns {string} ruta relativa normalizada con '/' como separador
 */
function validarArchivo(raizReal, archivo, indice) {
  const etiqueta = `mutación #${indice + 1}`;
  if (typeof archivo !== 'string' || archivo.length === 0) {
    throw new Error(`${etiqueta}: 'archivo' debe ser un texto no vacío`);
  }
  if (path.isAbsolute(archivo)) {
    throw new Error(`${etiqueta}: 'archivo' debe ser relativo al worktree, no absoluto (${archivo})`);
  }
  const normalizada = archivo.replace(/\\/g, '/');
  if (normalizada.split('/').includes('..')) {
    throw new Error(`${etiqueta}: 'archivo' no puede contener '..' (${archivo})`);
  }

  const destino = path.resolve(raizReal, normalizada);
  let destinoReal;
  try {
    destinoReal = fs.realpathSync(destino);
  } catch {
    throw new Error(`${etiqueta}: el archivo declarado no existe (${archivo})`);
  }
  if (destinoReal !== raizReal && !destinoReal.startsWith(`${raizReal}${path.sep}`)) {
    throw new Error(`${etiqueta}: 'archivo' escapa del worktree por un enlace simbólico (${archivo})`);
  }
  return normalizada;
}

/**
 * Valida y normaliza una entrada del manifiesto.
 * @param {unknown} entrada
 * @param {number} indice
 * @param {string} raizReal
 * @returns {{ archivo: string, buscar: string, reemplazar: string, comando: string }}
 */
function normalizarMutacion(entrada, indice, raizReal) {
  const etiqueta = `mutación #${indice + 1}`;
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) {
    throw new Error(`${etiqueta}: cada mutación debe ser un objeto`);
  }
  for (const campo of ['archivo', 'buscar', 'comando']) {
    if (typeof entrada[campo] !== 'string' || entrada[campo].length === 0) {
      throw new Error(`${etiqueta}: '${campo}' debe ser un texto no vacío`);
    }
  }
  // `reemplazar` puede ser el string vacío (borrar el texto encontrado).
  if (typeof entrada.reemplazar !== 'string') {
    throw new Error(`${etiqueta}: 'reemplazar' debe ser un texto (puede ser vacío)`);
  }
  const archivo = validarArchivo(raizReal, entrada.archivo, indice);
  return { archivo, buscar: entrada.buscar, reemplazar: entrada.reemplazar, comando: entrada.comando };
}

/**
 * Lee, valida y normaliza el manifiesto de mutaciones.
 *
 * El worktree se deduce de la ubicación del manifiesto (`<worktree>/.orq/mutaciones.json`),
 * salvo que se pase explícitamente en `worktree` (útil cuando el llamador ya lo conoce).
 *
 * @param {string} ruta ruta del manifiesto
 * @param {string} [worktree] raíz del worktree; por defecto, el directorio que contiene `.orq`
 * @returns {Array<{ archivo: string, buscar: string, reemplazar: string, comando: string }>}
 * @throws {Error} con mensaje claro si el manifiesto no existe, no es JSON válido o no cumple el esquema
 */
export function leerManifiesto(ruta, worktree = path.resolve(path.dirname(ruta), '..')) {
  let crudo;
  try {
    crudo = fs.readFileSync(ruta, 'utf8');
  } catch {
    throw new Error(`No se pudo leer el manifiesto de mutaciones: ${ruta}`);
  }

  let datos;
  try {
    datos = JSON.parse(crudo);
  } catch (error) {
    throw new Error(`El manifiesto de mutaciones no es JSON válido (${ruta}): ${error.message}`);
  }

  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
    throw new Error(`El manifiesto debe ser un objeto con el campo 'mutaciones' (${ruta})`);
  }
  if (!Array.isArray(datos.mutaciones)) {
    throw new Error(`El campo 'mutaciones' debe ser un array (${ruta})`);
  }
  if (datos.mutaciones.length > MAX_MUTACIONES) {
    throw new Error(`El manifiesto declara ${datos.mutaciones.length} mutaciones; el máximo es ${MAX_MUTACIONES}`);
  }

  const raizReal = fs.realpathSync(worktree);
  return datos.mutaciones.map((entrada, indice) => normalizarMutacion(entrada, indice, raizReal));
}

/**
 * Lanza `comando` con `bash -lc`, captura stdout+stderr y mata TODO el grupo de
 * procesos si expira. Es el `correr` por defecto; los tests lo inyectan.
 *
 * POR QUÉ grupo propio (`detached`): un comando puede lanzar hijos (el runner de
 * tests); al expirar hay que matarlos a todos, no solo al líder.
 *
 * @param {string} comando línea de shell
 * @param {{ cwd: string, timeoutMs?: number }} opciones
 * @returns {Promise<{ codigo: number|null, salida: string, timeout: boolean }>}
 */
function correrPorDefecto(comando, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const hijo = spawn('bash', ['-lc', comando], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });

    let salida = '';
    let terminado = false;
    let expiro = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;

    const acumular = (fragmento) => {
      salida += fragmento.toString('utf8');
    };
    hijo.stdout?.on('data', acumular);
    hijo.stderr?.on('data', acumular);

    /** Mata el grupo entero; si ya no existe el grupo cae al `kill` del hijo. */
    const matarGrupo = (senal) => {
      try {
        process.kill(-hijo.pid, senal);
      } catch {
        try {
          hijo.kill(senal);
        } catch {
          /* ya murió */
        }
      }
    };

    const finalizar = (codigo) => {
      if (terminado) return;
      terminado = true;
      if (timer) clearTimeout(timer);
      resolve({ codigo: Number.isInteger(codigo) ? codigo : null, salida, timeout: expiro });
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        expiro = true;
        matarGrupo('SIGKILL');
      }, timeoutMs);
    }

    hijo.on('error', (error) => {
      salida += `\n[error al lanzar] ${error.message}`;
      finalizar(1);
    });
    hijo.on('close', (codigo) => {
      finalizar(codigo);
    });
  });
}

/**
 * Restaura el contenido original y verifica por sha256. Si la primera escritura
 * no dejó el archivo byte a byte igual, reintenta una vez; si aún difiere lanza
 * un error irrecuperable para que el servidor falle el trabajo.
 *
 * @param {string} absoluta
 * @param {Buffer} original copia exacta del contenido previo
 * @param {string} hashOriginal
 */
function restaurar(absoluta, original, hashOriginal) {
  fs.writeFileSync(absoluta, original);
  if (coincideHash(absoluta, hashOriginal)) return;

  fs.writeFileSync(absoluta, original);
  if (coincideHash(absoluta, hashOriginal)) return;

  const error = new Error(`RESTAURACION_FALLIDA: no se pudo restaurar ${absoluta}`);
  error.codigo = 'RESTAURACION_FALLIDA';
  throw error;
}

/**
 * Ejecuta las mutaciones declaradas: aplica, corre y restaura cada una.
 *
 * @param {object} opciones
 * @param {string} opciones.worktree raíz del worktree
 * @param {Array|{ mutaciones: Array }} opciones.manifiesto lista normalizada (o el objeto crudo)
 * @param {(archivo: string) => boolean} [opciones.permitido] callback de alcance; por defecto todo permitido
 * @param {(comando: string, opciones: { cwd: string, timeoutMs: number }) => Promise<{ codigo: number|null, salida: string, timeout?: boolean }>} [opciones.correr]
 * @param {number} [opciones.timeoutMs]
 * @returns {Promise<{ total: number, detectadas: number, restauradoOk: true, detalle: Array<{ archivo: string, comando: string, estado: string, codigo?: number|null, ms: number }> }>}
 */
export async function ejecutarMutaciones({ worktree, manifiesto, permitido, correr, timeoutMs = 300000 } = {}) {
  if (typeof worktree !== 'string' || worktree.length === 0) {
    throw new Error('ejecutarMutaciones requiere un worktree');
  }
  const lista = Array.isArray(manifiesto) ? manifiesto : manifiesto?.mutaciones;
  if (!Array.isArray(lista)) {
    throw new Error('ejecutarMutaciones requiere un manifiesto con mutaciones');
  }

  const raizReal = fs.realpathSync(worktree);
  const alcance = typeof permitido === 'function' ? permitido : () => true;
  const ejecutarComando = typeof correr === 'function' ? correr : correrPorDefecto;

  const detalle = [];
  let detectadas = 0;

  for (const [indice, cruda] of lista.entries()) {
    // Aunque el llamador normal (leerManifiesto) ya validó, `ejecutarMutaciones`
    // puede invocarse directo: repetimos la validación de ruta para no escribir
    // jamás fuera del worktree.
    const mutacion = normalizarMutacion(cruda, indice, raizReal);

    if (!alcance(mutacion.archivo)) {
      detalle.push({ archivo: mutacion.archivo, comando: mutacion.comando, estado: 'no_permitida', ms: 0 });
      continue;
    }

    const absoluta = path.resolve(raizReal, mutacion.archivo);
    const original = fs.readFileSync(absoluta);
    const hashOriginal = sha256(original);

    const buscar = Buffer.from(mutacion.buscar, 'utf8');
    const encontrado = original.indexOf(buscar);
    if (encontrado === -1) {
      detalle.push({ archivo: mutacion.archivo, comando: mutacion.comando, estado: 'no_aplicable', ms: 0 });
      continue;
    }

    // Reemplaza SOLO la primera aparición, preservando todos los demás bytes.
    const reemplazo = Buffer.from(mutacion.reemplazar, 'utf8');
    const mutado = Buffer.concat([
      original.subarray(0, encontrado),
      reemplazo,
      original.subarray(encontrado + buscar.length),
    ]);

    let codigo = null;
    const inicio = Date.now();
    try {
      fs.writeFileSync(absoluta, mutado);
      const resultado = await ejecutarComando(mutacion.comando, { cwd: raizReal, timeoutMs });
      codigo = resultado?.codigo ?? null;
      const expiro = resultado?.timeout === true;
      if (expiro || codigo !== 0) detectadas += 1;
      detalle.push({
        archivo: mutacion.archivo,
        comando: mutacion.comando,
        estado: expiro || codigo !== 0 ? 'detectada' : 'no_detectada',
        codigo,
        ms: Date.now() - inicio,
      });
    } finally {
      // SIEMPRE restauramos: pase lo que pase con el comando, el archivo vuelve a
      // ser byte a byte el original (o el trabajo falla con RESTAURACION_FALLIDA).
      restaurar(absoluta, original, hashOriginal);
    }
  }

  return { total: lista.length, detectadas, restauradoOk: true, detalle };
}

/**
 * Texto compacto del resultado para logs del servidor: `MUTACION: detectada N/M`
 * (N detectadas sobre M aplicables) y una línea por cada no detectada.
 *
 * @param {{ detalle?: Array<{ archivo: string, comando: string, estado: string }> }} resultado
 * @returns {string}
 */
export function resumen(resultado) {
  const detalle = resultado?.detalle ?? [];
  const aplicables = detalle.filter((d) => d.estado === 'detectada' || d.estado === 'no_detectada');
  const detectadas = detalle.filter((d) => d.estado === 'detectada');
  const lineas = [`MUTACION: detectada ${detectadas.length}/${aplicables.length}`];
  for (const noDetectada of aplicables) {
    if (noDetectada.estado === 'no_detectada') {
      lineas.push(`  no detectada: ${noDetectada.archivo} (${noDetectada.comando})`);
    }
  }
  return lineas.join('\n');
}
