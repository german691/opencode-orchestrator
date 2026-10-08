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
  'jobBase',
  'promptPrefix',
  'timeoutMs',
  'aceptacionTimeoutMs',
  'protected',
  'worktrees',
  'env',
  'resources',
  'accept',
]);

/** Campos permitidos dentro de `worktrees`. */
const CLAVES_WORKTREES = new Set(['root', 'link', 'linkConCopia', 'setup']);

/** Campos permitidos dentro de cada recurso. */
const CLAVES_RECURSO = new Set(['kind', 'adminUrlEnv', 'template', 'name', 'exportAs']);

/** Tipos de recurso soportados. */
const KINDS_RECURSO = new Set(['postgres-db']);

/** `name` del perfil: segmento de ruta seguro (se usa para armar directorios). */
const NOMBRE_SEGURO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** Largo máximo del texto fijo que el perfil antepone a cada tarea. */
const MAX_PROMPT_PREFIX = 20000;

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

  if (objeto.jobBase !== undefined && objeto.jobBase !== 'base' && objeto.jobBase !== 'integracion') {
    errores.push("jobBase: debe ser 'base' o 'integracion'");
  }
  if (objeto.promptPrefix !== undefined) {
    if (typeof objeto.promptPrefix !== 'string') errores.push('promptPrefix: debe ser un texto');
    else if (objeto.promptPrefix.length > MAX_PROMPT_PREFIX) {
      errores.push(`promptPrefix: máximo ${MAX_PROMPT_PREFIX} caracteres`);
    }
  }
  if (objeto.timeoutMs !== undefined) {
    if (!Number.isFinite(objeto.timeoutMs) || objeto.timeoutMs < 60_000 || objeto.timeoutMs > 6 * 3600_000) {
      errores.push('timeoutMs: debe ser un número de milisegundos entre 1 minuto y 6 horas');
    }
  }

  if (objeto.aceptacionTimeoutMs !== undefined) {
    if (!Number.isFinite(objeto.aceptacionTimeoutMs) || objeto.aceptacionTimeoutMs < 60_000 || objeto.aceptacionTimeoutMs > 6 * 3600_000) {
      errores.push('aceptacionTimeoutMs: debe ser un número de milisegundos entre 1 minuto y 6 horas');
    }
  }

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
      if (wt.linkConCopia !== undefined) {
        if (!Array.isArray(wt.linkConCopia)) {
          errores.push('worktrees.linkConCopia: debe ser un array de { dir, copiar }');
        } else {
          wt.linkConCopia.forEach((item, indice) => {
            const base = `worktrees.linkConCopia[${indice}]`;
            if (!esObjetoPlano(item) || typeof item.dir !== 'string' || item.dir.trim() === '') {
              errores.push(`${base}: debe ser { dir: texto, copiar: [textos] }`);
              return;
            }
            if (!Array.isArray(item.copiar) || item.copiar.length === 0 || item.copiar.some((c) => typeof c !== 'string' || c.trim() === '')) {
              errores.push(`${base}.copiar: debe ser un array no vacío de rutas`);
            }
            const rutas = [item.dir, ...(Array.isArray(item.copiar) ? item.copiar : [])]
              .filter((r) => typeof r === 'string')
              .map((r) => r.replace(/\\/g, '/'));
            if (rutas.some((r) => r.startsWith('/') || /^[A-Za-z]:\//.test(r) || r.split('/').includes('..'))) {
              errores.push(`${base}: las rutas deben ser relativas y sin '..'`);
            }
            if (Array.isArray(wt.link) && wt.link.includes(item.dir)) {
              errores.push(`${base}.dir: no puede estar también en worktrees.link`);
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
    // 'integracion': los trabajos parten de la rama de integración (ya con lo integrado antes),
    // no de la base, que solo avanza cuando el usuario decide.
    jobBase: objeto.jobBase ?? 'base',
    // Texto fijo del proyecto que se antepone a la tarea de cada trabajo (convenciones, etc.).
    promptPrefix: objeto.promptPrefix ?? '',
    // Tope total por defecto de un trabajo (si el envío no pide otro); null = el del servidor.
    timeoutMs: objeto.timeoutMs ?? null,
    aceptacionTimeoutMs: objeto.aceptacionTimeoutMs ?? null,
    protected: objeto.protected ? [...objeto.protected] : [],
    worktrees: {
      root: objeto.worktrees?.root ?? '~/work/{name}',
      link: objeto.worktrees?.link ? [...objeto.worktrees.link] : [],
      linkConCopia: objeto.worktrees?.linkConCopia ? objeto.worktrees.linkConCopia.map((x) => ({ dir: x.dir, copiar: [...x.copiar] })) : [],
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
    jobBase: 'base',
    promptPrefix: '',
    timeoutMs: null,
    aceptacionTimeoutMs: null,
    protected: ['**/.env', '.opencode-orchestrator.json'],
    worktrees: { root: '~/work/{name}', link: [], linkConCopia: [], setup: [] },
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
