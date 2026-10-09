import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ErrorDeRevisor,
  configRevisor,
  construirPromptRevision,
  parsearVeredicto,
  resumenRevision,
  debeRevisar,
  MAX_TAREA_BYTES,
} from '../src/core/revisor.js';

/** Lanza `configRevisor` y devuelve el error para inspeccionar `.errores`. */
function capturarError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba un error');
}

test('configRevisor: sección ausente o null usa valores por defecto seguros', () => {
  const esperado = { habilitado: false, modelo: null, maxDiffBytes: 60000, reglas: [], prompt: null };
  assert.deepEqual(configRevisor(undefined), esperado);
  assert.deepEqual(configRevisor(null), esperado);
  assert.deepEqual(configRevisor({}), esperado);
});

test('configRevisor: configuración completa válida se normaliza', () => {
  const normalizado = configRevisor({
    habilitado: true,
    modelo: 'proveedor/modelo',
    maxDiffBytes: 5000,
    reglas: ['sin dependencias', 'tests en el mismo lote'],
    prompt: 'Encabezado propio',
  });
  assert.deepEqual(normalizado, {
    habilitado: true,
    modelo: 'proveedor/modelo',
    maxDiffBytes: 5000,
    reglas: ['sin dependencias', 'tests en el mismo lote'],
    prompt: 'Encabezado propio',
  });
  // La copia no comparte el array de entrada (evita mutaciones cruzadas).
  const original = { reglas: ['a'] };
  const copia = configRevisor(original);
  copia.reglas.push('b');
  assert.deepEqual(original.reglas, ['a']);
});

test('configRevisor: acepta los extremos del rango de maxDiffBytes', () => {
  assert.equal(configRevisor({ maxDiffBytes: 300000 }).maxDiffBytes, 300000);
});

test('configRevisor: rechaza campos desconocidos y valores inválidos acumulando errores', () => {
  const error = capturarError(() =>
    configRevisor({
      model: 'typo',
      habilitado: 'sí',
      modelo: '',
      maxDiffBytes: 4999,
      reglas: ['ok', 7, ''],
      prompt: '   ',
    }),
  );
  assert.ok(error instanceof ErrorDeRevisor);
  assert.ok(error.errores.some((e) => e.includes('revisor.model: campo desconocido')));
  assert.ok(error.errores.some((e) => e.includes('revisor.habilitado')));
  assert.ok(error.errores.some((e) => e.includes('revisor.modelo')));
  assert.ok(error.errores.some((e) => e.includes('revisor.maxDiffBytes')));
  assert.ok(error.errores.some((e) => e.includes('revisor.reglas[1]')));
  assert.ok(error.errores.some((e) => e.includes('revisor.reglas[2]')));
  assert.ok(error.errores.some((e) => e.includes('revisor.prompt')));
});

test('configRevisor: rechaza maxDiffBytes fuera de rango o no entero', () => {
  assert.throws(() => configRevisor({ maxDiffBytes: 300001 }), ErrorDeRevisor);
  assert.throws(() => configRevisor({ maxDiffBytes: 1.5 }), ErrorDeRevisor);
  assert.throws(() => configRevisor({ maxDiffBytes: 'x' }), ErrorDeRevisor);
});

test('configRevisor: rechaza una sección que no sea objeto plano', () => {
  assert.throws(() => configRevisor('hola'), ErrorDeRevisor);
  assert.throws(() => configRevisor([]), ErrorDeRevisor);
});

test('construirPromptRevision: incluye tarea, alcance, archivos, diff, reglas y formato exigido', () => {
  const prompt = construirPromptRevision({
    tarea: 'Arreglá el bug de login',
    writes: ['src/a.js', 'test/a.test.js'],
    archivos: ['src/a.js'],
    diff: 'diff --git a/src/a.js b/src/a.js\n+const x = 1;',
    reglas: ['comentarios en español'],
    maxDiffBytes: 60000,
  });

  assert.match(prompt, /Arreglá el bug de login/);
  assert.match(prompt, /- src\/a\.js/);
  assert.match(prompt, /- test\/a\.test\.js/);
  assert.match(prompt, /- comentarios en español/);
  assert.match(prompt, /diff --git a\/src\/a\.js/);
  assert.match(prompt, /Reglas de revisión, en este orden:/);
  assert.match(prompt, /a\) ¿Cumple lo pedido/);
  assert.match(prompt, /e\) ¿Hay bugs evidentes\?/);
  assert.match(prompt, /VEREDICTO: APRUEBA/);
  assert.match(prompt, /VEREDICTO: OBSERVA/);
  assert.doesNotMatch(prompt, /truncado/);
});

test('construirPromptRevision: trunca el diff y avisa cuántos bytes omitió', () => {
  const prompt = construirPromptRevision({ diff: 'x'.repeat(50), maxDiffBytes: 10 });
  assert.match(prompt, /\[diff truncado: 40 bytes omitidos\]/);
});

test('construirPromptRevision: trunca la tarea a 6 KB y lo avisa', () => {
  const tarea = 'y'.repeat(7000);
  const prompt = construirPromptRevision({ tarea });
  const aviso = `[tarea truncada: ${7000 - MAX_TAREA_BYTES} bytes omitidos]`;
  assert.match(prompt, new RegExp(`\\[tarea truncada: ${7000 - MAX_TAREA_BYTES} bytes omitidos\\]`));
  assert.ok(prompt.length < tarea.length + aviso.length + 2000, 'el prompt no debe arrastrar la tarea entera');
});

test('construirPromptRevision: una plantilla propia reemplaza el encabezado pero no los datos ni el formato', () => {
  const prompt = construirPromptRevision({
    plantilla: 'ENCABEZADO PROPIO',
    tarea: 't',
    diff: 'd',
    reglas: ['r'],
  });
  assert.match(prompt, /ENCABEZADO PROPIO/);
  assert.doesNotMatch(prompt, /Sos el REVISOR AUTOMÁTICO/);
  assert.match(prompt, /TAREA ORIGINAL/);
  assert.match(prompt, /VEREDICTO: APRUEBA/);
});

test('construirPromptRevision: sin datos usa los textos alternativos', () => {
  const prompt = construirPromptRevision();
  assert.match(prompt, /\(sin alcance declarado\)/);
  assert.match(prompt, /\(sin archivos cambiados\)/);
  assert.match(prompt, /\(sin reglas adicionales\)/);
});

test('parsearVeredicto: reconoce el veredicto y limpia las observaciones', () => {
  const r = parsearVeredicto('VEREDICTO: OBSERVA\n- falta test en src/a.js:10\n- tocó un archivo fuera de alcance');
  assert.equal(r.veredicto, 'OBSERVA');
  assert.deepEqual(r.observaciones, ['falta test en src/a.js:10', 'tocó un archivo fuera de alcance']);
});

test('parsearVeredicto: tolera minúsculas, espacios y ruido antes del veredicto', () => {
  const r = parsearVeredicto('Pensando...\nbla bla\n\n  veredicto  :   aprueba\n');
  assert.equal(r.veredicto, 'APRUEBA');
});

test('parsearVeredicto: tolera el veredicto en negrita dentro de un bloque de código', () => {
  const r = parsearVeredicto('```\n**VEREDICTO: OBSERVA**\n- algo\n```');
  assert.equal(r.veredicto, 'OBSERVA');
  assert.deepEqual(r.observaciones, ['algo']);
});

test('parsearVeredicto: sin veredicto devuelve INDETERMINADO con el crudo', () => {
  const r = parsearVeredicto('No sé qué decir, no hubo veredicto.');
  assert.equal(r.veredicto, 'INDETERMINADO');
  assert.equal(r.crudo, 'No sé qué decir, no hubo veredicto.');
});

test('parsearVeredicto: toma el primer veredicto y solo las observaciones posteriores', () => {
  const r = parsearVeredicto('- ruido previo\nVEREDICTO: APRUEBA\n- observación real');
  assert.equal(r.veredicto, 'APRUEBA');
  assert.deepEqual(r.observaciones, ['observación real']);
});

test('parsearVeredicto: recorta a 5 observaciones', () => {
  const lineas = ['VEREDICTO: OBSERVA'];
  for (let i = 1; i <= 7; i += 1) lineas.push(`- observación ${i}`);
  const r = parsearVeredicto(lineas.join('\n'));
  assert.equal(r.observaciones.length, 5);
  assert.deepEqual(r.observaciones, ['observación 1', 'observación 2', 'observación 3', 'observación 4', 'observación 5']);
});

test('parsearVeredicto: cada observación se limita a 300 caracteres', () => {
  const r = parsearVeredicto(`VEREDICTO: OBSERVA\n- ${'z'.repeat(400)}`);
  assert.equal(r.observaciones.length, 1);
  assert.equal(r.observaciones[0].length, 300);
});

test('parsearVeredicto: el crudo se limita a 1000 caracteres', () => {
  const r = parsearVeredicto('a'.repeat(1500));
  assert.equal(r.veredicto, 'INDETERMINADO');
  assert.equal(r.crudo.length, 1000);
});

test('parsearVeredicto: entrada no textual no rompe', () => {
  assert.equal(parsearVeredicto(null).veredicto, 'INDETERMINADO');
  assert.equal(parsearVeredicto(undefined).veredicto, 'INDETERMINADO');
  assert.equal(parsearVeredicto(42).veredicto, 'INDETERMINADO');
});

test('resumenRevision: APRUEBA ocupa una línea', () => {
  const resumen = resumenRevision({ veredicto: 'APRUEBA', observaciones: [] });
  assert.equal(resumen, 'Revisión automática: APRUEBA');
});

test('resumenRevision: OBSERVA lista las observaciones y no supera 6 líneas', () => {
  const observaciones = ['a', 'b', 'c', 'd', 'e', 'f'];
  const resumen = resumenRevision({ veredicto: 'OBSERVA', observaciones });
  const lineas = resumen.split('\n');
  assert.equal(lineas[0], 'Revisión automática: OBSERVA');
  assert.equal(lineas.length, 6);
  assert.equal(lineas[5], '- e');
});

test('resumenRevision: INDETERMINADO lo explica', () => {
  const resumen = resumenRevision({ veredicto: 'INDETERMINADO' });
  assert.match(resumen, /INDETERMINADO/);
  assert.equal(resumen.split('\n').length, 2);
});

test('debeRevisar: solo un safe succeeded habilitado y con archivos', () => {
  assert.equal(
    debeRevisar({ modo: 'safe', estado: 'succeeded', config: { habilitado: true }, archivos: ['src/a.js'] }),
    true,
  );
});

test('debeRevisar: tabla de casos que NO revisan', () => {
  const config = { habilitado: true };
  assert.equal(debeRevisar({ modo: 'readonly', estado: 'succeeded', config, archivos: ['a'] }), false);
  assert.equal(debeRevisar({ modo: 'auto', estado: 'succeeded', config, archivos: ['a'] }), false);
  assert.equal(debeRevisar({ modo: 'safe', estado: 'succeeded', config: { habilitado: false }, archivos: ['a'] }), false);
  assert.equal(debeRevisar({ modo: 'safe', estado: 'succeeded', config, archivos: [] }), false);
  assert.equal(debeRevisar({ modo: 'safe', estado: 'failed', config, archivos: ['a'] }), false);
  assert.equal(debeRevisar({ modo: 'safe', estado: 'rejected', config, archivos: ['a'] }), false);
  assert.equal(debeRevisar({ modo: 'safe', estado: 'succeeded', config, archivos: ['a'], solo_aceptacion: true }), false);
  assert.equal(debeRevisar({ modo: 'safe', estado: 'succeeded', archivos: ['a'] }), false);
});

test('debeRevisar: acepta el trabajo como objeto y respeta soloAceptacion', () => {
  const config = { habilitado: true };
  assert.equal(
    debeRevisar({ modo: 'safe', estado: { estado: 'succeeded', soloAceptacion: false }, config, archivos: ['a'] }),
    true,
  );
  assert.equal(
    debeRevisar({ modo: 'safe', estado: { estado: 'succeeded', soloAceptacion: true }, config, archivos: ['a'] }),
    false,
  );
});
