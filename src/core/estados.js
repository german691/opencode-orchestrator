/**
 * Máquina de estados de un trabajo (§3).
 *
 * POR QUÉ: el ciclo de vida es la espina dorsal del servidor: qué se puede
 * cancelar, qué se puede integrar y cuándo se sellan las marcas de tiempo debe
 * ser determinista y estar en un solo lugar. Un estado inválido jamás debe
 * "colarse": `transicionar` lanza si la transición no está permitida.
 *
 * Flujo normal: queued -> provisioning -> running -> verifying -> succeeded,
 * con `merged` como paso posterior de un `succeeded`. Un trabajo puede terminar
 * además en failed, cancelled, rejected (violó alcance/aceptación) o lost
 * (el servidor se reinició y el proceso ya no existe).
 */

/**
 * Todos los estados conocidos, en orden de ciclo de vida.
 * @type {readonly string[]}
 */
export const ESTADOS = Object.freeze([
  'queued',
  'provisioning',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
  'lost',
  'merged',
]);

/**
 * Estados sin salida. `succeeded` se considera terminal para el proceso (no se
 * puede cancelar ni volver atrás), aunque se permite `succeeded -> merged` como
 * acción administrativa posterior a la integración.
 * @type {ReadonlySet<string>}
 */
const TERMINALES = new Set(['succeeded', 'failed', 'cancelled', 'rejected', 'lost', 'merged']);

/**
 * Tabla de transiciones permitidas. Toda transición que no figure aquí es un error.
 * Incluye la regla "cualquier estado no terminal puede ir a cancelled o lost".
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const TRANSICIONES = Object.freeze({
  queued: Object.freeze(['provisioning', 'cancelled', 'lost']),
  provisioning: Object.freeze(['running', 'failed', 'cancelled', 'lost']),
  running: Object.freeze(['verifying', 'failed', 'cancelled', 'lost']),
  verifying: Object.freeze(['succeeded', 'failed', 'rejected', 'cancelled', 'lost']),
  succeeded: Object.freeze(['merged']),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  rejected: Object.freeze([]),
  lost: Object.freeze([]),
  merged: Object.freeze([]),
});

/**
 * ¿El estado es terminal (el trabajo ya no "corre")?
 * @param {string} estado
 * @returns {boolean}
 */
export function esTerminal(estado) {
  return TERMINALES.has(estado);
}

/**
 * ¿Se permite la transición `desde -> hacia`?
 * @param {string} desde
 * @param {string} hacia
 * @returns {boolean}
 */
export function puedeTransicionar(desde, hacia) {
  const permitidas = TRANSICIONES[desde];
  return Array.isArray(permitidas) && permitidas.includes(hacia);
}

/**
 * Aplica una transición al trabajo y sella marcas de tiempo sin pisar las que ya
 * existan.
 *
 *  - `creadoEn`: se rellena si falta (alta del trabajo).
 *  - `inicioEn`: se sella al entrar en `running`.
 *  - `finEn`   : se sella al entrar en cualquier estado terminal.
 *
 * @template {{ estado: string, creadoEn?: number, inicioEn?: number, finEn?: number }} T
 * @param {T} trabajo trabajo a mutar (se devuelve el mismo objeto)
 * @param {string} hacia estado destino
 * @param {number} [ahora] marca de tiempo a usar (por defecto `Date.now()`)
 * @returns {T} el mismo trabajo
 * @throws {TypeError} si `trabajo` no es un objeto
 * @throws {Error} si el origen/destino no existe o la transición es inválida
 */
export function transicionar(trabajo, hacia, ahora = Date.now()) {
  if (trabajo === null || typeof trabajo !== 'object') {
    throw new TypeError('transicionar espera un objeto de trabajo');
  }
  const desde = trabajo.estado;
  if (!Object.prototype.hasOwnProperty.call(TRANSICIONES, desde)) {
    throw new Error(`Estado de origen desconocido: ${desde}`);
  }
  if (!Object.prototype.hasOwnProperty.call(TRANSICIONES, hacia)) {
    throw new Error(`Estado destino desconocido: ${hacia}`);
  }
  if (!puedeTransicionar(desde, hacia)) {
    throw new Error(
      `Transición inválida: ${desde} -> ${hacia} (permitidas: ${TRANSICIONES[desde].join(', ') || 'ninguna'})`,
    );
  }

  if (trabajo.creadoEn === undefined || trabajo.creadoEn === null) {
    trabajo.creadoEn = ahora;
  }
  trabajo.estado = hacia;
  if (hacia === 'running' && (trabajo.inicioEn === undefined || trabajo.inicioEn === null)) {
    trabajo.inicioEn = ahora;
  }
  if (esTerminal(hacia) && (trabajo.finEn === undefined || trabajo.finEn === null)) {
    trabajo.finEn = ahora;
  }
  return trabajo;
}
