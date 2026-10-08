/**
 * Seguridad del entorno que reciben los trabajos: las credenciales de administración de los
 * recursos (que pueden crear y borrar CUALQUIER base) no deben llegar al agente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sinSecretosDeAdministracion } from '../src/core/gestor.js';
import { crearGestor, entornoFalso, montar } from './gestor-comun.js';

test('sinSecretosDeAdministracion quita ORQ_PG_ADMIN_URL y cualquier adminUrlEnv del perfil, sin mutar la entrada', () => {
  const entorno = { ORQ_PG_ADMIN_URL: 'postgres://a', OTRA_ADMIN_URL: 'postgres://b', PATH: '/bin', VARIABLE_COMUN: 'x' };
  const perfil = { resources: { db: { kind: 'postgres-db', adminUrlEnv: 'OTRA_ADMIN_URL' }, otro: {} } };
  const limpio = sinSecretosDeAdministracion(entorno, perfil);
  assert.deepEqual(limpio, { PATH: '/bin', VARIABLE_COMUN: 'x' });
  assert.equal(entorno.ORQ_PG_ADMIN_URL, 'postgres://a', 'no muta el entorno original');
  assert.deepEqual(sinSecretosDeAdministracion({ A: '1' }, undefined), { A: '1' }, 'tolera un perfil sin recursos');
});

test('un trabajo con recurso db recibe SU base pero jamás la URL de administración', async (t) => {
  const m = await montar(t, {
    perfil: {
      resources: {
        db: { kind: 'postgres-db', adminUrlEnv: 'OTRA_ADMIN_URL', name: 'orq_{job}_test', exportAs: 'TEST_DATABASE_URL' },
      },
    },
  });
  const volcado = path.join(m.base, 'volcado.json');
  const gestor = crearGestor(m.almacen, {
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR: 'src/a.js',
      ORQ_FAKE_VOLCADO: volcado,
      OTRA_ADMIN_URL: 'postgres://admin:S3cr3t-X@localhost:5432/postgres',
      ORQ_PG_ADMIN_URL: 'postgres://admin:S3cr3t-X@localhost:5432/postgres',
      VARIABLE_COMUN: 'se-hereda',
    }),
    home: m.home,
    ejecutarPsql: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  const trabajo = await gestor.enviar({ prompt: 'usa la db', cwd: m.repo, mode: 'safe', writes: ['src/**'], resources: ['db'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');

  const v = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  assert.equal(v.env.ORQ_PG_ADMIN_URL, null, 'ORQ_PG_ADMIN_URL no llega al trabajo');
  assert.equal(v.env.OTRA_ADMIN_URL, null, 'el adminUrlEnv declarado en el perfil no llega al trabajo');
  assert.match(v.env.TEST_DATABASE_URL, new RegExp(`/orq_${trabajo.id}_test$`), 'sí recibe la URL de SU base');
  assert.equal(v.env.VARIABLE_COMUN, 'se-hereda', 'el resto del entorno se hereda');
  await gestor.cerrar();
});

test('enviar rechaza al instante un writes que cae dentro de una ruta protegida del perfil', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { entorno: entornoFalso({}) });
  await assert.rejects(
    () => gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['secretos/nuevo/**'] }),
    /rutas protegidas.*secretos\/nuevo\/\*\*.*secretos\/\*\*/s,
  );
  // Un writes fuera de lo protegido sigue aceptándose.
  const ok = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  assert.ok(ok.id);
});
