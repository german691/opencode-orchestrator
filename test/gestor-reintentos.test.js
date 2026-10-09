/**
 * Compuerta sobre la integración (`solo_aceptacion`), retomar un trabajo (`desde_job`),
 * esperar a varios (`esperarAlguno`) y la vigilancia de alcance durante la ejecución.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { crearGestor, entornoFalso, gitOK, montar, NODE, esperar } from './gestor-comun.js';
import { Gestor } from '../src/core/gestor.js';
import { crearRegistroEventos } from '../src/core/eventos.js';

async function correr(gestor, spec) {
  const trabajo = await gestor.enviar(spec);
  await gestor.esperar(trabajo.id, 30000);
  return gestor.obtener(trabajo.id);
}

/**
 * Guion de opencode FALSO para simular un corte de transporte: escribe lo pedido,
 * cuenta sus corridas en un archivo y muere con la firma del socket cerrado + exit
 * 130 las primeras `ORQ_FAKE_MUERTES` veces; después sale limpio. Se escribe en el
 * tmp del test en vez de tocar el fixture compartido.
 */
const GUION_MUERTE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const escribir = String(process.env.ORQ_FAKE_ESCRIBIR || '').split(';').map((s) => s.trim()).filter(Boolean);",
  'for (const rel of escribir) {',
  '  const destino = path.resolve(process.cwd(), rel);',
  '  fs.mkdirSync(path.dirname(destino), { recursive: true });',
  "  fs.writeFileSync(destino, 'escrito\\n');",
  '}',
  'const contador = process.env.ORQ_FAKE_CONTADOR;',
  'let n = 0;',
  "if (contador) { try { n = Number(fs.readFileSync(contador, 'utf8')) || 0; } catch {} fs.writeFileSync(contador, String(n + 1)); }",
  "const muertes = Number(process.env.ORQ_FAKE_MUERTES || '1');",
  'if (n < muertes) {',
  "  fs.writeSync(2, 'Error: Transport: The socket connection was closed unexpectedly\\n');",
  '  process.exit(130);',
  '}',
  'process.exit(0);',
  '',
].join('\n');

/** Escribe el guion en el tmp del test y devuelve su ruta. */
function escribirGuion(m, nombre = 'opencode-muere.js') {
  const ruta = path.join(m.base, nombre);
  fs.writeFileSync(ruta, GUION_MUERTE);
  return ruta;
}

/** Gestor apuntando a un guion propio, con registro opcional para auditar los eventos. */
function crearGestorGuion(m, guion, { entorno, concurrencia = 2, registro, vigilanciaAlcanceMs } = {}) {
  return new Gestor({
    almacen: m.almacen,
    opencode: { cmd: NODE, argsPrefijo: [guion] },
    concurrencia,
    entornoBase: entorno,
    home: m.home,
    graceMs: 300,
    registro,
    ...(vigilanciaAlcanceMs === undefined ? {} : { vigilanciaAlcanceMs }),
  });
}

test('compuerta: solo_aceptacion sobre la integración corre la aceptación sin el agente y ve lo integrado', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });
  const a = await correr(gestor, { prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  assert.equal((await gestor.integrar(a.id)).ok, true);

  const verde = await correr(gestor, { cwd: m.repo, solo_aceptacion: true, base: 'integracion', accept: 'test -f subA/out.txt' });
  assert.equal(verde.estado, 'succeeded');
  assert.equal(verde.resultado.proceso.duracionMs, 0, 'el agente no corrió');
  assert.equal(fs.existsSync(path.join(verde.worktree, 'out.txt')), false, 'nadie escribió en la raíz: no hubo agente');
  assert.equal(verde.resultado.commit, null, 'una compuerta no produce commit integrable');
  assert.match(verde.titulo, /Compuerta sobre la integración/);

  const roja = await correr(gestor, { cwd: m.repo, solo_aceptacion: true, base: 'integracion', accept: 'test -f no-existe.txt' });
  assert.equal(roja.estado, 'rejected');
  assert.equal(roja.motivoFin, 'aceptacion');
  // Sobre la base (sin lo integrado) la misma comprobación NO pasa: la compuerta mide la integración.
  const sobreBase = await correr(gestor, { cwd: m.repo, solo_aceptacion: true, base: 'base', accept: 'test -f subA/out.txt' });
  assert.equal(sobreBase.estado, 'rejected');
});

test('solo_aceptacion exige una accept y no necesita prompt ni writes', async (t) => {
  const m = await montar(t, { perfil: { accept: {} } });
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, solo_aceptacion: true }), /necesita una `accept`/);
});

test('desde_job: retoma lo que dejó un trabajo rechazado y repite solo la aceptación', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/nuevo.txt' }), home: m.home });
  const malo = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'], accept: 'false' });
  assert.equal(malo.estado, 'rejected');
  assert.equal(malo.motivoFin, 'aceptacion');

  const reintento = await correr(gestor, { cwd: m.repo, desde_job: malo.id, solo_aceptacion: true, accept: 'test -f subA/nuevo.txt' });
  assert.equal(reintento.estado, 'succeeded');
  assert.equal(reintento.desdeJob, malo.id);
  assert.equal(reintento.baseCommit, malo.baseCommit, 'parte del mismo commit que el original');
  assert.deepEqual(reintento.writes, malo.writes, 'hereda el alcance');
  assert.deepEqual(reintento.resultado.archivos, ['subA/nuevo.txt']);
  assert.match(reintento.resultado.commit, /^[0-9a-f]{40}$/);
  assert.equal((await gestor.integrar(reintento.id)).ok, true, 'el reintento verde se puede integrar');
});

test('desde_job valida el origen: inexistente, activo o sin worktree', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_DORMIR: '3000' }), home: m.home });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, desde_job: 'noexiste', solo_aceptacion: true, accept: 'true' }), /no existe el trabajo/);
  const activo = await gestor.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, desde_job: activo.id, solo_aceptacion: true, accept: 'true' }), /sigue/);
  await gestor.cancelar(activo.id);
  await gestor.esperar(activo.id, 10000);
  await gestor.limpiar({ ids: [activo.id] });
  await assert.rejects(() => gestor.enviar({ cwd: m.repo, desde_job: activo.id, solo_aceptacion: true, accept: 'true' }), /no conserva su worktree/);
});

test('esperarAlguno responde apenas termina uno y reparte terminados y activos', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });
  const rapido = await gestor.enviar({ prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  await assert.rejects(() => gestor.esperarAlguno(['noexiste'], 100), /No existe el trabajo/);
  const r = await gestor.esperarAlguno([rapido.id], 30000);
  assert.deepEqual(r, { terminados: [rapido.id], activos: [] });
  // Ya terminado: responde sin esperar.
  const t0 = Date.now();
  assert.deepEqual(await gestor.esperarAlguno([rapido.id], 30000), { terminados: [rapido.id], activos: [] });
  assert.ok(Date.now() - t0 < 1000);
});

test('vigilancia de alcance: un agente que persiste fuera de writes se detiene sin esperar al final', async (t) => {
  const m = await montar(t);
  // Escribe FUERA de su alcance y se queda dormido 60 s: sin vigilancia llegaría al tope de tiempo.
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'fuera.txt', ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
    vigilanciaAlcanceMs: 150,
  });
  const inicio = Date.now();
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(r.estado, 'rejected', JSON.stringify({ motivoFin: r.motivoFin, error: r.error }));
  assert.equal(r.motivoFin, 'alcance');
  assert.ok(Date.now() - inicio < 20000, 'se detuvo temprano, no esperó los 60 s');
  assert.deepEqual(r.resultado.violaciones.map((v) => v.ruta), ['fuera.txt']);
  assert.match(r.resultado.advertencias.join(' '), /TEMPRANO/);
  assert.equal(r.resultado.proceso.motivo, 'detenido_por_alcance');
});

test('vigilancia de alcance: un archivo de paso que se borra a tiempo no corta al agente', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/ok.txt', ORQ_FAKE_DORMIR: '600' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(r.estado, 'succeeded', 'dentro de su alcance: nunca se corta');
  await gitOK(['status'], r.worktree);
});

test('solo_aceptacion y avanzar_base se aceptan también como texto "true" (clientes con el esquema en caché)', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }), home: m.home });
  const r = await correr(gestor, { cwd: m.repo, solo_aceptacion: 'true', accept: 'true' });
  assert.equal(r.soloAceptacion, true);
  assert.equal(r.estado, 'succeeded');
  assert.equal(r.resultado.proceso.duracionMs, 0, 'el agente no corrió');
});

test('sin progreso: un agente que no escribe nada en el plazo se corta y el mensaje dice cómo relanzar', async (t) => {
  const m = await montar(t);
  // Se queda "explorando" 60 s sin escribir: sin el vigilante llegaría al tope de tiempo.
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
    sinProgresoMs: 700,
  });
  const inicio = Date.now();
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(r.estado, 'failed');
  assert.equal(r.motivoFin, 'sin_progreso');
  assert.ok(Date.now() - inicio < 20000, 'se cortó temprano');
  assert.match(r.resultado.advertencias.join(' '), /NINGÚN archivo.*Relanzá.*ACOTADO/s);
});

test('sin progreso: un agente que escribe a tiempo NO se corta aunque siga trabajando; y readonly queda exento', async (t) => {
  const m = await montar(t);
  const escribe = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/ok.txt', ORQ_FAKE_DORMIR: '2500' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
    sinProgresoMs: 1200,
  });
  const ok = await correr(escribe, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  assert.equal(ok.estado, 'succeeded', 'escribió antes del plazo: sigue vivo');

  const lector = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '2500' }),
    home: m.home,
    vigilanciaAlcanceMs: 100,
    sinProgresoMs: 700,
  });
  const ro = await correr(lector, { prompt: 'solo mira', cwd: m.repo, mode: 'readonly' });
  assert.notEqual(ro.motivoFin, 'sin_progreso', 'readonly no escribe: no se corta por eso');
});

test('reanudación: el agente muere por transporte TRAS escribir → continúa, succeeded y con advertencia', async (t) => {
  const m = await montar(t);
  const guion = escribirGuion(m);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorGuion(m, guion, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.txt', ORQ_FAKE_MUERTES: '1' }),
    registro,
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });

  assert.equal(r.estado, 'succeeded', JSON.stringify(r.resultado));
  assert.match(r.resultado.advertencias.join(' '), /REANUDADO/);
  assert.deepEqual(r.resultado.archivos, ['subA/x.txt']);
  assert.equal(r.relanzamientos, undefined, 'con cambios no se relanza');
  assert.ok(registro.listar({ tipo: 'job.reanudado', limite: 20 }).some((e) => e.jobId === r.id), 'falta job.reanudado');
  assert.equal(registro.listar({ tipo: 'job.reintento', limite: 20 }).length, 0);
});

test('reanudación: sin cambios relanza UNA vez y el segundo intento puede terminar bien', async (t) => {
  const m = await montar(t);
  const guion = escribirGuion(m);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const contador = path.join(m.base, 'contador.txt');
  const gestor = crearGestorGuion(m, guion, {
    entorno: entornoFalso({ ORQ_FAKE_CONTADOR: contador, ORQ_FAKE_MUERTES: '1' }),
    registro,
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });

  assert.equal(r.estado, 'succeeded', JSON.stringify(r.resultado));
  assert.equal(r.relanzamientos, 1);
  assert.equal(fs.readFileSync(contador, 'utf8'), '2', 'el agente corrió dos veces');
  assert.ok(registro.listar({ tipo: 'job.reintento', limite: 20 }).some((e) => e.jobId === r.id), 'falta job.reintento');
});

test('reanudación: si muere dos veces sin dejar cambios, falla (no hay bucle)', async (t) => {
  const m = await montar(t);
  const guion = escribirGuion(m);
  const contador = path.join(m.base, 'contador.txt');
  const gestor = crearGestorGuion(m, guion, {
    entorno: entornoFalso({ ORQ_FAKE_CONTADOR: contador, ORQ_FAKE_MUERTES: '2' }),
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });

  assert.equal(r.estado, 'failed');
  assert.equal(r.motivoFin, 'exit_distinto_de_cero');
  assert.equal(r.relanzamientos, 1, 'solo se permite un relanzamiento');
  assert.equal(fs.readFileSync(contador, 'utf8'), '2');
});

test('reanudación: un corte deliberado por ALCANCE no reanuda', async (t) => {
  const m = await montar(t);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorGuion(m, m.fake, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'fuera.txt', ORQ_FAKE_DORMIR: '60000' }),
    registro,
    vigilanciaAlcanceMs: 150,
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });

  assert.equal(r.estado, 'rejected');
  assert.equal(r.motivoFin, 'alcance');
  assert.equal(registro.listar({ tipo: 'job.reintento', limite: 50 }).length, 0);
  assert.equal(registro.listar({ tipo: 'job.reanudado', limite: 50 }).length, 0);
});

test('reanudación: un corte por TIMEOUT no reanuda', async (t) => {
  const m = await montar(t);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorGuion(m, m.fake, {
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    registro,
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'], timeout_ms: 300 });

  assert.equal(r.estado, 'failed');
  assert.equal(r.motivoFin, 'timeout');
  assert.equal(registro.listar({ tipo: 'job.reintento', limite: 50 }).length, 0);
  assert.equal(registro.listar({ tipo: 'job.reanudado', limite: 50 }).length, 0);
});

test('reanudación: un corte por CANCELACIÓN no reanuda', async (t) => {
  const m = await montar(t);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorGuion(m, m.fake, {
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    registro,
  });
  const trabajo = await gestor.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  await esperar(() => gestor.obtener(trabajo.id).estado === 'running', 8000);
  await gestor.cancelar(trabajo.id);
  assert.equal(gestor.obtener(trabajo.id).estado, 'cancelled');
  assert.equal(registro.listar({ tipo: 'job.reintento', limite: 50 }).length, 0);
  assert.equal(registro.listar({ tipo: 'job.reanudado', limite: 50 }).length, 0);
});

test('reanudación: con reanudacion.habilitado=false el corte de transporte falla como antes', async (t) => {
  const m = await montar(t, { perfil: { reanudacion: { habilitado: false } } });
  const guion = escribirGuion(m);
  const registro = crearRegistroEventos({ dir: m.estadoDir });
  const gestor = crearGestorGuion(m, guion, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.txt', ORQ_FAKE_MUERTES: '1' }),
    registro,
  });
  const r = await correr(gestor, { prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });

  assert.equal(r.estado, 'failed');
  assert.equal(r.motivoFin, 'exit_distinto_de_cero');
  assert.doesNotMatch((r.resultado.advertencias ?? []).join(' '), /REANUDADO/);
  assert.equal(registro.listar({ tipo: 'job.reintento', limite: 50 }).length, 0);
  assert.equal(registro.listar({ tipo: 'job.reanudado', limite: 50 }).length, 0);
});
