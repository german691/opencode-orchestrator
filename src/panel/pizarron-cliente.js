/**
 * JavaScript del navegador para la página `/pizarron` (módulo ES, sin frameworks).
 *
 * POR QUÉ un módulo aparte del resto del cliente: el pizarrón se refresca solo
 * (polling cada 5 s) y no comparte el estado de la vista de trabajos. Cumple la
 * misma CSP que el resto: todo nodo se crea con `createElement` y el texto se
 * asigna con `textContent`, nunca con `innerHTML`.
 *
 * POR QUÉ se conserva el estado entre refrescos: el pizarrón se repinta cada 5 s;
 * si se reconstruyera siempre, el scroll saltaría y los valores plegados se
 * cerrarían. Se omite el repintado cuando el documento no cambió y, cuando sí
 * cambió, se restauran las claves abiertas y la posición del scroll.
 */
export const PIZARRON_CLIENTE = String.raw`import { formatearHoraEvento, horaIsoEvento } from '/static/lib.js';

const INTERVALO_MS = 5000;
const MAX_VALOR = 60;

const porId = function (id) { return document.getElementById(id); };
const crear = function (etiqueta, clase, texto) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined && texto !== null) nodo.textContent = String(texto);
  return nodo;
};

function hora(ts) {
  return formatearHoraEvento(ts);
}

function celdaHora(ts) {
  const celda = crear('td');
  const texto = hora(ts);
  if (texto) {
    const nodo = crear('time', '', texto);
    nodo.setAttribute('datetime', horaIsoEvento(ts));
    nodo.title = horaIsoEvento(ts);
    celda.append(nodo);
  }
  return celda;
}

function enlaceTrabajo(jobId, clase) {
  if (!jobId) return crear('span', clase || '', 'anónimo');
  const enlace = crear('a', clase || '', String(jobId));
  enlace.href = '/?job=' + encodeURIComponent(jobId);
  return enlace;
}

// Valor vigente: JSON corto en texto; si es largo, un <details> con 'ver más'
// para no desbordar la celda y conservar el contenido completo.
function valorPlegable(clave, valor) {
  const texto = valor === undefined ? '—' : JSON.stringify(valor);
  if (texto.length <= MAX_VALOR) return crear('span', 'valor-pizarron', texto);
  const detalle = crear('details', 'valor-pizarron');
  detalle.dataset.clave = clave;
  const resumen = crear('summary', 'valor-pizarron-resumen');
  resumen.append(crear('span', '', texto.slice(0, MAX_VALOR) + '…'), crear('span', 'plegable-accion', 'ver más'));
  detalle.append(resumen, crear('pre', '', texto));
  return detalle;
}

function tieneConflicto(entrada) {
  return Array.isArray(entrada && entrada.historial) && entrada.historial.some(function (e) {
    return e && e.conflicto === true;
  });
}

function pintarClaves(documento) {
  const claves = documento && documento.claves ? documento.claves : {};
  const entradas = Object.keys(claves).map(function (clave) { return [clave, claves[clave] || {}]; });
  const envoltorio = crear('div', 'tabla-envoltorio');
  if (entradas.length === 0) {
    envoltorio.append(crear('p', 'vacia', 'Todavía no hay claves compartidas.'));
    return envoltorio;
  }
  const tabla = crear('table', 'tabla-pizarron');
  tabla.setAttribute('aria-label', 'Claves compartidas por los agentes');
  const caption = crear('caption', 'oculto', 'Claves compartidas por los agentes');
  const filaCab = crear('tr');
  ['Clave', 'Valor vigente', 'Autor', 'Hora', 'Conflicto'].forEach(function (titulo) {
    const th = crear('th', '', titulo);
    th.setAttribute('scope', 'col');
    filaCab.append(th);
  });
  const thead = crear('thead');
  thead.append(filaCab);
  const tbody = crear('tbody');
  entradas.forEach(function (par) {
    const entrada = par[1];
    const fila = crear('tr');
    const celdaClave = crear('td');
    celdaClave.append(crear('span', 'valor-pizarron', par[0]));
    fila.append(celdaClave);
    const celdaValor = crear('td');
    celdaValor.append(valorPlegable(par[0], entrada.valor));
    fila.append(celdaValor);
    const celdaAutor = crear('td');
    celdaAutor.append(enlaceTrabajo(entrada.jobId, 'nota-autor'));
    fila.append(celdaAutor);
    fila.append(celdaHora(entrada.ts));
    const celdaConflicto = crear('td');
    if (tieneConflicto(entrada)) celdaConflicto.append(crear('span', 'marca-conflicto', 'conflicto'));
    fila.append(celdaConflicto);
    tbody.append(fila);
  });
  tabla.append(caption, thead, tbody);
  envoltorio.append(tabla);
  return envoltorio;
}

function pintarNotas(documento) {
  const notas = documento && Array.isArray(documento.notas) ? documento.notas : [];
  if (notas.length === 0) return crear('p', 'vacia', 'Todavía no hay notas.');
  const lista = crear('ol', 'notas-pizarron');
  notas.slice(-20).reverse().forEach(function (nota) {
    const item = crear('li', 'nota-pizarron');
    const fecha = hora(nota.ts);
    if (fecha) {
      const nodo = crear('time', 'evento-hora', fecha);
      nodo.setAttribute('datetime', horaIsoEvento(nota.ts));
      nodo.title = horaIsoEvento(nota.ts);
      item.append(nodo);
    }
    item.append(enlaceTrabajo(nota.jobId, 'nota-autor'));
    item.append(crear('span', 'nota-texto', nota.texto || ''));
    lista.append(item);
  });
  return lista;
}

let ultimoSerial = null;

function pintar(documento) {
  const contenedor = porId('pizarron');
  if (!contenedor) return;
  const serial = JSON.stringify(documento || {});
  // Sin cambios: no tocar el DOM evita perder scroll y plegables.
  if (serial === ultimoSerial) return;
  ultimoSerial = serial;
  const abiertas = [];
  contenedor.querySelectorAll('details[data-clave][open]').forEach(function (detalle) {
    abiertas.push(detalle.dataset.clave);
  });
  const scrollY = window.scrollY;

  const claves = documento && documento.claves ? documento.claves : {};
  const notas = documento && Array.isArray(documento.notas) ? documento.notas : [];
  if (Object.keys(claves).length === 0 && notas.length === 0) {
    const vacio = crear('p', 'vacia', 'Todavía ningún agente compartió contexto. Los agentes lo usan escribiendo .orq/aporte.json');
    vacio.setAttribute('role', 'status');
    contenedor.replaceChildren(vacio);
    return;
  }
  const seccionClaves = crear('section');
  seccionClaves.append(crear('h2', '', 'Claves'), pintarClaves(documento));
  const seccionNotas = crear('section');
  seccionNotas.append(crear('h2', '', 'Notas recientes'), pintarNotas(documento));
  contenedor.replaceChildren(seccionClaves, seccionNotas);

  // Restaurar plegables y scroll tras el repintado.
  contenedor.querySelectorAll('details[data-clave]').forEach(function (detalle) {
    if (abiertas.indexOf(detalle.dataset.clave) !== -1) detalle.open = true;
  });
  window.scrollTo(0, scrollY);
}

function estado(texto, error) {
  const nodo = porId('pizarron-estado');
  if (!nodo) return;
  nodo.textContent = texto;
  nodo.className = error ? 'error' : 'nota';
}

async function cargar() {
  try {
    const respuesta = await fetch('/api/pizarron');
    if (!respuesta.ok) throw new Error('estado ' + respuesta.status);
    const documento = await respuesta.json();
    pintar(documento);
    estado('Actualizado ' + new Date().toLocaleTimeString(), false);
  } catch (error) {
    estado('Reconectando…', true);
  }
}

cargar();
setInterval(cargar, INTERVALO_MS);
`;
