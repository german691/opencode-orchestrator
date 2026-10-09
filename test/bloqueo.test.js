import test from 'node:test';
import assert from 'node:assert/strict';

import { adquirirBloqueoConEspera } from '../src/core/bloqueo.js';

/** Almacén falso: falla `n` veces con 'otro servidor activo' y luego concede el bloqueo. */
function almacenQueSeLibera(n) {
  let intentos = 0;
  return {
    get intentos() {
      return intentos;
    },
    adquirirBloqueoDeInstancia() {
      intentos += 1;
      if (intentos <= n) throw new Error('otro servidor activo pid 123');
      return { pid: 1 };
    },
  };
}

const sinDormir = async () => {};

test('reintenta mientras el bloqueo está ocupado y lo toma cuando se libera', async () => {
  const almacen = almacenQueSeLibera(3);
  const lock = await adquirirBloqueoConEspera(almacen, { esperaMs: 5000, intervaloMs: 100, dormir: sinDormir });
  assert.deepEqual(lock, { pid: 1 });
  assert.equal(almacen.intentos, 4);
});

test('si el otro servidor sigue vivo tras la espera, falla con el mensaje original', async () => {
  const almacen = almacenQueSeLibera(1000);
  await assert.rejects(
    () => adquirirBloqueoConEspera(almacen, { esperaMs: 500, intervaloMs: 100, dormir: sinDormir }),
    /otro servidor activo pid 123/,
  );
  // 500/100 = 5 esperas -> 6 intentos: acotado, no un bucle infinito.
  assert.equal(almacen.intentos, 6);
});

test('un error distinto de "otro servidor activo" no se reintenta', async () => {
  let intentos = 0;
  const almacen = {
    adquirirBloqueoDeInstancia() {
      intentos += 1;
      throw new Error('EACCES');
    },
  };
  await assert.rejects(() => adquirirBloqueoConEspera(almacen, { esperaMs: 5000, dormir: sinDormir }), /EACCES/);
  assert.equal(intentos, 1);
});

test('con esperaMs 0 se comporta como antes (un solo intento)', async () => {
  const almacen = almacenQueSeLibera(5);
  await assert.rejects(() => adquirirBloqueoConEspera(almacen, { esperaMs: 0, dormir: sinDormir }), /otro servidor activo/);
  assert.equal(almacen.intentos, 1);
});
