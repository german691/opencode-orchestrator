import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizarParalelo, expandirComandos, ejecutarParalelo } from '../src/core/paralelo.js';

/** La aceptación llega como `{ paralelo: {...} }`. */
const spec = (paralelo) => ({ paralelo });

test('paralelo: valida shards, comando, recurso y timeout', () => {
  assert.throws(() => normalizarParalelo(null), /sección 'paralelo'/);
  assert.throws(() => normalizarParalelo({}), /sección 'paralelo'/);
  assert.throws(() => normalizarParalelo(spec({ shards: 1, comando: 'x {i}' })), /entre 2 y 8/);
  assert.throws(() => normalizarParalelo(spec({ shards: 9, comando: 'x {i}' })), /entre 2 y 8/);
  assert.throws(() => normalizarParalelo(spec({ shards: 2.5, comando: 'x {i}' })), /entre 2 y 8/);
  assert.throws(() => normalizarParalelo(spec({ shards: 3, comando: '   ' })), /no puede estar vacío/);
  assert.throws(() => normalizarParalelo(spec({ shards: 3, comando: 'npx vitest run' })), /incluir '\{i\}'/);
  assert.throws(() => normalizarParalelo(spec({ shards: 3, comando: 'x {i}', recurso: '' })), /recurso/);
  assert.throws(() => normalizarParalelo(spec({ shards: 3, comando: 'x {i}', timeoutMs: 0 })), /timeoutMs/);
});

test('paralelo: normaliza con valores por defecto', () => {
  assert.deepEqual(normalizarParalelo(spec({ shards: 3, comando: 'shard {i}/{n}' })), {
    shards: 3,
    comando: 'shard {i}/{n}',
    recurso: undefined,
    timeoutMs: undefined,
    cortarAlPrimerFallo: false,
  });
  assert.deepEqual(
    normalizarParalelo(spec({ shards: 2, comando: 'x {i}', recurso: 'db', timeoutMs: 5000, cortarAlPrimerFallo: true })),
    { shards: 2, comando: 'x {i}', recurso: 'db', timeoutMs: 5000, cortarAlPrimerFallo: true },
  );
});

test('paralelo: expande {i} (1..N) y {n}', () => {
  assert.deepEqual(expandirComandos(spec({ shards: 3, comando: 'npx vitest --shard={i}/{n}' })), [
    'npx vitest --shard=1/3',
    'npx vitest --shard=2/3',
    'npx vitest --shard=3/3',
  ]);
});

test('paralelo: todos con código 0 -> ok', async () => {
  const vistos = [];
  const ejecutar = async (comando, { env, indice }) => {
    vistos.push({ comando, indice, env });
    return { codigo: 0, salida: `ok ${indice}` };
  };

  const r = await ejecutarParalelo({ spec: spec({ shards: 3, comando: 'test {i}/{n}' }), ejecutar });

  assert.equal(r.ok, true);
  assert.deepEqual(r.fragmentos.map((f) => f.indice), [1, 2, 3]);
  assert.deepEqual(r.fragmentos.map((f) => f.comando), ['test 1/3', 'test 2/3', 'test 3/3']);
  assert.deepEqual(vistos.map((v) => v.indice).sort(), [1, 2, 3]);
  for (const f of r.fragmentos) assert.equal(f.codigo, 0);
  assert.match(r.salidaCombinada, /\[1\/3\] test 1\/3/);
});

test('paralelo: un fragmento falla y los demás igual corren (no se cancelan)', async () => {
  const ejecutados = [];
  const ejecutar = async (comando, { indice }) => {
    ejecutados.push(indice);
    return indice === 2 ? { codigo: 1, salida: 'fallo en 2' } : { codigo: 0, salida: 'ok' };
  };

  const r = await ejecutarParalelo({ spec: spec({ shards: 3, comando: 'x {i}' }), ejecutar });

  assert.equal(r.ok, false);
  assert.deepEqual([...ejecutados].sort(), [1, 2, 3], 'todos deben haberse ejecutado');
  assert.equal(r.fragmentos.length, 3);
  assert.equal(r.fragmentos.some((f) => f.cancelado), false, 'por defecto nadie se cancela');
  assert.equal(r.fragmentos.find((f) => f.indice === 2).codigo, 1);
  // El fallido va primero en la salida combinada.
  assert.ok(r.salidaCombinada.indexOf('[2/3]') < r.salidaCombinada.indexOf('[1/3]'));
  assert.ok(r.salidaCombinada.indexOf('[2/3]') < r.salidaCombinada.indexOf('[3/3]'));
  assert.ok(r.salidaCombinada.includes('[1/3]') && r.salidaCombinada.includes('[3/3]'));
});

test('paralelo: salidaCola guarda solo las últimas 60 líneas', async () => {
  const lineas = Array.from({ length: 70 }, (_, i) => `linea-${i + 1}`);
  const ejecutar = async () => ({ codigo: 0, salida: lineas.join('\n') });

  const r = await ejecutarParalelo({ spec: spec({ shards: 2, comando: 'x {i}' }), ejecutar });

  for (const f of r.fragmentos) {
    assert.equal(f.salidaCola.split('\n').length, 60);
    assert.equal(f.salidaCola.startsWith('linea-11'), true);
    assert.equal(f.salidaCola.endsWith('linea-70'), true);
  }
});

test('paralelo: si la provisión falla, libera los ya provisionados', async () => {
  const liberados = [];
  const provisionar = async (indice) => {
    if (indice === 2) throw new Error('sin base para 2');
    return { env: { BASE: `db${indice}` }, id: indice };
  };
  const ejecutar = async (comando, { env }) => ({ codigo: 0, salida: `usé ${env.BASE}` });
  const liberar = async (datos) => {
    liberados.push(datos.id);
  };

  const r = await ejecutarParalelo({
    spec: spec({ shards: 3, comando: 'x {i}', recurso: 'db' }),
    ejecutar,
    provisionar,
    liberar,
  });

  assert.equal(r.ok, false);
  assert.equal(r.fragmentos.find((f) => f.indice === 2).codigo, -1);
  assert.deepEqual([...liberados].sort(), [1, 3], 'solo se liberan los que llegaron a provisionarse');
});

test('paralelo: libera aunque el fragmento falle', async () => {
  const liberados = [];
  const provisionar = async (indice) => ({ env: {}, id: indice });
  const liberar = async (datos) => {
    liberados.push(datos.id);
  };
  const ejecutar = async (comando, { indice }) => {
    if (indice === 2) throw new Error('explotó');
    return { codigo: 0, salida: 'ok' };
  };

  const r = await ejecutarParalelo({
    spec: spec({ shards: 3, comando: 'x {i}', recurso: 'db' }),
    ejecutar,
    provisionar,
    liberar,
  });

  assert.equal(r.ok, false);
  assert.equal(r.fragmentos.find((f) => f.indice === 2).codigo, -1);
  assert.deepEqual([...liberados].sort(), [1, 2, 3], 'la liberación es garantizada');
});

test('paralelo: los N arrancan antes de que termine el primero', async () => {
  const shards = 4;
  let activos = 0;
  let maximo = 0;
  const orden = [];
  const ejecutar = async (comando, { indice }) => {
    activos += 1;
    maximo = Math.max(maximo, activos);
    orden.push(`inicio-${indice}`);
    await new Promise((r) => setTimeout(r, 15));
    activos -= 1;
    orden.push(`fin-${indice}`);
    return { codigo: 0, salida: '' };
  };

  const r = await ejecutarParalelo({ spec: spec({ shards, comando: 'x {i}' }), ejecutar });

  assert.equal(r.ok, true);
  assert.equal(maximo, shards, 'todos deben estar en vuelo a la vez');
  const primerFin = orden.findIndex((e) => e.startsWith('fin-'));
  const inicios = orden.slice(0, primerFin).filter((e) => e.startsWith('inicio-')).length;
  assert.equal(inicios, shards, 'los N arrancan antes del primer fin');
});

test('paralelo: cortarAlPrimerFallo deja de esperar al resto', async () => {
  const liberados = [];
  const provisionar = async (indice) => ({ env: {}, id: indice });
  const liberar = async (datos) => {
    liberados.push(datos.id);
  };
  let resolverLentos;
  const lentos = new Promise((resolve) => {
    resolverLentos = resolve;
  });
  let completados = 0;
  const ejecutar = async (comando, { indice }) => {
    if (indice === 1) return { codigo: 1, salida: 'boom' };
    await lentos;
    completados += 1;
    return { codigo: 0, salida: 'ok' };
  };

  const r = await ejecutarParalelo({
    spec: spec({ shards: 3, comando: 'x {i}', recurso: 'db', cortarAlPrimerFallo: true }),
    ejecutar,
    provisionar,
    liberar,
  });

  assert.equal(r.ok, false);
  const porIndice = new Map(r.fragmentos.map((f) => [f.indice, f]));
  assert.equal(porIndice.get(1).codigo, 1);
  assert.equal(porIndice.get(2).cancelado, true);
  assert.equal(porIndice.get(3).cancelado, true);
  assert.equal(completados, 0, 'no debe esperar a los fragmentos lentos');
  assert.deepEqual([...liberados].sort(), [1], 'solo el fallido terminó de inmediato');

  // Al terminar los lentos, igual liberan su recurso (la liberación corre en su finally).
  resolverLentos();
  await new Promise((r2) => setImmediate(r2));
  await new Promise((r2) => setImmediate(r2));
  assert.equal(completados, 2);
  assert.deepEqual([...liberados].sort(), [1, 2, 3]);
});

test('paralelo: recurso declarado sin provisionar y falta de ejecutar son errores claros', async () => {
  await assert.rejects(
    ejecutarParalelo({
      spec: spec({ shards: 2, comando: 'x {i}', recurso: 'db' }),
      ejecutar: async () => ({ codigo: 0, salida: '' }),
    }),
    /falta la función 'provisionar'/,
  );
  await assert.rejects(
    ejecutarParalelo({ spec: spec({ shards: 2, comando: 'x {i}' }) }),
    /exige una función 'ejecutar'/,
  );
});

test('paralelo: un fragmento SOLO es OK con código entero 0 y sin corte', async () => {
  const casos = [
    { nombre: 'código 0', resultado: { codigo: 0, salida: 'ok' }, codigo: 0, ok: true, motivo: undefined },
    {
      nombre: 'null + timeout',
      resultado: { codigo: null, timeout: true, salida: 'colgado' },
      codigo: -1,
      ok: false,
      motivo: 'timeout',
    },
    {
      nombre: 'null sin timeout',
      resultado: { codigo: null, salida: 'sin código' },
      codigo: -1,
      ok: false,
      motivo: 'sin_codigo',
    },
    { nombre: 'código distinto de 0', resultado: { codigo: 3, salida: 'falló' }, codigo: 3, ok: false, motivo: undefined },
    { nombre: 'undefined', resultado: { salida: 'nada' }, codigo: -1, ok: false, motivo: 'sin_codigo' },
  ];

  for (const caso of casos) {
    const ejecutar = async () => caso.resultado;
    const r = await ejecutarParalelo({ spec: spec({ shards: 2, comando: 'x {i}' }), ejecutar });

    assert.equal(r.ok, caso.ok, `${caso.nombre}: ok debe ser ${caso.ok}`);
    for (const f of r.fragmentos) {
      assert.equal(f.codigo, caso.codigo, `${caso.nombre}: código`);
      assert.equal(f.motivo, caso.motivo, `${caso.nombre}: motivo`);
    }
    if (caso.motivo) {
      assert.match(r.salidaCombinada, /motivo /, `${caso.nombre}: el motivo debe verse en la salida combinada`);
      assert.match(
        r.salidaCombinada,
        new RegExp(caso.motivo.replace(':', '\\:')),
        `${caso.nombre}: el motivo concreto debe verse en la salida combinada`,
      );
    }
  }
});

test('paralelo: idle y señal de corte son fallos con su motivo', async () => {
  const casos = [
    { resultado: { codigo: null, idle: true }, motivo: 'idle' },
    { resultado: { codigo: null, signal: 'SIGKILL' }, motivo: 'senal:SIGKILL' },
    { resultado: { codigo: null, senal: 'SIGTERM' }, motivo: 'senal:SIGTERM' },
  ];

  for (const caso of casos) {
    const r = await ejecutarParalelo({
      spec: spec({ shards: 2, comando: 'x {i}' }),
      ejecutar: async () => caso.resultado,
    });
    assert.equal(r.ok, false);
    assert.equal(r.fragmentos[0].codigo, -1);
    assert.equal(r.fragmentos[0].motivo, caso.motivo);
    assert.match(r.salidaCombinada, new RegExp(caso.motivo.replace(':', '\\:')));
  }
});

test('paralelo: un fragmento colgado (null+timeout) hace fallar la compuerta', async () => {
  const ejecutar = async (comando, { indice }) =>
    indice === 2 ? { codigo: null, timeout: true, salida: 'se colgó' } : { codigo: 0, salida: 'ok' };

  const r = await ejecutarParalelo({ spec: spec({ shards: 3, comando: 'x {i}' }), ejecutar });

  assert.equal(r.ok, false, 'una compuerta colgada no puede aceptarse');
  assert.equal(r.fragmentos.find((f) => f.indice === 2).codigo, -1);
  assert.equal(r.fragmentos.find((f) => f.indice === 2).motivo, 'timeout');
  // El colgado va primero, como cualquier fallo.
  assert.ok(r.salidaCombinada.indexOf('[2/3]') < r.salidaCombinada.indexOf('[1/3]'));
});
