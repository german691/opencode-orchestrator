/**
 * Compuerta sobre la integración (`solo_aceptacion`), retomar un trabajo (`desde_job`),
 * esperar a varios (`esperarAlguno`) y la vigilancia de alcance durante la ejecución.
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

test('compuerta: solo_aceptacion sobre la integración corre la aceptación sin el agente y ve lo integrado', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });
  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  assert.equal((await gestor.integrar(a.id)).ok, true);

  const verde = await correr(gestor, { cwd: m.repo, solo_aceptacion: true, base: 'integracion', accept: 'test -f subA/out.txt' });
  assert.equal(verde.estado, 'succeeded');
  assert.equal(verde.resultado.proceso.duracionMs, 0, 'el agente no corrió');
  assert.equal(fs.existsSync(path.join(verde.worktree, 'out.txt')), false, 'nadie escribió en la raíz: no hubo agente');
  assert.equal(verde.resultado.commit, null, 'una compuerta no produce commit integrable');
  assert.match(verde.titulo, /Compuerta sobre la integración/);

  const roja = await correr(gestor, { cwd: m.repo, solo_aceptacion: true, base: 'integracion', accept: 'test -f no-existe.txt' });
  assert.equal(roja.estado, 'rejected');
  assert.equal(roja.motivoFin, 'aceptacion');
  // Sobre la base (sin lo integrado) la misma comprobación NO pasa: la compuerta mide la integración.
  const sobreBase = await correr(gestor, { cwd: m.repo, solo_aceptacion: true, base: 'base', accept: 'test -f subA/out.txt' });
  assert.equal(sobreBase.estado, 'rejected');
});

test('solo_aceptacion exige una accept y no necesita prompt ni writes', async (t) => {
  const m = await montar(t, { perfil: { accept: {} } });
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, solo_aceptacion: true }), /necesita una `accept`/);
});

test('desde_job: retoma lo que dejó un trabajo rechazado y repite solo la aceptación', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/nuevo.txt' }), home: m.home });
  const malo = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'], accept: 'false' });
  assert.equal(malo.estado, 'rejected');
  assert.equal(malo.motivoFin, 'aceptacion');

  const reintento = await correr(gestor, { cwd: m.repo, desde_job: malo.id, solo_aceptacion: true, accept: 'test -f subA/nuevo.txt' });
  assert.equal(reintento.estado, 'succeeded');
  assert.equal(reintento.desdeJob, malo.id);
  assert.equal(reintento.baseCommit, malo.baseCommit, 'parte del mismo commit que el original');
  assert.deepEqual(reintento.writes, malo.writes, 'hereda el alcance');
  assert.deepEqual(reintento.resultado.archivos, ['subA/nuevo.txt']);
  assert.match(reintento.resultado.commit, /^[0-9a-f]{40}$/);
  assert.equal((await gestor.integrar(reintento.id)).ok, true, 'el reintento verde se puede integrar');
});

test('desde_job valida el origen: inexistente, activo o sin worktree', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_DORMIR: '3000' }), home: m.home });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, desde_job: 'noexiste', solo_aceptacion: true, accept: 'true' }), /no existe el trabajo/);
  const activo = await gestor.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, desde_job: activo.id, solo_aceptacion: true, accept: 'true' }), /sigue/);
  await gestor.cancelar(activo.id);
  await gestor.esperar(activo.id, 10000);
  await gestor.limpiar({ ids: [activo.id] });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, desde_job: activo.id, solo_aceptacion: true, accept: 'true' }), /no conserva su worktree/);
});

test('esperarAlguno responde apenas termina uno y reparte terminados y activos', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });
  const rapido = await gestor.enviar({ prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  await assert.rejects(() => gestor.esperarAlguno(['noexiste'], 100), /No existe el trabajo/);
  const r = await gestor.esperarAlguno([rapido.id], 30000);
  assert.deepEqual(r, { terminados: [rapido.id], activos: [] });
  // Ya terminado: responde sin esperar.
  const t0 = Date.now();
  assert.deepEqual(await gestor.esperarAlguno([rapido.id], 30000), { terminados: [rapido.id], activos: [] });
  assert.ok(Date.now() - t0 < 1000);
});

test('vigilancia de alcance: un agente que persiste fuera de writes se detiene sin esperar al final', async (t) => {
  const m = await montar(t);
  // Escribe FUERA de su alcance y se queda dormido 60 s: sin vigilancia llegaría al tope de tiempo.
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'fuera.txt', ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
    vigilanciaAlcanceMs: 150,
  });
  const inicio = Date.now();
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(r.estado, 'rejected', JSON.stringify({ motivoFin: r.motivoFin, error: r.error }));
  assert.equal(r.motivoFin, 'alcance');
  assert.ok(Date.now() - inicio < 20000, 'se detuvo temprano, no esperó los 60 s');
  assert.deepEqual(r.resultado.violaciones.map((v) => v.ruta), ['fuera.txt']);
  assert.match(r.resultado.advertencias.join(' '), /TEMPRANO/);
  assert.equal(r.resultado.proceso.motivo, 'detenido_por_alcance');
});

test('vigilancia de alcance: un archivo de paso que se borra a tiempo no corta al agente', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/ok.txt', ORQ_FAKE_DORMIR: '600' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(r.estado, 'succeeded', 'dentro de su alcance: nunca se corta');
  await gitOK(['status'], r.worktree);
});

test('solo_aceptacion y avanzar_base se aceptan también como texto "true" (clientes con el esquema en caché)', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });
  const r = await correr(gestor, { cwd: m.repo, solo_aceptacion: 'true', accept: 'true' });
  assert.equal(r.soloAceptacion, true);
  assert.equal(r.estado, 'succeeded');
  assert.equal(r.resultado.proceso.duracionMs, 0, 'el agente no corrió');
});

test('sin progreso: un agente que no escribe nada en el plazo se corta y el mensaje dice cómo relanzar', async (t) => {
  const m = await montar(t);
  // Se queda "explorando" 60 s sin escribir: sin el vigilante llegaría al tope de tiempo.
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
    sinProgresoMs: 700,
  });
  const inicio = Date.now();
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(r.estado, 'failed');
  assert.equal(r.motivoFin, 'sin_progreso');
  assert.ok(Date.now() - inicio < 20000, 'se cortó temprano');
  assert.match(r.resultado.advertencias.join(' '), /NINGÚN archivo.*Relanzá.*ACOTADO/s);
});

test('sin progreso: un agente que escribe a tiempo NO se corta aunque siga trabajando; y readonly queda exento', async (t) => {
  const m = await montar(t);
  const escribe = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/ok.txt', ORQ_FAKE_DORMIR: '2500' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
    sinProgresoMs: 1200,
  });
  const ok = await correr(escribe, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(ok.estado, 'succeeded', 'escribió antes del plazo: sigue vivo');

  const lector = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '2500' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
    sinProgresoMs: 700,
  });
  const ro = await correr(lector, { prompt: 'solo mira', cwd: m.repo, mode: 'readonly' });
  assert.notEqual(ro.motivoFin, 'sin_progreso', 'readonly no escribe: no se corta por eso');
});
