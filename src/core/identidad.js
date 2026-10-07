/**
 * Identidad de un proceso en Linux (§8, S1): permite distinguir NUESTRO proceso
 * de otro que reutilice el mismo pid/pgid tras un reinicio de WSL o de la máquina.
 *
 * POR QUÉ: el pid (y con `detached`, el pgid) son efímeros; el sistema los
 * reutiliza. Guardar solo el pgid y matarlo a ciegas tras un reinicio puede matar
 * un proceso AJENO que casualmente tenga ese número. La tupla
 * `(bootId, starttime)` es estable mientras el proceso vive y distinta en
 * cualquier otro arranque o instancia.
 *
 * POR QUÉ se lee /proc directamente y sin dependencias: es la única fuente que
 * expone `starttime` (campo 22 de `stat`) y `boot_id` sin invocar binarios
 * externos. En plataformas sin /proc, la identidad simplemente no es calculable
 * y se devuelve `null` (nunca se lanza).
 */

import fs from 'node:fs';

/** Ruta del identificador de arranque del kernel. */
const RUTA_BOOT_ID = '/proc/sys/kernel/random/boot_id';

/**
 * ¿Existe `/proc`? Es la puerta a toda la identidad. Si no está (por ejemplo en
 * Windows o macOS), no hay identidad posible.
 * @returns {boolean}
 */
function hayProc() {
  try {
    return fs.statSync('/proc').isDirectory();
  } catch {
    return false;
  }
}

/**
 * Contenido recortado de `boot_id` (identifica este arranque del kernel), o
 * `null` si no se puede leer.
 * @returns {string|null}
 */
export function bootIdActual() {
  try {
    const texto = fs.readFileSync(RUTA_BOOT_ID, 'utf8').trim();
    return texto === '' ? null : texto;
  } catch {
    return null;
  }
}

/**
 * Extrae `starttime` (campo 22) de una línea de `/proc/<pid>/stat`.
 *
 * POR QUÉ cortamos por el ÚLTIMO `)`: el campo `comm` (entre paréntesis) puede
 * contener espacios e incluso paréntesis —un ejecutable llamado `nodo (raro) x`
 * produce `123 (nodo (raro) x) S ...`—, así que `split(' ')` sobre la línea
 * entera o buscar el primer `)` rompería el parseo. Tras el último `)` los
 * campos no contienen espacios, de modo que `state` es el primero y `starttime`
 * el 20º de ese tramo (campo global 22).
 *
 * @param {string} texto contenido crudo de `/proc/<pid>/stat`
 * @returns {number|null}
 */
function inicioDeStat(texto) {
  // MUTACION TEMPORAL: parseo ingenuo con split(' ') sobre toda la línea.
  const todos = texto.trim().split(/\s+/);
  const valor = Number(todos[21]);
  return Number.isFinite(valor) ? valor : null;
  const cierre = texto.lastIndexOf(')');
  if (cierre < 0) return null;
  const resto = texto.slice(cierre + 1).trim();
  if (resto === '') return null;
  const campos = resto.split(/\s+/);
  // campos[0] = state (campo 3). starttime = campo 22 -> índice 19.
  const crudo = campos[19];
  if (crudo === undefined) return null;
  const valor = Number(crudo);
  return Number.isFinite(valor) ? valor : null;
}

/**
 * Identidad del proceso `pid`: `{ inicio, bootId }`, o `null` si el proceso no
 * existe, no hay `/proc` o el `stat` es ilegible.
 *
 * @param {number} pid
 * @returns {{ inicio: number, bootId: string|null }|null}
 */
export function identidadDeProceso(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!hayProc()) return null;
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null; // no existe (o sin permiso para leerlo)
  }
  const inicio = inicioDeStat(stat);
  if (inicio === null) return null;
  return { inicio, bootId: bootIdActual() };
}

/**
 * ¿La identidad guardada corresponde al proceso actual? Solo es verdadero si
 * AMBAS existen, comparten `bootId` y comparten `inicio`. Cualquier dato faltante
 * o distinto se considera "no coincide": ante la duda, jamás se mata.
 *
 * @param {{ inicio?: unknown, bootId?: unknown }|null|undefined} guardada
 * @param {{ inicio?: unknown, bootId?: unknown }|null|undefined} actual
 * @returns {boolean}
 */
export function coincideIdentidad(guardada, actual) {
  if (!guardada || !actual) return false;
  if (typeof guardada.inicio !== 'number' || typeof actual.inicio !== 'number') return false;
  if (typeof guardada.bootId !== 'string' || typeof actual.bootId !== 'string') return false;
  return guardada.bootId === actual.bootId && guardada.inicio === actual.inicio;
}
