/**
 * Historial de auditoría del panel: mezcla el registro global (`eventos.jsonl`)
 * con eventos RECONSTRUIDOS desde `job.json` para los trabajos anteriores a la
 * existencia del registro.
 *
 * POR QUÉ reconstruir: el registro de eventos se incorporó en la versión actual,
 * así que los trabajos viejos no tienen ninguna línea en `eventos.jsonl` y la
 * auditoría arrancaría vacía. Cada `job.json` guarda `creadoEn`, `inicioEn`,
 * `finEn`, `estado` y `motivoFin`, suficiente para sintetizar el ciclo de vida.
 *
 * POR QUÉ en un módulo aparte: la síntesis y el mezclado son funciones PURAS y
 * testeables, y la lectura de los `job.json` se cachea por mtime del directorio de
 * trabajos para no recorrerlos en cada petición del panel.
 *
 * Compatibilidad: los eventos reconstruidos se MARcan con `origen: 'reconstruido'`
 * (y se agrega `origen: 'registro'` a los reales); el resto de los campos es el
 * mismo formato que ya consumían `/api/eventos` y `/auditoria`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Origen de un evento en el historial mezclado. */
export const ORIGEN_REGISTRO = 'registro';
export const ORIGEN_RECONSTRUIDO = 'reconstruido';

/** Límite con el que se consulta el registro para saber qué trabajos ya tienen eventos. */
const LIMITE_REGISTRO = 100000;

/** Convierte un valor a número finito o `null` (los job.json viejos pueden traer basura). */
function numeroONull(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * Eventos sintetizados a partir de un `job.json`. Función PURA: no toca disco.
 *
 * Reglas:
 *  - `creadoEn`  -> `job.creado` (el trabajo quedó en cola);
 *  - `inicioEn`  -> `job.estado` `queued -> running` (momento en que arrancó);
 *  - `finEn`     -> `job.fin` con el `estado` final y el `motivoFin`.
 *
 * @param {object|null|undefined} job
 * @returns {object[]} eventos ordenados por fecha ascendente, marcados `origen`
 */
export function sintetizarEventos(job) {
  if (job === null || typeof job !== 'object') return [];
  const jobId = job.id;
  const eventos = [];
  const creado = numeroONull(job.creadoEn);
  const inicio = numeroONull(job.inicioEn);
  const fin = numeroONull(job.finEn);
  if (creado !== null) {
    eventos.push({ ts: creado, tipo: 'job.creado', jobId, estado: 'queued', origen: ORIGEN_RECONSTRUIDO });
  }
  if (inicio !== null) {
    eventos.push({
      ts: inicio,
      tipo: 'job.estado',
      jobId,
      anterior: 'queued',
      estado: 'running',
      origen: ORIGEN_RECONSTRUIDO,
    });
  }
  if (fin !== null) {
    eventos.push({
      ts: fin,
      tipo: 'job.fin',
      jobId,
      estado: job.estado,
      motivo: job.motivoFin ?? null,
      origen: ORIGEN_RECONSTRUIDO,
    });
  }
  return eventos;
}

/**
 * Filtra eventos por trabajo, tipo y rango de fechas. Función PURA.
 * @param {object[]} eventos
 * @param {{ jobId?: string, tipo?: string, desde?: number, hasta?: number }} [filtros]
 * @returns {object[]}
 */
export function filtrarEventos(eventos, { jobId, tipo, desde, hasta } = {}) {
  return (Array.isArray(eventos) ? eventos : []).filter((evento) => {
    if (jobId !== undefined && evento.jobId !== jobId) return false;
    if (tipo !== undefined && evento.tipo !== tipo) return false;
    if (desde !== undefined && !(evento.ts >= desde)) return false;
    if (hasta !== undefined && !(evento.ts <= hasta)) return false;
    return true;
  });
}

/**
 * Ordena una copia por fecha; `desc` (por defecto) deja lo más reciente primero.
 * Función PURA: no muta la entrada.
 * @param {object[]} eventos
 * @param {'asc'|'desc'} [orden]
 * @returns {object[]}
 */
export function ordenarEventos(eventos, orden = 'desc') {
  const copia = Array.isArray(eventos) ? [...eventos] : [];
  copia.sort((a, b) => (orden === 'asc' ? a.ts - b.ts : b.ts - a.ts));
  return copia;
}

/**
 * Mezcla eventos reales y reconstruidos aplicando filtros y límite. Función PURA.
 *
 * POR QUÉ se ordena DESPUÉS de mezclar: un evento reconstruido del pasado tiene
 * que intercalarse con los reales por fecha, no quedar agrupado al final.
 *
 * @param {object[]} registrados
 * @param {object[]} reconstruidos
 * @param {{ jobId?: string, tipo?: string, desde?: number, hasta?: number, limite?: number, orden?: 'asc'|'desc' }} [filtros]
 * @returns {object[]}
 */
export function mezclarEventos(registrados, reconstruidos, filtros = {}) {
  const { limite = 200, orden = 'desc' } = filtros;
  const reales = filtrarEventos(registrados, filtros).map((evento) => ({
    ...evento,
    origen: evento.origen ?? ORIGEN_REGISTRO,
  }));
  const sinteticos = filtrarEventos(reconstruidos, filtros);
  const unidos = ordenarEventos([...reales, ...sinteticos], orden);
  const tope = Number.isInteger(limite) && limite >= 0 ? limite : 200;
  return unidos.slice(0, tope);
}

/**
 * Eventos reconstruidos de los trabajos que NO tienen ningún evento real.
 * Función PURA: recibe el conjunto de ids ya presentes en el registro.
 * @param {object[]} trabajos
 * @param {Set<string>} idsConRegistro
 * @returns {object[]}
 */
export function reconstruirFaltantes(trabajos, idsConRegistro) {
  const eventos = [];
  for (const job of Array.isArray(trabajos) ? trabajos : []) {
    if (idsConRegistro && idsConRegistro.has(job?.id)) continue;
    eventos.push(...sintetizarEventos(job));
  }
  return eventos;
}

/** mtime en ms de una ruta; 0 si no existe (cachea también la ausencia). */
function mtimeMs(ruta) {
  try {
    return fs.statSync(ruta).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Crea el historial del panel sobre un directorio de estado.
 *
 * El registro real lo sigue leyendo `registro.listar`; aquí solo se decide qué
 * trabajos necesitan reconstrucción (los que NO tienen NINGÚN evento real) y se
 * mezclan ambos orígenes. Los `job.json` se cachean y solo se releen cuando cambia
 * el mtime del directorio de trabajos; el conjunto de trabajos con registro se
 * recalcula cuando cambia el mtime del `eventos.jsonl`.
 *
 * @param {object} opciones
 * @param {string} opciones.dirTrabajos directorio `jobs`
 * @param {string} [opciones.dirEstado] directorio de estado (para el mtime del registro)
 * @param {object|null} [opciones.registro] registro real; sin él no se reconstruye
 * @param {() => number} [opciones.ahora]
 * @returns {{ listar: (filtros?: object) => object[], titulos: () => Record<string,string>, total: (filtros?: object) => number }}
 */
export function crearHistorial({ dirTrabajos, dirEstado, registro = null, ahora = Date.now } = {}) {
  let cacheTrabajos = { mtime: NaN, trabajos: [] };
  let cacheRegistro = { mtime: NaN, ids: new Set() };

  /** Relee los `job.json` del directorio de trabajos solo si cambió su mtime. */
  function leerTrabajos() {
    const mtime = mtimeMs(dirTrabajos);
    if (mtime === cacheTrabajos.mtime) return cacheTrabajos.trabajos;
    let ids = [];
    try {
      ids = fs.readdirSync(dirTrabajos);
    } catch {
      ids = [];
    }
    const trabajos = [];
    for (const id of ids) {
      if (id.startsWith('.')) continue;
      try {
        const crudo = fs.readFileSync(path.join(dirTrabajos, id, 'job.json'), 'utf8');
        const job = JSON.parse(crudo);
        if (job !== null && typeof job === 'object' && !Array.isArray(job)) {
          trabajos.push(job.id === undefined ? { ...job, id } : job);
        }
      } catch {
        // job.json ausente o a medio escribir: se ignora como en el resto del panel
      }
    }
    cacheTrabajos = { mtime, trabajos };
    return trabajos;
  }

  /**
   * Conjunto de `jobId` que YA tienen al menos un evento real. Se recalcula al
   * cambiar el `eventos.jsonl`; sin registro queda vacío (nada que reconstruir).
   */
  function leerIdsConRegistro() {
    if (!registro) return new Set();
    const dir = dirEstado ?? '';
    // El registro rota a `eventos.1.jsonl`: hay que mirar los dos para invalidar.
    const mtime = Math.max(mtimeMs(path.join(dir, 'eventos.jsonl')), mtimeMs(path.join(dir, 'eventos.1.jsonl')));
    if (mtime === cacheRegistro.mtime) return cacheRegistro.ids;
    const ids = new Set();
    // Se pide un límite alto: con la rotación a 5 MB el registro nunca es enorme,
    // y así ningún jobId viejo queda afuera del conjunto.
    for (const evento of registro.listar({ limite: LIMITE_REGISTRO })) {
      if (evento && evento.jobId !== undefined) ids.add(evento.jobId);
    }
    cacheRegistro = { mtime, ids };
    return ids;
  }

  /**
   * Eventos reconstruidos de todos los trabajos sin registro. Sin registro
   * inyectado no se reconstruye nada: el panel avisa "no disponible" en su lugar.
   */
  function reconstruidos() {
    if (!registro) return [];
    return reconstruirFaltantes(leerTrabajos(), leerIdsConRegistro());
  }

  /**
   * Lista mezclada y filtrada, más reciente primero por defecto.
   * @param {object} [filtros]
   * @returns {object[]}
   */
  function listar({ jobId, tipo, desde, hasta, limite = 200, orden = 'desc' } = {}) {
    const registrados = registro
      ? registro.listar({ jobId, tipo, desde, hasta, limite, orden })
      : [];
    return mezclarEventos(registrados, reconstruidos(), { jobId, tipo, desde, hasta, limite, orden });
  }

  /** Total (sin límite) que satisface los filtros; se usa para saber si hay más páginas. */
  function total(filtros = {}) {
    return listar({ ...filtros, limite: Number.MAX_SAFE_INTEGER }).length;
  }

  /** Título legible por id de trabajo (para enlazar cada evento desde la tabla). */
  function titulos() {
    /** @type {Record<string,string>} */
    const mapa = {};
    for (const job of leerTrabajos()) {
      if (job && typeof job.id === 'string') mapa[job.id] = job.titulo || job.id;
    }
    return mapa;
  }

  return { listar, total, titulos };
}
