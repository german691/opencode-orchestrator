/**
 * Auto-integración (opt-in del perfil): un trabajo `safe` con commit que termina
 * `succeeded` se integra solo en la rama de integración, sin avanzar la base.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Gestor } from '../src/core/gestor.js';
import { crearRegistroEventos } from '../src/core/eventos.js';
import { crearGestor, entornoFalso, esperar, gitOK, montar, NODE } from './gestor-comun.js';

/**
 * Gestor con el registro global de eventos del estado del test (para ver el actor del merge).
 * @param {object} m montaje de gestor-comun
 * @param {NodeJS.ProcessEnv} entorno
 * @param {object} [registro]
 * @returns {Gestor}
 */
function gestorConRegistro(m, entorno, registro = crearRegistroEventos({ dir: m.estadoDir })) {
  return new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entorno,
    home: m.home,
    graceMs: 300,
    registro,
  });
}

test('autoIntegrar: un trabajo safe exitoso queda merged en la integración con evento del servidor', async (t) => {
  const m = await montar(t, { perfil: { autoIntegrar: { habilitado: true } } });
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = gestorConRegistro(m, entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js' }), registro);

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 20000);

  assert.equal(fin.estado, 'merged');
  assert.equal(fin.resultado.autoIntegrado, true);
  assert.equal(fin.resultado.autoIntegradoEn, 'staging');
  assert.match(await gitOK(['ls-tree', '-r', '--name-only', 'staging'], m.repo), /subA\/x\.js/);
  const merges = registro.listar({ tipo: 'merge', jobId: trabajo.id });
  assert.equal(merges.length, 1);
  assert.equal(merges[0].actor, 'servidor:auto');

  await gestor.cerrar();
});

test('autoIntegrar: con requiereRevisor y sin veredicto APRUEBA queda succeeded', async (t) => {
  const m = await montar(t, { perfil: { autoIntegrar: { habilitado: true, requiereRevisor: true } } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 20000);

  assert.equal(fin.estado, 'succeeded', 'sin revisor no hay APRUEBA y no se auto-integra');

  await gestor.cerrar();
});

test('autoIntegrar: ante conflicto queda succeeded con advertencia y la integración intacta', async (t) => {
  const m = await montar(t, { perfil: { autoIntegrar: { habilitado: true } } });
  const g1 = gestorConRegistro(m, entornoFalso({ ORQ_FAKE_ESCRIBIR: 'conflicto.txt' }));
  const a = await g1.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['conflicto.txt'] });
  const finA = await g1.esperar(a.id, 20000);
  assert.equal(finA.estado, 'merged', 'el primero se integra solo');

  const g2 = gestorConRegistro(m, entornoFalso({ ORQ_FAKE_ESCRIBIR: './conflicto.txt' }));
  const b = await g2.enviar({ prompt: 'B', cwd: m.repo, mode: 'safe', writes: ['conflicto.txt'] });
  const finB = await g2.esperar(b.id, 20000);

  assert.equal(finB.estado, 'succeeded', 'un conflicto no cambia el estado del trabajo');
  assert.ok(
    Array.isArray(finB.resultado.advertencias) &&
      finB.resultado.advertencias.some((texto) => /No se pudo integrar automáticamente/.test(texto)),
    `advertencias: ${JSON.stringify(finB.resultado.advertencias)}`,
  );

  await g1.cerrar();
  await g2.cerrar();
});

test('esperarIntegracion: un trabajo solapado no arranca hasta integrar al anterior', async (t) => {
  const m = await montar(t, { perfil: { esperarIntegracion: true } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js' }),
    home: m.home,
    concurrencia: 2,
  });

  const a = await gestor.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({ prompt: 'B', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const finA = await gestor.esperar(a.id, 20000);
  assert.equal(finA.estado, 'succeeded');

  // B comparte writes con A (succeeded, sin integrar): queda en cola en vez de arrancar.
  assert.ok(await esperar(() => gestor.obtener(b.id).estado === 'queued', 3000), 'B debe seguir en cola');
  assert.equal(gestor.obtener(b.id).espera?.motivo, 'esperando_integracion');

  // Al integrar A, el planificador reevalúa y B arranca.
  assert.equal((await gestor.integrar(a.id)).ok, true);
  const finB = await gestor.esperar(b.id, 20000);
  assert.equal(finB.estado, 'succeeded');

  await gestor.cerrar();
});
