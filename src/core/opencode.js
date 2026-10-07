/**
 * Adaptador de opencode: modos, argumentos de `opencode run`, configuración de
 * permisos por trabajo y entorno de ejecución (§3, §4, §11, §14).
 *
 * POR QUÉ un módulo propio y puro: la v2 armaba la línea de comandos y el agente
 * dentro del servidor, mezclado con el protocolo. Aquí concentramos las reglas
 * para poder probarlas sin lanzar nada: qué argumentos recibe opencode, qué
 * permisos se le conceden y qué entorno se le pasa.
 *
 * HALLAZGOS del diseño que condicionan este módulo (§14):
 *  - En las reglas de permiso de opencode **gana la ÚLTIMA que coincide**. Por eso
 *    el orden de `edit` es obligatorio: `"*": deny`, luego un `allow` por patrón de
 *    `writes`, y AL FINAL un `deny` por cada patrón protegido. Si el `deny` de
 *    protegidos fuera antes, un `allow` posterior lo reactivaría.
 *  - `OPENCODE_CONFIG` se fusiona con la configuración global y admite agentes en
 *    línea; `OPENCODE_CONFIG_DIR` REEMPLAZA la configuración global (se perdía el
 *    modelo). Por eso `entornoDeTrabajo` define `OPENCODE_CONFIG` y elimina
 *    cualquier `OPENCODE_CONFIG_DIR` heredado.
 *  - `--auto` aprueba lo que no esté denegado explícitamente; toda restricción se
 *    expresa como `deny`. Por eso `auto` es opt-in y no se apoya en la ausencia de
 *    reglas.
 *
 * SEGURIDAD: los valores (prompt, rutas, nombre de modelo) se devuelven SIEMPRE
 * como elementos de un array de argumentos; jamás se construye una línea de shell.
 * Así un prompt con `; rm -rf /` o que empiece con `-` es un único argumento.
 */

import fs from 'node:fs';
import path from 'node:path';

import { compilar } from './glob.js';

/**
 * Modos de trabajo y su agente de opencode. `auto` no fija agente (usa el de
 * opencode por defecto) porque es el modo sin restricciones, opt-in explícito.
 * @type {Readonly<Record<'readonly'|'safe'|'auto', { agente: string|null }>>}
 */
export const MODOS = Object.freeze({
  readonly: Object.freeze({ agente: 'coder-readonly' }),
  safe: Object.freeze({ agente: 'coder' }),
  auto: Object.freeze({ agente: null }),
});

/**
 * Patrones de `bash` de SOLO LECTURA permitidos en `readonly`. Replican la lista
 * de `~/.config/opencode/agent/coder-readonly.md`: inspección y pruebas, nunca
 * mutación. El `"*": deny` base los habilita uno a uno (gana la última regla).
 * @type {ReadonlyArray<string>}
 */
export const BASH_SOLO_LECTURA = Object.freeze([
  'ls*',
  'pwd',
  'cat *',
  'head *',
  'tail *',
  'wc *',
  'rg *',
  'grep *',
  'find *',
  'git status*',
  'git diff*',
  'git log*',
  'git show*',
  'git branch*',
  'node --version',
  'npm test*',
  'pytest*',
  'go test*',
  'cargo test*',
]);

/**
 * Patrones de `bash` DENEGADOS por seguridad en `safe`. Replican la lista de
 * `~/.config/opencode/agent/coder.md`: operaciones privilegiadas o destructivas
 * (sudo, formateo, borrado del home, push, reset/clean). El `"*": allow` base los
 * deniega uno a uno (gana la última regla).
 * @type {ReadonlyArray<string>}
 */
export const BASH_DENEGADOS_SEGUROS = Object.freeze([
  'sudo *',
  'su *',
  'rm -rf /*',
  'rm -rf ~*',
  'rm -rf $HOME*',
  'mkfs*',
  'dd if=*',
  'shutdown*',
  'reboot*',
  'poweroff*',
  'chmod -R 777 /*',
  'chown -R * /*',
  'curl *|*sh*',
  'wget *|*sh*',
  'git push*',
  'git reset --hard*',
  'git clean -*',
  ':(){*',
]);

/**
 * Formato aceptable de un modelo: `proveedor/modelo`. Conservador pero permite
 * puntos, guiones, `@` y `:` (etiquetas/versiones).
 */
const FORMATO_MODELO = /^[A-Za-z0-9][A-Za-z0-9._@-]*\/[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/** Separador inequívoco entre el encabezado del orquestador y la tarea original. */
const SEPARADOR_TAREA = '\n\n--- TAREA ---\n\n';

/**
 * Resuelve y valida un modo de trabajo.
 *
 * @param {unknown} modo `readonly`, `safe` o `auto` (se acepta cualquier caja)
 * @returns {{ agente: string|null }} descriptor del modo
 * @throws {Error} con los modos permitidos si no es válido
 */
export function resolverModo(modo) {
  const clave = typeof modo === 'string' ? modo.toLowerCase() : modo;
  const descriptor = typeof clave === 'string' ? MODOS[clave] : undefined;
  if (!descriptor) {
    throw new Error(
      `Modo desconocido: ${JSON.stringify(modo)} (permitidos: ${Object.keys(MODOS).join(', ')})`,
    );
  }
  return descriptor;
}

/**
 * Valida un nombre de modelo con formato `proveedor/modelo`.
 * @param {unknown} modelo
 * @returns {string} el modelo validado
 * @throws {Error} si no es un texto con el formato esperado
 */
function validarModelo(modelo) {
  if (typeof modelo !== 'string' || !FORMATO_MODELO.test(modelo)) {
    throw new Error(
      `Modelo inválido: ${JSON.stringify(modelo)} (se espera 'proveedor/modelo', p. ej. 'opencode-go/deepseek-v4.1-flash')`,
    );
  }
  return modelo;
}

/**
 * Valida una ruta a adjuntar (`-f`).
 * @param {unknown} archivo
 * @returns {string}
 * @throws {Error} si no es un texto o contiene NUL
 */
function validarArchivo(archivo) {
  if (typeof archivo !== 'string') throw new Error(`Cada archivo de 'files' debe ser un texto: ${JSON.stringify(archivo)}`);
  if (archivo.includes('\0')) throw new Error("Una ruta de 'files' no puede contener NUL");
  return archivo;
}

/**
 * Valida una lista de patrones glob (delega en `glob.compilar` para no duplicar
 * la sintaxis y garantizar que opencode reciba patrones bien formados).
 * @param {unknown[]} patrones
 * @param {string} campo nombre del campo para el mensaje
 * @returns {void}
 * @throws {Error} si algún patrón no es válido
 */
function validarPatrones(patrones, campo) {
  patrones.forEach((patron, indice) => {
    try {
      compilar(patron);
    } catch (error) {
      throw new Error(`${campo}[${indice}] no es un patrón glob válido: ${error.message}`);
    }
  });
}

/**
 * Construye el array de argumentos de `opencode run --standalone`.
 *
 * Orden: `run`, `--standalone`, `--model` (si hay), `--agent` (si corresponde),
 * `-f` por archivo, `--auto` (por defecto en todos los modos salvo `auto === false`)
 * y el prompt ORIGINAL al final.
 *
 * POR QUÉ array y no una cadena: con array opencode recibe cada valor como un
 * argumento literal; no hay shell que interprete `;`, `$`, comillas ni espacios, y
 * un prompt que empiece con `-` es un único elemento.
 *
 * @param {object} opciones
 * @param {string} opciones.prompt instrucciones para opencode (no vacío)
 * @param {'readonly'|'safe'|'auto'} opciones.modo modo de trabajo
 * @param {string} [opciones.modelo] modelo `proveedor/modelo`
 * @param {string[]} [opciones.files=[]] archivos a adjuntar
 * @param {string|null} [opciones.agente] agente explícito; si se omite se usa el del modo
 * @param {boolean} [opciones.auto] fuerza auto-aprobación; `false` la desactiva
 * @returns {string[]} argumentos listos para `spawn`/`execFile`
 * @throws {Error} si el prompt, el modelo, los archivos o el modo no son válidos
 */
export function construirArgs({ prompt, modo, modelo, files = [], agente, auto } = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('El prompt debe ser un texto no vacío');
  }
  const descriptor = resolverModo(modo);
  if (!Array.isArray(files)) throw new Error("'files' debe ser un array de rutas");

  const args = ['run', '--standalone'];

  if (modelo !== undefined && modelo !== null && modelo !== '') {
    args.push('--model', validarModelo(modelo));
  }

  // El agente explícito pisa al del modo; un valor vacío/nulo equivale a "sin agente".
  const agenteEfectivo = agente !== undefined ? agente : descriptor.agente;
  if (agenteEfectivo !== undefined && agenteEfectivo !== null && agenteEfectivo !== '') {
    if (typeof agenteEfectivo !== 'string') throw new Error("'agente' debe ser un texto");
    args.push('--agent', agenteEfectivo);
  }

  for (const archivo of files) args.push('-f', validarArchivo(archivo));

  // `--auto` se activa por defecto en todos los modos; solo `auto === false` la apaga.
  if (auto !== false) args.push('--auto');

  // El prompt va tal cual, como ÚLTIMO elemento.
  args.push(prompt);
  return args;
}

/**
 * Reglas de `permission.edit` en el ORDEN OBLIGATORIO (gana la última coincidencia).
 *
 *  - readonly            : `"*": deny` total (ningún cambio).
 *  - safe                : `"*": deny`, un `allow` por `writes`, y `deny` de
 *                          protegidos AL FINAL (gana sobre `writes` si se solapan).
 *  - auto sin writes     : `"*": allow` (sin restringir) y `deny` de protegidos al final.
 *  - auto con writes     : igual que `safe` (los `writes` acotan el alcance).
 *
 * @param {'readonly'|'safe'|'auto'} modo
 * @param {string[]} writes
 * @param {string[]} protegidos
 * @returns {Record<string, 'allow'|'deny'>}
 */
function reglasEdit(modo, writes, protegidos) {
  /** @type {Record<string, 'allow'|'deny'>} */
  const reglas = {};

  if (modo === 'readonly') {
    reglas['*'] = 'deny';
    return reglas;
  }

  if (modo === 'auto' && writes.length === 0) {
    reglas['*'] = 'allow';
  } else {
    reglas['*'] = 'deny';
    for (const patron of writes) reglas[patron] = 'allow';
  }

  // SIEMPRE al final: un protected que se solape con un write queda denegado.
  // Se borra antes de reasignar: reasignar una clave existente la deja en su posición
  // original y un allow posterior más específico pasaría a ganar sobre el deny.
  for (const patron of protegidos) {
    delete reglas[patron];
    reglas[patron] = 'deny';
  }
  return reglas;
}

/**
 * Reglas de `permission.bash` por modo.
 *
 *  - readonly: `"*": deny` + un `allow` por cada comando de solo lectura.
 *  - safe    : `"*": allow` + un `deny` por cada comando peligroso.
 *  - auto    : `"*": allow` sin lista de denegados (opt-in explícito).
 *
 * @param {'readonly'|'safe'|'auto'} modo
 * @returns {Record<string, 'allow'|'deny'>}
 */
function reglasBash(modo) {
  /** @type {Record<string, 'allow'|'deny'>} */
  const reglas = {};
  if (modo === 'readonly') {
    reglas['*'] = 'deny';
    for (const patron of BASH_SOLO_LECTURA) reglas[patron] = 'allow';
  } else {
    reglas['*'] = 'allow';
    if (modo === 'safe') for (const patron of BASH_DENEGADOS_SEGUROS) reglas[patron] = 'deny';
  }
  return reglas;
}

/**
 * Genera el OBJETO de configuración de opencode para un trabajo. La serialización
 * a JSON la hace quien lo escribe (`escribirConfigDeTrabajo`).
 *
 * La clave `agent.<nombreAgente>` define un agente en línea con `mode: primary` y
 * los permisos del modo. `webfetch` se deniega salvo en `auto`.
 *
 * @param {object} opciones
 * @param {'readonly'|'safe'|'auto'} opciones.modo
 * @param {string[]} [opciones.writes=[]] patrones que puede modificar
 * @param {string[]} [opciones.protegidos=[]] patrones que NUNCA puede modificar
 * @param {string} [opciones.modelo] modelo `proveedor/modelo`
 * @param {string} [opciones.nombreAgente='orq'] nombre del agente en línea
 * @returns {{ $schema: string, model?: string, agent: Record<string, object> }}
 * @throws {Error} si el modo o algún patrón son inválidos
 */
export function generarConfigDeTrabajo({
  modo,
  writes = [],
  protegidos = [],
  modelo,
  nombreAgente = 'orq',
} = {}) {
  resolverModo(modo); // valida temprano con mensaje claro
  if (!Array.isArray(writes)) throw new Error("'writes' debe ser un array de patrones");
  if (!Array.isArray(protegidos)) throw new Error("'protegidos' debe ser un array de patrones");
  validarPatrones(writes, 'writes');
  validarPatrones(protegidos, 'protegidos');
  if (typeof nombreAgente !== 'string' || nombreAgente.trim() === '') {
    throw new Error("'nombreAgente' debe ser un texto no vacío");
  }

  const permission = {
    edit: reglasEdit(modo, writes, protegidos),
    bash: reglasBash(modo),
    webfetch: modo === 'auto' ? 'allow' : 'deny',
    // Fuera del proyecto no se lee ni se edita con las herramientas (medido: no rompe leer a
    // través de enlaces simbólicos como node_modules ni los comandos de shell relativos).
    external_directory: modo === 'auto' ? 'allow' : 'deny',
  };

  /** @type {{ $schema: string, model?: string, agent: Record<string, object> }} */
  const config = { $schema: 'https://opencode.ai/config.json' };
  if (modelo !== undefined && modelo !== null && modelo !== '') {
    config.model = validarModelo(modelo);
  }
  config.agent = { [nombreAgente]: { mode: 'primary', permission } };
  return config;
}

/**
 * Formatea una lista de patrones para el encabezado del prompt.
 * @param {string[]} valores
 * @param {string} vacio texto a usar si la lista está vacía
 * @returns {string}
 */
function listar(valores, vacio) {
  if (!Array.isArray(valores) || valores.length === 0) return vacio;
  return valores.map((v) => `\`${String(v)}\``).join(', ');
}

/**
 * Construye el texto final que recibe opencode: un encabezado fijo en español con
 * las reglas del orquestador y, separado por una línea clara, el prompt ORIGINAL
 * sin alterar (se concatena tal cual, aunque traiga backticks, `$`, comillas o
 * saltos de línea; no se interpreta como plantilla).
 *
 * @param {object} opciones
 * @param {string} opciones.prompt instrucciones originales
 * @param {'readonly'|'safe'|'auto'} opciones.modo
 * @param {string[]} [opciones.writes=[]] patrones que puede modificar
 * @param {string[]} [opciones.reads=[]] patrones que puede leer (informativo)
 * @param {string[]} [opciones.protegidos=[]] patrones que no puede tocar
 * @param {string} [opciones.rutaTrabajo] directorio donde corre (informativo)
 * @returns {string} encabezado + separador + prompt original
 * @throws {Error} si el prompt o el modo son inválidos
 */
export function construirPrompt({
  prompt,
  modo,
  writes = [],
  reads = [],
  protegidos = [],
  rutaTrabajo,
} = {}) {
  if (typeof prompt !== 'string') throw new Error("El prompt debe ser un texto (puede estar vacío)");
  resolverModo(modo);

  const lineas = ['Reglas del orquestador (obligatorias):'];
  lineas.push(
    rutaTrabajo
      ? `- Trabajas dentro del directorio actual: ${rutaTrabajo}`
      : '- Trabajas dentro del directorio actual.',
  );

  if (modo === 'readonly') {
    lineas.push(
      '- No podes modificar NINGUN archivo ni crear ni borrar nada: solo inspeccionar y ejecutar comandos de lectura o pruebas.',
    );
  } else {
    lineas.push(`- Solo podes modificar estos patrones: ${listar(writes, '(ninguno)')}`);
  }

  if (Array.isArray(reads) && reads.length > 0) {
    lineas.push(`- Podes leer: ${listar(reads, '')}`);
  }

  lineas.push(`- NUNCA modifiques estos (estan protegidos): ${listar(protegidos, '(ninguno)')}`);
  lineas.push('- No hagas git commit, ni push, ni reset, ni clean.');
  lineas.push('- No corras la suite completa ni comandos que usen recursos compartidos salvo que la tarea lo pida.');
  lineas.push('- Termina apenas pasen tus verificaciones.');
  lineas.push('- Responde corto, con los archivos tocados y los resultados.');

  return `${lineas.join('\n')}${SEPARADOR_TAREA}${prompt}`;
}

/**
 * Escribe la configuración del trabajo en `<dirJob>/opencode.jsonc` de forma
 * ATÓMICA y con permisos 0600.
 *
 * POR QUÉ atómica: opencode puede leer el archivo en cuanto se lo pasamos por
 * `OPENCODE_CONFIG`; escribir a un temporal y luego `rename` garantiza que vea el
 * contenido completo o nada, nunca un JSON a medias.
 *
 * POR QUÉ 0600: el archivo puede contener rutas internas del trabajo; no debe ser
 * legible por otros usuarios del sistema.
 *
 * @param {string} dirJob directorio del trabajo (se crea si no existe)
 * @param {object|string} config objeto de configuración o su JSON ya serializado
 * @returns {string} ruta absoluta/relativa del archivo escrito
 * @throws {Error} si `dirJob` no es válido o la escritura falla
 */
export function escribirConfigDeTrabajo(dirJob, config) {
  if (typeof dirJob !== 'string' || dirJob.trim() === '') {
    throw new Error('dirJob debe ser un texto no vacío');
  }
  fs.mkdirSync(dirJob, { recursive: true });
  const destino = path.join(dirJob, 'opencode.jsonc');
  const contenido = typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`;

  const temporal = `${destino}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = fs.openSync(temporal, 'w', 0o600);
  try {
    fs.writeFileSync(fd, contenido);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporal, destino);
  try {
    fs.chmodSync(destino, 0o600);
  } catch {
    /* en sistemas sin permisos POSIX (p. ej. Windows) no aplica */
  }
  return destino;
}

/**
 * Construye el entorno del trabajo: el base más `OPENCODE_CONFIG` apuntando a la
 * configuración del trabajo.
 *
 * POR QUÉ se ELIMINA `OPENCODE_CONFIG_DIR`: ese hallazgo del diseño (§14) demuestra
 * que `OPENCODE_CONFIG_DIR` REEMPLAZA la configuración global (se perdió el modelo
 * y cayó a otro proveedor). Si el entorno base lo trae, se descarta siempre.
 *
 * Devuelve un objeto nuevo: nunca muta `base`.
 *
 * @param {object} opciones
 * @param {string} opciones.rutaConfig ruta del `opencode.jsonc` del trabajo
 * @param {NodeJS.ProcessEnv|Record<string,string>} [opciones.base={}] entorno base
 * @returns {Record<string,string|undefined>} entorno con `OPENCODE_CONFIG` y sin `OPENCODE_CONFIG_DIR`
 */
export function entornoDeTrabajo({ rutaConfig, base = {} } = {}) {
  if (typeof rutaConfig !== 'string' || rutaConfig.trim() === '') {
    throw new Error('rutaConfig debe ser un texto no vacío');
  }
  const entorno = { ...base, OPENCODE_CONFIG: rutaConfig };
  delete entorno.OPENCODE_CONFIG_DIR; // peligroso por el hallazgo del diseño (§14)
  return entorno;
}
