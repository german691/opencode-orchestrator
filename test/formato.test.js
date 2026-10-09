import test from 'node:test';
import assert from 'node:assert/strict';

import { describirPizarronClave, describirPizarronLista, describirTerminado } from '../src/mcp/formato.js';

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
