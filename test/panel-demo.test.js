import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { iniciarDemo, estadoRealPreexistente, PUERTO_DEMO } from '../scripts/panel-demo.js';

test('panel-demo: genera el estado y sirve trabajos, eventos y pizarrón con datos', async () => {
  const previo = process.env.ORQ_STATE_DIR;
  const demo = await iniciarDemo({ puerto: 0 });
  try {
    assert.equal(demo.resumen.trabajos.length, 12);
    assert.equal(demo.resumen.claves, 5);
    assert.equal(demo.resumen.notas, 3);

    // Lista de trabajos: 12, de dos repositorios y con estados variados.
    const trabajos = await (await fetch(`${demo.url}/api/trabajos`)).json();
    assert.equal(trabajos.total, 12);
    const repos = new Set(trabajos.trabajos.map((t) => t.repoNombre));
    assert.ok(repos.has('compras'));
    assert.ok(repos.has('opencode-orchestrator'));
    const estados = new Set(trabajos.trabajos.map((t) => t.estado));
    for (const estado of ['running', 'queued', 'succeeded', 'merged', 'failed', 'rejected', 'cancelled']) {
      assert.ok(estados.has(estado), `falta el estado ${estado}`);
    }

    // Eventos: reales de varios tipos + reconstruidos de los trabajos sin registro.
    const eventos = await (await fetch(`${demo.url}/api/eventos`)).json();
    assert.ok(eventos.eventos.length > 0);
    const tipos = new Set(eventos.eventos.map((e) => e.tipo));
    assert.ok(tipos.has('job.creado'));
    assert.ok(tipos.has('merge'));
    assert.ok(tipos.has('cleanup'));
    const reconstruidos = eventos.eventos.filter((e) => e.origen === 'reconstruido');
    assert.ok(reconstruidos.length > 0, 'debería haber eventos reconstruidos');

    // Pizarrón: 5 claves, una con conflicto en el historial, y notas.
    const pizarron = await (await fetch(`${demo.url}/api/pizarron`)).json();
    assert.equal(Object.keys(pizarron.claves).length, 5);
    assert.equal(pizarron.notas.length, 3);
    assert.equal(pizarron.claves['cache.ttl'].historial[0].conflicto, true);

    // La auditoría HTML muestra la etiqueta humana y la insignia histórico.
    const html = await (await fetch(`${demo.url}/auditoria`)).text();
    assert.match(html, /Trabajo creado/);
    assert.match(html, /histórico/);
  } finally {
    await demo.cerrar();
    if (previo === undefined) delete process.env.ORQ_STATE_DIR;
    else process.env.ORQ_STATE_DIR = previo;
  }
});

test('panel-demo: por defecto usa 7490 y se niega con un ORQ_STATE_DIR real preexistente', () => {
  assert.equal(PUERTO_DEMO, 7490);
  assert.equal(estadoRealPreexistente({}), false);
  assert.equal(estadoRealPreexistente({ ORQ_STATE_DIR: '' }), false);
  const inexistente = path.join(os.tmpdir(), `no-existe-${process.pid}-${Date.now()}`);
  assert.equal(estadoRealPreexistente({ ORQ_STATE_DIR: inexistente }), false);

  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-demo-real-'));
  try {
    assert.equal(estadoRealPreexistente({ ORQ_STATE_DIR: real }), true);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});
