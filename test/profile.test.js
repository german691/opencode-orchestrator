import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cargarPerfil,
  validarPerfil,
  perfilPorDefecto,
  resolverRaizWorktrees,
  ErrorDePerfil,
} from '../src/core/profile.js';

const PERFIL_VALIDO = {
  version: 1,
  name: 'sistema',
  baseBranch: 'dev',
  integrationBranch: 'staging',
  concurrency: 3,
  protected: ['backend/prisma/migrations/**', '**/.env', '.opencode-orchestrator.json'],
  worktrees: { root: '~/work/{name}', link: ['backend/node_modules'], setup: ['npm ci'] },
  env: { NODE_ENV: 'test' },
  resources: {
    db: {
      kind: 'postgres-db',
      adminUrlEnv: 'ORQ_PG_ADMIN_URL',
      template: 'compras_test',
      name: 'compras_{job}_test',
      exportAs: 'TEST_DATABASE_URL',
    },
  },
  accept: { default: 'cd backend && npm run lint' },
};

test('perfilPorDefecto devuelve valores seguros', () => {
  const perfil = perfilPorDefecto('mi-repo');
  assert.equal(perfil.version, 1);
  assert.equal(perfil.name, 'mi-repo');
  assert.equal(perfil.baseBranch, 'main');
  assert.equal(perfil.integrationBranch, 'staging');
  assert.equal(perfil.concurrency, 3);
  assert.deepEqual(perfil.protected, ['**/.env', '.opencode-orchestrator.json']);
  assert.equal(perfil.worktrees.root, '~/work/{name}');
  assert.deepEqual(perfil.resources, {});
});

test('perfilPorDefecto sin nombre usa un fallback', () => {
  assert.equal(perfilPorDefecto().name, 'repo');
  assert.equal(perfilPorDefecto('   ').name, 'repo');
});

test('validarPerfil acepta un perfil completo y aplica defaults a los ausentes', () => {
  const perfil = validarPerfil(PERFIL_VALIDO);
  assert.equal(perfil.name, 'sistema');
  assert.equal(perfil.baseBranch, 'dev');
  assert.equal(perfil.resources.db.name, 'compras_{job}_test');

  const minimo = validarPerfil({ version: 1, name: 'x' });
  assert.equal(minimo.baseBranch, 'main');
  assert.equal(minimo.integrationBranch, 'staging');
  assert.equal(minimo.concurrency, 3);
  assert.deepEqual(minimo.protected, []);
  assert.equal(minimo.worktrees.root, '~/work/{name}');
});

test('validarPerfil exige version 1 y name no vacío', () => {
  assert.throws(() => validarPerfil({ name: 'x' }), /version: debe ser 1/);
  assert.throws(() => validarPerfil({ version: 2, name: 'x' }), /version: debe ser 1/);
  assert.throws(() => validarPerfil({ version: 1, name: '' }), /name: debe ser un texto no vacío/);
  assert.throws(() => validarPerfil({ version: 1 }), /name: debe ser un texto no vacío/);
});

test('validarPerfil rechaza la raíz que no es objeto', () => {
  assert.throws(() => validarPerfil(null), ErrorDePerfil);
  assert.throws(() => validarPerfil([]), ErrorDePerfil);
  assert.throws(() => validarPerfil('x'), ErrorDePerfil);
});

test('validarPerfil rechaza campos desconocidos pero permite $schema', () => {
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', protectd: [] }),
    /protectd: campo desconocido/,
  );
  const conSchema = validarPerfil({ $schema: 'https://x/schema.json', version: 1, name: 'x' });
  assert.equal(conSchema.name, 'x');
});

test('validarPerfil valida ramas git', () => {
  assert.throws(() => validarPerfil({ version: 1, name: 'x', baseBranch: 'a b' }), /espacios/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', baseBranch: 'a..b' }), /'\.\.'/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', baseBranch: 'rama/' }), /terminar en '\//);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', baseBranch: 'x.lock' }), /'\.lock'/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', integrationBranch: '-x' }), /empezar con '-'/);
});

test('validarPerfil valida concurrency entero 1..8', () => {
  assert.throws(() => validarPerfil({ version: 1, name: 'x', concurrency: 0 }), /entre 1 y 8/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', concurrency: 9 }), /entre 1 y 8/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', concurrency: 1.5 }), /entre 1 y 8/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', concurrency: '3' }), /entre 1 y 8/);
  assert.equal(validarPerfil({ version: 1, name: 'x', concurrency: 8 }).concurrency, 8);
});

test('validarPerfil valida protected como array de patrones glob', () => {
  assert.throws(() => validarPerfil({ version: 1, name: 'x', protected: '**' }), /array de patrones/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', protected: ['/abs'] }), /patrón inválido/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', protected: ['a/../b'] }), /patrón inválido/);
  assert.throws(() => validarPerfil({ version: 1, name: 'x', protected: [''] }), /texto no vacío/);
});

test('validarPerfil valida worktrees', () => {
  assert.throws(() => validarPerfil({ version: 1, name: 'x', worktrees: [] }), /worktrees: debe ser un objeto/);
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', worktrees: { ruta: 'a' } }),
    /worktrees.ruta: campo desconocido/,
  );
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', worktrees: { root: '' } }),
    /worktrees.root/,
  );
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', worktrees: { link: ['../fuera'] } }),
    /no puede contener '\.\.'/,
  );
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', worktrees: { link: ['/abs'] } }),
    /ruta relativa/,
  );
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', worktrees: { setup: [123] } }),
    /worktrees.setup\[0\]/,
  );
});

test('validarPerfil valida env como string->string con claves válidas', () => {
  assert.throws(() => validarPerfil({ version: 1, name: 'x', env: [] }), /env: debe ser un objeto/);
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', env: { 'A=B': 'v' } }),
    /env\.A=B: nombre de variable de entorno inválido/,
  );
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', env: { '': 'v' } }),
    /nombre de variable de entorno inválido/,
  );
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', env: { OK: 1 } }),
    /env\.OK: el valor debe ser un texto/,
  );
});

test('validarPerfil valida recursos postgres-db', () => {
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', resources: { db: { kind: 'mysql' } } }),
    /resources\.db\.kind: kind inválido/,
  );
  assert.throws(
    () =>
      validarPerfil({
        version: 1,
        name: 'x',
        resources: {
          db: { kind: 'postgres-db', adminUrlEnv: 'A', template: 't', name: 'db_{job}_prod', exportAs: 'E' },
        },
      }),
    /resources\.db\.name: debe terminar en _test/,
  );
  assert.throws(
    () =>
      validarPerfil({
        version: 1,
        name: 'x',
        resources: {
          db: { kind: 'postgres-db', adminUrlEnv: 'A', template: 't', name: 'db_test', exportAs: 'E' },
        },
      }),
    /resources\.db\.name: debe contener '\{job\}'/,
  );
  assert.throws(
    () =>
      validarPerfil({
        version: 1,
        name: 'x',
        resources: {
          db: { kind: 'postgres-db', adminUrlEnv: 'A', template: 't', name: 'x_{job}_test', exportAs: '1bad' },
        },
      }),
    /resources\.db\.exportAs: nombre de variable de entorno inválido/,
  );
  assert.throws(
    () =>
      validarPerfil({
        version: 1,
        name: 'x',
        resources: {
          db: { kind: 'postgres-db', adminUrlEnv: 'A', template: 't', name: 'x_{job}_test', exportAs: 'E', extra: 1 },
        },
      }),
    /resources\.db\.extra: campo desconocido/,
  );
});

test('validarPerfil valida accept string->string', () => {
  assert.throws(() => validarPerfil({ version: 1, name: 'x', accept: [] }), /accept: debe ser un objeto/);
  assert.throws(
    () => validarPerfil({ version: 1, name: 'x', accept: { default: 1 } }),
    /accept\.default: debe ser un texto/,
  );
});

test('validarPerfil acumula todos los errores con la ruta del campo', () => {
  try {
    validarPerfil({ version: 2, name: '', concurrency: 99, typo: true });
    assert.fail('debía lanzar');
  } catch (error) {
    assert.ok(error instanceof ErrorDePerfil);
    assert.ok(error.errores.length >= 4);
    assert.ok(error.errores.some((e) => e === 'version: debe ser 1'));
    assert.ok(error.errores.some((e) => e === 'name: debe ser un texto no vacío'));
    assert.ok(error.errores.some((e) => e === 'concurrency: debe ser un entero entre 1 y 8'));
    assert.ok(error.errores.some((e) => e === 'typo: campo desconocido'));
  }
});

test('cargarPerfil parsea y valida JSON', () => {
  const perfil = cargarPerfil(JSON.stringify(PERFIL_VALIDO));
  assert.equal(perfil.name, 'sistema');
  assert.equal(perfil.concurrency, 3);
});

test('cargarPerfil falla con JSON inválido', () => {
  try {
    cargarPerfil('{ no json');
    assert.fail('debía lanzar');
  } catch (error) {
    assert.ok(error instanceof ErrorDePerfil);
    assert.match(error.errores[0], /JSON inválido/);
  }
});

test('cargarPerfil completa name desde opciones.nombreRepo', () => {
  const perfil = cargarPerfil('{"version":1}', { nombreRepo: 'auto' });
  assert.equal(perfil.name, 'auto');
});

test('resolverRaizWorktrees expande ~ y {name}', () => {
  const perfil = { name: 'sistema', worktrees: { root: '~/work/{name}' } };
  assert.equal(resolverRaizWorktrees(perfil, '/home/u'), '/home/u/work/sistema');
});

test('resolverRaizWorktrees maneja ~ solo y raíces sin tilde', () => {
  assert.equal(resolverRaizWorktrees({ name: 'x', worktrees: { root: '~' } }, '/home/u'), '/home/u');
  assert.equal(
    resolverRaizWorktrees({ name: 'x', worktrees: { root: '/tmp/wt/{name}' } }, '/home/u'),
    '/tmp/wt/x',
  );
});

test('resolverRaizWorktrees usa defaults si falta la raíz', () => {
  assert.equal(resolverRaizWorktrees({ name: 'x' }, '/home/u'), '/home/u/work/x');
});

test('validarPerfil: el template del recurso postgres-db es OPCIONAL pero si se indica no puede estar vacío', () => {
  const base = { version: 1, name: 'x' };
  const recurso = { kind: 'postgres-db', adminUrlEnv: 'ADMIN', name: 'x_{job}_test', exportAs: 'TEST_DATABASE_URL' };
  assert.doesNotThrow(() => validarPerfil({ ...base, resources: { db: recurso } }), 'sin template es válido');
  assert.doesNotThrow(() => validarPerfil({ ...base, resources: { db: { ...recurso, template: 'plantilla_test' } } }));
  for (const malo of ['', '   ', 5, null]) {
    assert.throws(
      () => validarPerfil({ ...base, resources: { db: { ...recurso, template: malo } } }),
      (error) => error.errores.some((e) => e.includes('resources.db.template')),
      `template ${JSON.stringify(malo)} debe rechazarse`,
    );
  }
});

test('validarPerfil: name es un segmento de ruta seguro (no puede escapar de ~/work/{name})', () => {
  for (const malo of ['../../etc', 'a/b', 'a\\b', '.oculto', '-guion', 'con espacio', 'x'.repeat(65), '..']) {
    assert.throws(
      () => validarPerfil({ version: 1, name: malo }),
      (error) => error.errores.some((e) => e.startsWith('name:')),
      `name ${JSON.stringify(malo)} debe rechazarse`,
    );
  }
  for (const bueno of ['sistema', 'mi-repo_2.0', 'A1', '_x']) {
    assert.doesNotThrow(() => validarPerfil({ version: 1, name: bueno }), `name ${bueno} es válido`);
  }
});

test('validarPerfil: worktrees.root debe ser absoluta o con ~ y sin ".."', () => {
  const base = { version: 1, name: 'x' };
  for (const malo of ['relativa/dir', './x', 'work', '/tmp/../etc', '~/a/../../b']) {
    assert.throws(
      () => validarPerfil({ ...base, worktrees: { root: malo } }),
      (error) => error.errores.some((e) => e.startsWith('worktrees.root:')),
      `root ${JSON.stringify(malo)} debe rechazarse`,
    );
  }
  for (const bueno of ['/var/work/{name}', '~/work/{name}', '~', 'C:/work']) {
    assert.doesNotThrow(() => validarPerfil({ ...base, worktrees: { root: bueno } }), `root ${bueno} es válido`);
  }
});

test('validarPerfil: las ramas rechazan los mismos caracteres que el resto del código', () => {
  for (const malo of ['a:b', 'a~1', 'a^', 'a?', 'a*', 'a[0]', 'a\\b', '/abs']) {
    assert.throws(
      () => validarPerfil({ version: 1, name: 'x', baseBranch: malo }),
      (error) => error.errores.some((e) => e.startsWith('baseBranch:')),
      `rama ${JSON.stringify(malo)} debe rechazarse`,
    );
  }
  assert.doesNotThrow(() => validarPerfil({ version: 1, name: 'x', baseBranch: 'feature/ok-1', integrationBranch: 'staging' }));
});

test('validarPerfil: jobBase, promptPrefix y timeoutMs (valida y aplica defaults)', () => {
  const base = { version: 1, name: 'sistema' };
  const porDefecto = validarPerfil(base);
  assert.deepEqual([porDefecto.jobBase, porDefecto.promptPrefix, porDefecto.timeoutMs], ['base', '', null]);
  const ok = validarPerfil({ ...base, jobBase: 'integracion', promptPrefix: 'Convenciones', timeoutMs: 3_600_000 });
  assert.deepEqual([ok.jobBase, ok.promptPrefix, ok.timeoutMs], ['integracion', 'Convenciones', 3_600_000]);
  assert.throws(() => validarPerfil({ ...base, jobBase: 'otra' }), /jobBase/);
  assert.throws(() => validarPerfil({ ...base, promptPrefix: 5 }), /promptPrefix/);
  assert.throws(() => validarPerfil({ ...base, timeoutMs: 10 }), /timeoutMs/);
});

test('validarPerfil: worktrees.linkConCopia se valida (formato, rutas relativas, sin repetir en link)', () => {
  const base = { version: 1, name: 'sistema' };
  const ok = validarPerfil({ ...base, worktrees: { linkConCopia: [{ dir: 'backend/node_modules', copiar: ['.prisma', '@prisma/client'] }] } });
  assert.deepEqual(ok.worktrees.linkConCopia, [{ dir: 'backend/node_modules', copiar: ['.prisma', '@prisma/client'] }]);
  assert.deepEqual(validarPerfil(base).worktrees.linkConCopia, []);
  assert.throws(() => validarPerfil({ ...base, worktrees: { linkConCopia: 'x' } }), /linkConCopia/);
  assert.throws(() => validarPerfil({ ...base, worktrees: { linkConCopia: [{ dir: 'a', copiar: [] }] } }), /copiar/);
  assert.throws(() => validarPerfil({ ...base, worktrees: { linkConCopia: [{ dir: '../a', copiar: ['x'] }] } }), /relativas/);
  assert.throws(
    () => validarPerfil({ ...base, worktrees: { link: ['a/node_modules'], linkConCopia: [{ dir: 'a/node_modules', copiar: ['x'] }] } }),
    /también en worktrees\.link/,
  );
});

test('validarPerfil: aceptacionTimeoutMs se valida y por defecto es null', () => {
  const base = { version: 1, name: 'sistema' };
  assert.equal(validarPerfil(base).aceptacionTimeoutMs, null);
  assert.equal(validarPerfil({ ...base, aceptacionTimeoutMs: 1_800_000 }).aceptacionTimeoutMs, 1_800_000);
  assert.throws(() => validarPerfil({ ...base, aceptacionTimeoutMs: 5 }), /aceptacionTimeoutMs/);
});

test('validarPerfil: sinProgresoMs acepta 0 (sin límite) o 1 min–6 h y por defecto es null', () => {
  const base = { version: 1, name: 'sistema' };
  assert.equal(validarPerfil(base).sinProgresoMs, null);
  assert.equal(validarPerfil({ ...base, sinProgresoMs: 0 }).sinProgresoMs, 0);
  assert.equal(validarPerfil({ ...base, sinProgresoMs: 600_000 }).sinProgresoMs, 600_000);
  assert.throws(() => validarPerfil({ ...base, sinProgresoMs: 30_000 }), /sinProgresoMs/);
  assert.throws(() => validarPerfil({ ...base, sinProgresoMs: 'x' }), /sinProgresoMs/);
});

test('validarPerfil: reanudacion opcional usa configReanudacion y por defecto es { habilitado: true, maxRelanzamientos: 1 }', () => {
  const base = { version: 1, name: 'sistema' };
  assert.deepEqual(validarPerfil(base).reanudacion, { habilitado: true, maxRelanzamientos: 1 });
  assert.deepEqual(perfilPorDefecto('x').reanudacion, { habilitado: true, maxRelanzamientos: 1 });
  assert.deepEqual(validarPerfil({ ...base, reanudacion: { habilitado: false } }).reanudacion, { habilitado: false, maxRelanzamientos: 1 });
  assert.deepEqual(validarPerfil({ ...base, reanudacion: { maxRelanzamientos: 2 } }).reanudacion, { habilitado: true, maxRelanzamientos: 2 });
});

test('validarPerfil: reanudacion inválida se acumula con la ruta del campo', () => {
  const base = { version: 1, name: 'sistema' };
  assert.throws(
    () => validarPerfil({ ...base, reanudacion: { habilitado: 'si' } }),
    (error) => error instanceof ErrorDePerfil && error.errores.some((e) => /reanudacion\.habilitado/.test(e)),
  );
  assert.throws(
    () => validarPerfil({ ...base, reanudacion: { maxRelanzamientos: 9 } }),
    (error) => error.errores.some((e) => /reanudacion\.maxRelanzamientos/.test(e)),
  );
  assert.throws(() => validarPerfil({ ...base, reanudacion: [] }), /reanudacion/);
});

test('validarPerfil: mutaciones opcional con defaults y errores claros', () => {
  const base = { version: 1, name: 'sistema' };
  assert.deepEqual(validarPerfil(base).mutaciones, { habilitado: true, exigirTodas: false, timeoutMs: 300000 });
  assert.deepEqual(
    validarPerfil({ ...base, mutaciones: { exigirTodas: true, timeoutMs: 1000 } }).mutaciones,
    { habilitado: true, exigirTodas: true, timeoutMs: 1000 },
  );
  assert.throws(() => validarPerfil({ ...base, mutaciones: [] }), /mutaciones: debe ser un objeto/);
  assert.throws(() => validarPerfil({ ...base, mutaciones: { habilitado: 'si' } }), /mutaciones\.habilitado/);
  assert.throws(() => validarPerfil({ ...base, mutaciones: { exigirTodas: 1 } }), /mutaciones\.exigirTodas/);
  assert.throws(() => validarPerfil({ ...base, mutaciones: { timeoutMs: 0 } }), /mutaciones\.timeoutMs/);
  assert.throws(() => validarPerfil({ ...base, mutaciones: { raro: 1 } }), /mutaciones\.raro: campo desconocido/);
});

test('validarPerfil: accept admite una compuerta paralela y valida su recurso', () => {
  const base = { version: 1, name: 'sistema' };
  const recurso = { kind: 'postgres-db', adminUrlEnv: 'ADMIN', name: 'db_{job}_{shard}_test', exportAs: 'TEST_DATABASE_URL' };
  const perfil = validarPerfil({
    ...base,
    resources: { db: recurso },
    accept: { fragmentos: { paralelo: { shards: 2, comando: 'vitest --shard={i}/{n}', recurso: 'db' } } },
  });
  assert.equal(perfil.accept.fragmentos.paralelo.shards, 2);
  // Sin recurso también es válido (solo fragmenta el comando).
  assert.doesNotThrow(() => validarPerfil({ ...base, accept: { partido: { paralelo: { shards: 3, comando: 'x {i}' } } } }));
  // shards fuera de rango y comando sin '{i}': delegan en normalizarParalelo.
  assert.throws(() => validarPerfil({ ...base, accept: { p: { paralelo: { shards: 1, comando: 'x {i}' } } } }), /accept\.p: .*shards/);
  assert.throws(() => validarPerfil({ ...base, accept: { p: { paralelo: { shards: 2, comando: 'sin indice' } } } }), /accept\.p: .*'\{i\}'/);
  assert.throws(() => validarPerfil({ ...base, accept: { p: 42 } }), /accept\.p: debe ser un texto o un objeto/);
  // Recurso inexistente, de kind equivocado o sin '{shard}'.
  assert.throws(
    () => validarPerfil({ ...base, accept: { p: { paralelo: { shards: 2, comando: 'x {i}', recurso: 'nope' } } } }),
    /accept\.p\.paralelo\.recurso: el recurso 'nope' no está declarado/,
  );
  assert.throws(
    () => validarPerfil({ ...base, resources: { db: { kind: 'mysql' } }, accept: { p: { paralelo: { shards: 2, comando: 'x {i}', recurso: 'db' } } } }),
    /accept\.p\.paralelo\.recurso: 'db' debe ser de kind postgres-db/,
  );
  assert.throws(
    () => validarPerfil({ ...base, resources: { db: { ...recurso, name: 'db_{job}_test' } }, accept: { p: { paralelo: { shards: 2, comando: 'x {i}', recurso: 'db' } } } }),
    /accept\.p\.paralelo\.recurso: el name de 'db' debe contener '\{shard\}'/,
  );
});

test('validarPerfil: pizarron opcional con defaults y errores claros', () => {
  const base = { version: 1, name: 'sistema' };
  assert.deepEqual(validarPerfil(base).pizarron, { habilitado: false, maxEntradasPorTrabajo: 30 });
  assert.deepEqual(perfilPorDefecto('x').pizarron, { habilitado: false, maxEntradasPorTrabajo: 30 });
  assert.deepEqual(
    validarPerfil({ ...base, pizarron: { habilitado: true, maxEntradasPorTrabajo: 5 } }).pizarron,
    { habilitado: true, maxEntradasPorTrabajo: 5 },
  );
  assert.throws(() => validarPerfil({ ...base, pizarron: [] }), /pizarron: debe ser un objeto/);
  assert.throws(() => validarPerfil({ ...base, pizarron: { habilitado: 'si' } }), /pizarron\.habilitado/);
  assert.throws(() => validarPerfil({ ...base, pizarron: { maxEntradasPorTrabajo: 0 } }), /pizarron\.maxEntradasPorTrabajo/);
  assert.throws(() => validarPerfil({ ...base, pizarron: { raro: 1 } }), /pizarron\.raro: campo desconocido/);
});

test('validarPerfil: recetas opcionales se validan y se copian', () => {
  const base = { version: 1, name: 'sistema' };
  assert.deepEqual(validarPerfil(base).recetas, {});
  assert.deepEqual(perfilPorDefecto('x').recetas, {});
  const perfil = validarPerfil({
    ...base,
    recetas: {
      tests: { descripcion: 'tests de un módulo', prompt: 'Escribí tests de {modulo}', writes: ['{modulo}/**'], mode: 'safe' },
    },
  });
  assert.equal(perfil.recetas.tests.prompt, 'Escribí tests de {modulo}');
  assert.deepEqual(perfil.recetas.tests.writes, ['{modulo}/**']);

  assert.throws(() => validarPerfil({ ...base, recetas: [] }), /recetas: debe ser un objeto/);
  assert.throws(() => validarPerfil({ ...base, recetas: { r: [] } }), /recetas\.r: debe ser un objeto/);
  assert.throws(() => validarPerfil({ ...base, recetas: { r: { prompt: 'x', pompt: 'y' } } }), /recetas\.r\.pompt: campo desconocido/);
  assert.throws(() => validarPerfil({ ...base, recetas: { r: {} } }), /recetas\.r\.prompt: debe ser un texto no vacío/);
  assert.throws(() => validarPerfil({ ...base, recetas: { r: { prompt: 'x', mode: 'raro' } } }), /recetas\.r\.mode/);
  assert.throws(() => validarPerfil({ ...base, recetas: { r: { prompt: 'x', writes: 'src/**' } } }), /recetas\.r\.writes/);
  assert.throws(() => validarPerfil({ ...base, recetas: { r: { prompt: 'x', writes: ['/abs'] } } }), /recetas\.r\.writes\[0\]/);
  assert.throws(() => validarPerfil({ ...base, recetas: { r: { prompt: 'x', solo_aceptacion: 'si' } } }), /recetas\.r\.solo_aceptacion/);
});

test('validarPerfil: autoIntegrar opcional con defaults y errores claros', () => {
  const base = { version: 1, name: 'sistema' };
  assert.deepEqual(validarPerfil(base).autoIntegrar, { habilitado: false, requiereRevisor: false, soloSinAdvertencias: true });
  assert.deepEqual(perfilPorDefecto('x').autoIntegrar, { habilitado: false, requiereRevisor: false, soloSinAdvertencias: true });
  assert.deepEqual(
    validarPerfil({ ...base, autoIntegrar: { habilitado: true, requiereRevisor: true, soloSinAdvertencias: false } }).autoIntegrar,
    { habilitado: true, requiereRevisor: true, soloSinAdvertencias: false },
  );
  assert.throws(() => validarPerfil({ ...base, autoIntegrar: [] }), /autoIntegrar: debe ser un objeto/);
  assert.throws(() => validarPerfil({ ...base, autoIntegrar: { habilitado: 'si' } }), /autoIntegrar\.habilitado/);
  assert.throws(() => validarPerfil({ ...base, autoIntegrar: { raro: true } }), /autoIntegrar\.raro: campo desconocido/);
});

test('validarPerfil: esperarIntegracion booleano, por defecto false', () => {
  const base = { version: 1, name: 'sistema' };
  assert.equal(validarPerfil(base).esperarIntegracion, false);
  assert.equal(validarPerfil({ ...base, esperarIntegracion: true }).esperarIntegracion, true);
  assert.throws(() => validarPerfil({ ...base, esperarIntegracion: 'si' }), /esperarIntegracion/);
  assert.equal(perfilPorDefecto('x').esperarIntegracion, false);
});

test('validarPerfil: revisor se delega en configRevisor (default deshabilitado)', () => {
  const base = { version: 1, name: 'sistema' };
  assert.equal(validarPerfil(base).revisor.habilitado, false);
  assert.equal(perfilPorDefecto('x').revisor.habilitado, false);
  const activo = validarPerfil({ ...base, revisor: { habilitado: true, reglas: ['a'] } }).revisor;
  assert.equal(activo.habilitado, true);
  assert.deepEqual(activo.reglas, ['a']);
  assert.throws(
    () => validarPerfil({ ...base, revisor: { model: 'typo' } }),
    (error) => error.errores.some((e) => /revisor\.model: campo desconocido/.test(e)),
  );
});

test('validarPerfil: logs opcional con tope por defecto de 20 MB y rango 1 MB–200 MB', () => {
  const base = { version: 1, name: 'sistema' };
  const porDefecto = validarPerfil(base).logs;
  assert.equal(porDefecto.maxBytes, 20 * 1024 * 1024);
  assert.equal(perfilPorDefecto('x').logs.maxBytes, 20 * 1024 * 1024);
  assert.equal(validarPerfil({ ...base, logs: { maxBytes: 1024 * 1024 } }).logs.maxBytes, 1024 * 1024);
  assert.equal(validarPerfil({ ...base, logs: { maxBytes: 200 * 1024 * 1024 } }).logs.maxBytes, 200 * 1024 * 1024);
  assert.throws(() => validarPerfil({ ...base, logs: [] }), /logs: debe ser un objeto/);
  assert.throws(() => validarPerfil({ ...base, logs: { maxBytes: 1000 } }), /logs\.maxBytes/);
  assert.throws(() => validarPerfil({ ...base, logs: { maxBytes: 'x' } }), /logs\.maxBytes/);
  assert.throws(() => validarPerfil({ ...base, logs: { otro: 1 } }), /logs\.otro: campo desconocido/);
});

test('validarPerfil: retencion opcional con defaults 30 días / 500 en memoria', () => {
  const base = { version: 1, name: 'sistema' };
  assert.deepEqual(validarPerfil(base).retencion, { dias: 30, maxEnMemoria: 500 });
  assert.deepEqual(perfilPorDefecto('x').retencion, { dias: 30, maxEnMemoria: 500 });
  assert.deepEqual(validarPerfil({ ...base, retencion: { dias: 7 } }).retencion, { dias: 7, maxEnMemoria: 500 });
  assert.deepEqual(validarPerfil({ ...base, retencion: { maxEnMemoria: 10 } }).retencion, { dias: 30, maxEnMemoria: 10 });
  assert.throws(() => validarPerfil({ ...base, retencion: [] }), /retencion: debe ser un objeto/);
  assert.throws(() => validarPerfil({ ...base, retencion: { dias: 0 } }), /retencion\.dias/);
  assert.throws(() => validarPerfil({ ...base, retencion: { maxEnMemoria: 0 } }), /retencion\.maxEnMemoria/);
  assert.throws(() => validarPerfil({ ...base, retencion: { raro: 1 } }), /retencion\.raro: campo desconocido/);
});

test('validarPerfil: `autor` opcional se normaliza y por defecto es null', () => {
  assert.equal(validarPerfil({ version: 1, name: 'x' }).autor, null);
  assert.equal(perfilPorDefecto('x').autor, null);
  const perfil = validarPerfil({ version: 1, name: 'x', autor: { nombre: 'Dueña', email: 'duena@repo.test' } });
  assert.deepEqual(perfil.autor, { nombre: 'Dueña', email: 'duena@repo.test' });
});

test('validarPerfil: `autor` inválido falla con mensajes claros', () => {
  const base = { version: 1, name: 'x' };
  assert.throws(() => validarPerfil({ ...base, autor: 'Dueña' }), /autor: debe ser un objeto \{ nombre, email \}/);
  assert.throws(() => validarPerfil({ ...base, autor: { nombre: 'A' } }), /autor\.email: debe ser un texto no vacío/);
  assert.throws(() => validarPerfil({ ...base, autor: { nombre: 'A', email: 'sin-arroba' } }), /autor\.email: debe tener forma x@y/);
  assert.throws(() => validarPerfil({ ...base, autor: { nombre: 'A<b', email: 'a@b' } }), /autor\.nombre: no puede tener saltos de línea ni/);
  assert.throws(() => validarPerfil({ ...base, autor: { nombre: 'A', email: 'a@b', extra: 1 } }), /autor\.extra: campo desconocido/);
});
