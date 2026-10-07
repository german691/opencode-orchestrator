import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cargarEntornoDeArchivo, parsearEntorno, rutaDeEntornoPorDefecto } from '../src/entorno.js';

const dirs = [];
function archivo(contenido, modo = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-env-'));
  dirs.push(dir);
  const ruta = path.join(dir, 'env');
  fs.writeFileSync(ruta, contenido, { mode: modo });
  fs.chmodSync(ruta, modo);
  return ruta;
}
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('parsearEntorno: claves, comentarios, comillas, export y valores con signo igual', () => {
  const { variables, invalidas } = parsearEntorno(
    [
      '# comentario',
      '',
      'ORQ_CONCURRENCY=4',
      'export ORQ_STATE_DIR = /var/orq ',
      'ORQ_PG_ADMIN_URL="postgres://u:p=w@host/db?x=1"',
      "OPENCODE_MODEL='a/b'",
      'VACIA=',
    ].join('\n'),
  );
  assert.deepEqual(variables, {
    ORQ_CONCURRENCY: '4',
    ORQ_STATE_DIR: '/var/orq',
    ORQ_PG_ADMIN_URL: 'postgres://u:p=w@host/db?x=1',
    OPENCODE_MODEL: 'a/b',
    VACIA: '',
  });
  assert.deepEqual(invalidas, []);
});

test('parsearEntorno: informa las líneas inválidas sin abortar y tolera CRLF', () => {
  const { variables, invalidas } = parsearEntorno('OK=1\r\n1MAL=2\r\nesto no es una asignación\r\nTAMBIEN_OK=3');
  assert.deepEqual(variables, { OK: '1', TAMBIEN_OK: '3' });
  assert.deepEqual(invalidas, [2, 3]);
});

test('cargarEntornoDeArchivo: no pisa lo definido y devuelve solo NOMBRES, jamás valores', () => {
  const ruta = archivo('A=1\nB=secreto-que-no-debe-aparecer\nC=3\n');
  const env = { A: 'ya-definida', C: '' };
  const logs = [];
  const r = cargarEntornoDeArchivo({ ruta, env, log: (...p) => logs.push(p.join(' ')) });
  assert.equal(r.existe, true);
  assert.deepEqual(r.omitidas, ['A']);
  assert.deepEqual(r.cargadas.sort(), ['B', 'C']);
  assert.equal(env.A, 'ya-definida');
  assert.equal(env.B, 'secreto-que-no-debe-aparecer');
  assert.equal(env.C, '3', 'una variable vacía en el entorno sí se completa');
  assert.ok(!JSON.stringify(r).includes('secreto'), 'el resultado no contiene valores');
  assert.ok(!logs.join('\n').includes('secreto'), 'el log no contiene valores');
});

test('cargarEntornoDeArchivo: sin archivo no falla', () => {
  const r = cargarEntornoDeArchivo({ ruta: '/no/existe/env', env: {} });
  assert.deepEqual(r, { cargadas: [], omitidas: [], existe: false });
});

test('cargarEntornoDeArchivo: avisa si el archivo es legible por otros usuarios', () => {
  const ruta = archivo('X=1\n', 0o644);
  const logs = [];
  cargarEntornoDeArchivo({ ruta, env: {}, log: (...p) => logs.push(p.join(' ')) });
  assert.ok(logs.some((l) => l.includes('0600')));
  const logs2 = [];
  cargarEntornoDeArchivo({ ruta: archivo('X=1\n', 0o600), env: {}, log: (...p) => logs2.push(p.join(' ')) });
  assert.equal(logs2.length, 0);
});

test('rutaDeEntornoPorDefecto vive bajo ~/.config/opencode-orchestrator', () => {
  assert.equal(rutaDeEntornoPorDefecto('/home/x'), '/home/x/.config/opencode-orchestrator/env');
});
