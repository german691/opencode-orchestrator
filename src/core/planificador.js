/**
 * Planificador (§5): decide, sin efectos secundarios, qué trabajos en cola pueden
 * arrancar en una pasada.
 *
 * POR QUÉ función pura: la decisión de concurrencia es la parte más delicada del
 * orquestador (evita pisadas y bloqueos). Mantenerla pura la hace testeable de
 * forma exhaustiva con tablas y sin procesos ni git.
 *
 * Reglas implementadas:
 *  - Cola FIFO con prioridad opcional (mayor prioridad primero; empate por llegada).
 *  - Tope de concurrencia: nunca devuelve más de `concurrencia - corriendo.length`.
 *  - Dependencias `after`: todas deben estar `succeeded`. Si alguna falló/rechazó/
 *    canceló/se perdió, el trabajo queda `bloqueado_por_dependencia`.
 *  - Conflictos de alcance (§5): un trabajo `isolation: none` con `writes` choca con
 *    cualquier trabajo del mismo repo que lea o escriba patrones superpuestos.
 *    Dos `worktree` cuyos `writes` se superponen se serializan (si
 *    `serializarEscrituras`, activo por defecto). Repos distintos no chocan.
 *  - Recursos con capacidad (`recursos`: nombre -> capacidad; ausente = 1, exclusivo).
 *  - Un trabajo que no puede arrancar no bloquea a los siguientes.
 *  - Anti-inanición: un trabajo listo que lleva más de `esperaMaximaMs` en cola
 *    reserva su lugar; ningún candidato con conflicto con él lo adelanta.
 */

import { gruposSeSuperponen } from './scope.js';

/** Estados de dependencia que impiden para siempre arrancar un trabajo. */
const ESTADOS_FALLIDOS = new Set(['failed', 'rejected', 'cancelled', 'lost']);

/**
 * Obtiene un trabajo de una colección que puede ser Map u objeto plano.
 * @param {Map<string, object>|Record<string, object>|undefined} trabajos
 * @param {string} id
 * @returns {object|undefined}
 */
function obtenerTrabajo(trabajos, id) {
  if (!trabajos) return undefined;
  if (trabajos instanceof Map) return trabajos.get(id);
  if (Object.prototype.hasOwnProperty.call(trabajos, id)) return trabajos[id];
  return undefined;
}

/**
 * Normaliza un descriptor de trabajo rellenando defaults coherentes.
 * @param {object|undefined} bruto
 * @param {string} id
 * @returns {object}
 */
function normalizarTrabajo(bruto, id) {
  const trabajo = bruto ?? {};
  return {
    id,
    repo: typeof trabajo.repo === 'string' ? trabajo.repo : '',
    mode: typeof trabajo.mode === 'string' ? trabajo.mode : 'safe',
    isolation: trabajo.isolation === 'none' ? 'none' : 'worktree',
    writes: Array.isArray(trabajo.writes) ? trabajo.writes : [],
    reads: Array.isArray(trabajo.reads) ? trabajo.reads : ['**'],
    resources: Array.isArray(trabajo.resources) ? trabajo.resources : [],
    after: Array.isArray(trabajo.after) ? trabajo.after : [],
    prioridad: Number.isFinite(trabajo.prioridad) ? trabajo.prioridad : 0,
    // `null` significa "no sabemos cuándo se encoló": no cuenta como veterano.
    encoladoEn: Number.isFinite(trabajo.encoladoEn) ? trabajo.encoladoEn : null,
    estado: trabajo.estado,
  };
}

/**
 * ¿El trabajo toma un bloqueo de escritura sobre el árbol real?
 * Solo `isolation: none` con `writes` no vacío (§5).
 * @param {object} trabajo normalizado
 * @returns {boolean}
 */
function bloqueaEscritura(trabajo) {
  return trabajo.isolation === 'none' && trabajo.writes.length > 0;
}

/**
 * ¿Dos trabajos entran en conflicto de alcance?
 *
 * @param {object} a trabajo normalizado
 * @param {object} b trabajo normalizado
 * @param {boolean} serializarEscrituras si se serializan writes solapados entre worktrees
 * @returns {boolean}
 */
function seChocan(a, b, serializarEscrituras) {
  if (a.repo !== b.repo) return false; // repos distintos: nunca chocan (§5)

  // Un escritor sobre el árbol real choca con cualquiera que lea o escriba encima.
  if (bloqueaEscritura(a) && gruposSeSuperponen(a.writes, [...b.reads, ...b.writes])) return true;
  if (bloqueaEscritura(b) && gruposSeSuperponen(b.writes, [...a.reads, ...a.writes])) return true;

  // Dos worktrees no se ven, pero si escriben lo mismo se serializan para no
  // romper la integración posterior.
  if (
    serializarEscrituras &&
    a.isolation === 'worktree' &&
    b.isolation === 'worktree' &&
    gruposSeSuperponen(a.writes, b.writes)
  ) {
    return true;
  }
  return false;
}

/**
 * Capacidad de un recurso (ausente = 1, es decir exclusivo).
 * @param {Record<string, number>} recursos
 * @param {string} nombre
 * @returns {number}
 */
function capacidadDe(recursos, nombre) {
  if (recursos && Object.prototype.hasOwnProperty.call(recursos, nombre)) {
    const capacidad = recursos[nombre];
    return Number.isFinite(capacidad) ? capacidad : 1;
  }
  return 1;
}

/**
 * ¿Queda hueco para todos los recursos que pide el trabajo?
 * @param {object} trabajo normalizado
 * @param {Map<string, number>} uso consumo actual (incluye los ya elegidos en la pasada)
 * @param {Record<string, number>} recursos capacidades declaradas
 * @returns {boolean}
 */
function recursosDisponibles(trabajo, uso, recursos) {
  /** @type {Map<string, number>} peticiones propias del trabajo en esta pasada */
  const propias = new Map();
  for (const nombre of trabajo.resources) {
    const capacidad = capacidadDe(recursos, nombre);
    const enUso = (uso.get(nombre) ?? 0) + (propias.get(nombre) ?? 0);
    if (enUso >= capacidad) return false;
    propias.set(nombre, (propias.get(nombre) ?? 0) + 1);
  }
  return true;
}

/**
 * Estado de una dependencia (`undefined` si no la conocemos).
 * @param {Map<string, object>|Record<string, object>|undefined} trabajos
 * @param {string} id
 * @returns {string|undefined}
 */
function estadoDependencia(trabajos, id) {
  return obtenerTrabajo(trabajos, id)?.estado;
}

/**
 * ¿Todas las dependencias `after` están `succeeded`?
 * @param {object} trabajo normalizado
 * @param {Map<string, object>|Record<string, object>|undefined} trabajos
 * @returns {boolean}
 */
function dependenciasListas(trabajo, trabajos) {
  return trabajo.after.every((dependencia) => estadoDependencia(trabajos, dependencia) === 'succeeded');
}

/**
 * ¿Alguna dependencia `after` terminó de forma irrecuperable?
 * @param {object} trabajo normalizado
 * @param {Map<string, object>|Record<string, object>|undefined} trabajos
 * @returns {boolean}
 */
function dependenciaBloqueada(trabajo, trabajos) {
  return trabajo.after.some((dependencia) => ESTADOS_FALLIDOS.has(estadoDependencia(trabajos, dependencia)));
}

/**
 * Calcula qué trabajos de la cola pueden arrancar AHORA.
 *
 * @param {object} entrada
 * @param {string[]} entrada.cola ids en orden de llegada (FIFO)
 * @param {string[]} entrada.corriendo ids que ya están corriendo
 * @param {number} entrada.concurrencia tope de trabajos simultáneos
 * @param {Map<string, object>|Record<string, object>} entrada.trabajos descriptores por id
 * @param {number} [entrada.ahora] instante actual (por defecto `Date.now()`)
 * @param {Record<string, number>} [entrada.recursos] capacidades por recurso
 * @param {boolean} [entrada.serializarEscrituras=true] serializar writes solapados entre worktrees
 * @param {number} [entrada.esperaMaximaMs=30000] umbral de anti-inanición
 * @returns {{ arrancar: string[], bloqueados: Array<{id: string, motivo: string}> }}
 * @throws {TypeError} si `cola` o `corriendo` no son arrays
 */
export function elegibles(entrada = {}) {
  const {
    cola,
    corriendo,
    concurrencia,
    trabajos,
    ahora,
    recursos = {},
    serializarEscrituras = true,
    esperaMaximaMs = 30000,
  } = entrada;

  if (!Array.isArray(cola)) throw new TypeError('cola debe ser un array de ids');
  if (!Array.isArray(corriendo)) throw new TypeError('corriendo debe ser un array de ids');

  const instante = Number.isFinite(ahora) ? ahora : Date.now();
  const tope = Number.isInteger(concurrencia) && concurrencia >= 0 ? concurrencia : 0;
  const libres = Math.max(0, tope - corriendo.length);

  // Trabajos que ya corren: consumen recursos y acotan el alcance disponible.
  const enCurso = corriendo.map((id) => normalizarTrabajo(obtenerTrabajo(trabajos, id), id));

  /** @type {Map<string, number>} recursos ocupados por los que ya corren */
  const uso = new Map();
  for (const trabajo of enCurso) {
    for (const nombre of trabajo.resources) uso.set(nombre, (uso.get(nombre) ?? 0) + 1);
  }

  // Candidatos ordenados por prioridad desc y, a igual prioridad, por llegada.
  const candidatos = cola.map((id, indice) => ({
    id,
    indice,
    trabajo: normalizarTrabajo(obtenerTrabajo(trabajos, id), id),
  }));
  candidatos.sort((a, b) => b.trabajo.prioridad - a.trabajo.prioridad || a.indice - b.indice);

  /** @type {Array<{id: string, motivo: string}>} */
  const bloqueados = [];
  /** @type {Set<string>} */
  const bloqueadosIds = new Set();

  // Clasificamos cada candidato: bloqueado (dep fallida), esperando (dep pendiente) o listo.
  const listos = new Set();
  for (const candidato of candidatos) {
    if (dependenciaBloqueada(candidato.trabajo, trabajos)) {
      bloqueados.push({ id: candidato.id, motivo: 'bloqueado_por_dependencia' });
      bloqueadosIds.add(candidato.id);
    } else if (dependenciasListas(candidato.trabajo, trabajos)) {
      listos.add(candidato.id);
    }
  }

  // Reserva anti-inanición: solo entre los listos que llevan demasiado esperando.
  /** @type {Set<string>} */
  const veteranos = new Set();
  for (const candidato of candidatos) {
    if (!listos.has(candidato.id)) continue;
    const encoladoEn = candidato.trabajo.encoladoEn;
    if (encoladoEn !== null && instante - encoladoEn > esperaMaximaMs) {
      veteranos.add(candidato.id);
    }
  }

  /** @type {Map<string, object>} descriptores por id, para consultar a los veteranos */
  const porId = new Map(candidatos.map((c) => [c.id, c.trabajo]));

  /** @type {string[]} */
  const arrancar = [];
  /** @type {object[]} descriptores ya elegidos en esta pasada */
  const elegidos = [];

  for (const candidato of candidatos) {
    if (arrancar.length >= libres) break; // no quedan huecos
    if (bloqueadosIds.has(candidato.id)) continue;
    if (!listos.has(candidato.id)) continue; // dependencias aún pendientes

    // Anti-inanición: no adelantar a un veterano con el que chocamos.
    let chocaConVeterano = false;
    for (const idVeterano of veteranos) {
      if (idVeterano === candidato.id) continue;
      const trabajoVeterano = porId.get(idVeterano);
      if (trabajoVeterano && seChocan(candidato.trabajo, trabajoVeterano, serializarEscrituras)) {
        chocaConVeterano = true;
        break;
      }
    }
    if (chocaConVeterano) continue;

    if (!recursosDisponibles(candidato.trabajo, uso, recursos)) continue;

    const chocaConCurso = enCurso.some((trabajo) => seChocan(candidato.trabajo, trabajo, serializarEscrituras));
    const chocaConElegido = elegidos.some((trabajo) => seChocan(candidato.trabajo, trabajo, serializarEscrituras));
    if (chocaConCurso || chocaConElegido) continue;

    arrancar.push(candidato.id);
    elegidos.push(candidato.trabajo);
    veteranos.delete(candidato.id);
    for (const nombre of candidato.trabajo.resources) {
      uso.set(nombre, (uso.get(nombre) ?? 0) + 1);
    }
  }

  // Los bloqueados se reportan en orden de cola para que el listado sea estable.
  bloqueados.sort((a, b) => cola.indexOf(a.id) - cola.indexOf(b.id));
  return { arrancar, bloqueados };
}
