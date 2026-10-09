/**
 * Funciones PURAS que comparte el cliente del panel.
 *
 * POR QUÉ un módulo aparte: el formato, el filtrado y el parseo del diff son la
 * única lógica del frontend que se puede probar sin DOM. El navegador lo carga
 * como módulo ES (`/static/lib.js`) y los tests lo importan desde Node; por eso
 * no usa APIs de Node ni del navegador.
 */

/** Estados terminales: el trabajo ya no avanza (salvo succeeded -> merged). */
const TERMINALES = new Set(['succeeded', 'failed', 'cancelled', 'rejected', 'lost', 'merged']);

/** Estados que cuentan como "activos" para los chips de filtro. */
const ACTIVOS = new Set(['queued', 'provisioning', 'running', 'verifying']);

/** Estados que se agrupan en "Fallidos/Rechazados". */
const FALLIDOS = new Set(['failed', 'rejected', 'cancelled', 'lost']);

/** Estados que se agrupan en "Terminados" (salida exitosa). */
const TERMINADOS = new Set(['succeeded', 'merged']);

/**
 * Texto, ícono y clase por estado. `icono` es el NOMBRE del ícono SVG (ver
 * `iconos.js`), no un glifo: el cliente lo resuelve a un SVG que hereda el color
 * y el texto sigue siendo la fuente principal de información.
 */
const ETIQUETAS = {
  queued: { texto: 'En cola', icono: 'queued', clase: 'estado-cola' },
  provisioning: { texto: 'Preparando', icono: 'provisioning', clase: 'estado-activo' },
  running: { texto: 'Corriendo', icono: 'running', clase: 'estado-activo' },
  verifying: { texto: 'Verificando', icono: 'verifying', clase: 'estado-activo' },
  succeeded: { texto: 'Terminado', icono: 'succeeded', clase: 'estado-ok' },
  merged: { texto: 'Integrado', icono: 'merged', clase: 'estado-ok' },
  failed: { texto: 'Falló', icono: 'failed', clase: 'estado-mal' },
  rejected: { texto: 'Rechazado', icono: 'rejected', clase: 'estado-mal' },
  cancelled: { texto: 'Cancelado', icono: 'cancelled', clase: 'estado-neutro' },
  lost: { texto: 'Perdido', icono: 'lost', clase: 'estado-mal' },
};

/** Motivos crudos del orquestador traducidos a lenguaje claro. */
const MOTIVOS = {
  alcance: 'fuera del alcance permitido',
  aceptacion: 'no pasó la aceptación',
  sin_progreso: 'se quedó sin progreso',
  exit_distinto_de_cero: 'el proceso terminó con error',
  error_al_lanzar: 'no se pudo lanzar el agente',
  error_interno: 'error interno del orquestador',
  dependencia_fallida: 'una dependencia falló',
  cancelado: 'cancelado',
  cancelado_en_cola: 'cancelado antes de arrancar',
  servidor_cerrado: 'el servidor se cerró',
  dependencia: 'espera sus dependencias',
  concurrencia: 'tope de concurrencia alcanzado',
  tope_del_repo: 'tope de concurrencia del repositorio',
  tope_global: 'tope global de concurrencia',
  esperando_integracion: 'esperando que se integre un trabajo anterior',
  recurso: 'espera un recurso compartido',
  solapa_alcance: 'sus writes se solapan con otro trabajo',
  veterano_adelante: 'otro trabajo más antiguo va primero',
  bloqueado_por_dependencia: 'bloqueado por una dependencia',
};

/**
 * Tipos de evento del registro traducidos a una etiqueta humana. POR QUÉ en la
 * lib pura: la auditoría se renderiza en el servidor y el pizarrón en el cliente;
 * ambos deben mostrar el mismo texto sin duplicar la tabla.
 */
const TIPOS_LEGIBLES = {
  'servidor.arranque': 'Servidor iniciado',
  'servidor.recuperacion': 'Recuperación al iniciar',
  'job.creado': 'Trabajo creado',
  'job.estado': 'Cambio de estado',
  'job.fin': 'Trabajo terminado',
  'job.espera': 'En cola',
  'job.reintento': 'Reintento',
  'job.reanudado': 'Reanudado',
  'job.cancelado': 'Cancelado',
  'job.mutaciones': 'Mutaciones',
  'job.revision': 'Revisión',
  merge: 'Integrado',
  avanzar_base: 'Base avanzada',
  cleanup: 'Limpieza',
  'pizarron.post': 'Pizarrón: aporte',
  'pizarron.aporte_invalido': 'Pizarrón: aporte inválido',
};

/** ¿El estado es terminal (el trabajo ya no corre)? */
export function esTerminal(estado) {
  return TERMINALES.has(estado);
}

/**
 * Etiqueta humana de un tipo de evento; el crudo si no se conoce (nunca vacío si
 * el tipo existe). El crudo se conserva en el `title` de la UI para depurar.
 * @param {string|null|undefined} tipo
 * @returns {string}
 */
export function etiquetaTipo(tipo) {
  return TIPOS_LEGIBLES[tipo] ?? String(tipo ?? '');
}

/**
 * Transición legible de un evento: `estado anterior → estado nuevo`. Va solo
 * texto (el color/ícono lo aporta el chip en la UI); con un solo estado devuelve
 * ese estado. Nunca vacío si el evento trae estado.
 * @param {{ anterior?: string, estado?: string }|null|undefined} evento
 * @returns {string}
 */
export function etiquetaTransicion(evento) {
  const datos = evento ?? {};
  const { estado } = datos;
  if (estado === undefined || estado === null || estado === '') return '';
  const destino = (ETIQUETAS[estado] ?? { texto: String(estado) }).texto;
  const { anterior } = datos;
  if (anterior === undefined || anterior === null || anterior === '') return destino;
  const previo = (ETIQUETAS[anterior] ?? { texto: String(anterior) }).texto;
  return `${previo} → ${destino}`;
}

/**
 * Categoría de un tipo de evento para colorear el chip de la auditoría. Agrupa
 * por prefijo; lo desconocido cae en `otro` (sin color semántico, para no mentir).
 * @param {string|null|undefined} tipo
 * @returns {'servidor'|'job'|'merge'|'pizarron'|'cleanup'|'otro'}
 */
export function categoriaTipo(tipo) {
  const valor = String(tipo ?? '');
  if (valor.startsWith('servidor.')) return 'servidor';
  if (valor.startsWith('pizarron.')) return 'pizarron';
  if (valor === 'merge' || valor === 'avanzar_base') return 'merge';
  if (valor === 'cleanup') return 'cleanup';
  if (valor.startsWith('job.')) return 'job';
  return 'otro';
}

/**
 * Hora legible `dd/mm hh:mm:ss` en la zona del navegador; vacío sin timestamp.
 * @param {number|null|undefined} ts
 * @returns {string}
 */
export function formatearHoraEvento(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const fecha = new Date(n);
  const dos = (valor) => String(valor).padStart(2, '0');
  return (
    `${dos(fecha.getDate())}/${dos(fecha.getMonth() + 1)} ` +
    `${dos(fecha.getHours())}:${dos(fecha.getMinutes())}:${dos(fecha.getSeconds())}`
  );
}

/**
 * Timestamp en ISO UTC (estable para `title` y para comparar entre máquinas).
 * @param {number|null|undefined} ts
 * @returns {string}
 */
export function horaIsoEvento(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
}

/**
 * Duración legible en español.
 * @param {number|null|undefined} segundos
 * @returns {string}
 */
export function formatearDuracion(segundos) {
  if (segundos === null || segundos === undefined || !Number.isFinite(Number(segundos))) return '–';
  const total = Math.max(0, Math.round(Number(segundos)));
  if (total < 60) return `${total} s`;
  const minutos = Math.floor(total / 60);
  if (minutos < 60) {
    const resto = total % 60;
    return resto ? `${minutos} min ${resto} s` : `${minutos} min`;
  }
  const horas = Math.floor(minutos / 60);
  if (horas < 24) {
    const resto = minutos % 60;
    return resto ? `${horas} h ${resto} min` : `${horas} h`;
  }
  const dias = Math.floor(horas / 24);
  const resto = horas % 24;
  return resto ? `${dias} d ${resto} h` : `${dias} d`;
}

/**
 * Primeras `lineas` líneas de un texto, con elipsis si quedó cortado. Se usa como
 * resumen plegable de la tarea para no ocupar media pantalla.
 * @param {string|null|undefined} texto
 * @param {number} [lineas]
 * @returns {string}
 */
export function resumenTarea(texto, lineas = 4) {
  const completo = String(texto ?? '');
  if (completo === '') return '';
  const todas = completo.split('\n');
  const tope = Math.max(1, Number.isFinite(Number(lineas)) ? Math.trunc(Number(lineas)) : 4);
  if (todas.length <= tope) return completo.replace(/\s+$/, '');
  return todas.slice(0, tope).join('\n').replace(/\s+$/, '') + '…';
}

/**
 * Traduce un motivo crudo a lenguaje claro; vacío si no hay.
 * @param {string|null|undefined} motivo
 * @returns {string}
 */
export function motivoLegible(motivo) {
  if (!motivo) return '';
  return MOTIVOS[motivo] ?? String(motivo);
}

/**
 * Etiqueta de estado para la UI: texto en español + ícono Unicode + clase CSS.
 * POR QUÉ los tres: el estado nunca debe depender solo del color.
 * @param {string} estado
 * @param {string|null} [motivo] motivo de fin o de espera, para enriquecer el texto
 * @returns {{ texto: string, icono: string, clase: string }}
 */
export function etiquetaEstado(estado, motivo) {
  const base = ETIQUETAS[estado] ?? { texto: String(estado ?? 'desconocido'), icono: 'neutro', clase: 'estado-neutro' };
  const razon = motivoLegible(motivo);
  return {
    texto: razon ? `${base.texto} · ${razon}` : base.texto,
    icono: base.icono,
    clase: base.clase,
  };
}

/**
 * Ordena una copia de la lista: activos primero y, dentro de cada grupo, el de
 * actividad más reciente arriba (igual que la API, para que la UI no sorprenda).
 * @param {object[]} lista
 * @param {{ activosPrimero?: boolean }} [opciones]
 * @returns {object[]}
 */
export function ordenarTrabajos(lista, { activosPrimero = true } = {}) {
  const copia = Array.isArray(lista) ? [...lista] : [];
  const actividad = (trabajo) => trabajo?.actividadEn ?? trabajo?.creadoEn ?? 0;
  return copia.sort((a, b) => {
    if (activosPrimero) {
      const pesoA = esTerminal(a?.estado) ? 1 : 0;
      const pesoB = esTerminal(b?.estado) ? 1 : 0;
      if (pesoA !== pesoB) return pesoA - pesoB;
    }
    return actividad(b) - actividad(a);
  });
}

/**
 * Filtra por categoría de chip, por texto (título, id, modelo o rama) y por
 * repositorio (`repoNombre`).
 * @param {object[]} lista
 * @param {{ estado?: 'todos'|'activos'|'fallidos'|'terminados', texto?: string, repo?: string|null }} [opciones]
 * @returns {object[]}
 */
export function filtrarTrabajos(lista, { estado = 'todos', texto = '', repo = null } = {}) {
  const consulta = String(texto ?? '').trim().toLowerCase();
  const objetivoRepo = repo ? String(repo) : null;
  const coincideCategoria = (trabajo) => {
    const actual = trabajo?.estado ?? '';
    if (estado === 'activos') return ACTIVOS.has(actual);
    if (estado === 'fallidos') return FALLIDOS.has(actual);
    if (estado === 'terminados') return TERMINADOS.has(actual);
    return true;
  };
  return (Array.isArray(lista) ? lista : []).filter((trabajo) => {
    if (objetivoRepo !== null && String(trabajo?.repoNombre ?? '') !== objetivoRepo) return false;
    if (!coincideCategoria(trabajo)) return false;
    if (consulta === '') return true;
    const campos = [trabajo?.titulo, trabajo?.id, trabajo?.modelo, trabajo?.rama];
    return campos.some((valor) => String(valor ?? '').toLowerCase().includes(consulta));
  });
}

/**
 * Cuenta trabajos por repositorio para los chips. Los trabajos sin `repoNombre`
 * caen bajo la etiqueta '(sin repo)' para no perderlos de vista.
 * @param {object[]} lista
 * @returns {Map<string, number>}
 */
export function contarPorRepo(lista) {
  const conteos = new Map();
  for (const trabajo of Array.isArray(lista) ? lista : []) {
    const nombre = trabajo?.repoNombre ?? '(sin repo)';
    conteos.set(nombre, (conteos.get(nombre) ?? 0) + 1);
  }
  return conteos;
}

/**
 * Cuenta trabajos por chip para mostrar los contadores.
 * @param {object[]} lista
 * @returns {{ todos: number, activos: number, fallidos: number, terminados: number }}
 */
export function contarEstados(lista) {
  const trabajos = Array.isArray(lista) ? lista : [];
  return {
    todos: trabajos.length,
    activos: trabajos.filter((j) => ACTIVOS.has(j?.estado)).length,
    fallidos: trabajos.filter((j) => FALLIDOS.has(j?.estado)).length,
    terminados: trabajos.filter((j) => TERMINADOS.has(j?.estado)).length,
  };
}

/** Quita el prefijo `a/` o `b/` de una ruta de diff; `null` para /dev/null. */
function sinPrefijo(ruta, prefijo) {
  if (ruta === '/dev/null' || ruta === '') return null;
  if (ruta.startsWith(`${prefijo}/`)) return ruta.slice(prefijo.length + 1);
  return ruta;
}

/**
 * Interpreta el encabezado `@@ -n1,c1 +n2,c2 @@ texto`.
 * @param {string} linea
 * @returns {object} hunk con `lineas: []`
 */
export function parsearHunk(linea) {
  const coincide = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(linea);
  if (!coincide) return { encabezado: linea, n1: 0, c1: 0, n2: 0, c2: 0, texto: '', lineas: [] };
  return {
    encabezado: linea,
    n1: Number(coincide[1]),
    c1: coincide[2] === undefined ? 1 : Number(coincide[2]),
    n2: Number(coincide[3]),
    c2: coincide[4] === undefined ? 1 : Number(coincide[4]),
    texto: (coincide[5] ?? '').trim(),
    lineas: [],
  };
}

/**
 * Parsea un parche unificado (git diff) en archivos, hunks y líneas.
 *
 * Cada línea lleva su número en el archivo viejo (`n1`) y nuevo (`n2`), o `null`
 * en el lado donde no existe. El cliente los muestra para no depender del color.
 *
 * @param {string} texto
 * @returns {Array<{ viejo: string|null, nuevo: string|null, estado: 'add'|'del'|'mod'|'rename',
 *   binario: boolean, renames: {de?: string, a?: string}|null, hunks: object[],
 *   adiciones: number, eliminaciones: number }>}
 */
export function parsearParche(texto) {
  const archivos = [];
  let actual = null;
  let hunk = null;
  let n1 = 0;
  let n2 = 0;
  for (const linea of String(texto ?? '').split('\n')) {
    if (linea.startsWith('diff --git ')) {
      actual = { viejo: null, nuevo: null, estado: 'mod', binario: false, renames: null, hunks: [], adiciones: 0, eliminaciones: 0 };
      const cabecera = linea.slice('diff --git '.length);
      const corte = cabecera.indexOf(' b/');
      if (corte === -1) {
        actual.viejo = cabecera;
        actual.nuevo = cabecera;
      } else {
        actual.viejo = cabecera.slice(0, corte);
        actual.nuevo = cabecera.slice(corte + 1);
      }
      actual.viejo = sinPrefijo(actual.viejo, 'a');
      actual.nuevo = sinPrefijo(actual.nuevo, 'b');
      hunk = null;
      archivos.push(actual);
      continue;
    }
    if (actual === null) continue;
    if (linea.startsWith('new file mode')) {
      actual.estado = 'add';
      continue;
    }
    if (linea.startsWith('deleted file mode')) {
      actual.estado = 'del';
      continue;
    }
    if (linea.startsWith('rename from ')) {
      actual.estado = 'rename';
      actual.renames = { ...(actual.renames ?? {}), de: linea.slice('rename from '.length) };
      continue;
    }
    if (linea.startsWith('rename to ')) {
      actual.estado = 'rename';
      actual.renames = { ...(actual.renames ?? {}), a: linea.slice('rename to '.length) };
      continue;
    }
    if (linea.startsWith('Binary files ') || linea.startsWith('GIT binary patch')) {
      actual.binario = true;
      continue;
    }
    if (linea.startsWith('--- ')) {
      actual.viejo = sinPrefijo(linea.slice(4).split('\t')[0], 'a');
      continue;
    }
    if (linea.startsWith('+++ ')) {
      actual.nuevo = sinPrefijo(linea.slice(4).split('\t')[0], 'b');
      continue;
    }
    if (linea.startsWith('@@')) {
      hunk = parsearHunk(linea);
      n1 = hunk.n1;
      n2 = hunk.n2;
      actual.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;
    const marca = linea[0];
    if (marca === '+') {
      hunk.lineas.push({ tipo: 'add', n1: null, n2, texto: linea.slice(1) });
      n2 += 1;
      actual.adiciones += 1;
    } else if (marca === '-') {
      hunk.lineas.push({ tipo: 'del', n1, n2: null, texto: linea.slice(1) });
      n1 += 1;
      actual.eliminaciones += 1;
    } else if (marca === ' ') {
      hunk.lineas.push({ tipo: 'ctx', n1, n2, texto: linea.slice(1) });
      n1 += 1;
      n2 += 1;
    }
    // '\' (sin salto de línea al final) y líneas ajenas a un hunk se ignoran.
  }
  return archivos;
}

/** Ancho mínimo y máximo (px) de la columna de la lista en el layout de app. */
export const ANCHO_LISTA_MIN = 280;
export const ANCHO_LISTA_MAX = 560;

/**
 * Acota el ancho de la lista al rango usable. La usan el valor por defecto, el
 * que se restaura de localStorage y el arrastre del divisor: así un valor viejo
 * o corrupto nunca deja una columna inusable ni desborda el layout.
 * @param {number|string} ancho
 * @returns {number}
 */
export function limitarAnchoLista(ancho) {
  const n = Number(ancho);
  if (!Number.isFinite(n)) return ANCHO_LISTA_MIN;
  return Math.min(ANCHO_LISTA_MAX, Math.max(ANCHO_LISTA_MIN, Math.round(n)));
}

/**
 * Ancho inicial de la lista según el ancho de la ventana: fluido `clamp(320px,
 * 28vw, 420px)` y hasta 440 px en pantallas muy anchas (≥1700 px), donde sobra
 * espacio y la lista puede mostrar más sin ahogar al detalle.
 * @param {number} viewportAncho
 * @returns {number}
 */
export function anchoListaInicial(viewportAncho) {
  const vp = Number(viewportAncho);
  if (!Number.isFinite(vp) || vp <= 0) return 320;
  if (vp >= 1700) return 440;
  return limitarAnchoLista(Math.min(420, Math.max(320, Math.round(vp * 0.28))));
}

/**
 * Agrupa los trabajos ya ordenados en «En curso» y «Terminados» para la lista,
 * con encabezados. Se omiten los grupos vacíos. Es pura para poder probar el
 * criterio (terminal = no avanza) sin depender del DOM.
 * @param {object[]} lista
 * @returns {Array<{ clave: string, etiqueta: string, trabajos: object[] }>}
 */
export function agruparTrabajos(lista) {
  const enCurso = [];
  const terminados = [];
  for (const trabajo of Array.isArray(lista) ? lista : []) {
    (esTerminal(trabajo?.estado) ? terminados : enCurso).push(trabajo);
  }
  const grupos = [];
  if (enCurso.length > 0) grupos.push({ clave: 'curso', etiqueta: 'En curso', trabajos: enCurso });
  if (terminados.length > 0) grupos.push({ clave: 'terminados', etiqueta: 'Terminados', trabajos: terminados });
  return grupos;
}

/**
 * Hora relativa legible (`hace 5 min`) para la meta de cada fila. El valor
 * absoluto (ISO) va en el `title` desde el cliente; acá solo el texto humano.
 * @param {number|null|undefined} ts
 * @param {number} [ahora]
 * @returns {string}
 */
export function tiempoRelativo(ts, ahora) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ref = Number.isFinite(Number(ahora)) ? Number(ahora) : Date.now();
  const segundos = Math.max(0, Math.round((ref - n) / 1000));
  if (segundos < 10) return 'recién';
  if (segundos < 60) return 'hace ' + segundos + ' s';
  const minutos = Math.floor(segundos / 60);
  if (segundos < 3600) return 'hace ' + minutos + ' min';
  const horas = Math.floor(segundos / 3600);
  if (segundos < 86400) return 'hace ' + horas + ' h';
  const dias = Math.floor(segundos / 86400);
  if (dias < 30) return 'hace ' + dias + ' d';
  const meses = Math.floor(dias / 30);
  if (meses < 12) return 'hace ' + meses + ' mes';
  return 'hace ' + Math.floor(meses / 12) + ' a';
}

/** Peso por estado para el orden «Estado»: primero lo que reclama atención. */
const PESO_ESTADO = {
  running: 0,
  verifying: 1,
  provisioning: 2,
  queued: 3,
  failed: 4,
  rejected: 5,
  lost: 6,
  cancelled: 7,
  succeeded: 8,
  merged: 9,
};

/**
 * Ordena una copia de la lista según el criterio elegido en la toolbar:
 * `actividad` (por defecto), `estado` o `creacion`. No muta la entrada.
 * @param {object[]} lista
 * @param {'actividad'|'estado'|'creacion'} [criterio]
 * @returns {object[]}
 */
export function ordenarPor(lista, criterio = 'actividad') {
  const copia = Array.isArray(lista) ? [...lista] : [];
  const actividad = (trabajo) => trabajo?.actividadEn ?? trabajo?.creadoEn ?? 0;
  const creacion = (trabajo) => trabajo?.creadoEn ?? 0;
  if (criterio === 'creacion') return copia.sort((a, b) => creacion(b) - creacion(a));
  if (criterio === 'estado') {
    return copia.sort((a, b) => {
      const pesoA = PESO_ESTADO[a?.estado] ?? 99;
      const pesoB = PESO_ESTADO[b?.estado] ?? 99;
      if (pesoA !== pesoB) return pesoA - pesoB;
      return actividad(b) - actividad(a);
    });
  }
  return copia.sort((a, b) => actividad(b) - actividad(a));
}

/**
 * Segmenta una línea en tramos que coinciden y que no con `consulta`, para
 * resaltar la búsqueda de la consola sin `innerHTML`. Pura y sin estado.
 * @param {string|null|undefined} texto
 * @param {string|null|undefined} consulta
 * @returns {Array<{ texto: string, coincide: boolean }>}
 */
export function segmentosDeLinea(texto, consulta) {
  const contenido = String(texto ?? '');
  const objetivo = String(consulta ?? '');
  if (objetivo === '') return [{ texto: contenido, coincide: false }];
  const bajo = contenido.toLowerCase();
  const aguja = objetivo.toLowerCase();
  const segmentos = [];
  let desde = 0;
  while (desde <= contenido.length) {
    const pos = bajo.indexOf(aguja, desde);
    if (pos === -1) break;
    if (pos > desde) segmentos.push({ texto: contenido.slice(desde, pos), coincide: false });
    segmentos.push({ texto: contenido.slice(pos, pos + aguja.length), coincide: true });
    desde = pos + aguja.length;
  }
  if (desde < contenido.length) segmentos.push({ texto: contenido.slice(desde), coincide: false });
  if (segmentos.length === 0) segmentos.push({ texto: contenido, coincide: false });
  return segmentos;
}

/**
 * Coincidencias de `consulta` sobre un arreglo de líneas: línea y rango. Pura,
 * para poder probar el «n de m» y la navegación de la búsqueda de la consola.
 * @param {string[]} lineas
 * @param {string|null|undefined} consulta
 * @returns {Array<{ linea: number, inicio: number, fin: number }>}
 */
export function coincidenciasEnLineas(lineas, consulta) {
  const lista = Array.isArray(lineas) ? lineas : [];
  const objetivo = String(consulta ?? '');
  if (objetivo === '') return [];
  const aguja = objetivo.toLowerCase();
  const coincidencias = [];
  lista.forEach(function (texto, linea) {
    const contenido = String(texto ?? '');
    const bajo = contenido.toLowerCase();
    let desde = 0;
    while (desde <= bajo.length) {
      const pos = bajo.indexOf(aguja, desde);
      if (pos === -1) break;
      coincidencias.push({ linea, inicio: pos, fin: pos + aguja.length });
      desde = pos + Math.max(1, aguja.length);
    }
  });
  return coincidencias;
}

/**
 * Totales del parche para la cabecera del Diff: cantidad de archivos y altas y
 * bajas sumadas. Pura para no repetir el recorrido en el cliente.
 * @param {Array<{ adiciones?: number, eliminaciones?: number }>|null|undefined} archivos
 * @returns {{ archivos: number, adiciones: number, eliminaciones: number, total: number, texto: string }}
 */
export function estadisticasDeParche(archivos) {
  const lista = Array.isArray(archivos) ? archivos : [];
  let adiciones = 0;
  let eliminaciones = 0;
  lista.forEach(function (archivo) {
    adiciones += Number(archivo?.adiciones) || 0;
    eliminaciones += Number(archivo?.eliminaciones) || 0;
  });
  return {
    archivos: lista.length,
    adiciones,
    eliminaciones,
    total: adiciones + eliminaciones,
    texto: `${lista.length} archivo(s) · +${adiciones} −${eliminaciones}`,
  };
}

/** Patrones de la consola: primero el error para que un «failed» no quede en verde. */
const RE_LINEA_ERROR = /error|fail|FAIL/i;
const RE_LINEA_OK = /ok |pass/i;

/**
 * Clase decorativa de una línea de consola. El color REFUERZA la señal; el texto
 * de la línea (que se muestra tal cual) es la fuente principal, no el color.
 * @param {string|null|undefined} texto
 * @returns {''|'linea-error'|'linea-ok'}
 */
export function claseDeLinea(texto) {
  const contenido = String(texto ?? '');
  if (RE_LINEA_ERROR.test(contenido)) return 'linea-error';
  if (RE_LINEA_OK.test(contenido)) return 'linea-ok';
  return '';
}

/**
 * ¿El usuario se alejó del final y corresponde pausar el seguimiento? Se mide la
 * distancia al fondo y se tolera un umbral para no pausar por un píxel. Pura.
 * @param {{ scrollTop?: number, scrollHeight?: number, clientHeight?: number }} [medidas]
 * @param {number} [umbral]
 * @returns {boolean}
 */
export function debePausarSeguimiento(medidas = {}, umbral = 24) {
  const scrollTop = Number(medidas.scrollTop) || 0;
  const scrollHeight = Number(medidas.scrollHeight) || 0;
  const clientHeight = Number(medidas.clientHeight) || 0;
  return scrollHeight - scrollTop - clientHeight > umbral;
}

/**
 * Resumen numérico del alcance de un trabajo para la cabecera de la pestaña.
 * @param {object|null|undefined} alcance
 * @returns {{ writes: number, protegidas: number, tocados: number, fuera: number,
 *   dentro: number, limpio: boolean, texto: string }}
 */
export function resumenAlcance(alcance) {
  const datos = alcance ?? {};
  const writes = Array.isArray(datos.writes) ? datos.writes : [];
  const protegidas = Array.isArray(datos.protegidas) ? datos.protegidas : [];
  const tocados = Array.isArray(datos.tocados) ? datos.tocados : [];
  const fuera = Array.isArray(datos.fuera) ? datos.fuera : [];
  const dentro = Math.max(0, tocados.length - fuera.length);
  return {
    writes: writes.length,
    protegidas: protegidas.length,
    tocados: tocados.length,
    fuera: fuera.length,
    dentro,
    limpio: fuera.length === 0,
    texto: fuera.length === 0
      ? `${tocados.length} archivo(s) tocado(s), todos dentro del alcance`
      : `${fuera.length} archivo(s) fuera del alcance de ${tocados.length}`,
  };
}

/** Componente lineal (sRGB) de un canal 0..255, según WCAG. */
function canalLineal(valor) {
  const c = valor / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa WCAG de un color `#rrggbb` o `#rgb`. */
function luminanciaRelativa(hex) {
  const limpio = String(hex ?? '').replace('#', '').trim();
  const completo = limpio.length === 3 ? limpio.split('').map((c) => c + c).join('') : limpio;
  const num = (desde) => parseInt(completo.slice(desde, desde + 2), 16) || 0;
  return 0.2126 * canalLineal(num(0)) + 0.7152 * canalLineal(num(2)) + 0.0722 * canalLineal(num(4));
}

/**
 * Razón de contraste WCAG entre dos colores hex. Pura y sin dependencias: la usan
 * los tests para exigir AA (≥ 4.5 en texto, ≥ 3 en bordes/UI) sobre los tokens,
 * así el diseño no puede degradar el contraste sin que falle la suite.
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
export function contraste(hexA, hexB) {
  const a = luminanciaRelativa(hexA);
  const b = luminanciaRelativa(hexB);
  const claro = Math.max(a, b);
  const oscuro = Math.min(a, b);
  return (claro + 0.05) / (oscuro + 0.05);
}
