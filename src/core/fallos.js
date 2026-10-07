/**
 * Extracción del resumen de FALLOS de la salida de un comando de aceptación.
 *
 * POR QUÉ: un comando de aceptación típico (lint + tests) imprime miles de líneas y lo que
 * importa —qué test falló y por qué— queda en medio o en stderr. Mostrar solo el final del
 * stdout obligaba a abrir los logs a mano. Esta función saca de ahí el bloque de fallos.
 */

/** Marcadores, de más a menos específicos, donde empieza el detalle de fallos. */
const MARCADORES = [
  /^\s*⎯+\s*Failed (Tests|Suites)\b/m, // vitest
  /^\s*FAIL\s+\S/m, // vitest/jest: " FAIL  ruta > nombre"
  /^not ok \d+/m, // node:test (TAP)
  /^\s*(?:AssertionError|Error|TypeError)\b.*$/m,
  /error TS\d+:/, // tsc
  /^\s*\d+:\d+\s+error\s+/m, // eslint: "  12:3  error  mensaje  regla"
];

/** Quita las líneas de pila internas (`    at ...`) que solo agregan ruido. */
function sinPilas(texto) {
  return texto
    .split('\n')
    .filter((linea) => !/^\s+at\s+\S/.test(linea))
    .join('\n');
}

/**
 * Devuelve el bloque de fallos de un texto de salida, o `null` si no se reconoce ninguno.
 *
 * @param {string} texto salida completa (o su cola) del comando
 * @param {number} [maximo=2500] largo máximo del resultado
 * @returns {string|null}
 */
export function extraerFallos(texto, maximo = 2500) {
  if (typeof texto !== 'string' || texto.trim() === '') return null;
  for (const marcador of MARCADORES) {
    const encontrado = marcador.exec(texto);
    if (!encontrado) continue;
    const desde = texto.lastIndexOf('\n', encontrado.index) + 1;
    const bloque = sinPilas(texto.slice(desde)).trim();
    if (bloque === '') continue;
    return bloque.length <= maximo ? bloque : `${bloque.slice(0, maximo)}\n[... recortado]`;
  }
  return null;
}

/**
 * Combina stderr y stdout: prioriza el que tenga un bloque de fallos reconocible.
 *
 * @param {{ stdout?: string, stderr?: string }} salidas
 * @param {number} [maximo]
 * @returns {string|null}
 */
export function resumirFallos({ stdout = '', stderr = '' } = {}, maximo = 2500) {
  return extraerFallos(stderr, maximo) ?? extraerFallos(stdout, maximo);
}
