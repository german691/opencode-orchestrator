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
