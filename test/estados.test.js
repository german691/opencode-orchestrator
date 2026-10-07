import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESTADOS,
  esTerminal,
  puedeTransicionar,
  transicionar,
} from '../src/core/estados.js';

test('ESTADOS contiene exactamente los estados del diseño', () => {
  assert.deepEqual([...ESTADOS].sort(), [
    'cancelled',
    'failed',
    'lost',
    'merged',
    'provisioning',
    'queued',
    'rejected',
    'running',
    'succeeded',
    'verifying',
  ]);
});

test('esTerminal identifica los estados sin retorno', () => {
  for (const estado of ['succeeded', 'failed', 'cancelled', 'rejected', 'lost', 'merged']) {
    assert.equal(esTerminal(estado), true, `${estado} debería ser terminal`);
  }
  for (const estado of ['queued', 'provisioning', 'running', 'verifying']) {
    assert.equal(esTerminal(estado), false, `${estado} no debería ser terminal`);
  }
});

/**
 * Tabla de transiciones esperada, escrita a mano desde la sección 3 del diseño.
 * Se compara contra puedeTransicionar para TODAS las combinaciones (10x10).
 */
const TABLA = {
  queued: ['provisioning', 'cancelled', 'lost'],
  provisioning: ['running', 'failed', 'cancelled', 'lost'],
  running: ['verifying', 'failed', 'cancelled', 'lost'],
  verifying: ['succeeded', 'failed', 'rejected', 'cancelled', 'lost'],
  succeeded: ['merged'],
  failed: [],
  cancelled: [],
  rejected: [],
  lost: [],
  merged: [],
};

test('puedeTransicionar coincide con la tabla completa 10x10', () => {
  for (const desde of ESTADOS) {
    for (const hacia of ESTADOS) {
      const esperado = TABLA[desde].includes(hacia);
      assert.equal(
        puedeTransicionar(desde, hacia),
        esperado,
        `${desde} -> ${hacia} debía ser ${esperado}`,
      );
    }
  }
});

test('puedeTransicionar devuelve false para estados desconocidos', () => {
  assert.equal(puedeTransicionar('inventado', 'running'), false);
  assert.equal(puedeTransicionar('running', 'inventado'), false);
});

test('transicionar avanza y sella creadoEn e inicioEn', () => {
  const trabajo = { estado: 'queued' };
  transicionar(trabajo, 'provisioning', 100);
  assert.equal(trabajo.estado, 'provisioning');
  assert.equal(trabajo.creadoEn, 100);
  assert.equal(trabajo.inicioEn, undefined);

  transicionar(trabajo, 'running', 200);
  assert.equal(trabajo.estado, 'running');
  assert.equal(trabajo.inicioEn, 200);
});

test('transicionar sella finEn al llegar a un estado terminal', () => {
  const trabajo = { estado: 'running', creadoEn: 1, inicioEn: 2 };
  transicionar(trabajo, 'verifying', 3);
  assert.equal(trabajo.finEn, undefined);
  transicionar(trabajo, 'succeeded', 4);
  assert.equal(trabajo.estado, 'succeeded');
  assert.equal(trabajo.finEn, 4);
});

test('transicionar NO pisa marcas de tiempo existentes', () => {
  const trabajo = { estado: 'queued', creadoEn: 10, inicioEn: 20, finEn: 30 };
  transicionar(trabajo, 'provisioning', 99);
  assert.equal(trabajo.creadoEn, 10);
  assert.equal(trabajo.inicioEn, 20);
  assert.equal(trabajo.finEn, 30);
});

test('transicionar permite succeeded -> merged y sella finEn sin pisar', () => {
  const trabajo = { estado: 'succeeded', creadoEn: 1, inicioEn: 2, finEn: 3 };
  transicionar(trabajo, 'merged', 4);
  assert.equal(trabajo.estado, 'merged');
  assert.equal(trabajo.finEn, 3);
});

test('transicionar lanza en transiciones inválidas', () => {
  assert.throws(() => transicionar({ estado: 'succeeded' }, 'running', 1), /Transición inválida/);
  assert.throws(() => transicionar({ estado: 'queued' }, 'merged', 1), /Transición inválida/);
  assert.throws(() => transicionar({ estado: 'running' }, 'merged', 1), /Transición inválida/);
  assert.throws(() => transicionar({ estado: 'failed' }, 'running', 1), /Transición inválida/);
});

test('transicionar lanza para estados desconocidos y entradas no objeto', () => {
  assert.throws(() => transicionar({ estado: 'zzz' }, 'running', 1), /origen desconocido/);
  assert.throws(() => transicionar({ estado: 'queued' }, 'zzz', 1), /destino desconocido/);
  assert.throws(() => transicionar(null, 'running', 1), TypeError);
});

test('transicionar usa Date.now() si no se indica ahora', () => {
  const trabajo = { estado: 'queued' };
  transicionar(trabajo, 'provisioning');
  assert.equal(typeof trabajo.creadoEn, 'number');
  assert.ok(trabajo.creadoEn > 0);
});
