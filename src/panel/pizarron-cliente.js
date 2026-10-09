/**
 * JavaScript del navegador para la página `/pizarron` (módulo ES, sin frameworks).
 *
 * POR QUÉ un módulo aparte del resto del cliente: el pizarrón se refresca solo
 * (polling cada 5 s) y no comparte el estado de la vista de trabajos. Cumple la
 * misma CSP que el resto: todo nodo se crea con `createElement` y el texto se
 * asigna con `textContent`, nunca con `innerHTML`.
 */
export const PIZARRON_CLIENTE = String.raw`const INTERVALO_MS = 5000;
const MAX_VALOR = 60;

const porId = function (id) { return document.getElementById(id); };
const crear = function (etiqueta, clase, texto) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined && texto !== null) nodo.textContent = String(texto);
  return nodo;
};

function hora(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : '';
}

function enlaceTrabajo(jobId) {
  if (!jobId) return crear('span', '', '');
  const enlace = crear('a', '', String(jobId));
  enlace.href = '/?job=' + encodeURIComponent(jobId);
  return enlace;
}

// Valor vigente: JSON truncado con 'ver más' para no desbordar la celda.
function valorConVerMas(valor) {
  const celda = crear('span', 'valor-pizarron');
  const texto = valor === undefined ? '—' : JSON.stringify(valor);
  if (texto === undefined || texto.length <= MAX_VALOR) {
    celda.textContent = texto === undefined ? '—' : texto;
    return celda;
  }
  const corto = crear('span', '', texto.slice(0, MAX_VALOR) + '…');
  const largo = crear('span', '', texto);
  largo.hidden = true;
  const boton = crear('button', 'boton', 'ver más');
  boton.type = 'button';
  boton.addEventListener('click', function () {
    const abierto = !largo.hidden;
    largo.hidden = abierto;
    corto.hidden = !abierto;
    boton.textContent = abierto ? 'ver más' : 'ver menos';
  });
  celda.append(corto, largo, boton);
  return celda;
}

function tieneConflicto(entrada) {
  return Array.isArray(entrada && entrada.historial) && entrada.historial.some(function (e) {
    return e && e.conflicto === true;
  });
}

function pintarClaves(documento) {
  const claves = documento && documento.claves ? documento.claves : {};
  const entradas = Object.keys(claves).map(function (clave) { return [clave, claves[clave] || {}]; });
  if (entradas.length === 0) return crear('p', 'nota', 'Sin claves todavía.');
  const tabla = crear('table', 'tabla-pizarron');
  const filaCab = crear('tr');
  ['clave', 'valor vigente', 'trabajo', 'hora', 'conflicto'].forEach(function (titulo) {
    filaCab.append(crear('th', '', titulo));
  });
  const thead = crear('thead');
  thead.append(filaCab);
  const tbody = crear('tbody');
  entradas.forEach(function (par) {
    const entrada = par[1];
    const fila = crear('tr');
    fila.append(crear('td', '', par[0]));
    const celdaValor = crear('td');
    celdaValor.append(valorConVerMas(entrada.valor));
    fila.append(celdaValor);
    const celdaTrabajo = crear('td');
    celdaTrabajo.append(enlaceTrabajo(entrada.jobId));
    fila.append(celdaTrabajo);
    fila.append(crear('td', '', hora(entrada.ts)));
    const celdaConflicto = crear('td');
    if (tieneConflicto(entrada)) celdaConflicto.append(crear('span', 'marca-conflicto', 'conflicto'));
    fila.append(celdaConflicto);
    tbody.append(fila);
  });
  tabla.append(thead, tbody);
  return tabla;
}

function pintarNotas(documento) {
  const notas = documento && Array.isArray(documento.notas) ? documento.notas : [];
  if (notas.length === 0) return crear('p', 'nota', 'Sin notas.');
  const lista = crear('ol', 'notas-pizarron');
  notas.slice(-20).reverse().forEach(function (nota) {
    const item = crear('li', 'nota-pizarron');
    item.append(crear('span', 'evento-hora', hora(nota.ts)));
    item.append(enlaceTrabajo(nota.jobId));
    item.append(crear('span', '', nota.texto || ''));
    lista.append(item);
  });
  return lista;
}

function pintar(documento) {
  const contenedor = porId('pizarron');
  if (!contenedor) return;
  const claves = documento && documento.claves ? documento.claves : {};
  const notas = documento && Array.isArray(documento.notas) ? documento.notas : [];
  if (Object.keys(claves).length === 0 && notas.length === 0) {
    contenedor.replaceChildren(crear('p', 'nota', 'Todavía ningún agente compartió contexto'));
    return;
  }
  const seccionClaves = crear('section');
  seccionClaves.append(crear('h2', '', 'Claves'), pintarClaves(documento));
  const seccionNotas = crear('section');
  seccionNotas.append(crear('h2', '', 'Notas recientes'), pintarNotas(documento));
  contenedor.replaceChildren(seccionClaves, seccionNotas);
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
