/**
 * Robustez del gestor: tope de concurrencia por repo, carrera entre `enviar()` y
 * `cerrar()`, y rastro en stderr cuando el registro global de eventos falla.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Gestor } from '../src/core/gestor.js';
import { NODE, crearGestor, entornoFalso, esperar, existeGrupo, montar, pidVivo } from './gestor-comun.js';

test('el tope por repo del perfil se guarda en el job y frena al segundo del mismo repo', async (t) => {
  const m = await montar(t, { perfil: { concurrency: 1 } });
  // El tope GLOBAL de crearGestor es 2, así que lo que frena a `b` es el tope del repo.
  const gestor = crearGestor(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.txt', ORQ_FAKE_DORMIR: '1500' }),
    home: m.home,
  });

  const a = await gestor.enviar({ prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({ prompt: 'B', cwd: path.join(m.repo, 'subB'), mode: 'safe', writes: ['subB/**'] });

  assert.equal(gestor.obtener(a.id).concurrenciaRepo, 1, 'el job guarda el tope del repo');
  assert.equal(gestor.obtener(b.id).concurrenciaRepo, 1);
  assert.ok(await esperar(() => gestor.obtener(a.id).estado === 'running'), 'a debe estar corriendo');
  assert.equal(gestor.obtener(b.id).estado, 'queued', 'b no puede arrancar con el repo lleno');
  assert.equal(gestor.obtener(b.id).espera?.motivo, 'tope_del_repo', 'el motivo es el tope del repo, no el global');

  await gestor.cerrar(500);
});

test('cerrar() durante enviar() rechaza el trabajo en vez de dejarlo en cola para siempre', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { entorno: entornoFalso({}) });

  // `enviar` se detiene en su primer `await`; `cerrar` pone `cerrado = true` antes de eso.
  const pendiente = gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const cierre = gestor.cerrar(0);

  let creado = null;
  let error = null;
  try {
    creado = await pendiente;
  } catch (e) {
    error = e;
  }
  await cierre;

  if (creado) {
    // Si llegó a crearse, cerrar() ya vació la cola: el trabajo debe haber quedado terminal.
    assert.notEqual(gestor.obtener(creado.id).estado, 'queued', 'nunca puede quedar encolado para siempre');
  } else {
    assert.match(error.message, /cerrando/i, 'el rechazo explica que el servidor se está cerrando');
  }
  assert.equal(gestor.cola.length, 0, 'no queda nada en la cola tras cerrar');
});

test('#evento reporta el primer fallo del registro y luego uno cada 100, sin frenar la operación', async (t) => {
  const m = await montar(t);
  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({}),
    home: m.home,
    graceMs: 300,
    registro: {
      registrar() {
        throw new Error('boom');
      },
    },
  });

  const lineas = [];
  const original = process.stderr.write;
  process.stderr.write = (texto) => {
    lineas.push(String(texto));
    return true;
  };
  try {
    for (let i = 0; i < 100; i += 1) gestor.registrarArranque();
  } finally {
    process.stderr.write = original;
  }

  assert.equal(gestor.fallosDeEvento, 100);
  assert.equal(lineas.length, 2, 'se reporta el 1º y el 100º, no los 100');
  assert.match(lineas[0], /fallo al registrar evento \(1\)/);
  assert.match(lineas[0], /boom/);
  assert.match(lineas[1], /\(100\)/);
});

test('#evento también reporta cuando el registro devuelve false (fallo de E/S)', async (t) => {
  const m = await montar(t);
  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({}),
    home: m.home,
    graceMs: 300,
    registro: { registrar: () => false },
  });

  const lineas = [];
  const original = process.stderr.write;
  process.stderr.write = (texto) => {
    lineas.push(String(texto));
    return true;
  };
  try {
    gestor.registrarArranque();
  } finally {
    process.stderr.write = original;
  }

  assert.equal(lineas.length, 1);
  assert.match(lineas[0], /fallo de E\/S/);
});

test('matarTodoSincrono mata sin esperar el grupo y a su nieto de larga vida', async (t) => {
  const m = await montar(t);
  const pidfile = path.join(m.base, 'nieto.pid');
  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({ ORQ_FAKE_NIETO: '1', ORQ_FAKE_PIDFILE: pidfile, ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
    graceMs: 300,
  });

  const trabajo = await gestor.enviar({ prompt: 'largo', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.ok(await esperar(() => fs.existsSync(pidfile), 8000), 'el nieto debía arrancar');
  const nieto = Number(fs.readFileSync(pidfile, 'utf8'));
  assert.ok(await esperar(() => Number.isInteger(gestor.obtener(trabajo.id).pgid), 4000), 'el pgid debía persistirse');
  const pgid = gestor.obtener(trabajo.id).pgid;
  assert.equal(existeGrupo(pgid), true);
  assert.equal(pidVivo(nieto), true);

  // Es la red de seguridad síncrona: no espera, envía SIGKILL de inmediato.
  gestor.matarTodoSincrono();
  assert.ok(
    await esperar(() => !existeGrupo(pgid) && !pidVivo(nieto), 3000),
    'tras matarTodoSincrono no debe quedar el grupo ni el nieto vivos',
  );

  await gestor.cerrar(200);
});

test('purgarLogsAntiguos borra los logs viejos según retencion y registra cleanup', async (t) => {
  const m = await montar(t, { perfil: { retencion: { dias: 1 } } });
  const eventos = [];
  const registro = { registrar(ev) { eventos.push(ev); return true; } };
  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({}),
    home: m.home,
    graceMs: 300,
    registro,
  });

  const ahora = Date.now();
  m.almacen.crear({ id: 'viej0001', estado: 'succeeded', repo: m.repo, creadoEn: ahora - 5 * 86400000, finEn: ahora - 3 * 86400000 });
  const rutasViejo = m.almacen.rutasDeLogs('viej0001');
  fs.writeFileSync(rutasViejo.stdout, 'x'.repeat(123));
  fs.writeFileSync(rutasViejo.stderr, 'y'.repeat(45));

  m.almacen.crear({ id: 'nuev0001', estado: 'succeeded', repo: m.repo, creadoEn: ahora - 3600000, finEn: ahora - 3600000 });
  const rutasNuevo = m.almacen.rutasDeLogs('nuev0001');
  fs.writeFileSync(rutasNuevo.stdout, 'zz');

  const res = await gestor.purgarLogsAntiguos({ ahora });
  // `crear` deja también un events.jsonl vacío: se cuenta como archivo purgado (0 bytes).
  assert.equal(res.cantidad, 3);
  assert.equal(res.bytes, 168);
  assert.equal(fs.existsSync(rutasViejo.stdout), false);
  assert.equal(fs.existsSync(rutasViejo.stderr), false);
  assert.equal(fs.existsSync(rutasViejo.job), true, 'job.json se conserva');
  assert.equal(fs.existsSync(rutasNuevo.stdout), true, 'el trabajo reciente no se toca');

  const cleanup = eventos.find((ev) => ev.tipo === 'cleanup');
  assert.ok(cleanup, 'debe registrarse el evento cleanup');
  assert.equal(cleanup.detalle.cantidad, 3);
  assert.equal(cleanup.detalle.bytes, 168);
  await gestor.cerrar(200);
});

test('iniciarRetencion usa un timer unref e idempotente que cerrar() cancela', async (t) => {
  const m = await montar(t);
  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({}),
    home: m.home,
    graceMs: 300,
  });

  gestor.iniciarRetencion({ intervaloMs: 10 * 60 * 1000 });
  const timer = gestor.timerRetencion;
  assert.ok(timer, 'debe quedar programado el timer');
  // `unref()` hace que el timer no mantenga vivo el proceso.
  assert.equal(typeof timer.hasRef === 'function' ? timer.hasRef() : false, false);
  gestor.iniciarRetencion(); // idempotente: no lo reemplaza
  assert.equal(gestor.timerRetencion, timer);

  await gestor.cerrar(0);
  assert.equal(gestor.timerRetencion, null, 'cerrar() debe cancelar el timer');
});

test('el gestor carga solo maxEnMemoria trabajos y lee los viejos del disco bajo demanda', async (t) => {
  const m = await montar(t);
  for (let i = 1; i <= 4; i += 1) {
    m.almacen.crear({ id: `term${i}000`, estado: 'succeeded', repo: m.repo, creadoEn: i });
  }
  m.almacen.crear({ id: 'active01', estado: 'running', repo: m.repo, creadoEn: 0 });

  const gestor = new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia: 2,
    entornoBase: entornoFalso({}),
    home: m.home,
    graceMs: 300,
    maxEnMemoria: 2,
  });

  // 2 más recientes + el activo (siempre presente); el resto queda en disco.
  assert.equal(gestor.trabajos.size, 3);
  assert.equal(gestor.trabajos.has('active01'), true);
  assert.equal(gestor.trabajosEnDisco, 2);

  // Un trabajo viejo se lee del disco bajo demanda y queda cacheado.
  const viejo = gestor.obtener('term1000');
  assert.equal(viejo.id, 'term1000');
  assert.equal(gestor.trabajos.has('term1000'), true);
  await gestor.cerrar(200);
});
