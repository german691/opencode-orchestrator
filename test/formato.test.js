import test from 'node:test';
import assert from 'node:assert/strict';

import { describirTerminado } from '../src/mcp/formato.js';

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
