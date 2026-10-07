/**
 * Tests de integración del Gestor (§12.3): ciclo de vida completo con repos git
 * REALES en directorios temporales, worktrees reales y el opencode falso como
 * ejecutable.
 *
 * POR QUÉ un solo archivo (y no varios `gestor-*.test.js`): cada archivo de test
 * corre en su propio proceso y node ejecuta los archivos en paralelo. Repartir
 * estos escenarios (que lanzan muchos procesos git y de opencode) en varios
 * archivos aumenta la carga pico lo suficiente como para retrasar tests de
 * temporización fina de OTROS módulos (p. ej. el de inactividad del runner).
 * Mantenerlos en un único proceso, con los escenarios en serie, acota esa carga.
 *
 * Escenarios:
 *   1  camino feliz con worktree (commit aislado, base intacta, entorno)
 *   2  violación de alcance y patrón protegido
 *   3  aceptación que falla
 *   4  los artefactos de la aceptación no entran al commit
 *   5  timeout total, timeout por inactividad y muerte del grupo
 *   6  exit distinto de cero
 *   7  cancelación en ejecución (con nieto) y en cola
 *   8  concurrencia y serialización por writes superpuestos
 *   9  dependencias `after`
 *   10 validaciones al enviar y perfil inválido
 *   11 integración (éxito, conflicto y rechazos)
 *   12 readonly sin aislamiento (incluidos cambios previos)
 *   13 limpieza y cierre
 *   14 recursos postgres-db (creación y liberación)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  crearGestor,
  entornoFalso,
  esperar,
  esperarEstado,
  existeGrupo,
  git,
  gitOK,
  leerEventos,
  leerJob,
  montar,
  pidVivo,
} from './gestor-comun.js';

const PERFIL_RECURSO = {
  resources: {
    db: {
      kind: 'postgres-db',
      adminUrlEnv: 'ORQ_PG_ADMIN_URL',
      // El validador de perfil exige `template` para postgres-db; el fake psql
      // responde que no existe, así que la base se crea sin TEMPLATE.
      template: 'orq_plantilla_test',
      name: 'orq_{job}_test',
      exportAs: 'TEST_DATABASE_URL',
    },
  },
};

// ---------------------------------------------------------------------------
// 1) Camino feliz con worktree
// ---------------------------------------------------------------------------

test('1. camino feliz con worktree: commit aislado, base intacta y entorno inyectado', async (t) => {
  const m = await montar(t);
  const volcado = path.join(m.base, 'volcado.json');
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/nuevo.js', ORQ_FAKE_VOLCADO: volcado }),
    home: m.home,
  });
  const mainAntes = (await gitOK(['rev-parse', 'main'], m.repo)).trim();

  const trabajo = await gestor.enviar({
    prompt: 'crea src/nuevo.js',
    cwd: m.repo,
    mode: 'safe',
    writes: ['src/**'],
    accept: 'test -f src/nuevo.js',
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.ok(fin, 'el trabajo debe terminar dentro del tope');
  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.motivoFin, null);
  assert.deepEqual(fin.resultado.archivos, ['src/nuevo.js']);
  assert.match(fin.resultado.commit, /^[0-9a-f]{40}$/);
  assert.equal(fin.resultado.aceptacion.exit, 0);
  assert.equal(fin.rama, `job/${trabajo.id}`);

  // El commit de la rama contiene SOLO el archivo verificado.
  const cambiados = (await gitOK(['diff', '--name-only', mainAntes, `job/${trabajo.id}`], m.repo))
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(cambiados, ['src/nuevo.js']);
  assert.match(await gitOK(['show', `job/${trabajo.id}:src/nuevo.js`], m.repo), /opencode-falso/);

  // El commit NO está en main y main no cambió.
  const enMain = await git(['merge-base', '--is-ancestor', fin.resultado.commit, 'main'], m.repo);
  assert.notEqual(enMain.code, 0, 'el commit del trabajo no debe estar en main');
  assert.equal((await gitOK(['rev-parse', 'main'], m.repo)).trim(), mainAntes);

  // job.json guarda pid, pgid e identidad del grupo.
  const guardado = leerJob(m.estadoDir, trabajo.id);
  assert.ok(Number.isInteger(guardado.pid) && guardado.pid > 0, 'pid persistido');
  assert.equal(guardado.pgid, guardado.pid, 'con detached el pid del líder es el pgid');
  assert.ok(guardado.identidad && typeof guardado.identidad.inicio === 'number', 'identidad persistida');

  // Variables del Gestor que llegaron al proceso de opencode.
  const volcadoDatos = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  assert.equal(volcadoDatos.env.ORQ_JOB_ID, trabajo.id);
  assert.equal(volcadoDatos.env.ORQ_WORKTREE, fin.worktree);
  assert.equal(volcadoDatos.env.ORQ_BRANCH, `job/${trabajo.id}`);
  assert.equal(
    fs.realpathSync(volcadoDatos.env.PWD),
    fs.realpathSync(volcadoDatos.cwd),
    'PWD debe ser el cwd real del trabajo y no el directorio de arranque del servidor',
  );
  assert.ok(volcadoDatos.opencodeConfig, 'OPENCODE_CONFIG debe apuntar a la config del trabajo');
  assert.equal(volcadoDatos.opencodeConfigDir, null, 'OPENCODE_CONFIG_DIR nunca debe pasarse');

  // La config generada tiene el agente 'orq' con el orden obligatorio de reglas.
  const config = JSON.parse(volcadoDatos.config);
  assert.deepEqual(Object.keys(config.agent), ['orq']);
  const edit = config.agent.orq.permission.edit;
  assert.deepEqual(edit, { '*': 'deny', 'src/**': 'allow', 'secretos/**': 'deny' });
  assert.equal(Object.keys(edit).at(-1), 'secretos/**', 'el deny de protegidos va AL FINAL');

  await gestor.cerrar();
});

test('1b. cada transición queda como evento en events.jsonl', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/nuevo.js' }),
    home: m.home,
  });
  const trabajo = await gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  await gestor.esperar(trabajo.id, 15000);

  const tipos = leerEventos(m.estadoDir, trabajo.id).map((e) => e.tipo);
  // Mapeo evento -> estado según gestor.js: encolado=queued,
  // provisionando=provisioning, ejecutando=running, verificando=verifying,
  // fin=succeeded. El docstring del módulo promete registrar CADA transición.
  for (const esperado of ['encolado', 'provisionando', 'ejecutando', 'verificando', 'fin']) {
    assert.ok(tipos.includes(esperado), `falta el evento '${esperado}' (eventos: ${tipos.join(', ')})`);
  }

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 2) Alcance
// ---------------------------------------------------------------------------

test('2a. escritura fuera de writes -> rejected con violación exacta y sin aceptación', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'otro/x.js' }),
    home: m.home,
  });
  const base = (await gitOK(['rev-parse', 'main'], m.repo)).trim();

  const trabajo = await gestor.enviar({
    prompt: 'escribe fuera',
    cwd: m.repo,
    mode: 'safe',
    writes: ['src/**'],
    accept: 'touch acepto.log',
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'rejected');
  assert.equal(fin.motivoFin, 'alcance');
  assert.deepEqual(fin.resultado.violaciones, [{ ruta: 'otro/x.js', motivo: 'fuera_de_alcance' }]);
  assert.equal(fin.resultado.commit, undefined, 'no debe haber commit');
  assert.equal(fin.resultado.aceptacion, undefined, 'la aceptación no debe ejecutarse');
  // La rama existe pero apunta a la base: no hubo commit.
  assert.equal((await gitOK(['rev-parse', `job/${trabajo.id}`], m.repo)).trim(), base);
  assert.equal(fs.existsSync(path.join(fin.worktree, 'acepto.log')), false, 'la aceptación no corrió');

  await gestor.cerrar();
});

test('2b. escribir en un patrón protegido (estando en writes **) -> motivo protegido', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'secretos/x.txt' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'toca secretos', cwd: m.repo, mode: 'safe', writes: ['**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'rejected');
  assert.deepEqual(fin.resultado.violaciones, [{ ruta: 'secretos/x.txt', motivo: 'protegido' }]);
  assert.equal(fin.resultado.commit, undefined);

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 3) y 4) Aceptación
// ---------------------------------------------------------------------------

test('3. aceptación que falla -> rejected con exit y cola, sin commit', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js' }),
    home: m.home,
  });
  const base = (await gitOK(['rev-parse', 'main'], m.repo)).trim();

  const trabajo = await gestor.enviar({
    prompt: 'escribe src/a.js',
    cwd: m.repo,
    mode: 'safe',
    writes: ['src/**'],
    accept: 'echo fallando; exit 5',
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'rejected');
  assert.equal(fin.motivoFin, 'aceptacion');
  assert.equal(fin.resultado.aceptacion.cmd, 'echo fallando; exit 5');
  assert.equal(fin.resultado.aceptacion.exit, 5);
  assert.notEqual(fin.resultado.aceptacion.exit, 0);
  assert.equal(typeof fin.resultado.aceptacion.cola, 'string');
  assert.match(fin.resultado.aceptacion.cola, /fallando/);
  assert.equal(fin.resultado.commit, undefined);
  assert.equal((await gitOK(['rev-parse', `job/${trabajo.id}`], m.repo)).trim(), base);

  await gestor.cerrar();
});

test('4. los artefactos de la aceptación NO entran al commit', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js' }),
    home: m.home,
  });
  const base = (await gitOK(['rev-parse', 'main'], m.repo)).trim();

  const trabajo = await gestor.enviar({
    prompt: 'escribe src/a.js',
    cwd: m.repo,
    mode: 'safe',
    writes: ['src/**'],
    accept: 'touch artefacto.log',
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  const cambiados = (await gitOK(['diff', '--name-only', base, `job/${trabajo.id}`], m.repo))
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(cambiados, ['src/a.js']);
  const artefactoEnCommit = await git(['show', `job/${trabajo.id}:artefacto.log`], m.repo);
  assert.notEqual(artefactoEnCommit.code, 0, 'el artefacto no debe estar en el commit');
  assert.equal(fs.existsSync(path.join(fin.worktree, 'artefacto.log')), true, 'el artefacto sigue en disco');

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 5) y 6) Timeouts y exit
// ---------------------------------------------------------------------------

test('5a. timeout total -> failed timeout y el grupo de procesos desaparece', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({
    prompt: 'duerme',
    cwd: m.repo,
    mode: 'safe',
    writes: ['src/**'],
    timeout_ms: 300,
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'failed');
  assert.equal(fin.motivoFin, 'timeout');
  const guardado = leerJob(m.estadoDir, trabajo.id);
  assert.equal(existeGrupo(guardado.pgid), false, 'el grupo del trabajo debe estar muerto');

  await gestor.cerrar();
});

test('5b. timeout por inactividad -> failed idle', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_SALIDA_BYTES: '64', ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({
    prompt: 'imprime y calla',
    cwd: m.repo,
    mode: 'safe',
    writes: ['src/**'],
    timeout_ms: 30000,
    idle_timeout_ms: 300,
  });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'failed');
  assert.equal(fin.motivoFin, 'idle');
  const guardado = leerJob(m.estadoDir, trabajo.id);
  assert.equal(existeGrupo(guardado.pgid), false);

  await gestor.cerrar();
});

test('5c. el grupo de procesos no existe tras cancelar (sonda de espera)', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
  });
  const trabajo = await gestor.enviar({ prompt: 'duerme', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  await esperar(() => gestor.obtener(trabajo.id).estado === 'running', 10000);
  const pgid = leerJob(m.estadoDir, trabajo.id).pgid;

  const fin = await gestor.cancelar(trabajo.id);
  assert.equal(fin.estado, 'cancelled');
  assert.equal(existeGrupo(pgid), false);

  await gestor.cerrar();
});

test('6. exit distinto de cero -> failed sin commit y el worktree sigue para inspección', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_SALIDA_CODIGO: '7', ORQ_FAKE_ESCRIBIR: 'src/a.js' }),
    home: m.home,
  });
  const base = (await gitOK(['rev-parse', 'main'], m.repo)).trim();

  const trabajo = await gestor.enviar({ prompt: 'falla', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'failed');
  assert.equal(fin.motivoFin, 'exit_distinto_de_cero');
  assert.equal(fin.resultado.proceso.exit, 7);
  assert.equal(fin.resultado.commit, undefined);
  assert.equal((await gitOK(['rev-parse', `job/${trabajo.id}`], m.repo)).trim(), base);
  assert.ok(fs.existsSync(fin.worktree), 'el worktree debe seguir existiendo para inspección');

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 7) Cancelación
// ---------------------------------------------------------------------------

test('7a. cancelar un trabajo en ejecución mata el grupo y al nieto', async (t) => {
  const m = await montar(t);
  const archivoPid = path.join(m.base, 'nieto.pid');
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_NIETO: '1', ORQ_FAKE_PIDFILE: archivoPid, ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'lanza un nieto', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  assert.ok(await esperar(() => fs.existsSync(archivoPid), 10000), 'el fixture debe anotar el pid del nieto');
  const pidNieto = Number(fs.readFileSync(archivoPid, 'utf8').trim());
  assert.ok(pidVivo(pidNieto), 'el nieto debe estar vivo antes de cancelar');

  const fin = await gestor.cancelar(trabajo.id);
  assert.equal(fin.estado, 'cancelled');
  assert.equal(fin.motivoFin, 'cancelado');
  assert.ok(await esperar(() => !pidVivo(pidNieto), 5000), 'el nieto debe morir con el grupo');

  await gestor.cerrar();
});

test('7b. cancelar un trabajo en cola no lo provisiona', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    concurrencia: 1,
    home: m.home,
  });

  const primero = await gestor.enviar({ prompt: 'largo', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  await esperarEstado(gestor, primero.id, 'running');

  const segundo = await gestor.enviar({ prompt: 'en cola', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  assert.equal(gestor.obtener(segundo.id).estado, 'queued');

  const fin = await gestor.cancelar(segundo.id);
  assert.equal(fin.estado, 'cancelled');
  assert.equal(fin.motivoFin, 'cancelado_en_cola');
  const tipos = leerEventos(m.estadoDir, segundo.id).map((e) => e.tipo);
  assert.equal(tipos.includes('provisionando'), false, 'nunca debe llegar a provisioning');

  await gestor.cancelar(primero.id);
  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 8) Concurrencia
// ---------------------------------------------------------------------------

test('8a. concurrencia 2 con writes disjuntos: nunca más de 2 en running y cada commit es suyo', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt', ORQ_FAKE_DORMIR: '400' }),
    concurrencia: 2,
    home: m.home,
  });

  const subs = ['subA', 'subB', 'subC', 'subD'];
  const trabajos = [];
  for (const sub of subs) {
    trabajos.push(
      await gestor.enviar({ prompt: `trabajo ${sub}`, cwd: path.join(m.repo, sub), mode: 'safe', writes: [`${sub}/**`] }),
    );
  }

  let maxEnRunning = 0;
  const muestreo = setInterval(() => {
    maxEnRunning = Math.max(maxEnRunning, gestor.listar({ estado: 'running' }).length);
  }, 20);
  try {
    for (const trabajo of trabajos) await gestor.esperar(trabajo.id, 30000);
  } finally {
    clearInterval(muestreo);
  }

  assert.ok(maxEnRunning <= 2, `nunca debe superar la concurrencia (máx ${maxEnRunning})`);
  assert.equal(maxEnRunning, 2, 'debe aprovechar la concurrencia disponible');

  for (let i = 0; i < subs.length; i += 1) {
    const trabajo = gestor.obtener(trabajos[i].id);
    assert.equal(trabajo.estado, 'succeeded');
    const cambiados = (await gitOK(['diff', '--name-only', m.baseCommit, trabajo.rama], m.repo))
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(cambiados, [`${subs[i]}/out.txt`]);
  }

  await gestor.cerrar();
});

test('8b. writes superpuestos con worktrees se serializan (nunca 2 en running)', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js', ORQ_FAKE_DORMIR: '400' }),
    concurrencia: 2,
    home: m.home,
  });

  const primero = await gestor.enviar({ prompt: 'uno', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  const segundo = await gestor.enviar({ prompt: 'dos', cwd: m.repo, mode: 'safe', writes: ['src/**'] });

  let maxEnRunning = 0;
  const muestreo = setInterval(() => {
    maxEnRunning = Math.max(maxEnRunning, gestor.listar({ estado: 'running' }).length);
  }, 20);
  try {
    await gestor.esperar(primero.id, 30000);
    await gestor.esperar(segundo.id, 30000);
  } finally {
    clearInterval(muestreo);
  }

  assert.equal(maxEnRunning, 1, 'los writes superpuestos deben serializarse');
  assert.equal(gestor.obtener(primero.id).estado, 'succeeded');
  assert.equal(gestor.obtener(segundo.id).estado, 'succeeded');
  const a = leerJob(m.estadoDir, primero.id);
  const b = leerJob(m.estadoDir, segundo.id);
  assert.ok(b.inicioEn >= a.finEn, 'el segundo no debe arrancar hasta que el primero termine');

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 9) Dependencias
// ---------------------------------------------------------------------------

test('9a. B con after [A] no arranca hasta que A esté succeeded', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt', ORQ_FAKE_DORMIR: '300' }),
    concurrencia: 2,
    home: m.home,
  });

  const a = await gestor.enviar({ prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({
    prompt: 'B',
    cwd: path.join(m.repo, 'subB'),
    mode: 'safe',
    writes: ['subB/**'],
    after: [a.id],
  });

  const finA = await gestor.esperar(a.id, 30000);
  const finB = await gestor.esperar(b.id, 30000);
  assert.equal(finA.estado, 'succeeded');
  assert.equal(finB.estado, 'succeeded');
  assert.ok(finB.inicioEn >= finA.finEn, 'B debe arrancar después de que A termine');

  await gestor.cerrar();
});

test('9b. si A falla, B queda cancelled dependencia_fallida sin provisionar', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '300', ORQ_FAKE_SALIDA_CODIGO: '7' }),
    concurrencia: 2,
    home: m.home,
  });

  const a = await gestor.enviar({ prompt: 'A falla', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({
    prompt: 'B depende',
    cwd: path.join(m.repo, 'subB'),
    mode: 'safe',
    writes: ['subB/**'],
    after: [a.id],
  });

  const finB = await gestor.esperar(b.id, 30000);
  assert.equal(gestor.obtener(a.id).estado, 'failed');
  assert.equal(finB.estado, 'cancelled');
  assert.equal(finB.motivoFin, 'dependencia_fallida');
  const tipos = leerEventos(m.estadoDir, b.id).map((e) => e.tipo);
  assert.equal(tipos.includes('provisionando'), false, 'B nunca debe llegar a provisioning');

  await gestor.cerrar();
});

test('9c. after con un id inexistente se rechaza al enviar', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });

  await assert.rejects(
    () => gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'], after: ['noexiste'] }),
    /after: no existe el trabajo/,
  );
  assert.equal(gestor.listar().length, 0);

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 10) Validaciones al enviar
// ---------------------------------------------------------------------------

test('10. validaciones al enviar rechazan con mensaje y SIN crear trabajo', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });

  const casos = [
    { nombre: 'prompt vacío', spec: { prompt: '   ', cwd: m.repo }, re: /prompt.*obligatorio/ },
    { nombre: 'modo inválido', spec: { prompt: 'x', cwd: m.repo, mode: 'raro' }, re: /Modo desconocido/ },
    { nombre: 'safe sin writes', spec: { prompt: 'x', cwd: m.repo, mode: 'safe' }, re: /writes.*obligatorio/ },
    { nombre: 'cwd inexistente', spec: { prompt: 'x', cwd: path.join(m.base, 'noexiste') }, re: /cwd no existe/ },
    {
      nombre: 'cwd fuera de repo git',
      spec: { prompt: 'x', cwd: m.base, mode: 'safe', writes: ['src/**'] },
      re: /No es un repositorio git/,
    },
    {
      nombre: 'recurso desconocido',
      spec: { prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'], resources: ['nope'] },
      re: /Recurso desconocido/,
    },
    {
      nombre: 'isolation inválida',
      spec: { prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'], isolation: 'raro' },
      re: /isolation/,
    },
    {
      nombre: 'writes no array',
      spec: { prompt: 'x', cwd: m.repo, mode: 'safe', writes: 'src/**' },
      re: /writes.*array/,
    },
  ];

  for (const caso of casos) {
    await assert.rejects(() => gestor.enviar(caso.spec), caso.re, caso.nombre);
    assert.equal(gestor.listar().length, 0, `${caso.nombre}: no debe crear ningún trabajo`);
  }

  await gestor.cerrar();
});

test('10a. un cwd con ruta de Windows se traduce a /mnt/<letra> (en enviar y en verPerfil)', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });

  // La unidad inexistente permite comprobar la traducción sin depender de WSL: el mensaje
  // de error muestra la ruta YA convertida (sin traducir sería una ruta relativa rara).
  await assert.rejects(
    () => gestor.enviar({ prompt: 'x', cwd: 'Z:\\no\\existe', mode: 'safe', writes: ['src/**'] }),
    /cwd no existe: \/mnt\/z\/no\/existe$/,
  );
  await assert.rejects(() => gestor.verPerfil('Z:\\no\\existe'), /\/mnt\/z\/no\/existe/);
  assert.equal(gestor.listar().length, 0);

  await gestor.cerrar();
});

test('10b. perfil inválido (JSON roto) se rechaza sin dejar un trabajo en queued', async (t) => {
  const m = await montar(t, { perfilCrudo: '{ "version": 1, ' });
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });

  await assert.rejects(
    () => gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] }),
    /Perfil inválido/,
  );
  assert.equal(gestor.listar().length, 0, 'no debe quedar ningún trabajo creado');
  assert.equal(gestor.listar({ estado: 'queued' }).length, 0, 'nada atascado en queued');

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 11) Integración
// ---------------------------------------------------------------------------

test('11a. integrar trabajos succeeded -> merged, staging con los commits y main intacta', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'out.txt' }),
    home: m.home,
  });

  const a = await gestor.enviar({ prompt: 'A', cwd: path.join(m.repo, 'subA'), mode: 'safe', writes: ['subA/**'] });
  const b = await gestor.enviar({ prompt: 'B', cwd: path.join(m.repo, 'subB'), mode: 'safe', writes: ['subB/**'] });
  await gestor.esperar(a.id, 30000);
  await gestor.esperar(b.id, 30000);
  const mainAntes = (await gitOK(['rev-parse', 'main'], m.repo)).trim();

  const r1 = await gestor.integrar(a.id);
  assert.equal(r1.ok, true);
  assert.match(r1.sha, /^[0-9a-f]{40}$/);
  assert.equal(gestor.obtener(a.id).estado, 'merged');
  assert.equal(gestor.obtener(a.id).integradoEn, 'staging');
  const enStaging = await git(['merge-base', '--is-ancestor', gestor.obtener(a.id).resultado.commit, 'staging'], m.repo);
  assert.equal(enStaging.code, 0, 'staging debe contener el commit del trabajo');

  const r2 = await gestor.integrar(b.id);
  assert.equal(r2.ok, true);
  assert.equal(gestor.obtener(b.id).estado, 'merged');

  const integ = path.join(m.rootDir, '_integracion', 'staging');
  assert.match(fs.readFileSync(path.join(integ, 'subA', 'out.txt'), 'utf8'), /opencode-falso/);
  assert.match(fs.readFileSync(path.join(integ, 'subB', 'out.txt'), 'utf8'), /opencode-falso/);
  assert.equal((await gitOK(['rev-parse', 'main'], m.repo)).trim(), mainAntes, 'main no debe cambiar');

  await gestor.cerrar();
});

test('11b. integrar con conflicto devuelve {ok:false} y deja staging intacta', async (t) => {
  const m = await montar(t);
  // Dos gestores sobre el mismo almacén para poder dar a cada trabajo un
  // ORQ_FAKE_ESCRIBIR distinto que, no obstante, apunta al MISMO archivo
  // ('conflicto.txt' vs './conflicto.txt') con contenidos distintos.
  const g1 = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'conflicto.txt' }),
    home: m.home,
  });
  const a = await g1.enviar({ prompt: 'A', cwd: m.repo, mode: 'safe', writes: ['conflicto.txt'] });
  await g1.esperar(a.id, 30000);

  const g2 = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: './conflicto.txt' }),
    home: m.home,
  });
  const b = await g2.enviar({ prompt: 'B', cwd: m.repo, mode: 'safe', writes: ['conflicto.txt'] });
  await g2.esperar(b.id, 30000);

  assert.equal(g1.obtener(a.id).estado, 'succeeded');
  assert.equal(g2.obtener(b.id).estado, 'succeeded');

  assert.equal((await g2.integrar(a.id)).ok, true);
  const stagingAntes = (await gitOK(['rev-parse', 'staging'], m.repo)).trim();

  const r2 = await g2.integrar(b.id);
  assert.equal(r2.ok, false);
  assert.ok(r2.conflictos.includes('conflicto.txt'), `conflictos: ${JSON.stringify(r2.conflictos)}`);
  assert.equal((await gitOK(['rev-parse', 'staging'], m.repo)).trim(), stagingAntes, 'staging no debe cambiar');

  await g1.cerrar();
  await g2.cerrar();
});

test('11c. no se integran trabajos que no están succeeded (corriendo o rejected)', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
  });

  const corriendo = await gestor.enviar({ prompt: 'largo', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  await esperarEstado(gestor, corriendo.id, 'running');
  await assert.rejects(() => gestor.integrar(corriendo.id), /Solo se integran trabajos succeeded/);
  await gestor.cancelar(corriendo.id);

  const g2 = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'otro/x.js' }),
    home: m.home,
  });
  const rechazado = await g2.enviar({ prompt: 'malo', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  await g2.esperar(rechazado.id, 15000);
  assert.equal(g2.obtener(rechazado.id).estado, 'rejected');
  await assert.rejects(() => g2.integrar(rechazado.id), /Solo se integran trabajos succeeded/);

  await gestor.cerrar();
  await g2.cerrar();
});

// ---------------------------------------------------------------------------
// 12) readonly sin aislamiento
// ---------------------------------------------------------------------------

test('12a. readonly sin aislamiento y sin escribir nada -> succeeded sin commit', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });

  const trabajo = await gestor.enviar({ prompt: 'solo mirá', cwd: m.repo, mode: 'readonly' });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.equal(fin.isolation, 'none');
  assert.equal(fin.resultado.commit, null, 'sin aislamiento no hay commit');
  assert.deepEqual(fin.resultado.archivos, []);

  await gestor.cerrar();
});

test('12b. readonly que escribe -> rejected solo_lectura', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'arruina.txt' }),
    home: m.home,
  });

  const trabajo = await gestor.enviar({ prompt: 'no deberías escribir', cwd: m.repo, mode: 'readonly' });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'rejected');
  assert.deepEqual(fin.resultado.violaciones, [{ ruta: 'arruina.txt', motivo: 'solo_lectura' }]);
  assert.equal(fin.resultado.commit, undefined);

  await gestor.cerrar();
});

test('12c. un cambio previo del árbol real que no se toca NO es violación', async (t) => {
  const m = await montar(t);
  // Modificación hecha ANTES de empezar el trabajo y que el trabajo no cambia.
  fs.writeFileSync(path.join(m.repo, 'base.txt'), 'modificado antes\n');
  const gestor = crearGestor(m.almacen, { fake: m.fake, entorno: entornoFalso(), home: m.home });

  const trabajo = await gestor.enviar({ prompt: 'no toques nada', cwd: m.repo, mode: 'readonly' });
  const fin = await gestor.esperar(trabajo.id, 15000);

  assert.equal(fin.estado, 'succeeded');
  assert.deepEqual(fin.resultado.archivos, [], 'un cambio previo sin tocar no cuenta');
  assert.equal(fs.readFileSync(path.join(m.repo, 'base.txt'), 'utf8'), 'modificado antes\n');

  await gestor.cerrar();
});

// ---------------------------------------------------------------------------
// 13) Limpieza y cierre
// ---------------------------------------------------------------------------

test('13a. limpiar elimina worktree y rama de terminados y no toca los activos', async (t) => {
  const m = await montar(t);
  const g1 = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_ESCRIBIR: 'src/a.js' }),
    home: m.home,
  });
  const terminado = await g1.enviar({ prompt: 'termina', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  const finTerminado = await g1.esperar(terminado.id, 15000);
  assert.equal(finTerminado.estado, 'succeeded');

  const g2 = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    home: m.home,
  });
  const activo = await g2.enviar({ prompt: 'sigue', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  await esperarEstado(g2, activo.id, 'running');
  const rutaActiva = g2.obtener(activo.id).worktree;

  const limpiados = await g2.limpiar();
  assert.ok(limpiados.includes(terminado.id));
  assert.equal(fs.existsSync(finTerminado.worktree), false, 'el worktree del terminado se elimina');
  assert.equal((await gitOK(['branch', '--list', `job/${terminado.id}`], m.repo)).trim(), '', 'la rama se borra');
  const worktrees = await gitOK(['worktree', 'list', '--porcelain'], m.repo);
  assert.equal(worktrees.includes(finTerminado.worktree), false);
  assert.equal(fs.existsSync(rutaActiva), true, 'el worktree del activo no se toca');

  await g2.cancelar(activo.id);
  await g1.cerrar();
  await g2.cerrar();
});

test('13b. cerrar cancela lo que corre, descarta la cola y rechaza envíos nuevos', async (t) => {
  const m = await montar(t);
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({ ORQ_FAKE_DORMIR: '60000' }),
    concurrencia: 1,
    home: m.home,
  });

  const corriendo = await gestor.enviar({ prompt: 'corre', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  await esperarEstado(gestor, corriendo.id, 'running');
  const enCola = await gestor.enviar({ prompt: 'cola', cwd: m.repo, mode: 'safe', writes: ['src/**'] });
  assert.equal(gestor.obtener(enCola.id).estado, 'queued');
  const pgid = leerJob(m.estadoDir, corriendo.id).pgid;

  await gestor.cerrar();

  assert.equal(gestor.obtener(corriendo.id).estado, 'cancelled');
  assert.equal(gestor.obtener(corriendo.id).motivoFin, 'cancelado');
  assert.equal(gestor.obtener(enCola.id).estado, 'cancelled');
  assert.equal(gestor.obtener(enCola.id).motivoFin, 'servidor_cerrado');
  assert.equal(existeGrupo(pgid), false, 'el grupo del que corría debe morir');
  await assert.rejects(
    () => gestor.enviar({ prompt: 'x', cwd: m.repo, mode: 'safe', writes: ['src/**'] }),
    /cerrando/,
  );
});

// ---------------------------------------------------------------------------
// 14) Recursos
// ---------------------------------------------------------------------------

test('14a. recurso db: se crea antes, se libera con DROP después y exporta la URL', async (t) => {
  const m = await montar(t, { perfil: PERFIL_RECURSO });
  const volcado = path.join(m.base, 'volcado.json');
  const llamadas = [];
  const ejecutarPsql = async (args) => {
    llamadas.push(args.at(-1));
    return { code: 0, stdout: '', stderr: '' };
  };
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR: 'src/a.js',
      ORQ_PG_ADMIN_URL: 'postgres://u:p@localhost:5432/postgres',
      ORQ_FAKE_VOLCADO: volcado,
    }),
    home: m.home,
    ejecutarPsql,
  });

  const trabajo = await gestor.enviar({ prompt: 'usa la db', cwd: m.repo, mode: 'safe', writes: ['src/**'], resources: ['db'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'succeeded');

  const v = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  assert.match(v.env.TEST_DATABASE_URL, new RegExp(`/orq_${trabajo.id}_test$`));

  const idxCreate = llamadas.findIndex((s) => s.startsWith('CREATE DATABASE'));
  const drops = llamadas.map((s, i) => [s, i]).filter(([s]) => s.startsWith('DROP DATABASE'));
  assert.ok(idxCreate >= 0, `debe crear la base (${llamadas.join(' | ')})`);
  assert.ok(drops.length > 0 && drops.at(-1)[1] > idxCreate, 'el DROP de liberación va después del CREATE');

  await gestor.cerrar();
});

test('14b. el recurso se libera aunque el trabajo falle', async (t) => {
  const m = await montar(t, { perfil: PERFIL_RECURSO });
  const llamadas = [];
  const ejecutarPsql = async (args) => {
    llamadas.push(args.at(-1));
    return { code: 0, stdout: '', stderr: '' };
  };
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_ESCRIBIR: 'src/a.js',
      ORQ_FAKE_SALIDA_CODIGO: '7',
      ORQ_PG_ADMIN_URL: 'postgres://u:p@localhost:5432/postgres',
    }),
    home: m.home,
    ejecutarPsql,
  });

  const trabajo = await gestor.enviar({ prompt: 'falla', cwd: m.repo, mode: 'safe', writes: ['src/**'], resources: ['db'] });
  const fin = await gestor.esperar(trabajo.id, 15000);
  assert.equal(fin.estado, 'failed');

  const idxCreate = llamadas.findIndex((s) => s.startsWith('CREATE DATABASE'));
  const drops = llamadas.map((s, i) => [s, i]).filter(([s]) => s.startsWith('DROP DATABASE'));
  assert.ok(idxCreate >= 0);
  assert.ok(drops.length > 0 && drops.at(-1)[1] > idxCreate);

  await gestor.cerrar();
});

test('14c. el recurso se libera aunque el trabajo se cancele', async (t) => {
  const m = await montar(t, { perfil: PERFIL_RECURSO });
  const llamadas = [];
  const ejecutarPsql = async (args) => {
    llamadas.push(args.at(-1));
    return { code: 0, stdout: '', stderr: '' };
  };
  const gestor = crearGestor(m.almacen, { fake: m.fake,
    entorno: entornoFalso({
      ORQ_FAKE_DORMIR: '60000',
      ORQ_PG_ADMIN_URL: 'postgres://u:p@localhost:5432/postgres',
    }),
    home: m.home,
    ejecutarPsql,
  });

  const trabajo = await gestor.enviar({ prompt: 'cancela', cwd: m.repo, mode: 'safe', writes: ['src/**'], resources: ['db'] });
  await esperarEstado(gestor, trabajo.id, 'running');
  const fin = await gestor.cancelar(trabajo.id);
  assert.equal(fin.estado, 'cancelled');

  const idxCreate = llamadas.findIndex((s) => s.startsWith('CREATE TABLE') || s.startsWith('CREATE DATABASE'));
  const drops = llamadas.map((s, i) => [s, i]).filter(([s]) => s.startsWith('DROP DATABASE'));
  assert.ok(idxCreate >= 0);
  assert.ok(drops.length > 0 && drops.at(-1)[1] > idxCreate);

  await gestor.cerrar();
});
