/**
 * Robustez del gestor: tope de concurrencia por repo, carrera entre `enviar()` y
 * `cerrar()`, y rastro en stderr cuando el registro global de eventos falla.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Gestor } from '../src/core/gestor.js';
import { NODE, crearGestor, entornoFalso, esperar, montar } from './gestor-comun.js';

test('el tope por repo del perfil se guarda en el job y frena al segundo del mismo repo', async (t) => {
  const m = await montar(t, { perfil: { concurrency: 1 } });
  // El tope GLOBAL de crearGestor es 2, así que lo que frena a `b` es el tope del repo.
  const gestor = crearGestor(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.txt', ORQ_FAKE_DORMIR: '1500' }),
    home: m.home,
  });

  const a = await gestor.enviar({ prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({ prompt: 'B', cwd: path.join(m.repo, 'subB'), mode: 'safe', writes: ['subB/**'] });

  assert.equal(gestor.obtener(a.id).concurrenciaRepo, 1, 'el job guarda el tope del repo');
  assert.equal(gestor.obtener(b.id).concurrenciaRepo, 1);
  assert.ok(await esperar(() => gestor.obtener(a.id).estado === 'running'), 'a debe estar corriendo');
  assert.equal(gestor.obtener(b.id).estado, 'queued', 'b no puede arrancar con el repo lleno');
  assert.equal(gestor.obtener(b.id).espera?.motivo, 'tope_del_repo', 'el motivo es el tope del repo, no el global');

  await gestor.cerrar(500);
});

test('cerrar() durante enviar() rechaza el trabajo en vez de dejarlo en cola para siempre', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { entorno: entornoFalso({}) });

  // `enviar` se detiene en su primer `await`; `cerrar` pone `cerrado = true` antes de eso.
  const pendiente = gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const cierre = gestor.cerrar(0);

  let creado = null;
  let error = null;
  try {
    creado = await pendiente;
  } catch (e) {
    error = e;
  }
  await cierre;

  if (creado) {
    // Si llegó a crearse, cerrar() ya vació la cola: el trabajo debe haber quedado terminal.
    assert.notEqual(gestor.obtener(creado.id).estado, 'queued', 'nunca puede quedar encolado para siempre');
  } else {
    assert.match(error.message, /cerrando/i, 'el rechazo explica que el servidor se está cerrando');
  }
  assert.equal(gestor.cola.length, 0, 'no queda nada en la cola tras cerrar');
});

test('#evento reporta el primer fallo del registro y luego uno cada 100, sin frenar la operación', async (t) => {
  const m = await montar(t);
  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({}),
    home: m.home,
    graceMs: 300,
    registro: {
      registrar() {
        throw new Error('boom');
      },
    },
  });

  const lineas = [];
  const original = process.stderr.write;
  process.stderr.write = (texto) => {
    lineas.push(String(texto));
    return true;
  };
  try {
    for (let i = 0; i < 100; i += 1) gestor.registrarArranque();
  } finally {
    process.stderr.write = original;
  }

  assert.equal(gestor.fallosDeEvento, 100);
  assert.equal(lineas.length, 2, 'se reporta el 1º y el 100º, no los 100');
  assert.match(lineas[0], /fallo al registrar evento \(1\)/);
  assert.match(lineas[0], /boom/);
  assert.match(lineas[1], /\(100\)/);
});

test('#evento también reporta cuando el registro devuelve false (fallo de E/S)', async (t) => {
  const m = await montar(t);
  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({}),
    home: m.home,
    graceMs: 300,
    registro: { registrar: () => false },
  });

  const lineas = [];
  const original = process.stderr.write;
  process.stderr.write = (texto) => {
    lineas.push(String(texto));
    return true;
  };
  try {
    gestor.registrarArranque();
  } finally {
    process.stderr.write = original;
  }

  assert.equal(lineas.length, 1);
  assert.match(lineas[0], /fallo de E\/S/);
});
