/**
 * Íconos SVG del panel, en un módulo compartido por el servidor y el navegador.
 *
 * POR QUÉ: reemplazan a los glifos Unicode (emojis y símbolos) que se veían
 * distintos en cada sistema y rompían la estética. Acá cada ícono es una forma
 * geométrica (trazos de 1.75 px, 16 px, `currentColor`) que hereda el color del
 * texto; así el estado nunca depende del color solo (siempre hay texto al lado).
 *
 * POR QUÉ exporta string Y nodo: la auditoría se renderiza en el servidor (string)
 * y el cliente hidrata el resto del panel (nodo DOM creado con `createElementNS`,
 * sin `innerHTML`, para mantener la CSP estricta y el invariante del cliente).
 */

/** Espacio de nombres de SVG para crear nodos en el navegador. */
const NS_SVG = 'http://www.w3.org/2000/svg';

/**
 * Formas por nombre: lista de `[etiqueta, atributos]`. Todas viven en un lienzo
 * de 24x24 y se dibujan sin relleno, solo trazo, para que escalen nítidas.
 */
const FORMAS = {
  logo: [
    ['rect', { x: 2.5, y: 2.5, width: 19, height: 19, rx: 5 }],
    ['path', { d: 'M9.5 8.5 6 12l3.5 3.5' }],
    ['path', { d: 'M14.5 8.5 18 12l-3.5 3.5' }],
  ],
  // Estados del ciclo de vida.
  queued: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v5l3.5 2' }],
  ],
  provisioning: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2' }],
  ],
  running: [['path', { d: 'M7 4.5 18.5 12 7 19.5z' }]],
  verifying: [
    ['circle', { cx: 10.5, cy: 10.5, r: 6.5 }],
    ['path', { d: 'M15.5 15.5 21 21' }],
  ],
  succeeded: [['path', { d: 'M4.5 12.5 9.5 17.5 19.5 6.5' }]],
  merged: [
    ['circle', { cx: 6, cy: 6, r: 2.3 }],
    ['circle', { cx: 6, cy: 18, r: 2.3 }],
    ['circle', { cx: 18, cy: 12, r: 2.3 }],
    ['path', { d: 'M6 8.3v7.4M8.3 6H12a6 6 0 0 1 6 6' }],
  ],
  failed: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9 9l6 6M15 9l-6 6' }],
  ],
  rejected: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M5.6 5.6 18.4 18.4' }],
  ],
  cancelled: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M8 12h8' }],
  ],
  lost: [
    ['path', { d: 'M12 3.5 21 20H3z' }],
    ['path', { d: 'M12 9.5v4.5' }],
    ['path', { d: 'M12 17.2h.01' }],
  ],
  neutro: [['circle', { cx: 12, cy: 12, r: 4 }]],
  // Íconos de interfaz.
  advertencia: [
    ['path', { d: 'M12 3.5 21 20H3z' }],
    ['path', { d: 'M12 9.5v4.5' }],
    ['path', { d: 'M12 17.2h.01' }],
  ],
  copiar: [
    ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2.5 }],
    ['path', { d: 'M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5' }],
  ],
  descargar: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'M7 10.5 12 15.5l5-5' }],
    ['path', { d: 'M4.5 20h15' }],
  ],
  abajo: [
    ['path', { d: 'M12 4v15' }],
    ['path', { d: 'M6 13l6 6 6-6' }],
  ],
  pausa: [['path', { d: 'M9 4.5v15M15 4.5v15' }]],
  seguir: [['path', { d: 'M8 5 18 12 8 19z' }]],
  buscar: [
    ['circle', { cx: 10.5, cy: 10.5, r: 6.5 }],
    ['path', { d: 'M15.5 15.5 21 21' }],
  ],
  limpiar: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  archivo: [
    ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }],
    ['path', { d: 'M14 3v5h5' }],
  ],
  atras: [
    ['path', { d: 'M19 12H5' }],
    ['path', { d: 'M11 6 5 12l6 6' }],
  ],
  expandir: [['path', { d: 'M6 9.5 12 15.5 18 9.5' }]],
  plegar: [['path', { d: 'M9.5 6 15.5 12 9.5 18' }]],
  'enlace-externo': [
    ['path', { d: 'M14 4h6v6' }],
    ['path', { d: 'M10 14 20 4' }],
    ['path', { d: 'M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5' }],
  ],
  mas: [['path', { d: 'M12 5v14M5 12h14' }]],
  menos: [['path', { d: 'M5 12h14' }]],
  modificado: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M12 3v3M12 18v3M3 12h3M18 12h3' }],
  ],
};

/** Nombres disponibles, útil para tests y para el cliente. */
export const NOMBRES_ICONO = Object.freeze(Object.keys(FORMAS));

/** Serializa los atributos de una forma a texto SVG. */
function atributosDe(attrs) {
  return Object.entries(attrs)
    .map(([clave, valor]) => `${clave}="${valor}"`)
    .join(' ');
}

/** Escapa un texto para usarlo dentro de un atributo HTML. */
function escaparAtributo(texto) {
  return String(texto ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Cuerpo interno del SVG (las formas) como string. */
function cuerpoSvg(nombre) {
  return (FORMAS[nombre] || FORMAS.neutro)
    .map(([etiqueta, attrs]) => `<${etiqueta} ${atributosDe(attrs)}/>`)
    .join('');
}

/**
 * Devuelve el SVG como string. Si `etiqueta` viene, el ícono es accesible
 * (`role="img"` + `aria-label`); si no, se oculta a lectores (`aria-hidden`).
 * @param {string} nombre clave de `FORMAS`
 * @param {{ clase?: string, tamano?: number, etiqueta?: string, color?: string }} [opciones]
 * @returns {string}
 */
export function svgIcono(nombre, { clase = 'icono-svg', tamano = 16, etiqueta, color = 'currentColor' } = {}) {
  const accesible = etiqueta
    ? ` role="img" aria-label="${escaparAtributo(etiqueta)}"`
    : ' aria-hidden="true"';
  return (
    `<svg class="${clase}" width="${tamano}" height="${tamano}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" ` +
    `stroke-linejoin="round" focusable="false"${accesible}>${cuerpoSvg(nombre)}</svg>`
  );
}

/**
 * Devuelve el SVG como nodo DOM. Solo se usa en el navegador; se construye con
 * `createElementNS` (nunca `innerHTML`) para no romper el invariante del cliente.
 * @param {string} nombre clave de `FORMAS`
 * @param {{ clase?: string, tamano?: number, etiqueta?: string }} [opciones]
 * @returns {SVGElement}
 */
export function nodoIcono(nombre, { clase = 'icono-svg', tamano = 16, etiqueta } = {}) {
  const svg = document.createElementNS(NS_SVG, 'svg');
  svg.setAttribute('class', clase);
  svg.setAttribute('width', String(tamano));
  svg.setAttribute('height', String(tamano));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('focusable', 'false');
  if (etiqueta) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', etiqueta);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of FORMAS[nombre] || FORMAS.neutro) {
    const forma = document.createElementNS(NS_SVG, tag);
    for (const [clave, valor] of Object.entries(attrs)) forma.setAttribute(clave, String(valor));
    svg.append(forma);
  }
  return svg;
}

/**
 * Favicon del panel: el monograma con el acento de marca. `img-src 'self' data:`
 * permite servirlo como archivo SVG propio.
 */
export const FAVICON = svgIcono('logo', { clase: 'favicon', tamano: 32, color: '#5b57d6' });
