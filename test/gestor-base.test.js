/**
 * La rama base del perfil manda (el trabajo parte de `baseBranch`) y un cambio en el árbol
 * REAL durante un trabajo aislado se advierte (el agente pudo salir del worktree).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { crearGestor, entornoFalso, gitOK, montar } from './gestor-comun.js';

test('el trabajo parte de baseBranch del perfil (no de main ni de la rama actual)', async (t) => {
  const m = await montar(t, { perfil: { baseBranch: 'dev' } });
  // 'dev' tiene un archivo que 'main' no tiene; el repo queda parado en 'main'.
  await gitOK(['checkout', '-q', '-b', 'dev'], m.repo);
  fs.writeFileSync(path.join(m.repo, 'solo-en-dev.txt'), 'dev\n');
  await gitOK(['add', '-A'], m.repo);
  await gitOK(['commit', '-qm', 'dev'], m.repo);
  const shaDev = (await gitOK(['rev-parse', 'dev'], m.repo)).trim();
  await gitOK(['checkout', '-q', 'main'], m.repo);

  const gestor = crearGestor(m.almacen, { entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js' }), home: m.home });
  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.baseCommit, shaDev, 'el commit base del trabajo es el de dev');
  const archivosDeLaRama = (await gitOK(['ls-tree', '-r', '--name-only', fin.rama], m.repo)).split('\n');
  assert.ok(archivosDeLaRama.includes('solo-en-dev.txt'), 'la rama del trabajo contiene lo que solo existe en dev');
  await gestor.cerrar();
});

test('si el árbol real cambia durante un trabajo aislado se ADVIERTE (y el trabajo no se rechaza)', async (t) => {
  const m = await montar(t);
  // Ruta relativa desde el worktree (<base>/worktrees/<id>) hacia el árbol real (<base>/repo).
  const gestor = crearGestor(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js;../../repo/fuga.txt' }),
    home: m.home,
  });
  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fs.existsSync(path.join(m.repo, 'fuga.txt')), true, 'el falso escribió en el árbol real');
  assert.equal(fin.estado, 'succeeded', 'el worktree está dentro de su alcance: no se rechaza');
  assert.equal(fin.resultado.advertencias.length, 1);
  assert.match(fin.resultado.advertencias[0], /El árbol principal cambió/);
  assert.match(fin.resultado.advertencias[0], /fuga\.txt/);
  await gestor.cerrar();
});

test('sin cambios en el árbol real no hay advertencias', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js' }), home: m.home });
  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.deepEqual(fin.resultado.advertencias, []);
  await gestor.cerrar();
});

test('si HEAD del árbol real se mueve durante un trabajo aislado también se advierte', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js', ORQ_FAKE_DORMIR: '800' }),
    home: m.home,
  });
  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  // Mientras el trabajo corre, alguien (o el propio agente) hace un commit en el repo real.
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(m.repo, 'externo.txt'), 'externo\n');
  await gitOK(['add', '-A'], m.repo);
  await gitOK(['commit', '-qm', 'commit externo'], m.repo);

  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.advertencias.length, 1);
  assert.match(fin.resultado.advertencias[0], /\(HEAD movido\)/);
  await gestor.cerrar();
});

test('los esperar() que vencen por tiempo no dejan esperadores registrados (sin fuga en sondeos repetidos)', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js', ORQ_FAKE_DORMIR: '1500' }),
    home: m.home,
  });
  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  for (let i = 0; i < 5; i += 1) assert.equal(await gestor.esperar(trabajo.id, 20), null, 'sigue activo');
  assert.equal(gestor.esperadores.get(trabajo.id)?.size ?? 0, 0, 'ningún esperador vencido queda registrado');

  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(gestor.esperadores.size, 0);
  await gestor.cerrar();
});
