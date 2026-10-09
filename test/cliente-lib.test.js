import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatearDuracion,
  etiquetaEstado,
  etiquetaTipo,
  etiquetaTransicion,
  formatearHoraEvento,
  horaIsoEvento,
  motivoLegible,
  esTerminal,
  ordenarTrabajos,
  filtrarTrabajos,
  contarEstados,
  contarPorRepo,
  parsearParche,
  resumenAlcance,
  resumenTarea,
  limitarAnchoLista,
  anchoListaInicial,
  agruparTrabajos,
  tiempoRelativo,
  ordenarPor,
  segmentosDeLinea,
  coincidenciasEnLineas,
  estadisticasDeParche,
  claseDeLinea,
  debePausarSeguimiento,
  debeMostrarVacio,
  debeAutoseleccionar,
  etiquetaPestana,
  contraste,
  categoriaTipo,
} from '../src/panel/cliente-lib.js';
import { sintetizarEventos, reconstruirFaltantes, mezclarEventos } from '../src/panel/historial.js';

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
  // `icono` es el NOMBRE del ícono SVG (iconos.js), no un glifo Unicode.
  assert.equal(corre.icono, 'running');
  assert.equal(corre.clase, 'estado-activo');

  const rech = etiquetaEstado('rejected', 'alcance');
  assert.match(rech.texto, /Rechazado/);
  assert.match(rech.texto, /fuera del alcance/);
  assert.equal(rech.icono, 'rejected');

  const raro = etiquetaEstado('marciano');
  assert.equal(raro.texto, 'marciano');
  assert.equal(raro.clase, 'estado-neutro');
  assert.equal(raro.icono, 'neutro');
  // Toda etiqueta trae texto e ícono: el estado no depende del color.
  for (const estado of ['queued', 'provisioning', 'running', 'verifying', 'succeeded', 'merged', 'failed', 'cancelled', 'lost']) {
    const etiqueta = etiquetaEstado(estado);
    assert.ok(etiqueta.texto.length > 0, estado);
    assert.match(etiqueta.icono, /^[a-z][a-z-]*$/, estado);
    assert.match(etiqueta.clase, /^estado-/);
  }
  assert.equal(esTerminal('succeeded'), true);
  assert.equal(esTerminal('running'), false);
  assert.equal(motivoLegible('concurrencia'), 'tope de concurrencia alcanzado');
  assert.equal(motivoLegible(''), '');
});

test('motivoLegible: motivos de espera del planificador con su texto en claro', () => {
  // Estos motivos los emite el planificador (tope por repo, tope global y esperar
  // la integración): sin traducción la UI mostraría el crudo y confundiría.
  assert.equal(motivoLegible('tope_del_repo'), 'tope de concurrencia del repositorio');
  assert.equal(motivoLegible('tope_global'), 'tope global de concurrencia');
  assert.equal(motivoLegible('esperando_integracion'), 'esperando que se integre un trabajo anterior');
  // Un motivo desconocido se devuelve crudo (nunca vacío si el motivo existe).
  assert.equal(motivoLegible('inventado'), 'inventado');
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

test('limitarAnchoLista: acota el ancho al rango usable 280..560', () => {
  assert.equal(limitarAnchoLista(380), 380);
  assert.equal(limitarAnchoLista(100), 280);
  assert.equal(limitarAnchoLista(999), 560);
  assert.equal(limitarAnchoLista(319.6), 320);
  assert.equal(limitarAnchoLista('420'), 420);
  // Un valor corrupto o vacío cae al mínimo, nunca deja la columna inusable.
  assert.equal(limitarAnchoLista('x'), 280);
  assert.equal(limitarAnchoLista(NaN), 280);
});

test('anchoListaInicial: fluid clamp(320,28vw,420) y 440 px en pantallas anchas', () => {
  assert.equal(anchoListaInicial(390), 320);
  assert.equal(anchoListaInicial(1366), 382);
  assert.equal(anchoListaInicial(1920), 440);
  assert.equal(anchoListaInicial(1699), 420);
  assert.equal(anchoListaInicial(2560), 440);
  assert.equal(anchoListaInicial(0), 320);
});

test('agruparTrabajos: separa En curso de Terminados y omite grupos vacíos', () => {
  const lista = [
    { id: 'corre', estado: 'running' },
    { id: 'cola', estado: 'queued' },
    { id: 'ok', estado: 'succeeded' },
    { id: 'mal', estado: 'failed' },
  ];
  const grupos = agruparTrabajos(lista);
  assert.deepEqual(grupos.map((g) => [g.clave, g.etiqueta, g.trabajos.map((t) => t.id)]), [
    ['curso', 'En curso', ['corre', 'cola']],
    ['terminados', 'Terminados', ['ok', 'mal']],
  ]);
  assert.deepEqual(agruparTrabajos([{ id: 'x', estado: 'running' }]).map((g) => g.clave), ['curso']);
  assert.deepEqual(agruparTrabajos([]), []);
});

test('tiempoRelativo: hace X s/min/h/d y vacío sin timestamp', () => {
  const ahora = 1_800_000_000_000;
  assert.equal(tiempoRelativo(ahora - 3_000, ahora), 'recién');
  assert.equal(tiempoRelativo(ahora - 30_000, ahora), 'hace 30 s');
  assert.equal(tiempoRelativo(ahora - 5 * 60_000, ahora), 'hace 5 min');
  assert.equal(tiempoRelativo(ahora - 3 * 3_600_000, ahora), 'hace 3 h');
  assert.equal(tiempoRelativo(ahora - 2 * 86_400_000, ahora), 'hace 2 d');
  assert.equal(tiempoRelativo(null, ahora), '');
  assert.equal(tiempoRelativo(0, ahora), '');
});

test('ordenarPor: actividad (defecto), estado y creación', () => {
  const lista = [
    { id: 'ok', estado: 'succeeded', creadoEn: 300, actividadEn: 100 },
    { id: 'corre', estado: 'running', creadoEn: 100, actividadEn: 500 },
    { id: 'cola', estado: 'queued', creadoEn: 200, actividadEn: 300 },
  ];
  assert.deepEqual(ordenarPor(lista).map((j) => j.id), ['corre', 'cola', 'ok']);
  assert.deepEqual(ordenarPor(lista, 'creacion').map((j) => j.id), ['ok', 'cola', 'corre']);
  assert.deepEqual(ordenarPor(lista, 'estado').map((j) => j.id), ['corre', 'cola', 'ok']);
  // No muta la entrada.
  assert.deepEqual(lista.map((j) => j.id), ['ok', 'corre', 'cola']);
});

test('filtrarTrabajos: por repositorio (repoNombre) y conteo por repo', () => {
  const lista = [
    { id: 'a1', estado: 'running', repoNombre: 'compras' },
    { id: 'a2', estado: 'queued', repoNombre: 'compras' },
    { id: 'b1', estado: 'failed', repoNombre: 'opencode-orchestrator' },
    { id: 'c1', estado: 'succeeded' },
  ];
  assert.deepEqual(filtrarTrabajos(lista, { repo: 'compras' }).map((j) => j.id), ['a1', 'a2']);
  assert.deepEqual(filtrarTrabajos(lista, { repo: 'compras', estado: 'activos' }).map((j) => j.id), ['a1', 'a2']);
  assert.deepEqual(filtrarTrabajos(lista, { repo: 'opencode-orchestrator' }).map((j) => j.id), ['b1']);
  assert.deepEqual(filtrarTrabajos(lista, { repo: 'nope' }), []);
  // Sin repo no filtra por repositorio.
  assert.equal(filtrarTrabajos(lista, { repo: null }).length, 4);

  const conteos = contarPorRepo(lista);
  assert.equal(conteos.get('compras'), 2);
  assert.equal(conteos.get('opencode-orchestrator'), 1);
  assert.equal(conteos.get('(sin repo)'), 1);
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

test('etiquetaTipo: tipos de evento traducidos a español y crudo si no se conoce', () => {
  assert.equal(etiquetaTipo('job.creado'), 'Trabajo creado');
  assert.equal(etiquetaTipo('job.estado'), 'Cambio de estado');
  assert.equal(etiquetaTipo('job.fin'), 'Trabajo terminado');
  assert.equal(etiquetaTipo('job.espera'), 'En cola');
  assert.equal(etiquetaTipo('job.reintento'), 'Reintento');
  assert.equal(etiquetaTipo('job.reanudado'), 'Reanudado');
  assert.equal(etiquetaTipo('job.cancelado'), 'Cancelado');
  assert.equal(etiquetaTipo('job.mutaciones'), 'Mutaciones');
  assert.equal(etiquetaTipo('job.revision'), 'Revisión');
  assert.equal(etiquetaTipo('merge'), 'Integrado');
  assert.equal(etiquetaTipo('avanzar_base'), 'Base avanzada');
  assert.equal(etiquetaTipo('cleanup'), 'Limpieza');
  assert.equal(etiquetaTipo('pizarron.post'), 'Pizarrón: aporte');
  assert.equal(etiquetaTipo('pizarron.aporte_invalido'), 'Pizarrón: aporte inválido');
  assert.equal(etiquetaTipo('servidor.arranque'), 'Servidor iniciado');
  assert.equal(etiquetaTipo('servidor.recuperacion'), 'Recuperación al iniciar');
  assert.equal(etiquetaTipo('inventado'), 'inventado');
  assert.equal(etiquetaTipo(undefined), '');
});

test('etiquetaTransicion: texto anterior → nuevo, nunca solo color', () => {
  assert.equal(etiquetaTransicion({ estado: 'running' }), 'Corriendo');
  assert.equal(etiquetaTransicion({ anterior: 'queued', estado: 'running' }), 'En cola → Corriendo');
  assert.equal(etiquetaTransicion({}), '');
  assert.equal(etiquetaTransicion(null), '');
  // Un estado desconocido se muestra crudo, pero con texto legible al lado.
  assert.equal(etiquetaTransicion({ anterior: 'raro', estado: 'running' }), 'raro → Corriendo');
});

test('formatearHoraEvento: dd/mm hh:mm:ss local y vacío sin timestamp', () => {
  const ts = Date.parse('2026-10-09T15:04:05');
  const fecha = new Date(ts);
  const dos = (valor) => String(valor).padStart(2, '0');
  const esperado =
    `${dos(fecha.getDate())}/${dos(fecha.getMonth() + 1)} ` +
    `${dos(fecha.getHours())}:${dos(fecha.getMinutes())}:${dos(fecha.getSeconds())}`;
  assert.equal(formatearHoraEvento(ts), esperado);
  assert.equal(formatearHoraEvento(null), '');
  assert.equal(formatearHoraEvento('x'), '');
  assert.equal(horaIsoEvento(ts), new Date(ts).toISOString());
  assert.equal(horaIsoEvento(undefined), '');
});

test('sintetizarEventos: creado, inicio y fin desde job.json (puro)', () => {
  const completo = sintetizarEventos({
    id: 'abc12345',
    estado: 'succeeded',
    creadoEn: 1000,
    inicioEn: 2000,
    finEn: 3000,
    motivoFin: null,
  });
  assert.deepEqual(
    completo.map((e) => [e.tipo, e.ts, e.origen]),
    [
      ['job.creado', 1000, 'reconstruido'],
      ['job.estado', 2000, 'reconstruido'],
      ['job.fin', 3000, 'reconstruido'],
    ],
  );
  assert.equal(completo[1].anterior, 'queued');
  assert.equal(completo[1].estado, 'running');
  assert.equal(completo[2].estado, 'succeeded');

  // Un trabajo corriendo no tiene fin; uno en cola, ni inicio ni fin.
  assert.deepEqual(
    sintetizarEventos({ id: 'x', estado: 'running', creadoEn: 10, inicioEn: 20 }).map((e) => e.tipo),
    ['job.creado', 'job.estado'],
  );
  assert.deepEqual(sintetizarEventos({ id: 'x', estado: 'queued', creadoEn: 5 }).map((e) => e.tipo), ['job.creado']);
  assert.deepEqual(sintetizarEventos(null), []);
  assert.deepEqual(sintetizarEventos({ id: 'x', estado: 'queued' }), []);
});

test('reconstruirFaltantes: no reconstruye un trabajo que ya tiene registro', () => {
  const trabajos = [
    { id: 'con', estado: 'succeeded', creadoEn: 1, finEn: 3 },
    { id: 'sin', estado: 'running', creadoEn: 2 },
  ];
  const eventos = reconstruirFaltantes(trabajos, new Set(['con']));
  assert.deepEqual(eventos.map((e) => e.jobId), ['sin']);
  assert.ok(eventos.every((e) => e.origen === 'reconstruido'));
  assert.deepEqual(reconstruirFaltantes([], new Set()), []);
});

test('mezclarEventos: orden desc mezclando ambos orígenes, filtros y límite (puro)', () => {
  const reales = [
    { ts: 5000, tipo: 'job.creado', jobId: 'nuevo' },
    { ts: 1000, tipo: 'job.fin', jobId: 'nuevo' },
  ];
  const reconstruidos = [
    { ts: 4000, tipo: 'job.fin', jobId: 'viejo', origen: 'reconstruido' },
    { ts: 3000, tipo: 'job.creado', jobId: 'viejo', origen: 'reconstruido' },
  ];
  assert.deepEqual(
    mezclarEventos(reales, reconstruidos, {}).map((e) => [e.ts, e.origen]),
    [
      [5000, 'registro'],
      [4000, 'reconstruido'],
      [3000, 'reconstruido'],
      [1000, 'registro'],
    ],
  );
  assert.deepEqual(mezclarEventos(reales, reconstruidos, { jobId: 'viejo' }).map((e) => e.ts), [4000, 3000]);
  assert.deepEqual(mezclarEventos(reales, reconstruidos, { tipo: 'job.fin' }).map((e) => e.ts), [4000, 1000]);
  assert.deepEqual(mezclarEventos(reales, reconstruidos, { desde: 3500 }).map((e) => e.ts), [5000, 4000]);
  assert.deepEqual(mezclarEventos(reales, reconstruidos, { hasta: 3000 }).map((e) => e.ts), [3000, 1000]);
  assert.deepEqual(mezclarEventos(reales, reconstruidos, { limite: 2 }).map((e) => e.ts), [5000, 4000]);
  assert.deepEqual(mezclarEventos(reales, reconstruidos, { limite: 0 }), []);
  assert.deepEqual(mezclarEventos(reales, reconstruidos, { orden: 'asc' }).map((e) => e.ts), [1000, 3000, 4000, 5000]);
  // La entrada no se muta.
  assert.equal(reales[0].origen, undefined);
});

test('segmentosDeLinea: separa lo que coincide de lo que no, con consulta vacía', () => {
  assert.deepEqual(segmentosDeLinea('error total', ''), [{ texto: 'error total', coincide: false }]);
  assert.deepEqual(segmentosDeLinea('abc', 'b'), [
    { texto: 'a', coincide: false },
    { texto: 'b', coincide: true },
    { texto: 'c', coincide: false },
  ]);
  // Todo el texto coincide y la búsqueda ignora mayúsculas.
  assert.deepEqual(segmentosDeLinea('ERROR', 'error'), [{ texto: 'ERROR', coincide: true }]);
  assert.deepEqual(segmentosDeLinea('', 'x'), [{ texto: '', coincide: false }]);
});

test('coincidenciasEnLineas: línea y rango de cada aparición', () => {
  const lineas = ['hola mundo', 'sin nada', 'mundo y más mundo'];
  assert.deepEqual(coincidenciasEnLineas(lineas, ''), []);
  assert.deepEqual(coincidenciasEnLineas(lineas, 'mundo'), [
    { linea: 0, inicio: 5, fin: 10 },
    { linea: 2, inicio: 0, fin: 5 },
    { linea: 2, inicio: 12, fin: 17 },
  ]);
  // El conteo de «n de m» sale directo del largo.
  assert.equal(coincidenciasEnLineas(lineas, 'ausente').length, 0);
});

test('estadisticasDeParche: suma archivos, altas y bajas', () => {
  const stats = estadisticasDeParche([
    { adiciones: 3, eliminaciones: 1 },
    { adiciones: 2, eliminaciones: 4 },
    { ruta: 'sin conteo' },
  ]);
  assert.deepEqual([stats.archivos, stats.adiciones, stats.eliminaciones, stats.total], [3, 5, 5, 10]);
  assert.match(stats.texto, /3 archivo\(s\) · \+5 −5/);
  assert.deepEqual(estadisticasDeParche(null), { archivos: 0, adiciones: 0, eliminaciones: 0, total: 0, texto: '0 archivo(s) · +0 −0' });
});

test('claseDeLinea: error gana al éxito y el color es solo un refuerzo', () => {
  assert.equal(claseDeLinea('✔ tests pass'), 'linea-ok');
  assert.equal(claseDeLinea('FATAL error de red'), 'linea-error');
  assert.equal(claseDeLinea('error: FAIL al compilar'), 'linea-error');
  // Una línea con ambas señales no debe quedar en verde.
  assert.equal(claseDeLinea('✔ 5 pass, 1 fail'), 'linea-error');
  assert.equal(claseDeLinea('línea común'), '');
  assert.equal(claseDeLinea(''), '');
});

test('debePausarSeguimiento: pausa al alejarse del final y tolera el umbral', () => {
  assert.equal(debePausarSeguimiento({ scrollTop: 100, scrollHeight: 400, clientHeight: 300 }), false);
  assert.equal(debePausarSeguimiento({ scrollTop: 100, scrollHeight: 500, clientHeight: 300 }), true);
  // Unos pocos píxeles de diferencia no pausan (ruido de subpíxel/trackpad).
  assert.equal(debePausarSeguimiento({ scrollTop: 100, scrollHeight: 410, clientHeight: 300 }), false);
  assert.equal(debePausarSeguimiento({}, 0), false);
});

test('contraste: razón WCAG entre colores hex (y bordes con el mismo valor)', () => {
  // Extremos conocidos: blanco contra negro da 21:1.
  assert.equal(Math.round(contraste('#ffffff', '#000000')), 21);
  // Simétrico y con equivalencia de hex corto.
  assert.equal(contraste('#fff', '#000'), contraste('#ffffff', '#000000'));
  // Un gris claro sobre blanco queda por debajo de AA de texto (4.5).
  assert.ok(contraste('#cccccc', '#ffffff') < 4.5);
  // El texto principal del token claro supera AA de sobra.
  assert.ok(contraste('#171a20', '#ffffff') >= 4.5);
});

test('categoriaTipo: agrupa los tipos de evento por familia', () => {
  assert.equal(categoriaTipo('job.creado'), 'job');
  assert.equal(categoriaTipo('job.fin'), 'job');
  assert.equal(categoriaTipo('merge'), 'merge');
  assert.equal(categoriaTipo('avanzar_base'), 'merge');
  assert.equal(categoriaTipo('cleanup'), 'cleanup');
  assert.equal(categoriaTipo('servidor.arranque'), 'servidor');
  assert.equal(categoriaTipo('pizarron.post'), 'pizarron');
  assert.equal(categoriaTipo('cualquiera'), 'otro');
  assert.equal(categoriaTipo(undefined), 'otro');
});

test('debeMostrarVacio: solo con 0 filas tras filtrar', () => {
  assert.equal(debeMostrarVacio(0), true);
  assert.equal(debeMostrarVacio(1), false);
  assert.equal(debeMostrarVacio(12), false);
  // Un valor ausente o no numérico no debe hacer parpadear el estado vacío.
  assert.equal(debeMostrarVacio(undefined), true);
  assert.equal(debeMostrarVacio(NaN), true);
});

test('debeAutoseleccionar: solo escritorio y sin selección previa', () => {
  assert.equal(debeAutoseleccionar(1366, false), true);
  assert.equal(debeAutoseleccionar(900, false), true);
  assert.equal(debeAutoseleccionar(899, false), false);
  assert.equal(debeAutoseleccionar(390, false), false);
  assert.equal(debeAutoseleccionar(320, false), false);
  // Con `?job` (haySeleccion) nunca auto-selecciona: se respeta la URL.
  assert.equal(debeAutoseleccionar(1366, true), false);
  assert.equal(debeAutoseleccionar(390, true), false);
});

test('etiquetaPestana: agrega el contador y omite el cero', () => {
  assert.equal(etiquetaPestana('Diff', 3), 'Diff 3');
  assert.equal(etiquetaPestana('Eventos', 12), 'Eventos 12');
  // Sin archivos/eventos la pestaña queda sin número.
  assert.equal(etiquetaPestana('Diff', 0), 'Diff');
  assert.equal(etiquetaPestana('Eventos', 0), 'Eventos');
  // Antes de cargar (undefined) tampoco inventa un número.
  assert.equal(etiquetaPestana('Diff', undefined), 'Diff');
  assert.equal(etiquetaPestana('Diff', null), 'Diff');
  assert.equal(etiquetaPestana('Diff', 'x'), 'Diff');
  assert.equal(etiquetaPestana('Diff', -2), 'Diff');
});
