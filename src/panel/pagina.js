/**
 * Shell HTML del panel y de la página de auditoría.
 *
 * POR QUÉ sin JS ni CSS en línea: la CSP del servidor (`style-src 'self'`,
 * `script-src 'self'`) los bloquea. El HTML solo referencia `/static/app.css` y
 * `/static/app.js`; los datos y el texto variable se insertan con textContent
 * desde el cliente, nunca con innerHTML.
 */

/** Escapa texto para insertarlo en HTML (la auditoría muestra datos leídos de disco). */
function escaparHtml(valor) {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Hora en ISO UTC: estable para tests y para comparar entre máquinas. */
function horaEvento(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n).toISOString() : '';
}

/** Columna estado: muestra `anterior → nuevo` cuando hay transición. */
function estadoEvento(evento) {
  if (evento.anterior !== undefined && evento.estado !== undefined) {
    return `${evento.anterior} → ${evento.estado}`;
  }
  return evento.estado !== undefined ? evento.estado : '';
}

/** Enlace de salto y cabecera común a las dos páginas del panel. */
function cabeceraHtml({ titulo, marca, nav }) {
  return `<a class="saltar" href="#contenido">Saltar al contenido</a>
<header class="cabecera">
  <span class="cabecera-titulo"><h1>${escaparHtml(titulo)}</h1><span class="marca">${escaparHtml(marca)}</span></span>
  ${nav}
</header>`;
}

/** Armazón común: doctype, cabecera de documento y cuerpo. */
function armazonHtml({ titulo, cabecera, cuerpo, scripts = '' }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escaparHtml(titulo)}</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
${cabecera}
${cuerpo}
${scripts}
</body>
</html>`;
}

/** Cabecera de la página principal: conexión, contadores y enlaces. */
const NAV_PRINCIPAL = `<span id="conexion" class="conexion reconectando" role="status">
    <span class="punto" aria-hidden="true"></span><span id="conexion-texto">Reconectando…</span>
  </span>
  <span id="contadores" class="contadores">Corriendo 0 · En cola 0 · Total 0</span>
  <span id="concurrencia" class="concurrencia" hidden></span>
  <nav class="cabecera-nav" aria-label="Secciones">
    <a href="/pizarron">Pizarrón</a>
    <a href="/auditoria">Auditoría</a>
    <button type="button" id="ayuda" class="boton" aria-haspopup="dialog">Atajos (?)</button>
  </nav>`;

/** Cuerpo de la página principal: lista de trabajos + detalle con pestañas. */
const CUERPO_PRINCIPAL = `<div class="cuerpo">
  <nav id="lista" class="lista" aria-label="Trabajos">
    <form class="busqueda" role="search">
      <label class="oculto" for="filtro-texto">Buscar trabajo</label>
      <input id="filtro-texto" type="search" placeholder="Buscar por título, id, rama o modelo" autocomplete="off">
    </form>
    <div id="chips" class="chips" role="group" aria-label="Filtrar por estado"></div>
    <div id="chips-repo" class="chips chips-repo" role="group" aria-label="Filtrar por repositorio" hidden></div>
    <ul id="trabajos" class="trabajos" aria-label="Lista de trabajos"></ul>
    <p id="lista-vacia" class="vacia" hidden>No hay trabajos que coincidan.</p>
  </nav>
  <main id="contenido" class="detalle" tabindex="-1">
    <p id="sin-seleccion" class="cargando">Elegí un trabajo de la lista.</p>
    <section id="detalle-trabajo" aria-labelledby="titulo-trabajo" hidden>
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
    <li><span>Esta ayuda</span><span><kbd>?</kbd></span></li>
  </ul>
  <form method="dialog"><button type="submit" class="boton">Cerrar</button></form>
</dialog>`;

/** Página principal (el cliente la hidrata). */
export const PAGINA = armazonHtml({
  titulo: 'Trabajos de opencode',
  cabecera: cabeceraHtml({ titulo: 'Trabajos de opencode', marca: 'panel en vivo', nav: NAV_PRINCIPAL }),
  cuerpo: CUERPO_PRINCIPAL,
  scripts: '<script type="module" src="/static/app.js"></script>',
});

/**
 * Página de auditoría (HTML plano, renderizado en el servidor, sin JS).
 * Los filtros viajan por query string y se reenvían al registro.
 * @param {{ eventos?: object[], tipos?: readonly string[], filtros?: object, disponible?: boolean }} [datos]
 * @returns {string}
 */
export function paginaAuditoria({ eventos = [], tipos = [], filtros = {}, disponible = true } = {}) {
  const opciones = ['', ...tipos]
    .map((t) => {
      const sel = t === filtros.tipo ? ' selected' : '';
      return `<option value="${escaparHtml(t)}"${sel}>${escaparHtml(t || 'todos')}</option>`;
    })
    .join('');
  const filas = eventos
    .map((e) => {
      const trabajo = e.jobId
        ? `<a href="/?job=${encodeURIComponent(e.jobId)}">${escaparHtml(e.jobId)}</a>`
        : '';
      return `<tr><td>${escaparHtml(horaEvento(e.ts))}</td><td>${escaparHtml(e.tipo)}</td>` +
        `<td>${trabajo}</td><td>${escaparHtml(estadoEvento(e))}</td>` +
        `<td>${escaparHtml(e.motivo)}</td><td>${escaparHtml(e.actor)}</td></tr>`;
    })
    .join('');
  const cuerpo = disponible
    ? `<table class="tabla-auditoria"><thead><tr><th>hora</th><th>tipo</th><th>trabajo</th><th>estado</th><th>motivo</th><th>actor</th></tr></thead><tbody>${filas}</tbody></table>`
    : '<p class="nota">Auditoría no disponible</p>';
  const nav = '<nav class="cabecera-nav" aria-label="Secciones"><a href="/">← Trabajos</a><a href="/pizarron">Pizarrón</a></nav>';
  return armazonHtml({
    titulo: 'Auditoría de opencode',
    cabecera: cabeceraHtml({ titulo: 'Auditoría de opencode', marca: 'registro de eventos', nav }),
    cuerpo: `<main id="contenido" class="detalle" tabindex="-1">
<form method="get" action="/auditoria" class="consola-barra">
<label>trabajo <input name="jobId" value="${escaparHtml(filtros.jobId ?? '')}"></label>
<label>tipo <select name="tipo">${opciones}</select></label>
<label>desde <input name="desde" value="${escaparHtml(filtros.desde ?? '')}" size="14"></label>
<label>hasta <input name="hasta" value="${escaparHtml(filtros.hasta ?? '')}" size="14"></label>
<button type="submit" class="boton">Filtrar</button>
<a href="/auditoria">Recargar</a>
</form>
${cuerpo}
</main>`,
  });
}

/**
 * Página del pizarrón compartido. El shell es igual al del resto del panel; el
 * contenido lo hidrata `/static/pizarron.js`, que refresca por polling contra
 * `/api/pizarron` (sin escrituras: el panel solo lee el estado del orquestador).
 * @returns {string}
 */
export function paginaPizarron() {
  const nav =
    '<nav class="cabecera-nav" aria-label="Secciones"><a href="/">← Trabajos</a><a href="/auditoria">Auditoría</a></nav>';
  return armazonHtml({
    titulo: 'Pizarrón de opencode',
    cabecera: cabeceraHtml({ titulo: 'Pizarrón de opencode', marca: 'contexto compartido', nav }),
    cuerpo: `<main id="contenido" class="detalle" tabindex="-1">
<p id="pizarron-estado" class="nota" role="status" aria-live="polite">Cargando pizarrón…</p>
<div id="pizarron"></div>
</main>`,
    scripts: '<script type="module" src="/static/pizarron.js"></script>',
  });
}
