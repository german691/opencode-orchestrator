/**
 * Pruebas del lector de colas compartido (`src/core/colas.js`): lo usan el gestor,
 * el almacén y el panel, así que su contrato (últimos bytes, tolerancia multibyte y
 * marcador de recorte opcional) debe quedar fijado acá.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { leerColaDeArchivo } from '../src/core/colas.js';

/** Archivo temporal con el contenido dado. */
function archivoCon(contenido) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-colas-'));
  const ruta = path.join(dir, 'log.txt');
  fs.writeFileSync(ruta, contenido);
  return ruta;
}

test('leerColaDeArchivo: devuelve el final y vacío si falta o no se piden bytes', () => {
  const ruta = archivoCon('linea1\nlinea2\nlinea3\n');
  assert.equal(leerColaDeArchivo(ruta, { bytes: 7 }), 'linea3\n');
  assert.equal(leerColaDeArchivo(ruta, { bytes: 0 }), '');
  assert.equal(leerColaDeArchivo(ruta, {}), '');
  assert.equal(leerColaDeArchivo(path.join(path.dirname(ruta), 'no-existe'), { bytes: 10 }), '');
  // Más bytes que el archivo: devuelve todo.
  assert.equal(leerColaDeArchivo(ruta, { bytes: 1000 }), 'linea1\nlinea2\nlinea3\n');
});

test('leerColaDeArchivo: tolera un corte multibyte (no devuelve U+FFFD)', () => {
  const ruta = archivoCon('你好世界'); // 12 bytes, 4 caracteres de 3 bytes
  assert.equal(leerColaDeArchivo(ruta, { bytes: 1000 }), '你好世界');
  const cola = leerColaDeArchivo(ruta, { bytes: 5 });
  assert.equal(cola, '界');
  assert.equal(cola.includes('\uFFFD'), false);
});

test('leerColaDeArchivo: con recortar antepone el marcador y descarta la primera línea partida', () => {
  const ruta = archivoCon('primera\nsegunda\ntercera\n');
  const texto = leerColaDeArchivo(ruta, { bytes: 16, recortar: true });
  assert.match(texto, /^\[\.\.\. recortado \.\.\.\]\n/);
  assert.match(texto, /tercera/);
  // Sin el flag NO aparece el marcador (el almacén y el gestor no lo quieren).
  assert.equal(leerColaDeArchivo(ruta, { bytes: 16 }).includes('recortado'), false);
});
