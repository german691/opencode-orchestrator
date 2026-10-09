/**
 * Revisor automático conectado al Gestor: veredictos APRUEBA/OBSERVA/INDETERMINADO, casos
 * en que NO corresponde revisar y garantía de que un fallo del revisor no rompe el trabajo.
 *
 * El opencode falso devuelve una respuesta fija cuando la invocación es del revisor
 * (variable ORQ_FAKE_REVISOR) y nunca escribe archivos pensados para el agente principal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearGestor, entornoFalso, leerEventos, montar } from './gestor-comun.js';

test('revisor: APRUEBA queda en resultado.revision y en el evento job.revision', async (t) => {
  const m = await montar(t, { perfil: { revisor: { habilitado: true } } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js', ORQ_FAKE_REVISOR: 'VEREDICTO: APRUEBA' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.revision.veredicto, 'APRUEBA');
  assert.deepEqual(fin.resultado.revision.observaciones, []);
  assert.match(fin.resultado.revision.resumen, /APRUEBA/);
  assert.ok(
    leerEventos(m.estadoDir, trabajo.id).some((e) => e.tipo === 'job.revision' && e.veredicto === 'APRUEBA'),
    'debe registrar job.revision',
  );

  await gestor.cerrar();
});

test('revisor: OBSERVA conserva hasta 5 observaciones', async (t) => {
  const m = await montar(t, { perfil: { revisor: { habilitado: true } } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR: 'subA/x.js',
      ORQ_FAKE_REVISOR: 'VEREDICTO: OBSERVA\n- falta test en subA/x.js\n- sobra un console.log',
    }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.revision.veredicto, 'OBSERVA');
  assert.deepEqual(fin.resultado.revision.observaciones, ['falta test en subA/x.js', 'sobra un console.log']);

  await gestor.cerrar();
});

test('revisor: una respuesta ilegible queda INDETERMINADO y advierte, sin fallar el trabajo', async (t) => {
  const m = await montar(t, { perfil: { revisor: { habilitado: true } } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js', ORQ_FAKE_REVISOR: 'no sé qué responder' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.revision.veredicto, 'INDETERMINADO');
  assert.ok(fin.resultado.advertencias.some((a) => /revisor/i.test(a)));

  await gestor.cerrar();
});

test('revisor: un fallo del revisor NO falla el trabajo (INDETERMINADO + advertencia)', async (t) => {
  const m = await montar(t, { perfil: { revisor: { habilitado: true } } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js', ORQ_FAKE_REVISOR: '', ORQ_FAKE_REVISOR_CODIGO: '3' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.revision.veredicto, 'INDETERMINADO');
  assert.ok(fin.resultado.advertencias.some((a) => /revisor/i.test(a)));

  await gestor.cerrar();
});

test('revisor: deshabilitado (por defecto) no lanza el revisor', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.js', ORQ_FAKE_REVISOR: 'VEREDICTO: APRUEBA' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.revision, undefined);
  assert.equal(leerEventos(m.estadoDir, trabajo.id).filter((e) => e.tipo === 'job.revision').length, 0);

  await gestor.cerrar();
});

test('revisor: un trabajo readonly no se revisa', async (t) => {
  const m = await montar(t, { perfil: { revisor: { habilitado: true } } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_REVISOR: 'VEREDICTO: APRUEBA' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'solo mira', cwd: m.repo, mode: 'readonly' });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.revision, undefined);

  await gestor.cerrar();
});

test('revisor: solo_aceptacion no se revisa (no hay diff del agente)', async (t) => {
  const m = await montar(t, { perfil: { revisor: { habilitado: true } } });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_REVISOR: 'VEREDICTO: APRUEBA' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'compuerta', cwd: m.repo, mode: 'safe', solo_aceptacion: true, accept: 'true' });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.revision, undefined);

  await gestor.cerrar();
});
