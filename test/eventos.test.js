import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearRegistroEventos, TIPOS } from '../src/core/eventos.js';

const AHORA = 1_800_000_000_000;

/** Crea un directorio temporal y lo borra al terminar el test. */
function crearDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('registrar y listar: persiste la forma del evento y expone los tipos', (t) => {
  const dir = crearDir(t);
  const registro = crearRegistroEventos({ dir, ahora: () => AHORA });
  assert.equal(registro.registrar({ tipo: 'job.creado', jobId: 'abc', actor: 'herramienta:coding' }), true);
  assert.equal(registro.registrar({ tipo: 'job.estado', jobId: 'abc', estado: 'running', anterior: 'queued' }), true);
  const eventos = registro.listar();
  assert.equal(eventos.length, 2);
  // orden desc por defecto: el último registrado primero
  assert.deepEqual(eventos[0], {
    ts: AHORA,
    tipo: 'job.estado',
    jobId: 'abc',
    estado: 'running',
    anterior: 'queued',
    actor: 'servidor',
  });
  assert.equal(eventos[1].actor, 'herramienta:coding');
  assert.equal(registro.tipos, TIPOS);
  assert.ok(TIPOS.includes('pizarron.post'));
});

test('listar: filtra por jobId, tipo y rango desde/hasta', (t) => {
  const dir = crearDir(t);
  let reloj = AHORA;
  const registro = crearRegistroEventos({ dir, ahora: () => reloj });
  reloj = AHORA - 100;
  registro.registrar({ tipo: 'job.creado', jobId: 'a' });
  reloj = AHORA;
  registro.registrar({ tipo: 'job.estado', jobId: 'a' });
  reloj = AHORA + 100;
  registro.registrar({ tipo: 'job.estado', jobId: 'b' });

  assert.deepEqual(registro.listar({ jobId: 'a' }).map((e) => e.ts), [AHORA, AHORA - 100]);
  assert.deepEqual(registro.listar({ tipo: 'job.estado' }).map((e) => e.jobId), ['b', 'a']);
  assert.deepEqual(registro.listar({ desde: AHORA, hasta: AHORA }).map((e) => e.jobId), ['a']);
  assert.deepEqual(registro.listar({ desde: AHORA + 200 }), []);
});

test('listar: respeta orden y limite', (t) => {
  const dir = crearDir(t);
  let reloj = AHORA;
  const registro = crearRegistroEventos({ dir, ahora: () => reloj });
  for (const jobId of ['a', 'b', 'c']) {
    reloj += 1;
    registro.registrar({ tipo: 'job.creado', jobId });
  }
  assert.deepEqual(registro.listar({ orden: 'asc' }).map((e) => e.jobId), ['a', 'b', 'c']);
  assert.deepEqual(registro.listar({ orden: 'desc' }).map((e) => e.jobId), ['c', 'b', 'a']);
  assert.deepEqual(registro.listar({ orden: 'asc', limite: 2 }).map((e) => e.jobId), ['a', 'b']);
});

test('listar: ignora líneas corruptas sin fallar', (t) => {
  const dir = crearDir(t);
  const registro = crearRegistroEventos({ dir, ahora: () => AHORA });
  registro.registrar({ tipo: 'job.creado', jobId: 'ok' });
  fs.appendFileSync(path.join(dir, 'eventos.jsonl'), '{"roto":\nno-json\n\n');
  registro.registrar({ tipo: 'job.fin', jobId: 'ok' });
  assert.deepEqual(registro.listar().map((e) => e.tipo), ['job.fin', 'job.creado']);
});

test('registrar: rechaza un tipo desconocido con Error', (t) => {
  const dir = crearDir(t);
  const registro = crearRegistroEventos({ dir });
  assert.throws(() => registro.registrar({ tipo: 'no.existe' }), /tipo de evento desconocido/);
  assert.deepEqual(registro.listar(), []);
});

test('registrar: trunca el detalle serializado a 4 KB', (t) => {
  const dir = crearDir(t);
  const registro = crearRegistroEventos({ dir, ahora: () => AHORA });
  registro.registrar({ tipo: 'job.mutaciones', detalle: 'a'.repeat(5000) });
  const linea = fs.readFileSync(path.join(dir, 'eventos.jsonl'), 'utf8').trim();
  const evento = JSON.parse(linea);
  assert.equal(typeof evento.detalle, 'string');
  assert.ok(Buffer.byteLength(evento.detalle, 'utf8') <= 4096);
  assert.equal(evento.detalle.length, 4096);
});

test('registrar: rota a eventos.1.jsonl si el archivo supera 5 MB', (t) => {
  const dir = crearDir(t);
  const archivo = path.join(dir, 'eventos.jsonl');
  fs.writeFileSync(archivo, 'x'.repeat(5 * 1024 * 1024 + 1));
  const registro = crearRegistroEventos({ dir, ahora: () => AHORA });
  assert.equal(registro.registrar({ tipo: 'job.creado', jobId: 'nuevo' }), true);
  assert.equal(fs.existsSync(path.join(dir, 'eventos.1.jsonl')), true);
  assert.equal(fs.statSync(archivo).size < 5 * 1024 * 1024, true);
  assert.deepEqual(registro.listar().map((e) => e.jobId), ['nuevo']);
});

test('registrar: un fallo de E/S devuelve false y no lanza', (t) => {
  const dir = crearDir(t);
  const comoArchivo = path.join(dir, 'soy-un-archivo');
  fs.writeFileSync(comoArchivo, 'no soy un directorio');
  const registro = crearRegistroEventos({ dir: comoArchivo });
  assert.equal(registro.registrar({ tipo: 'job.creado', jobId: 'x' }), false);
  assert.deepEqual(registro.listar(), []);
});
