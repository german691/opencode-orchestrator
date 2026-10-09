import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  raizGit,
  crearWorktree,
  cambiosDelWorktree,
  commitearTrabajo,
  integrar,
  sincronizarIntegracion,
  avanzarBase,
  eliminarWorktree,
  listarWorktrees,
  conCerrojo,
  refrescarCopiaPizarron,
} from '../src/core/workspace.js';
import { crearPizarron } from '../src/core/pizarron.js';

// SEGURIDAD: los tests usan git real en repos temporales bajo /tmp. Se anula la
// configuración global del usuario y la del sistema para no leer ~/.gitconfig ni
// /etc/gitconfig; la identidad se fija por repo con user.name/user.email locales.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

/**
 * Ejecuta git con ARGUMENTOS EN ARRAY (nunca por shell) y devuelve el resultado
 * crudo, sin lanzar.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * Igual que `git` pero lanza si falla.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function gitOK(args, cwd) {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} falló: ${r.stderr}`);
  return r.stdout;
}

/** Directorio temporal propio de cada prueba. */
function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-ws-'));
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** ¿El pid sigue existiendo? `EPERM` cuenta como vivo. */
function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/** Espera hasta que `condicion()` sea cierta o se agote `topeMs`. */
async function esperar(condicion, topeMs = 2000, pasoMs = 20) {
  const fin = Date.now() + topeMs;
  while (Date.now() < fin) {
    if (condicion()) return true;
    await dormir(pasoMs);
  }
  return condicion();
}

/** sha de una ref (por defecto HEAD). @param {string} cwd @param {string} [ref] */
async function sha(cwd, ref = 'HEAD') {
  return (await gitOK(['rev-parse', ref], cwd)).trim();
}

/**
 * Monta un repo temporal con contenido variado y devuelve sus rutas.
 * @returns {Promise<{ base: string, raiz: string, rootDir: string, rootDirIntegracion: string, baseCommit: string }>}
 */
async function montar() {
  const base = dirTemporal();
  const raiz = path.join(base, 'repo');
  const rootDir = path.join(base, 'worktrees');
  const rootDirIntegracion = path.join(base, 'integracion');
  fs.mkdirSync(raiz, { recursive: true });

  await gitOK(['init', '-q', '-b', 'main'], raiz);
  await gitOK(['config', 'user.name', 'Prueba'], raiz);
  await gitOK(['config', 'user.email', 'prueba@test'], raiz);
  fs.writeFileSync(path.join(raiz, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(raiz, 'renombrar.txt'), 'renombrar\n');
  fs.mkdirSync(path.join(raiz, 'docs'));
  fs.writeFileSync(path.join(raiz, 'docs', 'leeme.md'), 'hola\n');
  fs.writeFileSync(path.join(raiz, '.gitignore'), '*.log\n');
  await gitOK(['add', '-A'], raiz);
  await gitOK(['commit', '-qm', 'base'], raiz);
  const baseCommit = await sha(raiz);

  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(rootDirIntegracion, { recursive: true });
  return { base, raiz, rootDir, rootDirIntegracion, baseCommit };
}

test('raizGit devuelve la raíz y falla fuera de un repositorio', async () => {
  const { raiz } = await montar();
  assert.equal(await raizGit(path.join(raiz, 'docs')), fs.realpathSync(raiz));
  const fuera = dirTemporal();
  await assert.rejects(() => raizGit(fuera), /No es un repositorio git/);
});

test('crearWorktree crea rama job/<id>, ruta y baseCommit sin tocar la base', async () => {
  const { raiz, baseCommit, rootDir } = await montar();
  const antes = await sha(raiz);

  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'abc123', rootDir });

  assert.equal(res.rama, 'job/abc123');
  assert.equal(res.baseCommit, baseCommit);
  assert.equal(res.ruta, path.join(fs.realpathSync(rootDir), 'abc123'));
  assert.ok(fs.existsSync(res.ruta));
  assert.match(await gitOK(['branch', '--list', 'job/abc123'], raiz), /job\/abc123/);
  assert.equal(await sha(raiz), antes); // la base NUNCA cambia

  const worktrees = await listarWorktrees(raiz);
  assert.ok(worktrees.some((w) => w.rama === 'job/abc123' && w.ruta === res.ruta));
});

test('crearWorktree rechaza jobId inválidos sin crear nada', async () => {
  const { raiz, rootDir } = await montar();
  const invalidos = ['../x', 'ABC', '', 'a'.repeat(50), 'con/slash', 'con_guion_bajo'];
  for (const malo of invalidos) {
    await assert.rejects(
      () => crearWorktree({ repoRaiz: raiz, base: 'main', jobId: malo, rootDir }),
      /jobId inválido/,
      `debía rechazar ${JSON.stringify(malo)}`,
    );
  }
  assert.equal((await listarWorktrees(raiz)).length, 1); // solo el principal
  const contenido = fs.existsSync(rootDir) ? fs.readdirSync(rootDir) : [];
  assert.equal(contenido.length, 0);
});

test('crearWorktree con base inexistente no deja rama ni directorio', async () => {
  const { raiz, rootDir } = await montar();
  const antes = await sha(raiz);
  await assert.rejects(
    () => crearWorktree({ repoRaiz: raiz, base: 'no-existe', jobId: 'abc123', rootDir }),
    /no existe/,
  );
  assert.equal((await listarWorktrees(raiz)).length, 1);
  assert.equal((await gitOK(['branch', '--list'], raiz)).includes('abc123'), false);
  const contenido = fs.existsSync(rootDir) ? fs.readdirSync(rootDir) : [];
  assert.equal(contenido.length, 0);
  assert.equal(await sha(raiz), antes);
});

test('crearWorktree rechaza un destino que escapa por enlace simbólico', async () => {
  const { raiz, rootDir } = await montar();
  const fuera = dirTemporal();
  const enlace = path.join(rootDir, 'abc123');
  fs.symlinkSync(fuera, enlace, 'dir');

  await assert.rejects(
    () => crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'abc123', rootDir }),
    /escapa de rootDir/,
  );
  assert.equal((await listarWorktrees(raiz)).length, 1);
  assert.equal((await gitOK(['branch', '--list'], raiz)).includes('abc123'), false);
});

test('crearWorktree maneja link: válido, origen ausente, ya versionado y con ..', async () => {
  const { raiz, rootDir } = await montar();
  const origen = path.join(raiz, 'node_modules');
  fs.mkdirSync(origen);
  fs.writeFileSync(path.join(origen, 'x.js'), 'x');

  const res = await crearWorktree({
    repoRaiz: raiz,
    base: 'main',
    jobId: 'enl1',
    rootDir,
    link: ['node_modules', 'no-existe', 'docs/leeme.md'],
  });

  assert.ok(fs.lstatSync(path.join(res.ruta, 'node_modules')).isSymbolicLink());
  assert.deepEqual([...res.enlacesOmitidos].sort(), ['docs/leeme.md', 'no-existe']);

  await assert.rejects(
    () =>
      crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'enl2', rootDir, link: ['../fuera'] }),
    /no puede contener/,
  );
  // Tras el rechazo, el worktree a medio crear se limpió.
  assert.equal(fs.existsSync(path.join(rootDir, 'enl2')), false);
  assert.equal((await gitOK(['branch', '--list'], raiz)).includes('enl2'), false);
});

test('crearWorktree con setup que falla limpia worktree y rama', async () => {
  const { raiz, rootDir } = await montar();
  await assert.rejects(
    () => crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'falla1', rootDir, setup: ['exit 3'] }),
    /setup falló/,
  );
  assert.equal((await listarWorktrees(raiz)).length, 1);
  assert.equal((await gitOK(['branch', '--list'], raiz)).includes('falla1'), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'falla1')), false);
});

test('crearWorktree corre setup con env dentro del worktree', async () => {
  const { raiz, rootDir } = await montar();
  const res = await crearWorktree({
    repoRaiz: raiz,
    base: 'main',
    jobId: 'setup1',
    rootDir,
    env: { MI_VAR: 'hola' },
    setup: ['printf %s "$MI_VAR" > creado.txt'],
  });
  assert.equal(fs.readFileSync(path.join(res.ruta, 'creado.txt'), 'utf8'), 'hola');
});

test('cambiosDelWorktree lista nuevos, modificados, borrados, renombrados y raros', async () => {
  const { raiz, baseCommit, rootDir } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'cam1', rootDir });

  const origen = path.join(raiz, 'node_modules');
  fs.mkdirSync(origen);
  fs.writeFileSync(path.join(origen, 'x.js'), 'x');
  const resLink = await crearWorktree({
    repoRaiz: raiz,
    base: 'main',
    jobId: 'cam2',
    rootDir,
    link: ['node_modules'],
  });
  assert.deepEqual(resLink.enlacesCreados, ['node_modules']);

  const wt = resLink.ruta;
  fs.writeFileSync(path.join(wt, 'nuevo.txt'), 'n\n');
  fs.writeFileSync(path.join(wt, 'con espacio.txt'), 'e\n');
  fs.writeFileSync(path.join(wt, 'tilde-ñ.txt'), 't\n');
  fs.writeFileSync(path.join(wt, 'salto\nlinea.txt'), 's\n');
  fs.writeFileSync(path.join(wt, 'algo.log'), 'ignorado\n'); // .gitignore
  fs.writeFileSync(path.join(wt, 'base.txt'), 'modificado\n');
  fs.rmSync(path.join(wt, 'docs', 'leeme.md'));
  fs.renameSync(path.join(wt, 'renombrar.txt'), path.join(wt, 'renombrado con espacio.txt'));

  const { archivos, resumen } = await cambiosDelWorktree({
    ruta: wt,
    baseCommit,
    ignorar: resLink.enlacesCreados,
  });

  for (const esperado of [
    'nuevo.txt',
    'con espacio.txt',
    'tilde-ñ.txt',
    'salto\nlinea.txt',
    'base.txt',
    'docs/leeme.md',
    'renombrar.txt', // origen del renombrado
    'renombrado con espacio.txt', // destino del renombrado
  ]) {
    assert.ok(archivos.includes(esperado), `faltaba ${JSON.stringify(esperado)} en ${JSON.stringify(archivos)}`);
  }
  assert.equal(archivos.includes('algo.log'), false, 'un ignorado no debe listarse');
  assert.equal(archivos.includes('node_modules'), false, 'un enlace de link no debe listarse');
  assert.deepEqual(archivos, [...archivos].sort(), 'la lista debe venir ordenada');
  assert.deepEqual([...new Set(archivos)], archivos, 'sin repetidos');
  // Sin preparar, git no empareja el renombrado: lo ve como un borrado más un
  // sin-trackear (ambas rutas se informan igualmente). El renombrado PREPARADO,
  // que sí trae el estado 'R', se verifica en su propia prueba.
  assert.deepEqual(resumen, { agregados: 5, modificados: 1, borrados: 2 });
  // El primer worktree no se tocó.
  assert.equal((await cambiosDelWorktree({ ruta: res.ruta, baseCommit })).archivos.length, 0);
});

test('cambiosDelWorktree informa AMBAS rutas de un renombrado preparado', async () => {
  const { raiz, baseCommit, rootDir } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'ren1', rootDir });

  await gitOK(['mv', 'renombrar.txt', 'renombrado con espacio.txt'], res.ruta);

  const { archivos, resumen } = await cambiosDelWorktree({ ruta: res.ruta, baseCommit });
  assert.ok(archivos.includes('renombrar.txt'), `faltaba el origen: ${JSON.stringify(archivos)}`);
  assert.ok(archivos.includes('renombrado con espacio.txt'), `faltaba el destino: ${JSON.stringify(archivos)}`);
  assert.deepEqual(resumen, { agregados: 0, modificados: 1, borrados: 0 });
});

test('commitearTrabajo commitea con autor, corre hooks y devuelve null sin cambios', async () => {
  const { raiz, rootDir } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'com1', rootDir });

  const marca = path.join(raiz, 'hook-corrio');
  const hook = path.join(raiz, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marca}"\n`);
  fs.chmodSync(hook, 0o755);

  assert.equal(await commitearTrabajo({ ruta: res.ruta, mensaje: 'nada' }), null);

  fs.writeFileSync(path.join(res.ruta, 'trabajo.txt'), 'hecho\n');
  const commit = await commitearTrabajo({ ruta: res.ruta, mensaje: 'trabajo', autor: 'Autor <a@b>' });
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(marca), 'el hook pre-commit debe haber corrido (no se usa --no-verify)');
  assert.equal((await gitOK(['log', '-1', '--format=%an <%ae>'], res.ruta)).trim(), 'Autor <a@b>');
  assert.equal(await commitearTrabajo({ ruta: res.ruta, mensaje: 'otra vez' }), null);
});

test('integrar fusiona sin conflicto, en secuencia, y nunca toca la base', async () => {
  const { raiz, rootDir, rootDirIntegracion } = await montar();
  const baseAntes = await sha(raiz);

  const w1 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 't1', rootDir });
  fs.writeFileSync(path.join(w1.ruta, 'a.txt'), 'uno\n');
  fs.writeFileSync(path.join(w1.ruta, 'base.txt'), 'cambio1\n');
  await commitearTrabajo({ ruta: w1.ruta, mensaje: 't1', autor: 'T <t@t>' });

  const w2 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 't2', rootDir });
  fs.writeFileSync(path.join(w2.ruta, 'b.txt'), 'dos\n');
  await commitearTrabajo({ ruta: w2.ruta, mensaje: 't2', autor: 'T <t@t>' });

  const r1 = await integrar({ repoRaiz: raiz, rama: 'job/t1', integrationBranch: 'staging', base: 'main', rootDirIntegracion });
  assert.equal(r1.ok, true);
  assert.match(r1.sha, /^[0-9a-f]{40}$/);

  const r2 = await integrar({ repoRaiz: raiz, rama: 'job/t2', integrationBranch: 'staging', base: 'main', rootDirIntegracion });
  assert.equal(r2.ok, true);

  const integ = path.join(rootDirIntegracion, 'staging');
  assert.equal(fs.readFileSync(path.join(integ, 'a.txt'), 'utf8'), 'uno\n');
  assert.equal(fs.readFileSync(path.join(integ, 'b.txt'), 'utf8'), 'dos\n');
  assert.equal(fs.readFileSync(path.join(integ, 'base.txt'), 'utf8'), 'cambio1\n');

  assert.equal(await sha(raiz), baseAntes); // base intacta
  assert.equal((await gitOK(['show', 'main:base.txt'], raiz)).trim(), 'base');
});

test('integrar con conflicto aborta y deja la rama de integración intacta', async () => {
  const { raiz, rootDir, rootDirIntegracion } = await montar();
  const baseAntes = await sha(raiz);

  const w1 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'c1', rootDir });
  fs.writeFileSync(path.join(w1.ruta, 'base.txt'), 'uno\n');
  await commitearTrabajo({ ruta: w1.ruta, mensaje: 'c1', autor: 'T <t@t>' });

  const w2 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'c2', rootDir });
  fs.writeFileSync(path.join(w2.ruta, 'base.txt'), 'dos\n');
  await commitearTrabajo({ ruta: w2.ruta, mensaje: 'c2', autor: 'T <t@t>' });

  assert.equal(
    (await integrar({ repoRaiz: raiz, rama: 'job/c1', integrationBranch: 'staging', base: 'main', rootDirIntegracion })).ok,
    true,
  );
  const shaIntegracion = await sha(raiz, 'staging');

  const res = await integrar({ repoRaiz: raiz, rama: 'job/c2', integrationBranch: 'staging', base: 'main', rootDirIntegracion });
  assert.equal(res.ok, false);
  assert.ok(res.conflictos.includes('base.txt'), `conflictos: ${JSON.stringify(res.conflictos)}`);

  assert.equal(await sha(raiz, 'staging'), shaIntegracion); // mismo sha que antes
  assert.equal(await sha(raiz), baseAntes); // base intacta
  assert.equal(fs.readFileSync(path.join(rootDirIntegracion, 'staging', 'base.txt'), 'utf8'), 'uno\n');

  const integ = (await listarWorktrees(raiz)).find((w) => w.rama === 'staging');
  const mergeHead = await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], integ.ruta);
  assert.notEqual(mergeHead.code, 0); // no queda un merge a medias
});

test('integrar rechaza la rama base y la deja intacta', async () => {
  const { raiz, rootDirIntegracion } = await montar();
  const antes = await sha(raiz);
  await assert.rejects(
    () => integrar({ repoRaiz: raiz, rama: 'job/x', integrationBranch: 'main', base: 'main', rootDirIntegracion }),
    /rama base/,
  );
  // W1: `main` como rama a integrar ya no es un nombre de rama de trabajo válido.
  await assert.rejects(
    () => integrar({ repoRaiz: raiz, rama: 'main', integrationBranch: 'staging', base: 'main', rootDirIntegracion }),
    /rama inválida/,
  );
  assert.equal(await sha(raiz), antes);
});

test('eliminarWorktree elimina, es idempotente y rechaza rutas fuera de rootDir', async () => {
  const { raiz, rootDir } = await montar();
  const w = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'e1', rootDir });

  const r1 = await eliminarWorktree({ repoRaiz: raiz, ruta: w.ruta, rama: w.rama, rootDir });
  assert.equal(r1.eliminado, true);
  assert.equal(fs.existsSync(w.ruta), false);
  assert.equal((await gitOK(['branch', '--list'], raiz)).includes('job/e1'), false);

  const r2 = await eliminarWorktree({ repoRaiz: raiz, ruta: w.ruta, rama: w.rama, rootDir });
  assert.equal(r2.eliminado, false); // idempotente

  const fuera = dirTemporal();
  await assert.rejects(
    () => eliminarWorktree({ repoRaiz: raiz, ruta: fuera, rama: 'job/e1', rootDir }),
    /fuera de rootDir/,
  );

  // Dentro de rootDir pero NO registrado como worktree: no se borra.
  const noRegistrado = path.join(rootDir, 'no-registrado');
  fs.mkdirSync(noRegistrado);
  fs.writeFileSync(path.join(noRegistrado, 'x.txt'), 'x');
  const r3 = await eliminarWorktree({ repoRaiz: raiz, ruta: noRegistrado, rootDir });
  assert.equal(r3.eliminado, false);
  assert.ok(fs.existsSync(noRegistrado));
});

test('listarWorktrees parsea rama, sha y ruta', async () => {
  const { raiz, rootDir, baseCommit } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'lst1', rootDir });

  const worktrees = await listarWorktrees(raiz);
  const principal = worktrees.find((w) => w.rama === 'main');
  assert.ok(principal);
  assert.equal(principal.sha, baseCommit);
  const creado = worktrees.find((w) => w.rama === 'job/lst1');
  assert.ok(creado);
  assert.equal(creado.ruta, res.ruta);
  assert.equal(creado.detached, false);
});

// --- W1: borrar/integrar solo ramas job/<id> ---------------------------------

test('eliminarWorktree solo borra ramas job/<id> y rechaza main/dev/arbitrarias sin tocar nada', async () => {
  const { raiz, rootDir } = await montar();
  const w = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'w1a', rootDir });
  await gitOK(['branch', 'dev', 'main'], raiz);

  for (const mala of ['main', 'dev', 'staging', 'job/', 'job/BAD', 'refs/heads/job/x', 'job/a b', 'job/../x']) {
    await assert.rejects(
      () => eliminarWorktree({ repoRaiz: raiz, ruta: w.ruta, rama: mala, rootDir }),
      /rama inválida/,
      `debía rechazar ${JSON.stringify(mala)}`,
    );
  }
  // Nada se borró: ni el worktree ni las ramas.
  assert.ok(fs.existsSync(w.ruta));
  assert.ok((await gitOK(['branch', '--list', 'job/w1a'], raiz)).includes('job/w1a'));
  assert.ok((await gitOK(['branch', '--list', 'dev'], raiz)).includes('dev'));
  assert.ok((await gitOK(['branch', '--list', 'main'], raiz)).includes('main'));

  // Una rama en uso por OTRO worktree distinto tampoco se borra.
  const w2 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'w2b', rootDir });
  await assert.rejects(
    () => eliminarWorktree({ repoRaiz: raiz, ruta: w.ruta, rama: w2.rama, rootDir }),
    /otro worktree/,
  );
  assert.ok(fs.existsSync(w.ruta));
  assert.ok((await gitOK(['branch', '--list', 'job/w2b'], raiz)).includes('job/w2b'));
});

test('integrar rechaza ramas que no son job/<id> y no toca la base', async () => {
  const { raiz, rootDirIntegracion } = await montar();
  await gitOK(['branch', 'dev', 'main'], raiz);
  const antes = await sha(raiz);

  for (const mala of ['main', 'dev', 'staging', 'refs/heads/main', 'job/', 'job/BAD']) {
    await assert.rejects(
      () =>
        integrar({ repoRaiz: raiz, rama: mala, integrationBranch: 'staging', base: 'main', rootDirIntegracion }),
      /rama inválida/,
      `debía rechazar ${JSON.stringify(mala)}`,
    );
  }
  assert.equal(await sha(raiz), antes);
  assert.equal((await listarWorktrees(raiz)).some((x) => x.rama === 'staging'), false);
});

// --- W2: merge residual y árbol sucio ---------------------------------------

test('integrar aborta un merge residual y rechaza un árbol sucio sin tocar la rama', async () => {
  const { raiz, rootDir, rootDirIntegracion } = await montar();

  const w1 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'm1', rootDir });
  fs.writeFileSync(path.join(w1.ruta, 'base.txt'), 'uno\n');
  await commitearTrabajo({ ruta: w1.ruta, mensaje: 'm1', autor: 'T <t@t>' });

  const w2 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'm2', rootDir });
  fs.writeFileSync(path.join(w2.ruta, 'base.txt'), 'dos\n');
  await commitearTrabajo({ ruta: w2.ruta, mensaje: 'm2', autor: 'T <t@t>' });

  const w3 = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'm3', rootDir });
  fs.writeFileSync(path.join(w3.ruta, 'extra.txt'), 'extra\n');
  await commitearTrabajo({ ruta: w3.ruta, mensaje: 'm3', autor: 'T <t@t>' });

  assert.equal(
    (await integrar({ repoRaiz: raiz, rama: 'job/m1', integrationBranch: 'staging', base: 'main', rootDirIntegracion })).ok,
    true,
  );
  const integ = path.join(rootDirIntegracion, 'staging');

  // Dejamos a mano un merge a medias (conflicto) en el worktree de integración.
  const mergeManual = await git(['merge', '--no-ff', '-m', 'manual', 'refs/heads/job/m2'], integ);
  assert.notEqual(mergeManual.code, 0);
  assert.equal((await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], integ)).code, 0);

  // integrar debe abortar el residual y completar el merge de m3 (sin conflicto).
  const r3 = await integrar({ repoRaiz: raiz, rama: 'job/m3', integrationBranch: 'staging', base: 'main', rootDirIntegracion });
  assert.equal(r3.ok, true);
  assert.equal(fs.readFileSync(path.join(integ, 'extra.txt'), 'utf8'), 'extra\n');
  assert.notEqual((await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], integ)).code, 0);

  // Un archivo sucio (sin commitear) rechaza el merge y no se toca.
  fs.writeFileSync(path.join(integ, 'sucio.txt'), 'x\n');
  await assert.rejects(
    () => integrar({ repoRaiz: raiz, rama: 'job/m3', integrationBranch: 'staging', base: 'main', rootDirIntegracion }),
    /sucio/,
  );
  assert.ok(fs.existsSync(path.join(integ, 'sucio.txt')));
});

// --- W3: nada de info/exclude compartido -------------------------------------

test('crearWorktree no escribe en info/exclude y el enlace no aparece en cambios ni en el commit', async () => {
  const { raiz, baseCommit, rootDir } = await montar();
  const exclude = path.join(raiz, '.git', 'info', 'exclude');
  const antes = fs.readFileSync(exclude, 'utf8');

  const origen = path.join(raiz, 'node_modules');
  fs.mkdirSync(origen);
  fs.writeFileSync(path.join(origen, 'x.js'), 'x');

  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'enx1', rootDir, link: ['node_modules'] });
  assert.deepEqual(res.enlacesCreados, ['node_modules']);
  assert.equal(fs.readFileSync(exclude, 'utf8'), antes, 'el info/exclude del repo principal no debe cambiar');

  fs.writeFileSync(path.join(res.ruta, 'real.txt'), 'r\n');
  const { archivos } = await cambiosDelWorktree({ ruta: res.ruta, baseCommit, ignorar: res.enlacesCreados });
  assert.ok(archivos.includes('real.txt'));
  assert.equal(archivos.includes('node_modules'), false, 'el enlace no debe listarse como cambio');

  const commit = await commitearTrabajo({
    ruta: res.ruta,
    mensaje: 'trabajo',
    autor: 'T <t@t>',
    excluir: res.enlacesCreados,
  });
  assert.match(commit, /^[0-9a-f]{40}$/);
  const arbol = await gitOK(['ls-tree', '-r', '--name-only', 'HEAD'], res.ruta);
  assert.ok(arbol.includes('real.txt'));
  assert.equal(arbol.includes('node_modules'), false, 'el enlace no debe entrar al commit');
  assert.equal(fs.readFileSync(exclude, 'utf8'), antes, 'sigue sin tocarse tras el commit');
});

test('crearWorktree crea .orq vacío, lo excluye en SU gitdir y es invisible para cambios/commit', async () => {
  const { raiz, baseCommit, rootDir } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'orq1', rootDir });

  // El directorio reservado existe y está vacío.
  assert.equal(fs.statSync(path.join(res.ruta, '.orq')).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.join(res.ruta, '.orq')), []);

  // El exclude se escribe en el gitdir del WORKTREE, nunca en el info/exclude compartido.
  const gitdir = (await gitOK(['rev-parse', '--git-dir'], res.ruta)).trim();
  const excludeWorktree = path.resolve(res.ruta, gitdir, 'info', 'exclude');
  assert.match(fs.readFileSync(excludeWorktree, 'utf8'), /^\.orq\/$/m);
  const excludeMain = path.join(raiz, '.git', 'info', 'exclude');
  assert.doesNotMatch(fs.readFileSync(excludeMain, 'utf8'), /\.orq/);

  // Un archivo en `.orq` no cuenta como cambio ni entra al commit.
  fs.writeFileSync(path.join(res.ruta, '.orq', 'mutaciones.json'), '{}');
  fs.writeFileSync(path.join(res.ruta, 'real.txt'), 'r\n');
  const { archivos } = await cambiosDelWorktree({ ruta: res.ruta, baseCommit });
  assert.deepEqual(archivos, ['real.txt']);
  const commit = await commitearTrabajo({ ruta: res.ruta, mensaje: 't', autor: 'T <t@t>', soloArchivos: archivos });
  assert.match(commit, /^[0-9a-f]{40}$/);
  const arbol = await gitOK(['ls-tree', '-r', '--name-only', 'HEAD'], res.ruta);
  assert.equal(arbol.includes('.orq'), false);
});

// --- W4: setup con tope de tiempo y cancelable -------------------------------

test('crearWorktree: un setup que cuelga expira, limpia worktree/rama y no deja procesos', async () => {
  const { raiz, rootDir } = await montar();
  const inicio = Date.now();
  await assert.rejects(
    () =>
      crearWorktree({
        repoRaiz: raiz,
        base: 'main',
        jobId: 'hang1',
        rootDir,
        setup: ['sleep 5'],
        setupTimeoutMs: 300,
      }),
    /setup excedió el tiempo límite/,
  );
  const transcurrido = Date.now() - inicio;
  assert.ok(transcurrido < 10000, `no debe colgarse (${transcurrido} ms)`);
  assert.equal((await listarWorktrees(raiz)).length, 1);
  assert.equal((await gitOK(['branch', '--list'], raiz)).includes('hang1'), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'hang1')), false);
});

test('crearWorktree: el setup se cancela por AbortSignal y limpia worktree/rama', async () => {
  const { raiz, rootDir } = await montar();
  const controlador = new AbortController();
  setTimeout(() => controlador.abort(), 200);
  await assert.rejects(
    () =>
      crearWorktree({
        repoRaiz: raiz,
        base: 'main',
        jobId: 'cancel1',
        rootDir,
        setup: ['sleep 5'],
        signal: controlador.signal,
        setupTimeoutMs: 10000,
      }),
    /setup fue cancelado/,
  );
  assert.equal((await listarWorktrees(raiz)).length, 1);
  assert.equal(fs.existsSync(path.join(rootDir, 'cancel1')), false);
});

test('crearWorktree: un nieto del setup que sobrevive se mata con el grupo', async () => {
  const { raiz, rootDir } = await montar();
  const res = await crearWorktree({
    repoRaiz: raiz,
    base: 'main',
    jobId: 'niet1',
    rootDir,
    setup: ['sleep 60 & echo $! > nieto.pid'],
    setupTimeoutMs: 5000,
  });
  const pidNieto = Number(fs.readFileSync(path.join(res.ruta, 'nieto.pid'), 'utf8').trim());
  assert.ok(Number.isInteger(pidNieto) && pidNieto > 0);
  assert.ok(await esperar(() => !pidVivo(pidNieto)), 'el nieto del setup debía morir con el grupo');
});

// --- W5: exclusión mutua por repositorio -------------------------------------

test('6 crearWorktree en paralelo sobre el mismo repo terminan bien y crean sus ramas', async () => {
  const { raiz, rootDir } = await montar();
  const ids = ['par1', 'par2', 'par3', 'par4', 'par5', 'par6'];

  const resultados = await Promise.all(
    ids.map((id) => crearWorktree({ repoRaiz: raiz, base: 'main', jobId: id, rootDir })),
  );

  for (let i = 0; i < ids.length; i += 1) {
    assert.equal(resultados[i].rama, `job/${ids[i]}`);
    assert.ok(fs.existsSync(resultados[i].ruta));
  }
  const ramas = await gitOK(['branch', '--list'], raiz);
  for (const id of ids) assert.ok(ramas.includes(`job/${id}`), `falta la rama job/${id}`);
});

test('4 eliminar+crear intercalados sobre el mismo repo no chocan', async () => {
  const { raiz, rootDir } = await montar();
  const creados = [];
  for (const id of ['int1', 'int2', 'int3', 'int4']) {
    creados.push(await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: id, rootDir }));
  }

  const tareas = [];
  for (let i = 0; i < creados.length; i += 1) {
    if (i % 2 === 0) {
      tareas.push(eliminarWorktree({ repoRaiz: raiz, ruta: creados[i].ruta, rama: creados[i].rama, rootDir }));
    } else {
      tareas.push(crearWorktree({ repoRaiz: raiz, base: 'main', jobId: `nue${i}`, rootDir }));
    }
  }
  await Promise.all(tareas);

  assert.equal(fs.existsSync(creados[0].ruta), false);
  assert.equal(fs.existsSync(creados[2].ruta), false);
  assert.ok(fs.existsSync(path.join(rootDir, 'nue1')));
  assert.ok(fs.existsSync(path.join(rootDir, 'nue3')));
});

test('conCerrojo serializa por repo, libera tras un error y no cruza repos distintos', async () => {
  const { raiz } = await montar();

  let enCurso = 0;
  let maxEnCurso = 0;
  const tarea = (ms) =>
    conCerrojo(raiz, async () => {
      enCurso += 1;
      maxEnCurso = Math.max(maxEnCurso, enCurso);
      await dormir(ms);
      enCurso -= 1;
    });

  await Promise.all([tarea(40), tarea(40), tarea(40)]);
  assert.equal(maxEnCurso, 1, 'nunca debe haber dos operaciones a la vez en el mismo repo');

  // Un error no bloquea a los que vienen detrás.
  await assert.rejects(
    () =>
      conCerrojo(raiz, async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  let corrio = false;
  await conCerrojo(raiz, async () => {
    corrio = true;
  });
  assert.equal(corrio, true);

  // Un repo distinto (otra clave) no espera al cerrojo del primero.
  const otra = path.join(dirTemporal(), 'otro');
  fs.mkdirSync(otra, { recursive: true });
  let lentoTermino = false;
  const lento = conCerrojo(raiz, async () => {
    await dormir(150);
    lentoTermino = true;
  });
  await dormir(20);
  let otraCorrio = false;
  await conCerrojo(otra, async () => {
    otraCorrio = true;
  });
  assert.equal(otraCorrio, true);
  assert.equal(lentoTermino, false, 'otro repo no debe esperar al cerrojo de raiz');
  await lento;
});

test('commitearTrabajo con soloArchivos commitea ÚNICAMENTE esas rutas (lo que genera un comando posterior no entra)', async () => {
  const { raiz, rootDir } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'solo1', rootDir });

  // Dos archivos "del trabajo" (uno nuevo, uno borrado) y un artefacto posterior.
  fs.writeFileSync(path.join(res.ruta, 'verificado con [corchetes].txt'), 'v\n');
  fs.rmSync(path.join(res.ruta, 'base.txt'));
  fs.writeFileSync(path.join(res.ruta, 'artefacto.log'), 'generado por la aceptación\n');

  const sha = await commitearTrabajo({
    ruta: res.ruta,
    mensaje: 'solo lo verificado',
    soloArchivos: ['verificado con [corchetes].txt', 'base.txt'],
  });
  assert.ok(sha, 'debe commitear');

  const arbol = (await gitOK(['ls-tree', '-r', '--name-only', sha], res.ruta)).trim().split('\n');
  assert.ok(arbol.includes('verificado con [corchetes].txt'), 'el verificado entra (nombre con corchetes, literal)');
  assert.equal(arbol.includes('base.txt'), false, 'el borrado verificado queda borrado en el commit');
  assert.equal(arbol.includes('artefacto.log'), false, 'el artefacto posterior NO entra');
  // El artefacto sigue en el árbol de trabajo, sin commitear.
  assert.equal(fs.existsSync(path.join(res.ruta, 'artefacto.log')), true);
});

test('commitearTrabajo con soloArchivos vacío no agrega nada y nunca cae a "."', async () => {
  const { raiz, rootDir } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'solo2', rootDir });
  fs.writeFileSync(path.join(res.ruta, 'suelto.txt'), 's\n');
  assert.equal(await commitearTrabajo({ ruta: res.ruta, mensaje: 'nada', soloArchivos: [] }), null);
  await assert.rejects(
    commitearTrabajo({ ruta: res.ruta, mensaje: 'x', soloArchivos: ['../fuera.txt'] }),
    /soloArchivos|\.\./,
  );
});

test('cambiosDelWorktree lista los ARCHIVOS de un directorio nuevo, no el directorio colapsado', async () => {
  const { raiz, baseCommit, rootDir } = await montar();
  const res = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'dirnuevo', rootDir });

  // git status colapsa por defecto un directorio sin trackear a 'src/': el patrón
  // 'src/**' no coincide con 'src/' y un trabajo legítimo se rechazaba por alcance.
  fs.mkdirSync(path.join(res.ruta, 'src', 'profundo'), { recursive: true });
  fs.writeFileSync(path.join(res.ruta, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(res.ruta, 'src', 'profundo', 'b.js'), 'b\n');

  const { archivos, resumen } = await cambiosDelWorktree({ ruta: res.ruta, baseCommit });
  assert.deepEqual(archivos, ['src/a.js', 'src/profundo/b.js']);
  assert.deepEqual(resumen, { agregados: 2, modificados: 0, borrados: 0 });
});

test('integrar sincroniza antes lo commiteado en la base: la integración la incluye y la base se puede avanzar', async () => {
  const { raiz, rootDir, rootDirIntegracion } = await montar();
  const w = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'sy1', rootDir });
  fs.writeFileSync(path.join(w.ruta, 'trabajo.txt'), 'x\n');
  await commitearTrabajo({ ruta: w.ruta, mensaje: 'trabajo', autor: 'T <t@t>' });

  // El usuario commitea directo en la base DESPUÉS de lanzar el trabajo.
  fs.writeFileSync(path.join(raiz, 'doc-usuario.txt'), 'docs\n');
  await gitOK(['add', 'doc-usuario.txt'], raiz);
  await gitOK(['commit', '-m', 'docs del usuario'], raiz);

  const r = await integrar({ repoRaiz: raiz, rama: 'job/sy1', integrationBranch: 'staging', base: 'main', rootDirIntegracion });
  assert.equal(r.ok, true);
  const integ = path.join(rootDirIntegracion, 'staging');
  assert.equal(fs.readFileSync(path.join(integ, 'doc-usuario.txt'), 'utf8'), 'docs\n', 'la integración incluye la base');
  assert.equal((await git(['merge-base', '--is-ancestor', 'main', 'staging'], raiz)).code, 0);

  const av = await avanzarBase({ repoRaiz: raiz, base: 'main', integrationBranch: 'staging' });
  assert.equal(av.ok, true);
  assert.equal(av.sha, await sha(raiz, 'staging'));
  assert.equal(fs.readFileSync(path.join(raiz, 'trabajo.txt'), 'utf8'), 'x\n', 'el árbol real recibió el trabajo');
});

test('sincronizarIntegracion es idempotente y reporta conflictos sin dejar un merge a medias', async () => {
  const { raiz, rootDir, rootDirIntegracion } = await montar();
  const w = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'sy2', rootDir });
  fs.writeFileSync(path.join(w.ruta, 'base.txt'), 'version del trabajo\n');
  await commitearTrabajo({ ruta: w.ruta, mensaje: 'toca base.txt', autor: 'T <t@t>' });
  assert.equal((await integrar({ repoRaiz: raiz, rama: 'job/sy2', integrationBranch: 'staging', base: 'main', rootDirIntegracion })).ok, true);

  const sinCambios = await sincronizarIntegracion({ repoRaiz: raiz, integrationBranch: 'staging', base: 'main', rootDirIntegracion });
  assert.deepEqual({ ok: sinCambios.ok, cambio: sinCambios.cambio }, { ok: true, cambio: false });

  // La base cambia el MISMO archivo de otra forma: conflicto al sincronizar.
  fs.writeFileSync(path.join(raiz, 'base.txt'), 'version del usuario\n');
  await gitOK(['commit', '-am', 'usuario toca base.txt'], raiz);
  const antes = await sha(raiz, 'staging');
  const conf = await sincronizarIntegracion({ repoRaiz: raiz, integrationBranch: 'staging', base: 'main', rootDirIntegracion });
  assert.equal(conf.ok, false);
  assert.deepEqual(conf.conflictos, ['base.txt']);
  assert.equal(await sha(raiz, 'staging'), antes, 'la integración quedó intacta');
  assert.equal((await git(['status', '--porcelain'], path.join(rootDirIntegracion, 'staging'))).stdout.trim(), '', 'sin merge a medias');
});

test('avanzarBase se niega si el árbol real tiene cambios sin commitear o no es fast-forward', async () => {
  const { raiz, rootDir, rootDirIntegracion } = await montar();
  const w = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'sy3', rootDir });
  fs.writeFileSync(path.join(w.ruta, 'n.txt'), 'n\n');
  await commitearTrabajo({ ruta: w.ruta, mensaje: 'n', autor: 'T <t@t>' });
  await integrar({ repoRaiz: raiz, rama: 'job/sy3', integrationBranch: 'staging', base: 'main', rootDirIntegracion });

  fs.appendFileSync(path.join(raiz, 'base.txt'), 'sin commitear\n');
  const sucio = await avanzarBase({ repoRaiz: raiz, base: 'main', integrationBranch: 'staging' });
  assert.equal(sucio.ok, false);
  assert.match(sucio.motivo, /sin commitear/);

  await gitOK(['checkout', 'base.txt'], raiz);
  await gitOK(['commit', '--allow-empty', '-m', 'la base avanza sola'], raiz);
  const noFf = await avanzarBase({ repoRaiz: raiz, base: 'main', integrationBranch: 'staging' });
  assert.equal(noFf.ok, false);
  assert.match(noFf.motivo, /fast-forward/);
});

test('linkConCopia: el node_modules del worktree enlaza todo salvo lo copiado, y regenerar lo copiado NO toca el original', async () => {
  const { raiz, rootDir } = await montar();
  // node_modules de mentira (sin versionar, como el real): un paquete común, .prisma y @prisma/{client,otro}.
  const nm = path.join(raiz, 'app', 'node_modules');
  fs.mkdirSync(path.join(nm, 'comun'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'comun', 'index.js'), 'comun\n');
  fs.mkdirSync(path.join(nm, '.prisma', 'client'), { recursive: true });
  fs.writeFileSync(path.join(nm, '.prisma', 'client', 'index.js'), 'cliente original\n');
  fs.mkdirSync(path.join(nm, '@prisma', 'client'), { recursive: true });
  fs.writeFileSync(path.join(nm, '@prisma', 'client', 'index.js'), 'pc original\n');
  fs.mkdirSync(path.join(nm, '@prisma', 'otro'), { recursive: true });
  fs.writeFileSync(path.join(nm, '@prisma', 'otro', 'x.js'), 'otro\n');

  const w = await crearWorktree({
    repoRaiz: raiz,
    base: 'main',
    jobId: 'lc1',
    rootDir,
    linkConCopia: [{ dir: 'app/node_modules', copiar: ['.prisma', '@prisma/client'] }],
  });
  const d = path.join(w.ruta, 'app', 'node_modules');
  assert.deepEqual(w.enlacesCreados, ['app/node_modules']);
  assert.equal(fs.lstatSync(d).isSymbolicLink(), false, 'el directorio es real');
  assert.equal(fs.lstatSync(path.join(d, 'comun')).isSymbolicLink(), true, 'lo común se enlaza');
  assert.equal(fs.lstatSync(path.join(d, '.prisma')).isSymbolicLink(), false, '.prisma se copia');
  assert.equal(fs.lstatSync(path.join(d, '@prisma')).isSymbolicLink(), false, '@prisma es real');
  assert.equal(fs.lstatSync(path.join(d, '@prisma', 'client')).isSymbolicLink(), false, '@prisma/client se copia');
  assert.equal(fs.lstatSync(path.join(d, '@prisma', 'otro')).isSymbolicLink(), true, 'el resto de @prisma se enlaza');
  assert.equal(fs.readFileSync(path.join(d, 'comun', 'index.js'), 'utf8'), 'comun\n');

  // "prisma generate" en el worktree: reescribe SU copia; el original queda intacto.
  fs.writeFileSync(path.join(d, '.prisma', 'client', 'index.js'), 'cliente regenerado\n');
  assert.equal(fs.readFileSync(path.join(nm, '.prisma', 'client', 'index.js'), 'utf8'), 'cliente original\n');

  // Y los enlaces/copias no aparecen como cambios del trabajo.
  const { archivos } = await cambiosDelWorktree({ ruta: w.ruta, baseCommit: w.baseCommit, ignorar: w.enlacesCreados });
  assert.deepEqual(archivos, []);
});

test('commitearTrabajo: un archivo borrado con git rm (ya fuera del disco y del índice) no tumba el commit', async () => {
  const { raiz, rootDir } = await montar();
  const w = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'rm1', rootDir });
  fs.writeFileSync(path.join(w.ruta, 'nuevo.txt'), 'nuevo\n');
  await gitOK(['rm', '-q', 'renombrar.txt'], w.ruta); // borrado ya staged: no existe en disco ni en el índice
  fs.rmSync(path.join(w.ruta, 'docs', 'leeme.md')); // borrado sin stagear: existe en el índice
  const commit = await commitearTrabajo({
    ruta: w.ruta,
    mensaje: 'borra y agrega',
    autor: 'T <t@t>',
    soloArchivos: ['nuevo.txt', 'renombrar.txt', 'docs/leeme.md'],
  });
  assert.match(commit, /^[0-9a-f]{40}$/);
  const tocados = (await gitOK(['show', '--name-status', '--format=', 'HEAD'], w.ruta)).trim().split('\n').sort();
  assert.deepEqual(tocados, ['A\tnuevo.txt', 'D\tdocs/leeme.md', 'D\trenombrar.txt']);
});

test('crearWorktree con pizarrón escribe una COPIA (archivo regular) del documento vivo', async () => {
  const { raiz, rootDir, base } = await montar();
  const pizarron = crearPizarron({ dir: path.join(base, 'pizarron') });
  pizarron.post({ clave: 'contrato', valor: { v: 1 }, jobId: 'orq' });

  const w = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'piz123', rootDir, pizarron });
  const copia = path.join(w.ruta, '.orq', 'pizarron.json');
  assert.equal(fs.lstatSync(copia).isSymbolicLink(), false, 'debe ser archivo regular, no un symlink');
  const doc = JSON.parse(fs.readFileSync(copia, 'utf8'));
  assert.deepEqual(doc.claves.contrato.valor, { v: 1 }, 'la copia refleja el documento vivo al crear');

  // Editar la copia NO altera el documento vivo; el servidor la puede reponer.
  fs.writeFileSync(copia, '{"version":999,"claves":{},"notas":[]}');
  assert.equal(pizarron.leer().version, 1, 'el documento vivo no se toca al editar la copia');
  assert.equal(refrescarCopiaPizarron({ worktree: w.ruta, pizarron }), true);
  assert.equal(JSON.parse(fs.readFileSync(copia, 'utf8')).version, 1, 'el refresco repone el contenido vivo');

  // Sin pizarrón no se crea ninguna copia.
  const sin = await crearWorktree({ repoRaiz: raiz, base: 'main', jobId: 'nopiz1', rootDir });
  assert.equal(fs.existsSync(path.join(sin.ruta, '.orq', 'pizarron.json')), false);
  assert.equal(refrescarCopiaPizarron({ worktree: '', pizarron }), false, 'sin worktree no escribe');
});

// --- SEGURIDAD: el refresco del pizarrón no debe seguir enlaces ----------------------

test('refrescarCopiaPizarron: con `.orq` symlink a fuera no escribe y reporta el motivo', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-piz-'));
  const dirExterno = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-piz-externo-'));
  fs.symlinkSync(dirExterno, path.join(worktree, '.orq'), 'dir');
  const pizarron = { leer: () => ({ version: 1, claves: {}, notas: [] }) };

  const res = refrescarCopiaPizarron({ worktree, pizarron, conMotivo: true });
  assert.deepEqual(res, { ok: false, motivo: 'orq_no_es_directorio' });
  assert.equal(fs.existsSync(path.join(dirExterno, 'pizarron.json')), false);
  assert.deepEqual(fs.readdirSync(dirExterno), [], 'el directorio externo queda intacto');
  assert.equal(refrescarCopiaPizarron({ worktree, pizarron }), false, 'sigue devolviendo boolean por defecto');
  fs.rmSync(dirExterno, { recursive: true, force: true });
});

test('refrescarCopiaPizarron: con el temporal symlink a fuera no pisa el archivo externo', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-piz-'));
  fs.mkdirSync(path.join(worktree, '.orq'));
  const externo = path.join(os.tmpdir(), `orq-piz-tmp-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(externo, 'contenido externo\n');
  fs.symlinkSync(externo, path.join(worktree, '.orq', 'pizarron.json.tmp'));
  const pizarron = { leer: () => ({ version: 2, claves: {}, notas: [] }) };

  assert.equal(refrescarCopiaPizarron({ worktree, pizarron }), true);
  assert.equal(fs.readFileSync(externo, 'utf8'), 'contenido externo\n', 'el externo queda intacto');
  assert.equal(JSON.parse(fs.readFileSync(path.join(worktree, '.orq', 'pizarron.json'), 'utf8')).version, 2);
  fs.rmSync(externo, { force: true });
});
