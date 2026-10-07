import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AlmacenDeTrabajos } from '../src/core/store.js';
import { existeGrupo, matarGrupo } from '../src/core/runner.js';
import { identidadDeProceso } from '../src/core/identidad.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(AQUI, 'fixtures');
const NODE = process.execPath;
const ENTORNO = { ...process.env };
delete ENTORNO.NODE_TEST_CONTEXT;

/** Directorio temporal propio de cada prueba. */
function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-store-'));
}

/** Almacén sobre un directorio temporal nuevo. */
function almacenNuevo() {
  return new AlmacenDeTrabajos({ dir: dirTemporal() });
}

/** Espera hasta que `condicion()` sea cierta o se agote `topeMs`. */
async function esperar(condicion, topeMs = 2000, pasoMs = 20) {
  const fin = Date.now() + topeMs;
  while (Date.now() < fin) {
    if (condicion()) return true;
    await new Promise((r) => setTimeout(r, pasoMs));
  }
  return condicion();
}

test('crear/leer/listar/filtrar y orden por creación', () => {
  const almacen = almacenNuevo();
  const a = almacen.crear({ id: 'aaaa1111', creadoEn: 300, estado: 'queued', titulo: 'A' });
  const b = almacen.crear({ id: 'bbbb2222', creadoEn: 100, estado: 'running', titulo: 'B' });
  const c = almacen.crear({ id: 'cccc3333', creadoEn: 200, estado: 'queued', titulo: 'C' });

  assert.equal(a.id, 'aaaa1111');
  assert.deepEqual(almacen.leer('aaaa1111').titulo, 'A');
  assert.equal(almacen.leer('zzzz9999'), null);

  const { trabajos, corruptos } = almacen.listar();
  assert.deepEqual(
    trabajos.map((t) => t.id),
    ['aaaa1111', 'cccc3333', 'bbbb2222'], // creadoEn desc
  );
  assert.deepEqual(corruptos, []);

  assert.deepEqual(almacen.listar({ estado: 'queued' }).trabajos.map((t) => t.id), [
    'aaaa1111',
    'cccc3333',
  ]);
  assert.deepEqual(almacen.listar({ limite: 1 }).trabajos.map((t) => t.id), ['aaaa1111']);

  const generado = almacen.crear({ titulo: 'sin id' });
  assert.match(generado.id, /^[0-9a-f]{8}$/);
});

test('crear valida el id y el estado inicial', () => {
  const almacen = almacenNuevo();
  assert.throws(() => almacen.crear({ id: '../x' }), /id de trabajo inválido/);
  assert.throws(() => almacen.crear({ id: 'con/barra' }), /id de trabajo inválido/);
  assert.throws(() => almacen.crear({ id: 'MAYUS' }), /id de trabajo inválido/);
  assert.throws(() => almacen.crear({ id: 'zzzz9999', estado: 'inventado' }), /estado inicial desconocido/);
  almacen.crear({ id: 'dddd4444' });
  assert.throws(() => almacen.crear({ id: 'dddd4444' }), /Ya existe/);
});

test('ids con path traversal se rechazan en toda la API', () => {
  const almacen = almacenNuevo();
  const malos = ['../x', '..', 'a/b', '/etc/passwd', 'a\\b', ''];
  for (const malo of malos) {
    assert.throws(() => almacen.leer(malo), /id de trabajo inválido/, `leer(${JSON.stringify(malo)})`);
    assert.throws(() => almacen.actualizar(malo, { estado: 'running' }), /id de trabajo inválido/);
    assert.throws(() => almacen.rutasDeLogs(malo), /id de trabajo inválido/);
    assert.throws(() => almacen.leerCola(malo, 'stdout', 10), /id de trabajo inválido/);
    assert.throws(() => almacen.agregarEvento(malo, {}), /id de trabajo inválido/);
  }
});

test('actualizar valida transiciones y parchea atómicamente', () => {
  const almacen = almacenNuevo();
  almacen.crear({ id: 'eeee5555' });

  const actualizado = almacen.actualizar('eeee5555', { estado: 'provisioning', titulo: 'x' });
  assert.equal(actualizado.estado, 'provisioning');
  assert.equal(actualizado.titulo, 'x');
  assert.equal(typeof actualizado.creadoEn, 'number');

  // Una transición inválida no debe escribir nada.
  almacen.actualizar('eeee5555', { estado: 'running' });
  almacen.actualizar('eeee5555', { estado: 'verifying' });
  almacen.actualizar('eeee5555', { estado: 'succeeded' });
  assert.throws(() => almacen.actualizar('eeee5555', { estado: 'running' }), /Transición inválida/);
  assert.equal(almacen.leer('eeee5555').estado, 'succeeded');
  assert.throws(() => almacen.actualizar('noexiste1', { titulo: 'x' }), /No existe/);
});

test('parches concurrentes no corrompen el JSON y un temporal huérfano no molesta', async () => {
  const almacen = almacenNuevo();
  almacen.crear({ id: 'ffff6666' });

  await Promise.all([
    Promise.resolve().then(() => almacen.actualizar('ffff6666', { p1: 1 })),
    Promise.resolve().then(() => almacen.actualizar('ffff6666', { p2: 2 })),
  ]);

  const trabajo = almacen.leer('ffff6666'); // si estuviera corrupto, lanzaría
  assert.equal(trabajo.p1, 1);
  assert.equal(trabajo.p2, 2);

  // Un temporal de un corte a mitad no debe romper la lectura ni el listado.
  const rutas = almacen.rutasDeLogs('ffff6666');
  fs.writeFileSync(`${rutas.job}.tmp-huerfano`, '{"a":');
  assert.equal(almacen.leer('ffff6666').id, 'ffff6666');
  assert.deepEqual(almacen.listar().trabajos.map((t) => t.id), ['ffff6666']);
});

test('leerCola devuelve el final del log y tolera cortes multibyte', () => {
  const almacen = almacenNuevo();
  almacen.crear({ id: 'a1b2c3d4' });
  const rutas = almacen.rutasDeLogs('a1b2c3d4');
  fs.writeFileSync(rutas.stdout, '你好世界'); // 12 bytes, 4 caracteres de 3 bytes

  // Archivo más chico que los bytes pedidos: devuelve todo.
  assert.equal(almacen.leerCola('a1b2c3d4', 'stdout', 1000), '你好世界');
  // Corte en la mitad de un carácter multibyte: no aparece el reemplazo.
  const cola = almacen.leerCola('a1b2c3d4', 'stdout', 5);
  assert.equal(cola, '界');
  assert.equal(cola.includes('\uFFFD'), false);
  assert.equal(almacen.leerCola('a1b2c3d4', 'stdout', 0), '');
  assert.throws(() => almacen.leerCola('a1b2c3d4', 'otro', 5), /canal desconocido/);

  // Los eventos llevan marca de tiempo y se pueden leer en cola.
  almacen.agregarEvento('a1b2c3d4', { tipo: 'inicio' });
  const evento = JSON.parse(almacen.leerCola('a1b2c3d4', 'events', 4096).trim());
  assert.equal(evento.tipo, 'inicio');
  assert.equal(typeof evento.ocurridoEn, 'number');
});

test('auditar nunca guarda el prompt completo', () => {
  const almacen = almacenNuevo();
  const prompt = 'secreto-'.repeat(60); // 480 caracteres
  almacen.auditar({ accion: 'crear', jobId: 'aabbccdd', prompt });

  const lineas = fs.readFileSync(path.join(almacen.dir, 'audit.log'), 'utf8').trim().split('\n');
  const entrada = JSON.parse(lineas.at(-1));
  assert.equal(entrada.accion, 'crear');
  assert.equal(entrada.prompt.length, 120);
  assert.equal(entrada.promptTruncado, true);
  assert.equal(entrada.prompt, prompt.slice(0, 120));
  assert.equal(fs.readFileSync(path.join(almacen.dir, 'audit.log'), 'utf8').includes(prompt), false);

  // Un prompt anidado también se sanea.
  almacen.auditar({ detalle: { prompt: 'x'.repeat(300) } });
  const anidada = JSON.parse(fs.readFileSync(path.join(almacen.dir, 'audit.log'), 'utf8').trim().split('\n').at(-1));
  assert.equal(anidada.detalle.prompt.length, 120);
});

test('listar omite y reporta un job.json corrupto', () => {
  const almacen = almacenNuevo();
  almacen.crear({ id: 'bbbb7777', titulo: 'bueno' });
  almacen.crear({ id: 'cccc8888', titulo: 'roto' });
  fs.writeFileSync(almacen.rutasDeLogs('cccc8888').job, '{ esto no es json');

  const { trabajos, corruptos } = almacen.listar();
  assert.deepEqual(trabajos.map((t) => t.id), ['bbbb7777']);
  assert.equal(corruptos.length, 1);
  assert.equal(corruptos[0].id, 'cccc8888');
});

test('marcarPerdidos mata el grupo vivo con identidad correcta y pasa a lost a los no terminales', async () => {
  const almacen = almacenNuevo();

  // Proceso real en su propio grupo (líder con detached).
  const hijo = spawn(NODE, [path.join(FIXTURES, 'idle.js')], {
    detached: true,
    stdio: 'ignore',
    env: ENTORNO,
  });
  const pgid = hijo.pid;
  hijo.unref();
  assert.ok(await esperar(() => existeGrupo(pgid)), 'el grupo debía existir');
  const identidad = identidadDeProceso(pgid);
  assert.ok(identidad, 'el proceso debe tener identidad');

  almacen.crear({ id: 'run00001', estado: 'running', pgid, inicioEn: Date.now(), identidad });
  almacen.crear({ id: 'que00002', estado: 'queued' });
  almacen.crear({ id: 'fin00003', estado: 'succeeded' });

  // Un pgid que ya no existe: el proceso efímero sale antes de reconciliar.
  const efimero = spawn(NODE, ['-e', ''], { detached: true, stdio: 'ignore', env: ENTORNO });
  const pgidMuerto = efimero.pid;
  efimero.unref();
  await esperar(() => !existeGrupo(pgidMuerto));
  almacen.crear({ id: 'moid00004', estado: 'provisioning', pgid: pgidMuerto });

  try {
    const afectados = await almacen.marcarPerdidos();
    assert.deepEqual([...afectados].sort(), ['moid00004', 'que00002', 'run00001']);

    assert.equal(almacen.leer('run00001').estado, 'lost');
    assert.equal(almacen.leer('run00001').perdidoMotivo, 'servidor_reiniciado');
    assert.equal(almacen.leer('que00002').estado, 'lost');
    assert.equal(almacen.leer('moid00004').estado, 'lost');
    assert.equal(almacen.leer('fin00003').estado, 'succeeded'); // terminal: intacto

    assert.equal(existeGrupo(pgid), false, 'el grupo vivo con identidad correcta debía morir');
  } finally {
    try {
      await matarGrupo(pgid, 100);
    } catch {
      /* ya estaba muerto */
    }
  }
});

test('marcarPerdidos NO mata si la identidad no coincide, falta o cambió el bootId', async () => {
  const almacen = almacenNuevo();
  /** Lanza un proceso real en su propio grupo y devuelve su pgid. */
  const lanzar = () => {
    const h = spawn(NODE, [path.join(FIXTURES, 'idle.js')], { detached: true, stdio: 'ignore', env: ENTORNO });
    h.unref();
    return h.pid;
  };

  const pAdul = lanzar();
  const pSin = lanzar();
  const pBoot = lanzar();
  await esperar(() => existeGrupo(pAdul) && existeGrupo(pSin) && existeGrupo(pBoot));

  const idAdul = identidadDeProceso(pAdul);
  const idBoot = identidadDeProceso(pBoot);
  assert.ok(idAdul && idBoot);

  // Inicio adulterado (como si el pgid hoy fuera de otro proceso).
  almacen.crear({
    id: 'adul0001',
    estado: 'running',
    pgid: pAdul,
    identidad: { ...idAdul, inicio: idAdul.inicio + 100000 },
  });
  // Sin identidad guardada.
  almacen.crear({ id: 'sinid001', estado: 'running', pgid: pSin });
  // Otro arranque del kernel.
  almacen.crear({
    id: 'boot0001',
    estado: 'running',
    pgid: pBoot,
    identidad: { ...idBoot, bootId: 'boot-que-no-existe' },
  });

  try {
    const afectados = await almacen.marcarPerdidos();
    assert.deepEqual([...afectados].sort(), ['adul0001', 'boot0001', 'sinid001']);

    assert.equal(existeGrupo(pAdul), true, 'identidad adulterada: NO debía morir');
    assert.equal(almacen.leer('adul0001').perdidoMotivo, 'identidad_no_coincide');

    assert.equal(existeGrupo(pSin), true, 'sin identidad: NO debía morir');
    assert.equal(almacen.leer('sinid001').perdidoMotivo, 'sin_identidad');

    assert.equal(existeGrupo(pBoot), true, 'bootId distinto: NO debía morir');
    assert.equal(almacen.leer('boot0001').perdidoMotivo, 'reinicio_del_sistema');

    // Cada caso no matado deja una advertencia en events.jsonl.
    for (const id of ['adul0001', 'sinid001', 'boot0001']) {
      const eventos = almacen.leerCola(id, 'events', 65536);
      assert.match(eventos, /advertencia/, `faltaba la advertencia de ${id}`);
    }
  } finally {
    for (const pid of [pAdul, pSin, pBoot]) {
      try {
        await matarGrupo(pid, 100);
      } catch {
        /* ya estaba muerto */
      }
    }
  }
});

// --- S2: bloqueo de instancia ------------------------------------------------

test('adquirirBloqueoDeInstancia impide dos servidores y libera solo si es nuestro', () => {
  const dir = dirTemporal();
  const ruta = path.join(dir, 'server.lock');
  const a = new AlmacenDeTrabajos({ dir });
  const b = new AlmacenDeTrabajos({ dir });

  const lock = a.adquirirBloqueoDeInstancia();
  assert.equal(lock.pid, process.pid);
  assert.ok(fs.existsSync(ruta));

  // Otro servidor con el mismo pid vivo e identidad: rechazado.
  assert.throws(() => b.adquirirBloqueoDeInstancia(), /otro servidor activo/);

  // `liberar` solo borra un lock NUESTRO: con un lock ajeno no lo toca.
  fs.writeFileSync(ruta, JSON.stringify({ pid: 999999, identidad: { inicio: 1, bootId: 'x' } }));
  assert.equal(a.liberarBloqueoDeInstancia(), false);
  assert.ok(fs.existsSync(ruta));

  // Recuperamos el nuestro y lo liberamos.
  a.adquirirBloqueoDeInstancia();
  assert.equal(a.liberarBloqueoDeInstancia(), true);
  assert.equal(fs.existsSync(ruta), false);
});

test('adquirirBloqueoDeInstancia reemplaza locks obsoletos (pid muerto u otra identidad)', async () => {
  const dir = dirTemporal();
  const ruta = path.join(dir, 'server.lock');
  fs.mkdirSync(dir, { recursive: true });

  // Lock con un pid ya muerto.
  const efimero = spawn(NODE, ['-e', ''], { detached: true, stdio: 'ignore', env: ENTORNO });
  const pidMuerto = efimero.pid;
  efimero.unref();
  await esperar(() => !existeGrupo(pidMuerto));
  fs.writeFileSync(ruta, JSON.stringify({ pid: pidMuerto, identidad: { inicio: 1, bootId: 'x' } }));

  const a = new AlmacenDeTrabajos({ dir });
  assert.doesNotThrow(() => a.adquirirBloqueoDeInstancia());
  assert.equal(JSON.parse(fs.readFileSync(ruta, 'utf8')).pid, process.pid);
  a.liberarBloqueoDeInstancia();

  // Lock con pid vivo pero identidad distinta: obsoleto, se reemplaza.
  fs.writeFileSync(ruta, JSON.stringify({ pid: process.pid, identidad: { inicio: 1, bootId: 'otro-boot' } }));
  const b = new AlmacenDeTrabajos({ dir });
  assert.doesNotThrow(() => b.adquirirBloqueoDeInstancia());
  assert.equal(b.liberarBloqueoDeInstancia(), true);
});

// --- S3: temporales huérfanos y rotación de auditoría ------------------------

test('limpiarTemporales borra solo los temporales viejos', () => {
  const almacen = almacenNuevo();
  almacen.crear({ id: 'tmpa0001' });
  const rutas = almacen.rutasDeLogs('tmpa0001');
  const viejo = `${rutas.job}.tmp-1-1`;
  const nuevo = `${rutas.job}.tmp-1-2`;
  fs.writeFileSync(viejo, 'x');
  fs.writeFileSync(nuevo, 'x');
  const antiguo = new Date(Date.now() - 7200000);
  fs.utimesSync(viejo, antiguo, antiguo);

  const borrados = almacen.limpiarTemporales({ edadMs: 3600000 });
  assert.deepEqual(borrados, [viejo]);
  assert.equal(fs.existsSync(viejo), false);
  assert.equal(fs.existsSync(nuevo), true, 'un temporal joven no debe borrarse');
});

test('auditar rota audit.log al superar el tope y conserva un respaldo', () => {
  const almacen = new AlmacenDeTrabajos({ dir: dirTemporal(), topeAuditoriaBytes: 100 });
  almacen.auditar({ n: 1, relleno: 'a'.repeat(200) });
  assert.ok(fs.statSync(path.join(almacen.dir, 'audit.log')).size >= 100);

  almacen.auditar({ n: 2 });
  assert.ok(fs.existsSync(path.join(almacen.dir, 'audit.log.1')), 'debe existir el respaldo');

  const respaldo = fs.readFileSync(path.join(almacen.dir, 'audit.log.1'), 'utf8');
  assert.match(respaldo, /"n":1/);
  const actual = fs.readFileSync(path.join(almacen.dir, 'audit.log'), 'utf8');
  assert.match(actual, /"n":2/);
  assert.equal(actual.includes('"n":1'), false);
});
