/**
 * JavaScript del navegador como string (módulo clásico ES, sin frameworks).
 *
 * POR QUÉ `String.raw`: el código del cliente se conserva tal cual (barras
 * invertidas incluidas) sin tener que escaparlo. El cliente importa las
 * funciones puras desde `/static/lib.js`; el servidor sirve este texto en
 * `/static/app.js` con `text/javascript`.
 *
 * POR QUÉ sin `innerHTML` ni `style=`: la CSP del panel prohíbe el contenido en
 * línea. Todo nodo se crea con `createElement` y el texto se asigna con
 * `textContent`, así que nada leído de disco puede inyectar HTML. El único
 * estilo que se toca desde JS es la variable `--ancho-lista` (CSSOM), necesaria
 * para el divisor arrastrable.
 */
export const CLIENTE = String.raw`import { formatearDuracion, etiquetaEstado, motivoLegible, filtrarTrabajos, contarEstados, contarPorRepo, parsearParche, resumenAlcance, resumenTarea, limitarAnchoLista, anchoListaInicial, agruparTrabajos, tiempoRelativo, ordenarPor, ANCHO_LISTA_MIN, ANCHO_LISTA_MAX } from '/static/lib.js';

const porId = function (id) { return document.getElementById(id); };
const crear = function (etiqueta, clase, texto) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined && texto !== null) nodo.textContent = String(texto);
  return nodo;
};

const TABS = ['resumen', 'consola', 'diff', 'alcance', 'eventos'];
const MAX_LINEAS = 2000;
const MOTIVO_ESPERA = {
  dependencia: 'espera dependencias',
  concurrencia: 'tope de concurrencia',
  recurso: 'espera un recurso compartido',
  solapa_alcance: 'writes solapados con otro trabajo',
  veterano_adelante: 'otro trabajo más antiguo va primero',
  bloqueado_por_dependencia: 'bloqueado por una dependencia',
};

// Claves de preferencias. Se leen/escriben con try/catch: en modo privado o con
// almacenamiento bloqueado la UI debe seguir funcionando en memoria.
const CLAVE_REPO = 'orq.panel.repo';
const CLAVE_ANCHO = 'orq.panel.ancho';
const CLAVE_ORDEN = 'orq.panel.orden';
const CLAVE_DENSIDAD = 'orq.panel.densidad';
const PASO_DIVISOR = 16;

function leerAlmacen(clave) {
  try { return localStorage.getItem(clave); } catch (error) { return null; }
}
function guardarAlmacen(clave, valor) {
  try {
    if (valor === null || valor === undefined) localStorage.removeItem(clave);
    else localStorage.setItem(clave, valor);
  } catch (error) {
    // Sin localStorage la elección vive solo en memoria.
  }
}

// Estado de la aplicación en memoria. La lista se actualiza de forma incremental:
// cada fila existente se reutiliza y solo se pinta de nuevo su contenido, para no
// perder el scroll ni la selección cuando llega una actualización por SSE.
const app = {
  trabajos: [],
  porId: new Map(),
  seleccionado: null,
  seleccionadoInicial: null,
  filtroEstado: 'todos',
  filtroTexto: '',
  filtroRepo: null,
  orden: 'actividad',
  densidad: 'comoda',
  anchoLista: 380,
  tab: 'resumen',
  resumenGlobal: null,
  cargado: {},
  filas: new Map(),
  encabezados: new Map(),
  consola: { id: null, fuente: 'agente', seguir: true, offset: 0, timer: null, lineas: [], total: 0 },
  poll: null,
};

function idCorto(id) { return String(id || '').slice(0, 8); }

function textoEspera(espera) {
  if (!espera) return '';
  const motivo = MOTIVO_ESPERA[espera.motivo] || espera.motivo || '';
  const por = Array.isArray(espera.por) && espera.por.length ? ' [' + espera.por.join(', ') + ']' : '';
  return 'En cola: ' + motivo + por;
}

function anunciar(texto) {
  const region = porId('anuncios');
  if (region) region.textContent = texto;
}

// --- Cabecera ---------------------------------------------------------------

function actualizarTitulo() {
  const resumen = app.resumenGlobal || {};
  const corriendo = resumen.corriendo || 0;
  const total = resumen.total || 0;
  document.title = (corriendo ? corriendo + ' corriendo · ' : '') + total + ' trabajos · opencode-orchestrator';
}

function setConexion(vivo) {
  const caja = porId('conexion');
  if (!caja) return;
  caja.classList.toggle('vivo', vivo);
  caja.classList.toggle('reconectando', !vivo);
  porId('conexion-texto').textContent = vivo ? 'En vivo' : 'Reconectando…';
}

function renderCabecera(resumen) {
  if (!resumen) return;
  app.resumenGlobal = resumen;
  const corriendo = resumen.corriendo || 0;
  const enCola = resumen.enCola || 0;
  const usada = corriendo + (resumen.verificando || 0);
  const maxima = typeof resumen.concurrencia === 'number' && resumen.concurrencia > 0 ? resumen.concurrencia : usada;
  // Siempre visible: «Corriendo n/máx · En cola n» (y en móvil se compacta por CSS).
  porId('contadores').textContent = 'Corriendo ' + usada + '/' + maxima + ' · En cola ' + enCola;
  const caja = porId('concurrencia');
  if (typeof resumen.concurrencia === 'number' && resumen.concurrencia > 0) {
    const barra = document.createElement('progress');
    barra.className = 'barra';
    barra.max = maxima;
    barra.value = Math.min(usada, maxima);
    barra.setAttribute('aria-label', 'Concurrencia usada ' + usada + ' de ' + maxima);
    caja.hidden = false;
    caja.replaceChildren(crear('span', '', 'Corriendo ' + usada + '/' + maxima), barra);
  } else {
    caja.hidden = true;
    caja.replaceChildren();
  }
  actualizarTitulo();
}

// --- Toolbar de la lista ----------------------------------------------------

// Value 'fallidos' se rotula «Problemas» (mismo criterio que la lib pura), para
// que la etiqueta humana y el estado agrupado no se confundan.
const ESTADOS_TOOLBAR = [['todos', 'Todos'], ['activos', 'Activos'], ['fallidos', 'Problemas'], ['terminados', 'Terminados']];

function crearSegmentado() {
  const contenedor = porId('chips');
  if (!contenedor) return;
  contenedor.replaceChildren();
  ESTADOS_TOOLBAR.forEach(function (def) {
    const boton = crear('button', 'chip');
    boton.type = 'button';
    boton.dataset.estado = def[0];
    boton.setAttribute('aria-pressed', def[0] === app.filtroEstado ? 'true' : 'false');
    boton.append(crear('span', '', def[1]), crear('span', 'cuenta', '0'));
    boton.addEventListener('click', function () {
      app.filtroEstado = def[0];
      renderLista();
    });
    contenedor.append(boton);
  });
}

function actualizarSegmentado() {
  const conteos = contarEstados(app.trabajos);
  porId('chips').querySelectorAll('.chip').forEach(function (boton) {
    const clave = boton.dataset.estado;
    boton.setAttribute('aria-pressed', clave === app.filtroEstado ? 'true' : 'false');
    const cuenta = boton.querySelector('.cuenta');
    if (cuenta) cuenta.textContent = String(conteos[clave] || 0);
  });
}

// El repositorio es un <select> (chips aparte se confundían con los de estado).
// Se reconstruye con los conteos actuales y conserva la elección vigente.
function actualizarSelectRepo() {
  const select = porId('filtro-repo');
  if (!select) return;
  const entradas = Array.from(contarPorRepo(app.trabajos).entries())
    .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
  const valor = app.filtroRepo || '';
  select.replaceChildren();
  const todos = crear('option', '', 'Todos los repositorios');
  todos.value = '';
  select.append(todos);
  entradas.forEach(function (entrada) {
    const opcion = crear('option', '', entrada[0] + ' (' + entrada[1] + ')');
    opcion.value = entrada[0];
    select.append(opcion);
  });
  // Si el repo de ?repo= ya no aparece en la lista, igual se ofrece para no perderlo.
  if (valor && !entradas.some(function (entrada) { return entrada[0] === valor; })) {
    const suelto = crear('option', '', valor);
    suelto.value = valor;
    select.append(suelto);
  }
  select.value = valor;
  if (select.value !== valor) select.value = '';
}

function seleccionarRepo(nombre) {
  app.filtroRepo = nombre || null;
  // Se recuerda la elección y se refleja en ?repo= para poder compartir el enlace;
  // el listado se filtra localmente para no perder los contadores del resto.
  guardarAlmacen(CLAVE_REPO, app.filtroRepo);
  try {
    const url = new URL(location.href);
    if (app.filtroRepo) url.searchParams.set('repo', app.filtroRepo);
    else url.searchParams.delete('repo');
    history.replaceState(history.state, '', url);
  } catch (error) {
    // Sin History API no es crítico.
  }
  renderLista();
}

// --- Lista de trabajos ------------------------------------------------------

function trabajosVisibles() {
  const filtrados = filtrarTrabajos(app.trabajos, { estado: app.filtroEstado, texto: app.filtroTexto, repo: app.filtroRepo });
  return ordenarPor(filtrados, app.orden);
}

function horaTitulo(trabajo) {
  const n = Number(trabajo.actividadEn ?? trabajo.creadoEn);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
}

function pintarFila(boton, trabajo) {
  boton.dataset.id = trabajo.id;
  boton.setAttribute('aria-current', trabajo.id === app.seleccionado ? 'true' : 'false');
  const etiqueta = etiquetaEstado(trabajo.estado, trabajo.motivoFin);
  const estado = crear('span', 'trabajo-estado ' + etiqueta.clase);
  estado.append(crear('span', 'icono', etiqueta.icono), crear('span', 'texto-estado', etiqueta.texto));
  const titulo = crear('span', 'trabajo-titulo', trabajo.titulo || trabajo.id);
  titulo.title = trabajo.titulo || trabajo.id;
  const meta = crear('span', 'trabajo-meta');
  meta.append(crear('span', 'trabajo-id', idCorto(trabajo.id)));
  const duracion = crear('span', 'trabajo-duracion', formatearDuracion(trabajo.duracionS));
  duracion.title = 'Duración total';
  meta.append(duracion);
  // Hora relativa legible con el ISO exacto en el title.
  const relativo = tiempoRelativo(trabajo.actividadEn ?? trabajo.creadoEn, Date.now());
  if (relativo) {
    const cuando = crear('span', 'trabajo-actividad', relativo);
    cuando.title = horaTitulo(trabajo);
    meta.append(cuando);
  }
  if (trabajo.semaforo) {
    meta.append(crear('span', 'trabajo-semaforo semaforo-' + trabajo.semaforo, 'sin salida hace ' + formatearDuracion(trabajo.segundosSinSalida)));
  }
  if (trabajo.espera) meta.append(crear('span', 'trabajo-espera', textoEspera(trabajo.espera)));
  if (trabajo.tieneAdvertencias) meta.append(crear('span', 'trabajo-aviso', '⚠ con advertencias'));
  boton.replaceChildren(estado, titulo, meta);
}

function renderLista() {
  const contenedor = porId('trabajos');
  if (!contenedor) return;
  // Preservar el scroll: una actualización por SSE no debe saltar la lista.
  const scrollTop = contenedor.scrollTop;
  const visibles = trabajosVisibles();
  const ids = new Set(visibles.map(function (trabajo) { return trabajo.id; }));
  app.filas.forEach(function (li, id) {
    if (!ids.has(id)) { li.remove(); app.filas.delete(id); }
  });
  const grupos = agruparTrabajos(visibles);
  const nodos = [];
  grupos.forEach(function (grupo) {
    let enc = app.encabezados.get(grupo.clave);
    if (!enc) {
      enc = crear('li', 'grupo-encabezado');
      enc.dataset.clave = grupo.clave;
      enc.append(crear('span', 'grupo-titulo', grupo.etiqueta), crear('span', 'grupo-cuenta', '0'));
      app.encabezados.set(grupo.clave, enc);
    }
    enc.querySelector('.grupo-cuenta').textContent = String(grupo.trabajos.length);
    nodos.push(enc);
    grupo.trabajos.forEach(function (trabajo) {
      let li = app.filas.get(trabajo.id);
      if (!li) {
        li = crear('li', 'fila-trabajo');
        const boton = crear('button', 'trabajo');
        boton.type = 'button';
        boton.addEventListener('click', function () { seleccionar(trabajo.id); });
        li.append(boton);
        app.filas.set(trabajo.id, li);
      }
      pintarFila(li.firstChild, trabajo);
      nodos.push(li);
    });
  });
  // Encabezados de grupos que ya no existen.
  app.encabezados.forEach(function (enc, clave) {
    if (!grupos.some(function (grupo) { return grupo.clave === clave; })) { enc.remove(); app.encabezados.delete(clave); }
  });
  let anterior = null;
  nodos.forEach(function (nodo) {
    if (anterior === null) {
      if (contenedor.firstChild !== nodo) contenedor.prepend(nodo);
    } else if (anterior.nextSibling !== nodo) {
      contenedor.insertBefore(nodo, anterior.nextSibling);
    }
    anterior = nodo;
  });
  porId('lista-vacia').hidden = visibles.length !== 0;
  actualizarSegmentado();
  actualizarSelectRepo();
  contenedor.scrollTop = scrollTop;
  actualizarTitulo();
}

// --- Selección, detalle y navegación ----------------------------------------

function trabajoSeleccionado() {
  for (let i = 0; i < app.trabajos.length; i += 1) {
    if (app.trabajos[i].id === app.seleccionado) return app.trabajos[i];
  }
  return app.porId.get(app.seleccionado) || null;
}

function actualizarResaltado() {
  app.filas.forEach(function (li, filaId) {
    const boton = li.firstChild;
    if (boton) boton.setAttribute('aria-current', filaId === app.seleccionado ? 'true' : 'false');
  });
}

// El estado de navegación vive en la URL (?job=): pushState al elegir y popstate
// para el botón «Atrás» del navegador.
function actualizarUrlSeleccion(id, reemplazar) {
  try {
    const url = new URL(location.href);
    if (id) url.searchParams.set('job', id);
    else url.searchParams.delete('job');
    const estado = { job: id || null };
    if (reemplazar) history.replaceState(estado, '', url);
    else history.pushState(estado, '', url);
  } catch (error) {
    // Sin History API la selección sigue en memoria.
  }
}

function seleccionar(id, opciones) {
  if (!id) return;
  const ajustes = opciones || {};
  const cambio = app.seleccionado !== id;
  if (cambio) {
    app.cargado = {};
    detenerConsola();
    app.consola = { id: null, fuente: 'agente', seguir: true, offset: 0, timer: null, lineas: [], total: 0 };
  }
  app.seleccionado = id;
  document.body.classList.add('detalle-abierto');
  if (ajustes.historial !== false) actualizarUrlSeleccion(id, false);
  actualizarResaltado();
  mostrarDetalle();
  cargarTab(app.tab);
  if (cambio) {
    const li = app.filas.get(id);
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }
}

function limpiarSeleccion() {
  app.seleccionado = null;
  document.body.classList.remove('detalle-abierto');
  actualizarResaltado();
  mostrarDetalle();
}

// Cierra el detalle en móvil y refleja el cambio en la URL; el botón «Atrás» del
// navegador se apoya en popstate (la selección se apila con pushState).
function cerrarDetalle() {
  if (!app.seleccionado) return;
  limpiarSeleccion();
  actualizarUrlSeleccion(null, false);
  const busqueda = porId('filtro-texto');
  if (busqueda) busqueda.focus();
}

function mostrarDetalle() {
  const id = app.seleccionado;
  porId('sin-seleccion').hidden = Boolean(id);
  porId('detalle-trabajo').hidden = !id;
  const volver = porId('volver');
  if (volver) volver.hidden = !id;
  if (!id) return;
  const trabajo = trabajoSeleccionado();
  porId('titulo-trabajo').textContent = trabajo ? (trabajo.titulo || trabajo.id) : id;
  const copiar = porId('copiar-id');
  if (copiar) {
    copiar.hidden = false;
    copiar.dataset.id = id;
  }
  activarTab(app.tab, false);
}

async function copiarId(boton) {
  const id = boton.dataset.id || app.seleccionado || '';
  if (!id) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(id);
    else {
      const area = crear('textarea');
      area.value = id;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    boton.textContent = 'Copiado';
    setTimeout(function () { boton.textContent = 'Copiar id'; }, 1200);
  } catch (error) {
    boton.textContent = 'No se pudo copiar';
  }
}

function activarTab(tab, cargar) {
  if (TABS.indexOf(tab) === -1) return;
  app.tab = tab;
  TABS.forEach(function (nombre) {
    const boton = porId('tab-' + nombre);
    const panel = porId('panel-' + nombre);
    const activo = nombre === tab;
    boton.setAttribute('aria-selected', activo ? 'true' : 'false');
    boton.tabIndex = activo ? 0 : -1;
    panel.hidden = !activo;
  });
  if (cargar !== false && app.seleccionado) cargarTab(tab);
  // POR QUÉ pausar al salir de Consola: no tiene sentido seguir pidiendo el log
  // mientras el usuario mira otra pestaña; se reanuda al volver.
  if (tab !== 'consola') detenerConsola();
}

// POR QUÉ carga perezosa: el diff y los logs son caros; solo se piden al abrir la
// pestaña del trabajo seleccionado, nunca para los demás.
function cargarTab(tab) {
  const id = app.seleccionado;
  if (!id) return;
  const cache = app.cargado[id] || (app.cargado[id] = {});
  if (tab === 'resumen' && !cache.resumen) cargarResumen(id);
  else if (tab === 'consola') iniciarConsola(id);
  else if (tab === 'diff' && !cache.diff) cargarDiff(id);
  else if (tab === 'alcance' && !cache.alcance) cargarAlcance(id);
  else if (tab === 'eventos' && !cache.eventos) cargarEventos(id);
}

// Marca la pestaña como ocupada mientras se pide su contenido (aria-busy) y la
// deja lista con un mensaje de error legible y un botón para reintentar.
function marcarCargando(panel, texto) {
  panel.setAttribute('aria-busy', 'true');
  panel.replaceChildren(crear('p', 'cargando', texto || 'Cargando…'));
}

function mostrarErrorCarga(panel, error, reintentar) {
  panel.removeAttribute('aria-busy');
  panel.replaceChildren();
  const detalle = error && error.message ? error.message : 'error de red';
  panel.append(crear('p', 'error', 'No se pudo cargar: ' + detalle));
  const boton = crear('button', 'boton', 'Reintentar');
  boton.type = 'button';
  boton.addEventListener('click', reintentar);
  panel.append(boton);
}

// --- Pestaña Resumen --------------------------------------------------------

function filaResumen(dl, etiqueta, valor) {
  if (valor === undefined || valor === null || valor === '') return;
  dl.append(crear('dt', '', etiqueta));
  const dd = crear('dd');
  if (valor instanceof Node) dd.append(valor);
  else dd.textContent = String(valor);
  dl.append(dd);
}

// Tarea dentro de <details> cerrado: las primeras líneas como resumen y el texto
// completo al desplegar, para no ocupar media pantalla con un prompt largo.
function bloqueTarea(texto) {
  const detalle = crear('details', 'plegable');
  const resumen = crear('summary');
  resumen.append(crear('span', 'plegable-preview', resumenTarea(texto, 4)));
  resumen.append(crear('span', 'plegable-accion', 'Ver tarea completa'));
  detalle.append(resumen, crear('pre', 'prompt', texto));
  return detalle;
}

// Última salida también plegable: es informativa y no debe empujar lo importante.
function bloqueUltimaSalida(transcript) {
  const detalle = crear('details', 'plegable');
  detalle.append(crear('summary', '', 'Última salida'));
  detalle.append(crear('pre', 'salida', transcript ? transcript.slice(-2000) : '(sin salida todavía)'));
  return detalle;
}

function pintarResumen(panel, trabajo, alcance) {
  const dl = crear('dl', 'resumen');
  const etiqueta = etiquetaEstado(trabajo.estado, trabajo.motivoFin);
  const estado = crear('span', 'trabajo-estado ' + etiqueta.clase);
  estado.append(crear('span', 'icono', etiqueta.icono), crear('span', 'texto-estado', etiqueta.texto));
  // Primero lo importante: estado, por qué terminó, duración, advertencias y
  // resultado de mutaciones/revisión; los metadatos van después.
  filaResumen(dl, 'Estado', estado);
  if (trabajo.motivoFin) filaResumen(dl, 'Motivo de fin', motivoLegible(trabajo.motivoFin));
  filaResumen(dl, 'Duración', formatearDuracion(trabajo.duracionS));
  if (Array.isArray(trabajo.advertencias) && trabajo.advertencias.length) {
    const lista = crear('ul', 'lista-simple');
    trabajo.advertencias.forEach(function (aviso) { lista.append(crear('li', '', String(aviso))); });
    filaResumen(dl, 'Advertencias', lista);
  }
  if (alcance && alcance.mutaciones) {
    filaResumen(dl, 'Mutaciones', (alcance.mutaciones.detectada === undefined ? '?' : alcance.mutaciones.detectada) + '/' + (alcance.mutaciones.total === undefined ? '?' : alcance.mutaciones.total));
  }
  if (alcance && alcance.revision) filaResumen(dl, 'Revisión', alcance.revision.veredicto || JSON.stringify(alcance.revision));
  if (trabajo.modelo) filaResumen(dl, 'Modelo', trabajo.modelo);
  if (trabajo.rama) filaResumen(dl, 'Rama', trabajo.rama);
  if (trabajo.modo) filaResumen(dl, 'Modo', trabajo.modo);
  filaResumen(dl, 'Creado', trabajo.creadoEn ? new Date(trabajo.creadoEn).toLocaleString() : null);
  if (trabajo.finEn) filaResumen(dl, 'Terminado', new Date(trabajo.finEn).toLocaleString());
  if (trabajo.semaforo) filaResumen(dl, 'Semáforo', 'sin salida hace ' + formatearDuracion(trabajo.segundosSinSalida));
  filaResumen(dl, 'Id', trabajo.id);
  panel.append(dl);
  if (trabajo.prompt) {
    panel.append(crear('h3', '', 'Tarea'));
    panel.append(bloqueTarea(trabajo.prompt));
  }
  if (trabajo.fallos) {
    panel.append(crear('h3', '', 'Aceptación: qué falló'));
    panel.append(crear('pre', 'salida', trabajo.fallos));
  }
  panel.append(bloqueUltimaSalida(trabajo.transcript));
}

// El prompt, el transcript y la última salida SOLO viven en el detalle: el listado
// de /api/trabajos es liviano, así que el Resumen pide /api/trabajos/:id al seleccionar.
async function cargarResumen(id) {
  const panel = porId('panel-resumen');
  marcarCargando(panel, 'Cargando resumen…');
  try {
    const respuestas = await Promise.all([
      fetch('/api/trabajos/' + encodeURIComponent(id)),
      fetch('/api/trabajos/' + encodeURIComponent(id) + '/alcance'),
    ]);
    if (!respuestas[0].ok) throw new Error('estado ' + respuestas[0].status);
    const detalle = await respuestas[0].json();
    const cache = app.cargado[id] || (app.cargado[id] = {});
    let alcance = null;
    if (respuestas[1].ok) {
      alcance = await respuestas[1].json();
      cache.alcanceDatos = alcance;
      cache.alcance = true;
    }
    if (app.seleccionado !== id) return;
    panel.removeAttribute('aria-busy');
    panel.replaceChildren();
    pintarResumen(panel, detalle, alcance);
    cache.resumen = true;
  } catch (error) {
    mostrarErrorCarga(panel, error, function () { cargarResumen(id); });
  }
}

// --- Pestaña Consola --------------------------------------------------------

function detenerConsola() {
  if (app.consola.timer) {
    clearInterval(app.consola.timer);
    app.consola.timer = null;
  }
}

function iniciarConsola(id) {
  if (app.consola.id === id && porId('consola-salida')) {
    // Ya está armada: solo reanudar el sondeo si se había pausado al cambiar de pestaña.
    if (!app.consola.timer) app.consola.timer = setInterval(function () { if (app.consola.seguir) leerConsola(id); }, 1500);
    return;
  }
  detenerConsola();
  app.consola = { id: id, fuente: 'agente', seguir: true, offset: 0, timer: null, lineas: [], total: 0 };
  const panel = porId('panel-consola');
  panel.replaceChildren();
  const barra = crear('div', 'consola-barra');
  const etiquetaFuente = crear('label', '', 'Fuente');
  etiquetaFuente.setAttribute('for', 'consola-fuente');
  const selector = crear('select');
  selector.id = 'consola-fuente';
  [['agente', 'Agente'], ['aceptacion', 'Aceptación'], ['stderr', 'stderr de aceptación']].forEach(function (fuente) {
    const opcion = crear('option', '', fuente[1]);
    opcion.value = fuente[0];
    selector.append(opcion);
  });
  selector.addEventListener('change', function () { cambiarFuente(id, selector.value); });
  barra.append(etiquetaFuente, selector);
  const seguir = crear('button', 'boton', 'Pausar');
  seguir.type = 'button';
  seguir.id = 'consola-seguir';
  seguir.setAttribute('aria-pressed', 'true');
  seguir.addEventListener('click', alternarSeguir);
  const copiar = crear('button', 'boton', 'Copiar');
  copiar.type = 'button';
  copiar.addEventListener('click', function () { copiarConsola(copiar); });
  const descargar = crear('button', 'boton', 'Descargar .log');
  descargar.type = 'button';
  descargar.addEventListener('click', function () { descargarConsola(id); });
  barra.append(seguir, copiar, descargar);
  panel.append(barra);
  const aviso = crear('p', 'aviso-lineas');
  aviso.id = 'consola-aviso';
  aviso.hidden = true;
  panel.append(aviso);
  const salida = crear('pre', 'consola-salida mono');
  salida.id = 'consola-salida';
  salida.setAttribute('tabindex', '0');
  salida.setAttribute('aria-label', 'Salida de la consola');
  panel.append(salida);
  leerConsola(id);
  app.consola.timer = setInterval(function () { if (app.consola.seguir) leerConsola(id); }, 1500);
}

function cambiarFuente(id, fuente) {
  app.consola.fuente = fuente;
  app.consola.offset = 0;
  app.consola.lineas = [];
  app.consola.total = 0;
  const salida = porId('consola-salida');
  if (salida) salida.textContent = '';
  leerConsola(id);
}

async function leerConsola(id) {
  if (app.consola.id !== id) return;
  const desde = app.consola.offset;
  try {
    const respuesta = await fetch('/api/trabajos/' + encodeURIComponent(id) + '/log?fuente=' + app.consola.fuente + '&desde=' + desde);
    if (!respuesta.ok) return;
    const datos = await respuesta.json();
    if (app.consola.id !== id) return;
    if (typeof datos.siguiente === 'number') app.consola.offset = datos.siguiente;
    if (datos.texto) agregarLineas(datos.texto);
  } catch (error) {
    // El próximo ciclo reintenta; la consola no debe bloquear el resto de la UI.
  }
}

function agregarLineas(texto) {
  const nuevas = String(texto).split('\n');
  app.consola.lineas = app.consola.lineas.concat(nuevas);
  app.consola.total += nuevas.length;
  const recortadas = app.consola.lineas.length > MAX_LINEAS;
  if (recortadas) app.consola.lineas = app.consola.lineas.slice(app.consola.lineas.length - MAX_LINEAS);
  const salida = porId('consola-salida');
  if (!salida) return;
  salida.textContent = app.consola.lineas.join('\n');
  const aviso = porId('consola-aviso');
  if (aviso) {
    aviso.hidden = !recortadas;
    if (recortadas) aviso.textContent = 'Se muestran las últimas ' + MAX_LINEAS + ' líneas (recibidas ' + app.consola.total + ').';
  }
  if (app.consola.seguir) salida.scrollTop = salida.scrollHeight;
}

function alternarSeguir() {
  app.consola.seguir = !app.consola.seguir;
  const boton = porId('consola-seguir');
  if (boton) {
    boton.textContent = app.consola.seguir ? 'Pausar' : 'Seguir';
    boton.setAttribute('aria-pressed', app.consola.seguir ? 'true' : 'false');
  }
  if (app.consola.seguir) {
    const salida = porId('consola-salida');
    if (salida) salida.scrollTop = salida.scrollHeight;
    leerConsola(app.consola.id);
  }
}

async function copiarConsola(boton) {
  const salida = porId('consola-salida');
  const texto = salida ? salida.textContent : '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(texto);
    else {
      const area = crear('textarea');
      area.value = texto;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    boton.textContent = 'Copiado';
    setTimeout(function () { boton.textContent = 'Copiar'; }, 1200);
  } catch (error) {
    boton.textContent = 'No se pudo copiar';
  }
}

function descargarConsola(id) {
  const salida = porId('consola-salida');
  const blob = new Blob([salida ? salida.textContent : ''], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const enlace = crear('a');
  enlace.href = url;
  enlace.download = id + '-' + app.consola.fuente + '.log';
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}

// --- Pestaña Diff -----------------------------------------------------------

const MARCA_ARCHIVO = { add: ['+', 'estado-add'], del: ['−', 'estado-del'], mod: ['~', 'estado-mod'], rename: ['→', 'estado-ren'] };
const MARCA_GIT = { A: 'add', M: 'mod', D: 'del', R: 'rename', C: 'add' };

function lineaParche(linea) {
  const fila = crear('div', 'linea linea-' + linea.tipo);
  fila.append(crear('span', 'num', linea.n1 === null || linea.n1 === undefined ? '' : String(linea.n1)));
  fila.append(crear('span', 'num', linea.n2 === null || linea.n2 === undefined ? '' : String(linea.n2)));
  const signo = linea.tipo === 'add' ? '+' : linea.tipo === 'del' ? '-' : ' ';
  fila.append(crear('span', 'signo', signo), crear('span', 'texto-linea', linea.texto));
  return fila;
}

function detalleDeArchivo(archivo) {
  const detalle = crear('details', 'archivo');
  const resumen = crear('summary');
  const marca = MARCA_ARCHIVO[archivo.estado] || MARCA_ARCHIVO.mod;
  resumen.append(crear('span', 'archivo-estado ' + marca[1], marca[0]));
  const ruta = archivo.renames && archivo.renames.a ? (archivo.renames.de + ' → ' + archivo.renames.a) : (archivo.nuevo || archivo.viejo || '');
  resumen.append(crear('span', 'archivo-ruta', ruta));
  resumen.append(crear('span', 'archivo-cambios', '+' + archivo.adiciones + ' −' + archivo.eliminaciones));
  detalle.append(resumen);
  if (archivo.binario) detalle.append(crear('p', 'binario', 'Archivo binario.'));
  archivo.hunks.forEach(function (hunk) {
    const cuerpo = crear('div', 'parche');
    cuerpo.append(crear('div', 'hunk-encabezado', hunk.encabezado));
    hunk.lineas.forEach(function (linea) { cuerpo.append(lineaParche(linea)); });
    detalle.append(cuerpo);
  });
  return detalle;
}

function pintarDiff(panel, diff) {
  panel.replaceChildren();
  if (!diff || diff.disponible !== true) {
    panel.append(crear('p', 'nota', 'Diff no disponible (el worktree o la base ya no están).'));
    return;
  }
  if (diff.truncado) panel.append(crear('p', 'aviso-lineas', 'El parche está truncado: se muestra solo una parte.'));
  const archivos = parsearParche(diff.parche || '');
  if (archivos.length === 0 && (!diff.archivos || diff.archivos.length === 0)) {
    panel.append(crear('p', 'nota', 'Sin cambios.'));
    return;
  }
  const contenedor = crear('div', 'diff-archivos');
  const usados = new Set();
  archivos.forEach(function (archivo) {
    contenedor.append(detalleDeArchivo(archivo));
    if (archivo.viejo) usados.add(archivo.viejo);
    if (archivo.nuevo) usados.add(archivo.nuevo);
  });
  (diff.archivos || []).forEach(function (archivo) {
    if (usados.has(archivo.ruta)) return;
    const detalle = crear('details', 'archivo');
    const resumen = crear('summary');
    const estado = MARCA_GIT[archivo.estado] || 'mod';
    const marca = MARCA_ARCHIVO[estado];
    resumen.append(crear('span', 'archivo-estado ' + marca[1], marca[0]));
    resumen.append(crear('span', 'archivo-ruta', archivo.ruta));
    resumen.append(crear('span', 'archivo-cambios', '+' + (archivo.adiciones || 0) + ' −' + (archivo.eliminaciones || 0)));
    detalle.append(resumen, crear('p', 'binario', 'Sin parche de texto.'));
    contenedor.append(detalle);
  });
  panel.append(contenedor);
}

async function cargarDiff(id) {
  const panel = porId('panel-diff');
  marcarCargando(panel, 'Cargando diff…');
  try {
    const respuesta = await fetch('/api/trabajos/' + encodeURIComponent(id) + '/diff');
    if (!respuesta.ok) throw new Error('estado ' + respuesta.status);
    const diff = await respuesta.json();
    if (app.seleccionado !== id) return;
    panel.removeAttribute('aria-busy');
    pintarDiff(panel, diff);
    (app.cargado[id] = app.cargado[id] || {}).diff = true;
  } catch (error) {
    mostrarErrorCarga(panel, error, function () { cargarDiff(id); });
  }
}

// --- Pestaña Alcance --------------------------------------------------------

function listaArchivos(titulo, rutas, fuera) {
  const seccion = crear('section');
  seccion.append(crear('h3', '', titulo));
  if (!rutas || rutas.length === 0) {
    seccion.append(crear('p', 'nota', 'Ninguno.'));
    return seccion;
  }
  const lista = crear('ul');
  rutas.forEach(function (ruta) {
    const li = crear('li');
    const texto = typeof ruta === 'string' ? ruta : ruta.ruta;
    const estado = typeof ruta === 'string' ? '' : (ruta.estado || '');
    if (fuera && fuera.has(texto)) li.className = 'fuera-item';
    li.append(crear('span', '', texto));
    if (estado) li.append(crear('span', 'badge', estado));
    if (fuera && fuera.has(texto)) li.append(crear('span', 'marca-fuera', 'fuera de alcance'));
    lista.append(li);
  });
  seccion.append(lista);
  return seccion;
}

function pintarAlcance(panel, alcance) {
  panel.replaceChildren();
  const resumen = resumenAlcance(alcance);
  panel.append(crear('p', resumen.limpio ? 'nota' : 'error', resumen.texto));
  const fuera = new Set(Array.isArray(alcance.fuera) ? alcance.fuera : []);
  panel.append(listaArchivos('Writes declarados', alcance.writes || []));
  panel.append(listaArchivos('Patrones protegidos', alcance.protegidas || []));
  panel.append(listaArchivos('Archivos tocados', alcance.tocados || [], fuera));
  if (alcance.mutaciones) {
    panel.append(crear('p', 'nota', 'Mutaciones: ' + (alcance.mutaciones.detectada === undefined ? '?' : alcance.mutaciones.detectada) + '/' + (alcance.mutaciones.total === undefined ? '?' : alcance.mutaciones.total)));
  }
  if (alcance.revision) panel.append(crear('p', 'nota', 'Revisión: ' + (alcance.revision.veredicto || JSON.stringify(alcance.revision))));
}

async function cargarAlcance(id) {
  const panel = porId('panel-alcance');
  const cache = app.cargado[id] || (app.cargado[id] = {});
  if (cache.alcanceDatos) {
    cache.alcance = true;
    panel.removeAttribute('aria-busy');
    pintarAlcance(panel, cache.alcanceDatos);
    return;
  }
  marcarCargando(panel, 'Cargando alcance…');
  try {
    const respuesta = await fetch('/api/trabajos/' + encodeURIComponent(id) + '/alcance');
    if (!respuesta.ok) throw new Error('estado ' + respuesta.status);
    const alcance = await respuesta.json();
    if (app.seleccionado !== id) return;
    panel.removeAttribute('aria-busy');
    cache.alcanceDatos = alcance;
    cache.alcance = true;
    pintarAlcance(panel, alcance);
  } catch (error) {
    mostrarErrorCarga(panel, error, function () { cargarAlcance(id); });
  }
}

// --- Pestaña Eventos --------------------------------------------------------

function pintarEventos(panel, eventos) {
  panel.replaceChildren();
  if (!Array.isArray(eventos) || eventos.length === 0) {
    panel.append(crear('p', 'nota', 'Sin eventos registrados.'));
    return;
  }
  const lista = crear('ol', 'eventos');
  eventos.forEach(function (evento) {
    const item = crear('li', 'evento');
    const hora = Number(evento.ts);
    item.append(crear('span', 'evento-hora', Number.isFinite(hora) ? new Date(hora).toLocaleTimeString() : ''));
    item.append(crear('span', 'evento-tipo', evento.tipo || ''));
    const detalle = crear('span');
    if (evento.anterior !== undefined && evento.estado !== undefined) detalle.append(crear('span', 'evento-transicion', evento.anterior + ' → ' + evento.estado + ' '));
    else if (evento.estado !== undefined) detalle.append(crear('span', 'evento-transicion', evento.estado + ' '));
    if (evento.motivo) detalle.append(crear('span', 'evento-motivo', motivoLegible(evento.motivo)));
    item.append(detalle);
    lista.append(item);
  });
  panel.append(lista);
}

async function cargarEventos(id) {
  const panel = porId('panel-eventos');
  marcarCargando(panel, 'Cargando eventos…');
  try {
    const respuesta = await fetch('/api/trabajos/' + encodeURIComponent(id) + '/eventos');
    if (!respuesta.ok) throw new Error('estado ' + respuesta.status);
    const eventos = await respuesta.json();
    if (app.seleccionado !== id) return;
    panel.removeAttribute('aria-busy');
    pintarEventos(panel, eventos);
    (app.cargado[id] = app.cargado[id] || {}).eventos = true;
  } catch (error) {
    mostrarErrorCarga(panel, error, function () { cargarEventos(id); });
  }
}

// --- Datos y conexión -------------------------------------------------------

function anunciarCambios(previos, actuales) {
  actuales.forEach(function (trabajo) {
    const anterior = previos.get(trabajo.id);
    if (anterior && anterior.estado !== trabajo.estado) {
      anunciar('Trabajo ' + (trabajo.titulo || trabajo.id) + ': ' + anterior.estado + ' → ' + trabajo.estado);
    }
  });
}

function fusionarTrabajos(cambiados) {
  const previos = app.porId;
  (cambiados || []).forEach(function (trabajo) {
    if (!trabajo || !trabajo.id) return;
    const indice = app.trabajos.findIndex(function (t) { return t.id === trabajo.id; });
    if (indice === -1) app.trabajos.push(trabajo);
    else app.trabajos[indice] = trabajo;
  });
  app.porId = new Map(app.trabajos.map(function (t) { return [t.id, t]; }));
  anunciarCambios(previos, cambiados || []);
  renderLista();
}

async function cargarTodo() {
  try {
    const respuesta = await fetch('/api/trabajos');
    const datos = await respuesta.json();
    const previos = app.porId;
    app.trabajos = Array.isArray(datos.trabajos) ? datos.trabajos : [];
    app.porId = new Map(app.trabajos.map(function (t) { return [t.id, t]; }));
    anunciarCambios(previos, app.trabajos);
    renderLista();
    renderCabecera(await (await fetch('/api/estado')).json());
    // La selección de la URL se carga recién cuando llega la lista; si el trabajo
    // no está en la lista igual se pide su detalle por /api/trabajos/:id.
    const objetivo = app.seleccionado || app.seleccionadoInicial;
    app.seleccionadoInicial = null;
    if (objetivo && app.seleccionado !== objetivo) seleccionar(objetivo, { historial: false });
    else if (objetivo) mostrarDetalle();
    else if (app.trabajos.length) {
      seleccionar(app.trabajos[0].id, { historial: false });
      actualizarUrlSeleccion(app.trabajos[0].id, true);
    }
  } catch (error) {
    setConexion(false);
  }
}

function empezarPolling() {
  if (app.poll) return;
  app.poll = setInterval(cargarTodo, 3000);
}

function detenerPolling() {
  if (app.poll) {
    clearInterval(app.poll);
    app.poll = null;
  }
}

function conectar() {
  if (typeof EventSource === 'undefined') {
    empezarPolling();
    return;
  }
  const fuente = new EventSource('/api/stream');
  fuente.addEventListener('open', function () { setConexion(true); detenerPolling(); });
  fuente.addEventListener('error', function () { setConexion(false); empezarPolling(); });
  fuente.addEventListener('trabajos', function (evento) {
    try { fusionarTrabajos(JSON.parse(evento.data).cambiados); } catch (error) { /* mensaje ajeno: se ignora */ }
  });
  fuente.addEventListener('estado', function (evento) {
    try { renderCabecera(JSON.parse(evento.data)); } catch (error) { /* mensaje ajeno: se ignora */ }
  });
}

// --- Divisor ajustable ------------------------------------------------------

function aplicarAnchoLista(ancho) {
  const valor = limitarAnchoLista(ancho);
  app.anchoLista = valor;
  const cuerpo = porId('cuerpo');
  if (cuerpo) cuerpo.style.setProperty('--ancho-lista', valor + 'px');
  const divisor = porId('divisor');
  if (divisor) divisor.setAttribute('aria-valuenow', String(valor));
  return valor;
}

function iniciarDivisor() {
  const divisor = porId('divisor');
  const cuerpo = porId('cuerpo');
  if (!divisor || !cuerpo) return;
  const recordar = function () { guardarAlmacen(CLAVE_ANCHO, String(app.anchoLista)); };
  let arrastrando = false;
  divisor.addEventListener('pointerdown', function (evento) {
    arrastrando = true;
    evento.preventDefault();
    if (divisor.setPointerCapture) divisor.setPointerCapture(evento.pointerId);
  });
  divisor.addEventListener('pointermove', function (evento) {
    if (!arrastrando) return;
    const borde = cuerpo.getBoundingClientRect().left;
    aplicarAnchoLista(evento.clientX - borde);
  });
  const soltar = function (evento) {
    if (!arrastrando) return;
    arrastrando = false;
    recordar();
    if (divisor.releasePointerCapture) {
      try { divisor.releasePointerCapture(evento.pointerId); } catch (error) { /* ya liberado */ }
    }
  };
  divisor.addEventListener('pointerup', soltar);
  divisor.addEventListener('pointercancel', soltar);
  divisor.addEventListener('keydown', function (evento) {
    if (evento.key === 'ArrowLeft') { evento.preventDefault(); aplicarAnchoLista(app.anchoLista - PASO_DIVISOR); recordar(); }
    else if (evento.key === 'ArrowRight') { evento.preventDefault(); aplicarAnchoLista(app.anchoLista + PASO_DIVISOR); recordar(); }
    else if (evento.key === 'Home') { evento.preventDefault(); aplicarAnchoLista(ANCHO_LISTA_MIN); recordar(); }
    else if (evento.key === 'End') { evento.preventDefault(); aplicarAnchoLista(ANCHO_LISTA_MAX); recordar(); }
  });
  // Doble clic: vuelve al ancho por defecto para la ventana actual.
  divisor.addEventListener('dblclick', function () { aplicarAnchoLista(anchoListaInicial(window.innerWidth)); recordar(); });
}

function aplicarDensidad() {
  const cuerpo = porId('cuerpo');
  const compacta = app.densidad === 'compacta';
  if (cuerpo) cuerpo.classList.toggle('densidad-compacta', compacta);
  const boton = porId('densidad');
  if (boton) {
    boton.textContent = compacta ? 'Compacta' : 'Cómoda';
    boton.setAttribute('aria-pressed', compacta ? 'true' : 'false');
  }
}

// --- Teclado ----------------------------------------------------------------

function moverSeleccion(delta, conservarFoco) {
  const visibles = trabajosVisibles();
  if (visibles.length === 0) return;
  let indice = visibles.findIndex(function (trabajo) { return trabajo.id === app.seleccionado; });
  indice = indice === -1 ? 0 : Math.max(0, Math.min(visibles.length - 1, indice + delta));
  seleccionar(visibles[indice].id);
  if (conservarFoco) {
    // Navegar con j/k mientras se escribe en la búsqueda: el foco se queda ahí.
    const busqueda = porId('filtro-texto');
    if (busqueda) busqueda.focus();
    return;
  }
  const li = app.filas.get(visibles[indice].id);
  if (li && li.firstChild) li.firstChild.focus();
}

function abrirAyuda() {
  const dialogo = porId('dialogo-ayuda');
  if (dialogo && typeof dialogo.showModal === 'function') dialogo.showModal();
}

function enCampoDeTexto(elemento) {
  if (!elemento) return false;
  const etiqueta = elemento.tagName;
  return etiqueta === 'INPUT' || etiqueta === 'TEXTAREA' || etiqueta === 'SELECT' || elemento.isContentEditable === true;
}

function atajos(evento) {
  // Alt+← vuelve a la lista (maestro-detalle), sin depender del foco.
  if (evento.altKey && evento.key === 'ArrowLeft') { evento.preventDefault(); cerrarDetalle(); return; }
  // Escape cierra el detalle solo en móvil y fuera de un campo de texto.
  if (evento.key === 'Escape' && app.seleccionado && !enCampoDeTexto(evento.target)) {
    const dialogo = porId('dialogo-ayuda');
    if (!(dialogo && dialogo.open)) { cerrarDetalle(); return; }
  }
  if (evento.altKey || evento.ctrlKey || evento.metaKey) return;
  const campo = enCampoDeTexto(evento.target);
  const enBusqueda = evento.target === porId('filtro-texto');
  if (evento.key === '/' && !campo) { evento.preventDefault(); porId('filtro-texto').focus(); return; }
  if (evento.key === '?' && !campo) { evento.preventDefault(); abrirAyuda(); return; }
  // j/k navegan la lista AUN con el foco en la búsqueda (y no lo pierden): así se
  // filtra y se recorre el resultado en el mismo gesto.
  if (evento.key === 'j' || evento.key === 'k') {
    if (campo && !enBusqueda) return;
    evento.preventDefault();
    moverSeleccion(evento.key === 'j' ? 1 : -1, enBusqueda);
    return;
  }
  if (campo) return;
  if (evento.key === 'f') { evento.preventDefault(); alternarSeguir(); return; }
  if (evento.key >= '1' && evento.key <= '5') { evento.preventDefault(); activarTab(TABS[Number(evento.key) - 1]); }
}

function flechasTab(evento) {
  if (evento.key !== 'ArrowRight' && evento.key !== 'ArrowLeft' && evento.key !== 'Home' && evento.key !== 'End') return;
  evento.preventDefault();
  let indice = TABS.indexOf(app.tab);
  if (evento.key === 'Home') indice = 0;
  else if (evento.key === 'End') indice = TABS.length - 1;
  else indice = (indice + (evento.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
  activarTab(TABS[indice]);
  porId('tab-' + TABS[indice]).focus();
}

// --- Arranque ---------------------------------------------------------------

function iniciar() {
  crearSegmentado();
  // Restaurar preferencias persistidas (leerAlmacen ya trae try/catch).
  const ordenGuardado = leerAlmacen(CLAVE_ORDEN);
  if (ordenGuardado === 'actividad' || ordenGuardado === 'estado' || ordenGuardado === 'creacion') app.orden = ordenGuardado;
  app.densidad = leerAlmacen(CLAVE_DENSIDAD) === 'compacta' ? 'compacta' : 'comoda';
  const anchoGuardado = Number(leerAlmacen(CLAVE_ANCHO));
  app.anchoLista = Number.isFinite(anchoGuardado) && anchoGuardado > 0 ? limitarAnchoLista(anchoGuardado) : anchoListaInicial(window.innerWidth);
  aplicarAnchoLista(app.anchoLista);
  aplicarDensidad();
  const selectOrden = porId('orden');
  if (selectOrden) {
    selectOrden.value = app.orden;
    selectOrden.addEventListener('change', function () {
      app.orden = selectOrden.value;
      guardarAlmacen(CLAVE_ORDEN, app.orden);
      renderLista();
    });
  }
  const botonDensidad = porId('densidad');
  if (botonDensidad) botonDensidad.addEventListener('click', function () {
    app.densidad = app.densidad === 'compacta' ? 'comoda' : 'compacta';
    guardarAlmacen(CLAVE_DENSIDAD, app.densidad);
    aplicarDensidad();
  });
  const selectRepo = porId('filtro-repo');
  if (selectRepo) selectRepo.addEventListener('change', function () { seleccionarRepo(selectRepo.value || null); });
  const busqueda = porId('filtro-texto');
  const limpiar = porId('limpiar-busqueda');
  const sincronizarLimpiar = function () { if (limpiar) limpiar.hidden = busqueda.value === ''; };
  busqueda.addEventListener('input', function () { app.filtroTexto = busqueda.value; sincronizarLimpiar(); renderLista(); });
  if (limpiar) limpiar.addEventListener('click', function () {
    busqueda.value = '';
    app.filtroTexto = '';
    sincronizarLimpiar();
    renderLista();
    busqueda.focus();
  });
  sincronizarLimpiar();
  const volver = porId('volver');
  if (volver) volver.addEventListener('click', cerrarDetalle);
  const tablist = document.querySelector('.tabs');
  if (tablist) tablist.addEventListener('keydown', flechasTab);
  TABS.forEach(function (tab) {
    porId('tab-' + tab).addEventListener('click', function () { activarTab(tab); });
  });
  const ayuda = porId('ayuda');
  if (ayuda) ayuda.addEventListener('click', abrirAyuda);
  const copiar = porId('copiar-id');
  if (copiar) copiar.addEventListener('click', function () { copiarId(copiar); });
  document.addEventListener('keydown', atajos);
  // El botón «Atrás» del navegador mueve la selección leyendo el estado/URL.
  window.addEventListener('popstate', function (evento) {
    let id = evento.state && evento.state.job ? evento.state.job : null;
    if (!id) {
      try { id = new URLSearchParams(location.search).get('job'); } catch (error) { id = null; }
    }
    if (id) seleccionar(id, { historial: false });
    else limpiarSeleccion();
  });
  iniciarDivisor();
  const parametros = new URLSearchParams(location.search);
  app.seleccionadoInicial = parametros.get('job');
  // El parámetro ?repo= manda sobre lo recordado; si no, se recupera la última elección.
  app.filtroRepo = parametros.get('repo');
  if (!app.filtroRepo) app.filtroRepo = leerAlmacen(CLAVE_REPO);
  try { history.replaceState({ job: app.seleccionadoInicial || null }, '', location.href); } catch (error) { /* sin History API */ }
  cargarTodo();
  conectar();
}

iniciar();
`;
