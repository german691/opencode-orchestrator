/**
 * El servidor firma los commits NUEVOS (del trabajo y del merge) con la identidad
 * git del repo, NO con el usuario del sistema. Verifica autor Y committer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { crearGestor, entornoFalso, gitOK, montar } from './gestor-comun.js';

async function correr(gestor, spec) {
  const trabajo = await gestor.enviar(spec);
  await gestor.esperar(trabajo.id, 30000);
  return gestor.obtener(trabajo.id);
}

/** `anh|aem|cmm|cmmemail` del último commit de una ref. */
async function identidadDe(repo, ref) {
  return (await gitOK(['log', '-1', '--format=%an|%ae|%cn|%ce', ref], repo)).trim();
}

test('el commit del trabajo y el merge usan user.name/user.email del repo para autor y committer', async (t) => {
  const m = await montar(t);
  // Distinta de la del entorno: si se filtrara la del sistema, el assert la delata.
  await gitOK(['config', 'user.name', 'Dueña Repo'], m.repo);
  await gitOK(['config', 'user.email', 'duena@repo.test'], m.repo);
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }),
    home: m.home,
  });

  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  assert.equal(a.estado, 'succeeded');
  const esperada = 'Dueña Repo|duena@repo.test|Dueña Repo|duena@repo.test';
  assert.equal(await identidadDe(m.repo, `job/${a.id}`), esperada);

  const r = await gestor.integrar(a.id);
  assert.equal(r.ok, true);
  const merge = await identidadDe(m.repo, 'staging');
  assert.equal(merge, esperada, 'el merge también firma con la identidad del repo');
  assert.doesNotMatch(merge, /root@|localdomain/, 'nunca el usuario del sistema');
  gestor.cerrar?.();
});

test('el `autor` del perfil tiene prioridad sobre la config del repo', async (t) => {
  const m = await montar(t, { perfil: { autor: { nombre: 'Perfil', email: 'perfil@test' } } });
  await gitOK(['config', 'user.name', 'Repo'], m.repo);
  await gitOK(['config', 'user.email', 'repo@test'], m.repo);
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }),
    home: m.home,
  });

  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  assert.equal(await identidadDe(m.repo, `job/${a.id}`), 'Perfil|perfil@test|Perfil|perfil@test');
  gestor.cerrar?.();
});

test('sin user.name/user.email en el repo, los commits salen con el fallback', async (t) => {
  const m = await montar(t);
  await gitOK(['config', '--unset', 'user.name'], m.repo);
  await gitOK(['config', '--unset', 'user.email'], m.repo);
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }),
    home: m.home,
  });

  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  assert.equal(a.estado, 'succeeded');
  assert.equal(
    await identidadDe(m.repo, `job/${a.id}`),
    'opencode-orchestrator|orquestador@localhost|opencode-orchestrator|orquestador@localhost',
  );
  gestor.cerrar?.();
});
