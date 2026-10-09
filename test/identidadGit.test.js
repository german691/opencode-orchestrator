/**
 * Identidad git de los commits NUEVOS: prioridad perfil > `git config` > fallback,
 * validación y caché por repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ErrorDeIdentidad,
  limpiarCacheIdentidad,
  resolverIdentidad,
  validarIdentidad,
  variablesDeGit,
} from '../src/core/identidadGit.js';

// Aísla del entorno de quien ejecuta: solo cuenta la config LOCAL de cada repo temporal.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

/** Ejecuta git en un repo temporal (sin salida al stdout del test). */
function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Repo git temporal vacío (sin commit: solo hace falta la config). */
function repoNuevo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-identidad-'));
  git(['init', '-q'], dir);
  return dir;
}

test('resolverIdentidad: el perfil tiene prioridad sobre la config del repo', (t) => {
  const repo = repoNuevo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(['config', 'user.name', 'Repo'], repo);
  git(['config', 'user.email', 'repo@test'], repo);

  const id = resolverIdentidad({ repo, perfilAutor: { nombre: 'Perfil', email: 'perfil@test' } });
  assert.deepEqual(id, { nombre: 'Perfil', email: 'perfil@test', origen: 'perfil' });
});

test('resolverIdentidad: sin perfil usa user.name/user.email del repo', (t) => {
  const repo = repoNuevo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  limpiarCacheIdentidad();
  git(['config', 'user.name', 'Dueña'], repo);
  git(['config', 'user.email', 'duena@repo.test'], repo);

  const id = resolverIdentidad({ repo });
  assert.deepEqual(id, { nombre: 'Dueña', email: 'duena@repo.test', origen: 'git' });
});

test('resolverIdentidad: sin config ni perfil cae al fallback del orquestador', (t) => {
  const repo = repoNuevo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  limpiarCacheIdentidad();

  const id = resolverIdentidad({ repo });
  assert.deepEqual(id, {
    nombre: 'opencode-orchestrator',
    email: 'orquestador@localhost',
    origen: 'fallback',
  });
});

test('resolverIdentidad: si falta un solo campo, cae al fallback (no firma a medias)', (t) => {
  const repo = repoNuevo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  limpiarCacheIdentidad();
  git(['config', 'user.name', 'Solo Nombre'], repo);

  assert.equal(resolverIdentidad({ repo }).origen, 'fallback');
});

test('resolverIdentidad: cachea por repo y relee al limpiar la caché', (t) => {
  const repo = repoNuevo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  limpiarCacheIdentidad();
  git(['config', 'user.name', 'Uno'], repo);
  git(['config', 'user.email', 'uno@test'], repo);
  assert.equal(resolverIdentidad({ repo }).nombre, 'Uno');

  git(['config', 'user.name', 'Dos'], repo);
  assert.equal(resolverIdentidad({ repo }).nombre, 'Uno', 'dentro del TTL sigue cacheada');
  limpiarCacheIdentidad();
  assert.equal(resolverIdentidad({ repo }).nombre, 'Dos', 'al limpiar la caché relee la config');
});

test('validarIdentidad rechaza vacíos, <> y saltos de línea', () => {
  assert.throws(() => validarIdentidad({ nombre: '', email: 'a@b' }), ErrorDeIdentidad);
  assert.throws(() => validarIdentidad({ nombre: 'A', email: '' }), ErrorDeIdentidad);
  assert.throws(() => validarIdentidad({ nombre: 'A<b', email: 'a@b' }), ErrorDeIdentidad);
  assert.throws(() => validarIdentidad({ nombre: 'A', email: 'a@b\nc' }), ErrorDeIdentidad);
  assert.deepEqual(validarIdentidad({ nombre: 'A', email: 'a@b' }), { nombre: 'A', email: 'a@b' });
});

test('variablesDeGit devuelve autor y committer con la misma identidad', () => {
  const vars = variablesDeGit({ nombre: 'Dueña', email: 'duena@repo.test' });
  assert.deepEqual(vars, {
    GIT_AUTHOR_NAME: 'Dueña',
    GIT_AUTHOR_EMAIL: 'duena@repo.test',
    GIT_COMMITTER_NAME: 'Dueña',
    GIT_COMMITTER_EMAIL: 'duena@repo.test',
  });
});
