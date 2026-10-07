/**
 * Utilidades compartidas por los tests de integración del Gestor (§12.3).
 *
 * POR QUÉ un módulo aparte: los escenarios comparten el montaje de repos git
 * REALES en temporales, el opencode falso y la limpieza de procesos/directorios.
 * Duplicarlo en cada archivo de test sería propenso a divergencias y a dejar
 * basura. Este archivo solo define funciones y constantes: al ejecutarlo el
 * runner de tests no registra ninguna prueba (y no tiene efectos secundarios
 * peligrosos).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Gestor } from '../src/core/gestor.js';
import { AlmacenDeTrabajos } from '../src/core/store.js';
import { existeGrupo } from '../src/core/runner.js';

export { existeGrupo };

// POR QUÉ bajamos la prioridad de este proceso de test: los tests del Gestor
// lanzan muchos procesos (git y el opencode falso). Con varios archivos de test
// corriendo en paralelo, esa carga puede retrasar tests de temporización fina de
// otros módulos (p. ej. el de inactividad del runner). Ceder prioridad evita
// interferir con ellos sin tocarlos.
try {
  os.setPriority(0, 19);
} catch {
  /* no soportado en esta plataforma: se ignora */
}

// SEGURIDAD: los tests usan git real en repos temporales. Se anula la config
// global y la del sistema para no depender del entorno de quien ejecuta; la
// identidad se fija por repo con user.name/user.email locales.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

/** Ruta del ejecutable falso de opencode. */
export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode-falso.js');

/**
 * Copia del fixture en el sistema de archivos NATIVO del tmp.
 *
 * POR QUÉ: el repo vive en `/mnt/c` (9p, lento). Lanzar decenas de procesos que
 * lean el fixture desde ahí compite con otros tests de temporización fina que
 * también arrancan procesos desde `/mnt/c` (p. ej. el de inactividad del runner).
 * Ejecutarlo desde /tmp elimina esa contención sin tocar esos tests. La copia es
 * por proceso y se borra al salir.
 */
export const FIXTURE_TMP = path.join(os.tmpdir(), `orq-fake-${process.pid}.js`);
try {
  fs.copyFileSync(FIXTURE, FIXTURE_TMP);
} catch {
  /* si falla, se usa la ruta original */
}
process.on('exit', () => {
  try {
    fs.rmSync(FIXTURE_TMP, { force: true });
  } catch {
    /* best-effort */
  }
});

/** Intérprete de Node actual (se usa como `cmd` del opencode falso). */
export const NODE = process.execPath;

/** Nombre del archivo de perfil en la raíz del repo objetivo. */
export const ARCHIVO_PERFIL = '.opencode-orchestrator.json';

/**
 * Ejecuta git con ARGUMENTOS EN ARRAY (nunca por shell) y devuelve el resultado
 * crudo, sin lanzar.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * Igual que `git` pero lanza si el comando falla.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>} stdout
 */
export async function gitOK(args, cwd) {
  const resultado = await git(args, cwd);
  if (resultado.code !== 0) throw new Error(`git ${args.join(' ')} falló: ${resultado.stderr}`);
  return resultado.stdout;
}

/** Espera asíncrona en milisegundos. */
export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ¿El pid sigue existiendo? `EPERM` cuenta como vivo.
 * @param {number} pid
 * @returns {boolean}
 */
export function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * Espera hasta que `condicion()` sea cierta o se agote `topeMs`.
 * @param {() => boolean} condicion
 * @param {number} [topeMs]
 * @param {number} [pasoMs]
 * @returns {Promise<boolean>}
 */
export async function esperar(condicion, topeMs = 5000, pasoMs = 20) {
  const fin = Date.now() + topeMs;
  while (Date.now() < fin) {
    if (condicion()) return true;
    await dormir(pasoMs);
  }
  return condicion();
}

/**
 * Entorno para los trabajos: el del proceso de test SIN `NODE_TEST_CONTEXT`
 * (el fixture sale de inmediato si lo ve) y con las variables ORQ_FAKE_* dadas.
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function entornoFalso(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Lee y parsea el `events.jsonl` de un trabajo (vacío si no existe).
 * @param {string} estadoDir
 * @param {string} id
 * @returns {object[]}
 */
export function leerEventos(estadoDir, id) {
  const ruta = path.join(estadoDir, 'jobs', id, 'events.jsonl');
  try {
    return fs
      .readFileSync(ruta, 'utf8')
      .split('\n')
      .filter((linea) => linea.trim() !== '')
      .map((linea) => JSON.parse(linea));
  } catch {
    return [];
  }
}

/**
 * Lee y parsea el `job.json` persistido de un trabajo.
 * @param {string} estadoDir
 * @param {string} id
 * @returns {object}
 */
export function leerJob(estadoDir, id) {
  return JSON.parse(fs.readFileSync(path.join(estadoDir, 'jobs', id, 'job.json'), 'utf8'));
}

/**
 * Crea un Gestor con el opencode falso ya cableado.
 * @param {import('../src/core/store.js').AlmacenDeTrabajos} almacen
 * @param {object} opciones
 * @returns {Gestor}
 */
export function crearGestor(almacen, { entorno, concurrencia = 2, home, graceMs = 300, esperaMaximaMs = 60000, ejecutarPsql } = {}) {
  return new Gestor({
    almacen,
    opencode: { cmd: NODE, argsPrefijo: [FIXTURE_TMP] },
    concurrencia,
    entornoBase: entorno,
    home,
    graceMs,
    esperaMaximaMs,
    ejecutarPsql,
  });
}

/**
 * Espera a que un trabajo llegue a un estado, lanzando si no lo logra.
 * @param {Gestor} gestor
 * @param {string} id
 * @param {string} estado
 * @param {number} [topeMs]
 * @returns {Promise<void>}
 */
export async function esperarEstado(gestor, id, estado, topeMs = 15000) {
  const llego = await esperar(() => gestor.obtener(id).estado === estado, topeMs);
  if (!llego) throw new Error(`El trabajo ${id} no llegó a '${estado}' (está en '${gestor.obtener(id).estado}')`);
}

/**
 * Monta un repo git temporal con:
 *  - rama base `main` y un commit inicial,
 *  - un `.opencode-orchestrator.json` (commiteado) con worktrees.root absoluto
 *    dentro del tmp, baseBranch main, integrationBranch staging y protected
 *    `secretos/**`,
 *  - subdirectorios `subA`..`subD` para que varios trabajos puedan escribir
 *    rutas disjuntas usando `cwd` distintos,
 *  - un AlmacenDeTrabajos temporal.
 *
 * Registra en `t.after` la limpieza de procesos y del directorio.
 *
 * @param {import('node:test').TestContext} t contexto del test
 * @param {{ perfil?: object, perfilCrudo?: string|null }} [opciones]
 * @returns {Promise<{ base: string, repo: string, rootDir: string, estadoDir: string, home: string, baseCommit: string, almacen: import('../src/core/store.js').AlmacenDeTrabajos }>}
 */
export async function montar(t, { perfil = {}, perfilCrudo = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-gestor-'));
  const repo = path.join(base, 'repo');
  const rootDir = path.join(base, 'worktrees');
  const estadoDir = path.join(base, 'estado');
  const home = path.join(base, 'home');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  await gitOK(['init', '-q', '-b', 'main'], repo);
  await gitOK(['config', 'user.name', 'Prueba'], repo);
  await gitOK(['config', 'user.email', 'prueba@test'], repo);

  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'conflicto.txt'), 'original\n');
  for (const sub of ['subA', 'subB', 'subC', 'subD']) {
    fs.mkdirSync(path.join(repo, sub), { recursive: true });
    fs.writeFileSync(path.join(repo, sub, '.gitkeep'), `${sub}\n`);
  }

  const archivoPerfil = path.join(repo, ARCHIVO_PERFIL);
  if (perfilCrudo !== null) {
    fs.writeFileSync(archivoPerfil, perfilCrudo);
  } else {
    const completo = {
      version: 1,
      name: 'repo',
      baseBranch: 'main',
      integrationBranch: 'staging',
      protected: ['secretos/**'],
      worktrees: { root: rootDir },
      // `true` es un comando de aceptación que siempre pasa y no depende del cwd
      // (los trabajos con cwd en un subdirectorio no ven el perfil en su cwd).
      accept: { default: 'true' },
      ...perfil,
    };
    fs.writeFileSync(archivoPerfil, JSON.stringify(completo, null, 2));
  }

  await gitOK(['add', '-A'], repo);
  await gitOK(['commit', '-qm', 'base'], repo);
  const baseCommit = (await gitOK(['rev-parse', 'HEAD'], repo)).trim();

  const almacen = new AlmacenDeTrabajos({ dir: estadoDir });
  t.after(async () => {
    await limpiarBase(base, almacen);
  });
  return { base, repo, rootDir, estadoDir, home, baseCommit, almacen };
}

/**
 * Limpieza best-effort: mata los grupos de procesos registrados que sigan vivos
 * y borra el directorio temporal. POR QUÉ matar por pgid: si una aserción falla
 * a mitad de un test, el worktree y su opencode falso podrían quedar vivos.
 * @param {string} base
 * @param {import('../src/core/store.js').AlmacenDeTrabajos} [almacen]
 * @returns {Promise<void>}
 */
export async function limpiarBase(base, almacen) {
  try {
    const { trabajos } = almacen?.listar() ?? { trabajos: [] };
    for (const trabajo of trabajos) {
      if (Number.isInteger(trabajo.pgid) && trabajo.pgid > 0) {
        try {
          process.kill(-trabajo.pgid, 'SIGKILL');
        } catch {
          /* ya no existe */
        }
      }
    }
  } catch {
    /* la limpieza nunca debe enmascarar el resultado del test */
  }
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    /* best-effort */
  }
}
