import test from 'node:test';
import assert from 'node:assert/strict';

import { compilar, coincide } from '../src/core/glob.js';

test('src/** casa con archivos a cualquier profundidad, pero no con src ni srcx', () => {
  assert.equal(coincide('src/**', 'src/a.js'), true);
  assert.equal(coincide('src/**', 'src/a/b/c.js'), true);
  assert.equal(coincide('src/**', 'srcx/a.js'), false);
  assert.equal(coincide('src/**', 'src'), false);
});

test('**/.env casa en la raíz y a cualquier profundidad', () => {
  assert.equal(coincide('**/.env', '.env'), true);
  assert.equal(coincide('**/.env', 'a/b/.env'), true);
  assert.equal(coincide('**/.env', 'a/.env.example'), false);
  assert.equal(coincide('**/.env', 'env'), false);
});

test('*.md solo en la raíz', () => {
  assert.equal(coincide('*.md', 'README.md'), true);
  assert.equal(coincide('*.md', 'docs/README.md'), false);
  assert.equal(coincide('*.md', 'a/b.md'), false);
});

test('a/**/b casa con cero o más directorios intermedios', () => {
  assert.equal(coincide('a/**/b', 'a/b'), true);
  assert.equal(coincide('a/**/b', 'a/x/y/b'), true);
  assert.equal(coincide('a/**/b', 'a/x/y/b/c'), false);
  assert.equal(coincide('a/**/b', 'a/x/c'), false);
});

test('* no cruza la barra y ? casa exactamente un caracter', () => {
  assert.equal(coincide('src/*', 'src/a.js'), true);
  assert.equal(coincide('src/*', 'src/a/b.js'), false);
  assert.equal(coincide('?', 'a'), true);
  assert.equal(coincide('?', 'ab'), false);
  assert.equal(coincide('?', '/'), false);
  assert.equal(coincide('a?c', 'abc'), true);
  assert.equal(coincide('a?c', 'a/c'), false);
});

test('** por sí solo casa con cualquier ruta no vacía', () => {
  assert.equal(coincide('**', 'a'), true);
  assert.equal(coincide('**', 'a/b/c.txt'), true);
  assert.equal(coincide('**', ''), false);
});

test('los metacaracteres de regex en el patrón son literales', () => {
  assert.equal(coincide('a.b', 'a.b'), true);
  assert.equal(coincide('a.b', 'axb'), false);
  assert.equal(coincide('a+b', 'a+b'), true);
  assert.equal(coincide('a+b', 'aab'), false);
  assert.equal(coincide('(x)', '(x)'), true);
  assert.equal(coincide('[1]', '[1]'), true);
  assert.equal(coincide('[1]', '1'), false);
});

test('los metacaracteres de regex en la ruta no se interpretan', () => {
  assert.equal(coincide('**', 'a.b'), true);
  assert.equal(coincide('*.txt', 'a.b.txt'), true);
  assert.equal(coincide('a.b.c', 'a.b.c'), true);
});

test('distingue mayúsculas de minúsculas', () => {
  assert.equal(coincide('Foo.js', 'foo.js'), false);
  assert.equal(coincide('*.js', 'A.js'), true);
  assert.equal(coincide('*.JS', 'a.js'), false);
});

test('normaliza separadores \\ a /', () => {
  assert.equal(coincide('src/**', 'src\\a.js'), true);
  assert.equal(coincide('src\\**', 'src/a.js'), true);
  assert.equal(compilar('src\\**').test('src/a.js'), true);
});

test('compilar rechaza patrones absolutos o con ..', () => {
  assert.throws(() => compilar('/etc/**'), /absoluta/);
  assert.throws(() => compilar('C:/x/**'), /absoluta/);
  assert.throws(() => compilar('a/../b'), /\.\./);
  assert.throws(() => compilar('../x'), /\.\./);
});

test('compilar rechaza patrones vacíos o de tipo incorrecto', () => {
  assert.throws(() => compilar(''), /texto no vacío/);
  assert.throws(() => compilar(123), /texto no vacío/);
  assert.throws(() => compilar(null), /texto no vacío/);
});

test('coincide devuelve false para rutas absolutas o con ..', () => {
  assert.equal(coincide('**', '/etc/passwd'), false);
  assert.equal(coincide('**', 'C:/Windows/x'), false);
  assert.equal(coincide('**', '../secreto'), false);
  assert.equal(coincide('**', 'a/../../b'), false);
});

test('coincide devuelve false para rutas vacías o no string', () => {
  assert.equal(coincide('**', ''), false);
  assert.equal(coincide('**', null), false);
  assert.equal(coincide('**', 42), false);
});

test('coincide propaga el error de un patrón inválido', () => {
  assert.throws(() => coincide('../**', 'a'), /\.\./);
});

test('un comodín ** embebido sin barra también cruza directorios', () => {
  assert.equal(coincide('a/**b', 'a/x/yb'), true);
  assert.equal(coincide('a/**b', 'a/b'), true);
  assert.equal(coincide('a/**b', 'ab'), false);
});

test('coincide: por defecto distingue mayúsculas y con ignorarMayusculas no', () => {
  assert.equal(coincide('backend/prisma/migrations/**', 'Backend/prisma/MIGRATIONS/x.sql'), false);
  assert.equal(coincide('backend/prisma/migrations/**', 'Backend/prisma/MIGRATIONS/x.sql', { ignorarMayusculas: true }), true);
  assert.equal(coincide('**/.env', 'a/.ENV', { ignorarMayusculas: true }), true);
  // Ignorar mayúsculas no relaja nada más: sigue respetando límites de directorio.
  assert.equal(coincide('src/**', 'SRCX/a.js', { ignorarMayusculas: true }), false);
  assert.equal(compilar('A/**', { ignorarMayusculas: true }).flags, 'i');
  assert.equal(compilar('A/**').flags, '');
});
