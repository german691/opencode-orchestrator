/**
 * Glob mínimo sin dependencias para rutas relativas con '/' como separador.
 *
 * POR QUÉ: el diseño (§4) exige verificar el alcance de cada trabajo comparando
 * los archivos cambiados contra patrones `writes`/`protected`. No queremos una
 * dependencia externa (regla del proyecto), y necesitamos semántica explícita y
 * auditable de `**`, `*` y `?`. Por eso compilamos a RegExp a mano en vez de
 * delegar en un paquete.
 *
 * Semántica:
 *  - `**`  : cualquier cosa, incluida la barra (profundidad arbitraria, incluso cero).
 *  - `*`   : cualquier secuencia de caracteres que NO cruza '/'.
 *  - `?`   : exactamente un caracter que NO es '/'.
 *  - resto : literal (los metacaracteres de RegExp se escapan).
 *  - Sensible a mayúsculas (los sistemas de archivos objetivo en Linux lo son).
 *
 * Seguridad: se rechazan rutas absolutas y cualquier segmento '..' para que un
 * patrón o una ruta no puedan escapar de la raíz del repositorio.
 */

/** Metacaracteres de RegExp que hay que escapar cuando aparecen como literal. */
const METACARACTERES_REGEX = /[.*+?^${}()|[\]\\]/;

/**
 * Normaliza los separadores a '/' para aceptar entradas de Windows sin sorpresas.
 * @param {string} texto
 * @returns {string}
 */
function normalizarSeparadores(texto) {
  return String(texto).replace(/\\/g, '/');
}

/**
 * ¿La ruta es absoluta? Cubre POSIX ('/...') y unidades de Windows ('C:/...').
 * @param {string} ruta ya normalizada
 * @returns {boolean}
 */
function esRutaAbsoluta(ruta) {
  return ruta.startsWith('/') || /^[A-Za-z]:\//.test(ruta);
}

/**
 * ¿Contiene un segmento '..'? Se comprueba por segmento para no rechazar
 * nombres legítimos como 'a..b'.
 * @param {string} ruta ya normalizada
 * @returns {boolean}
 */
function tienePuntoPunto(ruta) {
  return ruta.split('/').includes('..');
}

/**
 * Escapa un único caracter si es metacaracter de RegExp.
 * @param {string} caracter
 * @returns {string}
 */
function escaparLiteral(caracter) {
  return METACARACTERES_REGEX.test(caracter) ? `\\${caracter}` : caracter;
}

/**
 * Quita barras finales repetidas para que 'src/' y 'src' signifiquen lo mismo.
 * @param {string} texto
 * @returns {string}
 */
function quitarBarrasFinales(texto) {
  return texto.replace(/\/+$/, '');
}

/**
 * Compila un patrón glob a una RegExp anclada (^...$).
 *
 * @param {string} patron patrón relativo, p. ej. 'src/**' o un '.env' a cualquier nivel
 * @returns {RegExp} expresión anclada lista para `test`
 * @throws {Error} si el patrón es vacío, no es string, es absoluto o contiene '..'
 */
export function compilar(patron) {
  if (typeof patron !== 'string' || patron.length === 0) {
    throw new Error('El patrón glob debe ser un texto no vacío');
  }
  const patronNormalizado = normalizarSeparadores(patron);
  if (esRutaAbsoluta(patronNormalizado)) {
    throw new Error(`El patrón glob no puede ser una ruta absoluta: ${patron}`);
  }
  if (tienePuntoPunto(patronNormalizado)) {
    throw new Error(`El patrón glob no puede contener '..': ${patron}`);
  }
  const limpio = quitarBarrasFinales(patronNormalizado);
  if (limpio === '') {
    throw new Error(`El patrón glob queda vacío tras normalizar: ${patron}`);
  }

  let expresion = '^';
  let i = 0;
  while (i < limpio.length) {
    const caracter = limpio[i];

    if (caracter === '*') {
      // Doble comodín: profundidad arbitraria.
      if (limpio[i + 1] === '*') {
        if (limpio[i + 2] === '/') {
          // '**' seguido de '/': cero o más directorios completos. Así el patrón
          // de un '.env' oculto casa con '.env' (cero niveles) y con 'a/b/.env'.
          expresion += '(?:[^/]+/)*';
          i += 3;
        } else {
          // '**' final (o seguido de un literal): cualquier cosa, incluida '/'.
          expresion += '.*';
          i += 2;
        }
      } else {
        expresion += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (caracter === '?') {
      expresion += '[^/]';
      i += 1;
      continue;
    }

    expresion += escaparLiteral(caracter);
    i += 1;
  }
  expresion += '$';
  return new RegExp(expresion);
}

/**
 * ¿La ruta coincide con el patrón glob?
 *
 * Las rutas absolutas o con '..' devuelven `false` (nunca se lanza por la ruta);
 * un patrón inválido sí lanza, porque es un error de configuración.
 *
 * @param {string} patron patrón relativo
 * @param {string} ruta ruta relativa al repositorio
 * @returns {boolean}
 * @throws {Error} si `patron` es inválido
 */
export function coincide(patron, ruta) {
  const regex = compilar(patron);
  if (typeof ruta !== 'string' || ruta.length === 0) return false;

  const normalizada = normalizarSeparadores(ruta);
  if (esRutaAbsoluta(normalizada)) return false;
  if (tienePuntoPunto(normalizada)) return false;

  const limpia = quitarBarrasFinales(normalizada);
  if (limpia === '') return false;
  return regex.test(limpia);
}
