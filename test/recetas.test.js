/**
 * Recetas del perfil: expansión de `{param}` y validación de los valores.
 *
 * Son puras (sin procesos ni git): la barrera importante es que un valor de
 * parámetro no pueda convertir un `writes` en una ruta absoluta o con '..'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { expandirReceta, parametrosDeReceta, parametrosDeTexto } from '../src/core/recetas.js';

test('recetas: parametrosDeTexto y parametrosDeReceta listan placeholders sin repetir', () => {
  assert.deepEqual(parametrosDeTexto('hola {a} y {b} {a}'), ['a', 'b']);
  assert.deepEqual(parametrosDeTexto(42), []);
  assert.deepEqual(
    parametrosDeReceta({ prompt: 'tests de {modulo}', writes: ['{modulo}/**', 'docs/{seccion}/**'] }),
    ['modulo', 'seccion'],
  );
  assert.deepEqual(parametrosDeReceta({ prompt: 'sin params' }), []);
});

test('recetas: expande prompt y writes con los parámetros', () => {
  const receta = {
    prompt: 'Escribí los tests de {modulo} en {modulo}/test.test.js',
    writes: ['{modulo}/**'],
    reads: ['{modulo}/index.js'],
    mode: 'safe',
    accept: 'unit',
    resources: ['db'],
  };
  const expandida = expandirReceta(receta, { modulo: 'backend' });
  assert.equal(expandida.prompt, 'Escribí los tests de backend en backend/test.test.js');
  assert.deepEqual(expandida.writes, ['backend/**']);
  assert.deepEqual(expandida.reads, ['{modulo}/index.js'], 'reads no se expande');
  assert.equal(expandida.mode, 'safe');
  assert.equal(expandida.accept, 'unit');
  assert.deepEqual(expandida.resources, ['db']);
});

test('recetas: solo devuelve los campos presentes', () => {
  const expandida = expandirReceta({ prompt: 'x' }, {});
  assert.equal(expandida.prompt, 'x');
  assert.equal(expandida.writes, undefined);
  assert.equal(expandida.mode, undefined);
});

test('recetas: falta un parámetro -> error claro con su nombre', () => {
  assert.throws(
    () => expandirReceta({ prompt: 'tests de {modulo}' }, {}),
    /falta el parámetro '\{modulo\}'/,
  );
  assert.throws(
    () => expandirReceta({ prompt: 'ok', writes: ['src/{carpeta}/**'] }, {}),
    /falta el parámetro '\{carpeta\}'/,
  );
});

test('recetas: una llave que queda sin definir -> error', () => {
  // El valor del parámetro reintroduce un placeholder que nadie definió.
  assert.throws(() => expandirReceta({ prompt: 'usa {a}' }, { a: '{b}' }), /llave no definida \{b\}/);
});

test('recetas: los parámetros deben ser textos', () => {
  assert.throws(() => expandirReceta({ prompt: 'x {a}' }, { a: 5 }), /'a' debe ser un texto/);
  assert.throws(() => expandirReceta({ prompt: 'x {a}' }, null), /params.*objeto/);
});

test('recetas: un valor usado en writes no admite saltos de línea, ".." ni rutas absolutas', () => {
  const receta = { prompt: 'x', writes: ['src/{carpeta}/**'] };
  assert.throws(() => expandirReceta(receta, { carpeta: 'a\nb' }), /saltos de línea/);
  assert.throws(() => expandirReceta(receta, { carpeta: '../fuera' }), /'\.\.'/);
  assert.throws(() => expandirReceta(receta, { carpeta: '/abs' }), /ruta absoluta/);
  assert.throws(() => expandirReceta(receta, { carpeta: 'C:\\abs' }), /ruta absoluta/);
  // Un valor válido (incluida una subruta) sí se acepta.
  assert.deepEqual(expandirReceta(receta, { carpeta: 'a/b' }).writes, ['src/a/b/**']);
});

test('recetas: un valor con salto de línea en el prompt (no en writes) sí se acepta', () => {
  const expandida = expandirReceta({ prompt: 'nota: {texto}' }, { texto: 'linea1\nlinea2' });
  assert.equal(expandida.prompt, 'nota: linea1\nlinea2');
});

test('recetas: una receta sin prompt no se expande', () => {
  assert.throws(() => expandirReceta({}, {}), /prompt/);
  assert.throws(() => expandirReceta({ prompt: '   ' }, {}), /prompt/);
});
