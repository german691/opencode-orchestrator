/**
 * Espacio de trabajo aislado por trabajo: worktrees, cambios reales y
 * integración en una rama aparte (§7, §9, §12.3).
 *
 * POR QUÉ git por `execFile` con argumentos en array (nunca por shell): un id de
 * trabajo, un nombre de rama o una ruta con caracteres raros jamás deben poder
 * inyectar comandos. Con array, git recibe cada valor como un argumento literal;
 * no hay una capa de shell que interprete `;`, `$()` ni espacios. La única
 * excepción deliberada son los comandos de `setup`, que el perfil declara como
 * líneas de shell y por tanto se ejecutan con `/bin/sh -c` a través del runner
 * (que les pone tope de tiempo y mata el grupo completo) (§7).
 *
 * POR QUÉ validamos rama y rutas antes de tocarlas: son la frontera de seguridad
 * del aislamiento. Una rama con `..` o una ruta que escapa de `rootDir` por un
 * enlace simbólico podría escribir fuera del aislamiento. Ante la duda, se lanza
 * un error claro ANTES de crear nada.
 *
 * POR QUÉ `-z`: los nombres de archivo pueden traer espacios, tildes, comillas e
 * incluso saltos de línea. El formato con NUL (`-z`) es el único que los entrega
 * sin ambigüedad y sin comillas, y por eso se usa en `status` y `diff`.
 *
 * POR QUÉ un cerrojo por repositorio: git usa locks internos; varias operaciones
 * `worktree add/remove/branch` simultáneas sobre el mismo repo pueden chocar. El
 * cerrojo serializa solo lo que MUTA la topología del repo, no el `setup` ni las
 * lecturas.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ejecutar } from './runner.js';

/** Id de trabajo válido: minúsculas/dígitos y guiones, sin barras ni puntos. */
const ID_TRABAJO = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Rama de trabajo válida. POR QUÉ se restringe a `job/<id>`: `eliminarWorktree`
 * e `integrar` reciben un nombre de rama; sin este filtro, un llamador podría
 * pasar `main`, `dev` o `staging` y destruir/integrar la rama equivocada.
 */
const RAMA_TRABAJO = /^job\/[a-z0-9][a-z0-9-]{0,40}$/;

/** Caracteres prohibidos en una rama (además de espacios y `..`). */
const PROHIBIDOS_EN_RAMA = ['~', '^', ':', '?', '*', '[', '\\'];

/** Tope de salida que acumulamos de un comando de `setup` para el mensaje de error. */
const TOPE_SALIDA_SETUP = 8000;

/** Tope de tiempo por defecto de un comando de `setup` (10 min). */
const SETUP_TIMEOUT_MS = 600000;

/**
 * Cerrojo en proceso por repositorio (§7). Serializa las operaciones que MUTAN
 * el repositorio (crear/eliminar worktrees, preparar/integrar) porque git usa
 * archivos de lock internos (`.git/worktrees/.../locked`, `index.lock`) que no
 * toleran carreras. El `setup` queda FUERA (puede tardar minutos y no cambia la
 * topología) y las lecturas también.
 *
 * POR QUÉ una cola de promesas por clave: es la forma más simple y sin
 * dependencias de garantizar exclusión mutua dentro del mismo proceso; cada
 * operación encadena su promesa a la anterior y libera al terminar (incluso si
 * falla), de modo que un error no bloquea el repo para siempre.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const cerrojosPorRepo = new Map();

/**
 * Clave canónica del repositorio (ruta real) para compartir el cerrojo aunque los
 * llamadores usen rutas distintas del mismo repo.
 * @param {string} repoRaiz
 * @returns {string}
 */
function claveRepo(repoRaiz) {
  try {
    return fs.realpathSync(repoRaiz);
  } catch {
    return path.resolve(repoRaiz);
  }
}

/**
 * Ejecuta `fn` en exclusión mutua con las demás operaciones del mismo repo.
 *
 * POR QUÉ se exporta: para poder probar de forma determinista que serializa y que
 * un error no bloquea la cola. El paralelismo con git real no falla de forma
 * reproducible (git admite varios `worktree add` de rutas distintas), así que la
 * garantía se prueba sobre el cerrojo mismo.
 *
 * @param {string} repoRaiz
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function conCerrojo(repoRaiz, fn) {
  const clave = claveRepo(repoRaiz);
  const anterior = cerrojosPorRepo.get(clave) ?? Promise.resolve();
  const actual = anterior.then(() => fn());
  // Guardamos una promesa que nunca rechaza: evita "unhandled rejection" en la
  // cola y no bloquea a los que llegan detrás si esta operación falla.
  const cola = actual.then(
    () => undefined,
    () => undefined,
  );
  cerrojosPorRepo.set(clave, cola);
  cola.then(() => {
    if (cerrojosPorRepo.get(clave) === cola) cerrojosPorRepo.delete(clave);
  });
  return actual;
}

/**
 * Error de espacio de trabajo, con la ruta o referencia afectada para poder
 * ubicarlo de un vistazo en el log del orquestador.
 */
export class ErrorDeWorkspace extends Error {
  /**
   * @param {string} mensaje
   */
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorDeWorkspace';
  }
}

/**
 * Ejecuta `git` con argumentos en array y devuelve la salida cruda.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opciones]
 * @returns {Promise<{ codigo: number, stdout: string, stderr: string }>}
 */
function git(args, opciones = {}) {
  const { cwd, env } = opciones;
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: env ?? process.env,
        maxBuffer: 128 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // `error.code` puede ser un número (código de salida) o un texto (ENOENT);
        // normalizamos todo lo que no sea un número a 1 para no confundir.
        const codigo = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
        resolve({
          codigo,
          stdout: stdout ? stdout.toString('utf8') : '',
          stderr: stderr ? stderr.toString('utf8') : '',
        });
      },
    );
  });
}

/**
 * Igual que `git`, pero lanza si el comando falla. El mensaje incluye el stderr
 * real de git, que es lo que hace diagnosticable un fallo de worktree o merge.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opciones]
 * @returns {Promise<string>} stdout
 * @throws {ErrorDeWorkspace}
 */
async function gitOLanza(args, opciones = {}) {
  const resultado = await git(args, opciones);
  if (resultado.codigo !== 0) {
    const detalle = (resultado.stderr || resultado.stdout).trim();
    throw new ErrorDeWorkspace(`git ${args.join(' ')} falló: ${detalle || `código ${resultado.codigo}`}`);
  }
  return resultado.stdout;
}

/**
 * Valida un id de trabajo. Es la primera barrera contra el path traversal: un id
 * con `/`, `..` o mayúsculas no puede llegar a formar parte de una ruta ni de un
 * nombre de rama.
 *
 * @param {unknown} jobId
 * @returns {string} el id validado
 * @throws {ErrorDeWorkspace}
 */
function validarJobId(jobId) {
  if (typeof jobId !== 'string' || !ID_TRABAJO.test(jobId)) {
    throw new ErrorDeWorkspace(
      `jobId inválido: ${JSON.stringify(jobId)} (se espera /^[a-z0-9][a-z0-9-]{0,40}$/)`,
    );
  }
  return jobId;
}

/**
 * Valida un nombre de rama según reglas conservadoras de `git check-ref-format`.
 *
 * @param {unknown} rama
 * @param {string} [campo='rama'] nombre del campo para el mensaje
 * @returns {string} la rama validada
 * @throws {ErrorDeWorkspace}
 */
function validarRama(rama, campo = 'rama') {
  if (typeof rama !== 'string' || rama.trim() === '') {
    throw new ErrorDeWorkspace(`${campo} inválida: debe ser un texto no vacío`);
  }
  if (/\s/.test(rama)) throw new ErrorDeWorkspace(`${campo} inválida: no puede contener espacios`);
  if (rama.includes('..')) throw new ErrorDeWorkspace(`${campo} inválida: no puede contener '..'`);
  if (rama.startsWith('-')) throw new ErrorDeWorkspace(`${campo} inválida: no puede empezar con '-'`);
  if (rama.startsWith('/') || rama.endsWith('/')) {
    throw new ErrorDeWorkspace(`${campo} inválida: no puede empezar ni terminar en '/'`);
  }
  if (rama.endsWith('.lock')) throw new ErrorDeWorkspace(`${campo} inválida: no puede terminar en '.lock'`);
  for (const caracter of PROHIBIDOS_EN_RAMA) {
    if (rama.includes(caracter)) {
      throw new ErrorDeWorkspace(`${campo} inválida: no puede contener '${caracter}'`);
    }
  }
  return rama;
}

/**
 * Valida una rama de trabajo: SOLO `job/<id>` (§9, W1). Se usa antes de borrar o
 * integrar una rama para que un `main`, `dev`, `staging` o una ref arbitraria no
 * puedan destruirse ni integrarse por error.
 *
 * @param {unknown} rama
 * @param {string} [campo='rama'] nombre del campo para el mensaje
 * @returns {string} la rama validada
 * @throws {ErrorDeWorkspace}
 */
function validarRamaTrabajo(rama, campo = 'rama') {
  if (typeof rama !== 'string' || !RAMA_TRABAJO.test(rama)) {
    throw new ErrorDeWorkspace(
      `${campo} inválida: ${JSON.stringify(rama)} (solo se permite /^job\\/[a-z0-9][a-z0-9-]{0,40}$/)`,
    );
  }
  return rama;
}

/**
 * Normaliza una ruta relativa declarada en `link` o en `excluir`: se usa '/' como
 * separador y se rechazan rutas absolutas o con `..`, que podrían escapar del
 * worktree.
 *
 * @param {unknown} relativa
 * @param {number} indice
 * @param {string} [campo='link'] nombre del campo para el mensaje
 * @returns {string}
 * @throws {ErrorDeWorkspace}
 */
function validarRutaRelativa(relativa, indice, campo = 'link') {
  if (typeof relativa !== 'string' || relativa.trim() === '') {
    throw new ErrorDeWorkspace(`${campo}[${indice}] inválido: debe ser un texto no vacío`);
  }
  const normalizada = relativa.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalizada === '' || normalizada.startsWith('/') || /^[A-Za-z]:\//.test(normalizada)) {
    throw new ErrorDeWorkspace(`${campo}[${indice}] inválido: '${relativa}' debe ser una ruta relativa`);
  }
  if (normalizada.split('/').includes('..')) {
    throw new ErrorDeWorkspace(`${campo}[${indice}] inválido: '${relativa}' no puede contener '..'`);
  }
  return normalizada;
}

/**
 * ¿La ruta `ruta` es igual a, o está contenida dentro de, algún elemento de
 * `ignorar`? POR QUÉ: los enlaces de `link` (p. ej. `node_modules`) no deben
 * contar como cambios ni entrar al commit; se filtran por ruta, no escribiendo en
 * el `info/exclude` compartido del repo real (§7, W3).
 *
 * @param {string} ruta relativa con '/'
 * @param {string[]} ignorar rutas relativas
 * @returns {boolean}
 */
function estaIgnorada(ruta, ignorar) {
  const candidata = ruta.replace(/\/+$/, '');
  return ignorar.some((patron) => {
    const base = String(patron).replace(/\\/g, '/').replace(/\/+$/, '');
    return base !== '' && (candidata === base || candidata.startsWith(`${base}/`));
  });
}

/**
 * Pathspec de exclusión para `git add`: `:(exclude)<ruta>` o
 * `:(exclude,literal)<ruta>` cuando la ruta trae caracteres de glob, para que git
 * la trate como un path exacto y no como patrón.
 *
 * @param {string} relativa ruta relativa con '/'
 * @returns {string}
 */
function pathspecExclusion(relativa) {
  const normalizada = relativa.replace(/\\/g, '/');
  return /[*?\[\]\\]/.test(normalizada)
    ? `:(exclude,literal)${normalizada}`
    : `:(exclude)${normalizada}`;
}

/**
 * ¿`candidato` está dentro de `base`? Compara rutas ya resueltas (sin enlaces) y
 * respeta el límite de directorio: '/a/bc' no está dentro de '/a/b'.
 *
 * @param {string} base ruta absoluta resuelta
 * @param {string} candidato ruta absoluta resuelta
 * @returns {boolean}
 */
function estaDentro(base, candidato) {
  const relativa = path.relative(base, candidato);
  return relativa === '' || (!relativa.startsWith(`..${path.sep}`) && relativa !== '..' && !path.isAbsolute(relativa));
}

/**
 * Devuelve la raíz del repositorio git que contiene `cwd`.
 *
 * @param {string} cwd ruta de trabajo (archivo o subcarpeta del repo)
 * @returns {Promise<string>} raíz real del repo (enlaces resueltos)
 * @throws {ErrorDeWorkspace} si `cwd` no está dentro de un repositorio git
 */
export async function raizGit(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new ErrorDeWorkspace('raizGit espera una ruta de trabajo no vacía');
  }
  const resultado = await git(['rev-parse', '--show-toplevel'], { cwd });
  if (resultado.codigo !== 0) {
    const detalle = resultado.stderr.trim();
    throw new ErrorDeWorkspace(`No es un repositorio git: ${cwd}${detalle ? ` (${detalle})` : ''}`);
  }
  const raiz = resultado.stdout.trim();
  if (raiz === '') throw new ErrorDeWorkspace(`No se pudo resolver la raíz git de: ${cwd}`);
  try {
    return fs.realpathSync(raiz);
  } catch {
    return raiz;
  }
}

/**
 * Corre un comando de shell (perfil `setup`) en el worktree a través del runner.
 *
 * POR QUÉ `/bin/sh -c` y no `spawn(..., { shell: true })`: así el runner puede
 * matar el grupo COMPLETO del setup (hijos y nietos) y aplicar timeouts. Un
 * `npm ci` colgado no debe bloquear el trabajo ni dejar procesos vivos (§7, W4).
 * No se interpola jamás el id ni una ruta en la línea: se ejecuta tal cual la
 * declaró el perfil. El entorno base se combina con el del perfil.
 *
 * @param {string} comando
 * @param {{ cwd: string, env: Record<string, string>, timeoutMs?: number, idleTimeoutMs?: number, signal?: AbortSignal }} opciones
 * @returns {Promise<{ motivo: string, code: number|null, salida: string }>}
 */
async function correrSetup(comando, { cwd, env, timeoutMs, idleTimeoutMs, signal }) {
  let salida = '';
  const resultado = await ejecutar({
    cmd: '/bin/sh',
    args: ['-c', comando],
    cwd,
    env: { ...process.env, ...env },
    timeoutMs,
    idleTimeoutMs,
    signal,
    onSalida: (evento) => {
      salida += evento.texto;
      if (salida.length > TOPE_SALIDA_SETUP) salida = salida.slice(-TOPE_SALIDA_SETUP);
    },
  });
  return { motivo: resultado.motivo, code: resultado.code, salida };
}

/**
 * Describe por qué falló un `setup` a partir del resultado del runner, para que
 * el error distinga un fallo normal de un timeout, una inactividad o una
 * cancelación (§7, W4).
 *
 * @param {{ motivo: string, code: number|null }} resultado
 * @returns {string}
 */
function describirSetup({ motivo, code }) {
  if (motivo === 'exit') return `falló (código ${code})`;
  if (motivo === 'timeout') return 'excedió el tiempo límite';
  if (motivo === 'idle') return 'quedó inactivo demasiado tiempo';
  if (motivo === 'cancelado') return 'fue cancelado';
  return `no pudo lanzarse (${motivo})`;
}

/**
 * Elimina un worktree y su rama, de forma best-effort, sin lanzar. Se usa para
 * limpiar tras un `setup` fallido: la operación principal ya va a fallar con su
 * propio error y no queremos enmascararlo.
 *
 * @param {string} repoRaiz
 * @param {string} ruta
 * @param {string} rama
 * @param {string} rootDir
 * @returns {Promise<void>}
 */
async function limpiarSilencioso(repoRaiz, ruta, rama, rootDir) {
  try {
    await eliminarWorktree({ repoRaiz, ruta, rama, borrarRama: true, rootDir });
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(ruta, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Crea un worktree aislado en la rama `job/<jobId>` a partir de `base`.
 *
 * Pasos y garantías:
 *  1. Se valida el id y se comprueba que `base` EXISTE antes de crear nada: si no,
 *     se lanza sin dejar rama ni directorio (nada de basura).
 *  2. `rootDir` se crea y se resuelve; se verifica que la ruta destino queda dentro
 *     de él (ni por `..` ni por un enlace que escape).
 *  3. Se crean enlaces simbólicos para cada ruta de `link`; los orígenes ausentes y
 *     los destinos ya versionados se omiten y se reportan en `enlacesOmitidos`.
 *     Los enlaces efectivamente creados se devuelven en `enlacesCreados` para que
 *     el llamador los excluya del commit y del cálculo de cambios (W3).
 *  4. Se corre cada comando de `setup` con el runner: tope de tiempo y cancelación
 *     por `signal`; si falla, expira o se cancela, se limpia worktree y rama.
 *
 * @param {object} opciones
 * @param {string} opciones.repoRaiz raíz del repositorio
 * @param {string} opciones.base rama o ref base (debe existir)
 * @param {string} opciones.jobId id del trabajo
 * @param {string} opciones.rootDir directorio raíz de los worktrees (absoluto)
 * @param {string[]} [opciones.link] rutas relativas a enlazar desde el repo
 * @param {string[]} [opciones.setup] comandos de shell a correr tras crear
 * @param {Record<string, string>} [opciones.env] variables extra para `setup`
 * @param {number} [opciones.setupTimeoutMs=600000] tope total por comando de setup
 * @param {number} [opciones.idleTimeoutMs] tope sin salida por comando de setup
 * @param {AbortSignal} [opciones.signal] cancelación del setup
 * @returns {Promise<{ ruta: string, rama: string, baseCommit: string, enlacesCreados: string[], enlacesOmitidos: string[] }>}
 * @throws {ErrorDeWorkspace}
 */
export async function crearWorktree({
  repoRaiz,
  base,
  jobId,
  rootDir,
  link = [],
  setup = [],
  env = {},
  setupTimeoutMs = SETUP_TIMEOUT_MS,
  idleTimeoutMs,
  signal,
} = {}) {
  const id = validarJobId(jobId);
  validarRama(base, 'base');
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new ErrorDeWorkspace('rootDir debe ser un texto no vacío');
  }
  if (!Array.isArray(link)) throw new ErrorDeWorkspace('link debe ser un array de rutas relativas');
  if (!Array.isArray(setup)) throw new ErrorDeWorkspace('setup debe ser un array de comandos');
  if (setupTimeoutMs !== undefined && (!Number.isFinite(setupTimeoutMs) || setupTimeoutMs < 0)) {
    throw new ErrorDeWorkspace('setupTimeoutMs debe ser un número no negativo');
  }

  const rama = `job/${id}`;

  // La creación de la topología (verificar base, `worktree add` y rama) va bajo el
  // cerrojo del repo (W5). Los enlaces y el setup quedan FUERA: no mutan la
  // topología y el setup puede tardar minutos.
  const creado = await conCerrojo(repoRaiz, async () => {
    // 1) Verificar `base` ANTES de crear directorio o rama. Si no existe, no queda basura.
    const existenBase = await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: repoRaiz });
    if (existenBase.codigo !== 0) {
      throw new ErrorDeWorkspace(`La base '${base}' no existe en ${repoRaiz}`);
    }
    const baseCommit = (await gitOLanza(['rev-parse', `${base}^{commit}`], { cwd: repoRaiz })).trim();

    if (!path.isAbsolute(rootDir)) {
      throw new ErrorDeWorkspace(`rootDir debe ser una ruta absoluta: ${rootDir}`);
    }

    // 2) Crear y resolver rootDir; comprobar contención de la ruta destino.
    fs.mkdirSync(rootDir, { recursive: true });
    const realRoot = fs.realpathSync(rootDir);
    if (!fs.statSync(realRoot).isDirectory()) {
      throw new ErrorDeWorkspace(`rootDir no es un directorio: ${rootDir}`);
    }

    const rutaLexical = path.join(rootDir, id);
    const ruta = path.join(realRoot, id);
    if (!estaDentro(realRoot, ruta)) {
      throw new ErrorDeWorkspace(`La ruta del worktree escapa de rootDir: ${ruta}`);
    }
    // Un enlace simbólico en el destino podría hacer que git escribiera fuera del
    // aislamiento al seguir el enlace: se rechaza antes de tocar el repositorio.
    const existente = fs.lstatSync(rutaLexical, { throwIfNoEntry: false });
    if (existente) {
      if (existente.isSymbolicLink()) {
        const realDestino = fs.realpathSync(rutaLexical);
        if (!estaDentro(realRoot, realDestino)) {
          throw new ErrorDeWorkspace(`La ruta del worktree escapa de rootDir por un enlace: ${rutaLexical}`);
        }
      }
      throw new ErrorDeWorkspace(`La ruta del worktree ya existe: ${rutaLexical}`);
    }

    // 3) Crear el worktree y la rama. `-b` crea la rama en el mismo paso.
    const agregar = await git(['worktree', 'add', '-b', rama, ruta, baseCommit], { cwd: repoRaiz });
    if (agregar.codigo !== 0) {
      // git pudo crear parte del directorio; limpiamos sin borrar una rama ajena.
      try {
        fs.rmSync(ruta, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw new ErrorDeWorkspace(`No se pudo crear el worktree: ${(agregar.stderr || agregar.stdout).trim()}`);
    }

    return { ruta, rama, baseCommit };
  });

  /** @type {string[]} */
  const enlacesOmitidos = [];
  /** @type {string[]} */
  const enlacesCreados = [];
  try {
    for (let indice = 0; indice < link.length; indice += 1) {
      const relativa = validarRutaRelativa(link[indice], indice);
      const origen = path.join(repoRaiz, relativa);
      const origenStat = fs.lstatSync(origen, { throwIfNoEntry: false });
      if (!origenStat) {
        enlacesOmitidos.push(relativa);
        continue;
      }
      const destino = path.join(creado.ruta, relativa);
      if (!estaDentro(creado.ruta, destino)) {
        throw new ErrorDeWorkspace(`El enlace '${relativa}' escaparía del worktree`);
      }
      const destinoStat = fs.lstatSync(destino, { throwIfNoEntry: false });
      if (destinoStat) {
        // Destino ya presente (normalmente porque está versionado): no lo pisamos.
        enlacesOmitidos.push(relativa);
        continue;
      }
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.symlinkSync(origen, destino, origenStat.isDirectory() ? 'dir' : 'file');
      // NO se escribe en el `info/exclude` COMPARTIDO del repo real (W3): los
      // enlaces se filtran por ruta en `cambiosDelWorktree` y `commitearTrabajo`.
      enlacesCreados.push(relativa);
    }

    // 4) Setup FUERA del cerrojo, con tope de tiempo y cancelación (W4). Un fallo,
    // un timeout o una cancelación limpian TODO para no dejar un worktree a medias.
    for (const comando of setup) {
      if (typeof comando !== 'string') {
        throw new ErrorDeWorkspace('Cada comando de setup debe ser un texto');
      }
      const resultado = await correrSetup(comando, {
        cwd: creado.ruta,
        env,
        timeoutMs: setupTimeoutMs,
        idleTimeoutMs,
        signal,
      });
      if (resultado.motivo !== 'exit' || resultado.code !== 0) {
        throw new ErrorDeWorkspace(
          `setup ${describirSetup(resultado)}: ${comando}\n${resultado.salida.trim()}`,
        );
      }
    }
  } catch (error) {
    await limpiarSilencioso(repoRaiz, creado.ruta, rama, rootDir);
    throw error;
  }

  return { ...creado, enlacesCreados, enlacesOmitidos };
}

/**
 * Divide una salida de git con NUL (`-z`) en campos, descartando el vacío final.
 * @param {string} texto
 * @returns {string[]}
 */
function camposNul(texto) {
  const campos = texto.split('\0');
  if (campos.length > 0 && campos[campos.length - 1] === '') campos.pop();
  return campos;
}

/**
 * Cuenta un cambio en el resumen por tipo. Los renombrados/copiados cuentan como
 * modificación (la ruta cambió); el par origen/destino se lista aparte en `archivos`.
 * @param {{ agregados: number, modificados: number, borrados: number }} resumen
 * @param {string} estado letra de git (A, M, D, R, C, T…)
 */
function clasificarCambio(resumen, estado) {
  const letra = estado[0];
  if (letra === 'A') resumen.agregados += 1;
  else if (letra === 'D') resumen.borrados += 1;
  else resumen.modificados += 1; // M, R, C, T y cualquier otra se tratan como modificación
}

/**
 * Lista los archivos cambiados de un worktree respecto de `baseCommit`, incluyendo
 * sin trackear, modificados, borrados y renombrados (con AMBAS rutas).
 *
 * POR QUÉ dos fuentes: `git diff <base>` ve todo lo trackeado (staged, sin stage y
 * commits hechos sobre base) pero NO los sin trackear; `git status --porcelain`
 * aporta los `??` sin trackear y respeta `.gitignore`. Los enlaces de `link` NO se
 * escriben en `info/exclude` (W3): se filtran por ruta con `ignorar`.
 *
 * @param {object} opciones
 * @param {string} opciones.ruta worktree
 * @param {string} opciones.baseCommit sha base
 * @param {string[]} [opciones.ignorar] rutas relativas a excluir del listado y del
 *   resumen: se descarta todo path igual a, o contenido dentro de, un elemento.
 * @returns {Promise<{ archivos: string[], resumen: { agregados: number, modificados: number, borrados: number } }>}
 * @throws {ErrorDeWorkspace}
 */
export async function cambiosDelWorktree({ ruta, baseCommit, ignorar = [] } = {}) {
  if (typeof ruta !== 'string' || ruta.trim() === '') {
    throw new ErrorDeWorkspace('cambiosDelWorktree espera una ruta de worktree');
  }
  if (typeof baseCommit !== 'string' || baseCommit.trim() === '') {
    throw new ErrorDeWorkspace('cambiosDelWorktree espera un baseCommit');
  }
  if (!Array.isArray(ignorar)) throw new ErrorDeWorkspace('ignorar debe ser un array de rutas relativas');
  const ignorado = (r) => estaIgnorada(r, ignorar);

  /** @type {Set<string>} */
  const archivos = new Set();
  const resumen = { agregados: 0, modificados: 0, borrados: 0 };

  // Trackeados: A/M/D/R/C/T respecto de base, con detección de renombrados.
  const diff = await git(['diff', '--name-status', '-z', '-M', baseCommit], { cwd: ruta });
  if (diff.codigo !== 0) {
    throw new ErrorDeWorkspace(`No se pudo calcular el diff: ${diff.stderr.trim()}`);
  }
  const camposDiff = camposNul(diff.stdout);
  for (let i = 0; i < camposDiff.length; ) {
    const estado = camposDiff[i];
    i += 1;
    if (estado.startsWith('R') || estado.startsWith('C')) {
      // Formato `R<score>\0origen\0destino\0`: informamos AMBAS rutas.
      const origen = camposDiff[i];
      const destino = camposDiff[i + 1];
      i += 2;
      const origenVisible = origen && !ignorado(origen);
      const destinoVisible = destino && !ignorado(destino);
      if (!origenVisible && !destinoVisible) continue;
      if (origenVisible) archivos.add(origen);
      if (destinoVisible) archivos.add(destino);
      clasificarCambio(resumen, estado);
    } else {
      const rutaCambiada = camposDiff[i];
      i += 1;
      if (rutaCambiada && !ignorado(rutaCambiada)) {
        archivos.add(rutaCambiada);
        clasificarCambio(resumen, estado);
      }
    }
  }

  // Sin trackear (solo `??`; los ignorados por .gitignore no aparecen aquí).
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: ruta });
  if (status.codigo !== 0) {
    throw new ErrorDeWorkspace(`No se pudo calcular el estado: ${status.stderr.trim()}`);
  }
  const camposStatus = camposNul(status.stdout);
  for (let i = 0; i < camposStatus.length; ) {
    const registro = camposStatus[i];
    i += 1;
    const xy = registro.slice(0, 2);
    const rutaCambiada = registro.slice(3);
    if (xy.startsWith('R') || xy.startsWith('C')) {
      // En status -z el renombrado viene como `XY destino\0origen\0`.
      const origen = camposStatus[i];
      i += 1;
      if (origen && !ignorado(origen)) archivos.add(origen);
    }
    if (xy === '??') {
      if (rutaCambiada && !ignorado(rutaCambiada)) {
        archivos.add(rutaCambiada);
        resumen.agregados += 1; // sin trackear: cuenta como agregado
      }
    } else if (!archivos.has(rutaCambiada) && xy !== '!!') {
      // Cambio trackeado que el diff no mostró (p. ej. modo); lo incluimos igual.
      if (rutaCambiada && !ignorado(rutaCambiada)) archivos.add(rutaCambiada);
    }
  }

  const lista = [...archivos].filter((a) => a !== '').sort();
  return { archivos: lista, resumen };
}

/**
 * Agrega TODO (salvo lo excluido) y commitea en la rama del worktree. Nunca usa
 * `--no-verify` ni desactiva hooks: un hook de pre-commit debe poder bloquear el
 * trabajo (§8, §11).
 *
 * POR QUÉ `excluir` con pathspecs: los enlaces de `link` (p. ej. `node_modules`)
 * no deben entrar al commit. Se usa `git add -A -- . ':(exclude)<ruta>'` en vez de
 * escribir en el `info/exclude` compartido del repo real (W3). Si la ruta trae
 * caracteres de glob se marca `literal` para no excluir de más.
 *
 * @param {object} opciones
 * @param {string} opciones.ruta worktree
 * @param {string} opciones.mensaje mensaje de commit
 * @param {string} [opciones.autor] autor en formato `Nombre <email>`
 * @param {string[]} [opciones.excluir] rutas relativas que NO se deben commitear
 * @param {string[]} [opciones.soloArchivos] si se indica, SOLO se agregan estas rutas
 *   (ya verificadas contra el alcance): lo que genere un comando posterior, como los
 *   artefactos de la aceptación, no entra al commit
 * @returns {Promise<string|null>} sha del commit, o `null` si no había cambios
 * @throws {ErrorDeWorkspace}
 */
export async function commitearTrabajo({ ruta, mensaje, autor, excluir = [], soloArchivos } = {}) {
  if (typeof ruta !== 'string' || ruta.trim() === '') {
    throw new ErrorDeWorkspace('commitearTrabajo espera una ruta de worktree');
  }
  if (typeof mensaje !== 'string' || mensaje.trim() === '') {
    throw new ErrorDeWorkspace('commitearTrabajo espera un mensaje no vacío');
  }
  if (autor !== undefined && (typeof autor !== 'string' || autor.trim() === '')) {
    throw new ErrorDeWorkspace('autor debe ser un texto "Nombre <email>" o estar ausente');
  }
  if (autor !== undefined && autor.startsWith('-')) {
    // Un autor que empieza con '-' podría confundirse con una opción de git.
    throw new ErrorDeWorkspace('autor no puede empezar con "-"');
  }
  if (!Array.isArray(excluir)) throw new ErrorDeWorkspace('excluir debe ser un array de rutas relativas');

  if (soloArchivos !== undefined) {
    if (!Array.isArray(soloArchivos)) {
      throw new ErrorDeWorkspace('soloArchivos debe ser un array de rutas relativas');
    }
    // Pathspecs literales: un nombre con '*' o '[' no debe expandirse. Sin archivos
    // verificados no se agrega nada (jamás se cae a `.`).
    if (soloArchivos.length > 0) {
      const argsSolo = ['add', '-A', '--'];
      for (let indice = 0; indice < soloArchivos.length; indice += 1) {
        argsSolo.push(`:(literal)${validarRutaRelativa(soloArchivos[indice], indice, 'soloArchivos')}`);
      }
      await gitOLanza(argsSolo, { cwd: ruta });
    }
  } else {
    const argsAdd = ['add', '-A', '--', '.'];
    for (let indice = 0; indice < excluir.length; indice += 1) {
      const relativa = validarRutaRelativa(excluir[indice], indice, 'excluir');
      argsAdd.push(pathspecExclusion(relativa));
    }
    await gitOLanza(argsAdd, { cwd: ruta });
  }
  // `--quiet` con exit 0 = no hay nada staged; exit 1 = hay cambios.
  const sinCambios = await git(['diff', '--cached', '--quiet'], { cwd: ruta });
  if (sinCambios.codigo === 0) return null;

  const args = ['commit', '-m', mensaje];
  if (autor) args.push('--author', autor);
  await gitOLanza(args, { cwd: ruta });
  return (await gitOLanza(['rev-parse', 'HEAD'], { cwd: ruta })).trim();
}

/**
 * Asegura un worktree dedicado a la rama de integración, creándola desde `base`
 * si aún no existe. Se serializa con el cerrojo del repo (W5).
 *
 * @param {object} opciones
 * @param {string} opciones.repoRaiz
 * @param {string} opciones.integrationBranch
 * @param {string} opciones.base
 * @param {string} opciones.rootDirIntegracion
 * @returns {Promise<string>} ruta del worktree de integración
 */
export async function prepararIntegracion({ repoRaiz, integrationBranch, base, rootDirIntegracion }) {
  return conCerrojo(repoRaiz, () =>
    prepararIntegracionSinCerrojo({ repoRaiz, integrationBranch, base, rootDirIntegracion }),
  );
}

/**
 * Igual que `prepararIntegracion` pero SIN tomar el cerrojo. Se usa desde
 * `integrar`, que ya lo tiene tomado (así se evita un auto-bloqueo).
 *
 * @param {object} opciones
 * @param {string} opciones.repoRaiz
 * @param {string} opciones.integrationBranch
 * @param {string} opciones.base
 * @param {string} opciones.rootDirIntegracion
 * @returns {Promise<string>} ruta del worktree de integración
 */
async function prepararIntegracionSinCerrojo({ repoRaiz, integrationBranch, base, rootDirIntegracion }) {
  const existentes = await listarWorktrees(repoRaiz);
  const yaTieneWorktree = existentes.find((w) => w.rama === integrationBranch);
  if (yaTieneWorktree) return yaTieneWorktree.ruta;

  if (typeof rootDirIntegracion !== 'string' || rootDirIntegracion.trim() === '') {
    throw new ErrorDeWorkspace('rootDirIntegracion debe ser un texto no vacío');
  }
  if (!path.isAbsolute(rootDirIntegracion)) {
    throw new ErrorDeWorkspace(`rootDirIntegracion debe ser una ruta absoluta: ${rootDirIntegracion}`);
  }
  fs.mkdirSync(rootDirIntegracion, { recursive: true });
  const realRoot = fs.realpathSync(rootDirIntegracion);
  // El nombre de rama puede traer '/', que no es válido como nombre de carpeta único.
  const nombreCarpeta = integrationBranch.replace(/\//g, '__');
  const ruta = path.join(realRoot, nombreCarpeta);
  if (!estaDentro(realRoot, ruta)) {
    throw new ErrorDeWorkspace(`La ruta de integración escapa de rootDirIntegracion: ${ruta}`);
  }
  if (fs.existsSync(ruta)) {
    throw new ErrorDeWorkspace(`La ruta de integración ya existe: ${ruta}`);
  }

  const existeRama = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch}`], {
    cwd: repoRaiz,
  });
  const args =
    existeRama.codigo === 0
      ? ['worktree', 'add', ruta, integrationBranch]
      : ['worktree', 'add', '-b', integrationBranch, ruta, base];
  await gitOLanza(args, { cwd: repoRaiz });
  return ruta;
}

/**
 * Integra una rama de trabajo en la rama de integración mediante `--no-ff`, usando
 * un worktree dedicado.
 *
 * Garantías:
 *  - Nunca se integra "sobre base": si `integrationBranch === base`, se rechaza.
 *  - La rama a integrar SOLO puede ser `job/<id>` (W1); se pasa a git como
 *    `refs/heads/<rama>` para no confundirla con un tag homónimo.
 *  - Antes de cada merge se aborta un `MERGE_HEAD` residual y se rechaza con un
 *    error claro si el árbol tiene cambios sin commitear (W2).
 *  - Ante conflicto, `git merge --abort` y la rama de integración queda con el
 *    MISMO sha que antes (no se deja un merge a medias).
 *  - Nunca se hace push ni se escribe en la rama base.
 *
 * @param {object} opciones
 * @param {string} opciones.repoRaiz
 * @param {string} opciones.rama rama de trabajo a integrar (`job/<id>`)
 * @param {string} opciones.integrationBranch rama destino
 * @param {string} opciones.base rama base del repositorio
 * @param {string} opciones.rootDirIntegracion raíz del worktree de integración
 * @returns {Promise<{ ok: true, sha: string } | { ok: false, conflictos: string[] }>}
 * @throws {ErrorDeWorkspace}
 */
export async function integrar({ repoRaiz, rama, integrationBranch, base, rootDirIntegracion } = {}) {
  validarRamaTrabajo(rama, 'rama');
  validarRama(integrationBranch, 'integrationBranch');
  validarRama(base, 'base');

  if (integrationBranch === base) {
    throw new ErrorDeWorkspace(`Nunca se integra sobre la rama base ('${base}')`);
  }
  if (rama === base) {
    throw new ErrorDeWorkspace(`Nunca se integra la rama base ('${base}')`);
  }

  return conCerrojo(repoRaiz, async () => {
    const ruta = await prepararIntegracionSinCerrojo({ repoRaiz, integrationBranch, base, rootDirIntegracion });

    // W2: un intento anterior pudo morir a mitad dejando un MERGE_HEAD y/o un
    // árbol sucio. Abortamos el merge residual y, si aún quedan cambios sin
    // commitear, rechazamos sin tocar la rama de integración.
    await abortarMerge(ruta);
    const sucio = await arbolSucio(ruta);
    if (sucio.length > 0) {
      throw new ErrorDeWorkspace(
        `El worktree de integración está sucio (${sucio.length} cambio(s)); se rechaza el merge: ${sucio.slice(0, 5).join(', ')}`,
      );
    }

    const shaAntes = (await gitOLanza(['rev-parse', `refs/heads/${integrationBranch}`], { cwd: ruta })).trim();

    const merge = await git(
      ['merge', '--no-ff', '-m', `Integra ${rama} en ${integrationBranch}`, `refs/heads/${rama}`],
      { cwd: ruta },
    );

    if (merge.codigo !== 0) {
      // Recolectamos las rutas en conflicto ANTES de abortar (tras abortar ya no hay).
      const conflictos = await rutasEnConflicto(ruta);
      await abortarMerge(ruta);
      const shaDespues = (await gitOLanza(['rev-parse', `refs/heads/${integrationBranch}`], { cwd: ruta })).trim();
      if (shaDespues !== shaAntes) {
        throw new ErrorDeWorkspace(
          `La rama de integración cambió tras abortar (${shaAntes} -> ${shaDespues})`,
        );
      }
      return { ok: false, conflictos };
    }

    const sha = (await gitOLanza(['rev-parse', `refs/heads/${integrationBranch}`], { cwd: ruta })).trim();
    return { ok: true, sha };
  });
}

/**
 * Cambios sin commitear (incluye sin trackear) en un worktree, como lista de
 * registros `status --porcelain`. Se usa para rechazar un merge sobre un árbol
 * sucio (W2).
 *
 * @param {string} ruta worktree
 * @returns {Promise<string[]>}
 * @throws {ErrorDeWorkspace} si git no puede leer el estado
 */
async function arbolSucio(ruta) {
  const resultado = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: ruta });
  if (resultado.codigo !== 0) {
    throw new ErrorDeWorkspace(
      `No se pudo leer el estado del worktree de integración: ${resultado.stderr.trim()}`,
    );
  }
  return camposNul(resultado.stdout).filter((r) => r !== '');
}

/**
 * Rutas de archivos en conflicto en un merge en curso (vacío si no hay merge).
 * @param {string} ruta worktree
 * @returns {Promise<string[]>}
 */
async function rutasEnConflicto(ruta) {
  const resultado = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: ruta });
  if (resultado.codigo !== 0) return [];
  return camposNul(resultado.stdout).filter((r) => r !== '');
}

/**
 * Aborta un merge en curso si existe (`MERGE_HEAD`). Sin merge, no hace nada.
 * @param {string} ruta worktree
 * @returns {Promise<void>}
 */
async function abortarMerge(ruta) {
  const enMerge = await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: ruta });
  if (enMerge.codigo !== 0) return;
  await git(['merge', '--abort'], { cwd: ruta });
}

/**
 * Elimina un worktree y (por defecto) su rama. Idempotente: si ya no existe, no
 * falla. Por seguridad NUNCA elimina una ruta fuera de `rootDir` ni una ruta que
 * no sea un worktree registrado del repositorio.
 *
 * @param {object} opciones
 * @param {string} opciones.repoRaiz
 * @param {string} opciones.ruta ruta del worktree
 * @param {string} [opciones.rama] rama a borrar (SOLO `job/<id>`)
 * @param {boolean} [opciones.borrarRama=true]
 * @param {string} opciones.rootDir raíz conocida de worktrees (obligatoria)
 * @returns {Promise<{ eliminado: boolean, ramaBorrada: boolean }>}
 * @throws {ErrorDeWorkspace} si la ruta queda fuera de `rootDir`, si la rama no es
 *   `job/<id>` o si esa rama está en uso por otro worktree
 */
export async function eliminarWorktree({ repoRaiz, ruta, rama, borrarRama = true, rootDir } = {}) {
  if (typeof ruta !== 'string' || ruta.trim() === '') {
    throw new ErrorDeWorkspace('eliminarWorktree espera una ruta');
  }
  if (typeof rootDir !== 'string' || rootDir.trim() === '' || !path.isAbsolute(rootDir)) {
    throw new ErrorDeWorkspace('eliminarWorktree exige un rootDir absoluto para verificar la ruta');
  }
  if (!fs.existsSync(rootDir)) {
    throw new ErrorDeWorkspace(`rootDir no existe: ${rootDir}`);
  }

  const realRoot = fs.realpathSync(rootDir);
  const rutaResuelta = path.resolve(ruta);
  let rutaReal = rutaResuelta;
  try {
    rutaReal = fs.realpathSync(rutaResuelta);
  } catch {
    /* si ya no existe, la comparación es solo léxica */
  }
  if (!estaDentro(realRoot, rutaResuelta) || !estaDentro(realRoot, rutaReal)) {
    throw new ErrorDeWorkspace(`Se rechaza eliminar una ruta fuera de rootDir: ${ruta}`);
  }

  const worktrees = await listarWorktrees(repoRaiz);
  const registrado = worktrees.find((w) => path.resolve(w.ruta) === rutaResuelta || w.ruta === rutaResuelta);

  // W1: validar la rama ANTES de borrar nada (ni el worktree). Solo se admiten
  // ramas `job/<id>`; 'main', 'dev', 'staging' o refs arbitrarias se rechazan.
  let borrar = false;
  if (borrarRama && typeof rama === 'string' && rama.trim() !== '') {
    validarRamaTrabajo(rama, 'rama');
    const enOtro = worktrees.find(
      (w) => w.rama === rama && path.resolve(w.ruta) !== rutaResuelta && w.ruta !== rutaResuelta,
    );
    if (enOtro) {
      throw new ErrorDeWorkspace(
        `Se rechaza borrar la rama '${rama}': está en uso por otro worktree (${enOtro.ruta})`,
      );
    }
    borrar = true;
  }

  return conCerrojo(repoRaiz, async () => {
    let eliminado = false;
    if (registrado) {
      const quitar = await git(['worktree', 'remove', '--force', registrado.ruta], { cwd: repoRaiz });
      if (quitar.codigo !== 0) {
        throw new ErrorDeWorkspace(`No se pudo eliminar el worktree: ${quitar.stderr.trim()}`);
      }
      eliminado = true;
    }

    let ramaBorrada = false;
    if (borrar) {
      const resultado = await git(['branch', '-D', rama], { cwd: repoRaiz });
      ramaBorrada = resultado.codigo === 0;
    }

    await git(['worktree', 'prune'], { cwd: repoRaiz });
    return { eliminado, ramaBorrada };
  });
}

/**
 * Lista los worktrees registrados del repositorio, parseando el formato porcelain
 * (bloques separados por línea en blanco, campos `clave valor`).
 *
 * @param {string} repoRaiz
 * @returns {Promise<Array<{ ruta: string, sha: string|null, rama: string|null, detached: boolean, bare: boolean, locked: boolean }>>}
 * @throws {ErrorDeWorkspace}
 */
export async function listarWorktrees(repoRaiz) {
  const salida = await gitOLanza(['worktree', 'list', '--porcelain'], { cwd: repoRaiz });
  /** @type {Array<any>} */
  const worktrees = [];
  let actual = null;

  for (const linea of salida.split('\n')) {
    if (linea === '') {
      if (actual) {
        worktrees.push(actual);
        actual = null;
      }
      continue;
    }
    if (linea.startsWith('worktree ')) {
      actual = {
        ruta: linea.slice('worktree '.length),
        sha: null,
        rama: null,
        detached: false,
        bare: false,
        locked: false,
      };
    } else if (!actual) {
      continue;
    } else if (linea.startsWith('HEAD ')) {
      actual.sha = linea.slice('HEAD '.length);
    } else if (linea.startsWith('branch ')) {
      const ref = linea.slice('branch '.length);
      actual.rama = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (linea === 'detached') {
      actual.detached = true;
    } else if (linea === 'bare') {
      actual.bare = true;
    } else if (linea.startsWith('locked')) {
      actual.locked = true;
    }
  }
  if (actual) worktrees.push(actual);
  return worktrees;
}
