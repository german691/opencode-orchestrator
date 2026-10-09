/**
 * Diff git de un trabajo para el panel (solo lectura).
 *
 * POR QUÉ `execFile` sin shell y argumentos fijos: el id del trabajo nunca se
 * interpola en un comando; los refs (`baseCommit`, `rama`) salen de `job.json` y se
 * pasan como argv, de modo que un valor raro jamás se interpreta como shell.
 *
 * El diff se pide contra el worktree si todavía existe (incluye lo commiteado y lo
 * sin commitear) y, si ya se limpió, contra la rama. Si no hay ninguno de los dos,
 * se informa `disponible: false` en vez de fallar.
 */
import { execFile } from 'node:child_process';

/** Tope del parche que se devuelve al navegador (400 KB). */
export const MAX_PARCHE_BYTES = 400 * 1024;

/** Tiempo máximo de cada invocación de git. */
export const TIMEOUT_MS = 10_000;

/** Tope interno del buffer de salida (más que el parche para poder marcar `truncado`). */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Ejecuta git sin shell y normaliza el resultado.
 * @param {string[]} args argumentos fijos (nunca construidos desde el id)
 * @param {{ cwd?: string, timeoutMs?: number }} [opciones]
 * @returns {Promise<{ codigo: number, stdout: string, stderr: string }>}
 */
export function ejecutarGit(args, { cwd, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const codigo = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
        resolve({ codigo, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * Trunca un diff a `max` bytes cortando en un salto de línea para no dejar media
 * línea ni un carácter multibyte partido.
 * @param {string} texto
 * @param {number} [max]
 * @returns {{ parche: string, truncado: boolean }}
 */
export function recortarParche(texto, max = MAX_PARCHE_BYTES) {
  const buffer = Buffer.from(texto, 'utf8');
  if (buffer.length <= max) return { parche: texto, truncado: false };
  let corte = buffer.lastIndexOf(0x0a, max);
  if (corte <= 0) corte = max;
  // Evita terminar dentro de una secuencia UTF-8 si el corte no cayó en un salto.
  while (corte > 0 && (buffer[corte] & 0xc0) === 0x80) corte -= 1;
  return { parche: buffer.subarray(0, corte).toString('utf8'), truncado: true };
}

/** Normaliza la ruta de una línea de `--numstat` con renombre ("viejo => nuevo"). */
function rutaDeNumstat(ruta) {
  if (!ruta.includes(' => ')) return ruta;
  const conLlaves = /\{[^{}]*? => ([^{}]*)\}/.exec(ruta);
  if (conLlaves) return ruta.replace(conLlaves[0], conLlaves[1]);
  return ruta.slice(ruta.indexOf(' => ') + 4);
}

/**
 * Combina `--name-status` (estado) y `--numstat` (adiciones/eliminaciones) por ruta.
 * @param {string} nameStatus
 * @param {string} numstat
 * @returns {Array<{ ruta: string, estado: string, adiciones: number, eliminaciones: number }>}
 */
export function unirArchivos(nameStatus, numstat) {
  /** @type {Map<string, { ruta: string, estado: string, adiciones: number, eliminaciones: number }>} */
  const porRuta = new Map();
  for (const linea of nameStatus.split('\n')) {
    if (linea.trim() === '') continue;
    const partes = linea.split('\t');
    const estado = (partes[0] ?? '').slice(0, 1) || 'M';
    const ruta = partes[partes.length - 1];
    if (ruta) porRuta.set(ruta, { ruta, estado, adiciones: 0, eliminaciones: 0 });
  }
  for (const linea of numstat.split('\n')) {
    if (linea.trim() === '') continue;
    const partes = linea.split('\t');
    if (partes.length < 3) continue;
    const adiciones = partes[0] === '-' ? 0 : Number(partes[0]) || 0;
    const eliminaciones = partes[1] === '-' ? 0 : Number(partes[1]) || 0;
    const ruta = rutaDeNumstat(partes[2]);
    const actual = porRuta.get(ruta);
    if (actual) {
      actual.adiciones = adiciones;
      actual.eliminaciones = eliminaciones;
    } else {
      porRuta.set(ruta, { ruta, estado: 'M', adiciones, eliminaciones });
    }
  }
  return [...porRuta.values()];
}

/**
 * Diff de un trabajo contra su base.
 *
 * @param {object} job `job.json` del trabajo (usa `worktree`, `rama`, `repo`, `baseCommit`)
 * @param {{ ejecutar?: typeof ejecutarGit, maxBytes?: number, timeoutMs?: number }} [opciones]
 * @returns {Promise<{ archivos: Array<object>, parche: string, truncado: boolean, disponible: boolean }>}
 */
export async function diffDeTrabajo(job, { ejecutar = ejecutarGit, maxBytes = MAX_PARCHE_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  const vacio = { archivos: [], parche: '', truncado: false, disponible: false };
  if (job === null || typeof job !== 'object') return vacio;
  const base = typeof job.baseCommit === 'string' && job.baseCommit !== '' ? job.baseCommit : null;
  if (base === null) return vacio;

  /** @type {Array<{ cwd: string, refs: string[] }>} */
  const destinos = [];
  if (typeof job.worktree === 'string' && job.worktree !== '') {
    destinos.push({ cwd: job.worktree, refs: [base] });
  }
  if (typeof job.repo === 'string' && job.repo !== '' && typeof job.rama === 'string' && job.rama !== '') {
    destinos.push({ cwd: job.repo, refs: [base, job.rama] });
  }

  for (const destino of destinos) {
    const parcheRes = await ejecutar(['diff', '--no-color', ...destino.refs], { cwd: destino.cwd, timeoutMs });
    if (parcheRes.codigo !== 0) continue; // worktree o rama inexistente: se prueba el siguiente
    const [nameStatusRes, numstatRes] = await Promise.all([
      ejecutar(['diff', '--name-status', ...destino.refs], { cwd: destino.cwd, timeoutMs }),
      ejecutar(['diff', '--numstat', ...destino.refs], { cwd: destino.cwd, timeoutMs }),
    ]);
    const archivos =
      nameStatusRes.codigo === 0 && numstatRes.codigo === 0
        ? unirArchivos(nameStatusRes.stdout, numstatRes.stdout)
        : [];
    const { parche, truncado } = recortarParche(parcheRes.stdout, maxBytes);
    return { archivos, parche, truncado, disponible: true };
  }
  return vacio;
}
