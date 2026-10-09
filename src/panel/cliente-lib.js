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

/** Texto, ícono y clase por estado. El ícono y el texto evitan depender del color. */
const ETIQUETAS = {
  queued: { texto: 'En cola', icono: '⏳', clase: 'estado-cola' },
  provisioning: { texto: 'Preparando', icono: '⚙', clase: 'estado-activo' },
  running: { texto: 'Corriendo', icono: '▶', clase: 'estado-activo' },
  verifying: { texto: 'Verificando', icono: '🔎', clase: 'estado-activo' },
  succeeded: { texto: 'Terminado', icono: '✔', clase: 'estado-ok' },
  merged: { texto: 'Integrado', icono: '✔', clase: 'estado-ok' },
  failed: { texto: 'Falló', icono: '✖', clase: 'estado-mal' },
  rejected: { texto: 'Rechazado', icono: '⛔', clase: 'estado-mal' },
  cancelled: { texto: 'Cancelado', icono: '⊘', clase: 'estado-neutro' },
  lost: { texto: 'Perdido', icono: '⚠', clase: 'estado-mal' },
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
  recurso: 'espera un recurso compartido',
  solapa_alcance: 'sus writes se solapan con otro trabajo',
  veterano_adelante: 'otro trabajo más antiguo va primero',
  bloqueado_por_dependencia: 'bloqueado por una dependencia',
};

/** ¿El estado es terminal (el trabajo ya no corre)? */
export function esTerminal(estado) {
  return TERMINALES.has(estado);
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
  const base = ETIQUETAS[estado] ?? { texto: String(estado ?? 'desconocido'), icono: '•', clase: 'estado-neutro' };
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
 * Filtra por categoría de chip y por texto (título, id, modelo o rama).
 * @param {object[]} lista
 * @param {{ estado?: 'todos'|'activos'|'fallidos'|'terminados', texto?: string }} [opciones]
 * @returns {object[]}
 */
export function filtrarTrabajos(lista, { estado = 'todos', texto = '' } = {}) {
  const consulta = String(texto ?? '').trim().toLowerCase();
  const coincideCategoria = (trabajo) => {
    const actual = trabajo?.estado ?? '';
    if (estado === 'activos') return ACTIVOS.has(actual);
    if (estado === 'fallidos') return FALLIDOS.has(actual);
    if (estado === 'terminados') return TERMINADOS.has(actual);
    return true;
  };
  return (Array.isArray(lista) ? lista : []).filter((trabajo) => {
    if (!coincideCategoria(trabajo)) return false;
    if (consulta === '') return true;
    const campos = [trabajo?.titulo, trabajo?.id, trabajo?.modelo, trabajo?.rama];
    return campos.some((valor) => String(valor ?? '').toLowerCase().includes(consulta));
  });
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
