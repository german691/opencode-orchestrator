/**
 * Alcance (scope): superposición conservadora de patrones y verificación de
 * cambios contra `writes`/`protected`/`readonly`.
 *
 * POR QUÉ conservador: el planificador decide serializar trabajos que "podrían"
 * pisarse. Reducimos cada patrón a su prefijo literal (lo anterior al primer
 * comodín) y decimos que hay choque si un prefijo contiene al otro respetando
 * límites de directorio. Esto puede serializar de más, nunca de menos (§5), que
 * es la dirección segura: mejor esperar que corromper el árbol.
 */

import { compilar, coincide } from './glob.js';

/**
 * Valida y normaliza un patrón de entrada.
 * @param {string} valor
 * @returns {string} patrón con '/' como separador
 */
function comoPatron(valor) {
  if (typeof valor !== 'string' || valor.length === 0) {
    throw new TypeError('El patrón debe ser un texto no vacío');
  }
  return valor.replace(/\\/g, '/');
}

/**
 * Reduce un patrón a su prefijo literal de directorio: todo lo anterior al primer
 * comodín (`*` o `?`), recortado hasta la última '/'.
 *
 * Ejemplos: 'backend/src/**' -> 'backend/src'; '*.md' -> '';
 * 'docs/*.md' -> 'docs'; '.env' -> '.env'.
 *
 * @param {string} patron
 * @returns {string} prefijo sin barra final ('' = raíz del repo)
 * @throws {TypeError} si el patrón no es un texto no vacío
 */
export function prefijoLiteral(patron) {
  const p = comoPatron(patron);
  const primerComodin = p.search(/[*?]/);
  const hastaComodin = primerComodin === -1 ? p : p.slice(0, primerComodin);
  const ultimaBarra = hastaComodin.lastIndexOf('/');
  if (ultimaBarra === -1) {
    // Sin directorio: si venía de un literal sin comodín es el propio nombre;
    // si venía de un comodín en la raíz, no tiene prefijo de directorio.
    return primerComodin === -1 ? hastaComodin : '';
  }
  return hastaComodin.slice(0, ultimaBarra).replace(/\/+$/, '');
}

/**
 * ¿El patrón puede alcanzar cualquier directorio? Un patrón cuyo prefijo literal
 * es '' y que además contiene '**' (p. ej. el patrón universal) no está atado a
 * ningún directorio; por eso se superpone con todo.
 * @param {string} patron
 * @returns {boolean}
 */
function esUniversal(patron) {
  return prefijoLiteral(patron) === '' && comoPatron(patron).includes('**');
}

/**
 * ¿Un prefijo literal comparte ubicación con el otro respetando límites de
 * directorio? La raíz '' NO es prefijo de 'docs': son ubicaciones distintas
 * (archivos de la raíz vs. contenido de docs). Por eso '*.md' y 'docs/**' no
 * se superponen.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function prefijoComparte(a, b) {
  if (a === b) return true;
  if (a !== '' && b.startsWith(`${a}/`)) return true;
  if (b !== '' && a.startsWith(`${b}/`)) return true;
  return false;
}

/**
 * ¿El patrón está confinado a la raíz (no contiene '/')? Un patrón de la raíz solo
 * puede alcanzar archivos de la raíz, nunca contenido dentro de un directorio.
 * @param {string} patron
 * @returns {boolean}
 */
function esDeRaiz(patron) {
  return !comoPatron(patron).includes('/');
}

/**
 * ¿El patrón contiene algún comodín ('*' o '?')?
 * @param {string} patron
 * @returns {boolean}
 */
function tieneComodin(patron) {
  return /[*?]/.test(comoPatron(patron));
}

/**
 * Segmentos del patrón separados por '/', normalizando y quitando barras finales.
 * Se usa para razonar componente a componente.
 * @param {string} patron
 * @returns {string[]}
 */
function segmentos(patron) {
  return comoPatron(patron)
    .replace(/\/+$/, '')
    .split('/');
}

/**
 * ¿Hay un '**' que NO ocupa un segmento completo (p. ej. 'a**b')? En glob.js ese
 * '**' se compila como '.*' y puede cruzar '/', lo que invalida el modelo por
 * segmentos. POR QUÉ nos importa: preferimos devolver superposición de más antes
 * que arriesgar un falso negativo con una semántica que no modelamos con precisión.
 * @param {string} patron
 * @returns {boolean}
 */
function tieneComodinCruzado(patron) {
  return segmentos(patron).some((s) => s !== '**' && s.includes('**'));
}

/**
 * ¿Existe un texto no vacío (sin '/') que casen a la vez dos segmentos de patrón?
 *
 * POR QUÉ autómata producto: un segmento solo puede contener '*', '?' y literales.
 * Recorremos el producto de sus posiciones; '*' puede consumir un caracter o
 * saltarse (transición épsilon), '?' consume cualquier caracter y un literal solo
 * a sí mismo. Aceptamos si ambos llegan al final habiendo consumido al menos un
 * caracter, porque un componente de ruta nunca es vacío. Que exista esa cadena es
 * la evidencia de que los dos segmentos pueden describir el mismo componente.
 *
 * @param {string} p segmento del primer patrón
 * @param {string} q segmento del segundo patrón
 * @returns {boolean}
 */
function interseccionSegmento(p, q) {
  const n = p.length;
  const m = q.length;
  const visitado = new Set();
  const cola = [[0, 0, 0]]; // [posición en p, posición en q, ¿consumió algo?]
  visitado.add('0,0,0');

  while (cola.length > 0) {
    const [i, j, consumio] = cola.shift();
    if (i === n && j === m && consumio === 1) return true;

    const encolar = (ni, nj, nc) => {
      const clave = `${ni},${nj},${nc}`;
      if (!visitado.has(clave)) {
        visitado.add(clave);
        cola.push([ni, nj, nc]);
      }
    };

    // Épsilon: '*' puede no consumir nada.
    if (i < n && p[i] === '*') encolar(i + 1, j, consumio);
    if (j < m && q[j] === '*') encolar(i, j + 1, consumio);

    // Consumir un caracter común: solo importa que exista, no cuál.
    if (i < n && j < m) {
      const pa = p[i];
      const qb = q[j];
      const hayCaracterComun =
        pa === '*' || qb === '*' || pa === '?' || qb === '?' || pa === qb;
      if (hayCaracterComun) {
        // '*' se queda (puede seguir consumiendo); el resto avanza su posición.
        encolar(pa === '*' ? i : i + 1, qb === '*' ? j : j + 1, 1);
      }
    }
  }

  return false;
}

/**
 * ¿Dos secuencias de segmentos pueden describir una misma ruta?
 *
 * '**' como segmento completo absorbe cero o más componentes de ruta. El resto de
 * segmentos consume exactamente un componente y solo encajan si existe un texto
 * común (`interseccionSegmento`). Programación dinámica sobre (i, j) para no
 * repetir trabajo; la base es que ambas secuencias se agoten a la vez.
 *
 * @param {string[]} a segmentos del primer patrón
 * @param {string[]} b segmentos del segundo patrón
 * @returns {boolean}
 */
function comunSecuencia(a, b) {
  const n = a.length;
  const m = b.length;
  const memo = new Map();
  const clave = (i, j) => i * (m + 1) + j;

  const f = (i, j) => {
    if (i === n && j === m) return true;
    const k = clave(i, j);
    if (memo.has(k)) return memo.get(k);

    let res;
    if (i < n && a[i] === '**') {
      // '**' puede no consumir nada o absorber el siguiente componente (que,
      // por ser '**', siempre encaja con lo que aporte el otro patrón).
      res = f(i + 1, j) || (j < m && f(i, j + 1));
    } else if (j < m && b[j] === '**') {
      res = f(i, j + 1) || (i < n && f(i + 1, j));
    } else if (i < n && j < m) {
      res = interseccionSegmento(a[i], b[j]) && f(i + 1, j + 1);
    } else {
      res = false;
    }

    memo.set(k, res);
    return res;
  };

  return f(0, 0);
}

/**
 * ¿Dos patrones podrían tocar los mismos archivos? Aproximación conservadora:
 * puede decir `true` de más, nunca `false` de menos (§5).
 *
 * Se combinan varias reglas, de la más barata a la más precisa, de modo que
 * cualquier caso con ruta común quede cubierto:
 *
 *  1. Universal: un patrón con '**' desde la raíz alcanza cualquier ruta.
 *  2. Raíz: un patrón de la raíz con comodín puede alcanzar cualquier archivo de
 *     la raíz, así que choca con cualquier otro patrón de la raíz (literal o con
 *     comodín). No alcanza a patrones con '/' (p. ej. 'docs/**'), que viven en
 *     directorios distintos.
 *  3. Prefijos literales que comparten directorio: conserva el comportamiento
 *     histórico ('backend/**' con 'backend/src/**', límites de directorio, etc.).
 *  4. Comodín no confinado a un segmento ('a**b'): sin modelo fiable, ante la duda
 *     superponemos.
 *  5. Intersección real por segmentos: cubre '?', '*' dentro de un segmento y '**'
 *     en cualquier posición, incluidos los casos que la heurística de prefijos
 *     resolvía como falso negativo (literal raíz contra comodín raíz, comodín en
 *     el primer segmento, '?' en un directorio, etc.).
 *
 * @param {string} a patrón
 * @param {string} b patrón
 * @returns {boolean}
 */
export function seSuperponen(a, b) {
  // 1) Universal.
  if (esUniversal(a) || esUniversal(b)) return true;

  // 2) Regla de la raíz (evita el bug de prefijos: literal vs comodín de raíz).
  const ambasDeRaiz = esDeRaiz(a) && esDeRaiz(b);
  if (ambasDeRaiz && (tieneComodin(a) || tieneComodin(b))) return true;

  // 3) Prefijos literales que comparten directorio.
  if (prefijoComparte(prefijoLiteral(a), prefijoLiteral(b))) return true;

  // 4) Comodín que cruza segmentos: conservador.
  if (tieneComodinCruzado(a) || tieneComodinCruzado(b)) return true;

  // 5) Intersección por segmentos (sound: nunca false de menos).
  return comunSecuencia(segmentos(a), segmentos(b));
}

/**
 * ¿Algún patrón de `listaA` se superpone con alguno de `listaB`?
 *
 * @param {string[]} [listaA]
 * @param {string[]} [listaB]
 * @returns {boolean}
 * @throws {TypeError} si alguna lista no es un array
 */
export function gruposSeSuperponen(listaA = [], listaB = []) {
  if (!Array.isArray(listaA) || !Array.isArray(listaB)) {
    throw new TypeError('gruposSeSuperponen espera dos arrays de patrones');
  }
  for (const a of listaA) {
    for (const b of listaB) {
      if (seSuperponen(a, b)) return true;
    }
  }
  return false;
}

/** Modos válidos de un trabajo (§3). */
const MODOS_VALIDOS = new Set(['readonly', 'safe', 'auto']);

/**
 * Verifica una lista de archivos cambiados contra el alcance declarado.
 *
 * Precedencia de motivos (del más fuerte al más débil):
 *  1. 'protegido'      : coincide con un patrón protegido (gana incluso sobre `writes`).
 *  2. 'solo_lectura'   : modo readonly; cualquier cambio es violación.
 *  3. 'fuera_de_alcance': no coincide con ningún patrón de `writes`.
 *
 * Los archivos repetidos se deduplican conservando el orden de aparición. Una
 * lista vacía da `{ ok: true, violaciones: [] }`.
 *
 * @param {object} [entrada]
 * @param {string[]} [entrada.archivosCambiados] rutas relativas cambiadas
 * @param {string[]} [entrada.writes] patrones permitidos
 * @param {string[]} [entrada.protegidos] patrones siempre prohibidos
 * @param {'readonly'|'safe'|'auto'} [entrada.modo] modo del trabajo
 * @returns {{ ok: boolean, violaciones: Array<{ruta: string, motivo: string}> }}
 * @throws {TypeError|Error} si los tipos de entrada no son válidos
 */
export function verificarCambios(entrada = {}) {
  const {
    archivosCambiados = [],
    writes = [],
    protegidos = [],
    modo = 'safe',
  } = entrada;

  if (!Array.isArray(archivosCambiados)) {
    throw new TypeError('archivosCambiados debe ser un array de rutas');
  }
  if (!Array.isArray(writes)) {
    throw new TypeError('writes debe ser un array de patrones');
  }
  if (!Array.isArray(protegidos)) {
    throw new TypeError('protegidos debe ser un array de patrones');
  }
  if (!MODOS_VALIDOS.has(modo)) {
    throw new Error(`modo desconocido: ${modo} (permitidos: readonly, safe, auto)`);
  }

  const vistos = new Set();
  const violaciones = [];

  for (const original of archivosCambiados) {
    if (typeof original !== 'string') {
      throw new TypeError('cada archivo cambiado debe ser un texto');
    }
    const ruta = original.replace(/\\/g, '/');
    if (vistos.has(ruta)) continue; // deduplicación: un archivo cuenta una vez
    vistos.add(ruta);

    let motivo = null;
    if (protegidos.some((patron) => coincide(patron, ruta))) {
      motivo = 'protegido';
    } else if (modo === 'readonly') {
      motivo = 'solo_lectura';
    } else if (!writes.some((patron) => coincide(patron, ruta))) {
      motivo = 'fuera_de_alcance';
    }

    if (motivo !== null) violaciones.push({ ruta, motivo });
  }

  return { ok: violaciones.length === 0, violaciones };
}
