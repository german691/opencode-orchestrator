import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { identidadDeProceso, coincideIdentidad, bootIdActual } from '../src/core/identidad.js';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Directorio temporal propio de cada prueba. */
function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-id-'));
}

/** ¿El pid sigue existiendo? `EPERM` cuenta como vivo. */
function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/** Espera hasta que `condicion()` sea cierta o se agote `topeMs`. */
async function esperar(condicion, topeMs = 2000, pasoMs = 20) {
  const fin = Date.now() + topeMs;
  while (Date.now() < fin) {
    if (condicion()) return true;
    await dormir(pasoMs);
  }
  return condicion();
}

/** Mata un grupo de procesos best-effort. */
function matar(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ya no existe */
    }
  }
}

test('identidadDeProceso lee inicio y bootId de un proceso real', async () => {
  const hijo = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const pid = hijo.pid;
  hijo.unref();

  try {
    assert.ok(await esperar(() => pidVivo(pid)), 'el proceso debía arrancar');
    const id = identidadDeProceso(pid);
    assert.ok(id, 'debe devolver identidad de un proceso vivo');
    assert.equal(typeof id.inicio, 'number');
    assert.ok(id.inicio > 0);
    assert.equal(id.bootId, bootIdActual());
    // Volver a leer da la MISMA identidad (es estable mientras vive).
    assert.equal(coincideIdentidad(id, identidadDeProceso(pid)), true);
  } finally {
    matar(pid);
  }
});

test('identidadDeProceso parsea el comm con espacios y paréntesis', async () => {
  // Copiamos /bin/sleep a un nombre con espacios y paréntesis: el campo `comm` de
  // /proc/<pid>/stat lo reproduce entre paréntesis y rompería un parseo ingenuo
  // que buscara el PRIMER ')' o hiciera split(' ') sobre toda la línea.
  const binario = '/bin/sleep';
  if (!fs.existsSync(binario)) return; // fuera de Linux no aplica

  const dir = dirTemporal();
  const raro = path.join(dir, 'nodo (raro) x');
  fs.copyFileSync(binario, raro);
  fs.chmodSync(raro, 0o755);

  const hijo = spawn(raro, ['30'], { detached: true, stdio: 'ignore' });
  const pid = hijo.pid;
  hijo.unref();

  try {
    assert.ok(await esperar(() => pidVivo(pid)), 'el proceso de nombre raro debía arrancar');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    assert.ok(stat.includes('(nodo (raro) x)'), 'el comm debe traer espacios y paréntesis');
    // Referencia robusta: campo 22 = índice 19 tras el ÚLTIMO ')'.
    const cierre = stat.lastIndexOf(')');
    const campos = stat.slice(cierre + 1).trim().split(/\s+/);
    const esperado = Number(campos[19]);
    const id = identidadDeProceso(pid);
    assert.ok(id, 'debe parsear aunque el comm tenga paréntesis');
    assert.equal(id.inicio, esperado, 'el starttime debe ser el campo 22 real');
    assert.ok(id.inicio > 0);
  } finally {
    matar(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identidadDeProceso devuelve null para un pid inexistente o inválido', () => {
  assert.equal(identidadDeProceso(999999), null);
  assert.equal(identidadDeProceso(0), null);
  assert.equal(identidadDeProceso(-1), null);
  assert.equal(identidadDeProceso(1.5), null);
  assert.equal(identidadDeProceso('1'), null);
});

test('coincideIdentidad exige ambos lados, mismo bootId y mismo inicio', () => {
  const base = { inicio: 123, bootId: 'b1' };
  assert.equal(coincideIdentidad(base, { inicio: 123, bootId: 'b1' }), true);
  assert.equal(coincideIdentidad(base, { inicio: 124, bootId: 'b1' }), false);
  assert.equal(coincideIdentidad(base, { inicio: 123, bootId: 'b2' }), false);
  assert.equal(coincideIdentidad(null, base), false);
  assert.equal(coincideIdentidad(base, null), false);
  assert.equal(coincideIdentidad(undefined, undefined), false);
  assert.equal(coincideIdentidad({}, base), false);
  assert.equal(coincideIdentidad({ inicio: '123', bootId: 'b1' }, base), false);
});

test('coincideIdentidad: una identidad ausente (proceso que ya no existe) devuelve false y no lanza', () => {
  const guardada = { inicio: 123, bootId: 'abc' };
  assert.equal(coincideIdentidad(guardada, null), false);
  assert.equal(coincideIdentidad(guardada, undefined), false);
  assert.equal(coincideIdentidad(null, guardada), false);
});
