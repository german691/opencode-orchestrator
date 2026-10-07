import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ejecutar } from '../src/core/runner.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(AQUI, 'fixtures', 'opencode-falso.js');
const NODE = process.execPath;

// El runner de tests marca a sus hijos con NODE_TEST_CONTEXT; el fixture lo usa
// para no ejecutarse como prueba. Al lanzarlo como proceso real lo quitamos.
const ENTORNO = { ...process.env };
delete ENTORNO.NODE_TEST_CONTEXT;

/** Igual que `ejecutar`, pero sin el marcador del runner de tests en el entorno. */
const correr = (opciones) => ejecutar({ env: ENTORNO, ...opciones });

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Directorio temporal propio de cada prueba. */
function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-fake-'));
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

/** Muerte best-effort de cualquier resto y comprobación de que no queda nada. */
async function asegurarLimpio(pgid, pids = []) {
  if (Number.isInteger(pgid) && pgid > 0) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* ya no existe */
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ya no existe */
    }
  }
  for (const pid of pids) {
    await esperar(() => !pidVivo(pid), 1500, 10);
  }
}

test('opencode-falso: vuelca los argumentos recibidos y las variables relevantes', async () => {
  const dir = dirTemporal();
  const volcado = path.join(dir, 'volcado.json');
  const prompt = 'prompt con "comillas", `backticks`, $VAR y ; rm -rf /';

  const resultado = await correr({
    cmd: NODE,
    args: [FIXTURE, 'run', '--standalone', '-f', 'a.js', prompt],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    graceMs: 200,
    env: { ...ENTORNO, ORQ_FAKE_VOLCADO: volcado },
  });

  try {
    assert.equal(resultado.motivo, 'exit');
    assert.equal(resultado.code, 0);
    assert.ok(fs.existsSync(volcado), 'debe existir el volcado');
    const datos = JSON.parse(fs.readFileSync(volcado, 'utf8'));
    assert.deepEqual(datos.args, ['run', '--standalone', '-f', 'a.js', prompt]);
    assert.equal(datos.cwd, fs.realpathSync(dir));
    assert.equal(datos.opencodeConfig, null);
    assert.equal(datos.opencodeConfigDir, null);
    assert.equal(datos.config, null);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('opencode-falso: vuelca el contenido del archivo apuntado por OPENCODE_CONFIG', async () => {
  const dir = dirTemporal();
  const volcado = path.join(dir, 'volcado.json');
  const rutaConfig = path.join(dir, 'opencode.jsonc');
  const contenido = '{"agente":"demo"}';
  fs.writeFileSync(rutaConfig, contenido);

  const resultado = await correr({
    cmd: NODE,
    args: [FIXTURE, 'run'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    graceMs: 200,
    env: { ...ENTORNO, ORQ_FAKE_VOLCADO: volcado, OPENCODE_CONFIG: rutaConfig },
  });

  try {
    const datos = JSON.parse(fs.readFileSync(volcado, 'utf8'));
    assert.equal(datos.opencodeConfig, rutaConfig);
    assert.equal(datos.config, contenido);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('opencode-falso: escribe los archivos indicados creando directorios', async () => {
  const dir = dirTemporal();
  const resultado = await correr({
    cmd: NODE,
    args: [FIXTURE, 'run'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    graceMs: 200,
    env: { ...ENTORNO, ORQ_FAKE_ESCRIBIR: 'uno.txt;a/b/dos.txt;c/d/tres.txt' },
  });

  try {
    assert.equal(resultado.code, 0);
    for (const relativa of ['uno.txt', 'a/b/dos.txt', 'c/d/tres.txt']) {
      const ruta = path.join(dir, relativa);
      assert.ok(fs.existsSync(ruta), `debe existir ${relativa}`);
      assert.match(fs.readFileSync(ruta, 'utf8'), /opencode-falso/);
    }
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('opencode-falso: imprime exactamente N bytes por stdout', async () => {
  const dir = dirTemporal();
  const out = path.join(dir, 'out.log');
  const resultado = await correr({
    cmd: NODE,
    args: [FIXTURE, 'run'],
    cwd: dir,
    stdoutPath: out,
    timeoutMs: 5000,
    idleTimeoutMs: 5000,
    graceMs: 200,
    env: { ...ENTORNO, ORQ_FAKE_SALIDA_BYTES: '4096' },
  });

  try {
    assert.equal(resultado.code, 0);
    assert.equal(fs.statSync(out).size, 4096);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('opencode-falso: sale con el código indicado', async () => {
  const dir = dirTemporal();
  const resultado = await correr({
    cmd: NODE,
    args: [FIXTURE, 'run'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    graceMs: 200,
    env: { ...ENTORNO, ORQ_FAKE_SALIDA_CODIGO: '7' },
  });

  try {
    assert.equal(resultado.motivo, 'exit');
    assert.equal(resultado.code, 7);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('opencode-falso: espera ORQ_FAKE_DORMIR antes de salir', async () => {
  const dir = dirTemporal();
  const inicio = Date.now();
  const resultado = await correr({
    cmd: NODE,
    args: [FIXTURE, 'run'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    graceMs: 200,
    env: { ...ENTORNO, ORQ_FAKE_DORMIR: '150' },
  });
  const transcurrido = Date.now() - inicio;

  try {
    assert.equal(resultado.code, 0);
    assert.ok(transcurrido >= 150, `debe dormir al menos 150 ms (${transcurrido})`);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('opencode-falso: con ORQ_FAKE_IGNORA_TERM muere por SIGKILL tras el grace', async () => {
  const dir = dirTemporal();
  const resultado = await correr({
    cmd: NODE,
    args: [FIXTURE, 'run'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 200,
    idleTimeoutMs: 10000,
    graceMs: 300,
    env: { ...ENTORNO, ORQ_FAKE_IGNORA_TERM: '1' },
  });

  try {
    assert.equal(resultado.motivo, 'timeout');
    assert.equal(resultado.signal, 'SIGKILL');
    assert.ok(resultado.duracionMs >= 300, `debe respetar el grace (${resultado.duracionMs} ms)`);
    assert.equal(pidVivo(resultado.pid), false);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('opencode-falso: el nieto de larga vida muere con el grupo al cancelar', async () => {
  const dir = dirTemporal();
  const archivoPid = path.join(dir, 'nieto.pid');
  const control = correr({
    cmd: NODE,
    args: [FIXTURE, 'run'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 10000,
    idleTimeoutMs: 10000,
    graceMs: 300,
    env: { ...ENTORNO, ORQ_FAKE_NIETO: '1', ORQ_FAKE_PIDFILE: archivoPid, ORQ_FAKE_DORMIR: '10000' },
  });

  let pidNieto = null;
  try {
    assert.ok(await esperar(() => fs.existsSync(archivoPid)), 'el fixture debe anotar el pid del nieto');
    pidNieto = Number(fs.readFileSync(archivoPid, 'utf8').trim());
    assert.ok(pidVivo(pidNieto), 'el nieto debe estar vivo antes de cancelar');

    control.cancelar();
    const resultado = await control;
    assert.equal(resultado.motivo, 'cancelado');
    assert.ok(await esperar(() => !pidVivo(pidNieto)), 'el nieto debe morir con el grupo');
  } finally {
    await asegurarLimpio(control.pid, [pidNieto]);
  }
});
