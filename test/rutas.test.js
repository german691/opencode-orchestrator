import test from 'node:test';
import assert from 'node:assert/strict';

import { aRutaDelServidor } from '../src/rutas.js';

test('aRutaDelServidor convierte rutas de unidad de Windows a /mnt/<letra>', () => {
  const casos = [
    ['C:\\Users\\tecnologia\\Documents\\GitHub\\sistema', '/mnt/c/Users/tecnologia/Documents/GitHub/sistema'],
    ['C:/Users/tecnologia/repo', '/mnt/c/Users/tecnologia/repo'],
    ['D:\\datos\\x', '/mnt/d/datos/x'],
    ['c:\\mixta/ruta\\final\\', '/mnt/c/mixta/ruta/final'],
    ['C:\\', '/mnt/c'],
    ['C:', '/mnt/c'],
    ['C:\\dir con espacios\\ñandú', '/mnt/c/dir con espacios/ñandú'],
    ['C:\\\\doble\\\\barra', '/mnt/c/doble/barra'],
  ];
  for (const [entrada, esperado] of casos) assert.equal(aRutaDelServidor(entrada, 'linux'), esperado, entrada);
});

test('aRutaDelServidor convierte las rutas UNC de WSL a rutas de Linux', () => {
  assert.equal(aRutaDelServidor('\\\\wsl$\\Debian\\home\\x\\repo', 'linux'), '/home/x/repo');
  assert.equal(aRutaDelServidor('\\\\wsl.localhost\\Debian\\root\\work', 'linux'), '/root/work');
  assert.equal(aRutaDelServidor('\\\\wsl$\\Debian', 'linux'), '/');
  assert.equal(aRutaDelServidor('//wsl.localhost/Debian/tmp/a', 'linux'), '/tmp/a');
});

test('aRutaDelServidor no toca rutas de Linux, relativas ni valores que no son texto', () => {
  for (const ruta of ['/mnt/c/Users/x', '/home/a/b', 'relativa/dir', '.', '', 'C', 'CC:\\x', '/c:/x']) {
    assert.equal(aRutaDelServidor(ruta, 'linux'), ruta, JSON.stringify(ruta));
  }
  assert.equal(aRutaDelServidor(undefined, 'linux'), undefined);
  assert.equal(aRutaDelServidor(42, 'linux'), 42);
});

test('aRutaDelServidor no convierte nada fuera de Linux (Windows ya entiende sus rutas)', () => {
  assert.equal(aRutaDelServidor('C:\\Users\\x', 'win32'), 'C:\\Users\\x');
  assert.equal(aRutaDelServidor('C:\\Users\\x', 'darwin'), 'C:\\Users\\x');
});
