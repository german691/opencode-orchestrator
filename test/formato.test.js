import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describirEstado,
  describirPerfil,
  describirPizarronClave,
  describirPizarronLista,
  describirTerminado,
} from '../src/mcp/formato.js';

const base = (aceptacion) => ({
  id: 'abc12345',
  estado: 'rejected',
  mode: 'safe',
  isolation: 'worktree',
  creadoEn: 0,
  finEn: 5000,
  motivoFin: 'aceptacion',
  resultado: { archivos: ['a.js'], aceptacion },
});

test('un rechazo por aceptación muestra primero el bloque de fallos extraído', () => {
  const texto = describirTerminado(
    base({ ejecutada: true, cmd: 'npm test', exit: 1, motivo: 'exit', cola: 'final del stdout', fallos: 'FAIL  a.test.ts\nError: boom' }),
  );
  assert.match(texto, /--- fallos de la aceptacion ---\nFAIL {2}a\.test\.ts\nError: boom/);
  assert.doesNotMatch(texto, /final del stdout/);
});

test('sin bloque de fallos reconocido cae al final del stdout', () => {
  const texto = describirTerminado(base({ ejecutada: true, cmd: 'npm test', exit: 1, motivo: 'exit', cola: 'final del stdout' }));
  assert.match(texto, /--- salida de la aceptacion ---\nfinal del stdout/);
});

test('una aceptación que pasó no imprime ni fallos ni salida', () => {
  const texto = describirTerminado({
    ...base({ ejecutada: true, cmd: 'npm test', exit: 0, motivo: 'exit', cola: 'todo bien', fallos: 'nunca' }),
    estado: 'succeeded',
    motivoFin: null,
  });
  assert.match(texto, /aceptacion: OK/);
  assert.doesNotMatch(texto, /fallos de la aceptacion|salida de la aceptacion/);
});

test('describirEspera y el listado dicen por qué un trabajo sigue en cola', async () => {
  const { describirEspera, describirListado, describirActivo } = await import('../src/mcp/formato.js');
  const t = {
    id: 'q1',
    estado: 'queued',
    mode: 'safe',
    isolation: 'worktree',
    creadoEn: 0,
    titulo: 'T',
    espera: { motivo: 'solapa_alcance', por: ['aaa', 'bbb'] },
  };
  assert.match(describirEspera(t), /se solapan.*\[aaa, bbb\]/);
  assert.equal(describirEspera({ ...t, espera: null }), '');
  assert.match(describirListado([t], { concurrencia: 1, corriendo: [], enCola: ['q1'] }), /espera: .*\[aaa, bbb\]/);
  assert.match(describirActivo(t, 1000), /En cola porque: .*\[aaa, bbb\]/);
});

test('describirActivo: la explicación es UNA línea de ≤ 100 caracteres y se puede omitir', async () => {
  const { describirActivo, EXPLICACION_ACTIVO } = await import('../src/mcp/formato.js');
  const t = { id: 'q1', estado: 'running', creadoEn: 0, titulo: 'T' };
  const conExplicacion = describirActivo(t, 1000);
  assert.ok(conExplicacion.includes(EXPLICACION_ACTIVO));
  assert.ok(EXPLICACION_ACTIVO.length <= 100, `la explicación debe medir ≤ 100 (mide ${EXPLICACION_ACTIVO.length})`);
  assert.equal(conExplicacion.split('\n').length, 2, 'mensaje + una sola línea de explicación');
  const sinExplicacion = describirActivo(t, 1000, { conExplicacion: false });
  assert.ok(!sinExplicacion.includes(EXPLICACION_ACTIVO));
  assert.equal(sinExplicacion.split('\n').length, 1);
});

test('describirTerminado: un proceso terminado por señal lo informa; un exit normal no', () => {
  const conSenal = {
    ...base(null),
    estado: 'failed',
    motivoFin: 'timeout',
    resultado: { proceso: { exit: null, senal: 'SIGKILL', motivo: 'timeout' } },
  };
  assert.match(describirTerminado(conSenal), /terminado por señal SIGKILL/);
  assert.doesNotMatch(describirTerminado({ ...base(null), resultado: { proceso: { exit: 0, senal: null } } }), /terminado por señal/);
  assert.doesNotMatch(describirTerminado({ ...base(null), resultado: {} }), /terminado por señal/);
});

test('describirEspera: los topes nuevos de concurrencia se explican en texto', async () => {
  const { describirEspera } = await import('../src/mcp/formato.js');
  const repo = { espera: { motivo: 'tope_del_repo', por: [] } };
  const global = { espera: { motivo: 'tope_global', por: [] } };
  assert.match(describirEspera(repo), /tope de concurrencia de su repositorio/);
  assert.match(describirEspera(global), /tope de concurrencia global/);
});

test('salida del agente: por defecto solo las últimas 40 líneas y ofrece recuperar todo con completo', () => {
  const salida = Array.from({ length: 60 }, (_, i) => `linea ${i}`).join('\n');
  const porDefecto = describirTerminado({ ...base(null), resultado: {} }, { salida });
  assert.match(porDefecto, /linea 59/);
  assert.match(porDefecto, /linea 20/);
  assert.doesNotMatch(porDefecto, /linea 19\b/);
  assert.match(porDefecto, /líneas omitidas/);
  assert.match(porDefecto, /\(salida completa: opencode_logs job_id=abc12345\)/);

  const completo = describirTerminado({ ...base(null), resultado: {} }, { salida }, { completo: true });
  assert.match(completo, /linea 0\b/);
  assert.doesNotMatch(completo, /líneas omitidas/);
  assert.doesNotMatch(completo, /salida completa: opencode_logs/);
});

test('stderr: por defecto solo las últimas 15 líneas', () => {
  const errores = Array.from({ length: 30 }, (_, i) => `err ${i}`).join('\n');
  const texto = describirTerminado({ ...base(null), estado: 'failed', resultado: {} }, { errores });
  assert.match(texto, /err 29/);
  assert.match(texto, /err 15/);
  assert.doesNotMatch(texto, /err 14\b/);
});

test('log de aceptación fallido: coincidencias primero, sin subtests ok y con tope', () => {
  const lineas = Array.from({ length: 60 }, (_, i) => `linea ${i}`);
  lineas.push('ok 1 - subtest que pasó');
  lineas.push('  duration_ms: 12');
  lineas.push('FAIL test/x.test.js');
  lineas.push('AssertionError: boom');
  const cola = lineas.join('\n');

  const texto = describirTerminado(base({ ejecutada: true, cmd: 'npm test', exit: 1, motivo: 'exit', cola }));
  assert.match(texto, /FAIL test\/x\.test\.js\nAssertionError: boom/);
  assert.doesNotMatch(texto, /ok 1 - subtest/);
  assert.doesNotMatch(texto, /duration_ms/);
  assert.match(texto, /\(salida completa: opencode_logs job_id=abc12345\)/);

  const completo = describirTerminado(base({ ejecutada: true, cmd: 'npm test', exit: 1, motivo: 'exit', cola }), {}, { completo: true });
  assert.match(completo, /ok 1 - subtest que pasó/);
  assert.doesNotMatch(completo, /salida completa: opencode_logs/);
});

test('resultado con mutaciones: línea compacta N/M detectadas (solo si existen)', () => {
  const conMutaciones = {
    ...base(null),
    estado: 'succeeded',
    resultado: {
      mutaciones: {
        detectadas: 1,
        total: 2,
        restauradoOk: true,
        detalle: [{ estado: 'detectada' }, { estado: 'no_detectada' }],
      },
    },
  };
  assert.match(describirTerminado(conMutaciones), /mutaciones: 1\/2 detectadas/);
  assert.doesNotMatch(describirTerminado({ ...base(null), resultado: {} }), /mutaciones:/);
});

test('resultado con revisión: veredicto y hasta 5 observaciones (solo si existe)', () => {
  const conRevision = {
    ...base(null),
    estado: 'succeeded',
    resultado: { revision: { veredicto: 'OBSERVA', observaciones: ['a', 'b', 'c', 'd', 'e', 'f'] } },
  };
  const texto = describirTerminado(conRevision);
  assert.match(texto, /revisión: OBSERVA/);
  assert.match(texto, /  - a/);
  assert.match(texto, /  - e/);
  assert.doesNotMatch(texto, /  - f/);
  assert.match(describirTerminado({ ...base(null), estado: 'succeeded', resultado: { revision: { veredicto: 'APRUEBA', observaciones: [] } } }), /revisión: APRUEBA/);
  assert.doesNotMatch(describirTerminado({ ...base(null), resultado: {} }), /revisión:/);
});

test('pizarrón sin clave: versión, claves truncadas a 200 y últimas 5 notas', () => {
  const doc = {
    version: 3,
    claves: {
      'contrato.api': { valor: { ruta: '/v1' }, jobId: 'job1' },
      'nota.larga': { valor: 'x'.repeat(300), jobId: 'job2' },
    },
    notas: Array.from({ length: 7 }, (_, i) => ({ jobId: 'job1', ts: i, texto: `nota ${i}` })),
  };
  const texto = describirPizarronLista(doc);
  assert.match(texto, /pizarrón v3 \| claves=2/);
  assert.match(texto, /contrato\.api = \{"ruta":"\/v1"\}  \[job1\]/);
  assert.match(texto, /x+…  \[job2\]/, 'el valor se trunca con aviso');
  assert.doesNotMatch(texto, /x{300}/, 'no se lista el valor completo');
  assert.match(texto, /últimas notas:/);
  assert.match(texto, /nota 2/);
  assert.match(texto, /nota 6/);
  assert.doesNotMatch(texto, /nota 1\b/);
});

test('describirTerminado: un trabajo auto-integrado agrega la línea al resumen', () => {
  const conAuto = {
    ...base(null),
    estado: 'merged',
    resultado: { autoIntegrado: true, autoIntegradoEn: 'staging' },
  };
  assert.match(describirTerminado(conAuto), /integrado automáticamente en staging/);
  assert.doesNotMatch(describirTerminado({ ...base(null), resultado: {} }), /integrado automáticamente/);
});

test('describirPerfil: lista las recetas con sus parámetros requeridos', () => {
  const texto = describirPerfil({
    repo: '/r',
    archivo: '/r/.opencode-orchestrator.json',
    existe: true,
    perfil: {
      recetas: {
        tests: { prompt: 'tests de {modulo}', writes: ['{modulo}/**'], descripcion: 'corre tests' },
        revisar: { prompt: 'revisá el diff' },
      },
    },
  });
  assert.match(texto, /recetas \(2\):/);
  assert.match(texto, /tests: params: modulo - corre tests/);
  assert.match(texto, /revisar: sin parámetros/);
});

test('describirEstado: contadores, activos y succeeded sin integrar, con tope de líneas', () => {
  const trabajos = [
    { id: 'run1', estado: 'running', creadoEn: 0, titulo: 'corriendo' },
    { id: 'ver1', estado: 'verifying', creadoEn: 0, titulo: 'verificando' },
    { id: 'ok1', estado: 'succeeded', creadoEn: 0, finEn: 1000, titulo: 'listo' },
    { id: 'mg1', estado: 'merged', creadoEn: 0, finEn: 1000, titulo: 'ya integrado' },
    { id: 'fail1', estado: 'failed', creadoEn: 0, finEn: 1000, titulo: 'falló' },
  ];
  const texto = describirEstado({ trabajos, resumen: { corriendo: ['run1'], enCola: [] }, ahora: 2000 });
  const lineas = texto.split('\n');
  assert.match(lineas[0], /^corriendo=1 \| en cola=0 \| verificando=1$/);
  assert.ok(lineas.some((l) => /^run1 \| running \|/.test(l)));
  assert.ok(lineas.some((l) => /^ok1 \| succeeded \|/.test(l)));
  assert.ok(!lineas.some((l) => l.startsWith('mg1')), 'merged no se lista (ya integrado)');
  assert.ok(!lineas.some((l) => l.startsWith('fail1')), 'los fallidos no se listan');
  assert.equal(lineas.at(-1), 'sin integrar: ok1');

  // Título truncado a 60.
  const largo = describirEstado({
    trabajos: [{ id: 'x1', estado: 'running', creadoEn: 0, titulo: 'z'.repeat(120) }],
    resumen: { corriendo: ['x1'], enCola: [] },
  });
  const fila = largo.split('\n').find((l) => l.startsWith('x1'));
  assert.equal((fila.split(' | ')[3]).length, 61, '60 caracteres + el …');

  // Tope: nunca más de 25 líneas.
  const muchos = Array.from({ length: 40 }, (_, i) => ({ id: `j${i}`, estado: 'running', creadoEn: 0, titulo: 'x' }));
  const tabla = describirEstado({ trabajos: muchos, resumen: { corriendo: muchos.map((t) => t.id), enCola: [] } });
  assert.ok(tabla.split('\n').length <= 25, `tabla de ${tabla.split('\n').length} líneas`);
  assert.match(tabla, /… \(\+\d+ más\)/);
});

test('pizarrón con clave: valor completo e historial; clave ausente se informa', () => {
  const entrada = {
    valor: { ruta: '/v1', extra: 'x'.repeat(300) },
    jobId: 'job1',
    nota: 'definido',
    historial: [{ valor: 'A', ts: 1 }, { valor: 'B', ts: 2, conflicto: true }],
  };
  const texto = describirPizarronClave('contrato.api', entrada);
  assert.match(texto, /clave: contrato\.api/);
  assert.match(texto, /"extra": "x{300}"/);
  assert.match(texto, /nota: definido/);
  assert.match(texto, /historial \(2\):/);
  assert.match(texto, /\[conflicto\]/);
  assert.match(describirPizarronClave('nope', undefined), /la clave 'nope' no existe/);
});
