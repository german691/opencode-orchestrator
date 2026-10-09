/**
 * Revisor automático: lógica pura del agente interno de SOLO LECTURA que contrasta
 * el diff de un trabajo `safe` exitoso con la tarea y las reglas del proyecto.
 *
 * POR QUÉ un módulo aparte y sin efectos: acá solo se normaliza la configuración,
 * se arma el prompt y se interpreta la respuesta. Conectar el revisor (lanzarlo con
 * el runner, guardar `resultado.revision`, mostrarlo en la herramienta) es de otro
 * trabajo; mantener la lógica pura permite probarla sin procesos ni repos.
 *
 * Decisión de robustez: el prompt SIEMPRE incluye los datos (tarea, alcance,
 * archivos, diff, reglas) y el formato exigido, aun cuando el perfil aporte una
 * `plantilla`. La plantilla solo reemplaza el encabezado de rol: así una plantilla
 * mal escrita nunca deja al parser sin la línea que sabe leer.
 */

/** Largo máximo (en bytes) del bloque de tarea original, por legibilidad del prompt. */
export const MAX_TAREA_BYTES = 6 * 1024;

/** Tope por defecto del diff incluido en el prompt (configurable por perfil). */
export const MAX_DIFF_POR_DEFECTO = 60_000;

/** Rango válido de `revisor.maxDiffBytes`. */
export const MIN_DIFF_BYTES = 5_000;
export const MAX_DIFF_BYTES = 300_000;

/** Campos permitidos en la sección `revisor` del perfil. */
const CLAVES_REVISOR = new Set(['habilitado', 'modelo', 'maxDiffBytes', 'reglas', 'prompt']);

/**
 * Error de validación de la sección `revisor`. Acumula todos los mensajes con la
 * ruta del campo, igual que `ErrorDePerfil`, para que el usuario los vea de una vez.
 */
export class ErrorDeRevisor extends Error {
  /**
   * @param {string[]} errores mensajes con la ruta del campo afectado
   */
  constructor(errores) {
    const lista = Array.isArray(errores) ? errores : [String(errores)];
    const cabecera = `Sección revisor inválida (${lista.length} error${lista.length === 1 ? '' : 'es'})`;
    super(`${cabecera}:\n${lista.map((e) => `- ${e}`).join('\n')}`);
    this.name = 'ErrorDeRevisor';
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
 * Normaliza la sección opcional `revisor` del perfil.
 *
 * Ausente o `null` equivale a la configuración por defecto (revisor apagado): el
 * orquestador solo gasta un agente extra si el perfil lo pide explícitamente.
 * Se rechazan campos desconocidos porque un typo (`model` por `modelo`) dejaría
 * la validación silenciosamente inactiva.
 *
 * @param {unknown} perfilRevisor valor de `revisor` en el perfil (opcional)
 * @returns {{habilitado: boolean, modelo: string|null, maxDiffBytes: number, reglas: string[], prompt: string|null}}
 * @throws {ErrorDeRevisor} con todos los errores acumulados
 */
export function configRevisor(perfilRevisor) {
  if (perfilRevisor === undefined || perfilRevisor === null) {
    return {
      habilitado: false,
      modelo: null,
      maxDiffBytes: MAX_DIFF_POR_DEFECTO,
      reglas: [],
      prompt: null,
    };
  }

  const errores = [];
  if (!esObjetoPlano(perfilRevisor)) {
    throw new ErrorDeRevisor(['revisor: debe ser un objeto']);
  }

  for (const clave of Object.keys(perfilRevisor)) {
    if (!CLAVES_REVISOR.has(clave)) errores.push(`revisor.${clave}: campo desconocido`);
  }

  const habilitado = perfilRevisor.habilitado;
  if (habilitado !== undefined && typeof habilitado !== 'boolean') {
    errores.push('revisor.habilitado: debe ser true o false');
  }

  const modelo = perfilRevisor.modelo;
  if (modelo !== undefined && (typeof modelo !== 'string' || modelo.trim() === '')) {
    errores.push('revisor.modelo: debe ser un texto no vacío');
  }

  const maxDiffBytes = perfilRevisor.maxDiffBytes;
  if (maxDiffBytes !== undefined) {
    if (!Number.isInteger(maxDiffBytes) || maxDiffBytes < MIN_DIFF_BYTES || maxDiffBytes > MAX_DIFF_BYTES) {
      errores.push(
        `revisor.maxDiffBytes: debe ser un entero entre ${MIN_DIFF_BYTES} y ${MAX_DIFF_BYTES}`,
      );
    }
  }

  const reglas = perfilRevisor.reglas;
  if (reglas !== undefined) {
    if (!Array.isArray(reglas)) {
      errores.push('revisor.reglas: debe ser un array de textos');
    } else {
      reglas.forEach((regla, indice) => {
        if (typeof regla !== 'string' || regla.trim() === '') {
          errores.push(`revisor.reglas[${indice}]: debe ser un texto no vacío`);
        }
      });
    }
  }

  const prompt = perfilRevisor.prompt;
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.trim() === '')) {
    errores.push('revisor.prompt: debe ser un texto no vacío');
  }

  if (errores.length > 0) throw new ErrorDeRevisor(errores);

  return {
    habilitado: habilitado === true,
    modelo: modelo === undefined ? null : modelo,
    maxDiffBytes: maxDiffBytes === undefined ? MAX_DIFF_POR_DEFECTO : maxDiffBytes,
    reglas: reglas === undefined ? [] : [...reglas],
    prompt: prompt === undefined ? null : prompt,
  };
}

/**
 * Recorta un texto a `maxBytes` bytes UTF-8 sin partir un carácter multibyte y,
 * si recortó algo, agrega el aviso con la cantidad de bytes omitidos.
 *
 * @param {unknown} texto
 * @param {number} maxBytes
 * @param {string} etiqueta texto del aviso, p. ej. 'diff truncado'
 * @returns {string}
 */
function truncarConAviso(texto, maxBytes, etiqueta) {
  const cadena = typeof texto === 'string' ? texto : '';
  const bytes = Buffer.byteLength(cadena, 'utf8');
  if (bytes <= maxBytes) return cadena;

  const buffer = Buffer.from(cadena, 'utf8');
  let corte = Math.max(0, maxBytes);
  // Un byte de continuación (10xxxxxx) pertenece a un carácter que empezó antes del
  // corte: retrocedemos para no emitir UTF-8 inválido.
  while (corte > 0 && (buffer[corte] & 0xc0) === 0x80) corte -= 1;
  const recorte = buffer.subarray(0, corte).toString('utf8');
  const omitidos = bytes - Buffer.byteLength(recorte, 'utf8');
  return `${recorte}\n[${etiqueta}: ${omitidos} bytes omitidos]`;
}

/**
 * Convierte una lista de textos en viñetas, o en el texto alternativo si está vacía.
 * @param {unknown} valores
 * @param {string} alternativo
 * @returns {string}
 */
function listar(valores, alternativo) {
  if (!Array.isArray(valores) || valores.length === 0) return alternativo;
  return valores.map((valor) => `- ${valor}`).join('\n');
}

/** Encabezado de rol por defecto (una plantilla del perfil lo reemplaza). */
const ENCABEZADO_POR_DEFECTO =
  'Sos el REVISOR AUTOMÁTICO de un trabajo de código ya terminado. ' +
  'Contrastás el diff con la tarea y las reglas del proyecto y devolvés un veredicto corto. ' +
  'NO modificás archivos, NO ejecutás comandos y NO proponés reescrituras largas: solo señalás lo que falta o está mal.';

/** Orden de revisión exigido, siempre presente para que el agente no lo saltee. */
const ORDEN_REVISION = [
  'Reglas de revisión, en este orden:',
  'a) ¿Cumple lo pedido en la tarea?',
  'b) ¿Hay tests nuevos o ajustados y pueden fallar si se revierte el cambio?',
  'c) ¿Algo toca archivos fuera del alcance declarado?',
  'd) ¿Respeta las convenciones de las reglas del proyecto?',
  'e) ¿Hay bugs evidentes?',
].join('\n');

/** Formato de respuesta exigido, siempre presente para que el parser tenga qué leer. */
const FORMATO_EXIGIDO = [
  'Formato de respuesta (ESTRICTO):',
  'La PRIMERA línea debe ser exactamente `VEREDICTO: APRUEBA` o `VEREDICTO: OBSERVA`.',
  'Si el veredicto es OBSERVA, agregá hasta 5 líneas que empiecen con `- `, cada una con qué falta o está mal (con archivo:línea cuando puedas).',
  'No agregues nada más: ni introducción, ni cierre, ni bloques de código.',
].join('\n');

/**
 * Arma el prompt en español para el revisor de solo lectura.
 *
 * POR QUÉ se truncan la tarea y el diff: el revisor es un agente acotado; un diff de
 * miles de líneas o una tarea pegada entera diluyen el foco y encarecen el trabajo.
 * El aviso de truncado deja constancia de que la revisión es sobre una porción.
 *
 * @param {object} [entrada]
 * @param {string} [entrada.tarea] tarea original (se trunca a 6 KB)
 * @param {string[]} [entrada.writes] alcance declarado
 * @param {string} [entrada.diff] diff del trabajo
 * @param {string[]} [entrada.archivos] archivos cambiados
 * @param {string[]} [entrada.reglas] reglas del proyecto
 * @param {string} [entrada.plantilla] encabezado propio; reemplaza el rol por defecto
 * @param {number} [entrada.maxDiffBytes] tope del diff (default 60000)
 * @returns {string}
 */
export function construirPromptRevision(entrada = {}) {
  const {
    tarea = '',
    writes = [],
    diff = '',
    archivos = [],
    reglas = [],
    plantilla,
    maxDiffBytes = MAX_DIFF_POR_DEFECTO,
  } = entrada;

  const topeDiff = Number.isInteger(maxDiffBytes) && maxDiffBytes > 0 ? maxDiffBytes : MAX_DIFF_POR_DEFECTO;
  const encabezado =
    typeof plantilla === 'string' && plantilla.trim() !== '' ? plantilla.trim() : ENCABEZADO_POR_DEFECTO;

  const secciones = [
    encabezado,
    `TAREA ORIGINAL:\n${truncarConAviso(tarea, MAX_TAREA_BYTES, 'tarea truncada')}`,
    `ALCANCE DECLARADO (writes):\n${listar(writes, '(sin alcance declarado)')}`,
    `ARCHIVOS CAMBIADOS:\n${listar(archivos, '(sin archivos cambiados)')}`,
    `DIFF:\n${truncarConAviso(diff, topeDiff, 'diff truncado')}`,
    `REGLAS DEL PROYECTO:\n${listar(reglas, '(sin reglas adicionales)')}`,
    ORDEN_REVISION,
    FORMATO_EXIGIDO,
  ];

  return secciones.join('\n\n');
}

/** Cantidad máxima de observaciones aceptadas. */
const MAX_OBSERVACIONES = 5;

/** Largo máximo de cada observación. */
const MAX_OBSERVACION_CHARS = 300;

/** Largo máximo del texto crudo guardado. */
const MAX_CRUDO_CHARS = 1000;

/**
 * Interpreta la respuesta del revisor.
 *
 * POR QUÉ tolerante: el agente puede envolver la respuesta en un bloque de código,
 * poner el veredicto en negrita, escribir en minúsculas o agregar texto antes. Solo
 * exigimos reconocer la etiqueta `VEREDICTO: APRUEBA|OBSERVA` en alguna línea; si no
 * aparece, devolvemos INDETERMINADO con el crudo para que un humano decida, en vez
 * de inventar un veredicto.
 *
 * @param {unknown} texto respuesta del revisor
 * @returns {{veredicto: 'APRUEBA'|'OBSERVA'|'INDETERMINADO', observaciones: string[], crudo: string}}
 */
export function parsearVeredicto(texto) {
  const bruto = typeof texto === 'string' ? texto : texto === null || texto === undefined ? '' : String(texto);
  const crudo = bruto.slice(0, MAX_CRUDO_CHARS);
  const lineas = bruto.split(/\r?\n/);

  let indiceVeredicto = -1;
  let veredicto = 'INDETERMINADO';
  for (let i = 0; i < lineas.length; i += 1) {
    const encontrado = lineas[i].match(/veredicto\s*:\s*(aprueba|observa)\b/i);
    if (encontrado) {
      indiceVeredicto = i;
      veredicto = encontrado[1].toUpperCase();
      break;
    }
  }

  const observaciones = [];
  const desde = indiceVeredicto === -1 ? 0 : indiceVeredicto + 1;
  for (let i = desde; i < lineas.length && observaciones.length < MAX_OBSERVACIONES; i += 1) {
    const linea = lineas[i].trim();
    if (!linea.startsWith('-')) continue;
    const contenido = linea.replace(/^-\s*/, '').trim();
    if (contenido === '') continue;
    observaciones.push(contenido.slice(0, MAX_OBSERVACION_CHARS));
  }

  return { veredicto, observaciones, crudo };
}

/**
 * Resume una revisión en 1 a 6 líneas, para `resultado.revision` y para el resumen
 * de la herramienta MCP. El tope de 6 sale de 1 encabezado + 5 observaciones.
 *
 * @param {{veredicto?: string, observaciones?: string[]}} [revision]
 * @returns {string}
 */
export function resumenRevision(revision) {
  const veredicto = revision?.veredicto ?? 'INDETERMINADO';
  const observaciones = Array.isArray(revision?.observaciones) ? revision.observaciones.slice(0, MAX_OBSERVACIONES) : [];
  const lineas = [`Revisión automática: ${veredicto}`];

  if (veredicto === 'OBSERVA') {
    if (observaciones.length === 0) lineas.push('- (sin detalle)');
    else for (const observacion of observaciones) lineas.push(`- ${observacion}`);
  } else if (veredicto === 'INDETERMINADO') {
    lineas.push('No se pudo interpretar la respuesta del revisor.');
  }

  return lineas.join('\n');
}

/**
 * ¿Corresponde lanzar el revisor para este trabajo?
 *
 * Solo en modo `safe`, con el revisor habilitado en el perfil y sobre un trabajo
 * que terminó `succeeded` y dejó archivos (un `solo_aceptacion` no corre al agente
 * ni commitea, así que no hay diff que revisar).
 *
 * @param {object} [entrada]
 * @param {string} [entrada.modo] modo del trabajo
 * @param {string|object} [entrada.estado] estado del trabajo o el propio trabajo
 * @param {{habilitado?: boolean}} [entrada.config] configuración normalizada del revisor
 * @param {string[]} [entrada.archivos] archivos que el trabajo commiteó
 * @param {boolean} [entrada.soloAceptacion]
 * @param {boolean} [entrada.solo_aceptacion]
 * @returns {boolean}
 */
export function debeRevisar(entrada = {}) {
  const { modo, estado, config, archivos } = entrada;

  if (modo !== 'safe') return false;
  if (!esObjetoPlano(config) || config.habilitado !== true) return false;

  const trabajo = esObjetoPlano(estado) ? estado : null;
  const estadoTexto = typeof estado === 'string' ? estado : trabajo?.estado;
  if (estadoTexto !== 'succeeded') return false;

  const soloAceptacion =
    entrada.soloAceptacion === true || entrada.solo_aceptacion === true || trabajo?.soloAceptacion === true;
  if (soloAceptacion) return false;

  return Array.isArray(archivos) && archivos.length > 0;
}
