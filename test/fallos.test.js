import test from 'node:test';
import assert from 'node:assert/strict';

import { extraerFallos, resumirFallos } from '../src/core/fallos.js';

const VITEST = `
 ✓ test-integracion/a.test.ts (3 tests) 12ms
stdout | ruido
muchas líneas de ruido

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test-integracion/seguridad-auditoria-http.test.ts > 1a) authz_fail
NotFoundError: No EventoSeguridad found
 ❯ node_modules/@prisma/client/runtime/library.js:31:5146
    at wn (/x/library.js:29:1363)
    at $n.request (/x/library.js:121:6307)
 ❯ test-integracion/seguridad-auditoria-http.test.ts:112:21

 Test Files  1 failed | 35 passed (36)
`;

test('extraerFallos toma el bloque de vitest desde "Failed Tests" y quita las pilas internas', () => {
  const r = extraerFallos(VITEST);
  assert.match(r, /Failed Tests 1/);
  assert.match(r, /FAIL {2}test-integracion\/seguridad-auditoria-http\.test\.ts/);
  assert.match(r, /NotFoundError: No EventoSeguridad found/);
  assert.doesNotMatch(r, /^\s+at wn/m);
  assert.doesNotMatch(r, /ruido/);
});

test('extraerFallos reconoce suites que fallan al cargar o por hook', () => {
  const r = extraerFallos('ok\n⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯\n FAIL  a.test.ts [ a.test.ts ]\nError: Hook timed out in 60000ms.\n');
  assert.match(r, /Hook timed out in 60000ms/);
});

test('extraerFallos reconoce node:test (TAP), tsc y eslint', () => {
  assert.match(extraerFallos('ok 1 - a\nnot ok 2 - b\n  ---\n  error: boom\n'), /^not ok 2 - b/);
  assert.match(extraerFallos('src/x.ts(3,5): error TS2322: Type mal\n'), /error TS2322/);
  assert.match(extraerFallos('/a/b.ts\n  12:3  error  mensaje largo  no-unused-vars\n'), /12:3 {2}error/);
});

test('extraerFallos devuelve null si no hay fallos reconocibles o la entrada no es texto', () => {
  assert.equal(extraerFallos('todo bien\n✓ 400 tests\n'), null);
  assert.equal(extraerFallos(''), null);
  assert.equal(extraerFallos(undefined), null);
  assert.equal(extraerFallos(42), null);
});

test('extraerFallos recorta al máximo e indica el recorte', () => {
  const largo = `⎯⎯ Failed Tests 1 ⎯⎯\n${'x'.repeat(5000)}`;
  const r = extraerFallos(largo, 300);
  assert.ok(r.length <= 300 + '\n[... recortado]'.length);
  assert.match(r, /\[\.\.\. recortado\]$/);
});

test('resumirFallos prioriza stderr y cae a stdout', () => {
  assert.match(resumirFallos({ stderr: VITEST, stdout: 'not ok 1 - otro' }), /NotFoundError/);
  assert.match(resumirFallos({ stderr: 'sin nada', stdout: 'not ok 1 - otro' }), /not ok 1 - otro/);
  assert.equal(resumirFallos({ stderr: 'a', stdout: 'b' }), null);
  assert.equal(resumirFallos(), null);
});
