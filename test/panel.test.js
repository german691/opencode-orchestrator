import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { semaforo, listarTrabajos, detalleDeTrabajo, sinAnsi, idValido } from '../src/panel/datos.js';
import { crearServidorPanel } from '../src/panel/servidor.js';
import { crearRegistroEventos } from '../src/core/eventos.js';

const AHORA = 1_800_000_000_000;

function crearEstado() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
  const jobs = path.join(base, 'jobs');
  fs.mkdirSync(jobs);
  return { base, jobs };
}

function crearJob(jobs, id, job, { stderr, stdout, aceptacionErr, hace = 0, eventos } = {}) {
  const dir = path.join(jobs, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, ...job }));
  const t = new Date(AHORA - hace * 1000);
  const escribir = (nombre, texto) => {
    const archivo = path.join(dir, nombre);
    fs.writeFileSync(archivo, texto);
    fs.utimesSync(archivo, t, t);
  };
  if (stderr !== undefined) escribir('stderr.log', stderr);
  if (stdout !== undefined) escribir('stdout.log', stdout);
  if (aceptacionErr !== undefined) escribir('aceptacion.err.log', aceptacionErr);
  if (eventos) fs.writeFileSync(path.join(dir, 'events.jsonl'), eventos.map((e) => JSON.stringify(e)).join('\n'));
}

test('semaforo: verde, amarillo (>2 min) y rojo (>5 min)', () => {
  assert.equal(semaforo(null), null);
  assert.equal(semaforo(10), 'verde');
  assert.equal(semaforo(120), 'verde');
  assert.equal(semaforo(121), 'amarillo');
  assert.equal(semaforo(301), 'rojo');
});

test('lista: activos primero, con segundos sin salida y semáforo', () => {
  const { jobs } = crearEstado();
  crearJob(jobs, 'viejo', { estado: 'succeeded', titulo: 'T1', creadoEn: AHORA - 900_000 }, {
    stderr: 'x', hace: 600,
    eventos: [{ tipo: 'fin', ocurridoEn: AHORA - 600_000 }],
  });
  crearJob(jobs, 'vivo', { estado: 'running', titulo: 'T2', creadoEn: AHORA - 400_000 }, { stderr: 'leyendo', hace: 200 });
  crearJob(jobs, 'trabado', { estado: 'running', titulo: 'T3', creadoEn: AHORA - 800_000 }, { stderr: 'x', hace: 400 });
  const lista = listarTrabajos(jobs, AHORA);
  assert.deepEqual(lista.map((j) => j.id), ['vivo', 'trabado', 'viejo']);
  assert.equal(lista[0].segundosSinSalida, 200);
  assert.equal(lista[0].semaforo, 'amarillo');
  assert.equal(lista[1].semaforo, 'rojo');
  assert.equal(lista[2].semaforo, null);
  assert.equal(lista[2].duracionS, 300);
  assert.equal(lista[0].duracionS, 400);
});

test('detalle: transcript sin ANSI, respuesta y fallos de la aceptación', () => {
  const { jobs } = crearEstado();
  crearJob(
    jobs,
    'rech',
    { estado: 'rejected', creadoEn: AHORA - 1000, resultado: { aceptacion: { cmd: 'npm test', ejecutada: true, exit: 1 } } },
    {
      stderr: '\u001b[0m→ \u001b[0mRead CLAUDE.md\n',
      stdout: 'listo',
      aceptacionErr: ' FAIL  test/a.test.ts > suma\nAssertionError: esperado 2\n',
      hace: 5,
    },
  );
  const d = detalleDeTrabajo(jobs, 'rech', AHORA);
  assert.match(d.transcript, /→ Read CLAUDE\.md/);
  assert.equal(d.transcript.includes('\u001b'), false);
  assert.equal(d.respuesta, 'listo');
  assert.match(d.fallos, /FAIL/);
  assert.equal(d.aceptacion.exit, 1);
});

test('detalle: sin fallos mientras la aceptación no terminó o salió bien', () => {
  const { jobs } = crearEstado();
  const err = ' FAIL  test/a.test.ts > suma\nAssertionError: x\n';
  crearJob(jobs, 'enCurso', { estado: 'verifying', creadoEn: AHORA - 1000 }, { stderr: 'x', aceptacionErr: err, hace: 1 });
  crearJob(
    jobs,
    'verde',
    { estado: 'succeeded', creadoEn: AHORA - 1000, resultado: { aceptacion: { ejecutada: true, exit: 0 } } },
    { stderr: 'x', aceptacionErr: err, hace: 1 },
  );
  assert.equal(detalleDeTrabajo(jobs, 'enCurso', AHORA).fallos, null);
  assert.equal(detalleDeTrabajo(jobs, 'verde', AHORA).fallos, null);
});

test('detalle: ids con ../ o inexistentes devuelven null (no salen del directorio)', () => {
  const { jobs } = crearEstado();
  assert.equal(idValido('../x'), false);
  assert.equal(detalleDeTrabajo(jobs, '../x', AHORA), null);
  assert.equal(detalleDeTrabajo(jobs, 'noexiste', AHORA), null);
});

test('un job.json a medio escribir o ausente no rompe la lista', () => {
  const { jobs } = crearEstado();
  fs.mkdirSync(path.join(jobs, 'roto'));
  fs.writeFileSync(path.join(jobs, 'roto', 'job.json'), '{"estado":');
  fs.mkdirSync(path.join(jobs, 'vacio'));
  assert.deepEqual(listarTrabajos(jobs, AHORA), []);
  assert.equal(sinAnsi('\u001b[31mrojo\u001b[0m'), 'rojo');
});

test('servidor: sirve página y API, rechaza escrituras y no modifica el estado', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'abc', { estado: 'running', titulo: 'Demo', creadoEn: AHORA - 1000 }, { stderr: 'hola', hace: 1 });
  const antes = fs.readdirSync(path.join(jobs, 'abc')).sort();
  const servidor = crearServidorPanel({ baseDir: base, ahora: () => AHORA });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const pagina = await fetch(`${url}/`);
    assert.equal(pagina.status, 200);
    assert.match(await pagina.text(), /Trabajos de opencode/);
    const lista = await (await fetch(`${url}/api/trabajos`)).json();
    assert.equal(lista.trabajos[0].id, 'abc');
    const det = await (await fetch(`${url}/api/trabajos/abc`)).json();
    assert.equal(det.transcript, 'hola');
    assert.equal((await fetch(`${url}/api/trabajos/zzz`)).status, 404);
    assert.equal((await fetch(`${url}/api/trabajos/..%2Fabc`)).status, 404);
    assert.equal((await fetch(`${url}/api/trabajos`, { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(`${url}/api/trabajos/abc`, { method: 'DELETE' })).status, 405);
    assert.deepEqual(fs.readdirSync(path.join(jobs, 'abc')).sort(), antes);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});

test('lista: un trabajo en cola muestra por qué espera; uno corriendo no', () => {
  const { jobs } = crearEstado();
  const espera = { motivo: 'recurso', por: ['zzz'] };
  crearJob(jobs, 'cola1', { estado: 'queued', creadoEn: AHORA - 1000, espera });
  crearJob(jobs, 'corre', { estado: 'running', creadoEn: AHORA - 1000, espera }, { stderr: 'x', hace: 1 });
  const lista = listarTrabajos(jobs, AHORA);
  assert.deepEqual(lista.find((j) => j.id === 'cola1').espera, espera);
  assert.equal(lista.find((j) => j.id === 'corre').espera, null);
});

test('auditoría: la página y /api/eventos usan el registro inyectado con filtros', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'abc', { estado: 'running', titulo: 'Demo', creadoEn: AHORA - 1000 }, { stderr: 'hola', hace: 1 });
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  registro.registrar({ tipo: 'job.creado', jobId: 'abc', actor: 'herramienta:coding' });
  registro.registrar({ tipo: 'job.fin', jobId: 'otro', motivo: 'listo' });
  const servidor = crearServidorPanel({ baseDir: base, ahora: () => AHORA, registro });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const pagina = await fetch(`${url}/auditoria`);
    assert.equal(pagina.status, 200);
    const html = await pagina.text();
    assert.match(html, /Auditoría de opencode/);
    assert.match(html, /job\.creado/);
    assert.match(html, /\/\?job=abc/);

    const todos = await (await fetch(`${url}/api/eventos`)).json();
    assert.equal(todos.eventos.length, 2);

    const porJob = await (await fetch(`${url}/api/eventos?jobId=abc`)).json();
    assert.deepEqual(porJob.eventos.map((e) => e.jobId), ['abc']);

    const porTipo = await (await fetch(`${url}/api/eventos?tipo=job.fin`)).json();
    assert.deepEqual(porTipo.eventos.map((e) => e.tipo), ['job.fin']);

    const paginaFiltrada = await fetch(`${url}/auditoria?jobId=otro`);
    const htmlFiltrado = await paginaFiltrada.text();
    assert.match(htmlFiltrado, /job\.fin/);
    assert.match(htmlFiltrado, /\/\?job=otro/);
    assert.equal(htmlFiltrado.includes('/?job=abc'), false);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});

test('auditoría: sin registro inyectado avisa que no está disponible', async () => {
  const { base } = crearEstado();
  const servidor = crearServidorPanel({ baseDir: base, ahora: () => AHORA });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const pagina = await fetch(`${url}/auditoria`);
    assert.equal(pagina.status, 200);
    assert.match(await pagina.text(), /Auditoría no disponible/);
    assert.equal((await fetch(`${url}/api/eventos`)).status, 503);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});
