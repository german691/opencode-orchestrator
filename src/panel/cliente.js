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
export const CLIENTE = String.raw`import { formatearDuracion, etiquetaEstado, motivoLegible, filtrarTrabajos, contarEstados, contarPorRepo, parsearParche, resumenAlcance, resumenTarea, limitarAnchoLista, anchoListaInicial, agruparTrabajos, tiempoRelativo, ordenarPor, segmentosDeLinea, coincidenciasEnLineas, estadisticasDeParche, claseDeLinea, debePausarSeguimiento, ANCHO_LISTA_MIN, ANCHO_LISTA_MAX } from '/static/lib.js';

const porId = function (id) { return document.getElementById(id); };
// Lectura TOLERANTE del DOM: un elemento ausente (p. ej. una cabecera recortada o
// un shell sin hidratar) nunca debe cortar la carga con un TypeError.
const conElemento = function (id, fn) {
  const nodo = porId(id);
  if (!nodo) return null;
  return fn(nodo);
};
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
const CLAVE_ENVOLVER = 'orq.panel.envolver';
const CLAVE_TAMANO = 'orq.panel.tamano';
const PASO_DIVISOR = 16;
const TAMANO_MIN = 12;
const TAMANO_MAX = 18;
const MAX_LINEAS_ARCHIVO = 400;

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
  // Pestaña activa por trabajo y scroll por pestaña+trabajo: al volver a un
  // trabajo (o a una pestaña) se restaura dónde estaba el usuario.
  tabsPorTrabajo: {},
  scrolls: {},
  resumenGlobal: null,
  cargado: {},
  filas: new Map(),
  encabezados: new Map(),
  consola: {
    id: null, fuente: 'agente', seguir: true, offset: 0, timer: null, lineas: [], total: 0,
    envolver: true, tamano: 12, consulta: '', coincidencias: [], activa: -1,
    nuevas: 0, actualizadoEn: null,
  },
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
  conElemento('conexion', function (caja) {
    caja.classList.toggle('vivo', vivo);
    caja.classList.toggle('reconectando', !vivo);
  });
  conElemento('conexion-texto', function (texto) { texto.textContent = vivo ? 'En vivo' : 'Reconectando…'; });
}

function renderCabecera(resumen) {
  if (!resumen) return;
  app.resumenGlobal = resumen;
  const corriendo = resumen.corriendo || 0;
  const enCola = resumen.enCola || 0;
  const usada = corriendo + (resumen.verificando || 0);
  const maxima = typeof resumen.concurrencia === 'number' && resumen.concurrencia > 0 ? resumen.concurrencia : usada;
  // Siempre visible: «Corriendo n/máx · En cola n» (y en móvil se compacta por CSS).
  conElemento('contadores', function (nodo) {
    nodo.textContent = 'Corriendo ' + usada + '/' + maxima + ' · En cola ' + enCola;
  });
  conElemento('concurrencia', function (caja) {
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
  });
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

// Cada pestaña scrollea por su cuenta: guardar/restaurar por trabajo evita perder
// la posición al cambiar de pestaña o de trabajo y volver.
function guardarScrollActual() {
  const id = app.seleccionado;
  if (!id) return;
  const registro = app.scrolls[id] || (app.scrolls[id] = {});
  const panel = porId('panel-' + app.tab);
  // Solo se guarda lo que estaba visible: llamadas de re-render no deben pisar
  // la posición recordada con el scroll en 0 de un panel recién oculto.
  if (panel && !panel.hidden) registro[app.tab] = panel.scrollTop;
  if (app.tab === 'consola') {
    const salida = porId('consola-salida');
    if (salida) registro['consola-salida'] = salida.scrollTop;
  }
}

function restaurarScroll(id, tab) {
  const registro = (id && app.scrolls[id]) || {};
  const panel = porId('panel-' + tab);
  if (panel && typeof registro[tab] === 'number') panel.scrollTop = registro[tab];
  if (tab === 'consola') {
    const salida = porId('consola-salida');
    const valor = registro['consola-salida'];
    // Con el seguimiento activo el final manda; pausado, se respeta lo guardado.
    if (salida && typeof valor === 'number' && !app.consola.seguir) salida.scrollTop = valor;
  }
}

function seleccionar(id, opciones) {
  if (!id) return;
  const ajustes = opciones || {};
  const cambio = app.seleccionado !== id;
  if (cambio) {
    if (app.seleccionado) {
      app.tabsPorTrabajo[app.seleccionado] = app.tab;
      guardarScrollActual();
    }
    app.cargado = {};
    detenerConsola();
    app.consola = {
      id: null, fuente: 'agente', seguir: true, offset: 0, timer: null, lineas: [], total: 0,
      envolver: app.consola.envolver, tamano: app.consola.tamano, consulta: '',
      coincidencias: [], activa: -1, nuevas: 0, actualizadoEn: null,
    };
    // Resumen por defecto la primera vez; después, la última pestaña de ese trabajo.
    app.tab = app.tabsPorTrabajo[id] || 'resumen';
  }
  app.seleccionado = id;
  document.body.classList.add('detalle-abierto');
  if (ajustes.historial !== false) actualizarUrlSeleccion(id, false);
  actualizarResaltado();
  mostrarDetalle();
  actualizarEtiquetasTabs(id);
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
  conElemento('sin-seleccion', function (nodo) { nodo.hidden = Boolean(id); });
  conElemento('detalle-trabajo', function (nodo) { nodo.hidden = !id; });
  const volver = porId('volver');
  if (volver) volver.hidden = !id;
  if (!id) return;
  const trabajo = trabajoSeleccionado();
  conElemento('titulo-trabajo', function (nodo) {
    nodo.textContent = trabajo ? (trabajo.titulo || trabajo.id) : id;
  });
  const copiar = porId('copiar-id');
  if (copiar) {
    copiar.hidden = false;
    copiar.dataset.id = id;
  }
  activarTab(app.tab, false);
}

// Copia texto al portapapeles con fallback y restaura la etiqueta del botón.
async function copiarTexto(texto, boton, etiqueta) {
  const original = etiqueta || boton.textContent || 'Copiar';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(String(texto));
    else {
      const area = crear('textarea');
      area.value = String(texto);
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    boton.textContent = 'Copiado';
  } catch (error) {
    boton.textContent = 'No se pudo copiar';
  }
  setTimeout(function () { boton.textContent = original; }, 1200);
}

function copiarId(boton) {
  const id = boton.dataset.id || app.seleccionado || '';
  if (!id) return;
  copiarTexto(id, boton, 'Copiar id');
}

function activarTab(tab, cargar) {
  if (TABS.indexOf(tab) === -1) return;
  if (app.seleccionado) guardarScrollActual();
  app.tab = tab;
  if (app.seleccionado) app.tabsPorTrabajo[app.seleccionado] = tab;
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
  if (app.seleccionado) restaurarScroll(app.seleccionado, tab);
}

// Etiquetas de pestaña con contadores baratos: se usan los datos YA cargados y
// nunca se dispara un pedido nuevo solo para numerar la pestaña.
const TAB_BASE = { resumen: 'Resumen', consola: 'Consola', diff: 'Diff', alcance: 'Alcance', eventos: 'Eventos' };

function actualizarEtiquetasTabs(id) {
  const objetivo = id || app.seleccionado;
  const cache = (objetivo && app.cargado[objetivo]) || {};
  TABS.forEach(function (tab) {
    const boton = porId('tab-' + tab);
    if (!boton) return;
    let texto = TAB_BASE[tab];
    let aria = null;
    if (tab === 'diff' && typeof cache.nDiff === 'number') {
      texto = 'Diff ' + cache.nDiff;
      aria = 'Diff, ' + cache.nDiff + ' archivo(s)';
    } else if (tab === 'eventos' && typeof cache.nEventos === 'number') {
      texto = 'Eventos ' + cache.nEventos;
      aria = 'Eventos, ' + cache.nEventos + ' evento(s)';
    } else if (tab === 'alcance' && cache.nFuera) {
      // El aviso de alcance solo aparece cuando HAY archivos fuera; sin ruido.
      texto = 'Alcance ⚠';
      aria = 'Alcance, ' + cache.nFuera + ' archivo(s) fuera de alcance';
    }
    boton.textContent = texto;
    if (aria) boton.setAttribute('aria-label', aria);
    else boton.removeAttribute('aria-label');
  });
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

// Mientras carga se muestra un esqueleto (no un texto pelado) con el texto
// accesible para lectores de pantalla; aria-busy marca la región ocupada.
function marcarCargando(panel, texto) {
  panel.setAttribute('aria-busy', 'true');
  panel.replaceChildren();
  const estado = crear('p', 'sr-only', texto || 'Cargando…');
  estado.setAttribute('role', 'status');
  const esqueleto = crear('div', 'esqueleto');
  esqueleto.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i += 1) esqueleto.append(crear('div', 'esqueleto-linea'));
  panel.append(estado, esqueleto);
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

// Tarjeta compacta de la franja superior del Resumen.
function tarjeta(etiqueta, valor, claseValor) {
  const caja = crear('div', 'tarjeta');
  caja.append(crear('span', 'tarjeta-etiqueta', etiqueta));
  const contenido = crear('span', claseValor ? 'tarjeta-valor ' + claseValor : 'tarjeta-valor');
  if (valor instanceof Node) contenido.append(valor);
  else contenido.textContent = String(valor);
  caja.append(contenido);
  return caja;
}

// Caja con título para avisos y resultados (advertencias, mutaciones, revisión…).
function cajaConTitulo(titulo, clase, contenido) {
  const caja = crear('section', clase ? 'caja ' + clase : 'caja');
  caja.append(crear('h3', 'caja-titulo', titulo));
  if (contenido instanceof Node) caja.append(contenido);
  else caja.append(crear('p', '', String(contenido)));
  return caja;
}

// Botón de copiar genérico, con la etiqueta original para restaurarla.
function botonCopiar(texto, etiqueta) {
  const boton = crear('button', 'boton boton-mini', etiqueta);
  boton.type = 'button';
  boton.addEventListener('click', function () { copiarTexto(texto, boton, etiqueta); });
  return boton;
}

// Tarea dentro de <details> cerrado: las primeras líneas como resumen y el texto
// completo al desplegar, con alto máximo y scroll interno.
function bloqueTarea(texto) {
  const detalle = crear('details', 'plegable');
  const resumen = crear('summary');
  resumen.append(crear('span', 'plegable-preview', resumenTarea(texto, 4)));
  resumen.append(crear('span', 'plegable-accion', 'Ver tarea completa'));
  detalle.append(resumen, crear('pre', 'prompt', texto));
  return detalle;
}

// Última salida plegable SOLO si hay algo: sin salida no se muestra un bloque vacío.
function bloqueUltimaSalida(transcript) {
  const texto = String(transcript || '');
  if (texto.trim() === '') return null;
  const detalle = crear('details', 'plegable');
  detalle.append(crear('summary', '', 'Última salida'));
  detalle.append(crear('pre', 'salida', texto.slice(-2000)));
  return detalle;
}

function pintarResumen(panel, trabajo, alcance) {
  panel.replaceChildren();
  const etiqueta = etiquetaEstado(trabajo.estado, trabajo.motivoFin);
  const estado = crear('span', 'trabajo-estado ' + etiqueta.clase);
  estado.append(crear('span', 'icono', etiqueta.icono), crear('span', 'texto-estado', etiqueta.texto));

  // Franja de datos clave como tarjetas compactas: primero lo esencial.
  const franja = crear('div', 'tarjetas-resumen');
  franja.append(tarjeta('Estado', estado));
  franja.append(tarjeta('Duración', formatearDuracion(trabajo.duracionS)));
  if (trabajo.repoNombre) franja.append(tarjeta('Repositorio', trabajo.repoNombre));
  if (trabajo.modelo) franja.append(tarjeta('Modelo', trabajo.modelo));
  if (trabajo.rama) {
    const rama = crear('span', 'tarjeta-rama');
    rama.append(crear('span', 'mono', trabajo.rama));
    rama.append(botonCopiar(trabajo.rama, 'Copiar rama'));
    franja.append(tarjeta('Rama', rama));
  }
  panel.append(franja);

  // Acciones del resumen: copiar y saltar a la consola sin tocar la cabecera.
  const acciones = crear('div', 'resumen-acciones');
  acciones.append(botonCopiar(trabajo.id, 'Copiar id'));
  const abrirConsola = crear('button', 'boton', 'Abrir consola');
  abrirConsola.type = 'button';
  abrirConsola.addEventListener('click', function () { activarTab('consola'); });
  acciones.append(abrirConsola);
  panel.append(acciones);

  // Avisos y resultados, cada uno en su caja y sin bloques vacíos.
  if (trabajo.motivoFin) {
    panel.append(cajaConTitulo('Motivo de fin', 'caja-aviso', motivoLegible(trabajo.motivoFin)));
  }
  if (Array.isArray(trabajo.advertencias) && trabajo.advertencias.length) {
    const lista = crear('ul', 'lista-simple');
    trabajo.advertencias.forEach(function (aviso) { lista.append(crear('li', '', String(aviso))); });
    panel.append(cajaConTitulo('Advertencias', 'caja-aviso', lista));
  }
  if (alcance && alcance.mutaciones) {
    const valor = (alcance.mutaciones.detectada === undefined ? '?' : alcance.mutaciones.detectada) + '/' + (alcance.mutaciones.total === undefined ? '?' : alcance.mutaciones.total);
    panel.append(cajaConTitulo('Mutaciones', null, valor));
  }
  if (alcance && alcance.revision) {
    panel.append(cajaConTitulo('Revisión', null, alcance.revision.veredicto || JSON.stringify(alcance.revision)));
  }
  if (trabajo.fallos) {
    panel.append(cajaConTitulo('Aceptación: qué falló', 'caja-aviso', crear('pre', 'salida', trabajo.fallos)));
  }

  if (trabajo.prompt) {
    panel.append(crear('h3', '', 'Tarea'));
    panel.append(bloqueTarea(trabajo.prompt));
  }
  const ultima = bloqueUltimaSalida(trabajo.transcript);
  if (ultima) {
    panel.append(crear('h3', '', 'Última salida'));
    panel.append(ultima);
  }
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
      cache.nFuera = Array.isArray(alcance.fuera) ? alcance.fuera.length : 0;
    }
    // Conteo barato de archivos del diff desde el detalle ya recibido (el parche
    // completo solo se pide al abrir Diff, que después pisa este número).
    if (typeof cache.nDiff !== 'number' && Array.isArray(detalle.archivos)) {
      cache.nDiff = detalle.archivos.length;
    }
    if (app.seleccionado !== id) return;
    panel.removeAttribute('aria-busy');
    panel.replaceChildren();
    pintarResumen(panel, detalle, alcance);
    cache.resumen = true;
    actualizarEtiquetasTabs(id);
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

// ¿El foco está dentro de la consola? Se usa para el atajo «/» y Ctrl/Cmd+F.
function estaEnConsola(nodo) {
  return Boolean(nodo && nodo.closest && nodo.closest('#panel-consola'));
}

function enfocarBusquedaConsola() {
  const buscar = porId('consola-buscar');
  if (!buscar) return;
  buscar.focus();
  buscar.select();
}

function iniciarConsola(id) {
  if (app.consola.id === id && porId('consola-salida')) {
    // Ya está armada: reanudar el sondeo si se había pausado al cambiar de pestaña.
    actualizarControlesConsola();
    if (!app.consola.timer) app.consola.timer = setInterval(function () { if (app.consola.seguir) leerConsola(id); }, 1500);
    return;
  }
  detenerConsola();
  app.consola = {
    id: id, fuente: 'agente', seguir: true, offset: 0, timer: null, lineas: [], total: 0,
    envolver: app.consola.envolver, tamano: app.consola.tamano, consulta: '',
    coincidencias: [], activa: -1, nuevas: 0, actualizadoEn: null,
  };
  const panel = porId('panel-consola');
  panel.replaceChildren();
  panel.classList.add('consola-panel');

  // Barra compacta y sticky: los controles no se van con el scroll de la salida.
  const barra = crear('div', 'consola-barra');
  const etiquetaFuente = crear('label', 'oculto', 'Fuente');
  etiquetaFuente.setAttribute('for', 'consola-fuente');
  const selector = crear('select', 'consola-selector');
  selector.id = 'consola-fuente';
  [['agente', 'Agente'], ['aceptacion', 'Aceptación'], ['stderr', 'stderr de aceptación']].forEach(function (fuente) {
    const opcion = crear('option', '', fuente[1]);
    opcion.value = fuente[0];
    selector.append(opcion);
  });
  selector.value = app.consola.fuente;
  selector.addEventListener('change', function () { cambiarFuente(id, selector.value); });

  const seguir = crear('button', 'boton', 'Pausar');
  seguir.type = 'button';
  seguir.id = 'consola-seguir';
  seguir.setAttribute('aria-pressed', 'true');
  seguir.addEventListener('click', alternarSeguir);

  const ajustar = crear('button', 'boton', 'Ajustar líneas');
  ajustar.type = 'button';
  ajustar.id = 'consola-ajustar';
  ajustar.setAttribute('aria-pressed', app.consola.envolver ? 'true' : 'false');
  ajustar.addEventListener('click', function () {
    app.consola.envolver = !app.consola.envolver;
    guardarAlmacen(CLAVE_ENVOLVER, app.consola.envolver ? '1' : '0');
    aplicarEnvolturaConsola();
  });

  const menos = crear('button', 'boton boton-mini', 'A−');
  menos.type = 'button';
  menos.setAttribute('aria-label', 'Reducir tamaño de fuente');
  menos.addEventListener('click', function () { cambiarTamanoConsola(-1); });
  const mas = crear('button', 'boton boton-mini', 'A+');
  mas.type = 'button';
  mas.setAttribute('aria-label', 'Aumentar tamaño de fuente');
  mas.addEventListener('click', function () { cambiarTamanoConsola(1); });
  const tamano = crear('span', 'consola-tamano');
  tamano.id = 'consola-tamano';

  const copiar = crear('button', 'boton', 'Copiar');
  copiar.type = 'button';
  copiar.addEventListener('click', function () { copiarConsola(copiar); });
  const descargar = crear('button', 'boton', 'Descargar .log');
  descargar.type = 'button';
  descargar.addEventListener('click', function () { descargarConsola(id); });

  const buscar = crear('input', 'consola-buscar');
  buscar.id = 'consola-buscar';
  buscar.type = 'search';
  buscar.placeholder = 'Buscar en la consola';
  buscar.setAttribute('aria-label', 'Buscar en la consola');
  buscar.addEventListener('input', function () {
    app.consola.consulta = buscar.value;
    actualizarCoincidencias(true);
    resaltarCoincidenciaActiva(true);
  });
  buscar.addEventListener('keydown', function (evento) {
    // Enter/Shift+Enter recorren las coincidencias sin salir del campo.
    if (evento.key === 'Enter') { evento.preventDefault(); navegarCoincidencia(evento.shiftKey ? -1 : 1); }
    else if (evento.key === 'Escape') { evento.preventDefault(); buscar.value = ''; app.consola.consulta = ''; actualizarCoincidencias(true); }
  });
  const conteo = crear('span', 'consola-coincidencias');
  conteo.id = 'consola-coincidencias';
  conteo.setAttribute('aria-live', 'polite');

  barra.append(etiquetaFuente, selector, seguir, ajustar, menos, tamano, mas, copiar, descargar, buscar, conteo);
  panel.append(barra);

  // El cuerpo ocupa TODA la altura restante; el scroll vive dentro de la salida.
  const cuerpo = crear('div', 'consola-cuerpo');
  const salida = crear('pre', 'consola-salida mono');
  salida.id = 'consola-salida';
  salida.setAttribute('tabindex', '0');
  salida.setAttribute('aria-label', 'Salida de la consola');
  salida.addEventListener('scroll', alDesplazarConsola);
  cuerpo.append(salida);

  const pausa = crear('span', 'consola-pausa');
  pausa.id = 'consola-pausa';
  pausa.hidden = true;
  pausa.textContent = '⏸ En pausa';
  const irFinal = crear('button', 'boton consola-ir-final');
  irFinal.type = 'button';
  irFinal.id = 'consola-final';
  irFinal.hidden = true;
  irFinal.addEventListener('click', irAlFinal);
  cuerpo.append(pausa, irFinal);
  panel.append(cuerpo);

  const pie = crear('p', 'consola-pie');
  pie.id = 'consola-pie';
  panel.append(pie);

  aplicarEnvolturaConsola();
  aplicarTamanoConsola();
  actualizarControlesConsola();
  leerConsola(id);
  app.consola.timer = setInterval(function () { if (app.consola.seguir) leerConsola(id); }, 1500);
}

function aplicarEnvolturaConsola() {
  const salida = porId('consola-salida');
  if (salida) salida.classList.toggle('sin-ajuste', !app.consola.envolver);
  const boton = porId('consola-ajustar');
  if (boton) boton.setAttribute('aria-pressed', app.consola.envolver ? 'true' : 'false');
}

function aplicarTamanoConsola() {
  const salida = porId('consola-salida');
  if (salida) salida.style.fontSize = app.consola.tamano + 'px';
  const etiqueta = porId('consola-tamano');
  if (etiqueta) etiqueta.textContent = app.consola.tamano + 'px';
}

function cambiarTamanoConsola(delta) {
  app.consola.tamano = Math.min(TAMANO_MAX, Math.max(TAMANO_MIN, app.consola.tamano + delta));
  guardarAlmacen(CLAVE_TAMANO, String(app.consola.tamano));
  aplicarTamanoConsola();
  if (app.consola.seguir) irAlFinal();
}

function actualizarControlesConsola() {
  const boton = porId('consola-seguir');
  if (boton) {
    boton.textContent = app.consola.seguir ? 'Pausar' : 'Seguir';
    boton.setAttribute('aria-pressed', app.consola.seguir ? 'true' : 'false');
  }
  const pausa = porId('consola-pausa');
  if (pausa) pausa.hidden = app.consola.seguir;
  actualizarIrAlFinal();
  actualizarPieConsola();
}

function actualizarIrAlFinal() {
  const boton = porId('consola-final');
  if (!boton) return;
  if (app.consola.seguir) {
    boton.hidden = true;
    return;
  }
  boton.hidden = false;
  boton.textContent = app.consola.nuevas > 0 ? 'Ir al final ↓ (' + app.consola.nuevas + ')' : 'Ir al final ↓';
}

function irAlFinal() {
  app.consola.seguir = true;
  app.consola.nuevas = 0;
  const salida = porId('consola-salida');
  if (salida) salida.scrollTop = salida.scrollHeight;
  actualizarControlesConsola();
}

// Auto-seguimiento inteligente: si el usuario sube el scroll, se pausa solo; si
// vuelve al final, se reanuda. No se depende del botón para nada de esto.
function alDesplazarConsola() {
  const salida = porId('consola-salida');
  if (!salida) return;
  const lejos = debePausarSeguimiento({
    scrollTop: salida.scrollTop,
    scrollHeight: salida.scrollHeight,
    clientHeight: salida.clientHeight,
  });
  if (lejos) {
    if (app.consola.seguir) {
      app.consola.seguir = false;
      actualizarControlesConsola();
    }
  } else if (!app.consola.seguir) {
    irAlFinal();
  }
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

function nodoLineaConsola(texto, indice) {
  const linea = crear('span', 'consola-linea ' + claseDeLinea(texto));
  linea.dataset.linea = String(indice);
  const consulta = app.consola.consulta;
  if (consulta) {
    segmentosDeLinea(texto, consulta).forEach(function (segmento) {
      if (segmento.coincide) linea.append(crear('mark', 'coincidencia', segmento.texto));
      else if (segmento.texto) linea.append(document.createTextNode(segmento.texto));
    });
  } else {
    linea.textContent = texto;
  }
  linea.append(document.createTextNode('\n'));
  return linea;
}

function pintarConsola() {
  const salida = porId('consola-salida');
  if (!salida) return;
  const fragmento = document.createDocumentFragment();
  app.consola.lineas.forEach(function (texto, indice) {
    fragmento.append(nodoLineaConsola(texto, indice));
  });
  salida.replaceChildren(fragmento);
  actualizarCoincidencias(false);
  actualizarPieConsola();
}

function agregarLineas(texto) {
  const nuevas = String(texto).split('\n');
  app.consola.lineas = app.consola.lineas.concat(nuevas);
  app.consola.total += nuevas.length;
  if (app.consola.lineas.length > MAX_LINEAS) {
    app.consola.lineas = app.consola.lineas.slice(app.consola.lineas.length - MAX_LINEAS);
  }
  // Con el seguimiento pausado se acumulan las líneas nuevas para el contador.
  if (!app.consola.seguir) app.consola.nuevas += nuevas.length;
  app.consola.actualizadoEn = Date.now();
  pintarConsola();
  if (app.consola.seguir) irAlFinal();
  else actualizarControlesConsola();
}

function actualizarCoincidencias(reiniciarActiva) {
  app.consola.coincidencias = coincidenciasEnLineas(app.consola.lineas, app.consola.consulta);
  if (reiniciarActiva) app.consola.activa = app.consola.coincidencias.length ? 0 : -1;
  else if (app.consola.activa >= app.consola.coincidencias.length) app.consola.activa = app.consola.coincidencias.length - 1;
  const conteo = porId('consola-coincidencias');
  if (conteo) {
    if (!app.consola.consulta) conteo.textContent = '';
    else if (app.consola.coincidencias.length === 0) conteo.textContent = '0 de 0';
    else conteo.textContent = (app.consola.activa + 1) + ' de ' + app.consola.coincidencias.length;
  }
  resaltarCoincidenciaActiva(false);
}

function resaltarCoincidenciaActiva(desplazar) {
  const salida = porId('consola-salida');
  if (!salida) return;
  salida.querySelectorAll('.coincidencia-activa').forEach(function (nodo) { nodo.classList.remove('coincidencia-activa'); });
  const activa = app.consola.coincidencias[app.consola.activa];
  if (!activa) return;
  const linea = salida.querySelector('[data-linea="' + activa.linea + '"]');
  if (!linea) return;
  linea.classList.add('coincidencia-activa');
  if (desplazar && linea.scrollIntoView) linea.scrollIntoView({ block: 'center' });
}

function navegarCoincidencia(delta) {
  const total = app.consola.coincidencias.length;
  if (total === 0) return;
  if (app.consola.activa === -1) app.consola.activa = 0;
  else app.consola.activa = (app.consola.activa + delta + total) % total;
  const conteo = porId('consola-coincidencias');
  if (conteo) conteo.textContent = (app.consola.activa + 1) + ' de ' + total;
  resaltarCoincidenciaActiva(true);
}

function actualizarPieConsola() {
  const pie = porId('consola-pie');
  if (!pie) return;
  const cuantas = app.consola.lineas.length;
  let texto = cuantas + (cuantas === 1 ? ' línea' : ' líneas') + ' · se muestran las últimas ' + MAX_LINEAS;
  if (app.consola.actualizadoEn) {
    const hora = new Date(app.consola.actualizadoEn);
    const dos = function (n) { return String(n).padStart(2, '0'); };
    texto += ' · actualizado ' + dos(hora.getHours()) + ':' + dos(hora.getMinutes()) + ':' + dos(hora.getSeconds());
  }
  pie.textContent = texto;
}

function cambiarFuente(id, fuente) {
  app.consola.fuente = fuente;
  app.consola.offset = 0;
  app.consola.lineas = [];
  app.consola.total = 0;
  app.consola.nuevas = 0;
  pintarConsola();
  leerConsola(id);
}

function alternarSeguir() {
  if (app.consola.seguir) {
    app.consola.seguir = false;
    actualizarControlesConsola();
    return;
  }
  irAlFinal();
  leerConsola(app.consola.id);
}

function copiarConsola(boton) {
  copiarTexto(app.consola.lineas.join('\n'), boton, 'Copiar');
}

function descargarConsola(id) {
  const blob = new Blob([app.consola.lineas.join('\n')], { type: 'text/plain' });
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

function lineasDeArchivo(archivo) {
  return (archivo.hunks || []).reduce(function (total, hunk) { return total + hunk.lineas.length; }, 0);
}

function rutaDeArchivo(archivo) {
  if (archivo.renames && archivo.renames.a) return archivo.renames.de + ' → ' + archivo.renames.a;
  return archivo.nuevo || archivo.viejo || archivo.ruta || '';
}

function lineaParche(linea) {
  const fila = crear('div', 'linea linea-' + linea.tipo);
  fila.append(crear('span', 'num', linea.n1 === null || linea.n1 === undefined ? '' : String(linea.n1)));
  fila.append(crear('span', 'num', linea.n2 === null || linea.n2 === undefined ? '' : String(linea.n2)));
  const signo = linea.tipo === 'add' ? '+' : linea.tipo === 'del' ? '-' : ' ';
  fila.append(crear('span', 'signo', signo), crear('span', 'texto-linea', linea.texto));
  return fila;
}

// Cuerpo del archivo: hunks con números de línea alineados. Se arma por separado
// para poder postergarlo en archivos grandes.
function contenidoArchivo(archivo) {
  const fragmento = document.createDocumentFragment();
  if (archivo.binario) {
    fragmento.append(crear('p', 'binario', 'Archivo binario.'));
    return fragmento;
  }
  if (archivo.sinParche) {
    fragmento.append(crear('p', 'binario', 'Sin parche de texto.'));
    return fragmento;
  }
  (archivo.hunks || []).forEach(function (hunk) {
    const cuerpo = crear('div', 'parche');
    cuerpo.append(crear('div', 'hunk-encabezado', hunk.encabezado));
    hunk.lineas.forEach(function (linea) { cuerpo.append(lineaParche(linea)); });
    fragmento.append(cuerpo);
  });
  return fragmento;
}

// Barrita proporcional al tamaño del cambio respecto del archivo más grande.
function barraProporcional(archivo, maximo) {
  const barra = crear('span', 'archivo-barra');
  const total = (archivo.adiciones || 0) + (archivo.eliminaciones || 0);
  const proporcion = maximo > 0 ? Math.round((total / maximo) * 100) : 0;
  barra.style.width = Math.max(4, Math.min(100, proporcion)) + '%';
  return barra;
}

function detalleDeArchivo(archivo, ajustes) {
  const detalle = crear('details', 'archivo');
  const resumen = crear('summary');
  const marca = MARCA_ARCHIVO[archivo.estado] || MARCA_ARCHIVO.mod;
  resumen.append(crear('span', 'archivo-estado ' + marca[1], marca[0]));
  resumen.append(crear('span', 'archivo-ruta', rutaDeArchivo(archivo)));
  resumen.append(crear('span', 'archivo-cambios', '+' + (archivo.adiciones || 0) + ' −' + (archivo.eliminaciones || 0)));
  resumen.append(barraProporcional(archivo, ajustes.maximo));
  const cantidad = lineasDeArchivo(archivo);
  if (cantidad > MAX_LINEAS_ARCHIVO) {
    // Archivo grande: el cuerpo se arma recién al pedirlo (no bloquea al abrir Diff).
    const ver = crear('button', 'boton boton-mini archivo-ver', 'Mostrar (' + cantidad + ' líneas)');
    ver.type = 'button';
    ver.addEventListener('click', function (evento) {
      evento.preventDefault();
      evento.stopPropagation();
      detalle.replaceChildren(resumen, contenidoArchivo(archivo));
      detalle.open = true;
    });
    resumen.append(ver);
    detalle.append(resumen);
  } else {
    detalle.append(resumen, contenidoArchivo(archivo));
    if (ajustes.abierto) detalle.open = true;
  }
  return detalle;
}

function pintarDiff(panel, diff) {
  panel.replaceChildren();
  if (!diff || diff.disponible !== true) {
    panel.append(crear('p', 'nota', 'Diff no disponible (el worktree o la base ya no están).'));
    return 0;
  }
  if (diff.truncado) panel.append(crear('p', 'aviso-lineas', 'El parche está truncado: se muestra solo una parte.'));
  const archivos = parsearParche(diff.parche || '');
  const usados = new Set();
  archivos.forEach(function (archivo) {
    if (archivo.viejo) usados.add(archivo.viejo);
    if (archivo.nuevo) usados.add(archivo.nuevo);
  });
  (diff.archivos || []).forEach(function (archivo) {
    if (usados.has(archivo.ruta)) return;
    archivos.push({
      viejo: null, nuevo: archivo.ruta, estado: MARCA_GIT[archivo.estado] || 'mod', binario: false,
      renames: null, hunks: [], adiciones: archivo.adiciones || 0, eliminaciones: archivo.eliminaciones || 0,
      sinParche: true,
    });
  });
  if (archivos.length === 0) {
    panel.append(crear('p', 'nota', 'Sin cambios.'));
    return 0;
  }
  const stats = estadisticasDeParche(archivos);

  // Cabecera con totales, salto rápido y acciones.
  const cabecera = crear('div', 'diff-cabecera');
  const resumen = crear('span', 'diff-resumen', stats.archivos + ' archivos · +' + stats.adiciones + ' −' + stats.eliminaciones);
  resumen.id = 'diff-resumen';
  const salto = crear('select', 'diff-salto');
  salto.setAttribute('aria-label', 'Ir a un archivo del diff');
  const opcionCero = crear('option', '', 'Ir a archivo…');
  opcionCero.value = '';
  salto.append(opcionCero);
  archivos.forEach(function (archivo, indice) {
    const opcion = crear('option', '', rutaDeArchivo(archivo));
    opcion.value = String(indice);
    salto.append(opcion);
  });
  const expandir = crear('button', 'boton boton-mini', 'Expandir todo');
  expandir.type = 'button';
  const plegar = crear('button', 'boton boton-mini', 'Plegar todo');
  plegar.type = 'button';
  const copiar = crear('button', 'boton boton-mini', 'Copiar parche');
  copiar.type = 'button';
  cabecera.append(resumen, salto, expandir, plegar, copiar);
  panel.append(cabecera);

  const maximo = archivos.reduce(function (tope, archivo) {
    return Math.max(tope, (archivo.adiciones || 0) + (archivo.eliminaciones || 0));
  }, 0);
  // El primer archivo CON cambios arranca abierto; el resto plegado.
  const abierto = archivos.findIndex(function (archivo) {
    return (archivo.adiciones || 0) + (archivo.eliminaciones || 0) > 0;
  });
  const detalles = [];
  const contenedor = crear('div', 'diff-archivos');
  archivos.forEach(function (archivo, indice) {
    const detalle = detalleDeArchivo(archivo, { maximo: maximo, abierto: indice === abierto });
    detalles.push(detalle);
    contenedor.append(detalle);
  });
  panel.append(contenedor);

  expandir.addEventListener('click', function () { detalles.forEach(function (d) { d.open = true; }); });
  plegar.addEventListener('click', function () { detalles.forEach(function (d) { d.open = false; }); });
  copiar.addEventListener('click', function () { copiarTexto(diff.parche || '', copiar, 'Copiar parche'); });
  salto.addEventListener('change', function () {
    const indice = Number(salto.value);
    salto.value = '';
    if (!Number.isInteger(indice) || !detalles[indice]) return;
    detalles[indice].open = true;
    if (detalles[indice].scrollIntoView) detalles[indice].scrollIntoView({ block: 'start' });
  });
  return archivos.length;
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
    const cantidad = pintarDiff(panel, diff);
    const cache = app.cargado[id] || (app.cargado[id] = {});
    cache.diff = true;
    cache.nDiff = cantidad;
    actualizarEtiquetasTabs(id);
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
    actualizarEtiquetasTabs(id);
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
    cache.nFuera = Array.isArray(alcance.fuera) ? alcance.fuera.length : 0;
    pintarAlcance(panel, alcance);
    actualizarEtiquetasTabs(id);
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
    const cache = app.cargado[id] || (app.cargado[id] = {});
    cache.eventos = true;
    cache.nEventos = Array.isArray(eventos) ? eventos.length : 0;
    actualizarEtiquetasTabs(id);
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

// La cabecera es independiente de la lista: si /api/estado falla, la selección y
// la carga de trabajos siguen igual (un fallo de estado nunca debe frenar todo).
async function cargarEstadoCabecera() {
  try {
    const respuesta = await fetch('/api/estado');
    if (respuesta.ok) renderCabecera(await respuesta.json());
  } catch (error) {
    // La cabecera se reintenta en el próximo ciclo; no bloquea la lista.
  }
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
  // En su propio try: la cabecera se actualiza aunque la lista haya fallado y
  // viceversa.
  await cargarEstadoCabecera();
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
  // Ctrl/Cmd+F con el foco en la consola abre SU búsqueda (no la del navegador).
  if ((evento.ctrlKey || evento.metaKey) && (evento.key === 'f' || evento.key === 'F') && (estaEnConsola(evento.target) || estaEnConsola(document.activeElement))) {
    evento.preventDefault();
    enfocarBusquedaConsola();
    return;
  }
  if (evento.altKey || evento.ctrlKey || evento.metaKey) return;
  const campo = enCampoDeTexto(evento.target);
  const enBusqueda = evento.target === porId('filtro-texto');
  // «/» con la consola enfocada busca DENTRO de la consola; fuera de un campo,
  // sigue llevando a la búsqueda de trabajos.
  if (evento.key === '/' && !campo && (estaEnConsola(evento.target) || estaEnConsola(document.activeElement))) {
    evento.preventDefault();
    enfocarBusquedaConsola();
    return;
  }
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
  // Preferencias de la consola: ajuste de líneas activo por defecto y tamaño acotado.
  app.consola.envolver = leerAlmacen(CLAVE_ENVOLVER) !== '0';
  const tamanoGuardado = Number(leerAlmacen(CLAVE_TAMANO));
  app.consola.tamano = Number.isFinite(tamanoGuardado) ? Math.min(TAMANO_MAX, Math.max(TAMANO_MIN, Math.round(tamanoGuardado))) : 12;
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
