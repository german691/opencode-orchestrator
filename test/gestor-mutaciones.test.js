/**
 * Mutaciones del servidor y compuerta en fragmentos, a nivel del Gestor.
 *
 * Se usan el opencode falso y un `ejecutarPsql` inyectado: nunca se toca Postgres real.
 * El agente falso escribe `.orq/mutaciones.json` (con `ORQ_FAKE_ESCRIBIR_CONTENIDO`) y el
 * servidor aplica, corre y RESTAURA cada mutación antes de la aceptación.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  crearGestor,
  entornoFalso,
  gitOK,
  leerEventos,
  montar,
} from './gestor-comun.js';

/** sha256 de un Buffer, igual que en el módulo de mutaciones. */
function sha(contenido) {
  return createHash('sha256').update(contenido).digest('hex');
}

/**
 * Simula una caída del servidor a mitad de una mutación: deja el archivo mutado y el
 * journal + respaldo que `ejecutarMutaciones` habría escrito antes de mutar.
 * @param {string} worktree
 * @param {string} archivoRel
 * @param {Buffer} original
 */
function simularMutacionPendiente(worktree, archivoRel, original) {
  const dirOrq = path.join(worktree, '.orq');
  fs.mkdirSync(dirOrq, { recursive: true });
  fs.writeFileSync(path.join(worktree, archivoRel), 'MUTADO\n');
  fs.writeFileSync(path.join(dirOrq, 'mutacion-pendiente.bak'), original);
  fs.writeFileSync(
    path.join(dirOrq, 'mutacion-pendiente.json'),
    JSON.stringify({ archivo: archivoRel, sha256Original: sha(original), rutaRespaldo: '.orq/mutacion-pendiente.bak' }),
  );
}

/**
 * Agrega y commitea un archivo en la rama main del repo montado, para que el worktree
 * del trabajo lo herede como código existente.
 * @param {string} repo
 * @param {string} relativa
 * @param {string} contenido
 */
async function commitArchivo(repo, relativa, contenido) {
  const absoluta = path.join(repo, relativa);
  fs.mkdirSync(path.dirname(absoluta), { recursive: true });
  fs.writeFileSync(absoluta, contenido);
  await gitOK(['add', '-A'], repo);
  await gitOK(['commit', '-qm', `fuente ${relativa}`], repo);
}

/**
 * Contenido de un manifiesto con UNA mutación.
 * @param {{ archivo: string, buscar: string, reemplazar: string, comando: string }} mutacion
 * @returns {string}
 */
function manifiestoDe(mutacion) {
  return JSON.stringify({ mutaciones: [mutacion] });
}

test('mutaciones: el servidor aplica, detecta y RESTAURA; guarda resultado y evento', async (t) => {
  const m = await montar(t);
  await commitArchivo(m.repo, 'subA/codigo.js', 'const x = 1;\n');
  const comando = "grep -q 'const x = 1;' subA/codigo.js";
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([
        {
          ruta: '.orq/mutaciones.json',
          contenido: manifiestoDe({
            archivo: 'subA/codigo.js',
            buscar: 'const x = 1;',
            reemplazar: 'const x = 2;',
            comando,
          }),
        },
      ]),
    }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  const mut = fin.resultado.mutaciones;
  assert.equal(mut.detectadas, 1, 'la mutación rompe el grep: se detecta');
  assert.equal(mut.total, 1);
  assert.equal(mut.restauradoOk, true);
  assert.equal(mut.detalle[0].estado, 'detectada');
  assert.equal(mut.detalle[0].archivo, 'subA/codigo.js');

  // El archivo quedó byte a byte como estaba.
  assert.equal(fs.readFileSync(path.join(fin.worktree, 'subA/codigo.js'), 'utf8'), 'const x = 1;\n');
  assert.deepEqual(fin.resultado.advertencias, [], 'una mutación detectada no advierte nada');

  // `.orq` no cuenta como cambio: el trabajo no ensucia el diff ni el commit.
  assert.deepEqual(fin.resultado.archivos, []);

  const eventos = leerEventos(m.estadoDir, trabajo.id).filter((e) => e.tipo === 'job.mutaciones');
  assert.equal(eventos.length, 1, 'debe registrar el evento job.mutaciones');
  assert.equal(eventos[0].detectadas, 1);
  assert.equal(eventos[0].total, 1);
  assert.equal(eventos[0].restauradoOk, true);

  await gestor.cerrar();
});

test('mutaciones: una NO detectada advierte y, sin exigirTodas, el trabajo sigue', async (t) => {
  const m = await montar(t);
  await commitArchivo(m.repo, 'subA/codigo.js', 'const x = 1;\n');
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([
        {
          ruta: '.orq/mutaciones.json',
          contenido: manifiestoDe({
            archivo: 'subA/codigo.js',
            buscar: 'const x = 1;',
            reemplazar: 'const x = 2;',
            comando: 'true', // siempre pasa: no "nota" la mutación
          }),
        },
      ]),
    }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.mutaciones.detectadas, 0);
  assert.equal(fin.resultado.mutaciones.detalle[0].estado, 'no_detectada');
  assert.ok(
    fin.resultado.advertencias.some((a) => /MUTACION NO DETECTADA: subA\/codigo\.js con true/.test(a)),
    `falta la advertencia de mutación no detectada (${fin.resultado.advertencias.join(' | ')})`,
  );

  await gestor.cerrar();
});

test('mutaciones: un manifiesto inválido solo advierte y el trabajo no falla', async (t) => {
  const m = await montar(t);
  await commitArchivo(m.repo, 'subA/codigo.js', 'const x = 1;\n');
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([
        { ruta: '.orq/mutaciones.json', contenido: '{ esto no es json' },
      ]),
    }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.mutaciones, null);
  assert.ok(
    fin.resultado.advertencias.some((a) => /manifiesto de mutaciones inválido/.test(a)),
    `falta la advertencia de manifiesto inválido (${fin.resultado.advertencias.join(' | ')})`,
  );

  await gestor.cerrar();
});

test('mutaciones: con exigirTodas, una no detectada deja el trabajo rejected (motivo mutacion)', async (t) => {
  const m = await montar(t, { perfil: { mutaciones: { exigirTodas: true } } });
  await commitArchivo(m.repo, 'subA/codigo.js', 'const x = 1;\n');
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([
        {
          ruta: '.orq/mutaciones.json',
          contenido: manifiestoDe({
            archivo: 'subA/codigo.js',
            buscar: 'const x = 1;',
            reemplazar: 'const x = 2;',
            comando: 'true',
          }),
        },
      ]),
    }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'rejected');
  assert.equal(fin.motivoFin, 'mutacion');
  assert.equal(fin.resultado.mutaciones.detectadas, 0);
  assert.equal(fin.resultado.commit, undefined, 'un rechazo por mutación no se commitea');

  await gestor.cerrar();
});

test('mutaciones: si la restauración falla, el trabajo queda failed y NUNCA se commitea', async (t) => {
  const m = await montar(t);
  await commitArchivo(m.repo, 'subA/codigo.js', 'const x = 1;\n');
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR_CONTENIDO: JSON.stringify([
        {
          ruta: '.orq/mutaciones.json',
          contenido: manifiestoDe({
            archivo: 'subA/codigo.js',
            buscar: 'const x = 1;',
            reemplazar: 'const x = 2;',
            // Reemplaza el archivo por un enlace a /dev/null: la restauración por sha256 falla.
            comando: 'rm subA/codigo.js && ln -s /dev/null subA/codigo.js',
          }),
        },
      ]),
    }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'failed');
  assert.equal(fin.motivoFin, 'error_interno');
  assert.match(fin.error, /No se pudo restaurar un archivo mutado/);
  assert.equal(fin.resultado.commit, undefined, 'no debe commitearse un worktree que no se pudo restaurar');

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// Compuerta en fragmentos paralelos
// ---------------------------------------------------------------------------

/** Perfil con un recurso postgres por fragmento y una aceptación paralela que lo usa. */
function perfilParalelo(comando) {
  return {
    resources: {
      db: {
        kind: 'postgres-db',
        adminUrlEnv: 'ORQ_PG_ADMIN_URL',
        name: 'orq_{job}_{shard}_test',
        exportAs: 'TEST_DATABASE_URL',
      },
    },
    accept: { fragmentos: { paralelo: { shards: 2, comando, recurso: 'db' } } },
  };
}

/** `ejecutarPsql` falso: registra las sentencias y responde éxito. */
function psqlFalso(llamadas) {
  return async (args) => {
    llamadas.push(args.at(-1));
    return { code: 0, stdout: '', stderr: '' };
  };
}

test('aceptación paralela: todos los fragmentos pasan, una base por shard y se liberan', async (t) => {
  const m = await montar(t, { perfil: perfilParalelo('echo shard {i} && test -n "$TEST_DATABASE_URL"') });
  const llamadas = [];
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR: 'subA/a.js',
      ORQ_PG_ADMIN_URL: 'postgres://u:p@localhost:5432/postgres',
    }),
    home: m.home,
    ejecutarPsql: psqlFalso(llamadas),
  });

  const trabajo = await gestor.enviar({
    prompt: 'x',
    cwd: m.repo,
    mode: 'safe',
    writes: ['subA/**'],
    resources: ['db'],
    accept: 'fragmentos',
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.resultado.aceptacion.ejecutada, true);
  assert.equal(fin.resultado.aceptacion.exit, 0);
  assert.equal(fin.resultado.aceptacion.fragmentos, 2);

  const creaciones = llamadas.filter((s) => s.startsWith('CREATE DATABASE'));
  assert.equal(creaciones.length, 2, `debe crear una base por shard (${llamadas.join(' | ')})`);
  assert.equal(creaciones.some((s) => new RegExp(`"orq_${trabajo.id}_test"`).test(s)), false, 'no debe existir la base única');
  assert.ok(creaciones.some((s) => new RegExp(`"orq_${trabajo.id}_1_test"`).test(s)));
  assert.ok(creaciones.some((s) => new RegExp(`"orq_${trabajo.id}_2_test"`).test(s)));
  // Cada fragmento libera SU base: dos DROP posteriores al último CREATE.
  const ultimoCreate = llamadas.map((s, i) => [s, i]).filter(([s]) => s.startsWith('CREATE DATABASE')).at(-1)[1];
  const dropsPost = llamadas.map((s, i) => [s, i]).filter(([s, i]) => s.startsWith('DROP DATABASE') && i > ultimoCreate);
  assert.equal(dropsPost.length, 2, 'cada fragmento libera su base');

  const eventos = leerEventos(m.estadoDir, trabajo.id).filter((e) => e.tipo === 'aceptacion_paralela');
  assert.ok(eventos.some((e) => e.fase === 'inicio' && e.fragmentos === 2));
  assert.ok(eventos.some((e) => e.fase === 'fin' && e.fragmentos === 2 && e.ok === true));

  await gestor.cerrar();
});

test('aceptación paralela: un fragmento que falla rechaza y libera TODAS las bases', async (t) => {
  // El fragmento 2 falla; el 1 pasa. En el fallo, la salida combinada lista el 2 primero.
  const m = await montar(t, { perfil: perfilParalelo('echo "corriendo {i}"; test {i} -ne 2') });
  const llamadas = [];
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR: 'subA/a.js',
      ORQ_PG_ADMIN_URL: 'postgres://u:p@localhost:5432/postgres',
    }),
    home: m.home,
    ejecutarPsql: psqlFalso(llamadas),
  });

  const trabajo = await gestor.enviar({
    prompt: 'x',
    cwd: m.repo,
    mode: 'safe',
    writes: ['subA/**'],
    resources: ['db'],
    accept: 'fragmentos',
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'rejected');
  assert.equal(fin.motivoFin, 'aceptacion');
  assert.equal(fin.resultado.aceptacion.exit, 1);
  assert.equal(fin.resultado.aceptacion.fragmentos, 2);
  // Los fallidos van primero (contrato de ejecutarParalelo).
  const cola = fin.resultado.aceptacion.cola;
  assert.ok(cola.indexOf('[2/2]') !== -1 && cola.indexOf('[2/2]') < cola.indexOf('[1/2]'), cola);

  const drops = llamadas.filter((s) => s.startsWith('DROP DATABASE'));
  assert.equal(drops.length, 4, 'limpieza previa + liberación de cada uno de los dos shards');
  assert.equal(fin.resultado.commit, undefined, 'un rechazo no se commitea');

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// Recuperación de una mutación que quedó pegada por una caída del servidor
// ---------------------------------------------------------------------------

test('desde_job: restaura una mutación pendiente del worktree origen ANTES de trasladar', async (t) => {
  const m = await montar(t);
  await commitArchivo(m.repo, 'subA/pendiente.js', 'ORIGINAL\n');
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/otro.txt' }),
    home: m.home,
  });
  const original = await gestor.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const finOriginal = await gestor.esperar(original.id, 15000);
  assert.equal(finOriginal.estado, 'succeeded');
  const worktreeOrigen = finOriginal.worktree;

  // El origen "murió" con una mutación aplicada y sin restaurar.
  simularMutacionPendiente(worktreeOrigen, 'subA/pendiente.js', Buffer.from('ORIGINAL\n'));

  const reintento = await gestor.enviar({
    cwd: m.repo,
    desde_job: original.id,
    solo_aceptacion: true,
    accept: 'true',
  });
  const finReintento = await gestor.esperar(reintento.id, 15000);
  assert.equal(finReintento.estado, 'succeeded');
  assert.equal(
    fs.readFileSync(path.join(worktreeOrigen, 'subA/pendiente.js'), 'utf8'),
    'ORIGINAL\n',
    'el worktree origen debe quedar restaurado antes de trasladar',
  );
  assert.ok(
    (finReintento.resultado.advertencias ?? []).some((a) => /se restauró un archivo que había quedado mutado/.test(a)),
    `falta la advertencia de restauración (${(finReintento.resultado.advertencias ?? []).join(' | ')})`,
  );

  await gestor.cerrar();
});

test('arranque: al recuperar un trabajo huérfano se restaura el archivo que quedó mutado', async (t) => {
  const m = await montar(t);
  await commitArchivo(m.repo, 'subA/pendiente.js', 'ORIGINAL\n');
  const gestor = crearGestor(m.almacen, {
    fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'subA/otro.txt' }),
    home: m.home,
  });
  const original = await gestor.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['subA/**'] });
  const finOriginal = await gestor.esperar(original.id, 15000);
  const worktreeOrigen = finOriginal.worktree;

  simularMutacionPendiente(worktreeOrigen, 'subA/pendiente.js', Buffer.from('ORIGINAL\n'));
  gestor.registrarArranque({ recuperados: [original.id] });

  assert.equal(fs.readFileSync(path.join(worktreeOrigen, 'subA/pendiente.js'), 'utf8'), 'ORIGINAL\n');
  const eventos = leerEventos(m.estadoDir, original.id).filter((e) => e.tipo === 'mutacion_pendiente_recuperada');
  assert.equal(eventos.length, 1, 'debe dejar constancia de la restauración');
  assert.match(eventos[0].advertencia, /se restauró un archivo que había quedado mutado/);

  await gestor.cerrar();
});
