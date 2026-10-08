/**
 * Pruebas de extremo a extremo del SERVIDOR REAL (proceso hijo por stdio) con el
 * opencode falso y repos git temporales. Cubren lo que ninguna prueba unitaria puede:
 * el cierre limpio con trabajos en curso, la recuperación tras una caída brusca y la
 * exclusión de dos servidores sobre el mismo estado.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { existeGrupo } from '../src/core/runner.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SERVIDOR = path.join(AQUI, '..', 'src', 'server.js');
const FALSO = path.join(AQUI, 'fixtures', 'opencode-falso.js');

const temporales = [];
const servidoresVivos = new Set();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  for (const proceso of servidoresVivos) {
    try {
      proceso.kill('SIGKILL');
    } catch {
      /* ya terminó */
    }
  }
  for (const dir of temporales) fs.rmSync(dir, { recursive: true, force: true });
});

/** Directorio temporal propio. */
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-e2e-'));
  temporales.push(dir);
  return dir;
}

/** Repo git con perfil commiteado y un envoltorio ejecutable que lanza el opencode falso. */
function montarEscenario() {
  const base = tmp();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Prueba');
  git('config', 'user.email', 'prueba@test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  fs.writeFileSync(
    path.join(repo, '.opencode-orchestrator.json'),
    JSON.stringify({
      version: 1,
      name: 'e2e',
      baseBranch: 'main',
      integrationBranch: 'staging',
      protected: ['secretos/**'],
      worktrees: { root: path.join(base, 'wt') },
      accept: { default: 'test -f src/nuevo.js' },
    }),
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const envoltorio = path.join(base, 'opencode-falso.sh');
  fs.writeFileSync(envoltorio, `#!/bin/sh\nexec "${process.execPath}" "${FALSO}" "$@"\n`, { mode: 0o755 });
  return { base, repo, git, envoltorio, estado: path.join(base, 'estado') };
}

/** Arranca el servidor real y devuelve un cliente JSON-RPC mínimo. */
function iniciarServidor({ estado, envoltorio, env = {} }) {
  const entorno = { ...process.env, ORQ_STATE_DIR: estado, ORQ_OPENCODE_BIN: envoltorio, ORQ_WAIT_MS: '10000', ...env };
  // El opencode falso se vuelve inerte bajo el ejecutor de pruebas de Node (para que
  // `node --test` no lo corra como test): esa variable no debe llegar al servidor.
  delete entorno.NODE_TEST_CONTEXT;
  const proceso = spawn(process.execPath, [SERVIDOR], { env: entorno, stdio: ['pipe', 'pipe', 'pipe'] });
  servidoresVivos.add(proceso);
  let stderr = '';
  proceso.stderr.on('data', (d) => {
    stderr += d;
  });
  const esperas = new Map();
  let buffer = '';
  proceso.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const linea = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const m = JSON.parse(linea); // si el stdout se ensucia, esto lanza y la prueba falla
      esperas.get(m.id)?.(m);
    }
  });
  const salida = new Promise((resolver) => proceso.once('exit', (codigo, senal) => {
    servidoresVivos.delete(proceso);
    resolver({ codigo, senal });
  }));
  let n = 0;
  const rpc = (method, params) =>
    new Promise((resolver) => {
      n += 1;
      esperas.set(n, resolver);
      proceso.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const llamar = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { proceso, rpc, llamar, salida, stderr: () => stderr };
}

const texto = (resultado) => resultado.content[0].text;
const jobIdDe = (t) => t.match(/job_id=([0-9a-f]{8})/)[1];

async function esperarHasta(condicion, ms = 8000, paso = 50) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await condicion()) return true;
    await dormir(paso);
  }
  return false;
}

const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('el servidor expone las 9 herramientas y su stdout es solo protocolo', async () => {
  const e = montarEscenario();
  const s = iniciarServidor(e);
  const init = await s.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'opencode-orchestrator');
  const { result } = await s.rpc('tools/list');
  assert.deepEqual(
    result.tools.map((t) => t.name).sort(),
    ['opencode_cancel', 'opencode_cleanup', 'opencode_coding', 'opencode_list', 'opencode_logs', 'opencode_merge', 'opencode_profile', 'opencode_wait', 'opencode_wait_any'],
  );
  s.proceso.stdin.end();
  const { codigo } = await s.salida;
  assert.equal(codigo, 0, 'cierra con código 0 al cerrarse stdin');
});

test('flujo completo: trabajo aislado, alcance verificado, aceptación, merge a staging y la base intacta', async () => {
  const e = montarEscenario();
  const mainAntes = e.git('rev-parse', 'main').trim();
  const s = iniciarServidor({ ...e, env: { ORQ_FAKE_ESCRIBIR: 'src/nuevo.js', ORQ_FAKE_DORMIR: '100' } });

  const r = await s.llamar('opencode_coding', { prompt: 'crea src/nuevo.js', cwd: e.repo, mode: 'safe', writes: ['src/**'], title: 'e2e' });
  assert.equal(r.isError, false, texto(r));
  const t = texto(r);
  assert.match(t, /estado=succeeded/);
  assert.match(t, /archivos modificados \(1\): src\/nuevo\.js/);
  assert.match(t, /aceptacion: OK/);
  const id = jobIdDe(t);

  const m = await s.llamar('opencode_merge', { job_id: id });
  assert.equal(m.isError, false, texto(m));
  assert.equal(e.git('rev-parse', 'main').trim(), mainAntes, 'la rama base NO cambia jamás');
  assert.ok(e.git('ls-tree', '-r', '--name-only', 'staging').includes('src/nuevo.js'));

  // Un segundo merge del mismo trabajo se rechaza (ya está merged).
  const otra = await s.llamar('opencode_merge', { job_id: id });
  assert.equal(otra.isError, true);

  s.proceso.stdin.end();
  await s.salida;
});

test('un trabajo que viola el alcance queda rechazado y no se puede integrar', async () => {
  const e = montarEscenario();
  const s = iniciarServidor({ ...e, env: { ORQ_FAKE_ESCRIBIR: 'src/nuevo.js;secretos/clave.txt', ORQ_FAKE_DORMIR: '50' } });
  const r = await s.llamar('opencode_coding', { prompt: 'x', cwd: e.repo, mode: 'safe', writes: ['**'], title: 'viola' });
  assert.equal(r.isError, true);
  assert.match(texto(r), /estado=rejected/);
  assert.match(texto(r), /secretos\/clave\.txt: protegido/);
  const m = await s.llamar('opencode_merge', { job_id: jobIdDe(texto(r)) });
  assert.equal(m.isError, true);
  assert.match(texto(m), /Solo se integran trabajos succeeded/);
  s.proceso.stdin.end();
  await s.salida;
});

test('errores de uso: respuesta legible, sin traza y sin trabajo creado', async () => {
  const e = montarEscenario();
  const s = iniciarServidor(e);
  const sinWrites = await s.llamar('opencode_coding', { prompt: 'x', cwd: e.repo, mode: 'safe' });
  assert.equal(sinWrites.isError, true);
  assert.equal(texto(sinWrites), 'Error: En modo safe `writes` es obligatorio: declará qué patrones puede modificar');
  const inexistente = await s.llamar('opencode_wait', { job_id: 'deadbeef' });
  assert.equal(inexistente.isError, true);
  assert.match(texto(inexistente), /No existe el trabajo/);
  const lista = await s.llamar('opencode_list', {});
  assert.match(texto(lista), /\(sin trabajos\)/);
  s.proceso.stdin.end();
  await s.salida;
});

test('STILL RUNNING, opencode_logs y opencode_cancel: cancelar mata el grupo completo incluido el nieto', async () => {
  const e = montarEscenario();
  const pidfile = path.join(e.base, 'nieto.pid');
  const s = iniciarServidor({
    ...e,
    env: { ORQ_WAIT_MS: '400', ORQ_FAKE_DORMIR: '60000', ORQ_FAKE_NIETO: '1', ORQ_FAKE_PIDFILE: pidfile, ORQ_FAKE_SALIDA_BYTES: '200' },
  });
  const r = await s.llamar('opencode_coding', { prompt: 'largo', cwd: e.repo, mode: 'safe', writes: ['src/**'], title: 'largo' });
  assert.equal(r.isError, false);
  assert.match(texto(r), /^STILL RUNNING \| job_id=[0-9a-f]{8}/);
  const id = jobIdDe(texto(r));

  assert.ok(await esperarHasta(() => fs.existsSync(pidfile)), 'el nieto debía arrancar');
  const nieto = Number(fs.readFileSync(pidfile, 'utf8'));
  assert.ok(vivo(nieto));

  const lista = await s.llamar('opencode_list', {});
  assert.match(texto(lista), new RegExp(`job_id=${id} \\| running`));
  const logs = await s.llamar('opencode_logs', { job_id: id, canal: 'stdout', bytes: 100 });
  assert.equal(logs.isError, false);

  const cancelado = await s.llamar('opencode_cancel', { job_id: id });
  assert.match(texto(cancelado), /estado=cancelled/);
  assert.ok(await esperarHasta(() => !vivo(nieto)), 'el nieto debe morir con el grupo');

  s.proceso.stdin.end();
  await s.salida;
});

test('cerrar el servidor con un trabajo en curso mata su grupo (no quedan huérfanos)', async () => {
  const e = montarEscenario();
  const pidfile = path.join(e.base, 'nieto.pid');
  const s = iniciarServidor({
    ...e,
    env: { ORQ_WAIT_MS: '300', ORQ_FAKE_DORMIR: '60000', ORQ_FAKE_NIETO: '1', ORQ_FAKE_PIDFILE: pidfile },
  });
  const r = await s.llamar('opencode_coding', { prompt: 'largo', cwd: e.repo, mode: 'safe', writes: ['src/**'] });
  assert.match(texto(r), /^STILL RUNNING/);
  assert.ok(await esperarHasta(() => fs.existsSync(pidfile)));
  const nieto = Number(fs.readFileSync(pidfile, 'utf8'));
  const trabajo = JSON.parse(fs.readFileSync(path.join(e.estado, 'jobs', jobIdDe(texto(r)), 'job.json'), 'utf8'));
  assert.ok(Number.isInteger(trabajo.pgid) && existeGrupo(trabajo.pgid));

  s.proceso.stdin.end();
  const { codigo } = await s.salida;
  assert.equal(codigo, 0);
  assert.equal(existeGrupo(trabajo.pgid), false, 'el grupo del trabajo ya no existe');
  assert.equal(vivo(nieto), false, 'el nieto murió con el cierre');
  const final = JSON.parse(fs.readFileSync(path.join(e.estado, 'jobs', trabajo.id, 'job.json'), 'utf8'));
  assert.equal(final.estado, 'cancelled');
});

test('tras una caída brusca (SIGKILL) el siguiente arranque mata el grupo huérfano y marca el trabajo perdido', async () => {
  const e = montarEscenario();
  const pidfile = path.join(e.base, 'nieto.pid');
  const entorno = { ORQ_WAIT_MS: '300', ORQ_FAKE_DORMIR: '60000', ORQ_FAKE_NIETO: '1', ORQ_FAKE_PIDFILE: pidfile };
  const s1 = iniciarServidor({ ...e, env: entorno });
  const r = await s1.llamar('opencode_coding', { prompt: 'largo', cwd: e.repo, mode: 'safe', writes: ['src/**'] });
  const id = jobIdDe(texto(r));
  assert.ok(await esperarHasta(() => fs.existsSync(pidfile)));
  const nieto = Number(fs.readFileSync(pidfile, 'utf8'));
  const { pgid } = JSON.parse(fs.readFileSync(path.join(e.estado, 'jobs', id, 'job.json'), 'utf8'));

  s1.proceso.kill('SIGKILL'); // sin cierre ordenado: no se limpia nada
  await s1.salida;
  assert.ok(vivo(nieto), 'tras SIGKILL el grupo queda huérfano (esto es lo que hay que reparar)');

  const s2 = iniciarServidor({ ...e, env: entorno });
  await s2.rpc('initialize', {});
  assert.ok(await esperarHasta(() => !vivo(nieto)), 'el nuevo servidor mata el grupo huérfano que reconoce como suyo');
  assert.equal(existeGrupo(pgid), false);
  const perdido = JSON.parse(fs.readFileSync(path.join(e.estado, 'jobs', id, 'job.json'), 'utf8'));
  assert.equal(perdido.estado, 'lost');
  assert.equal(perdido.perdidoMotivo, 'servidor_reiniciado');
  const lista = await s2.llamar('opencode_list', {});
  assert.match(texto(lista), new RegExp(`job_id=${id} \\| lost`));

  s2.proceso.stdin.end();
  await s2.salida;
});

test('un segundo servidor sobre el mismo estado NO arranca el gestor: sus herramientas informan el motivo', async () => {
  const e = montarEscenario();
  const s1 = iniciarServidor(e);
  await s1.rpc('initialize', {});
  const s2 = iniciarServidor(e);
  await s2.rpc('initialize', {});
  const r = await s2.llamar('opencode_list', {});
  assert.equal(r.isError, true);
  assert.match(texto(r), /otro servidor activo pid \d+/);

  // El primero sigue operativo.
  const ok = await s1.llamar('opencode_list', {});
  assert.equal(ok.isError, false);

  s2.proceso.stdin.end();
  s1.proceso.stdin.end();
  await Promise.all([s1.salida, s2.salida]);

  // Al cerrarse el primero (y soltar el bloqueo) un nuevo servidor sí puede arrancar.
  const s3 = iniciarServidor(e);
  await s3.rpc('initialize', {});
  assert.equal((await s3.llamar('opencode_list', {})).isError, false);
  s3.proceso.stdin.end();
  await s3.salida;
});

test('opencode_profile muestra el perfil resuelto y detecta un perfil inválido', async () => {
  const e = montarEscenario();
  const s = iniciarServidor(e);
  const bien = await s.llamar('opencode_profile', { cwd: e.repo });
  assert.equal(bien.isError, false);
  assert.match(texto(bien), /"integrationBranch": "staging"/);

  const roto = montarEscenario();
  fs.writeFileSync(path.join(roto.repo, '.opencode-orchestrator.json'), '{ "version": 2 }');
  const mal = await s.llamar('opencode_profile', { cwd: roto.repo });
  assert.equal(mal.isError, true);
  assert.match(texto(mal), /Perfil inválido/);
  s.proceso.stdin.end();
  await s.salida;
});

test('si el cliente se va con stderr roto el servidor termina solo y no queda girando en CPU', async () => {
  // Regresión (observada en vivo): al irse el cliente, stderr queda con el pipe roto; cada
  // log() provocaba un EPIPE asíncrono → uncaughtException → otro log → otro EPIPE, en un
  // bucle infinito que dejaba el proceso huérfano al 100 % de CPU durante horas.
  const estado = tmp();
  const hijo = spawn(process.execPath, [SERVIDOR], {
    env: { ...process.env, ORQ_STATE_DIR: estado },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  servidoresVivos.add(hijo);
  const salio = new Promise((resolve) => hijo.once('exit', (codigo, senal) => resolve({ codigo, senal })));

  const respondio = new Promise((resolve) => hijo.stdout.once('data', () => resolve(true)));
  hijo.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })}\n`,
  );
  assert.equal(await Promise.race([respondio, dormir(10000).then(() => false)]), true, 'el servidor debe responder initialize');

  // El cliente "se va": se rompe el pipe de stderr y se cierra la entrada.
  hijo.stderr.destroy();
  hijo.stdout.destroy();
  hijo.stdin.end();

  const resultado = await Promise.race([salio, dormir(10000).then(() => null)]);
  assert.notEqual(resultado, null, 'el servidor debe terminar solo cuando el cliente se va');
  servidoresVivos.delete(hijo);
});
