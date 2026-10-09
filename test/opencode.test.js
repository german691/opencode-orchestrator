import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MODOS,
  BASH_SOLO_LECTURA,
  BASH_DENEGADOS_SEGUROS,
  resolverModo,
  construirArgs,
  generarConfigDeTrabajo,
  construirPrompt,
  escribirConfigDeTrabajo,
  entornoDeTrabajo,
} from '../src/core/opencode.js';

const MODELO = 'opencode-go/deepseek-v4.1-flash';

/** Directorio temporal propio de cada prueba. */
function dirTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-opencode-'));
}

test('MODOS define los tres modos y su agente', () => {
  assert.deepEqual(Object.keys(MODOS), ['readonly', 'safe', 'auto']);
  assert.equal(MODOS.readonly.agente, 'coder-readonly');
  assert.equal(MODOS.safe.agente, 'coder');
  assert.equal(MODOS.auto.agente, null);
});

test('resolverModo devuelve el descriptor y rechaza los desconocidos', () => {
  assert.deepEqual(resolverModo('readonly'), { agente: 'coder-readonly' });
  assert.deepEqual(resolverModo('safe'), { agente: 'coder' });
  assert.deepEqual(resolverModo('auto'), { agente: null });
  assert.deepEqual(resolverModo('SAFE'), { agente: 'coder' });
  assert.throws(() => resolverModo('raro'), /permitidos: readonly, safe, auto/);
  assert.throws(() => resolverModo(undefined), /Modo desconocido/);
  assert.throws(() => resolverModo(42), /Modo desconocido/);
});

test('construirArgs: argumentos exactos por modo (tabla)', () => {
  const casos = [
    ['readonly', 'coder-readonly'],
    ['safe', 'coder'],
  ];
  for (const [modo, agente] of casos) {
    assert.deepEqual(construirArgs({ prompt: 'hazlo', modo, modelo: MODELO, files: ['a.js'] }), [
      'run',
      '--standalone',
      '--model',
      MODELO,
      '--agent',
      agente,
      '-f',
      'a.js',
      '--auto',
      'hazlo',
    ]);
  }

  // auto: sin agente (usa el de opencode por defecto).
  assert.deepEqual(construirArgs({ prompt: 'hazlo', modo: 'auto', modelo: MODELO }), [
    'run',
    '--standalone',
    '--model',
    MODELO,
    '--auto',
    'hazlo',
  ]);
});

test('construirArgs: --auto por defecto salvo auto === false', () => {
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'safe', auto: false }), [
    'run',
    '--standalone',
    '--agent',
    'coder',
    'x',
  ]);
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'auto', auto: false }), [
    'run',
    '--standalone',
    'x',
  ]);
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'readonly' }), [
    'run',
    '--standalone',
    '--agent',
    'coder-readonly',
    '--auto',
    'x',
  ]);
});

test('construirArgs: sin modelo u con modelo vacío no agrega --model', () => {
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'auto' }), ['run', '--standalone', '--auto', 'x']);
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'auto', modelo: '' }), [
    'run',
    '--standalone',
    '--auto',
    'x',
  ]);
});

test('construirArgs: el agente explícito pisa al del modo (y null lo quita)', () => {
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'safe', agente: 'mi-agente' }), [
    'run',
    '--standalone',
    '--agent',
    'mi-agente',
    '--auto',
    'x',
  ]);
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'safe', agente: null }), [
    'run',
    '--standalone',
    '--auto',
    'x',
  ]);
  // En auto también se puede forzar un agente.
  assert.deepEqual(construirArgs({ prompt: 'x', modo: 'auto', agente: 'coder' }), [
    'run',
    '--standalone',
    '--agent',
    'coder',
    '--auto',
    'x',
  ]);
});

test('construirArgs: valores raros siguen siendo UN solo elemento', () => {
  const prompt = 'linea1\nlinea2 "comillas" `back` $HOME ${VAR} $& ; rm -rf /';
  const args = construirArgs({ prompt, modo: 'safe', files: ['archivo con espacios.txt'] });
  assert.equal(args[args.length - 1], prompt);
  assert.equal(args.filter((a) => a === prompt).length, 1);
  assert.equal(args.includes('archivo con espacios.txt'), true);

  // Un valor que empieza con '-' no se interpreta como opción ni se fusiona.
  assert.deepEqual(construirArgs({ prompt: '-peligro', modo: 'auto', files: ['-rf'] }), [
    'run',
    '--standalone',
    '-f',
    '-rf',
    '--auto',
    '-peligro',
  ]);
});

test('construirArgs: valida prompt, modo, modelo y files', () => {
  assert.throws(() => construirArgs({ prompt: '', modo: 'safe' }), /prompt debe ser un texto no vacío/);
  assert.throws(() => construirArgs({ prompt: '   ', modo: 'safe' }), /prompt debe ser un texto no vacío/);
  assert.throws(() => construirArgs({ prompt: 123, modo: 'safe' }), /prompt debe ser un texto no vacío/);
  assert.throws(() => construirArgs({ prompt: 'x', modo: 'raro' }), /Modo desconocido/);
  assert.throws(() => construirArgs({ prompt: 'x', modo: 'safe', modelo: 'sin-barra' }), /Modelo inválido/);
  assert.throws(
    () => construirArgs({ prompt: 'x', modo: 'safe', modelo: 'a/b/c' }),
    /Modelo inválido/,
  );
  assert.throws(() => construirArgs({ prompt: 'x', modo: 'safe', files: 'no-array' }), /files/);
  assert.throws(() => construirArgs({ prompt: 'x', modo: 'safe', files: [123] }), /texto/);
  assert.throws(() => construirArgs({ prompt: 'x', modo: 'safe', files: ['a\0b'] }), /NUL/);
});

test('generarConfigDeTrabajo: estructura, orden de edit y modelo', () => {
  const config = generarConfigDeTrabajo({
    modo: 'safe',
    writes: ['src/**'],
    protegidos: ['**/.env'],
    modelo: MODELO,
  });

  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.model, MODELO);
  const agente = config.agent.orq;
  assert.equal(agente.mode, 'primary');

  // ORDEN OBLIGATORIO: deny total, allows de writes, denys de protegidos al final.
  assert.deepEqual(Object.keys(agente.permission.edit), ['*', 'src/**', '**/.env']);
  assert.equal(agente.permission.edit['*'], 'deny');
  assert.equal(agente.permission.edit['src/**'], 'allow');
  assert.equal(agente.permission.edit['**/.env'], 'deny');
});

test('generarConfigDeTrabajo: el orden se mantiene con varias reglas', () => {
  const config = generarConfigDeTrabajo({
    modo: 'safe',
    writes: ['a/**', 'b/**'],
    protegidos: ['secreto/**', '**/.env'],
  });
  assert.deepEqual(Object.keys(config.agent.orq.permission.edit), [
    '*',
    'a/**',
    'b/**',
    'secreto/**',
    '**/.env',
  ]);
  assert.equal(config.agent.orq.permission.edit['a/**'], 'allow');
  assert.equal(config.agent.orq.permission.edit['b/**'], 'allow');
  assert.equal(config.agent.orq.permission.edit['secreto/**'], 'deny');
  assert.equal(config.agent.orq.permission.edit['**/.env'], 'deny');
});

test('generarConfigDeTrabajo: protegido que se solapa con writes queda denegado al final', () => {
  const solapado = generarConfigDeTrabajo({
    modo: 'safe',
    writes: ['src/**'],
    protegidos: ['src/secreto/**'],
  });
  assert.deepEqual(Object.keys(solapado.agent.orq.permission.edit), [
    '*',
    'src/**',
    'src/secreto/**',
  ]);
  assert.equal(solapado.agent.orq.permission.edit['src/secreto/**'], 'deny');

  // Mismo patrón en writes y protegidos: gana el deny (última coincidencia).
  const mismo = generarConfigDeTrabajo({ modo: 'safe', writes: ['src/**'], protegidos: ['src/**'] });
  assert.equal(mismo.agent.orq.permission.edit['src/**'], 'deny');
});

test('generarConfigDeTrabajo: readonly deniega toda edición', () => {
  const config = generarConfigDeTrabajo({
    modo: 'readonly',
    writes: ['src/**'],
    protegidos: ['**/.env'],
  });
  assert.deepEqual(config.agent.orq.permission.edit, { '*': 'deny' });
  assert.equal('src/**' in config.agent.orq.permission.edit, false);
});

test('generarConfigDeTrabajo: readonly solo permite bash de lectura y deniega webfetch', () => {
  const permission = generarConfigDeTrabajo({ modo: 'readonly' }).agent.orq.permission;
  assert.equal(permission.bash['*'], 'deny');
  for (const patron of BASH_SOLO_LECTURA) assert.equal(permission.bash[patron], 'allow', patron);
  assert.equal(permission.webfetch, 'deny');
});

test('generarConfigDeTrabajo: safe deniega writes vacíos y usa la lista de bash peligrosos', () => {
  const permission = generarConfigDeTrabajo({ modo: 'safe' }).agent.orq.permission;
  assert.deepEqual(permission.edit, { '*': 'deny' });
  assert.equal(permission.bash['*'], 'allow');
  for (const patron of BASH_DENEGADOS_SEGUROS) assert.equal(permission.bash[patron], 'deny', patron);
  assert.equal(permission.webfetch, 'deny');
});

test('generarConfigDeTrabajo: auto sin writes permite editar salvo protegidos y no trae denegados de bash', () => {
  const permission = generarConfigDeTrabajo({
    modo: 'auto',
    protegidos: ['**/.env', 'infra/**'],
  }).agent.orq.permission;

  assert.deepEqual(permission.edit, { '*': 'allow', '**/.env': 'deny', 'infra/**': 'deny' });
  assert.deepEqual(permission.bash, { '*': 'allow' });
  for (const patron of BASH_DENEGADOS_SEGUROS) {
    assert.equal(patron in permission.bash, false, `auto no debe denegar ${patron}`);
  }
  assert.equal(permission.webfetch, 'allow');
});

test('generarConfigDeTrabajo: auto con writes acota la edición', () => {
  const permission = generarConfigDeTrabajo({
    modo: 'auto',
    writes: ['a/**'],
    protegidos: ['b/**'],
  }).agent.orq.permission;
  assert.deepEqual(Object.keys(permission.edit), ['*', 'a/**', 'b/**']);
  assert.equal(permission.edit['*'], 'deny');
  assert.equal(permission.edit['a/**'], 'allow');
  assert.equal(permission.edit['b/**'], 'deny');
});

test('generarConfigDeTrabajo: valida modo, patrones, modelo y nombreAgente', () => {
  assert.throws(() => generarConfigDeTrabajo({ modo: 'raro' }), /Modo desconocido/);
  assert.throws(() => generarConfigDeTrabajo({ modo: 'safe', writes: ['/abs'] }), /writes\[0\]/);
  assert.throws(() => generarConfigDeTrabajo({ modo: 'safe', writes: ['a/../b'] }), /writes\[0\]/);
  assert.throws(() => generarConfigDeTrabajo({ modo: 'safe', protegidos: ['/abs'] }), /protegidos\[0\]/);
  assert.throws(() => generarConfigDeTrabajo({ modo: 'safe', writes: 'no-array' }), /writes/);
  assert.throws(() => generarConfigDeTrabajo({ modo: 'safe', modelo: 'sin-barra' }), /Modelo inválido/);
  assert.throws(() => generarConfigDeTrabajo({ modo: 'safe', nombreAgente: '' }), /nombreAgente/);
});

test('generarConfigDeTrabajo: usa el nombre de agente indicado', () => {
  const config = generarConfigDeTrabajo({ modo: 'safe', nombreAgente: 'trabajo-7' });
  assert.ok(config.agent['trabajo-7']);
  assert.equal(config.agent.orq, undefined);
});

test('construirPrompt: el prompt original se inserta intacto', () => {
  const prompt = 'Tarea con `backticks`, $VAR, ${OTRO}, $& y "comillas";\nrm -rf /; fin.';
  const texto = construirPrompt({
    prompt,
    modo: 'safe',
    writes: ['src/**'],
    reads: ['**'],
    protegidos: ['**/.env'],
    rutaTrabajo: '/tmp/job-1',
  });

  assert.ok(texto.endsWith(prompt));
  assert.equal(texto.slice(-prompt.length), prompt);
  assert.match(texto, /Reglas del orquestador/);
  assert.match(texto, /\/tmp\/job-1/);
  assert.match(texto, /Solo podes modificar estos patrones/);
  assert.match(texto, /`src\/\*\*`/);
  assert.match(texto, /NUNCA modifiques estos/);
  assert.match(texto, /`\*\*\/\.env`/);
  assert.match(texto, /git commit/);
  assert.match(texto, /suite completa/);
  assert.match(texto, /--- TAREA ---/);
});

test('construirPrompt: en readonly avisa que no se puede modificar nada', () => {
  const texto = construirPrompt({ prompt: 'solo mira', modo: 'readonly' });
  assert.match(texto, /No podes modificar NINGUN archivo/);
  assert.ok(texto.endsWith('solo mira'));
});

test('construirPrompt: valida modo y prompt', () => {
  assert.throws(() => construirPrompt({ prompt: 'x', modo: 'raro' }), /Modo desconocido/);
  assert.throws(() => construirPrompt({ prompt: 123, modo: 'safe' }), /prompt debe ser un texto/);
});

test('entornoDeTrabajo: define OPENCODE_CONFIG y elimina OPENCODE_CONFIG_DIR', () => {
  const base = { PATH: '/bin', OPENCODE_CONFIG_DIR: '/peligroso', OPENCODE_CONFIG: '/viejo' };
  const entorno = entornoDeTrabajo({ rutaConfig: '/jobs/1/opencode.jsonc', base });

  assert.equal(entorno.OPENCODE_CONFIG, '/jobs/1/opencode.jsonc');
  assert.equal('OPENCODE_CONFIG_DIR' in entorno, false);
  assert.equal(entorno.PATH, '/bin');
  // No muta el entorno base.
  assert.equal(base.OPENCODE_CONFIG_DIR, '/peligroso');
  assert.equal(base.OPENCODE_CONFIG, '/viejo');
});

test('entornoDeTrabajo: sin base tampoco define OPENCODE_CONFIG_DIR', () => {
  const entorno = entornoDeTrabajo({ rutaConfig: '/x/opencode.jsonc' });
  assert.equal(entorno.OPENCODE_CONFIG, '/x/opencode.jsonc');
  assert.equal('OPENCODE_CONFIG_DIR' in entorno, false);
});

test('escribirConfigDeTrabajo: escribe opencode.jsonc con modo 0600 y sin temporales', () => {
  const dir = dirTemporal();
  const config = generarConfigDeTrabajo({ modo: 'safe', writes: ['src/**'], modelo: MODELO });
  const ruta = escribirConfigDeTrabajo(dir, config);

  assert.equal(path.basename(ruta), 'opencode.jsonc');
  assert.ok(fs.existsSync(ruta));
  assert.deepEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')), config);
  assert.equal(fs.statSync(ruta).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('escribirConfigDeTrabajo: crea el directorio del trabajo si falta', () => {
  const raiz = dirTemporal();
  const anidado = path.join(raiz, 'jobs', '7');
  const ruta = escribirConfigDeTrabajo(anidado, '{}');
  assert.ok(fs.existsSync(ruta));
  assert.equal(fs.readFileSync(ruta, 'utf8'), '{}');
});

test('generarConfigDeTrabajo: un protegido idéntico a un write queda AL FINAL y gana sobre un allow más específico', () => {
  const config = generarConfigDeTrabajo({
    modo: 'safe',
    writes: ['a/**', 'a/x/**'],
    protegidos: ['a/**'],
  });
  const edit = config.agent.orq.permission.edit;
  // Orden esperado (gana la última coincidencia): deny base, allow específico, deny protegido.
  assert.deepEqual(Object.entries(edit), [
    ['*', 'deny'],
    ['a/x/**', 'allow'],
    ['a/**', 'deny'],
  ]);
});

test('generarConfigDeTrabajo: external_directory se deniega en readonly y safe y se permite solo en auto', () => {
  assert.equal(generarConfigDeTrabajo({ modo: 'readonly' }).agent.orq.permission.external_directory, 'deny');
  assert.equal(generarConfigDeTrabajo({ modo: 'safe', writes: ['a/**'] }).agent.orq.permission.external_directory, 'deny');
  assert.equal(generarConfigDeTrabajo({ modo: 'auto' }).agent.orq.permission.external_directory, 'allow');
});

test('construirPrompt: antepone el prefijo del perfil a la tarea y manda parar ante archivos fuera de alcance', () => {
  const texto = construirPrompt({
    prompt: 'la tarea `con` $backticks',
    modo: 'safe',
    writes: ['src/**'],
    prefijo: '  Convenciones del proyecto: español.  ',
  });
  assert.ok(texto.indexOf('Convenciones del proyecto: español.') < texto.indexOf('la tarea `con` $backticks'));
  assert.match(texto, /detenete y reportalo/);
  assert.ok(texto.endsWith('la tarea `con` $backticks'), 'la tarea original va intacta al final');
  // En readonly no aplica la regla de "fuera de alcance".
  assert.doesNotMatch(construirPrompt({ prompt: 'x', modo: 'readonly' }), /detenete y reportalo/);
  // Sin prefijo no agrega nada entre el separador y la tarea.
  assert.equal(construirPrompt({ prompt: 'x', modo: 'safe', writes: ['a'] }).endsWith('x'), true);
});

test('construirPrompt pide acotar la exploración (salvo en readonly)', () => {
  assert.match(construirPrompt({ prompt: 'x', modo: 'safe', writes: ['a'] }), /No explores el repositorio entero/);
  assert.doesNotMatch(construirPrompt({ prompt: 'x', modo: 'readonly' }), /No explores el repositorio entero/);
});

test('construirPrompt pide declarar mutaciones en .orq en vez de mutar a mano (salvo readonly)', () => {
  const texto = construirPrompt({ prompt: 'x', modo: 'safe', writes: ['a'] });
  assert.match(texto, /NO mutes archivos a mano/);
  assert.match(texto, /\.orq\/mutaciones\.json/);
  assert.match(texto, /MUTACION: detectada N\/M/);
  assert.match(texto, /"buscar":"texto exacto"/);
  assert.doesNotMatch(construirPrompt({ prompt: 'x', modo: 'readonly' }), /NO mutes archivos a mano/);
});
