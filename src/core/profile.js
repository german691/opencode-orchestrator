/**
 * Perfil del entorno (§6): validación del archivo `.opencode-orchestrator.json`.
 *
 * POR QUÉ validación estricta: el perfil describe qué está protegido, qué
 * recursos se provisionan y cómo se aíslan los worktrees. Un typo silencioso
 * (p. ej. `protectd`) desactivaría una garantía de seguridad. Por eso se rechazan
 * los campos desconocidos y se acumulan TODOS los errores con la ruta del campo,
 * para que el usuario los vea de una sola pasada.
 */

import { compilar } from './glob.js';
import { homedir } from 'node:os';

/**
 * Error de validación de perfil. Lleva todos los mensajes acumulados en `.errores`.
 */
export class ErrorDePerfil extends Error {
  /**
   * @param {string[]} errores mensajes con la ruta del campo afectado
   */
  constructor(errores) {
    const lista = Array.isArray(errores) ? errores : [String(errores)];
    const cabecera = `Perfil inválido (${lista.length} error${lista.length === 1 ? '' : 'es'})`;
    super(`${cabecera}:\n${lista.map((e) => `- ${e}`).join('\n')}`);
    this.name = 'ErrorDePerfil';
    /** @type {string[]} */
    this.errores = lista;
  }
}

/** Campos de primer nivel permitidos (el resto se considera typo). */
const CLAVES_PERFIL = new Set([
  '$schema',
  'version',
  'name',
  'baseBranch',
  'integrationBranch',
  'concurrency',
  'protected',
  'worktrees',
  'env',
  'resources',
  'accept',
]);

/** Campos permitidos dentro de `worktrees`. */
const CLAVES_WORKTREES = new Set(['root', 'link', 'setup']);

/** Campos permitidos dentro de cada recurso. */
const CLAVES_RECURSO = new Set(['kind', 'adminUrlEnv', 'template', 'name', 'exportAs']);

/** Tipos de recurso soportados. */
const KINDS_RECURSO = new Set(['postgres-db']);

/** `name` del perfil: segmento de ruta seguro (se usa para armar directorios). */
const NOMBRE_SEGURO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** Nombre de variable de entorno válido (y por tanto de `exportAs`/`adminUrlEnv`). */
const NOMBRE_VARIABLE_ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * ¿Es un objeto JSON plano (no null, no array)?
 * @param {unknown} valor
 * @returns {boolean}
 */
function esObjetoPlano(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * ¿Es un nombre de variable de entorno válido?
 * @param {unknown} valor
 * @returns {boolean}
 */
function esNombreVariableEnv(valor) {
  return typeof valor === 'string' && NOMBRE_VARIABLE_ENV.test(valor);
}

/**
 * Valida una rama git y acumula los problemas encontrados.
 * @param {string} campo ruta del campo
 * @param {unknown} valor valor a validar (undefined = opcional, no error)
 * @param {string[]} errores acumulador
 * @returns {void}
 */
function validarRama(campo, valor, errores) {
  if (valor === undefined) return;
  if (typeof valor !== 'string' || valor.trim() === '') {
    errores.push(`${campo}: debe ser un texto no vacío`);
    return;
  }
  if (/\s/.test(valor)) errores.push(`${campo}: no puede contener espacios`);
  if (valor.includes('..')) errores.push(`${campo}: no puede contener '..'`);
  if (valor.endsWith('/')) errores.push(`${campo}: no puede terminar en '/'`);
  if (valor.endsWith('.lock')) errores.push(`${campo}: no puede terminar en '.lock'`);
  if (valor.startsWith('-')) errores.push(`${campo}: no puede empezar con '-'`);
  if (valor.startsWith('/')) errores.push(`${campo}: no puede empezar con '/'`);
  // Mismos caracteres que rechaza workspace.js: mejor fallar al validar el perfil que al crear el worktree.
  for (const caracter of ['~', '^', ':', '?', '*', '[', '\\']) {
    if (valor.includes(caracter)) errores.push(`${campo}: no puede contener '${caracter}'`);
  }
}

/**
 * Valida y normaliza un objeto de perfil ya parseado.
 *
 * Aplica valores por defecto seguros para los campos ausentes y devuelve una
 * copia nueva. Si hay cualquier error, lanza `ErrorDePerfil` con `.errores`.
 *
 * @param {unknown} objeto perfil parseado (JSON.parse)
 * @returns {object} perfil normalizado
 * @throws {ErrorDePerfil} con todos los errores acumulados
 */
export function validarPerfil(objeto) {
  /** @type {string[]} */
  const errores = [];

  if (!esObjetoPlano(objeto)) {
    throw new ErrorDePerfil(['<raíz>: el perfil debe ser un objeto JSON']);
  }

  // Detección de typos: cualquier campo no listado es un error.
  for (const clave of Object.keys(objeto)) {
    if (!CLAVES_PERFIL.has(clave)) errores.push(`${clave}: campo desconocido`);
  }

  if (objeto.version !== 1) errores.push('version: debe ser 1');
  if (typeof objeto.name !== 'string' || objeto.name.trim() === '') {
    errores.push('name: debe ser un texto no vacío');
  } else if (!NOMBRE_SEGURO.test(objeto.name)) {
    // `name` forma parte de rutas (~/work/{name}): no puede escapar con '/', '..' ni caracteres raros.
    errores.push('name: solo letras, dígitos, punto, guion y guion bajo (1 a 64, sin empezar con punto ni guion)');
  }

  validarRama('baseBranch', objeto.baseBranch, errores);
  validarRama('integrationBranch', objeto.integrationBranch, errores);

  if (objeto.concurrency !== undefined) {
    if (!Number.isInteger(objeto.concurrency) || objeto.concurrency < 1 || objeto.concurrency > 8) {
      errores.push('concurrency: debe ser un entero entre 1 y 8');
    }
  }

  if (objeto.protected !== undefined) {
    if (!Array.isArray(objeto.protected)) {
      errores.push('protected: debe ser un array de patrones');
    } else {
      objeto.protected.forEach((patron, indice) => {
        if (typeof patron !== 'string' || patron.length === 0) {
          errores.push(`protected[${indice}]: debe ser un texto no vacío`);
          return;
        }
        try {
          compilar(patron); // delega en el glob para no duplicar la sintaxis
        } catch (error) {
          errores.push(`protected[${indice}]: patrón inválido (${error.message})`);
        }
      });
    }
  }

  if (objeto.worktrees !== undefined) {
    if (!esObjetoPlano(objeto.worktrees)) {
      errores.push('worktrees: debe ser un objeto');
    } else {
      const wt = objeto.worktrees;
      for (const clave of Object.keys(wt)) {
        if (!CLAVES_WORKTREES.has(clave)) errores.push(`worktrees.${clave}: campo desconocido`);
      }
      if (wt.root !== undefined) {
        if (typeof wt.root !== 'string' || wt.root.trim() === '') {
          errores.push('worktrees.root: debe ser un texto no vacío');
        } else {
          const raiz = wt.root.replace(/\\/g, '/');
          const absoluta = raiz.startsWith('/') || /^[A-Za-z]:\//.test(raiz) || raiz === '~' || raiz.startsWith('~/');
          if (!absoluta) {
            errores.push("worktrees.root: debe ser absoluta o empezar con '~/' (una ruta relativa depende del directorio del servidor)");
          } else if (raiz.split('/').includes('..')) {
            errores.push("worktrees.root: no puede contener '..'");
          }
        }
      }
      if (wt.link !== undefined) {
        if (!Array.isArray(wt.link)) {
          errores.push('worktrees.link: debe ser un array de rutas relativas');
        } else {
          wt.link.forEach((ruta, indice) => {
            if (typeof ruta !== 'string' || ruta.trim() === '') {
              errores.push(`worktrees.link[${indice}]: debe ser un texto no vacío`);
              return;
            }
            const normalizada = ruta.replace(/\\/g, '/');
            if (normalizada.startsWith('/') || /^[A-Za-z]:\//.test(normalizada)) {
              errores.push(`worktrees.link[${indice}]: debe ser una ruta relativa`);
            } else if (normalizada.split('/').includes('..')) {
              errores.push(`worktrees.link[${indice}]: no puede contener '..'`);
            }
          });
        }
      }
      if (wt.setup !== undefined) {
        if (!Array.isArray(wt.setup)) {
          errores.push('worktrees.setup: debe ser un array de comandos');
        } else {
          wt.setup.forEach((comando, indice) => {
            if (typeof comando !== 'string') {
              errores.push(`worktrees.setup[${indice}]: debe ser un texto`);
            }
          });
        }
      }
    }
  }

  if (objeto.env !== undefined) {
    if (!esObjetoPlano(objeto.env)) {
      errores.push('env: debe ser un objeto');
    } else {
      for (const [clave, valor] of Object.entries(objeto.env)) {
        if (!esNombreVariableEnv(clave)) {
          errores.push(`env.${clave}: nombre de variable de entorno inválido`);
        }
        if (typeof valor !== 'string') {
          errores.push(`env.${clave}: el valor debe ser un texto`);
        }
      }
    }
  }

  if (objeto.resources !== undefined) {
    if (!esObjetoPlano(objeto.resources)) {
      errores.push('resources: debe ser un objeto');
    } else {
      for (const [nombre, recurso] of Object.entries(objeto.resources)) {
        const base = `resources.${nombre}`;
        if (nombre.trim() === '') errores.push('resources: el nombre del recurso no puede estar vacío');
        if (!esObjetoPlano(recurso)) {
          errores.push(`${base}: debe ser un objeto`);
          continue;
        }
        for (const clave of Object.keys(recurso)) {
          if (!CLAVES_RECURSO.has(clave)) errores.push(`${base}.${clave}: campo desconocido`);
        }
        if (!KINDS_RECURSO.has(recurso.kind)) {
          errores.push(`${base}.kind: kind inválido (permitido: postgres-db)`);
          continue; // sin kind válido no tiene sentido validar el resto
        }
        if (!esNombreVariableEnv(recurso.adminUrlEnv)) {
          errores.push(`${base}.adminUrlEnv: nombre de variable de entorno inválido`);
        }
        // `template` es OPCIONAL (sin él se crea una base vacía que la app migra por su cuenta).
        if (recurso.template !== undefined && (typeof recurso.template !== 'string' || recurso.template.trim() === '')) {
          errores.push(`${base}.template: debe ser un texto no vacío si se indica`);
        }
        if (typeof recurso.name !== 'string' || !recurso.name.includes('{job}')) {
          errores.push(`${base}.name: debe contener '{job}'`);
        } else if (!recurso.name.endsWith('_test')) {
          // Garantía de seguridad: nunca crear/borrar una base que no sea de test.
          errores.push(`${base}.name: debe terminar en _test`);
        }
        if (!esNombreVariableEnv(recurso.exportAs)) {
          errores.push(`${base}.exportAs: nombre de variable de entorno inválido`);
        }
      }
    }
  }

  if (objeto.accept !== undefined) {
    if (!esObjetoPlano(objeto.accept)) {
      errores.push('accept: debe ser un objeto');
    } else {
      for (const [clave, valor] of Object.entries(objeto.accept)) {
        if (typeof valor !== 'string') errores.push(`accept.${clave}: debe ser un texto`);
      }
    }
  }

  if (errores.length > 0) throw new ErrorDePerfil(errores);

  return {
    version: 1,
    name: objeto.name,
    baseBranch: objeto.baseBranch ?? 'main',
    integrationBranch: objeto.integrationBranch ?? 'staging',
    concurrency: objeto.concurrency ?? 3,
    protected: objeto.protected ? [...objeto.protected] : [],
    worktrees: {
      root: objeto.worktrees?.root ?? '~/work/{name}',
      link: objeto.worktrees?.link ? [...objeto.worktrees.link] : [],
      setup: objeto.worktrees?.setup ? [...objeto.worktrees.setup] : [],
    },
    env: objeto.env ? { ...objeto.env } : {},
    resources: objeto.resources
      ? Object.fromEntries(Object.entries(objeto.resources).map(([clave, valor]) => [clave, { ...valor }]))
      : {},
    accept: objeto.accept ? { ...objeto.accept } : {},
  };
}

/**
 * Carga un perfil desde texto JSON y lo valida.
 *
 * @param {string} texto contenido de `.opencode-orchestrator.json`
 * @param {{ nombreRepo?: string }} [opciones] si se indica `nombreRepo` y el
 *   perfil no trae `name`, se completa con él (útil al cargar por repo).
 * @returns {object} perfil normalizado
 * @throws {ErrorDePerfil} si el JSON es inválido o el perfil no valida
 */
export function cargarPerfil(texto, opciones = {}) {
  if (typeof texto !== 'string') {
    throw new ErrorDePerfil(['<raíz>: el perfil debe ser un texto JSON']);
  }
  let objeto;
  try {
    objeto = JSON.parse(texto);
  } catch (error) {
    throw new ErrorDePerfil([`<raíz>: JSON inválido (${error.message})`]);
  }

  if (
    esObjetoPlano(objeto) &&
    objeto.name === undefined &&
    opciones &&
    typeof opciones.nombreRepo === 'string'
  ) {
    objeto = { ...objeto, name: opciones.nombreRepo };
  }

  return validarPerfil(objeto);
}

/**
 * Perfil por defecto seguro (sin archivo de perfil en el repo).
 *
 * @param {string} [nombreRepo] nombre del repositorio
 * @returns {object} perfil con valores conservadores
 */
export function perfilPorDefecto(nombreRepo) {
  const nombre = typeof nombreRepo === 'string' && nombreRepo.trim() !== '' ? nombreRepo : 'repo';
  return {
    version: 1,
    name: nombre,
    baseBranch: 'main',
    integrationBranch: 'staging',
    concurrency: 3,
    protected: ['**/.env', '.opencode-orchestrator.json'],
    worktrees: { root: '~/work/{name}', link: [], setup: [] },
    env: {},
    resources: {},
    accept: {},
  };
}

/**
 * Resuelve la raíz de worktrees expandiendo '~' (home) y '{name}' (nombre del repo).
 *
 * @param {object} perfil perfil normalizado (o compatible)
 * @param {string} [home] home del usuario; por defecto `os.homedir()`
 * @returns {string} ruta absoluta con '/' como separador
 */
export function resolverRaizWorktrees(perfil, home = homedir()) {
  const raiz = perfil?.worktrees?.root ?? '~/work/{name}';
  const nombre = typeof perfil?.name === 'string' && perfil.name !== '' ? perfil.name : 'repo';
  const homeNormalizado = String(home).replace(/\\/g, '/').replace(/\/+$/, '');

  let resuelta = String(raiz).replace(/\{name\}/g, nombre);
  if (resuelta === '~') {
    resuelta = homeNormalizado;
  } else if (resuelta.startsWith('~/')) {
    resuelta = `${homeNormalizado}${resuelta.slice(1)}`;
  }
  return resuelta.replace(/\\/g, '/');
}
