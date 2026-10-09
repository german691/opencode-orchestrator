import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatearDuracion,
  etiquetaEstado,
  motivoLegible,
  esTerminal,
  ordenarTrabajos,
  filtrarTrabajos,
  contarEstados,
  parsearParche,
  resumenAlcance,
  resumenTarea,
} from '../src/panel/cliente-lib.js';

test('formatearDuracion: segundos, minutos, horas y días', () => {
  assert.equal(formatearDuracion(null), '–');
  assert.equal(formatearDuracion(undefined), '–');
  assert.equal(formatearDuracion(NaN), '–');
  assert.equal(formatearDuracion(0), '0 s');
  assert.equal(formatearDuracion(45), '45 s');
  assert.equal(formatearDuracion(90), '1 min 30 s');
  assert.equal(formatearDuracion(120), '2 min');
  assert.equal(formatearDuracion(3600), '1 h');
  assert.equal(formatearDuracion(3661), '1 h 1 min');
  assert.equal(formatearDuracion(90000), '1 d 1 h');
});

test('etiquetaEstado: texto + ícono + clase, nunca solo color', () => {
  const corre = etiquetaEstado('running');
  assert.equal(corre.texto, 'Corriendo');
  assert.equal(corre.icono, '▶');
  assert.equal(corre.clase, 'estado-activo');

  const rech = etiquetaEstado('rejected', 'alcance');
  assert.match(rech.texto, /Rechazado/);
  assert.match(rech.texto, /fuera del alcance/);
  assert.equal(rech.icono, '⛔');

  const raro = etiquetaEstado('marciano');
  assert.equal(raro.texto, 'marciano');
  assert.equal(raro.clase, 'estado-neutro');
  assert.ok(raro.icono.length > 0);
  // Toda etiqueta trae texto e ícono: el estado no depende del color.
  for (const estado of ['queued', 'provisioning', 'running', 'verifying', 'succeeded', 'merged', 'failed', 'cancelled', 'lost']) {
    const etiqueta = etiquetaEstado(estado);
    assert.ok(etiqueta.texto.length > 0, estado);
    assert.ok(etiqueta.icono.length > 0, estado);
    assert.match(etiqueta.clase, /^estado-/);
  }
  assert.equal(esTerminal('succeeded'), true);
  assert.equal(esTerminal('running'), false);
  assert.equal(motivoLegible('concurrencia'), 'tope de concurrencia alcanzado');
  assert.equal(motivoLegible(''), '');
});

test('ordenarTrabajos: activos primero y, dentro del grupo, el más reciente', () => {
  const lista = [
    { id: 'ok', estado: 'succeeded', creadoEn: 300 },
    { id: 'corre', estado: 'running', creadoEn: 100 },
    { id: 'cola', estado: 'queued', creadoEn: 200 },
  ];
  assert.deepEqual(ordenarTrabajos(lista).map((j) => j.id), ['cola', 'corre', 'ok']);
  assert.deepEqual(ordenarTrabajos(lista, { activosPrimero: false }).map((j) => j.id), ['ok', 'cola', 'corre']);
  // No muta la entrada.
  assert.deepEqual(lista.map((j) => j.id), ['ok', 'corre', 'cola']);
});

test('ordenarTrabajos: usa actividadEn (actividad reciente) cuando existe', () => {
  const lista = [
    { id: 'encoladoAntes', estado: 'running', creadoEn: 100, actividadEn: 500 },
    { id: 'encoladoDespues', estado: 'running', creadoEn: 400, actividadEn: 300 },
  ];
  // Gana el que tuvo actividad más reciente, no el que se creó último.
  assert.deepEqual(ordenarTrabajos(lista).map((j) => j.id), ['encoladoAntes', 'encoladoDespues']);
});

test('resumenTarea: primeras líneas con elipsis si el prompt es más largo', () => {
  assert.equal(resumenTarea('', 4), '');
  assert.equal(resumenTarea(null, 4), '');
  assert.equal(resumenTarea('una\ndos\ntres', 4), 'una\ndos\ntres');
  const largo = 'l1\nl2\nl3\nl4\nl5\nl6';
  assert.equal(resumenTarea(largo, 4), 'l1\nl2\nl3\nl4…');
  assert.equal(resumenTarea(largo, 1), 'l1…');
  assert.equal(resumenTarea('solo una', 4), 'solo una');
});

test('filtrarTrabajos: por categoría de chip y por texto', () => {
  const lista = [
    { id: 'a1', estado: 'running', titulo: 'Refactor login', rama: 'feat/login', modelo: 'gpt' },
    { id: 'a2', estado: 'queued', titulo: 'Arreglar tests' },
    { id: 'b1', estado: 'failed', titulo: 'Migrar base' },
    { id: 'b2', estado: 'rejected', titulo: 'Alcance prohibido' },
    { id: 'c1', estado: 'succeeded', titulo: 'Documentar' },
    { id: 'c2', estado: 'merged', titulo: 'Integrar' },
  ];
  assert.equal(filtrarTrabajos(lista, { estado: 'todos' }).length, 6);
  assert.deepEqual(filtrarTrabajos(lista, { estado: 'activos' }).map((j) => j.id), ['a1', 'a2']);
  assert.deepEqual(filtrarTrabajos(lista, { estado: 'fallidos' }).map((j) => j.id), ['b1', 'b2']);
  assert.deepEqual(filtrarTrabajos(lista, { estado: 'terminados' }).map((j) => j.id), ['c1', 'c2']);
  assert.deepEqual(filtrarTrabajos(lista, { texto: 'login' }).map((j) => j.id), ['a1']);
  assert.deepEqual(filtrarTrabajos(lista, { texto: 'FEAT/LOGIN' }).map((j) => j.id), ['a1']);
  assert.deepEqual(filtrarTrabajos(lista, { estado: 'activos', texto: 'tests' }).map((j) => j.id), ['a2']);
  assert.deepEqual(filtrarTrabajos(lista, { texto: 'nada' }), []);
  assert.deepEqual(contarEstados(lista), { todos: 6, activos: 2, fallidos: 2, terminados: 2 });
});

test('parsearParche: archivo modificado con números de línea por lado', () => {
  const parche = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,4 @@',
    ' uno',
    '+dos',
    ' tres',
    ' cuatro',
  ].join('\n');
  const archivos = parsearParche(parche);
  assert.equal(archivos.length, 1);
  const [archivo] = archivos;
  assert.equal(archivo.viejo, 'a.txt');
  assert.equal(archivo.nuevo, 'a.txt');
  assert.equal(archivo.estado, 'mod');
  assert.equal(archivo.binario, false);
  assert.equal(archivo.adiciones, 1);
  assert.equal(archivo.eliminaciones, 0);
  assert.equal(archivo.hunks.length, 1);
  const [hunk] = archivo.hunks;
  assert.deepEqual([hunk.n1, hunk.c1, hunk.n2, hunk.c2], [1, 3, 1, 4]);
  assert.deepEqual(hunk.lineas.map((l) => [l.tipo, l.n1, l.n2, l.texto]), [
    ['ctx', 1, 1, 'uno'],
    ['add', null, 2, 'dos'],
    ['ctx', 2, 3, 'tres'],
    ['ctx', 3, 4, 'cuatro'],
  ]);
});

test('parsearParche: archivo nuevo, borrado, renombrado y binario', () => {
  const nuevo = [
    'diff --git a/nuevo.txt b/nuevo.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/nuevo.txt',
    '@@ -0,0 +1,2 @@',
    '+hola',
    '+mundo',
  ].join('\n');
  const borrado = [
    'diff --git a/viejo.txt b/viejo.txt',
    'deleted file mode 100644',
    '--- a/viejo.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-adiós',
  ].join('\n');
  const renombrado = [
    'diff --git a/origen.txt b/destino.txt',
    'similarity index 100%',
    'rename from origen.txt',
    'rename to destino.txt',
  ].join('\n');
  const binario = [
    'diff --git a/img.png b/img.png',
    'index 111..222 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');

  const archivos = parsearParche([nuevo, borrado, renombrado, binario].join('\n'));
  assert.equal(archivos.length, 4);

  assert.equal(archivos[0].estado, 'add');
  assert.equal(archivos[0].viejo, null);
  assert.equal(archivos[0].nuevo, 'nuevo.txt');
  assert.equal(archivos[0].adiciones, 2);
  assert.deepEqual(archivos[0].hunks[0].lineas.map((l) => [l.n2, l.texto]), [[1, 'hola'], [2, 'mundo']]);

  assert.equal(archivos[1].estado, 'del');
  assert.equal(archivos[1].nuevo, null);
  assert.equal(archivos[1].eliminaciones, 1);
  assert.deepEqual(archivos[1].hunks[0].lineas[0], { tipo: 'del', n1: 1, n2: null, texto: 'adiós' });

  assert.equal(archivos[2].estado, 'rename');
  assert.deepEqual(archivos[2].renames, { de: 'origen.txt', a: 'destino.txt' });
  assert.deepEqual(archivos[2].hunks, []);

  assert.equal(archivos[3].binario, true);
  assert.deepEqual(parsearParche(''), []);
});

test('resumenAlcance: cuenta writes, protegidas, tocados y fuera', () => {
  const limpio = resumenAlcance({ writes: ['a'], protegidas: ['s/**'], tocados: [{ ruta: 'a' }], fuera: [] });
  assert.deepEqual([limpio.writes, limpio.protegidas, limpio.tocados, limpio.fuera, limpio.dentro], [1, 1, 1, 0, 1]);
  assert.equal(limpio.limpio, true);
  assert.match(limpio.texto, /todos dentro del alcance/);

  const sucio = resumenAlcance({ writes: ['a'], protegidas: [], tocados: [{ ruta: 'a' }, { ruta: 'b' }], fuera: ['b'] });
  assert.equal(sucio.fuera, 1);
  assert.equal(sucio.dentro, 1);
  assert.equal(sucio.limpio, false);
  assert.match(sucio.texto, /1 archivo\(s\) fuera del alcance de 2/);

  const vacio = resumenAlcance(null);
  assert.equal(vacio.tocados, 0);
  assert.equal(vacio.limpio, true);
});
