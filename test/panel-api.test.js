import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { crearServidorPanel } from '../src/panel/servidor.js';
import { crearFlujoEventos } from '../src/panel/stream.js';
import { crearRegistroEventos } from '../src/core/eventos.js';
import { diffDeTrabajo } from '../src/panel/diff.js';

const AHORA = 1_800_000_000_000;

function crearEstado() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-api-'));
  const jobs = path.join(base, 'jobs');
  fs.mkdirSync(jobs);
  return { base, jobs };
}

function crearJob(jobs, id, job, { stderr, stdout, aceptacion, aceptacionErr, config } = {}) {
  const dir = path.join(jobs, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, creadoEn: AHORA - 1000, ...job }));
  if (stderr !== undefined) fs.writeFileSync(path.join(dir, 'stderr.log'), stderr);
  if (stdout !== undefined) fs.writeFileSync(path.join(dir, 'stdout.log'), stdout);
  if (aceptacion !== undefined) fs.writeFileSync(path.join(dir, 'aceptacion.log'), aceptacion);
  if (aceptacionErr !== undefined) fs.writeFileSync(path.join(dir, 'aceptacion.err.log'), aceptacionErr);
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'opencode.jsonc'), JSON.stringify(config));
  return dir;
}

async function conServidor(opciones, fn) {
  const servidor = crearServidorPanel({ ahora: () => AHORA, ...opciones });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  try {
    await fn(url);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
}

/** Lee el body SSE hasta que aparezca `marca` (o falle por timeout). */
async function esperarEvento(resp, marca, { timeoutMs = 3000 } = {}) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let texto = '';
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      texto += dec.decode(value, { stream: true });
      if (texto.includes(marca)) return texto;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`no llegó '${marca}'; recibido: ${texto}`);
}

test('estado: cuenta por estado y refleja la concurrencia conocida', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'corre001', { estado: 'running' });
  crearJob(jobs, 'corre002', { estado: 'running' });
  crearJob(jobs, 'cola0001', { estado: 'queued' });
  crearJob(jobs, 'verif001', { estado: 'verifying' });
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  registro.registrar({ tipo: 'job.creado', jobId: 'corre001' });
  await conServidor({ baseDir: base, registro, concurrencia: 3 }, async (url) => {
    const estado = await (await fetch(`${url}/api/estado`)).json();
    assert.equal(estado.concurrencia, 3);
    assert.equal(estado.corriendo, 2);
    assert.equal(estado.enCola, 1);
    assert.equal(estado.verificando, 1);
    assert.equal(estado.total, 4);
    assert.deepEqual(estado.porEstado, { running: 2, queued: 1, verifying: 1 });
    assert.equal(estado.ultimoEvento.tipo, 'job.creado');
  });
});

test('estado: sin concurrencia conocida la informa como null', async () => {
  const { base } = crearEstado();
  await conServidor({ baseDir: base }, async (url) => {
    const estado = await (await fetch(`${url}/api/estado`)).json();
    assert.equal(estado.concurrencia, null);
    assert.equal(estado.ultimoEvento, null);
  });
});

test('log: rangos, límite, borde UTF-8 y ANSI', async () => {
  const { base, jobs } = crearEstado();
  // bytes: 'aaaa' + 'ñ'(2) + '\n' + 'b'  => cortar en 5 parte la 'ñ'
  crearJob(jobs, 'log00001', { estado: 'running' }, { stderr: `aaaañ\nb`, aceptacionErr: '\u001b[31mrojo\u001b[0m\n' });
  await conServidor({ baseDir: base }, async (url) => {
    const entero = await (await fetch(`${url}/api/trabajos/log00001/log?fuente=agente`)).json();
    assert.equal(entero.desde, 0);
    assert.equal(entero.tamano, 8);
    assert.equal(entero.fin, true);
    assert.equal(entero.texto, 'aaaañ\nb');
    assert.equal(entero.siguiente, 8);

    const primera = await (await fetch(`${url}/api/trabajos/log00001/log?fuente=agente&desde=0&limite=5`)).json();
    assert.equal(primera.fin, false);
    assert.equal(primera.texto, 'aaaa'); // no incluye el byte suelto de 'ñ'
    assert.equal(primera.siguiente, 4);
    const segunda = await (await fetch(`${url}/api/trabajos/log00001/log?fuente=agente&desde=4&limite=10`)).json();
    assert.equal(segunda.texto, 'ñ\nb');
    assert.equal(segunda.fin, true);

    // ANSI: por defecto se limpia; con ansi=1 se conserva.
    const limpio = await (await fetch(`${url}/api/trabajos/log00001/log?fuente=stderr&desde=0&limite=65536`)).json();
    assert.equal(limpio.texto, 'rojo\n');
    const crudo = await (await fetch(`${url}/api/trabajos/log00001/log?fuente=stderr&desde=0&limite=65536&ansi=1`)).json();
    assert.equal(crudo.texto, '\u001b[31mrojo\u001b[0m\n');
  });
});

test('log: límite se acota a 65536 y una fuente desconocida da 400', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'log00002', { estado: 'running' }, { stderr: 'x'.repeat(70_000) });
  await conServidor({ baseDir: base }, async (url) => {
    const r = await (await fetch(`${url}/api/trabajos/log00002/log?fuente=agente&limite=999999`)).json();
    assert.equal(Buffer.byteLength(r.texto), 65536);
    assert.equal(r.fin, false);
    assert.equal(r.siguiente, 65536);
    assert.equal((await fetch(`${url}/api/trabajos/log00002/log?fuente=nope`)).status, 400);
  });
});

test('id inválido o traversal da 400; id válido inexistente da 404', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'valido01', { estado: 'running' }, { stderr: 'hola' });
  await conServidor({ baseDir: base }, async (url) => {
    assert.equal((await fetch(`${url}/api/trabajos/abc/log`)).status, 400); // muy corto
    assert.equal((await fetch(`${url}/api/trabajos/..%2F..%2Fetc/log`)).status, 400); // traversal
    assert.equal((await fetch(`${url}/api/trabajos/abcdefghijklmnopq/log`)).status, 400); // >16
    assert.equal((await fetch(`${url}/api/trabajos/otro0001/log`)).status, 404); // válido, inexistente
    assert.equal((await fetch(`${url}/api/trabajos/valido01/log?fuente=agente`)).status, 200);
  });
});

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function crearRepoGit() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@test']);
  git(repo, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  return { repo, sha };
}

test('diff: archivos y parche del repo git contra la base', async () => {
  const { base, jobs } = crearEstado();
  const { repo, sha } = crearRepoGit();
  crearJob(jobs, 'diff0001', { estado: 'succeeded', repo, worktree: repo, baseCommit: sha, mode: 'safe', writes: ['a.txt', 'b.txt'] });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\ndos\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'nuevo\n');
  git(repo, ['add', '.']);
  await conServidor({ baseDir: base }, async (url) => {
    const diff = await (await fetch(`${url}/api/trabajos/diff0001/diff`)).json();
    assert.equal(diff.disponible, true);
    assert.equal(diff.truncado, false);
    const porRuta = Object.fromEntries(diff.archivos.map((a) => [a.ruta, a]));
    assert.equal(porRuta['a.txt'].estado, 'M');
    assert.equal(porRuta['a.txt'].adiciones, 1);
    assert.equal(porRuta['b.txt'].estado, 'A');
    assert.match(diff.parche, /a\.txt/);
    assert.match(diff.parche, /\+dos/);
  });
});

test('diff: sin baseCommit informa disponible false con motivo sin_base', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'diff0002', { estado: 'succeeded', repo: '/noexiste', rama: 'x' });
  await conServidor({ baseDir: base }, async (url) => {
    const diff = await (await fetch(`${url}/api/trabajos/diff0002/diff`)).json();
    assert.deepEqual(diff, {
      archivos: [],
      parche: '',
      truncado: false,
      disponible: false,
      motivo: 'sin_base',
      detalle: '',
    });
  });
});

test('diff: pasa -c safe.directory con el cwd concreto y nunca con *', async () => {
  const llamadas = [];
  const ejecutar = async (args, opciones) => {
    llamadas.push({ args, cwd: opciones && opciones.cwd });
    return { codigo: 0, stdout: '', stderr: '' };
  };
  const diff = await diffDeTrabajo(
    { baseCommit: 'base', repo: '/repo', worktree: '/worktree/job', rama: 'job/x' },
    { ejecutar },
  );
  assert.equal(diff.disponible, true);
  assert.ok(llamadas.length >= 3, 'debería consultar diff, name-status y numstat');
  for (const llamada of llamadas) {
    assert.equal(llamada.args[0], '-c');
    assert.equal(llamada.args[1], `safe.directory=${llamada.cwd}`);
    assert.notEqual(llamada.args[1], 'safe.directory=*');
    assert.equal(llamada.args[2], 'diff');
  }
});

test('diff: un git que rechaza por propiedad informa git_fallo con el detalle', async () => {
  const ejecutar = async () => ({
    codigo: 128,
    stdout: '',
    stderr: 'fatal: detected dubious ownership in repository at /mnt/c/repo\npista: agregá safe.directory',
  });
  const diff = await diffDeTrabajo({ baseCommit: 'base', repo: '/repo', worktree: '/worktree/x' }, { ejecutar });
  assert.equal(diff.disponible, false);
  assert.equal(diff.motivo, 'git_fallo');
  assert.equal(diff.detalle, 'fatal: detected dubious ownership in repository at /mnt/c/repo');
});

test('diff: commit del resultado inexistente informa commit_inexistente', async () => {
  const ejecutar = async () => ({ codigo: 128, stdout: '', stderr: 'fatal: bad object deadbeef\n' });
  const diff = await diffDeTrabajo(
    { baseCommit: 'base', repo: '/repo', resultado: { commit: 'deadbeef' } },
    { ejecutar },
  );
  assert.equal(diff.disponible, false);
  assert.equal(diff.motivo, 'commit_inexistente');
  assert.match(diff.detalle, /bad object/);
});

test('diff: usa resultado.commit cuando el worktree y la rama ya no existen', async () => {
  const { base, jobs } = crearEstado();
  const { repo, sha } = crearRepoGit();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\ndos\n');
  fs.writeFileSync(path.join(repo, 'nuevo.txt'), 'creado\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'trabajo']);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  // La rama vuelve a la base: el commit queda colgado pero sigue existiendo en el repo.
  git(repo, ['reset', '-q', '--hard', sha]);
  crearJob(jobs, 'fall0001', {
    estado: 'merged',
    repo,
    baseCommit: sha,
    rama: 'job/ya-no-existe',
    resultado: { commit },
  });
  await conServidor({ baseDir: base }, async (url) => {
    const diff = await (await fetch(`${url}/api/trabajos/fall0001/diff`)).json();
    assert.equal(diff.disponible, true);
    assert.match(diff.parche, /nuevo\.txt/);
    assert.match(diff.parche, /\+creado/);
    const rutas = diff.archivos.map((a) => a.ruta);
    assert.ok(rutas.includes('nuevo.txt'));
  });
});

test('alcance: writes, protegidas desde la config, tocados, fuera y resultado', async () => {
  const { base, jobs } = crearEstado();
  const { repo, sha } = crearRepoGit();
  const mutaciones = { detectada: 1, total: 1 };
  const revision = { veredicto: 'APROBADO' };
  crearJob(
    jobs,
    'alc00001',
    { estado: 'succeeded', repo, worktree: repo, baseCommit: sha, mode: 'safe', writes: ['a.txt'], resultado: { mutaciones, revision } },
    { config: { agent: { orq: { permission: { edit: { '*': 'deny', 'a.txt': 'allow', 'secreto/**': 'deny' } } } } } },
  );
  fs.writeFileSync(path.join(repo, 'a.txt'), 'cambiado\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'fuera\n');
  git(repo, ['add', '.']);
  await conServidor({ baseDir: base }, async (url) => {
    const alcance = await (await fetch(`${url}/api/trabajos/alc00001/alcance`)).json();
    assert.deepEqual(alcance.writes, ['a.txt']);
    assert.deepEqual(alcance.protegidas, ['secreto/**']);
    const rutas = alcance.tocados.map((t) => t.ruta).sort();
    assert.deepEqual(rutas, ['a.txt', 'c.txt']);
    assert.deepEqual(alcance.fuera, ['c.txt']);
    assert.deepEqual(alcance.mutaciones, mutaciones);
    assert.deepEqual(alcance.revision, revision);
  });
});

test('eventos: filtra por jobId; sin registro devuelve vacío', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'even0001', { estado: 'running' }, { stderr: 'x' });
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  registro.registrar({ tipo: 'job.creado', jobId: 'even0001' });
  registro.registrar({ tipo: 'job.fin', jobId: 'oteo0001' });
  await conServidor({ baseDir: base, registro }, async (url) => {
    const solo = await (await fetch(`${url}/api/trabajos/even0001/eventos`)).json();
    assert.deepEqual(solo.map((e) => e.jobId), ['even0001']);
  });
  await conServidor({ baseDir: base }, async (url) => {
    const vacio = await (await fetch(`${url}/api/trabajos/even0001/eventos`)).json();
    assert.deepEqual(vacio, []);
  });
});

test('pizarrón: /api/pizarron vacío si no existe y documento si está', async () => {
  const { base } = crearEstado();
  await conServidor({ baseDir: base }, async (url) => {
    const vacio = await (await fetch(`${url}/api/pizarron`)).json();
    assert.deepEqual(vacio, { version: 0, actualizado: 0, claves: {}, notas: [] });
  });
  const entrada = {
    valor: { path: '/v1/salud' },
    nota: 'definido',
    jobId: 'abc12345',
    ts: AHORA,
    historial: [{ valor: {}, jobId: 'otro0001', ts: AHORA, conflicto: true }],
  };
  fs.writeFileSync(
    path.join(base, 'pizarron.json'),
    JSON.stringify({ version: 7, actualizado: AHORA, claves: { 'api.ruta': entrada }, notas: [{ jobId: 'abc12345', ts: AHORA, texto: 'hola' }] }),
  );
  await conServidor({ baseDir: base }, async (url) => {
    const doc = await (await fetch(`${url}/api/pizarron`)).json();
    assert.equal(doc.version, 7);
    assert.equal(doc.actualizado, AHORA);
    assert.equal(doc.claves['api.ruta'].valor.path, '/v1/salud');
    assert.equal(doc.claves['api.ruta'].historial[0].conflicto, true);
    assert.equal(doc.notas[0].texto, 'hola');
  });
});

test('stream: emite trabajos tras un cambio y rechaza al noveno cliente', async () => {
  const { base, jobs } = crearEstado();
  const dir = crearJob(jobs, 'stre0001', { estado: 'running' });
  await conServidor(
    { baseDir: base, stream: { intervaloRevisionMs: 20, intervaloEstadoMs: 10_000, intervaloKeepaliveMs: 10_000, maxClientes: 1 } },
    async (url) => {
      const control = new AbortController();
      const primero = await fetch(`${url}/api/stream`, { signal: control.signal });
      assert.equal(primero.status, 200);
      assert.equal(primero.headers.get('content-type'), 'text/event-stream; charset=utf-8');

      // Ya hay un cliente: el segundo recibe 503.
      const segundo = await fetch(`${url}/api/stream`);
      assert.equal(segundo.status, 503);

      // Un cambio de estado dispara el evento `trabajos`.
      fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id: 'stre0001', estado: 'succeeded', creadoEn: AHORA - 1000 }));
      const texto = await esperarEvento(primero, 'event: trabajos');
      assert.match(texto, /"estado":"succeeded"/);
      control.abort();
    },
  );
});

test('stream: al desconectar limpia timers y libera el cupo', () => {
  const activos = new Set();
  const temporizadores = {
    setInterval: (fn, ms) => {
      const id = { fn, ms };
      activos.add(id);
      return id;
    },
    clearInterval: (id) => activos.delete(id),
  };
  const flujo = crearFlujoEventos({ temporizadores, trabajos: () => [], estado: () => ({}), maxClientes: 1 });
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { writeHead() {}, write() {}, end() {} });
  assert.equal(flujo.atender(req, res), true);
  assert.equal(flujo.cantidadClientes(), 1);
  assert.equal(activos.size, 3); // revisión, estado y keepalive

  const res2 = Object.assign(new EventEmitter(), { writeHead() {}, write() {}, end() {} });
  assert.equal(flujo.atender(new EventEmitter(), res2), false); // cupo lleno
  assert.equal(flujo.cantidadClientes(), 1);

  req.emit('close');
  assert.equal(flujo.cantidadClientes(), 0);
  assert.equal(activos.size, 0); // sin timers colgados

  // Cerrar el servidor de todos modos no rompe y sigue liberando.
  flujo.atender(new EventEmitter(), res2);
  assert.equal(flujo.cantidadClientes(), 1);
  flujo.cerrar();
  assert.equal(flujo.cantidadClientes(), 0);
  assert.equal(activos.size, 0);
});
