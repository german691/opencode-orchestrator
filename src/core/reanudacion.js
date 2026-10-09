/**
 * REANUDACIÓN AUTOMÁTICA: decisión pura sobre un agente que murió por corte de
 * transporte (socket cerrado) después de haber hecho su trabajo.
 *
 * POR QUÉ: en vivo los agentes opencode mueren a los 10-16 min con
 * `Error: Transport: The socket connection was closed unexpectedly` (exit 130 o
 * corte por idle), casi siempre DESPUÉS de escribir lo suyo mientras corrían
 * tests largos. Hoy el orquestador humano retoma a mano con `desde_job` +
 * `solo_aceptacion`. Este módulo decide, sin tocar el sistema de archivos ni el
 * perfil, si conviene continuar (dejó cambios que verificar), relanzar (no dejó
 * nada) o no hacer nada, y redacta la advertencia para `resultado.advertencias`.
 *
 * Es lógica PURA a propósito: otro trabajo la conecta a gestor.js y al perfil.
 */

/** Marcas de un corte de transporte en stderr/stdout (el socket se cerró). */
export const FIRMAS_TRANSPORTE = [
  /Transport: The socket connection was closed unexpectedly/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /fetch failed/i,
  /UND_ERR_SOCKET/i,
  /other side closed/i,
];

/**
 * Solo se mira la COLA de la salida: un test largo puede imprimir la firma en
 * medio del ruido y lo que importa es cómo terminó la corrida.
 */
const TAMANO_COLA = 8 * 1024;

/** Relanzamientos por defecto cuando el perfil no dice cuántos permitir. */
const RELANZAMIENTOS_POR_DEFECTO = 1;

/** Tope duro de relanzamientos: más que esto es un bucle de fallos, no un corte. */
const MAX_RELANZAMIENTOS = 3;

/** Campos permitidos dentro de la sección `reanudacion` del perfil. */
const CLAVES_REANUDACION = new Set(['habilitado', 'maxRelanzamientos']);

/**
 * Cortes DELIBERADOS del servidor: aunque la salida contenga una firma de
 * transporte, no hay que reanudar (el corte fue una decisión nuestra, no una
 * caída: reanudar repetiría el mismo problema).
 */
const MOTIVOS_DELIBERADOS = new Set(['timeout', 'cancelado', 'alcance', 'sin_progreso']);

/**
 * Error de validación de la sección `reanudacion` del perfil. Acumula todos los
 * mensajes en `.errores`, igual que `ErrorDePerfil`, para verlos de una pasada.
 */
export class ErrorDeReanudacion extends Error {
  /**
   * @param {string[]} errores mensajes con la ruta del campo afectado
   */
  constructor(errores) {
    const lista = Array.isArray(errores) ? errores : [String(errores)];
    const cabecera = `Reanudación inválida (${lista.length} error${lista.length === 1 ? '' : 'es'})`;
    super(`${cabecera}:\n${lista.map((e) => `- ${e}`).join('\n')}`);
    this.name = 'ErrorDeReanudacion';
    /** @type {string[]} */
    this.errores = lista;
  }
}

/**
 * ¿Es un objeto JSON plano (no null, no array)?
 * @param {unknown} valor
 * @returns {boolean}
 */
function esObjetoPlano(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * Recorta un texto a su última ventana (o '' si no es texto).
 * @param {unknown} texto
 * @returns {string}
 */
function cola(texto) {
  if (typeof texto !== 'string' || texto === '') return '';
  return texto.length > TAMANO_COLA ? texto.slice(-TAMANO_COLA) : texto;
}

/**
 * ¿La firma de un corte de transporte aparece en la cola de stderr o stdout?
 * @param {unknown} stderr
 * @param {unknown} stdout
 * @returns {boolean}
 */
function hayFirmaDeTransporte(stderr, stdout) {
  const err = cola(stderr);
  const out = cola(stdout);
  return FIRMAS_TRANSPORTE.some((firma) => firma.test(err) || firma.test(out));
}

/**
 * ¿El proceso terminó de forma anormal? Un corte de transporte solo es
 * reanudable si además la salida del proceso no fue limpia: exit 130 (SIGINT de
 * la caída del socket), corte por idle, error interno, o cualquier código
 * distinto de cero.
 * @param {{ codigo?: number|null, motivo?: string }} fallo
 * @returns {boolean}
 */
function salidaAnormal({ codigo, motivo }) {
  if (codigo === 130) return true;
  if (motivo === 'idle' || motivo === 'error_interno') return true;
  return codigo != null && codigo !== 0;
}

/**
 * Detecta si un fallo de proceso fue un corte de transporte (socket) reanudable.
 *
 * @param {{ codigo?: number|null, motivo?: string, stderr?: string, stdout?: string }} [fallo]
 * @returns {boolean} true solo si la salida trae una firma de transporte Y el
 *   proceso terminó de forma anormal Y el corte no fue deliberado.
 */
export function esFalloDeTransporte({ codigo = null, motivo = null, stderr = '', stdout = '' } = {}) {
  // Los cortes deliberados del servidor nunca se reanudan, aunque la salida
  // contenga una firma (p. ej. el agente imprime un error de red de su test).
  if (MOTIVOS_DELIBERADOS.has(motivo)) return false;
  if (!hayFirmaDeTransporte(stderr, stdout)) return false;
  return salidaAnormal({ codigo, motivo });
}

/**
 * Decide qué hacer ante un posible fallo de transporte.
 *
 * @param {object} entrada
 * @param {{ codigo?: number|null, motivo?: string, stderr?: string, stdout?: string }} [entrada.fallo]
 * @param {boolean} [entrada.hayCambiosEnAlcance] el agente ya dejó cambios en `writes`
 * @param {number} [entrada.relanzamientosPrevios=0]
 * @param {{ habilitado?: boolean, maxRelanzamientos?: number }} [entrada.config] ya normalizada
 * @returns {{ accion: 'continuar'|'relanzar'|'ninguna', motivo: string }}
 */
export function decidirReanudacion({ fallo = {}, hayCambiosEnAlcance = false, relanzamientosPrevios = 0, config } = {}) {
  const habilitado = config?.habilitado !== false;
  const maxRelanzamientos = Number.isInteger(config?.maxRelanzamientos)
    ? config.maxRelanzamientos
    : RELANZAMIENTOS_POR_DEFECTO;

  if (!habilitado) return { accion: 'ninguna', motivo: 'reanudacion_deshabilitada' };
  if (!esFalloDeTransporte(fallo)) return { accion: 'ninguna', motivo: 'no_es_fallo_de_transporte' };

  // Con cambios ya escritos conviene continuar: el servidor verifica alcance y
  // aceptación sobre lo que el agente dejó, sin gastar otro intento del agente.
  if (hayCambiosEnAlcance) return { accion: 'continuar', motivo: 'hay_cambios_para_verificar' };

  const previos = Number.isInteger(relanzamientosPrevios) && relanzamientosPrevios >= 0 ? relanzamientosPrevios : 0;
  if (previos < maxRelanzamientos) return { accion: 'relanzar', motivo: 'sin_cambios_con_intentos_disponibles' };

  return { accion: 'ninguna', motivo: 'limite_de_relanzamientos_alcanzado' };
}

/**
 * Normaliza y valida la sección opcional `reanudacion` del perfil.
 *
 * @param {unknown} perfilReanudacion valor del perfil (puede faltar)
 * @returns {{ habilitado: boolean, maxRelanzamientos: number }}
 * @throws {ErrorDeReanudacion} si algún campo es inválido, con todos los errores
 */
export function configReanudacion(perfilReanudacion) {
  if (perfilReanudacion === undefined || perfilReanudacion === null) {
    return { habilitado: true, maxRelanzamientos: RELANZAMIENTOS_POR_DEFECTO };
  }
  if (!esObjetoPlano(perfilReanudacion)) {
    throw new ErrorDeReanudacion(['reanudacion: debe ser un objeto { habilitado, maxRelanzamientos }']);
  }

  /** @type {string[]} */
  const errores = [];
  for (const clave of Object.keys(perfilReanudacion)) {
    if (!CLAVES_REANUDACION.has(clave)) errores.push(`reanudacion.${clave}: campo desconocido`);
  }

  const habilitado = perfilReanudacion.habilitado ?? true;
  if (typeof habilitado !== 'boolean') errores.push('reanudacion.habilitado: debe ser un booleano');

  const maxRelanzamientos = perfilReanudacion.maxRelanzamientos ?? RELANZAMIENTOS_POR_DEFECTO;
  if (!Number.isInteger(maxRelanzamientos) || maxRelanzamientos < 0 || maxRelanzamientos > MAX_RELANZAMIENTOS) {
    errores.push(`reanudacion.maxRelanzamientos: debe ser un entero entre 0 y ${MAX_RELANZAMIENTOS}`);
  }

  if (errores.length > 0) throw new ErrorDeReanudacion(errores);
  return { habilitado, maxRelanzamientos };
}

/**
 * Minutos transcurridos desde el inicio del agente, o null si no se sabe.
 * @param {{ duracionMs?: number }} [fallo]
 * @returns {number|null}
 */
function minutosDe(fallo) {
  const ms = fallo?.duracionMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return Math.max(0, Math.round(ms / 60000));
}

/**
 * Redacta, en español, la advertencia para `resultado.advertencias` según la decisión.
 *
 * @param {{ accion: string, motivo: string }} decision
 * @param {{ duracionMs?: number }} [fallo]
 * @returns {string}
 */
export function textoAdvertencia(decision, fallo) {
  const minutos = minutosDe(fallo);
  const tras = minutos === null ? '' : ` tras ${minutos} min`;
  const accion = decision?.accion;
  if (accion === 'continuar') {
    return `REANUDADO: el agente murió por corte de transporte${tras}; se verificó alcance y aceptación sobre lo que dejó.`;
  }
  if (accion === 'relanzar') {
    return `RELANZADO: el agente murió por corte de transporte${tras} sin dejar cambios; se lanzó un intento nuevo.`;
  }
  return `SIN REANUDAR: ${decision?.motivo ?? 'no corresponde reanudar'}.`;
}
