/**
 * Formato de texto de los resultados que ve el orquestador (Claude).
 *
 * POR QUÉ texto estructurado y corto: el resultado entra al contexto del modelo.
 * Se prioriza lo que permite decidir (estado, qué cambió, violaciones, aceptación)
 * y el final de la salida; el resto se consulta con `opencode_logs`.
 */

import { esTerminal } from '../core/estados.js';
import { parametrosDeReceta } from '../core/recetas.js';

/** Máximo de archivos que se listan en línea. */
const MAX_ARCHIVOS = 40;

/** Topes por defecto de la salida compacta (ahorro de contexto del orquestador). */
const LIMITE_LINEAS_SALIDA = 40;
const LIMITE_LINEAS_STDERR = 15;
const LIMITE_LINEAS_ACEPTACION = 40;
const LIMITE_COINCIDENCIAS = 15;

/** Líneas que delatan un fallo: se muestran primero al recortar un log de aceptación. */
const RE_FALLO = /✖|✗|not ok|FAIL|Error|AssertionError/;

/** Duración legible: 1h 02m 03s. */
export function duracion(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Últimas `tope` líneas de un texto, con un aviso de lo omitido.
 * POR QUÉ por líneas y no por caracteres: lo que interesa de un log de agente es su
 * desenlace (las últimas líneas), y una sola línea kilométrica no debe comerse el cupo.
 * @param {unknown} texto
 * @param {number} tope
 * @returns {string}
 */
function ultimasLineas(texto, tope) {
  const lineas = String(texto ?? '').replace(/\s+$/, '').split(/\r?\n/);
  if (lineas.length <= tope) return lineas.join('\n');
  return `[... ${lineas.length - tope} líneas omitidas ...]\n${lineas.slice(-tope).join('\n')}`;
}

/**
 * Quita los bloques de subtests que PASARON (`ok N - ...`) junto con sus líneas de
 * detalle, que solo agregan ruido cuando se resume un log de aceptación fallido.
 * @param {string[]} lineas
 * @returns {string[]}
 */
function sinSubtestOk(lineas) {
  const resultado = [];
  let sangriaOmitida = null;
  for (const linea of lineas) {
    const sangria = linea.length - linea.trimStart().length;
    if (sangriaOmitida !== null) {
      if (linea.trim() === '' || sangria > sangriaOmitida) continue; // detalle del bloque omitido
      sangriaOmitida = null;
    }
    if (/^\s*ok\b/.test(linea)) {
      sangriaOmitida = sangria;
      continue;
    }
    resultado.push(linea);
  }
  return resultado;
}

/**
 * Recorta un log de aceptación fallido: primero las líneas que casan el patrón de
 * fallo (hasta `topeCoincidencias`) y luego las últimas `topeLineas`, sin repetir.
 * @param {unknown} texto
 * @param {{ topeLineas: number, topeCoincidencias: number }} opciones
 * @returns {string}
 */
function lineasPrioritarias(texto, { topeLineas, topeCoincidencias }) {
  const sinOk = sinSubtestOk(String(texto ?? '').split(/\r?\n/));
  const indices = [];
  const yaEsta = new Set();
  sinOk.forEach((linea, indice) => {
    if (indices.length >= topeCoincidencias) return;
    if (RE_FALLO.test(linea)) {
      indices.push(indice);
      yaEsta.add(indice);
    }
  });
  for (let indice = Math.max(0, sinOk.length - topeLineas); indice < sinOk.length; indice += 1) {
    if (!yaEsta.has(indice)) {
      indices.push(indice);
      yaEsta.add(indice);
    }
  }
  return indices.map((i) => sinOk[i]).join('\n');
}

const TEXTO_ESPERA = {
  dependencia: 'espera a que terminen sus dependencias (after)',
  concurrencia: 'tope de concurrencia alcanzado',
  recurso: 'espera un recurso compartido (p. ej. la base de datos)',
  solapa_alcance: 'sus `writes` se solapan con el trabajo en curso',
  veterano_adelante: 'otro trabajo más antiguo con el que choca va primero',
  esperando_integracion: 'esperando la integración de otro trabajo con el que comparte writes',
};

/**
 * Por qué un trabajo en cola todavía no arrancó ("" si no hay dato).
 * @param {{ espera?: { motivo: string, por?: string[] } | null }} trabajo
 * @returns {string}
 */
export function describirEspera(trabajo) {
  const espera = trabajo?.espera;
  if (!espera) return '';
  const por = espera.por?.length ? ` [${espera.por.join(', ')}]` : '';
  return `${TEXTO_ESPERA[espera.motivo] ?? espera.motivo}${por}`;
}

/**
 * Mensaje para un trabajo que sigue activo tras la espera de la llamada.
 * @param {object} trabajo
 * @param {number} [ahora]
 * @returns {string}
 */
export function describirActivo(trabajo, ahora = Date.now()) {
  const edad = duracion(ahora - (trabajo.creadoEn ?? ahora));
  const espera = describirEspera(trabajo);
  return (
    `STILL RUNNING | job_id=${trabajo.id} | estado=${trabajo.estado} | edad=${edad} | tarea="${trabajo.titulo ?? ''}"\n` +
    (espera ? `En cola porque: ${espera}\n` : '') +
    'No es un error: opencode sigue trabajando en segundo plano. Llamá a opencode_wait con este job_id ' +
    '(repetí hasta que diga finished), opencode_logs para ver el avance u opencode_cancel para detenerlo.'
  );
}

/**
 * Descripción completa de un trabajo terminado.
 *
 * @param {object} trabajo
 * @param {{ salida?: string, errores?: string }} [colas] final de stdout/stderr
 * @param {{ completo?: boolean }} [opciones] `completo: true` desactiva los topes de
 *   líneas (recupera toda la salida); por defecto se recorta para ahorrar contexto
 * @returns {string}
 */
export function describirTerminado(trabajo, colas = {}, { completo = false } = {}) {
  const r = trabajo.resultado ?? {};
  const encabezado = [
    `job_id=${trabajo.id} (finished)`,
    `estado=${trabajo.estado}`,
    `modo=${trabajo.mode}`,
    `aislamiento=${trabajo.isolation}`,
    `duracion=${duracion((trabajo.finEn ?? Date.now()) - (trabajo.inicioEn ?? trabajo.creadoEn ?? 0))}`,
    trabajo.motivoFin ? `motivo=${trabajo.motivoFin}` : null,
    r.proceso?.exit !== undefined && r.proceso?.exit !== null ? `exit=${r.proceso.exit}` : null,
  ].filter(Boolean);

  const partes = [encabezado.join(' | ')];
  if (trabajo.titulo) partes.push(`tarea: ${trabajo.titulo}`);
  if (trabajo.rama) partes.push(`rama: ${trabajo.rama}${r.commit ? `  commit: ${r.commit}` : '  (sin commit)'}`);
  if (trabajo.worktree) partes.push(`worktree: ${trabajo.worktree}${trabajo.limpiado ? ' (limpiado)' : ''}`);
  if (trabajo.error) partes.push(`error: ${trabajo.error}`);
  // Auto-integración: el trabajo safe ya quedó en la rama de integración sin que el
  // orquestador llamara a opencode_merge (opt-in del perfil).
  if (r.autoIntegrado === true) {
    partes.push(`integrado automáticamente${r.autoIntegradoEn ? ` en ${r.autoIntegradoEn}` : ''}`);
  }

  if (Array.isArray(r.archivos)) {
    const lista = r.archivos.slice(0, MAX_ARCHIVOS).join(', ');
    const extra = r.archivos.length > MAX_ARCHIVOS ? ` (+${r.archivos.length - MAX_ARCHIVOS} más)` : '';
    partes.push(`archivos modificados (${r.archivos.length}): ${lista || '(ninguno)'}${extra}`);
  }
  if (Array.isArray(r.violaciones) && r.violaciones.length > 0) {
    partes.push(
      `VIOLACIONES DE ALCANCE (${r.violaciones.length}) - el trabajo NO se integra:\n` +
        r.violaciones.slice(0, MAX_ARCHIVOS).map((v) => `  - ${v.ruta}: ${v.motivo}`).join('\n'),
    );
  }
  // Resumen compacto de las mutaciones declaradas por el agente (`.orq/mutaciones.json`).
  if (r.mutaciones && Number.isFinite(r.mutaciones.detectadas)) {
    const detalle = Array.isArray(r.mutaciones.detalle) ? r.mutaciones.detalle : [];
    const aplicables = detalle.length > 0
      ? detalle.filter((d) => d.estado === 'detectada' || d.estado === 'no_detectada').length
      : r.mutaciones.total;
    partes.push(`mutaciones: ${r.mutaciones.detectadas}/${aplicables} detectadas`);
  }
  // Revisor automático: una línea con el veredicto y hasta 5 observaciones.
  if (r.revision && typeof r.revision.veredicto === 'string') {
    partes.push(`revisión: ${r.revision.veredicto}`);
    for (const observacion of (Array.isArray(r.revision.observaciones) ? r.revision.observaciones : []).slice(0, 5)) {
      partes.push(`  - ${observacion}`);
    }
  }
  if (Array.isArray(r.advertencias) && r.advertencias.length > 0) {
    partes.push(`ADVERTENCIAS:\n${r.advertencias.map((a) => `  - ${a}`).join('\n')}`);
  }
  if (r.aceptacion?.ejecutada) {
    const ok = r.aceptacion.exit === 0 && r.aceptacion.motivo === 'exit';
    partes.push(`aceptacion: ${ok ? 'OK' : 'FALLO'} (exit=${r.aceptacion.exit}) $ ${r.aceptacion.cmd}`);
    // Primero QUÉ falló (bloque de fallos extraído); el final del stdout solo si no se reconoció ninguno.
    // Por defecto se recorta a las últimas 40 líneas con las coincidencias de fallo primero.
    if (!ok && r.aceptacion.fallos) {
      const log = completo
        ? r.aceptacion.fallos
        : lineasPrioritarias(r.aceptacion.fallos, { topeLineas: LIMITE_LINEAS_ACEPTACION, topeCoincidencias: LIMITE_COINCIDENCIAS });
      partes.push(`--- fallos de la aceptacion ---\n${log}`);
    } else if (!ok && r.aceptacion.cola) {
      const log = completo
        ? r.aceptacion.cola
        : lineasPrioritarias(r.aceptacion.cola, { topeLineas: LIMITE_LINEAS_ACEPTACION, topeCoincidencias: LIMITE_COINCIDENCIAS });
      partes.push(`--- salida de la aceptacion ---\n${log}`);
    }
  }
  if (colas.salida) {
    const salida = completo ? String(colas.salida).trim() : ultimasLineas(colas.salida, LIMITE_LINEAS_SALIDA);
    partes.push(`--- salida de opencode (final) ---\n${salida}`);
  }
  if (colas.errores) {
    const errores = completo ? String(colas.errores).trim() : ultimasLineas(colas.errores, LIMITE_LINEAS_STDERR);
    partes.push(`--- stderr (final) ---\n${errores}`);
  }
  // Recuperar todo lo recortado con opencode_logs (o con `completo: true`).
  if (!completo && (colas.salida || colas.errores || r.aceptacion?.ejecutada)) {
    partes.push(`(salida completa: opencode_logs job_id=${trabajo.id})`);
  }
  return partes.join('\n');
}

/**
 * Listado de trabajos en texto.
 * @param {object[]} trabajos
 * @param {{ concurrencia: number, corriendo: string[], enCola: string[] }} resumen
 * @param {number} [ahora]
 * @returns {string}
 */
export function describirListado(trabajos, resumen, ahora = Date.now()) {
  const cabecera = `concurrencia=${resumen.concurrencia} | corriendo=${resumen.corriendo.length} | en cola=${resumen.enCola.length}`;
  if (trabajos.length === 0) return `${cabecera}\n(sin trabajos)`;
  const filas = trabajos.map((t) => {
    const activo = !esTerminal(t.estado);
    const edad = duracion((activo ? ahora : t.finEn ?? ahora) - (t.creadoEn ?? ahora));
    const alcance = t.writes?.length ? ` writes=[${t.writes.join(',')}]` : '';
    const espera = describirEspera(t);
    return `job_id=${t.id} | ${t.estado}${t.motivoFin ? `(${t.motivoFin})` : ''} | ${activo ? 'edad' : 'duracion'}=${edad} | ${t.mode}/${t.isolation}${alcance}${espera ? ` | espera: ${espera}` : ''} | "${t.titulo ?? ''}"`;
  });
  return `${cabecera}\n${filas.join('\n')}`;
}

/**
 * Perfil resuelto en texto legible.
 * @param {{ repo: string, archivo: string, existe: boolean, perfil: object }} info
 * @returns {string}
 */
export function describirPerfil({ repo, archivo, existe, perfil }) {
  const lineas = [
    `repo: ${repo}`,
    existe ? `perfil: ${archivo}` : `perfil: (sin archivo; valores por defecto seguros. Creá ${archivo} para personalizarlo)`,
  ];
  // Las recetas llegan al orquestador con sus parámetros requeridos ya calculados:
  // sin esto tendría que deducir los placeholders del prompt a mano.
  const recetas = perfil?.recetas ?? {};
  const nombres = Object.keys(recetas);
  if (nombres.length > 0) {
    lineas.push(`recetas (${nombres.length}):`);
    for (const nombre of nombres) {
      const requeridos = parametrosDeReceta(recetas[nombre]);
      const detalle = requeridos.length > 0 ? `params: ${requeridos.join(', ')}` : 'sin parámetros';
      const descripcion = typeof recetas[nombre]?.descripcion === 'string' && recetas[nombre].descripcion !== ''
        ? ` - ${recetas[nombre].descripcion}`
        : '';
      lineas.push(`  - ${nombre}: ${detalle}${descripcion}`);
    }
  }
  lineas.push(JSON.stringify(perfil, null, 2));
  return lineas.join('\n');
}

/** Máximo de líneas de la tabla de estado (cabe en el contexto del orquestador). */
const MAX_LINEAS_ESTADO = 25;

/** Título máximo en la tabla de estado. */
const MAX_TITULO_ESTADO = 60;

/**
 * Tabla compacta del estado del servidor: contadores, una línea por trabajo activo o
 * `succeeded` sin integrar, y al final los ids que faltan mergear.
 *
 * POR QUÉ compacta y con tope: es la herramienta de sondeo rápido; debe entrar en el
 * contexto sin repetir lo que `opencode_list` ya detalla.
 *
 * @param {object} opciones
 * @param {object[]} [opciones.trabajos] trabajos (más recientes primero)
 * @param {{ concurrencia?: number, corriendo?: string[], enCola?: string[] }} [opciones.resumen]
 * @param {number} [opciones.ahora]
 * @returns {string}
 */
export function describirEstado({ trabajos = [], resumen = {}, ahora = Date.now() } = {}) {
  const corriendo = Array.isArray(resumen.corriendo) ? resumen.corriendo.length : 0;
  const enCola = Array.isArray(resumen.enCola) ? resumen.enCola.length : 0;
  const verificando = trabajos.filter((t) => t.estado === 'verifying').length;
  const lineas = [`corriendo=${corriendo} | en cola=${enCola} | verificando=${verificando}`];

  const visibles = trabajos.filter((t) => !esTerminal(t.estado) || t.estado === 'succeeded');
  // El tope total incluye cabecera y línea final: se reserva una línea para el aviso
  // de truncado cuando hay más trabajos de los que entran.
  const presupuesto = MAX_LINEAS_ESTADO - 2;
  const truncados = Math.max(0, visibles.length - presupuesto);
  const mostrados = truncados > 0 ? visibles.slice(0, presupuesto - 1) : visibles;
  for (const trabajo of mostrados) {
    const activo = !esTerminal(trabajo.estado);
    const edad = duracion((activo ? ahora : trabajo.finEn ?? ahora) - (trabajo.creadoEn ?? ahora));
    lineas.push(`${trabajo.id} | ${trabajo.estado} | ${edad} | ${truncarTexto(trabajo.titulo ?? '', MAX_TITULO_ESTADO)}`);
  }
  if (truncados > 0) lineas.push(`… (+${truncados} más)`);

  const sinIntegrar = trabajos.filter((t) => t.estado === 'succeeded').map((t) => t.id);
  lineas.push(`sin integrar: ${sinIntegrar.length > 0 ? sinIntegrar.join(', ') : '(ninguno)'}`);
  return lineas.join('\n');
}

/** Tope de caracteres de un valor al listar el pizarrón (los detalles van con `clave`). */
const MAX_VALOR_PIZARRON = 200;

/** Recorta un texto a `n` caracteres agregando un aviso si se pasó. */
function truncarTexto(texto, n) {
  const cadena = typeof texto === 'string' ? texto : String(texto);
  return cadena.length > n ? `${cadena.slice(0, n)}…` : cadena;
}

/** Serializa un valor JSON del pizarrón en una sola línea, recortado. */
function valorCompacto(valor) {
  let texto;
  try {
    texto = JSON.stringify(valor);
  } catch {
    texto = String(valor);
  }
  if (texto === undefined) texto = String(valor);
  return truncarTexto(texto, MAX_VALOR_PIZARRON);
}

/**
 * Vista compacta del pizarrón sin clave: versión, claves vigentes (valor truncado) y
 * las últimas 5 notas. POR QUÉ compacta: entra al contexto del orquestador.
 * @param {object} doc documento del pizarrón (`leer()`)
 * @returns {string}
 */
export function describirPizarronLista(doc) {
  const claves = Object.keys(doc?.claves ?? {});
  const lineas = [`pizarrón v${doc?.version ?? 0} | claves=${claves.length}`];
  if (claves.length === 0) {
    lineas.push('(sin claves todavía)');
  } else {
    for (const clave of claves) {
      const entrada = doc.claves[clave] ?? {};
      lineas.push(`${clave} = ${valorCompacto(entrada.valor)}${entrada.jobId ? `  [${entrada.jobId}]` : ''}`);
    }
  }
  const notas = Array.isArray(doc?.notas) ? doc.notas.slice(-5) : [];
  if (notas.length > 0) {
    lineas.push('últimas notas:');
    for (const nota of notas) {
      const autor = nota?.jobId ? `${nota.jobId}: ` : '';
      lineas.push(`  - ${autor}${truncarTexto(nota?.texto ?? '', MAX_VALOR_PIZARRON)}`);
    }
  }
  return lineas.join('\n');
}

/**
 * Vista completa de una clave del pizarrón: valor vigente (sin truncar) e historial.
 * @param {string} clave
 * @param {object|undefined} entrada entrada de la clave
 * @returns {string}
 */
export function describirPizarronClave(clave, entrada) {
  if (!entrada || typeof entrada !== 'object') return `pizarrón: la clave '${clave}' no existe`;
  const partes = [
    `clave: ${clave}`,
    `valor: ${JSON.stringify(entrada.valor, null, 2)}`,
    `jobId: ${entrada.jobId ?? '?'}`,
  ];
  if (entrada.nota) partes.push(`nota: ${entrada.nota}`);
  const historial = Array.isArray(entrada.historial) ? entrada.historial : [];
  partes.push(`historial (${historial.length}):`);
  for (const item of historial.slice(-10)) {
    const marca = item?.conflicto ? ' [conflicto]' : '';
    const nota = item?.nota ? ` (${item.nota})` : '';
    partes.push(`  - ${item?.ts ?? '?'}: ${valorCompacto(item?.valor)}${nota}${marca}`);
  }
  return partes.join('\n');
}
