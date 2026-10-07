import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ejecutar, existeGrupo, matarGrupo } from '../src/core/runner.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(AQUI, 'fixtures');
const NODE = process.execPath;

// El runner de tests marca a sus hijos con NODE_TEST_CONTEXT; los fixtures lo usan
// para no ejecutarse como pruebas. Al lanzarlos como procesos reales lo quitamos.
const ENTORNO = { ...process.env };
delete ENTORNO.NODE_TEST_CONTEXT;

/** Igual que `ejecutar`, pero sin el marcador del runner de tests en el entorno. */
const correr = (opciones) => ejecutar({ env: ENTORNO, ...opciones });

/** Ruta a un fixture. @param {string} nombre */
const fixture = (nombre) => path.join(FIXTURES, nombre);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Directorio temporal propio de cada prueba. */
function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-runner-'));
}

/**
 * Muerte best-effort de cualquier resto y comprobación de que no queda nada.
 * Falla la prueba si algún proceso o grupo siguiera vivo.
 * @param {number|null} pgid
 * @param {number[]} pids
 */
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
  if (Number.isInteger(pgid) && pgid > 0) {
    await esperar(() => !existeGrupo(pgid), 1500, 10);
    assert.equal(existeGrupo(pgid), false, `quedó vivo el grupo ${pgid}`);
  }
  for (const pid of pids) {
    await esperar(() => !pidVivo(pid), 1500, 10);
    assert.equal(pidVivo(pid), false, `quedó vivo el proceso ${pid}`);
  }
}

test('runner: salida normal con exit 0, logs y onSalida', async () => {
  const dir = dirTemporal();
  const out = path.join(dir, 'sub', 'stdout.log');
  const err = path.join(dir, 'sub', 'stderr.log');
  const fragmentos = [];

  const resultado = await correr({
    cmd: NODE,
    args: [fixture('eco.js'), '0'],
    cwd: dir,
    stdoutPath: out,
    stderrPath: err,
    timeoutMs: 5000,
    idleTimeoutMs: 5000,
    graceMs: 200,
    onSalida: (evento) => fragmentos.push(evento),
  });

  try {
    assert.equal(resultado.motivo, 'exit');
    assert.equal(resultado.code, 0);
    assert.equal(resultado.signal, null);
    assert.ok(Number.isInteger(resultado.pid) && resultado.pid > 0);
    assert.equal(resultado.pgid, resultado.pid);
    assert.ok(resultado.duracionMs >= 0);
    // El runner creó el directorio del anidado.
    assert.match(fs.readFileSync(out, 'utf8'), /salida-normal/);
    assert.match(fs.readFileSync(err, 'utf8'), /error-normal/);
    // Cada fragmento se entregó con su canal.
    assert.equal(fragmentos.map((f) => f.canal).includes('stdout'), true);
    assert.equal(fragmentos.map((f) => f.canal).includes('stderr'), true);
    assert.equal(fragmentos.map((f) => f.texto).join(''), 'salida-normal\nerror-normal\n');
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: salida normal con exit 3 reporta el código', async () => {
  const dir = dirTemporal();
  const resultado = await correr({
    cmd: NODE,
    args: [fixture('eco.js'), '3'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    stderrPath: path.join(dir, 'err.log'),
    timeoutMs: 5000,
    graceMs: 200,
  });

  try {
    assert.equal(resultado.motivo, 'exit');
    assert.equal(resultado.code, 3);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: 5 MB de stdout llegan completos al archivo sin crecer la memoria', async () => {
  const dir = dirTemporal();
  const out = path.join(dir, 'stdout.log');
  const memoriaAntes = process.memoryUsage().heapUsed;

  const resultado = await correr({
    cmd: NODE,
    args: [fixture('volumen.js'), '5'],
    cwd: dir,
    stdoutPath: out,
    timeoutMs: 30000,
    idleTimeoutMs: 30000,
    graceMs: 300,
  });

  // Se mide el heap (donde viviría una acumulación por concatenación de strings,
  // el bug de la v2) tras dar una vuelta al bucle para dejar paso a la recolección.
  await dormir(50);
  const memoriaDespues = process.memoryUsage().heapUsed;

  try {
    assert.equal(resultado.motivo, 'exit');
    assert.equal(resultado.code, 0);
    assert.equal(fs.statSync(out).size, 5 * 1024 * 1024);
    // El resultado NO transporta la salida: se fue al archivo.
    assert.equal('stdout' in resultado, false);
    assert.equal('stderr' in resultado, false);
    // Sin acumular la salida, el heap no crece de forma proporcional a 5 MB.
    const crecimiento = memoriaDespues - memoriaAntes;
    assert.ok(crecimiento < 4 * 1024 * 1024, `el heap creció ${crecimiento} bytes`);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: timeout total mata el grupo', async () => {
  const dir = dirTemporal();
  const out = path.join(dir, 'out.log');
  const inicio = Date.now();
  const resultado = await correr({
    cmd: NODE,
    args: [fixture('idle.js')],
    cwd: dir,
    stdoutPath: out,
    timeoutMs: 200,
    idleTimeoutMs: 10000,
    graceMs: 200,
  });
  const transcurrido = Date.now() - inicio;

  try {
    assert.equal(resultado.motivo, 'timeout');
    assert.ok(transcurrido >= 200, `debería esperar el timeout (${transcurrido} ms)`);
    assert.ok(transcurrido < 3000, `no debería colgarse (${transcurrido} ms)`);
    assert.equal(existeGrupo(resultado.pgid), false);
    assert.equal(pidVivo(resultado.pid), false);
    assert.match(fs.readFileSync(out, 'utf8'), /listo/);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: timeout por inactividad cuando el proceso calla', async () => {
  const dir = dirTemporal();
  const inicio = Date.now();
  const resultado = await correr({
    cmd: NODE,
    args: [fixture('idle.js')],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 10000,
    idleTimeoutMs: 200,
    graceMs: 200,
  });
  const transcurrido = Date.now() - inicio;

  try {
    assert.equal(resultado.motivo, 'idle');
    assert.ok(transcurrido >= 200 && transcurrido < 3000, `inactividad tardó ${transcurrido} ms`);
    assert.equal(existeGrupo(resultado.pgid), false);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: la actividad reinicia el timeout por inactividad', async () => {
  const dir = dirTemporal();
  const resultado = await correr({
    cmd: NODE,
    args: [fixture('pulso.js')],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    // Márgenes holgados a propósito: bajo carga (muchos procesos a la vez) el arranque de
    // node puede tardar más que la inactividad y el test fallaba por 'idle' sin ser un bug.
    timeoutMs: 1500,
    idleTimeoutMs: 800,
    graceMs: 200,
  });

  try {
    // Con pulsos cada 40 ms nunca se supera la inactividad de 800 ms.
    assert.equal(resultado.motivo, 'timeout');
    assert.equal(existeGrupo(resultado.pgid), false);
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: un proceso que ignora SIGTERM muere por SIGKILL tras el grace', async () => {
  const dir = dirTemporal();
  const resultado = await correr({
    cmd: NODE,
    args: [fixture('ignora_sigterm.js')],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 200,
    idleTimeoutMs: 10000,
    graceMs: 300,
  });

  try {
    assert.equal(resultado.motivo, 'timeout');
    // Tuvo que esperar al menos el grace antes del SIGKILL.
    assert.ok(resultado.duracionMs >= 300, `debería respetar el grace (${resultado.duracionMs} ms)`);
    assert.equal(existeGrupo(resultado.pgid), false);
    assert.equal(pidVivo(resultado.pid), false);
    assert.equal(resultado.signal, 'SIGKILL');
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: cancelar mata también al nieto', async () => {
  const dir = dirTemporal();
  const archivoPid = path.join(dir, 'nieto.pid');
  const control = correr({
    cmd: NODE,
    args: [fixture('nieto.js'), archivoPid, 'vive'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 10000,
    idleTimeoutMs: 10000,
    graceMs: 300,
  });

  let pidNieto = null;
  try {
    assert.ok(await esperar(() => fs.existsSync(archivoPid)), 'el fixture debe anotar el pid del nieto');
    pidNieto = Number(fs.readFileSync(archivoPid, 'utf8').trim());
    assert.ok(pidVivo(pidNieto), 'el nieto debe estar vivo antes de cancelar');
    const pgid = control.pid;

    control.cancelar();
    const resultado = await control;

    assert.equal(resultado.motivo, 'cancelado');
    assert.ok(resultado.duracionMs < 3000);
    assert.ok(await esperar(() => !pidVivo(pidNieto)), 'el nieto debe morir con el grupo');
    assert.equal(existeGrupo(resultado.pgid), false);
  } finally {
    await asegurarLimpio(control.pid, [pidNieto]);
  }
});

test('runner: un nieto que mantiene stdout abierto no cuelga la promesa', async () => {
  const dir = dirTemporal();
  const archivoPid = path.join(dir, 'nieto2.pid');
  const inicio = Date.now();
  const resultado = await correr({
    cmd: NODE,
    args: [fixture('nieto.js'), archivoPid, 'padre_muere'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    idleTimeoutMs: 5000,
    graceMs: 300,
  });
  const transcurrido = Date.now() - inicio;
  const pidNieto = Number(fs.readFileSync(archivoPid, 'utf8').trim());

  try {
    assert.equal(resultado.motivo, 'exit');
    assert.equal(resultado.code, 0);
    assert.ok(transcurrido < 3000, `no debe colgarse esperando la tubería (${transcurrido} ms)`);
    assert.ok(await esperar(() => !pidVivo(pidNieto)), 'el nieto no debe quedar vivo');
    assert.equal(existeGrupo(resultado.pgid), false);
  } finally {
    await asegurarLimpio(resultado.pgid, [pidNieto]);
  }
});

test('runner: cancelar antes de arrancar (señal ya abortada) no lanza nada', async () => {
  const dir = dirTemporal();
  const controlador = new AbortController();
  controlador.abort();

  const resultado = await correr({
    cmd: NODE,
    args: [fixture('idle.js')],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    signal: controlador.signal,
    timeoutMs: 5000,
    graceMs: 200,
  });

  assert.equal(resultado.motivo, 'cancelado');
  assert.equal(resultado.pid, null);
  assert.equal(resultado.pgid, null);
});

test('runner: cancelar justo tras lanzar mata el grupo', async () => {
  const dir = dirTemporal();
  const control = correr({
    cmd: NODE,
    args: [fixture('idle.js')],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 10000,
    graceMs: 200,
  });

  try {
    control.cancelar();
    const resultado = await control;
    assert.equal(resultado.motivo, 'cancelado');
    assert.equal(existeGrupo(resultado.pgid), false);
  } finally {
    await asegurarLimpio(control.pid, []);
  }
});

test('runner: cancelar por AbortSignal en pleno vuelo', async () => {
  const dir = dirTemporal();
  const controlador = new AbortController();
  const control = correr({
    cmd: NODE,
    args: [fixture('idle.js')],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    signal: controlador.signal,
    timeoutMs: 10000,
    graceMs: 200,
  });

  try {
    await dormir(80); // damos tiempo a que arranque de verdad
    controlador.abort();
    const resultado = await control;
    assert.equal(resultado.motivo, 'cancelado');
    assert.equal(existeGrupo(resultado.pgid), false);
    assert.equal(pidVivo(resultado.pid), false);
  } finally {
    await asegurarLimpio(control.pid, []);
  }
});

test('runner: cancelar es idempotente (dos veces y tras terminar)', async () => {
  const dir = dirTemporal();
  const control = correr({
    cmd: NODE,
    args: [fixture('idle.js')],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 10000,
    graceMs: 200,
  });

  try {
    assert.doesNotThrow(() => {
      control.cancelar();
      control.cancelar();
    });
    const resultado = await control;
    assert.equal(resultado.motivo, 'cancelado');
    assert.doesNotThrow(() => control.cancelar());
  } finally {
    await asegurarLimpio(control.pid, []);
  }
});

test('runner: cancelar después de terminar no rompe', async () => {
  const dir = dirTemporal();
  const control = correr({
    cmd: NODE,
    args: [fixture('eco.js'), '0'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    graceMs: 200,
  });

  const resultado = await control;
  try {
    assert.equal(resultado.motivo, 'exit');
    assert.doesNotThrow(() => control.cancelar());
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: cmd inexistente resuelve error_al_lanzar sin lanzar excepción', async () => {
  const dir = dirTemporal();
  const resultado = await correr({
    cmd: path.join(dir, 'no-existe-bin'),
    args: [],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    stderrPath: path.join(dir, 'err.log'),
    timeoutMs: 2000,
    graceMs: 100,
  });

  assert.equal(resultado.motivo, 'error_al_lanzar');
  assert.ok(typeof resultado.mensaje === 'string' && resultado.mensaje.length > 0);
  assert.equal(resultado.pid, null);
  assert.equal(resultado.pgid, null);
});

test('runner: matarGrupo y existeGrupo son reutilizables', async () => {
  const dir = dirTemporal();
  const hijo = (await import('node:child_process')).spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const pid = hijo.pid;
  hijo.unref();

  try {
    assert.equal(existeGrupo(pid), true);
    await matarGrupo(pid, 200);
    assert.equal(existeGrupo(pid), false);
  } finally {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* ya no existe */
    }
  }
});

test('runner: onLanzado se invoca una vez, con el pid correcto, antes del primer onSalida', async () => {
  const dir = dirTemporal();
  const orden = [];
  /** @type {Array<{ pid: number, pgid: number }>} */
  const lanzamientos = [];

  const resultado = await correr({
    cmd: NODE,
    args: [fixture('eco.js'), '0'],
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 5000,
    graceMs: 200,
    onLanzado: (datos) => {
      lanzamientos.push(datos);
      orden.push('lanzado');
    },
    onSalida: () => orden.push('salida'),
  });

  try {
    assert.equal(lanzamientos.length, 1, 'onLanzado debe invocarse exactamente una vez');
    assert.equal(lanzamientos[0].pid, resultado.pid);
    assert.equal(lanzamientos[0].pgid, resultado.pgid);
    assert.equal(orden[0], 'lanzado', 'debe ser lo primero que se observa');
    assert.ok(orden.includes('salida'));
  } finally {
    await asegurarLimpio(resultado.pgid, [resultado.pid]);
  }
});

test('runner: onLanzado no se invoca si el cmd no existe', async () => {
  const dir = dirTemporal();
  let llamado = 0;
  const resultado = await correr({
    cmd: path.join(dir, 'no-existe-bin'),
    cwd: dir,
    stdoutPath: path.join(dir, 'out.log'),
    timeoutMs: 2000,
    graceMs: 100,
    onLanzado: () => {
      llamado += 1;
    },
  });

  assert.equal(resultado.motivo, 'error_al_lanzar');
  assert.equal(llamado, 0);
  assert.equal(resultado.pid, null);
});
