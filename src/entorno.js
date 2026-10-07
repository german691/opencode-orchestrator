/**
 * Carga opcional de variables desde `~/.config/opencode-orchestrator/env`.
 *
 * POR QUÉ un archivo y no el `env` del cliente: el servidor corre dentro de WSL detrás de
 * `wsl.exe`, que NO hereda las variables de Windows. Y las credenciales (p. ej. la URL de
 * administración de Postgres) no deben vivir en el JSON de configuración del cliente ni en
 * un perfil versionado. El archivo vive fuera de cualquier repo y debería ser `0600`.
 *
 * Formato: una `CLAVE=valor` por línea; `#` comenta; el valor puede ir entre comillas
 * simples o dobles. Las variables que YA existen en el entorno NO se pisan.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Ruta por defecto del archivo de entorno. */
export function rutaDeEntornoPorDefecto(home = os.homedir()) {
  return path.join(home, '.config', 'opencode-orchestrator', 'env');
}

/**
 * Parsea el contenido de un archivo de entorno.
 *
 * @param {string} texto
 * @returns {{ variables: Record<string, string>, invalidas: number[] }} variables válidas y
 *   los números de línea (1-based) que no se pudieron interpretar
 */
export function parsearEntorno(texto) {
  const variables = {};
  const invalidas = [];
  texto.split(/\r?\n/).forEach((linea, indice) => {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) return;
    const coincide = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(limpia);
    if (!coincide) {
      invalidas.push(indice + 1);
      return;
    }
    let valor = coincide[2].trim();
    const comilla = valor[0];
    if ((comilla === '"' || comilla === "'") && valor.length >= 2 && valor.endsWith(comilla)) {
      valor = valor.slice(1, -1);
    }
    variables[coincide[1]] = valor;
  });
  return { variables, invalidas };
}

/**
 * Carga el archivo en `env` sin pisar lo que ya está definido.
 *
 * @param {object} [opciones]
 * @param {string} [opciones.ruta] archivo a leer
 * @param {NodeJS.ProcessEnv} [opciones.env=process.env] entorno destino
 * @param {(...partes: unknown[]) => void} [opciones.log] diagnóstico (nunca recibe valores)
 * @returns {{ cargadas: string[], omitidas: string[], existe: boolean }} nombres de variables
 *   (jamás sus valores, que pueden ser secretos)
 */
export function cargarEntornoDeArchivo({ ruta = rutaDeEntornoPorDefecto(), env = process.env, log = () => {} } = {}) {
  let texto;
  try {
    const stat = fs.statSync(ruta);
    if ((stat.mode & 0o077) !== 0) {
      log(`aviso: ${ruta} es legible por otros usuarios; debería ser 0600`);
    }
    texto = fs.readFileSync(ruta, 'utf8');
  } catch {
    return { cargadas: [], omitidas: [], existe: false };
  }
  const { variables, invalidas } = parsearEntorno(texto);
  if (invalidas.length > 0) log(`aviso: líneas no interpretables en ${ruta}: ${invalidas.join(', ')}`);
  const cargadas = [];
  const omitidas = [];
  for (const [nombre, valor] of Object.entries(variables)) {
    if (Object.hasOwn(env, nombre) && env[nombre] !== undefined && env[nombre] !== '') {
      omitidas.push(nombre);
    } else {
      env[nombre] = valor;
      cargadas.push(nombre);
    }
  }
  return { cargadas, omitidas, existe: true };
}
