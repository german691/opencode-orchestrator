/**
 * Identidad git con la que el servidor firma los commits NUEVOS (§8, §11).
 *
 * POR QUÉ existe: si el proceso no define `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, git
 * firma con la identidad del usuario del sistema (p. ej. `root@host.localdomain`).
 * GitHub nunca cuenta esos commits como contribuciones del dueño del repo. Acá se
 * resuelve UNA identidad por repositorio (perfil > `git config` > fallback) y se
 * traduce a las variables de entorno que git entiende.
 *
 * POR QUÉ se cachea por repo con TTL: un trabajo commitea y luego integra (varias
 * invocaciones de git); leer `git config` en cada una agrega procesos. El TTL corto
 * permite que un cambio de identidad se refleje sin reiniciar el servidor.
 */

import { execFileSync } from 'node:child_process';

/** Tiempo que sobrevive una identidad ya resuelta (ms). */
const CACHE_TTL_MS = 60_000;

/** Identidad de último recurso cuando ni el perfil ni el repo definen una. */
const IDENTIDAD_FALLBACK = Object.freeze({
  nombre: 'opencode-orchestrator',
  email: 'orquestador@localhost',
});

/** Resolución por repo: `repo -> { identidad, expira }`. */
const cacheIdentidades = new Map();

/** Error de identidad git inválida. */
export class ErrorDeIdentidad extends Error {
  /**
   * @param {string} mensaje
   */
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorDeIdentidad';
  }
}

/**
 * ¿El texto trae algo que rompería el bloque de identidad de git?
 *
 * POR QUÉ: un salto de línea parte la cabecera del commit en dos, y `<`/`>`
 * rompen el formato `Nombre <email>` volviendo la identidad ilegible.
 * @param {string} texto
 * @returns {boolean}
 */
function tieneCaracteresIlegales(texto) {
  return /[\r\n]/.test(texto) || texto.includes('<') || texto.includes('>');
}

/**
 * Valida una identidad y la devuelve tal cual (sin normalizar).
 * @param {{ nombre?: unknown, email?: unknown }} identidad
 * @returns {{ nombre: string, email: string }}
 * @throws {ErrorDeIdentidad}
 */
export function validarIdentidad({ nombre, email } = {}) {
  if (typeof nombre !== 'string' || nombre.trim() === '') {
    throw new ErrorDeIdentidad('nombre de la identidad git debe ser un texto no vacío');
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new ErrorDeIdentidad('email de la identidad git debe ser un texto no vacío');
  }
  if (tieneCaracteresIlegales(nombre)) {
    throw new ErrorDeIdentidad("nombre de la identidad git no puede tener saltos de línea ni '<' o '>'");
  }
  if (tieneCaracteresIlegales(email)) {
    throw new ErrorDeIdentidad("email de la identidad git no puede tener saltos de línea ni '<' o '>'");
  }
  return { nombre, email };
}

/** ¿La identidad pasa la validación? (sin lanzar) */
function esIdentidadValida(identidad) {
  try {
    validarIdentidad(identidad);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lee una clave de `git config` del repo. Devuelve '' si no está o si git falla.
 *
 * POR QUÉ `-c safe.directory=<repo>`: si el repo es de otro usuario git se niega a
 * leer su config; la excepción puntual evita depender del entorno del servidor.
 * @param {string} repo
 * @param {string} clave
 * @returns {string}
 */
function leerConfig(repo, clave) {
  try {
    return execFileSync(
      'git',
      ['-c', `safe.directory=${repo}`, '-C', repo, 'config', '--get', clave],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    // Sin config, repo inexistente o timeout: se trata como ausente.
    return '';
  }
}

/**
 * Identidad declarada por el repo (`user.name`/`user.email`), o `null` si falta o
 * es inválida (una identidad con `<`/saltos no debe propagarse).
 * @param {string} repo
 * @returns {{ nombre: string, email: string } | null}
 */
function identidadDelRepo(repo) {
  const candidata = { nombre: leerConfig(repo, 'user.name'), email: leerConfig(repo, 'user.email') };
  return esIdentidadValida(candidata) ? candidata : null;
}

/**
 * Resuelve la identidad git de un repo con la prioridad: perfil > `git config` > fallback.
 * @param {{ repo?: string, perfilAutor?: { nombre?: string, email?: string } | null }} [opciones]
 * @returns {{ nombre: string, email: string, origen: 'perfil' | 'git' | 'fallback' }}
 * @throws {ErrorDeIdentidad} si `perfilAutor` viene inválido o falta el repo sin perfil
 */
export function resolverIdentidad({ repo, perfilAutor } = {}) {
  if (perfilAutor !== undefined && perfilAutor !== null) {
    // El perfil se validó al cargarlo; igualmente se revalida para no firmar con basura.
    return { ...validarIdentidad(perfilAutor), origen: 'perfil' };
  }
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new ErrorDeIdentidad('resolverIdentidad necesita un repo si no hay perfilAutor');
  }
  const ahora = Date.now();
  const cacheada = cacheIdentidades.get(repo);
  if (cacheada && cacheada.expira > ahora) return cacheada.identidad;

  const delRepo = identidadDelRepo(repo);
  const identidad = delRepo
    ? { ...delRepo, origen: 'git' }
    : { ...IDENTIDAD_FALLBACK, origen: 'fallback' };
  cacheIdentidades.set(repo, { identidad, expira: ahora + CACHE_TTL_MS });
  return identidad;
}

/**
 * Traduce una identidad a las variables que git lee para autor y committer.
 * @param {{ nombre: string, email: string }} identidad
 * @returns {{ GIT_AUTHOR_NAME: string, GIT_AUTHOR_EMAIL: string, GIT_COMMITTER_NAME: string, GIT_COMMITTER_EMAIL: string }}
 * @throws {ErrorDeIdentidad}
 */
export function variablesDeGit(identidad) {
  const { nombre, email } = validarIdentidad(identidad);
  return {
    GIT_AUTHOR_NAME: nombre,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: nombre,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Vacía la caché de identidades. Solo para tests: aísla casos que reconfiguran un repo.
 * @returns {void}
 */
export function limpiarCacheIdentidad() {
  cacheIdentidades.clear();
}
