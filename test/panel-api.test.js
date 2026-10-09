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
import { normalizarLimiteLista, LIMITE_LISTA_POR_DEFECTO } from '../src/panel/datos.js';

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

test('listado: liviano (sin prompt/transcript), con repo, advertencias y writes recortados', async () => {
  const { base, jobs } = crearEstado();
  const writes = Array.from({ length: 12 }, (_, i) => `src/f${i}.js`);
  crearJob(
    jobs,
    'list0001',
    {
      estado: 'succeeded',
      repoNombre: 'compras',
      writes,
      prompt: 'instrucción muy larga',
      resultado: { advertencias: ['rr', 'alcance'] },
    },
    { stderr: 'transcript completo', stdout: 'respuesta' },
  );
  await conServidor({ baseDir: base }, async (url) => {
    const cuerpo = await (await fetch(`${url}/api/trabajos`)).json();
    assert.equal(cuerpo.total, 1);
    const [trabajo] = cuerpo.trabajos;
    // El listado ya no arrastra el prompt ni el transcript: eso es del detalle.
    assert.equal('prompt' in trabajo, false);
    assert.equal('transcript' in trabajo, false);
    assert.equal('respuesta' in trabajo, false);
    assert.equal(trabajo.repoNombre, 'compras');
    assert.equal(trabajo.tieneAdvertencias, true);
    assert.equal(trabajo.writes.length, 8);
    assert.deepEqual(trabajo.writes, writes.slice(0, 8));
    // Compatibilidad: los campos de siempre siguen presentes.
    for (const campo of ['id', 'titulo', 'estado', 'modo', 'modelo', 'rama', 'creadoEn', 'finEn', 'duracionS', 'semaforo']) {
      assert.ok(campo in trabajo, `falta ${campo}`);
    }
  });
});

test('listado: respeta ?limite, ?repo y pagina con ?desde (id o timestamp)', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'alfa0001', { estado: 'succeeded', repoNombre: 'alfa', creadoEn: AHORA - 1000 });
  crearJob(jobs, 'alfa0002', { estado: 'succeeded', repoNombre: 'alfa', creadoEn: AHORA - 2000 });
  crearJob(jobs, 'alfa0003', { estado: 'succeeded', repoNombre: 'alfa', creadoEn: AHORA - 3000 });
  crearJob(jobs, 'beta0001', { estado: 'succeeded', repoNombre: 'beta', creadoEn: AHORA - 500 });
  await conServidor({ baseDir: base }, async (url) => {
    const completa = await (await fetch(`${url}/api/trabajos`)).json();
    assert.equal(completa.total, 4);
    assert.deepEqual(completa.trabajos.map((t) => t.id), ['beta0001', 'alfa0001', 'alfa0002', 'alfa0003']);

    const dos = await (await fetch(`${url}/api/trabajos?limite=2`)).json();
    assert.equal(dos.trabajos.length, 2);
    assert.equal(dos.total, 4);

    const alfa = await (await fetch(`${url}/api/trabajos?repo=alfa`)).json();
    assert.equal(alfa.total, 3);
    assert.deepEqual(alfa.trabajos.map((t) => t.id), ['alfa0001', 'alfa0002', 'alfa0003']);

    const alfaUno = await (await fetch(`${url}/api/trabajos?repo=alfa&limite=1`)).json();
    assert.deepEqual(alfaUno.trabajos.map((t) => t.id), ['alfa0001']);

    // `desde` con un id devuelve los siguientes en el orden de la lista.
    const porId = await (await fetch(`${url}/api/trabajos?desde=alfa0001`)).json();
    assert.deepEqual(porId.trabajos.map((t) => t.id), ['alfa0002', 'alfa0003']);

    // `desde` con un timestamp devuelve los de actividad más antigua.
    const porTs = await (await fetch(`${url}/api/trabajos?desde=${AHORA - 1500}`)).json();
    assert.deepEqual(porTs.trabajos.map((t) => t.id), ['alfa0002', 'alfa0003']);
  });
});

test('limite: por defecto 300 y acotado a 1000', () => {
  assert.equal(LIMITE_LISTA_POR_DEFECTO, 300);
  assert.equal(normalizarLimiteLista(undefined), 300);
  assert.equal(normalizarLimiteLista(''), 300);
  assert.equal(normalizarLimiteLista('0'), 300);
  assert.equal(normalizarLimiteLista('nan'), 300);
  assert.equal(normalizarLimiteLista('42'), 42);
  assert.equal(normalizarLimiteLista('999999'), 1000);
});

test('detalle: prompt y transcript truncados a 64 KB con la bandera truncado', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'gran0001', { estado: 'succeeded', prompt: 'a'.repeat(70_000) }, { stderr: 'INICIO' + 'b'.repeat(70_000) });
  crearJob(jobs, 'chic0001', { estado: 'succeeded', prompt: 'corto' }, { stderr: 'hola' });
  await conServidor({ baseDir: base }, async (url) => {
    const grande = await (await fetch(`${url}/api/trabajos/gran0001`)).json();
    assert.equal(grande.truncado, true);
    assert.equal(Buffer.byteLength(grande.prompt), 65_536);
    assert.ok(Buffer.byteLength(grande.transcript) <= 65_536 + 64, 'el transcript no debería crecer sin control');
    assert.equal(grande.transcript.includes('INICIO'), false, 'debería haberse recortado el comienzo');

    const chico = await (await fetch(`${url}/api/trabajos/chic0001`)).json();
    assert.equal(chico.truncado, false);
    assert.equal(chico.prompt, 'corto');
    assert.equal(chico.transcript, 'hola');
  });
});

test('cabeceras: las respuestas JSON llevan nosniff y no-store', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'cabez001', { estado: 'running' });
  await conServidor({ baseDir: base }, async (url) => {
    for (const ruta of ['/api/estado', '/api/trabajos', '/api/trabajos/cabez001', '/api/nope']) {
      const respuesta = await fetch(`${url}${ruta}`);
      assert.equal(respuesta.headers.get('x-content-type-options'), 'nosniff', ruta);
      assert.equal(respuesta.headers.get('cache-control'), 'no-store', ruta);
    }
  });
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

test('historial: reconstruye los trabajos sin registro y no duplica los que sí lo tienen', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'viejo001', {
    estado: 'succeeded',
    titulo: 'Trabajo viejo',
    creadoEn: AHORA - 9000,
    inicioEn: AHORA - 8000,
    finEn: AHORA - 7000,
    motivoFin: null,
  });
  crearJob(jobs, 'nuevo001', { estado: 'running', creadoEn: AHORA - 1000 });
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  registro.registrar({ tipo: 'job.creado', jobId: 'nuevo001' });
  await conServidor({ baseDir: base, registro }, async (url) => {
    const todos = await (await fetch(`${url}/api/eventos`)).json();
    const deViejo = todos.eventos.filter((e) => e.jobId === 'viejo001');
    assert.deepEqual(deViejo.map((e) => e.tipo), ['job.fin', 'job.estado', 'job.creado']);
    assert.ok(deViejo.every((e) => e.origen === 'reconstruido'), 'los viejos se marcan reconstruido');
    assert.equal(deViejo[0].estado, 'succeeded');

    // El trabajo CON registro no se duplica ni se reconstruye.
    const deNuevo = todos.eventos.filter((e) => e.jobId === 'nuevo001');
    assert.deepEqual(deNuevo.map((e) => e.tipo), ['job.creado']);
    assert.equal(deNuevo[0].origen, 'registro');

    // El orden final es por fecha descendente mezclando ambos orígenes.
    const fechas = todos.eventos.map((e) => e.ts);
    assert.deepEqual(fechas, [...fechas].sort((a, b) => b - a));

    // Los filtros siguen funcionando sobre el historial mezclado.
    const fin = await (await fetch(`${url}/api/eventos?tipo=job.fin`)).json();
    assert.deepEqual(fin.eventos.map((e) => e.jobId), ['viejo001']);
    const porJob = await (await fetch(`${url}/api/eventos?jobId=viejo001`)).json();
    assert.equal(porJob.eventos.length, 3);
    const rango = await (await fetch(`${url}/api/eventos?desde=${AHORA - 7500}`)).json();
    assert.deepEqual(rango.eventos.map((e) => e.jobId), ['nuevo001', 'viejo001']);

    // El endpoint por trabajo también reconstruye.
    const delTrabajo = await (await fetch(`${url}/api/trabajos/viejo001/eventos`)).json();
    assert.equal(delTrabajo.length, 3);
    assert.equal(delTrabajo[0].origen, 'reconstruido');
  });
});

test('auditoría: pagina con «Cargar más» (límite 200) y respeta ?limite', async () => {
  const { base, jobs } = crearEstado();
  for (const [indice, id] of ['p0000001', 'p0000002', 'p0000003'].entries()) {
    crearJob(jobs, id, { estado: 'queued', creadoEn: AHORA - (indice + 1) * 1000 });
  }
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  await conServidor({ baseDir: base, registro }, async (url) => {
    const html = await (await fetch(`${url}/auditoria?limite=1`)).text();
    assert.match(html, /Cargar más/);
    assert.match(html, /limite=201/);
    assert.equal((html.match(/<time/g) ?? []).length, 1); // una sola fila visible

    // Sin filtros sobra una página: no aparece el enlace.
    const completo = await (await fetch(`${url}/auditoria`)).text();
    assert.doesNotMatch(completo, /Cargar más/);
    assert.equal((completo.match(/<time/g) ?? []).length, 3);

    const api = await (await fetch(`${url}/api/eventos?limite=2`)).json();
    assert.equal(api.eventos.length, 2);
  });
});

test('auditoría: la etiqueta es humana y el tipo crudo queda en el title; los viejos llevan insignia histórico', async () => {
  const { base, jobs } = crearEstado();
  crearJob(jobs, 'viejo002', { estado: 'succeeded', creadoEn: AHORA - 5000, inicioEn: AHORA - 4000, finEn: AHORA - 3000 });
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  await conServidor({ baseDir: base, registro }, async (url) => {
    const html = await (await fetch(`${url}/auditoria`)).text();
    assert.match(html, /Trabajo creado/);
    assert.match(html, /Trabajo terminado/);
    assert.match(html, /Cambio de estado/);
    assert.match(html, /title="job\.creado"/);
    assert.match(html, /class="badge badge-historico">histórico/);
    // El trabajo se enlaza y muestra su título cuando lo tiene.
    assert.match(html, /href="\/\?job=viejo002"/);
  });
});

