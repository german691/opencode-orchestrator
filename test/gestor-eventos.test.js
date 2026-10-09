/**
 * Registro global de eventos de auditoría (src/core/eventos.js) conectado al gestor:
 * arranque, recuperación, creación, cada cambio de estado, espera en cola, fin,
 * cancelación, merge, avance de base y limpieza. Usa el opencode FALSO y repos git
 * temporales, igual que el resto de los tests del gestor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Gestor } from '../src/core/gestor.js';
import { crearRegistroEventos } from '../src/core/eventos.js';
import { NODE, entornoFalso, esperar, montar } from './gestor-comun.js';

/** Gestor con el registro global cableado (crearGestor de gestor-comun no lo acepta). */
function crearGestorConRegistro(m, { entorno, concurrencia = 2, registro, vigilanciaAlcanceMs } = {}) {
  return new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [m.fake] },
    concurrencia,
    entornoBase: entorno,
    home: m.home,
    graceMs: 300,
    registro,
    ...(vigilanciaAlcanceMs === undefined ? {} : { vigilanciaAlcanceMs }),
  });
}

async function correr(gestor, spec) {
  const trabajo = await gestor.enviar(spec);
  await gestor.esperar(trabajo.id, 30000);
  return gestor.obtener(trabajo.id);
}

test('el registro global recibe arranque, recuperación, creación, estados, fin y cleanup', async (t) => {
  const m = await montar(t);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorConRegistro(m, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.txt' }),
    registro,
  });
  gestor.registrarArranque({ recuperados: ['viejo'] });

  const trabajo = await gestor.enviar(
    { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'], title: 'auditado' },
    { actor: 'herramienta:coding' },
  );
  await gestor.esperar(trabajo.id, 30000);
  assert.equal(gestor.obtener(trabajo.id).estado, 'succeeded');
  await gestor.limpiar({ ids: [trabajo.id], actor: 'herramienta:cleanup' });

  const eventos = registro.listar({ limite: 500 });
  const tipos = eventos.map((e) => e.tipo);
  for (const tipo of ['servidor.arranque', 'servidor.recuperacion', 'job.creado', 'job.estado', 'job.fin', 'cleanup']) {
    assert.ok(tipos.includes(tipo), `falta ${tipo} (hay: ${tipos.join(', ')})`);
  }

  const creado = eventos.find((e) => e.tipo === 'job.creado' && e.jobId === trabajo.id);
  assert.equal(creado.actor, 'herramienta:coding');
  assert.equal(creado.detalle.modo, 'safe');
  assert.deepEqual(creado.detalle.writes, ['subA/**']);

  const estados = eventos.filter((e) => e.tipo === 'job.estado' && e.jobId === trabajo.id);
  assert.ok(estados.some((e) => e.estado === 'running' && e.anterior === 'provisioning'), 'running desde provisioning');
  assert.ok(estados.some((e) => e.estado === 'succeeded' && e.anterior === 'verifying'), 'succeeded desde verifying');

  const finEvento = eventos.find((e) => e.tipo === 'job.fin' && e.jobId === trabajo.id);
  assert.equal(finEvento.estado, 'succeeded');
  assert.ok(Number.isFinite(finEvento.detalle.duracionMs), 'job.fin trae la duración');

  const cleanup = eventos.find((e) => e.tipo === 'cleanup');
  assert.deepEqual(cleanup.detalle.ids, [trabajo.id]);
  assert.equal(cleanup.actor, 'herramienta:cleanup');
});

test('el registro global deja constancia de por qué espera un trabajo en cola', async (t) => {
  const m = await montar(t);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorConRegistro(m, {
    concurrencia: 1,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '1200' }),
    registro,
  });
  const a = await gestor.enviar({ prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({ prompt: 'B', cwd: path.join(m.repo, 'subB'), mode: 'safe', writes: ['subB/**'] });
  await gestor.esperarAlguno([a.id, b.id], 30000);

  const espera = registro.listar({ tipo: 'job.espera', limite: 100 });
  assert.ok(espera.length > 0, 'debía registrarse al menos una espera');
  assert.equal(espera[0].jobId, b.id);
  assert.equal(typeof espera[0].motivo, 'string');
});

test('cancelar registra job.cancelado con el actor de la herramienta', async (t) => {
  const m = await montar(t);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorConRegistro(m, {
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    registro,
  });
  const trabajo = await gestor.enviar({ prompt: 'largo', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  await esperar(() => gestor.obtener(trabajo.id).estado === 'running', 8000);
  await gestor.cancelar(trabajo.id, { actor: 'herramienta:cancel' });

  const cancelado = registro.listar({ tipo: 'job.cancelado', limite: 50 });
  assert.ok(cancelado.some((e) => e.jobId === trabajo.id && e.actor === 'herramienta:cancel'));
  assert.ok(registro.listar({ tipo: 'job.fin', limite: 50 }).some((e) => e.jobId === trabajo.id && e.estado === 'cancelled'));
});

test('integrar registra merge (rama y sha) y avanzar_base', async (t) => {
  const m = await montar(t);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorConRegistro(m, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.txt' }),
    registro,
  });
  const trabajo = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(trabajo.estado, 'succeeded');

  const resultado = await gestor.integrar(trabajo.id, { avanzarBase: true, actor: 'herramienta:merge' });
  assert.equal(resultado.ok, true);

  const merge = registro.listar({ tipo: 'merge', limite: 20 }).find((e) => e.jobId === trabajo.id);
  assert.ok(merge, 'falta el evento merge');
  assert.match(merge.detalle.sha, /^[0-9a-f]{40}$/);
  assert.equal(merge.detalle.rama, 'staging');
  assert.equal(merge.actor, 'herramienta:merge');

  const avanzar = registro.listar({ tipo: 'avanzar_base', limite: 20 }).find((e) => e.jobId === trabajo.id);
  assert.ok(avanzar, 'falta el evento avanzar_base');
});
