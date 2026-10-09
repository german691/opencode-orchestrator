/**
 * Recetas del perfil: plantillas de tarea con parámetros (§nuevo).
 *
 * POR QUÉ un módulo puro y aparte: una receta es una convención del repo (p. ej.
 * "tests de {modulo}") que el orquestador invoca por nombre en vez de repetir el
 * prompt y el alcance en cada llamada. Mantener la expansión pura permite probarla
 * con tablas y, sobre todo, validar los valores ANTES de encolar: un parámetro con
 * salto de línea o con '..' en `writes` escaparía del alcance declarado.
 *
 * Sintaxis: un `{nombre}` (letras, dígitos y guion bajo) en `prompt` o en `writes`
 * se reemplaza por `params[nombre]`. Todos los placeholders deben estar definidos;
 * si falta uno se informa cuál, y si tras sustituir queda una llave sin resolver
 * también es un error (evita prompts con `{x}` a medio reemplazar).
 */

/** Un placeholder `{nombre}` dentro de una plantilla. */
const RE_PARAMETRO = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * ¿Es un objeto JSON plano (no null, no array)?
 * @param {unknown} valor
 * @returns {boolean}
 */
function esObjetoPlano(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * Nombres de parámetros que aparecen en un texto, sin repetir y en orden de aparición.
 * @param {unknown} texto
 * @returns {string[]}
 */
export function parametrosDeTexto(texto) {
  if (typeof texto !== 'string') return [];
  const encontrados = [];
  for (const coincidencia of texto.matchAll(RE_PARAMETRO)) {
    const nombre = coincidencia[1];
    if (!encontrados.includes(nombre)) encontrados.push(nombre);
  }
  return encontrados;
}

/**
 * Nombres de parámetros que requiere una receta: los del `prompt` más los de sus `writes`.
 * @param {unknown} receta
 * @returns {string[]}
 */
export function parametrosDeReceta(receta) {
  const nombres = [];
  const agregar = (texto) => {
    for (const nombre of parametrosDeTexto(texto)) {
      if (!nombres.includes(nombre)) nombres.push(nombre);
    }
  };
  if (esObjetoPlano(receta)) {
    agregar(receta.prompt);
    for (const patron of Array.isArray(receta.writes) ? receta.writes : []) agregar(patron);
  }
  return nombres;
}

/**
 * Valida el valor de un parámetro que se va a inyectar en `writes`. Es la única
 * barrera que impide que un valor de datos convierta una ruta relativa en absoluta
 * o con '..', lo que rompería la garantía de alcance.
 * @param {string} nombre
 * @param {string} valor
 * @returns {void}
 * @throws {Error} si el valor no es utilizable en un patrón de escritura
 */
function validarValorDeWrite(nombre, valor) {
  if (/[\r\n]/.test(valor)) {
    throw new Error(`el parámetro '{${nombre}}' no puede tener saltos de línea porque se usa en \`writes\``);
  }
  const normalizado = valor.replace(/\\/g, '/');
  if (normalizado.startsWith('/') || /^[A-Za-z]:\//.test(normalizado)) {
    throw new Error(`el parámetro '{${nombre}}' no puede ser una ruta absoluta porque se usa en \`writes\``);
  }
  if (normalizado.split('/').includes('..')) {
    throw new Error(`el parámetro '{${nombre}}' no puede contener '..' porque se usa en \`writes\``);
  }
}

/**
 * Expande una receta con sus parámetros.
 *
 * @param {object} receta definición del perfil (`recetas.<nombre>`)
 * @param {Record<string, string>} [params] valores de los parámetros
 * @returns {{ prompt: string, writes?: string[], reads?: string[], mode?: string, accept?: string|object, resources?: string[], solo_aceptacion?: boolean }}
 * @throws {Error} si falta un parámetro, un valor no es texto, un valor de `writes` es
 *   inválido o queda una llave sin definir
 */
export function expandirReceta(receta, params = {}) {
  if (!esObjetoPlano(receta)) throw new Error('la receta debe ser un objeto');
  if (typeof receta.prompt !== 'string' || receta.prompt.trim() === '') {
    throw new Error('la receta necesita un `prompt` de texto no vacío');
  }
  if (!esObjetoPlano(params)) throw new Error('`params` debe ser un objeto de textos');

  for (const [nombre, valor] of Object.entries(params)) {
    if (typeof valor !== 'string') throw new Error(`el parámetro '${nombre}' debe ser un texto`);
  }

  // Cada placeholder de la plantilla debe venir definido: así el error dice cuál falta.
  for (const nombre of parametrosDeReceta(receta)) {
    if (!Object.prototype.hasOwnProperty.call(params, nombre)) {
      throw new Error(`falta el parámetro '{${nombre}}'`);
    }
  }

  const writes = Array.isArray(receta.writes) ? receta.writes : undefined;
  /** @type {Set<string>} */
  const enWrites = new Set();
  for (const patron of writes ?? []) {
    for (const nombre of parametrosDeTexto(patron)) enWrites.add(nombre);
  }
  for (const nombre of enWrites) validarValorDeWrite(nombre, params[nombre]);

  const sustituir = (texto) => texto.replace(RE_PARAMETRO, (_todo, nombre) => params[nombre]);
  const prompt = sustituir(receta.prompt);
  const writesExpandidos = writes ? writes.map(sustituir) : undefined;

  // Un valor de parámetro podría reintroducir una llave (`{x}`): no debe quedar ninguna.
  const pendientes = [...parametrosDeTexto(prompt), ...(writesExpandidos ?? []).flatMap(parametrosDeTexto)];
  if (pendientes.length > 0) throw new Error(`llave no definida {${pendientes[0]}}`);

  return {
    prompt,
    ...(writesExpandidos ? { writes: writesExpandidos } : {}),
    ...(Array.isArray(receta.reads) ? { reads: [...receta.reads] } : {}),
    ...(receta.mode !== undefined ? { mode: receta.mode } : {}),
    ...(receta.accept !== undefined ? { accept: receta.accept } : {}),
    ...(Array.isArray(receta.resources) ? { resources: [...receta.resources] } : {}),
    ...(receta.solo_aceptacion !== undefined ? { solo_aceptacion: receta.solo_aceptacion } : {}),
  };
}
