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
 *  - Topes de concurrencia: uno GLOBAL (`concurrencia`) y uno POR REPO por trabajo
 *    (`concurrenciaRepo`, el `concurrency` de su perfil). Nunca arranca más de los que
 *    permiten ambos; el motivo reportado es `tope_global` o `tope_del_repo` (el global
 *    gana: si los dos están llenos, se informa `tope_global`).
 *  - Antigüedad con `encoladoEn` para la anti-inanición.
 *  - Dependencias `after`: todas deben estar `succeeded` (o `merged`, que es un
 *    `succeeded` ya integrado: mismo efecto para el dependiente). Si alguna
 *    falló/rechazó/canceló/se perdió, el trabajo queda
 *    `bloqueado_por_dependencia`.
 *  - Conflictos de alcance (§5): un trabajo `isolation: none` con `writes` choca con
 *    cualquier trabajo del mismo repo que lea o escriba patrones superpuestos.
 *    Dos `worktree` cuyos `writes` se superponen se serializan (si
 *    `serializarEscrituras`, activo por defecto). Repos distintos no chocan.
 *  - Recursos con capacidad (`recursos`: nombre -> capacidad; ausente = 1, exclusivo).
 *  - Un trabajo que no puede arrancar no bloquea a los siguientes.
 *  - Anti-inanición: un trabajo listo que lleva más de `esperaMaximaMs` en cola
 *    reserva su lugar; ningún candidato que choque con él (alcance O recursos)
 *    lo adelanta.
 */

import { gruposSeSuperponen } from './scope.js';

/** Estados de dependencia que impiden para siempre arrancar un trabajo. */
const ESTADOS_FALLIDOS = new Set(['failed', 'rejected', 'cancelled', 'lost']);

/**
 * Estados que SATISFACEN una dependencia `after`. `merged` se incluye a propósito:
 * es un `succeeded` que ya se integró (§3), y para quien depende de él el efecto es
 * el mismo. Exigir 'succeeded' exacto dejaría al dependiente esperando para siempre.
 * @type {ReadonlySet<string>}
 */
const ESTADOS_SATISFECHOS = new Set(['succeeded', 'merged']);

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
    // Opt-in del perfil: esperar a que se integren los trabajos que solapan sus writes.
    esperarIntegracion: trabajo.esperarIntegracion === true,
    // Tope de trabajos simultáneos POR REPO (el `concurrency` del perfil del trabajo).
    // `null` = sin tope por repo: solo rige el tope global.
    concurrenciaRepo: Number.isInteger(trabajo.concurrenciaRepo) && trabajo.concurrenciaRepo > 0 ? trabajo.concurrenciaRepo : null,
  };
}

/**
 * Ids de trabajos `succeeded` (sin integrar) del mismo repo cuyos `writes` se solapan
 * con los del candidato.
 *
 * POR QUÉ existe: con `esperarIntegracion` el trabajo no debe partir de una base que
 * quedará obsoleta en cuanto el anterior se integre (hoy arranca apenas el anterior
 * termina y el conflicto aparece recién en el merge). `merged` no cuenta: ya está
 * integrado y no deja la base atrás.
 *
 * @param {object} trabajo trabajo normalizado
 * @param {Map<string, object>|Record<string, object>|undefined} trabajos
 * @returns {string[]} ids que lo frenan (ordenados)
 */
function trabajosSucceededSolapados(trabajo, trabajos) {
  if (trabajo.writes.length === 0) return [];
  const ids = [];
  const entradas = trabajos instanceof Map ? trabajos.entries() : Object.entries(trabajos ?? {});
  for (const [id, bruto] of entradas) {
    if (!bruto || typeof bruto !== 'object') continue;
    const otro = normalizarTrabajo(bruto, id);
    if (otro.id === trabajo.id) continue;
    if (otro.repo !== trabajo.repo) continue;
    if (otro.estado !== 'succeeded') continue;
    if (otro.writes.length === 0) continue;
    if (gruposSeSuperponen(trabajo.writes, otro.writes)) ids.push(otro.id);
  }
  return ids.sort();
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
 * ¿Dos trabajos piden algún recurso con el mismo nombre?
 *
 * POR QUÉ importa para la anti-inanición: dos trabajos que comparten un recurso
 * compiten por la misma capacidad; si uno es un veterano bloqueado, dejar pasar al
 * otro puede dejarlo sin hueco indefinidamente.
 *
 * @param {object} a trabajo normalizado
 * @param {object} b trabajo normalizado
 * @returns {boolean}
 */
function comparteRecurso(a, b) {
  if (a.resources.length === 0 || b.resources.length === 0) return false;
  for (const recurso of a.resources) {
    if (b.resources.includes(recurso)) return true;
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
 * ¿Todas las dependencias `after` están satisfechas?
 *
 * `succeeded` y `merged` cuentan por igual: un trabajo ya integrado es un
 * `succeeded` que cumplió su parte. El resto de estados (incluidos los pendientes
 * como `queued`/`running`) no satisfacen la dependencia.
 *
 * @param {object} trabajo trabajo normalizado
 * @param {Map<string, object>|Record<string, object>|undefined} trabajos
 * @returns {boolean}
 */
function dependenciasListas(trabajo, trabajos) {
  return trabajo.after.every((dependencia) => ESTADOS_SATISFECHOS.has(estadoDependencia(trabajos, dependencia)));
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
 * @param {number} entrada.concurrencia tope GLOBAL de trabajos simultáneos
 * @param {Map<string, object>|Record<string, object>} entrada.trabajos descriptores por id
 *   (cada uno puede traer `concurrenciaRepo`, su tope por repositorio)
 * @param {number} [entrada.ahora] instante actual (por defecto `Date.now()`)
 * @param {Record<string, number>} [entrada.recursos] capacidades por recurso
 * @param {boolean} [entrada.serializarEscrituras=true] serializar writes solapados entre worktrees
 * @param {number} [entrada.esperaMaximaMs=30000] umbral de anti-inanición
 * @returns {{ arrancar: string[], bloqueados: Array<{id: string, motivo: string}>, esperas: Map<string, {motivo: string, por: string[]}> }}
 *   `esperas` explica POR QUÉ cada trabajo en cola no arrancó (motivo + ids de los que lo frenan):
 *   sin esto el listado solo dice "queued" y no hay forma de saber a quién se espera.
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
  // Tope GLOBAL (servidor). Cada trabajo trae además su tope por repo (`concurrenciaRepo`).
  const topeGlobal = Number.isInteger(concurrencia) && concurrencia >= 0 ? concurrencia : 0;

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

  /** @type {Map<string, {motivo: string, por: string[]}>} motivo de espera de cada trabajo en cola */
  const esperas = new Map();

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

  // `esperarIntegracion` (opt-in): un candidato que solapa writes con un trabajo
  // `succeeded` aún sin integrar espera a que lo integren en vez de partir de una base
  // que quedará obsoleta (el conflicto aparecería recién en el merge).
  for (const candidato of candidatos) {
    if (!listos.has(candidato.id) || !candidato.trabajo.esperarIntegracion) continue;
    const bloqueadores = trabajosSucceededSolapados(candidato.trabajo, trabajos);
    if (bloqueadores.length > 0) {
      listos.delete(candidato.id);
      esperas.set(candidato.id, { motivo: 'esperando_integracion', por: bloqueadores });
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
  /** @type {Map<string, number>} posición en el orden de arranque (prioridad y llegada) */
  const posicion = new Map(candidatos.map((c, i) => [c.id, i]));

  /** @type {string[]} */
  const arrancar = [];
  /** @type {object[]} descriptores ya elegidos en esta pasada */
  const elegidos = [];
  for (const candidato of candidatos) {
    if (esperas.has(candidato.id)) continue; // ya tiene un motivo (p. ej. esperando_integracion)
    if (bloqueadosIds.has(candidato.id) || listos.has(candidato.id)) continue;
    const pendientes = candidato.trabajo.after.filter((dep) => !ESTADOS_SATISFECHOS.has(estadoDependencia(trabajos, dep)));
    esperas.set(candidato.id, { motivo: 'dependencia', por: pendientes });
  }

  for (const candidato of candidatos) {
    if (bloqueadosIds.has(candidato.id)) continue;
    if (!listos.has(candidato.id)) continue; // dependencias aún pendientes

    // 1) Tope global: si ya hay `topeGlobal` corriendo o elegidos, no hay hueco. Se
    //    comprueba ANTES del tope por repo para que el global gane como motivo.
    const ocupadosGlobal = corriendo.length + arrancar.length;
    if (ocupadosGlobal >= topeGlobal) {
      esperas.set(candidato.id, { motivo: 'tope_global', por: [...corriendo, ...arrancar] });
      continue;
    }

    // 2) Tope por repo: cada repo admite a lo sumo su `concurrency` de perfil. Un trabajo
    //    sin `concurrenciaRepo` (null) solo está limitado por el global.
    const repoDelCandidato = candidato.trabajo.repo;
    const topeRepo = candidato.trabajo.concurrenciaRepo;
    if (topeRepo !== null) {
      const enRepo = enCurso.filter((t) => t.repo === repoDelCandidato);
      const elegidosRepo = elegidos.filter((t) => t.repo === repoDelCandidato);
      if (enRepo.length + elegidosRepo.length >= topeRepo) {
        esperas.set(candidato.id, {
          motivo: 'tope_del_repo',
          por: [...enRepo, ...elegidosRepo].map((t) => t.id),
        });
        continue;
      }
    }

    // Anti-inanición: no adelantar a un veterano con el que chocamos, ya sea por
    // alcance de archivos o porque ambos compiten por el mismo recurso.
    let chocaConVeterano = false;
    let idFrenaVeterano = null;
    for (const idVeterano of veteranos) {
      if (idVeterano === candidato.id) continue;
      // Un veterano frena siempre a los que NO son veteranos (de eso trata la
      // anti-inanición), pero entre veteranos manda el orden de arranque: uno solo
      // frena a los que están DETRÁS de él. Si frenara también a los de adelante, dos
      // veteranos que chocan entre sí se bloquearían mutuamente para siempre (cola
      // estancada con cero trabajos corriendo, observado en vivo): el primer
      // veterano del orden siempre debe poder arrancar.
      if (veteranos.has(candidato.id) && posicion.get(idVeterano) > posicion.get(candidato.id)) continue;
      const trabajoVeterano = porId.get(idVeterano);
      if (!trabajoVeterano) continue;
      if (
        seChocan(candidato.trabajo, trabajoVeterano, serializarEscrituras) ||
        comparteRecurso(candidato.trabajo, trabajoVeterano)
      ) {
        chocaConVeterano = true;
        idFrenaVeterano = idVeterano;
        break;
      }
    }
    if (chocaConVeterano) {
      esperas.set(candidato.id, { motivo: 'veterano_adelante', por: [idFrenaVeterano] });
      continue;
    }

    if (!recursosDisponibles(candidato.trabajo, uso, recursos)) {
      const pedidos = new Set(candidato.trabajo.resources);
      const por = [...enCurso, ...elegidos].filter((t) => t.resources.some((r) => pedidos.has(r))).map((t) => t.id);
      esperas.set(candidato.id, { motivo: 'recurso', por });
      continue;
    }

    const frenan = [...enCurso, ...elegidos].filter((trabajo) => seChocan(candidato.trabajo, trabajo, serializarEscrituras));
    if (frenan.length > 0) {
      esperas.set(candidato.id, { motivo: 'solapa_alcance', por: frenan.map((t) => t.id) });
      continue;
    }

    arrancar.push(candidato.id);
    elegidos.push(candidato.trabajo);
    veteranos.delete(candidato.id);
    esperas.delete(candidato.id);
    for (const nombre of candidato.trabajo.resources) {
      uso.set(nombre, (uso.get(nombre) ?? 0) + 1);
    }
  }

  // Los bloqueados se reportan en orden de cola para que el listado sea estable.
  bloqueados.sort((a, b) => cola.indexOf(a.id) - cola.indexOf(b.id));
  return { arrancar, bloqueados, esperas };
}
