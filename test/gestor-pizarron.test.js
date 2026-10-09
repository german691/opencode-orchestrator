/**
 * Pizarrón compartido conectado al Gestor: symlink en el worktree, fusión de aportes
 * de trabajos concurrentes, tolerancia a aportes corruptos y perfil deshabilitado.
 *
 * Se usa el opencode falso y repos git reales (helpers de gestor-comun.js). El Gestor
 * se construye a mano porque `crearGestor` no recibe el pizarrón (y ese archivo no se
 * toca): así el test refleja el cableado real de `server.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Gestor } from '../src/core/gestor.js';
import { crearPizarron } from '../src/core/pizarron.js';
import { entornoFalso, leerEventos, montar, NODE } from './gestor-comun.js';

/**
 * Construye un Gestor con el pizarrón dado y el opencode falso.
 * @param {import('../src/core/store.js').AlmacenDeTrabajos} almacen
 * @param {{entorno: NodeJS.ProcessEnv, pizarron: object, home: string, fake: string, concurrencia?: number}} opciones
 * @returns {Gestor}
 */
function crearGestorConPizarron(almacen, { entorno, pizarron, home, fake, concurrencia = 2, vigilanciaAlcanceMs }) {
  return new Gestor({
    almacen,
    opencode: { cmd: NODE, argsPrefijo: [fake] },
    concurrencia,
    entornoBase: entorno,
    home,
    graceMs: 300,
    pizarron,
    ...(vigilanciaAlcanceMs === undefined ? {} : { vigilanciaAlcanceMs }),
  });
}

test('pizarrón: el worktree enlaza `.orq/pizarron.json` al archivo vivo y ve la última versión', async (t) => {
  const m = await montar(t, { perfil: { pizarron: { habilitado: true } } });
  const pizarron = crearPizarron({ dir: path.join(m.base, 'pizarron') });
  const gestor = crearGestorConPizarron(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js' }),
    pizarron,
    home: m.home,
    fake: m.fake,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');

  const enlace = path.join(fin.worktree, '.orq', 'pizarron.json');
  assert.ok(fs.lstatSync(enlace).isSymbolicLink(), 'debe ser un symlink');
  assert.equal(fs.realpathSync(enlace), fs.realpathSync(pizarron.rutaViva()));

  // Leer por el symlink debe ver SIEMPRE la última versión tras el rename atómico.
  pizarron.post({ clave: 'contrato.x', valor: { v: 'uno' }, jobId: 'orquestador' });
  assert.match(fs.readFileSync(enlace, 'utf8'), /"uno"/);
  pizarron.post({ clave: 'contrato.x', valor: { v: 'dos' }, jobId: 'orquestador' });
  const leido = JSON.parse(fs.readFileSync(enlace, 'utf8'));
  assert.deepEqual(leido.claves['contrato.x'].valor, { v: 'dos' });

  await gestor.cerrar();
});

test('pizarrón: dos trabajos concurrentes fusionan sus aportes y el conflicto de clave se registra', async (t) => {
  const m = await montar(t, { perfil: { pizarron: { habilitado: true } } });
  const pizarron = crearPizarron({ dir: path.join(m.base, 'pizarron') });
  const aporte = JSON.stringify({
    entradas: [{ clave: 'contrato.api', valor: { ruta: '/v1' }, nota: 'inicial' }],
    notas: ['hola'],
  });
  const gestor = crearGestorConPizarron(m.almacen, {
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([{ ruta: '.orq/aporte.json', contenido: aporte }]),
    }),
    pizarron,
    home: m.home,
    fake: m.fake,
    concurrencia: 2,
  });

  // Writes disjuntos: el planificador los corre en paralelo.
  const a = await gestor.enviar({ prompt: 'a', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({ prompt: 'b', cwd: m.repo, mode: 'safe', writes: ['subB/**'] });
  const finA = await gestor.esperar(a.id, 20000);
  const finB = await gestor.esperar(b.id, 20000);
  assert.equal(finA.estado, 'succeeded');
  assert.equal(finB.estado, 'succeeded');

  const doc = pizarron.leer();
  assert.ok(doc.claves['contrato.api'], 'la clave quedó en el pizarrón');
  const historial = doc.claves['contrato.api'].historial;
  assert.equal(historial.length, 2, 'los dos aportes quedaron en el historial');
  assert.equal(historial.filter((h) => h.conflicto).length, 1, 'uno de los dos chocó');

  const eventos = [...leerEventos(m.estadoDir, a.id), ...leerEventos(m.estadoDir, b.id)].filter(
    (e) => e.tipo === 'pizarron.post',
  );
  assert.ok(eventos.some((e) => e.conflictos >= 1), 'debe quedar constancia del conflicto');

  await gestor.cerrar();
});

test('pizarrón: un aporte corrupto no rompe el trabajo ni ensucia el pizarrón', async (t) => {
  const m = await montar(t, { perfil: { pizarron: { habilitado: true } } });
  const pizarron = crearPizarron({ dir: path.join(m.base, 'pizarron') });
  const gestor = crearGestorConPizarron(m.almacen, {
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([{ ruta: '.orq/aporte.json', contenido: '{ roto' }]),
    }),
    pizarron,
    home: m.home,
    fake: m.fake,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(pizarron.leer().version, 0);
  assert.equal(leerEventos(m.estadoDir, trabajo.id).filter((e) => e.tipo === 'pizarron.post').length, 0);

  await gestor.cerrar();
});

test('pizarrón: maxEntradasPorTrabajo recorta el aporte a las primeras N entradas', async (t) => {
  const m = await montar(t, { perfil: { pizarron: { habilitado: true, maxEntradasPorTrabajo: 2 } } });
  const pizarron = crearPizarron({ dir: path.join(m.base, 'pizarron') });
  const aporte = JSON.stringify({
    entradas: [
      { clave: 'contrato.uno', valor: 1 },
      { clave: 'contrato.dos', valor: 2 },
      { clave: 'contrato.tres', valor: 3 },
    ],
  });
  const gestor = crearGestorConPizarron(m.almacen, {
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([{ ruta: '.orq/aporte.json', contenido: aporte }]),
    }),
    pizarron,
    home: m.home,
    fake: m.fake,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');

  const claves = Object.keys(pizarron.leer().claves);
  assert.deepEqual(claves.sort(), ['contrato.dos', 'contrato.uno'], 'solo entran las primeras 2');

  await gestor.cerrar();
});

test('pizarrón deshabilitado: no crea el enlace ni agrega instrucciones al prompt', async (t) => {
  const m = await montar(t); // sin `pizarron`: por defecto deshabilitado
  const pizarron = crearPizarron({ dir: path.join(m.base, 'pizarron') });
  const volcado = path.join(m.base, 'volcado.json');
  const gestor = crearGestorConPizarron(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js', ORQ_FAKE_VOLCADO: volcado }),
    pizarron,
    home: m.home,
    fake: m.fake,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');

  assert.equal(
    fs.existsSync(path.join(fin.worktree, '.orq', 'pizarron.json')),
    false,
    'sin pizarrón habilitado no debe haber enlace',
  );
  const info = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  const prompt = info.args[info.args.length - 1];
  assert.doesNotMatch(prompt, /PIZARRÓN COMPARTIDO/);
  assert.equal(fs.existsSync(pizarron.rutaViva()), false, 'el pizarrón no se escribe si está deshabilitado');

  await gestor.cerrar();
});

test('pizarrón habilitado: agrega las instrucciones al prompt del agente', async (t) => {
  const m = await montar(t, { perfil: { pizarron: { habilitado: true } } });
  const pizarron = crearPizarron({ dir: path.join(m.base, 'pizarron') });
  const volcado = path.join(m.base, 'volcado.json');
  const gestor = crearGestorConPizarron(m.almacen, {
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js', ORQ_FAKE_VOLCADO: volcado }),
    pizarron,
    home: m.home,
    fake: m.fake,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');

  const info = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  const prompt = info.args[info.args.length - 1];
  assert.match(prompt, /PIZARRÓN COMPARTIDO/);
  assert.match(prompt, /\.orq\/aporte\.json/);

  await gestor.cerrar();
});

test('pizarrón: un aporte gigante se ignora y avisa UNA sola vez por trabajo', async (t) => {
  const m = await montar(t, { perfil: { pizarron: { habilitado: true } } });
  const pizarron = crearPizarron({ dir: path.join(m.base, 'pizarron') });
  // Script que escribe un `.orq/aporte.json` de 1,1 MB y se queda un rato: así el
  // vigilante de alcance (cada 150 ms) intenta fusionarlo varias veces.
  const guion = path.join(m.base, 'opencode-aporte-grande.mjs');
  fs.writeFileSync(
    guion,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const destino = path.resolve(process.cwd(), '.orq/aporte.json');",
      "fs.mkdirSync(path.dirname(destino), { recursive: true });",
      "fs.writeFileSync(destino, '{\"entradas\":[' + ' '.repeat(1100000) + ']}');",
      'await new Promise((resolve) => setTimeout(resolve, 1200));',
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  const gestor = crearGestorConPizarron(m.almacen, {
    entorno: entornoFalso({}),
    pizarron,
    home: m.home,
    fake: guion,
    vigilanciaAlcanceMs: 150,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(pizarron.leer().version, 0, 'el aporte gigante no se fusiona');

  const eventos = leerEventos(m.estadoDir, trabajo.id).filter((e) => e.tipo === 'pizarron.aporte_invalido');
  assert.equal(eventos.length, 1, 'el aviso se emite una sola vez por trabajo');
  assert.equal(eventos[0].motivo, 'demasiado_grande');

  await gestor.cerrar();
});
