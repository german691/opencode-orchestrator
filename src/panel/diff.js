/**
 * Diff git de un trabajo para el panel (solo lectura).
 *
 * POR QUÉ `execFile` sin shell y argumentos fijos: el id del trabajo nunca se
 * interpola en un comando; los refs (`baseCommit`, `rama`) salen de `job.json` y se
 * pasan como argv, de modo que un valor raro jamás se interpreta como shell.
 *
 * El diff se pide contra el worktree si todavía existe (incluye lo commiteado y lo
 * sin commitear), si ya se limpió contra la rama y, si la rama también se borró,
 * contra `resultado.commit`. Todas las llamadas corren con `-c safe.directory`
 * acotado al directorio del trabajo (ver `argsConDirectorioSeguro`). Cuando nada
 * corre se informa `disponible: false` junto con `motivo` y `detalle`.
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
 * Antepone `-c safe.directory=<cwd>` al subcomando de git.
 *
 * POR QUÉ: el panel corre como servicio sin `HOME`/config global y los repos y
 * worktrees pueden pertenecer a otro usuario o a un FS montado (/mnt/c); sin esto
 * git rechaza todo con "detected dubious ownership". Se acota SIEMPRE al
 * directorio concreto del trabajo (nunca `'*'`, que abriría cualquier repo).
 *
 * @param {string[]} args argumentos del subcomando (p. ej. `['diff', ...refs]`)
 * @param {string} [cwd] directorio desde el que corre git
 * @returns {string[]} argumentos con la excepción de propiedad si hay `cwd`
 */
export function argsConDirectorioSeguro(args, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return [...args];
  return ['-c', `safe.directory=${cwd}`, ...args];
}

/**
 * Primera línea con contenido de un texto, recortada: es el `detalle` corto que
 * la UI muestra cuando el diff no está disponible.
 * @param {string} texto
 * @returns {string}
 */
export function primerRenglon(texto) {
  const linea = String(texto ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return (linea ?? '').slice(0, 300);
}

/** git responde así cuando un ref/commit no existe en el repositorio. */
const REVISION_INEXISTENTE = /bad (object|revision)|unknown revision|not a valid object name|invalid object name|ambiguous argument/i;

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
 * Orden de intentos:
 *  1) contra el worktree (incluye lo commiteado y lo sin commitear);
 *  2) contra la rama `job/<id>` en el repo;
 *  3) contra `resultado.commit` en el repo (cuando ya se integró y limpió el
 *     worktree y la rama, pero el commit sigue existiendo).
 * Si ninguno corre, la respuesta trae `motivo` y `detalle` para que la UI explique.
 *
 * @param {object} job `job.json` del trabajo (usa `worktree`, `rama`, `repo`, `baseCommit`, `resultado.commit`)
 * @param {{ ejecutar?: typeof ejecutarGit, maxBytes?: number, timeoutMs?: number }} [opciones]
 * @returns {Promise<{ archivos: Array<object>, parche: string, truncado: boolean, disponible: boolean,
 *   motivo?: 'sin_base'|'sin_worktree'|'git_fallo'|'commit_inexistente', detalle?: string }>}
 */
export async function diffDeTrabajo(job, { ejecutar = ejecutarGit, maxBytes = MAX_PARCHE_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  const vacio = { archivos: [], parche: '', truncado: false, disponible: false };
  if (job === null || typeof job !== 'object') return { ...vacio, motivo: 'sin_base', detalle: '' };
  const base = typeof job.baseCommit === 'string' && job.baseCommit !== '' ? job.baseCommit : null;
  if (base === null) return { ...vacio, motivo: 'sin_base', detalle: '' };

  const repo = typeof job.repo === 'string' && job.repo !== '' ? job.repo : null;
  const rama = typeof job.rama === 'string' && job.rama !== '' ? job.rama : null;
  const commit =
    typeof job.resultado?.commit === 'string' && job.resultado.commit !== '' ? job.resultado.commit : null;

  /** @type {Array<{ cwd: string, refs: string[], tipo: string }>} */
  const destinos = [];
  if (typeof job.worktree === 'string' && job.worktree !== '') {
    destinos.push({ cwd: job.worktree, refs: [base], tipo: 'worktree' });
  }
  if (repo !== null && rama !== null) {
    destinos.push({ cwd: repo, refs: [base, rama], tipo: 'rama' });
  }
  if (repo !== null && commit !== null) {
    destinos.push({ cwd: repo, refs: [base, commit], tipo: 'commit' });
  }
  if (destinos.length === 0) return { ...vacio, motivo: 'sin_worktree', detalle: '' };

  let ultimoGitFallo = '';
  let falloCommit = null;
  for (const destino of destinos) {
    const argsDiff = argsConDirectorioSeguro(['diff', '--no-color', ...destino.refs], destino.cwd);
    const parcheRes = await ejecutar(argsDiff, { cwd: destino.cwd, timeoutMs });
    if (parcheRes.codigo !== 0) {
      ultimoGitFallo = primerRenglon(parcheRes.stderr);
      if (destino.tipo === 'commit') falloCommit = ultimoGitFallo;
      continue; // worktree, rama o commit inexistente: se prueba el siguiente
    }
    const [nameStatusRes, numstatRes] = await Promise.all([
      ejecutar(argsConDirectorioSeguro(['diff', '--name-status', ...destino.refs], destino.cwd), {
        cwd: destino.cwd,
        timeoutMs,
      }),
      ejecutar(argsConDirectorioSeguro(['diff', '--numstat', ...destino.refs], destino.cwd), {
        cwd: destino.cwd,
        timeoutMs,
      }),
    ]);
    const archivos =
      nameStatusRes.codigo === 0 && numstatRes.codigo === 0
        ? unirArchivos(nameStatusRes.stdout, numstatRes.stdout)
        : [];
    const { parche, truncado } = recortarParche(parcheRes.stdout, maxBytes);
    return { archivos, parche, truncado, disponible: true };
  }
  if (falloCommit !== null && REVISION_INEXISTENTE.test(falloCommit)) {
    return { ...vacio, motivo: 'commit_inexistente', detalle: falloCommit };
  }
  return { ...vacio, motivo: 'git_fallo', detalle: ultimoGitFallo };
}
