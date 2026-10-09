#!/usr/bin/env node
/**
 * Prueba de HUMO end-to-end del servidor MCP (scripts/humo.js).
 *
 * POR QUÉ existe: antes de reemplazar el servidor en vivo hace falta validar una
 * versión nueva SIN tocar el estado real (~/.local/state/opencode-orchestrator) ni
 * el servidor que está orquestando otros trabajos. Este script crea un repo git
 * temporal, arranca ESTE checkout con un ORQ_STATE_DIR temporal y recorre el flujo
 * completo (handshake, herramientas, receta, trabajo, alcance, merge, pizarrón y
 * auditoría) contra el opencode real del sistema o contra el falso del repo.
 *
 * Uso:
 *   node scripts/humo.js
 *   node scripts/humo.js --opencode /ruta/al/opencode --timeout 300 --mantener
 *   ORQ_OPENCODE_BIN=/ruta/test/fixtures/opencode-falso.js node scripts/humo.js
 *
 * Sin dependencias externas (Node 20 ESM). Termina con código 0 si todos los pasos
 * pasan y 1 si alguno falla.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
/** El servidor que se valida es el de ESTE checkout (nunca el que corre en vivo). */
const SERVIDOR = path.join(AQUI, '..', 'src', 'server.js');

/** Herramientas que el servidor debe exponer (compatibilidad del contrato MCP). */
const HERRAMIENTAS_ESPERADAS = [
  'opencode_coding',
  'opencode_wait',
  'opencode_wait_any',
  'opencode_merge',
  'opencode_status',
  'opencode_batch',
  'opencode_board_get',
  'opencode_board_post',
  'opencode_profile',
  'opencode_list',
  'opencode_logs',
  'opencode_cancel',
  'opencode_cleanup',
];

/** Tipos de evento de la auditoría global que el flujo debe dejar registrados. */
const EVENTOS_ESPERADOS = ['job.creado', 'job.estado', 'job.fin', 'merge'];

const USO = `Uso: node scripts/humo.js [opciones]

Opciones:
  --opencode <ruta>   Ejecutable de opencode (por defecto ORQ_OPENCODE_BIN o 'opencode').
                      Si es un .js (el falso del repo) se envuelve con node.
  --timeout <seg>     Tope de espera del trabajo en segundos (por defecto 300 = 5 min).
  --mantener          No borra el directorio temporal al terminar (para depurar).
  -h, --help          Muestra esta ayuda.`;

/** Resultado de cada paso, para el resumen final. */
const pasos = [];

/**
 * Registra el resultado de un paso e imprime su marca (✔/✘).
 * @param {boolean} ok
 * @param {string} etiqueta
 * @param {string} [detalle]
 * @returns {boolean} el mismo `ok`, para encadenar
 */
function anotar(ok, etiqueta, detalle = '') {
  pasos.push({ ok, etiqueta });
  console.log(`${ok ? '✔' : '✘'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  return ok;
}

/**
 * Compara una condición y la reporta como paso; no aborta el flujo (así se ve todo
 * lo que falla de una vez).
 * @param {boolean} condicion
 * @param {string} etiqueta
 * @param {string} [detalle]
 * @returns {boolean}
 */
function comprobar(condicion, etiqueta, detalle = '') {
  return anotar(condicion === true, etiqueta, condicion ? '' : detalle);
}

/**
 * Lee los flags de la línea de comandos.
 * @param {string[]} argv
 * @returns {{ opencode: string|null, timeoutSeg: number, mantener: boolean, ayuda: boolean }}
 */
function leerFlags(argv) {
  const opciones = { opencode: null, timeoutSeg: 300, mantener: false, ayuda: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--opencode') opciones.opencode = argv[++i];
    else if (flag === '--timeout') opciones.timeoutSeg = Number(argv[++i]);
    else if (flag === '--mantener') opciones.mantener = true;
    else if (flag === '-h' || flag === '--help') opciones.ayuda = true;
    else throw new Error(`opción desconocida: ${flag} (probá --help)`);
  }
  return opciones;
}

/**
 * Aborta si el entorno ya define un ORQ_STATE_DIR: el humo SIEMPRE usa su propio
 * temporal y no debe, ni por herencia, tocar el estado real de un servidor en vivo.
 * @returns {void}
 */
function verificarEstadoSeguro() {
  const heredado = process.env.ORQ_STATE_DIR;
  if (typeof heredado === 'string' && heredado.trim() !== '') {
    throw new Error(
      `ORQ_STATE_DIR ya está definido (${heredado}): el humo crea y usa su PROPIO directorio ` +
        'temporal y nunca debe escribir en un estado existente. Desdefiní la variable para correrlo.',
    );
  }
}

/**
 * Resuelve el ejecutable de opencode. Si apunta a un archivo .js (el falso del
 * repo) se crea un envoltorio ejecutable: el runner lo lanza con `spawn(cmd,args)`
 * sin shell, así que un .js sin bit de ejecución no sirve como `cmd` directo.
 * @param {string} base directorio temporal donde crear el envoltorio
 * @param {string|null} indicado ruta pasada por `--opencode`
 * @returns {string}
 */
function resolverBinario(base, indicado) {
  const bruto = indicado ?? process.env.ORQ_OPENCODE_BIN ?? 'opencode';
  const resuelto = path.resolve(bruto);
  if (bruto.endsWith('.js') && fs.existsSync(resuelto)) {
    const envoltorio = path.join(base, 'opencode-bin');
    fs.writeFileSync(envoltorio, `#!/bin/sh\nexec "${process.execPath}" "${resuelto}" "$@"\n`, { mode: 0o755 });
    return envoltorio;
  }
  return bruto;
}

/** git en el repo temporal, aislado de la configuración global del usuario. */
function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/**
 * Crea un repo git temporal con un commit inicial y el perfil mínimo que ejercita
 * recetas, reanudación, pizarrón y aceptación.
 * @param {string} base directorio temporal contenedor
 * @param {string} repo ruta del repo a crear
 * @returns {void}
 */
function montarRepo(base, repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Humo']);
  git(repo, ['config', 'user.email', 'humo@test']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');

  const perfil = {
    version: 1,
    name: 'humo',
    baseBranch: 'main',
    integrationBranch: 'staging',
    // Las raíces viven DENTRO del temporal: ni worktrees ni repos reales se tocan.
    worktrees: { root: path.join(base, 'wt') },
    // `test -f {archivo}` no sirve como aceptación default: el placeholder no existe ahí.
    accept: { default: 'true' },
    reanudacion: { habilitado: true },
    pizarron: { habilitado: true },
    revisor: { habilitado: false },
    recetas: {
      'crear-archivo': {
        descripcion: 'Crea un archivo con un texto fijo.',
        prompt: 'Creá el archivo {archivo} con el texto {texto}.',
        writes: ['{archivo}'],
      },
    },
  };
  fs.writeFileSync(path.join(repo, '.opencode-orchestrator.json'), `${JSON.stringify(perfil, null, 2)}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
}

/**
 * Arranca `node src/server.js` y devuelve un cliente JSON-RPC mínimo por stdio.
 * @param {{ estado: string, binario: string }} opciones
 * @returns {{ proceso: import('node:child_process').ChildProcess, rpc: Function, llamar: Function, salida: Promise<object>, stderr: () => string }}
 */
function iniciarServidor({ estado, binario }) {
  const entorno = {
    ...process.env,
    ORQ_STATE_DIR: estado,
    ORQ_OPENCODE_BIN: binario,
    // El primer opencode_coding no debe bloquear 45 s: el humo sondea con opencode_wait.
    ORQ_WAIT_MS: '10000',
  };
  // Bajo `node --test` esta variable llega al servidor y el falso se volvería inerte:
  // el humo también corre dentro del runner de pruebas, así que se limpia SIEMPRE.
  delete entorno.NODE_TEST_CONTEXT;
  // Garantía explícita de no tocar el opencode real por accidente si el usuario no lo pide.
  delete entorno.OPENCODE_CONFIG_DIR;

  const proceso = spawn(process.execPath, [SERVIDOR], { env: entorno, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proceso.stderr.on('data', (d) => {
    stderr += d;
  });

  const esperas = new Map();
  let buffer = '';
  proceso.stdout.on('data', (d) => {
    buffer += d;
    let salto;
    while ((salto = buffer.indexOf('\n')) !== -1) {
      const linea = buffer.slice(0, salto);
      buffer = buffer.slice(salto + 1);
      let mensaje;
      try {
        mensaje = JSON.parse(linea);
      } catch {
        continue; // ruido: el diagnóstico real va a stderr
      }
      esperas.get(mensaje.id)?.(mensaje);
    }
  });

  const salida = new Promise((resolver) => {
    proceso.once('exit', (codigo, senal) => resolver({ codigo, senal }));
  });

  let contador = 0;
  const rpc = (method, params) =>
    new Promise((resolver) => {
      contador += 1;
      esperas.set(contador, resolver);
      proceso.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: contador, method, params })}\n`);
    });
  const llamar = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;

  return { proceso, rpc, llamar, salida, stderr: () => stderr };
}

/** Texto del primer bloque de contenido de un resultado de herramienta. */
const texto = (resultado) => resultado?.content?.[0]?.text ?? '';

/**
 * Espera a que un trabajo termine con `opencode_wait`, hasta el tope pedido.
 * @param {{ llamar: Function }} cliente
 * @param {string} id
 * @param {object} primeraRespuesta respuesta ya obtenida de opencode_coding
 * @param {number} limiteMs
 * @returns {Promise<object>}
 */
async function esperarTrabajo(cliente, id, primeraRespuesta, limiteMs) {
  let respuesta = primeraRespuesta;
  while (!/\(finished\)/.test(texto(respuesta)) && Date.now() < limiteMs) {
    if (!/STILL RUNNING/.test(texto(respuesta))) break; // error inesperado: no reintentes a ciegas
    respuesta = await cliente.llamar('opencode_wait', { job_id: id });
  }
  return respuesta;
}

/**
 * Lee `eventos.jsonl` del directorio de estado y devuelve los tipos presentes.
 * @param {string} estado
 * @returns {Set<string>}
 */
function tiposDeEventos(estado) {
  const ruta = path.join(estado, 'eventos.jsonl');
  if (!fs.existsSync(ruta)) return new Set();
  const tipos = new Set();
  for (const linea of fs.readFileSync(ruta, 'utf8').split('\n')) {
    if (linea.trim() === '') continue;
    try {
      tipos.add(JSON.parse(linea).tipo);
    } catch {
      /* línea a medio escribir: se ignora, igual que el registro */
    }
  }
  return tipos;
}

/** Flujo principal. Devuelve el código de salida (0/1). */
async function main() {
  const opciones = leerFlags(process.argv.slice(2));
  if (opciones.ayuda) {
    console.log(USO);
    return 0;
  }
  if (!Number.isFinite(opciones.timeoutSeg) || opciones.timeoutSeg <= 0) {
    throw new Error('--timeout debe ser un número de segundos mayor que 0');
  }
  verificarEstadoSeguro();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-humo-'));
  const estado = path.join(base, 'estado');
  const repo = path.join(base, 'repo');
  const binario = resolverBinario(base, opciones.opencode);
  const limiteMs = Date.now() + opciones.timeoutSeg * 1000;

  let cliente = null;
  let cerrarServidor = null;
  try {
    montarRepo(base, repo);
    anotar(true, 'repo temporal con perfil', repo);

    cliente = iniciarServidor({ estado, binario });
    const init = await cliente.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'humo', version: '1' },
    });
    comprobar(init?.result?.serverInfo?.name === 'opencode-orchestrator', 'handshake MCP', cliente.stderr());

    const listado = await cliente.rpc('tools/list');
    const nombres = (listado?.result?.tools ?? []).map((t) => t.name);
    const faltantes = HERRAMIENTAS_ESPERADAS.filter((n) => !nombres.includes(n));
    const bytes = Buffer.byteLength(JSON.stringify(listado?.result ?? {}));
    console.log(`   tools/list: ${bytes} bytes`);
    comprobar(faltantes.length === 0, 'herramientas MCP', `faltan: ${faltantes.join(', ')}`);

    // 4) El perfil debe listar la receta que usaremos y traer la rama de integración.
    const perfil = await cliente.llamar('opencode_profile', { cwd: repo });
    const textoPerfil = texto(perfil);
    comprobar(!perfil.isError && /crear-archivo/.test(textoPerfil) && /staging/.test(textoPerfil), 'receta crear-archivo', textoPerfil.slice(0, 200));

    // 5) Lanzar el trabajo por receta y esperar a que termine.
    const creado = await cliente.llamar('opencode_coding', {
      cwd: repo,
      receta: 'crear-archivo',
      params: { archivo: 'hola.txt', texto: 'hola' },
      title: 'humo',
    });
    const id = texto(creado).match(/job_id=([0-9a-f]{8})/)?.[1] ?? null;
    if (id === null) {
      comprobar(false, 'trabajo succeeded', `no se obtuvo job_id: ${texto(creado)}`);
    } else {
      const resultado = await esperarTrabajo(cliente, id, creado, limiteMs);
      comprobar(/\(finished\)/.test(texto(resultado)) && /estado=succeeded/.test(texto(resultado)), 'trabajo succeeded', texto(resultado));

      // El commit de la rama del trabajo debe contener el archivo que la receta pidió.
      let enRama = false;
      try {
        enRama = git(repo, ['show', `job/${id}:hola.txt`]).trim() !== '';
      } catch {
        enRama = false;
      }
      comprobar(enRama, 'archivo en la rama del trabajo', `job/${id}:hola.txt`);

      const estadoTabla = await cliente.llamar('opencode_status', {});
      comprobar(new RegExp(`sin integrar:.*${id}`).test(texto(estadoTabla)), 'status sin integrar', texto(estadoTabla));

      const merge = await cliente.llamar('opencode_merge', { job_id: id });
      comprobar(!merge.isError && /Integrado en staging/.test(texto(merge)), 'merge a staging', texto(merge));
      const listaMerged = await cliente.llamar('opencode_list', { estado: 'merged', limite: 20 });
      comprobar(new RegExp(`job_id=${id} \\| merged`).test(texto(listaMerged)), 'pasa a merged', texto(listaMerged));

      const post = await cliente.llamar('opencode_board_post', { clave: 'humo.clave', valor: { ok: true }, nota: 'ida y vuelta' });
      const get = await cliente.llamar('opencode_board_get', { clave: 'humo.clave' });
      comprobar(
        !post.isError && /Publicado 'humo\.clave'/.test(texto(post)) && /"ok": true/.test(texto(get)),
        'pizarrón ida y vuelta',
        `${texto(post)} | ${texto(get)}`.slice(0, 200),
      );

      const tipos = tiposDeEventos(estado);
      const faltanEventos = EVENTOS_ESPERADOS.filter((t) => !tipos.has(t));
      comprobar(faltanEventos.length === 0, 'eventos.jsonl', `faltan: ${faltanEventos.join(', ')}`);

      const cleanup = await cliente.llamar('opencode_cleanup', { job_ids: [id] });
      comprobar(!cleanup.isError, 'cleanup', texto(cleanup));
    }

    // 6) Apagar ordenadamente: cerrar stdin dispara el cierre limpio del servidor.
    cerrarServidor = cliente;
    cliente.proceso.stdin.end();
    const { codigo } = await cliente.salida;
    comprobar(codigo === 0, 'cierre limpio', `código=${codigo}`);
  } catch (error) {
    anotar(false, 'flujo interrumpido', error?.message ?? String(error));
  } finally {
    if (cerrarServidor && cliente !== null && !cerrarServidor.proceso.killed && cerrarServidor.proceso.exitCode === null) {
      try {
        cerrarServidor.proceso.stdin.end();
        await cerrarServidor.salida;
      } catch {
        cerrarServidor.proceso.kill('SIGKILL');
      }
    }
    if (opciones.mantener) console.log(`   (temporal conservado: ${base})`);
    else fs.rmSync(base, { recursive: true, force: true });
  }

  const fallos = pasos.filter((p) => !p.ok).length;
  const total = pasos.length;
  console.log(`\n${fallos === 0 ? '✔' : '✘'} HUMO ${fallos === 0 ? 'OK' : 'FALLÓ'}: ${total - fallos}/${total} pasos`);
  return fallos === 0 ? 0 : 1;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((error) => {
    console.error(`✘ error fatal del humo: ${error?.stack ?? error}`);
    process.exit(1);
  });
