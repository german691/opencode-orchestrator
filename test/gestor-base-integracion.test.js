/**
 * `jobBase: 'integracion'`: los trabajos parten de la rama de integración (con lo integrado
 * antes y lo commiteado en la base), no de la base, que solo avanza cuando el usuario decide.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { crearGestor, entornoFalso, gitOK, montar } from './gestor-comun.js';

async function correr(gestor, spec) {
  const trabajo = await gestor.enviar(spec);
  await gestor.esperar(trabajo.id, 30000);
  return gestor.obtener(trabajo.id);
}

test('con jobBase integracion, el trabajo siguiente ve lo ya integrado aunque la base no avanzó', async (t) => {
  const m = await montar(t, { perfil: { jobBase: 'integracion' } });
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });

  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  assert.equal(a.estado, 'succeeded');
  assert.equal((await gestor.integrar(a.id)).ok, true);
  const mainAntes = (await gitOK(['rev-parse', 'main'], m.repo)).trim();

  const b = await correr(gestor, { prompt: 'B', cwd: path.join(m.repo, 'subB'), mode: 'safe', writes: ['subB/**'] });
  assert.equal(b.estado, 'succeeded');
  assert.ok(fs.existsSync(path.join(b.worktree, 'subA', 'out.txt')), 'B parte de staging: ve el trabajo de A');
  assert.equal((await gitOK(['rev-parse', 'main'], m.repo)).trim(), mainAntes, 'la base no se tocó');
  // El diff de B se mide contra SU punto de partida: no arrastra lo de A como "fuera de alcance".
  assert.deepEqual(b.resultado.violaciones ?? [], []);
  gestor.cerrar?.();
});

test('sin jobBase (por defecto) el trabajo parte de la base y NO ve lo integrado', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });

  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  assert.equal((await gestor.integrar(a.id)).ok, true);
  const b = await correr(gestor, { prompt: 'B', cwd: path.join(m.repo, 'subB'), mode: 'safe', writes: ['subB/**'] });
  assert.equal(fs.existsSync(path.join(b.worktree, 'subA', 'out.txt')), false);
});

test('opencode_merge con avanzar_base avanza la base por fast-forward y lo informa', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });
  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });

  const r = await gestor.integrar(a.id, { avanzarBase: true });
  assert.equal(r.ok, true);
  assert.equal(r.baseAvanzada.ok, true);
  assert.ok(fs.existsSync(path.join(m.repo, 'subA', 'out.txt')), 'el árbol real recibió el trabajo');
  assert.equal((await gitOK(['rev-parse', 'main'], m.repo)).trim(), r.baseAvanzada.sha);
});
