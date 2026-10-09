/**
 * Recetas conectadas al Gestor: `enviar` expande `receta` + `params`, las notas de la
 * llamada se agregan al prompt y los campos explícitos pisan a los de la receta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { crearGestor, entornoFalso, montar } from './gestor-comun.js';

/** Perfil con una receta que escribe dentro de `{modulo}` y usa la aceptación por defecto. */
const PERFIL = {
  recetas: {
    modulo: { prompt: 'Escribí los tests de {modulo}', writes: ['{modulo}/**'] },
  },
};

test('recetas: enviar expande prompt y writes, y el agente recibe el prompt expandido', async (t) => {
  const m = await montar(t, { perfil: PERFIL });
  const volcado = path.join(m.base, 'volcado.json');
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/x.test.js', ORQ_FAKE_VOLCADO: volcado }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ cwd: m.repo, receta: 'modulo', params: { modulo: 'subA' } });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.deepEqual(fin.writes, ['subA/**'], 'los writes de la receta se expandieron');
  assert.equal(fin.mode, 'safe');
  const info = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  const prompt = info.args[info.args.length - 1];
  assert.match(prompt, /Escribí los tests de subA/);
  assert.doesNotMatch(prompt, /Notas adicionales/);

  await gestor.cerrar();
});

test('recetas: las notas de la llamada se agregan y los campos explícitos pisan a la receta', async (t) => {
  const m = await montar(t, { perfil: PERFIL });
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subB/x.test.js' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({
    cwd: m.repo,
    receta: 'modulo',
    params: { modulo: 'subA' },
    prompt: 'nota extra',
    writes: ['subB/**'],
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.match(fin.prompt, /Escribí los tests de subA/);
  assert.match(fin.prompt, /Notas adicionales:\nnota extra$/);
  assert.deepEqual(fin.writes, ['subB/**'], 'el writes explícito gana');

  await gestor.cerrar();
});

test('recetas: receta desconocida y parámetro faltante se rechazan sin crear trabajo', async (t) => {
  const m = await montar(t, { perfil: PERFIL });
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });

  await assert.rejects(
    () => gestor.enviar({ cwd: m.repo, receta: 'nope' }),
    /receta desconocida 'nope'/,
  );
  await assert.rejects(
    () => gestor.enviar({ cwd: m.repo, receta: 'modulo', params: {} }),
    /receta 'modulo': falta el parámetro '\{modulo\}'/,
  );
  assert.equal(gestor.listar().length, 0, 'no debe quedar ningún trabajo creado');

  await gestor.cerrar();
});
