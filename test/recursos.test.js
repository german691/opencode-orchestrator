import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { crearProveedor, ejecutarPsql } from '../src/core/recursos.js';

const DEF = {
  kind: 'postgres-db',
  adminUrlEnv: 'ORQ_PG_ADMIN_URL',
  template: 'compras_test',
  name: 'compras_{job}_test',
  exportAs: 'TEST_DATABASE_URL',
};

const ADMIN = 'postgres://usuario:secreto@localhost:5432/postgres';

/**
 * `ejecutarPsql` falso que registra cada llamada. `manejador(sql, args)` decide la
 * respuesta; por defecto responde éxito con salida vacía.
 */
function ejecutarPsqlFalso(manejador) {
  const llamadas = [];
  const ejecutar = async (args) => {
    llamadas.push(args);
    const sql = args[args.length - 1];
    const r = (manejador ? manejador(sql, args) : null) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { llamadas, ejecutar };
}

/** El SQL es el último argumento de `psql ... -c <sql>`. */
const sqlDe = (llamada) => llamada[llamada.length - 1];

const argsPsql = (url, sql) => ['-X', '-v', 'ON_ERROR_STOP=1', '-d', url, '-c', sql];
const argsSql = (sql) => argsPsql(ADMIN, sql);

test('recursos: kind desconocido es error', () => {
  assert.throws(() => crearProveedor({ ...DEF, kind: 'mysql' }), /kind de recurso no soportado/);
  assert.throws(() => crearProveedor(null), /definición del recurso/);
});

test('recursos: la definición debe contener {job} y los campos obligatorios', () => {
  assert.throws(() => crearProveedor({ ...DEF, name: 'compras_test' }), /'\{job\}'/);
  assert.throws(() => crearProveedor({ ...DEF, adminUrlEnv: '' }), /adminUrlEnv/);
  assert.throws(() => crearProveedor({ ...DEF, exportAs: '' }), /exportAs/);
  assert.throws(() => crearProveedor({ ...DEF, template: '' }), /template/);
});

test('recursos: crea la base sin plantilla y exporta la URL con el nombre nuevo', async () => {
  const fake = ejecutarPsqlFalso();
  const proveedor = crearProveedor(
    { ...DEF, template: undefined },
    { env: { ORQ_PG_ADMIN_URL: ADMIN }, ejecutarPsql: fake.ejecutar },
  );

  const { env, liberar } = await proveedor.provisionar({ id: 'abc123' });

  assert.equal(fake.llamadas.length, 2);
  assert.deepEqual(fake.llamadas[0], argsSql('DROP DATABASE IF EXISTS "compras_abc123_test" WITH (FORCE)'));
  assert.deepEqual(fake.llamadas[1], argsSql('CREATE DATABASE "compras_abc123_test"'));
  assert.deepEqual(env, {
    TEST_DATABASE_URL: 'postgres://usuario:secreto@localhost:5432/compras_abc123_test',
  });
  assert.equal(typeof liberar, 'function');

  await liberar();
  assert.deepEqual(
    sqlDe(fake.llamadas[2]),
    'DROP DATABASE IF EXISTS "compras_abc123_test" WITH (FORCE)',
  );
});

test('recursos: usa TEMPLATE solo si la plantilla declarada existe', async () => {
  const existe = ejecutarPsqlFalso((sql) => (sql.includes('pg_database') ? { stdout: '1\n' } : {}));
  const proveedorExiste = crearProveedor(DEF, {
    env: { ORQ_PG_ADMIN_URL: ADMIN },
    ejecutarPsql: existe.ejecutar,
  });
  await proveedorExiste.provisionar({ id: 'abc' });

  assert.equal(existe.llamadas.length, 3);
  assert.deepEqual(
    sqlDe(existe.llamadas[0]),
    "SELECT 1 FROM pg_database WHERE datname = 'compras_test'",
  );
  assert.deepEqual(sqlDe(existe.llamadas[1]), 'DROP DATABASE IF EXISTS "compras_abc_test" WITH (FORCE)');
  assert.deepEqual(sqlDe(existe.llamadas[2]), 'CREATE DATABASE "compras_abc_test" TEMPLATE "compras_test"');

  const noExiste = ejecutarPsqlFalso((sql) => (sql.includes('pg_database') ? { stdout: '\n' } : {}));
  const proveedorNoExiste = crearProveedor(DEF, {
    env: { ORQ_PG_ADMIN_URL: ADMIN },
    ejecutarPsql: noExiste.ejecutar,
  });
  await proveedorNoExiste.provisionar({ id: 'abc' });
  assert.equal(sqlDe(noExiste.llamadas[2]), 'CREATE DATABASE "compras_abc_test"');
});

test('recursos: rechaza nombres inválidos o sin _test SIN invocar psql', async () => {
  const fake = ejecutarPsqlFalso();
  const proveedor = crearProveedor(DEF, {
    env: { ORQ_PG_ADMIN_URL: ADMIN },
    ejecutarPsql: fake.ejecutar,
  });

  // Mayúsculas/espacios -> nombre inválido.
  await assert.rejects(proveedor.provisionar({ id: 'ABC DEF' }), /Nombre de base rechazado/);
  // Hiphen: no permitido por el patrón (solo [a-z0-9_]).
  await assert.rejects(proveedor.provisionar({ id: 'abc-1' }), /Nombre de base rechazado/);
  // Sin id no hay nombre.
  await assert.rejects(proveedor.provisionar({}), /no tiene id/);

  // Plantilla que no termina en _test.
  const sinTest = crearProveedor(
    { ...DEF, name: 'compras_{job}' },
    { env: { ORQ_PG_ADMIN_URL: ADMIN }, ejecutarPsql: fake.ejecutar },
  );
  await assert.rejects(sinTest.provisionar({ id: 'abc' }), /Nombre de base rechazado/);

  assert.equal(fake.llamadas.length, 0, 'no debe invocarse psql ante un nombre inválido');
});

test('recursos: falta la variable de administración -> error claro sin la URL', async () => {
  const fake = ejecutarPsqlFalso();
  const proveedor = crearProveedor(DEF, { env: {}, ejecutarPsql: fake.ejecutar });

  await assert.rejects(proveedor.provisionar({ id: 'abc' }), (error) => {
    assert.match(error.message, /Falta la variable de entorno ORQ_PG_ADMIN_URL/);
    assert.equal(error.message.includes('postgres://'), false);
    return true;
  });
  assert.equal(fake.llamadas.length, 0);
});

test('recursos: la URL de administración no aparece en los mensajes de error de psql', async () => {
  const admin = 'postgres://usuario:SUPERSECRETO@db.interno:5432/postgres';
  const fake = ejecutarPsqlFalso((sql) =>
    sql.startsWith('CREATE DATABASE') ? { code: 1, stderr: 'ERROR: no se pudo crear' } : {},
  );
  const proveedor = crearProveedor(
    { ...DEF, template: undefined },
    { env: { ORQ_PG_ADMIN_URL: admin }, ejecutarPsql: fake.ejecutar },
  );

  await assert.rejects(proveedor.provisionar({ id: 'abc' }), (error) => {
    assert.equal(error.message.includes('SUPERSECRETO'), false);
    assert.equal(error.message.includes('postgres://'), false);
    assert.match(error.message, /No se pudo crear la base 'compras_abc_test'/);
    return true;
  });
});

test('recursos: liberar es idempotente (DROP IF EXISTS repetible)', async () => {
  const fake = ejecutarPsqlFalso();
  const proveedor = crearProveedor(
    { ...DEF, template: undefined },
    { env: { ORQ_PG_ADMIN_URL: ADMIN }, ejecutarPsql: fake.ejecutar },
  );
  const { liberar } = await proveedor.provisionar({ id: 'abc' });

  const antes = fake.llamadas.length;
  await liberar();
  await liberar();

  const drops = fake.llamadas.slice(antes).map(sqlDe);
  assert.deepEqual(drops, [
    'DROP DATABASE IF EXISTS "compras_abc_test" WITH (FORCE)',
    'DROP DATABASE IF EXISTS "compras_abc_test" WITH (FORCE)',
  ]);
});

test('recursos: si la creación falla se intenta borrar el resto y se propaga el error', async () => {
  const fake = ejecutarPsqlFalso((sql) =>
    sql.startsWith('CREATE DATABASE') ? { code: 1, stderr: 'ERROR: boom' } : {},
  );
  const proveedor = crearProveedor(
    { ...DEF, template: undefined },
    { env: { ORQ_PG_ADMIN_URL: ADMIN }, ejecutarPsql: fake.ejecutar },
  );

  await assert.rejects(proveedor.provisionar({ id: 'abc' }), /No se pudo crear la base 'compras_abc_test'/);

  const sqls = fake.llamadas.map(sqlDe);
  assert.deepEqual(sqls, [
    'DROP DATABASE IF EXISTS "compras_abc_test" WITH (FORCE)',
    'CREATE DATABASE "compras_abc_test"',
    'DROP DATABASE IF EXISTS "compras_abc_test" WITH (FORCE)',
  ]);
});

/** ¿Hay un `psql` usable en el PATH? */
function hayPsql() {
  const resultado = spawnSync('psql', ['--version'], { encoding: 'utf8', windowsHide: true });
  return resultado.status === 0;
}

test('recursos: integración real con Postgres (se saltea sin psql o sin ORQ_PG_ADMIN_URL)', async (t) => {
  const adminUrl = process.env.ORQ_PG_ADMIN_URL;
  if (!adminUrl) return t.skip('falta ORQ_PG_ADMIN_URL');
  if (!hayPsql()) return t.skip('psql no disponible en el PATH');

  const id = `orq${Date.now().toString(36)}`;
  const nombre = `orq_${id}_test`;
  const consulta = `SELECT 1 FROM pg_database WHERE datname = '${nombre}'`;
  const definicion = {
    kind: 'postgres-db',
    adminUrlEnv: 'ORQ_PG_ADMIN_URL',
    name: 'orq_{job}_test',
    exportAs: 'TEST_DATABASE_URL',
  };

  const proveedor = crearProveedor(definicion, { env: process.env });
  /** @type {null | { env: Record<string,string>, liberar: () => Promise<void> }} */
  let recurso = null;
  try {
    recurso = await proveedor.provisionar({ id });
    assert.equal(new URL(recurso.env.TEST_DATABASE_URL).pathname, `/${nombre}`);

    const antes = await ejecutarPsql(argsPsql(adminUrl, consulta));
    assert.equal(/(^|\D)1(\D|$)/.test(antes.stdout), true, `la base ${nombre} debería existir`);

    await recurso.liberar();
    recurso = null;

    const despues = await ejecutarPsql(argsPsql(adminUrl, consulta));
    assert.equal(/(^|\D)1(\D|$)/.test(despues.stdout), false, `la base ${nombre} debería haber desaparecido`);
  } finally {
    if (recurso) {
      try {
        await recurso.liberar();
      } catch {
        /* best-effort */
      }
    }
  }
});
