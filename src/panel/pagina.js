/**
 * Shell HTML del panel y de las páginas secundarias (auditoría y pizarrón).
 *
 * POR QUÉ sin JS ni CSS en línea: la CSP del servidor (`style-src 'self'`,
 * `script-src 'self'`) los bloquea. El HTML solo referencia `/static/app.css` y
 * `/static/app.js`; los datos y el texto variable se insertan con textContent
 * desde el cliente, nunca con innerHTML.
 *
 * POR QUÉ la auditoría sigue renderizándose en el servidor: es una tabla de solo
 * lectura con filtros por query string; no necesita JavaScript y así funciona
 * aun con el cliente bloqueado. La paginación es un enlace «Cargar más».
 */
import { etiquetaTipo, etiquetaTransicion, formatearHoraEvento, horaIsoEvento, motivoLegible } from './cliente-lib.js';

/** Paso de la paginación de la auditoría (y límite por defecto). */
export const PASO_EVENTOS = 200;

/** Escapa texto para insertarlo en HTML (la auditoría muestra datos leídos de disco). */
function escaparHtml(valor) {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Enlace de sección; marca la actual con `aria-current="page"`. */
function enlaceSeccion(href, texto, actual, clave) {
  const marca = clave === actual ? ' aria-current="page"' : '';
  return `<a href="${href}"${marca}>${texto}</a>`;
}

/**
 * Navegación común a las tres páginas: Trabajos, Auditoría y Pizarrón, con la
 * actual marcada. `extra` permite sumar controles propios de cada página (p. ej.
 * el botón de atajos de la principal) dentro del mismo `<nav>`.
 */
function navSecciones(actual, extra = '') {
  return `<nav class="cabecera-nav" aria-label="Secciones">${enlaceSeccion('/', 'Trabajos', actual, 'trabajos')}${enlaceSeccion('/auditoria', 'Auditoría', actual, 'auditoria')}${enlaceSeccion('/pizarron', 'Pizarrón', actual, 'pizarron')}${extra}</nav>`;
}

/** Enlace de salto y cabecera común a las tres páginas del panel. */
function cabeceraHtml({ titulo, marca, actual, extra = '' }) {
  return `<a class="saltar" href="#contenido">Saltar al contenido</a>
<header class="cabecera">
  <span class="cabecera-titulo"><h1>${escaparHtml(titulo)}</h1><span class="marca">${escaparHtml(marca)}</span></span>
  ${navSecciones(actual, extra)}
</header>`;
}

/**
 * Armazón común: doctype, cabecera de documento y cuerpo. `claseCuerpo` permite
 * marcar la página principal (`panel-app`) para que solo ella use el layout de
 * aplicación a pantalla completa; auditoría y pizarrón siguen con scroll normal.
 */
function armazonHtml({ titulo, cabecera, cuerpo, scripts = '', claseCuerpo = '' }) {
  const clase = claseCuerpo ? ` class="${claseCuerpo}"` : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escaparHtml(titulo)}</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body${clase}>
${cabecera}
${cuerpo}
${scripts}
</body>
</html>`;
}

/**
 * Controles EXTRA de la cabecera principal: conexión, contadores, concurrencia y
 * el botón de atajos. POR QUÉ sin `navSecciones`: estos controles van DENTRO del
 * `<nav>` que arma `cabeceraHtml`, así no se duplica el navegador de secciones.
 */
const CONTROLES_PRINCIPAL = `<span id="conexion" class="conexion reconectando" role="status">
    <span class="punto" aria-hidden="true"></span><span id="conexion-texto">Reconectando…</span>
  </span>
  <span id="contadores" class="contadores">Corriendo 0/0 · En cola 0</span>
  <span id="concurrencia" class="concurrencia" hidden></span>
  <button type="button" id="ayuda" class="boton" aria-haspopup="dialog">Atajos (?)</button>`;

/**
 * Cuerpo de la página principal: layout de aplicación (lista + divisor + detalle).
 * El divisor es una manija de 6 px con atributos ARIA y foco de teclado; el
 * detalle separa su barra de título + pestañas (sticky) del contenido que scrollea.
 */
const CUERPO_PRINCIPAL = `<div class="cuerpo" id="cuerpo">
  <nav id="lista" class="lista" aria-label="Trabajos">
    <div class="toolbar">
      <form class="busqueda" role="search">
        <div class="busqueda-caja">
          <label class="oculto" for="filtro-texto">Buscar trabajo</label>
          <input id="filtro-texto" type="search" placeholder="Buscar por título, id, rama o modelo" autocomplete="off">
          <button type="button" id="limpiar-busqueda" class="boton-limpiar" aria-label="Limpiar búsqueda" hidden>×</button>
        </div>
      </form>
      <div id="chips" class="segmentado" role="group" aria-label="Filtrar por estado"></div>
      <div class="toolbar-fila">
        <label class="oculto" for="filtro-repo">Repositorio</label>
        <select id="filtro-repo" aria-label="Filtrar por repositorio"></select>
        <label class="oculto" for="orden">Ordenar</label>
        <select id="orden" aria-label="Ordenar trabajos">
          <option value="actividad">Actividad reciente</option>
          <option value="estado">Estado</option>
          <option value="creacion">Creación</option>
        </select>
        <button type="button" id="densidad" class="boton" aria-pressed="false" title="Alternar densidad de la lista">Cómoda</button>
      </div>
    </div>
    <ul id="trabajos" class="trabajos" aria-label="Lista de trabajos"></ul>
    <p id="lista-vacia" class="vacia" hidden>No hay trabajos que coincidan.</p>
  </nav>
  <div id="divisor" class="divisor" role="separator" aria-orientation="vertical" aria-label="Ajustar ancho de la lista" aria-valuenow="380" aria-valuemin="280" aria-valuemax="560" tabindex="0"></div>
  <main id="contenido" class="detalle" tabindex="-1">
    <button type="button" id="volver" class="boton volver" hidden>← Trabajos</button>
    <p id="sin-seleccion" class="cargando">Elegí un trabajo de la lista.</p>
    <section id="detalle-trabajo" aria-labelledby="titulo-trabajo" hidden>
      <div class="detalle-cabecera">
        <div class="titulo-fila">
          <h2 id="titulo-trabajo" class="titulo-trabajo"></h2>
          <button type="button" id="copiar-id" class="boton" hidden>Copiar id</button>
        </div>
        <div class="tabs" role="tablist" aria-label="Vistas del trabajo">
          <button type="button" role="tab" id="tab-resumen" aria-controls="panel-resumen" aria-selected="true" tabindex="0">Resumen</button>
          <button type="button" role="tab" id="tab-consola" aria-controls="panel-consola" aria-selected="false" tabindex="-1">Consola</button>
          <button type="button" role="tab" id="tab-diff" aria-controls="panel-diff" aria-selected="false" tabindex="-1">Diff</button>
          <button type="button" role="tab" id="tab-alcance" aria-controls="panel-alcance" aria-selected="false" tabindex="-1">Alcance</button>
          <button type="button" role="tab" id="tab-eventos" aria-controls="panel-eventos" aria-selected="false" tabindex="-1">Eventos</button>
        </div>
      </div>
      <div id="panel-resumen" role="tabpanel" aria-labelledby="tab-resumen" tabindex="0"></div>
      <div id="panel-consola" role="tabpanel" aria-labelledby="tab-consola" tabindex="0" hidden></div>
      <div id="panel-diff" role="tabpanel" aria-labelledby="tab-diff" tabindex="0" hidden></div>
      <div id="panel-alcance" role="tabpanel" aria-labelledby="tab-alcance" tabindex="0" hidden></div>
      <div id="panel-eventos" role="tabpanel" aria-labelledby="tab-eventos" tabindex="0" hidden></div>
    </section>
  </main>
</div>
<div id="anuncios" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<dialog id="dialogo-ayuda" class="dialogo" aria-labelledby="ayuda-titulo">
  <h2 id="ayuda-titulo">Atajos de teclado</h2>
  <ul class="ayuda-lista">
    <li><span>Siguiente / anterior trabajo</span><span><kbd>j</kbd> <kbd>k</kbd></span></li>
    <li><span>Buscar</span><span><kbd>/</kbd></span></li>
    <li><span>Pestañas Resumen…Eventos</span><span><kbd>1</kbd>–<kbd>5</kbd></span></li>
    <li><span>Seguir / pausar consola</span><span><kbd>f</kbd></span></li>
    <li><span>Volver a la lista (móvil)</span><span><kbd>Esc</kbd> / <kbd>Alt</kbd>+<kbd>←</kbd></span></li>
    <li><span>Ancho de la lista</span><span><kbd>←</kbd> <kbd>→</kbd></span></li>
    <li><span>Esta ayuda</span><span><kbd>?</kbd></span></li>
  </ul>
  <form method="dialog"><button type="submit" class="boton">Cerrar</button></form>
</dialog>`;

/** Página principal (el cliente la hidrata). */
export const PAGINA = armazonHtml({
  titulo: 'Trabajos de opencode',
  cabecera: cabeceraHtml({ titulo: 'Trabajos de opencode', marca: 'panel en vivo', actual: 'trabajos', extra: CONTROLES_PRINCIPAL }),
  cuerpo: CUERPO_PRINCIPAL,
  scripts: '<script type="module" src="/static/app.js"></script>',
  claseCuerpo: 'panel-app',
});

/** Opciones del `<select>` de tipos, con la actual seleccionada. */
function opcionesTipo(tipos, seleccionado) {
  return ['', ...tipos]
    .map((tipo) => {
      const marca = tipo === seleccionado ? ' selected' : '';
      return `<option value="${escaparHtml(tipo)}"${marca}>${escaparHtml(tipo || 'todos')}</option>`;
    })
    .join('');
}

/** Fila de la tabla de auditoría, con etiqueta humana, ícono de transición e insignia histórico. */
function filaAuditoria(evento, titulos) {
  const iso = horaIsoEvento(evento.ts);
  const hora = formatearHoraEvento(evento.ts);
  const titulo = titulos[evento.jobId] ?? evento.jobId;
  const trabajo = evento.jobId
    ? `<a href="/?job=${encodeURIComponent(evento.jobId)}">${escaparHtml(titulo)}</a>`
    : '';
  const historico =
    evento.origen === 'reconstruido' ? ' <span class="badge badge-historico">histórico</span>' : '';
  const transicion = etiquetaTransicion(evento);
  return (
    `<tr><td><time datetime="${escaparHtml(iso)}" title="${escaparHtml(iso)}">${escaparHtml(hora)}</time></td>` +
    `<td><span title="${escaparHtml(evento.tipo)}">${escaparHtml(etiquetaTipo(evento.tipo))}</span>${historico}</td>` +
    `<td>${trabajo}</td>` +
    `<td>${escaparHtml(transicion)}</td>` +
    `<td>${escaparHtml(motivoLegible(evento.motivo))}</td>` +
    `<td>${escaparHtml(evento.actor)}</td></tr>`
  );
}

/** Enlace «Cargar más» que conserva los filtros y suma un paso al límite. */
function enlaceCargarMas(filtros, limite) {
  const params = new URLSearchParams();
  if (filtros.jobId) params.set('jobId', filtros.jobId);
  if (filtros.tipo) params.set('tipo', filtros.tipo);
  if (filtros.desde !== undefined) params.set('desde', String(filtros.desde));
  if (filtros.hasta !== undefined) params.set('hasta', String(filtros.hasta));
  params.set('limite', String(limite + PASO_EVENTOS));
  return `<a class="boton boton-primario" href="/auditoria?${escaparHtml(params.toString())}">Cargar más</a>`;
}

/**
 * Página de auditoría (HTML plano, renderizado en el servidor, sin JS).
 * Los filtros viajan por query string y se reenvían al registro.
 *
 * @param {{ eventos?: object[], tipos?: readonly string[], filtros?: object, disponible?: boolean,
 *   titulos?: Record<string,string>, limite?: number, hayMas?: boolean, enTope?: boolean }} [datos]
 * @returns {string}
 */
export function paginaAuditoria({
  eventos = [],
  tipos = [],
  filtros = {},
  disponible = true,
  titulos = {},
  limite = PASO_EVENTOS,
  hayMas = false,
  enTope = false,
} = {}) {
  const filas = eventos.map((evento) => filaAuditoria(evento, titulos)).join('');
  const tabla =
    eventos.length > 0
      ? `<div class="tabla-envoltorio">
<table class="tabla-auditoria" aria-label="Eventos registrados, más recientes primero">
<caption class="oculto">Eventos registrados, más recientes primero</caption>
<thead><tr><th scope="col">Hora</th><th scope="col">Tipo</th><th scope="col">Trabajo</th><th scope="col">Estado</th><th scope="col">Motivo</th><th scope="col">Autor</th></tr></thead>
<tbody>${filas}</tbody>
</table>
</div>`
      : '';
  const vacio = !disponible
    ? '<p class="vacia" role="status">Auditoría no disponible: el panel no tiene acceso al registro de eventos.</p>'
    : eventos.length === 0
      ? '<p class="vacia" role="status">Todavía no hay eventos. Acá se registran los cambios de estado de los trabajos, los merges, las limpiezas y los aportes al pizarrón.</p>'
      : '';
  // En el tope del límite «Cargar más» no puede avanzar (el tope lo frenaría): se oculta
  // el enlace y se explica cómo seguir, para que lo viejo no quede inalcanzable en silencio.
  const paginacion = hayMas && !enTope ? `<div class="paginacion">${enlaceCargarMas(filtros, limite)}</div>` : '';
  const avisoTope = enTope
    ? `<p class="nota" role="status">Mostrando los ${limite} más recientes; filtrá por fechas para ver más.</p>`
    : '';
  const cuerpo = `<main id="contenido" class="pagina" tabindex="-1">
<form method="get" action="/auditoria" class="filtros" role="search" aria-label="Filtrar eventos">
  <div class="campo">
    <label for="filtro-trabajo">Trabajo</label>
    <input id="filtro-trabajo" name="jobId" value="${escaparHtml(filtros.jobId ?? '')}" placeholder="id del trabajo" autocomplete="off">
  </div>
  <div class="campo">
    <label for="filtro-tipo">Tipo</label>
    <select id="filtro-tipo" name="tipo">${opcionesTipo(tipos, filtros.tipo)}</select>
  </div>
  <div class="campo">
    <label for="filtro-desde">Desde</label>
    <input id="filtro-desde" name="desde" value="${escaparHtml(filtros.desde ?? '')}" inputmode="numeric" size="14" placeholder="timestamp">
  </div>
  <div class="campo">
    <label for="filtro-hasta">Hasta</label>
    <input id="filtro-hasta" name="hasta" value="${escaparHtml(filtros.hasta ?? '')}" inputmode="numeric" size="14" placeholder="timestamp">
  </div>
  <div class="acciones">
    <button type="submit" class="boton boton-primario">Filtrar</button>
    <a class="boton" href="/auditoria">Limpiar</a>
  </div>
</form>
${tabla}
${vacio}
${avisoTope}
${paginacion}
</main>`;
  return armazonHtml({
    titulo: 'Auditoría de opencode',
    cabecera: cabeceraHtml({ titulo: 'Auditoría de opencode', marca: 'registro de eventos', actual: 'auditoria' }),
    cuerpo,
  });
}

/**
 * Página del pizarrón compartido. El shell es igual al del resto del panel; el
 * contenido lo hidrata `/static/pizarron.js`, que refresca por polling contra
 * `/api/pizarron` (sin escrituras: el panel solo lee el estado del orquestador).
 * @returns {string}
 */
export function paginaPizarron() {
  return armazonHtml({
    titulo: 'Pizarrón de opencode',
    cabecera: cabeceraHtml({ titulo: 'Pizarrón de opencode', marca: 'contexto compartido', actual: 'pizarron' }),
    cuerpo: `<main id="contenido" class="pagina" tabindex="-1">
<p id="pizarron-estado" class="nota" role="status" aria-live="polite">Cargando pizarrón…</p>
<div id="pizarron"></div>
</main>`,
    scripts: '<script type="module" src="/static/pizarron.js"></script>',
  });
}
