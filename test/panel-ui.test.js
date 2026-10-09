import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crearServidorPanel, hostPermitido, concurrenciaDeEntorno, CONCURRENCIA_POR_DEFECTO } from '../src/panel/servidor.js';
import { PAGINA, paginaAuditoria } from '../src/panel/pagina.js';
import { CLIENTE } from '../src/panel/cliente.js';
import { PIZARRON_CLIENTE } from '../src/panel/pizarron-cliente.js';
import { svgIcono } from '../src/panel/iconos.js';
import { contraste } from '../src/panel/cliente-lib.js';
import { crearRegistroEventos } from '../src/core/eventos.js';

const AHORA = 1_800_000_000_000;

function crearBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ui-'));
  fs.mkdirSync(path.join(base, 'jobs'));
  return base;
}

async function conServidor(fn) {
  const servidor = crearServidorPanel({ baseDir: crearBase(), ahora: () => AHORA });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  try {
    await fn(url);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
}

test('shell: landmarks, skip link, lang y referencias estáticas sin código en línea', async () => {
  await conServidor(async (url) => {
    const html = await (await fetch(`${url}/`)).text();
    assert.match(html, /<html lang="es">/);
    assert.match(html, /<header/);
    assert.match(html, /<nav/);
    assert.match(html, /<main/);
    assert.match(html, /Saltar al contenido/);
    assert.match(html, /href="\/static\/app\.css"/);
    assert.match(html, /src="\/static\/app\.js"/);
    assert.doesNotMatch(html, /onclick=/i);
    assert.doesNotMatch(html, /javascript:/i);
    // La CSP prohíbe estilos/scripts en línea: el shell no debe traerlos.
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /<script>[^<]/i);
  });
});

test('HTML: CSP restrictiva y nosniff en las páginas', async () => {
  await conServidor(async (url) => {
    const respuesta = await fetch(`${url}/`);
    const csp = respuesta.headers.get('content-security-policy');
    assert.ok(csp, 'falta content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src 'self' data:/);
    assert.equal(respuesta.headers.get('x-content-type-options'), 'nosniff');

    const audit = await fetch(`${url}/auditoria`);
    assert.equal(audit.headers.get('x-content-type-options'), 'nosniff');
    assert.match(audit.headers.get('content-security-policy'), /default-src 'self'/);
  });
});

test('estáticos: MIME correcto, ETag y 304 al revalidar', async () => {
  const esperados = [
    ['/static/app.css', /^text\/css/],
    ['/static/app.js', /^text\/javascript/],
    ['/static/lib.js', /^text\/javascript/],
    ['/static/iconos.js', /^text\/javascript/],
    ['/static/pizarron.js', /^text\/javascript/],
    ['/static/favicon.svg', /^image\/svg\+xml/],
  ];
  await conServidor(async (url) => {
    for (const [ruta, tipo] of esperados) {
      const respuesta = await fetch(`${url}${ruta}`);
      assert.equal(respuesta.status, 200, ruta);
      assert.match(respuesta.headers.get('content-type'), tipo, ruta);
      assert.equal(respuesta.headers.get('cache-control'), 'no-cache', ruta);
      const etag = respuesta.headers.get('etag');
      assert.ok(etag, `sin ETag en ${ruta}`);
      assert.ok((await respuesta.text()).length > 0, ruta);

      const revalidada = await fetch(`${url}${ruta}`, { headers: { 'if-none-match': etag } });
      assert.equal(revalidada.status, 304, ruta);
    }
    // Un estático inexistente sigue dando 404.
    assert.equal((await fetch(`${url}/static/nope.js`)).status, 404);
  });
});

test('estilos: tokens de tema claro/oscuro y accesibilidad presentes', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    assert.match(css, /:root\s*\{/);
    assert.match(css, /prefers-color-scheme:dark/);
    assert.match(css, /prefers-reduced-motion:reduce/);
    assert.match(css, /forced-colors:active/);
    assert.match(css, /--esp:4px/);
    assert.match(css, /\.tabla-pizarron\{/);
    assert.match(css, /details\.plegable\{/);
    const lib = await (await fetch(`${url}/static/lib.js`)).text();
    assert.match(lib, /export function formatearDuracion/);
    assert.match(lib, /export function parsearParche/);
  });
});

test('cliente: pasa node --check y trae atajos y ARIA esperados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-cliente-'));
  const archivo = path.join(dir, 'app.mjs');
  fs.writeFileSync(archivo, CLIENTE);
  // node --check valida la sintaxis del módulo tal como lo cargaría el navegador.
  execFileSync(process.execPath, ['--check', archivo]);

  assert.match(CLIENTE, /from '\/static\/lib\.js'/);
  // Atajos j/k, /, f y ?.
  assert.match(CLIENTE, /evento\.key === 'j'/);
  assert.match(CLIENTE, /evento\.key === 'k'/);
  assert.match(CLIENTE, /evento\.key === 'f'/);
  assert.match(CLIENTE, /evento\.key === '\?'/);
  assert.match(CLIENTE, /evento\.key === '\/'/);
  // ARIA que el cliente mantiene dinámicamente.
  assert.match(CLIENTE, /aria-selected/);
  assert.match(CLIENTE, /aria-current/);
  assert.match(CLIENTE, /aria-pressed/);
  assert.match(CLIENTE, /anunciar/);

  // La tarea y la última salida van plegadas y el id se copia desde la cabecera.
  assert.match(CLIENTE, /resumenTarea\(/);
  assert.match(CLIENTE, /'Última salida'/);
  assert.match(CLIENTE, /copiarId/);
  assert.match(PAGINA, /id="copiar-id"/);

  // El shell aporta los roles de pestañas, la región en vivo y el diálogo de ayuda.
  assert.match(PAGINA, /role="tablist"/);
  assert.match(PAGINA, /role="tab"/);
  assert.match(PAGINA, /role="tabpanel"/);
  assert.match(PAGINA, /aria-live="polite"/);
  assert.match(PAGINA, /<dialog/);
});

test('auditoría: usa el CSS nuevo y el mismo shell accesible', async () => {
  await conServidor(async (url) => {
    const html = await (await fetch(`${url}/auditoria`)).text();
    assert.match(html, /<html lang="es">/);
    assert.match(html, /Auditoría de opencode/);
    assert.match(html, /href="\/static\/app\.css"/);
    assert.match(html, /Saltar al contenido/);
    assert.match(html, /<main/);
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /onclick=/i);
    assert.doesNotMatch(html, /javascript:/i);
  });
});

test('pizarrón: misma shell, CSP y landmarks que el resto', async () => {
  await conServidor(async (url) => {
    const respuesta = await fetch(`${url}/pizarron`);
    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.headers.get('x-content-type-options'), 'nosniff');
    assert.match(respuesta.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await respuesta.text();
    assert.match(html, /<html lang="es">/);
    assert.match(html, /Pizarrón de opencode/);
    assert.match(html, /href="\/static\/app\.css"/);
    assert.match(html, /src="\/static\/pizarron\.js"/);
    assert.match(html, /Saltar al contenido/);
    assert.match(html, /<main/);
    assert.match(html, /id="pizarron"/);
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /onclick=/i);
    assert.doesNotMatch(html, /javascript:/i);
  });
});

test('cabecera: enlaces a Pizarrón y Auditoría desde la página principal', async () => {
  await conServidor(async (url) => {
    const principal = await (await fetch(`${url}/`)).text();
    assert.match(principal, /href="\/pizarron">Pizarrón/);
    assert.match(principal, /href="\/auditoria">Auditoría/);
    const auditoria = await (await fetch(`${url}/auditoria`)).text();
    assert.match(auditoria, /href="\/pizarron"/);
  });
});

test('host: solo se permite loopback salvo ORQ_PANEL_ALLOW_REMOTE=1', () => {
  assert.equal(hostPermitido('127.0.0.1', {}), true);
  assert.equal(hostPermitido('localhost', {}), true);
  assert.equal(hostPermitido('::1', {}), true);
  assert.equal(hostPermitido('0.0.0.0', {}), false);
  assert.equal(hostPermitido('192.168.1.10', {}), false);
  assert.equal(hostPermitido('0.0.0.0', { ORQ_PANEL_ALLOW_REMOTE: '1' }), true);
});

test('concurrencia: por defecto 8 y acotada a 1..16 como el servidor MCP', () => {
  assert.equal(CONCURRENCIA_POR_DEFECTO, 8);
  assert.equal(concurrenciaDeEntorno({}), 8);
  assert.equal(concurrenciaDeEntorno({ ORQ_CONCURRENCY: '5' }), 5);
  assert.equal(concurrenciaDeEntorno({ ORQ_CONCURRENCY: '99' }), 16);
  assert.equal(concurrenciaDeEntorno({ ORQ_CONCURRENCY: '0' }), 8);
  assert.equal(concurrenciaDeEntorno({ ORQ_CONCURRENCY: 'x' }), 8);
});

test('UI: repositorio como select, localStorage, ?repo=, aria-busy, Reintentar y Corriendo n/máx', () => {
  // El repositorio pasó de chips a un <select> para no confundirse con el estado.
  assert.match(PAGINA, /id="filtro-repo"/);
  assert.match(PAGINA, /aria-label="Filtrar por repositorio"/);
  assert.doesNotMatch(PAGINA, /id="chips-repo"/);
  // El filtro se recuerda y se refleja en la URL; se usa la lib pura contarPorRepo.
  assert.match(CLIENTE, /contarPorRepo/);
  assert.match(CLIENTE, /localStorage/);
  assert.match(CLIENTE, /searchParams\.set\('repo'/);
  assert.match(CLIENTE, /parametros\.get\('repo'\)/);
  // Accesibilidad: aria-busy al cargar, error legible con botón Reintentar y j/k que
  // no roban el foco de la búsqueda.
  assert.match(CLIENTE, /aria-busy/);
  assert.match(CLIENTE, /'No se pudo cargar: '/);
  assert.match(CLIENTE, /'Reintentar'/);
  assert.match(CLIENTE, /moverSeleccion\(evento\.key === 'j' \? 1 : -1, enBusqueda\)/);
  // La cabecera muestra UNA píldora 'n/máx en curso' con la concurrencia del entorno.
  assert.match(CLIENTE, /usada \+ '\/' \+ maxima \+ ' en curso'/);
});

test('UI: toolbar compacta con búsqueda, segmentado, repo, orden y densidad persistidos', () => {
  assert.match(PAGINA, /id="limpiar-busqueda"/);
  assert.match(PAGINA, /id="chips" class="segmentado"/);
  assert.match(PAGINA, /id="orden"/);
  assert.match(PAGINA, /Actividad reciente/);
  assert.match(PAGINA, /id="densidad"/);
  // Todas las preferencias se guardan/restauran con la lib de almacenamiento.
  assert.match(CLIENTE, /CLAVE_ORDEN/);
  assert.match(CLIENTE, /CLAVE_DENSIDAD/);
  assert.match(CLIENTE, /CLAVE_ANCHO/);
  assert.match(CLIENTE, /guardarAlmacen\(/);
  assert.match(CLIENTE, /densidad-compacta/);
  // El control de estado rotula «Problemas» (value 'fallidos') y trae contadores.
  assert.match(CLIENTE, /\['fallidos', 'Problemas'\]/);
});

test('UI: layout de aplicación (grid, scroll por columna, divisor ARIA y maestro-detalle)', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // Cabecera fija y grilla con el alto restante; sin scroll de página.
    assert.match(css, /body\.panel-app\{[^}]*height:100dvh[^}]*overflow:hidden/);
    assert.match(css, /\.cuerpo\{[^}]*grid-template-columns:var\(--ancho-lista\) 6px minmax\(0,1fr\)/);
    assert.match(css, /\.cuerpo\{[^}]*overflow:hidden/);
    // Cada columna con su propio scroll (min-height:0 + overflow:auto).
    assert.match(css, /\.lista\{[^}]*overflow:hidden/);
    assert.match(css, /\.trabajos\{[^}]*overflow:auto[^}]*min-height:0/);
    assert.match(css, /\[role=tabpanel\]\{[^}]*overflow:auto[^}]*min-height:0/);
    // Barra de título + pestañas sticky; encabezados de grupo sticky.
    assert.match(css, /\.detalle-cabecera\{[^}]*position:sticky/);
    assert.match(css, /\.grupo-encabezado\{[^}]*position:sticky/);
    // Divisor de 6 px y ensanche a 440 px en pantallas ≥1700 px.
    assert.match(css, /\.divisor\{/);
    assert.match(css, /@media \(min-width:1700px\)\{\.cuerpo\{--ancho-lista:440px\}\}/);
    // Maestro-detalle por debajo de 900 px.
    assert.match(css, /@media \(max-width:899px\)/);
    assert.match(css, /body\.detalle-abierto \.lista\{display:none\}/);
    assert.match(css, /body\.detalle-abierto \.detalle\{display:flex\}/);
  });
  // El divisor es una manija accesible con atributos ARIA y foco de teclado.
  assert.match(PAGINA, /id="divisor" class="divisor" role="separator" aria-orientation="vertical"/);
  assert.match(PAGINA, /aria-valuenow="380" aria-valuemin="280" aria-valuemax="560" tabindex="0"/);
  assert.match(PAGINA, /id="volver"[^>]*>[\s\S]*Trabajos</);
});

test('UI: navegación por history.pushState/popstate y carga del detalle por ?job', () => {
  // La selección se apila en el historial y el evento popstate la restaura.
  assert.match(CLIENTE, /history\.pushState\(/);
  assert.match(CLIENTE, /history\.replaceState\(/);
  assert.match(CLIENTE, /addEventListener\('popstate'/);
  assert.match(CLIENTE, /searchParams\.set\('job'/);
  assert.match(CLIENTE, /parametros\.get\('job'\)/);
  // El id de la URL se carga cuando llega la lista (aunque no esté en ella).
  assert.match(CLIENTE, /seleccionadoInicial/);
  assert.match(CLIENTE, /const objetivo = app\.seleccionado \|\| app\.seleccionadoInicial/);
  // El detalle arranca con la lista cuando se vuelve.
  assert.match(CLIENTE, /function cerrarDetalle\(/);
  assert.match(CLIENTE, /'detalle-abierto'/);
  // Al navegar/actualizar, la fila seleccionada se hace visible sin saltar.
  assert.match(CLIENTE, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  // Agrupación con encabezados y hora relativa en la lista.
  assert.match(CLIENTE, /agruparTrabajos\(/);
  assert.match(CLIENTE, /tiempoRelativo\(/);
  assert.match(CLIENTE, /ordenarPor\(/);
  // Divisor arrastrable por puntero y teclado, acotado por la lib pura.
  assert.match(CLIENTE, /setPointerCapture/);
  assert.match(CLIENTE, /limitarAnchoLista\(/);
  assert.match(CLIENTE, /ANCHO_LISTA_MIN/);
  assert.match(CLIENTE, /ANCHO_LISTA_MAX/);
});

test('cliente del pizarrón: pasa node --check y refresca por polling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-pizarron-'));
  const archivo = path.join(dir, 'pizarron.mjs');
  fs.writeFileSync(archivo, PIZARRON_CLIENTE);
  execFileSync(process.execPath, ['--check', archivo]);
  assert.match(PIZARRON_CLIENTE, /fetch\('\/api\/pizarron'\)/);
  assert.match(PIZARRON_CLIENTE, /setInterval/);
  assert.match(PIZARRON_CLIENTE, /replaceChildren/);
  assert.match(PIZARRON_CLIENTE, /ver más/);
  assert.match(PIZARRON_CLIENTE, /Todavía ningún agente compartió contexto/);
  assert.doesNotMatch(PIZARRON_CLIENTE, /innerHTML/);
});

/** Arranca el panel sobre una base propia y ejecuta `fn(url)`. */
async function conBase(fn, { registro } = {}) {
  const base = crearBase();
  const servidor = crearServidorPanel({ baseDir: base, ahora: () => AHORA, registro });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  try {
    await fn(url, base);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
}

test('auditoría: layout de página, cabecera con aria-current, filtros etiquetados, tabla con caption y vacío role=status', async () => {
  const base = crearBase();
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  await conBase(
    async (url) => {
      const html = await (await fetch(`${url}/auditoria`)).text();
      // Layout: <main> de página con ancho cómodo (clase .pagina, CSS aparte).
      assert.match(html, /<main id="contenido" class="pagina" tabindex="-1">/);
      // Cabecera consistente con la principal y sección actual marcada.
      assert.match(html, /<a href="\/">Trabajos<\/a>/);
      assert.match(html, /<a href="\/auditoria" aria-current="page">Auditoría<\/a>/);
      assert.match(html, /<a href="\/pizarron">Pizarrón<\/a>/);
      // Filtros con etiquetas visibles y botones primario/limpiar.
      assert.match(html, /<label for="filtro-trabajo">Trabajo<\/label>/);
      assert.match(html, /<label for="filtro-tipo">Tipo<\/label>/);
      assert.match(html, /<label for="filtro-desde">Desde<\/label>/);
      assert.match(html, /<label for="filtro-hasta">Hasta<\/label>/);
      assert.match(html, /class="boton boton-primario">Filtrar<\/button>/);
      assert.match(html, /class="boton" href="\/auditoria">Limpiar<\/a>/);
      // Estados vacíos informativos con role=status.
      assert.match(html, /role="status"/);
      assert.match(html, /Todavía no hay eventos/);
      assert.match(html, /cambios de estado de los trabajos/);
      assert.doesNotMatch(html, /<style/i);
      assert.doesNotMatch(html, /onclick=/i);
    },
    { registro },
  );
});

test('auditoría: en el tope del límite oculta «Cargar más» y avisa que filtre por fechas', () => {
  const evento = { ts: 1_800_000_000_000, tipo: 'job.creado', jobId: 'abc12345', estado: 'queued', actor: 'sistema' };
  // En el tope no se ofrece paginar (el límite se recortaría y no avanzaría): se avisa.
  const enTope = paginaAuditoria({ eventos: [evento], filtros: {}, limite: 10000, hayMas: true, enTope: true });
  assert.doesNotMatch(enTope, /Cargar más/);
  assert.match(enTope, /Mostrando los 10000 más recientes; filtrá por fechas para ver más\./);

  // Sin llegar al tope, el enlace avanza el límite con el paso habitual.
  const pagina = paginaAuditoria({ eventos: [evento], filtros: {}, limite: 200, hayMas: true, enTope: false });
  assert.match(pagina, /Cargar más/);
  assert.match(pagina, /limite=400/);
  assert.doesNotMatch(pagina, /Mostrando los/);
});

test('auditoría: tabla con caption/aria-label, encabezado fijo y hora legible con ISO', async () => {
  const base = crearBase();
  const registro = crearRegistroEventos({ dir: path.join(base, 'auditoria'), ahora: () => AHORA });
  registro.registrar({ tipo: 'job.creado', jobId: 'abc12345', estado: 'queued', actor: 'herramienta:coding' });
  await conBase(
    async (url) => {
      const html = await (await fetch(`${url}/auditoria`)).text();
      assert.match(html, /<div class="tabla-envoltorio">/);
      assert.match(html, /<table class="tabla-auditoria" aria-label="Eventos registrados, más recientes primero">/);
      assert.match(html, /<caption class="oculto">Eventos registrados, más recientes primero<\/caption>/);
      assert.match(html, /<th scope="col">Hora<\/th>/);
      // Hora legible dd/mm hh:mm:ss con el ISO en `datetime`/`title`.
      assert.match(html, /<time datetime="[^"]+Z" title="[^"]+Z">\d{2}\/\d{2} \d{2}:\d{2}:\d{2}<\/time>/);
      assert.match(html, /title="job\.creado">Trabajo creado/);
    },
    { registro },
  );
});

test('pizarrón: layout de página, cabecera con aria-current y shell del cliente', async () => {
  await conServidor(async (url) => {
    const html = await (await fetch(`${url}/pizarron`)).text();
    assert.match(html, /<main id="contenido" class="pagina" tabindex="-1">/);
    assert.match(html, /<a href="\/">Trabajos<\/a>/);
    assert.match(html, /<a href="\/pizarron" aria-current="page">Pizarrón<\/a>/);
    assert.match(html, /<a href="\/auditoria">Auditoría<\/a>/);
    assert.match(html, /src="\/static\/pizarron\.js"/);
    assert.match(html, /id="pizarron-estado"[^>]*role="status"/);
  });
});

test('estilos: layout de páginas secundarias con tokens, cabecera fija y foco visible', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    assert.match(css, /\.pagina\{/);
    assert.match(css, /max-width:1100px/);
    assert.match(css, /padding:calc\(var\(--esp\)\*5\) calc\(var\(--esp\)\*6\)/);
    assert.match(css, /\.filtros\{/);
    assert.match(css, /\.filtros label\{/);
    assert.match(css, /\.tabla-envoltorio\{/);
    assert.match(css, /position:sticky/);
    assert.match(css, /\.boton-primario\{/);
    assert.match(css, /:focus-visible\{outline:2px solid var\(--foco\)/);
    assert.match(css, /prefers-reduced-motion:reduce/);
    assert.match(css, /\.badge-historico\{/);
  });
});

test('estilos: páginas secundarias llenan el ancho con cabecera, contenedor y tablas al 100%', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // La cabecera no debe quedar recortada a un ancho menor al de la ventana.
    assert.match(css, /\.cabecera\{[^}]*width:100%/);
    // `.pagina` ocupa el 100% hasta 1100px y se centra; con border-box el padding
    // no ensancha el contenedor ni lo saca del viewport.
    assert.match(
      css,
      /\.pagina\{[^}]*width:100%[^}]*max-width:1100px[^}]*margin-inline:auto[^}]*box-sizing:border-box/,
    );
    // Las tablas llenan su contenedor y es el envoltorio el que scrollea dentro.
    assert.match(css, /\.tabla-auditoria\{[^}]*width:100%/);
    assert.match(css, /\.tabla-pizarron\{[^}]*width:100%/);
    assert.match(css, /\.tabla-envoltorio\{[^}]*overflow:auto/);
    // A 360 px no hay scroll horizontal de página: los campos se apilan al 100%.
    assert.match(css, /@media \(max-width:600px\)/);
    assert.match(css, /\.filtros input,\.filtros select\{width:100%/);
  });
});

test('pizarrón cliente: refresca sin perder scroll ni plegables y muestra el estado vacío informativo', () => {
  assert.match(PIZARRON_CLIENTE, /from '\/static\/lib\.js'/);
  assert.match(PIZARRON_CLIENTE, /formatearHoraEvento/);
  assert.match(PIZARRON_CLIENTE, /details\[data-clave\]\[open\]/);
  assert.match(PIZARRON_CLIENTE, /detalle\.open = true/);
  assert.match(PIZARRON_CLIENTE, /window\.scrollTo\(0, scrollY\)/);
  assert.match(PIZARRON_CLIENTE, /serial === ultimoSerial/);
  assert.match(PIZARRON_CLIENTE, /Todavía ningún agente compartió contexto\. Los agentes lo usan escribiendo \.orq\/aporte\.json/);
  assert.match(PIZARRON_CLIENTE, /'conflicto'/);
  assert.match(PIZARRON_CLIENTE, /enlaceTrabajo\(entrada\.jobId/);
  assert.match(PIZARRON_CLIENTE, /tabla-envoltorio/);
});

test('regresión 1: la cabecera principal trae conexión y UNA píldora de concurrencia, y el JS lee el DOM con tolerancia', async () => {
  await conServidor(async (url) => {
    const html = await (await fetch(`${url}/`)).text();
    // BUG de la ronda previa: NAV_PRINCIPAL no viajaba en `extra`, así que estos
    // ids no existían y renderCabecera lanzaba TypeError al hidratar.
    for (const id of ['conexion', 'conexion-texto', 'concurrencia', 'cola']) {
      const veces = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
      assert.equal(veces, 1, `id="${id}" debe aparecer exactamente una vez`);
    }
    // UNA sola píldora de concurrencia: ya no existe el `#contadores` que repetía
    // «Corriendo n/máx» al lado de la barra.
    assert.doesNotMatch(html, /id="contadores"/);
    // El navegador de secciones no se duplica: un solo <nav> de secciones.
    assert.equal((html.match(/aria-label="Secciones"/g) || []).length, 1);
    assert.doesNotMatch(html, /<nav[^>]*>\s*<nav/);
    // El botón de atajos sigue dentro del mismo nav.
    assert.match(html, /id="ayuda"/);
  });
  // El cliente lee el DOM con un helper tolerante a elementos ausentes.
  assert.match(CLIENTE, /const conElemento = function \(id, fn\)/);
  assert.match(CLIENTE, /conElemento\('concurrencia', function/);
  assert.match(CLIENTE, /conElemento\('cola', function/);
  assert.doesNotMatch(CLIENTE, /conElemento\('contadores'/);
  // La cabecera se actualiza en su propio try y no frena la carga/selección.
  assert.match(CLIENTE, /async function cargarEstadoCabecera\(\)/);
  assert.match(CLIENTE, /await cargarEstadoCabecera\(\)/);
  // La selección inicial ya no depende de /api/estado.
  assert.match(CLIENTE, /const objetivo = app\.seleccionado \|\| app\.seleccionadoInicial/);
});

test('resumen: franja de tarjetas, cajas con título, plegables con scroll y acciones', () => {
  assert.match(CLIENTE, /tarjetas-resumen/);
  assert.match(CLIENTE, /function tarjeta\(/);
  assert.match(CLIENTE, /function cajaConTitulo\(/);
  // Una caja por aviso/resultado, sin bloques vacíos.
  assert.match(CLIENTE, /cajaConTitulo\('Motivo de fin'/);
  assert.match(CLIENTE, /cajaConTitulo\('Advertencias'/);
  assert.match(CLIENTE, /cajaConTitulo\('Mutaciones'/);
  assert.match(CLIENTE, /cajaConTitulo\('Revisión'/);
  // «Última salida» plegable solo si hay output: sin salida no hay título ni caja.
  assert.match(CLIENTE, /if \(texto\.trim\(\) === ''\) return null/);
  assert.match(CLIENTE, /const ultima = bloqueUltimaSalida\(trabajo\.transcript\)/);
  // El plegable ya trae su propio «Última salida»: no se duplica con un <h3>.
  assert.doesNotMatch(CLIENTE, /crear\('h3', '', 'Última salida'\)/);
  // Acciones del resumen: solo abrir consola y copiar rama (dentro de la tarjeta).
  assert.match(CLIENTE, /'Copiar rama'/);
  assert.match(CLIENTE, /'Abrir consola'/);
  assert.match(CLIENTE, /activarTab\('consola'\)/);
  // «Copiar id» existe UNA sola vez, junto al título: el Resumen ya no lo repite.
  assert.match(CLIENTE, /'Copiar id'/);
  assert.doesNotMatch(CLIENTE, /botonCopiar\(trabajo\.id, 'Copiar id'\)/);
  assert.equal((PAGINA.match(/id="copiar-id"/g) || []).length, 1);
});

test('pestañas: contadores en la etiqueta, alcance solo si hay fuera, pestaña y scroll recordados', () => {
  assert.match(CLIENTE, /function actualizarEtiquetasTabs\(/);
  // El contador sale de la lib pura y omite el cero: «Diff» sin número si no hay.
  assert.match(CLIENTE, /etiquetaPestana\('Diff', cache\.nDiff\)/);
  assert.match(CLIENTE, /etiquetaPestana\('Eventos', cache\.nEventos\)/);
  assert.match(CLIENTE, /texto = 'Alcance';/);
  assert.match(CLIENTE, /aviso = true/);
  // El aviso de alcance NO aparece si no hay archivos fuera.
  assert.match(CLIENTE, /else if \(tab === 'alcance' && cache\.nFuera\)/);
  // Texto accesible para lectores de pantalla conviviendo con el contador.
  assert.match(CLIENTE, /boton\.setAttribute\('aria-label', aria\)/);
  // Pestaña activa por trabajo y scroll por pestaña+trabajo.
  assert.match(CLIENTE, /tabsPorTrabajo/);
  assert.match(CLIENTE, /app\.scrolls/);
  assert.match(CLIENTE, /function guardarScrollActual\(/);
  assert.match(CLIENTE, /function restaurarScroll\(/);
  assert.match(CLIENTE, /Resumen por defecto/);
});

test('consola: barra sticky con fuente, pausa, wrap, tamaño, copiar/descargar y búsqueda navegable', () => {
  assert.match(CLIENTE, /id = 'consola-ajustar'/);
  assert.match(CLIENTE, /id = 'consola-buscar'/);
  assert.match(CLIENTE, /id = 'consola-final'/);
  assert.match(CLIENTE, /id = 'consola-pie'/);
  assert.match(CLIENTE, /'Ajustar líneas'/);
  assert.match(CLIENTE, /CLAVE_ENVOLVER/);
  assert.match(CLIENTE, /CLAVE_TAMANO/);
  assert.match(CLIENTE, /TAMANO_MIN/);
  assert.match(CLIENTE, /TAMANO_MAX/);
  // Búsqueda con «n de m», Enter/Shift+Enter y resaltado sin depender del color solo.
  assert.match(CLIENTE, /coincidenciasEnLineas\(/);
  assert.match(CLIENTE, /navegarCoincidencia\(evento\.shiftKey \? -1 : 1\)/);
  assert.match(CLIENTE, /' de ' \+/);
  // Auto-seguimiento: pausa al subir, botón flotante con contador y reanudación.
  assert.match(CLIENTE, /debePausarSeguimiento\(/);
  assert.match(CLIENTE, /'Ir al final'/);
  assert.match(CLIENTE, /'En pausa'/);
  // Coloreo con refuerzo (clase por línea) y pie con el recorte.
  assert.match(CLIENTE, /claseDeLinea\(/);
  assert.match(CLIENTE, /se muestran las últimas ' \+ MAX_LINEAS/);
  // Atajos dentro de la consola.
  assert.match(CLIENTE, /Ctrl\/Cmd\+F/);
  assert.match(CLIENTE, /enfocarBusquedaConsola/);
});

test('diff: cabecera con totales y acciones, archivo abierto por defecto, grandes plegados y salto rápido', () => {
  assert.match(CLIENTE, /estadisticasDeParche\(/);
  assert.match(CLIENTE, /' archivos · \+'/);
  assert.match(CLIENTE, /'Expandir todo'/);
  assert.match(CLIENTE, /'Plegar todo'/);
  assert.match(CLIENTE, /'Copiar parche'/);
  assert.match(CLIENTE, /MAX_LINEAS_ARCHIVO/);
  assert.match(CLIENTE, /'Mostrar \(' \+ cantidad \+ ' líneas\)'/);
  assert.match(CLIENTE, /const abierto = archivos\.findIndex/);
  assert.match(CLIENTE, /diff-salto/);
  assert.match(CLIENTE, /archivo-barra/);
});

test('estilos ronda 2: consola a toda altura, esqueletos, scrollbars y sticky del diff', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // La consola llena la altura y scrollea por dentro.
    assert.match(css, /#panel-consola\.consola-panel\{[^}]*display:flex[^}]*min-height:0[^}]*overflow:hidden/);
    assert.match(css, /\.consola-salida\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow:auto/);
    // Wrap por defecto y scroll horizontal al desactivarlo.
    assert.match(css, /\.consola-salida\.sin-ajuste\{[^}]*white-space:pre[^}]*overflow-x:auto/);
    assert.match(css, /\.consola-barra\{[^}]*position:sticky/);
    // Estados de carga con esqueleto y errores ya con «Reintentar».
    assert.match(css, /\.esqueleto-linea\{/);
    // Barras finas y sticky de encabezados sin tapar contenido.
    assert.match(css, /scrollbar-width:thin/);
    assert.match(css, /details\.archivo>summary\{[^}]*position:sticky/);
    assert.match(css, /\[role=tabpanel\]\{[^}]*scroll-padding-top/);
    assert.match(css, /details\.archivo\{[^}]*scroll-margin-top/);
    // Tarjetas y cajas del resumen.
    assert.match(css, /\.tarjetas-resumen\{/);
    assert.match(css, /\.caja\{/);
  });
});

test('íconos: hay un SVG por estado, en 24x24, con currentColor y accesible', () => {
  const estados = ['queued', 'provisioning', 'running', 'verifying', 'succeeded', 'merged', 'failed', 'rejected', 'cancelled', 'lost'];
  for (const estado of estados) {
    const svg = svgIcono(estado);
    assert.match(svg, /^<svg /, estado);
    assert.match(svg, /viewBox="0 0 24 24"/, estado);
    assert.match(svg, /stroke="currentColor"/, estado);
    assert.match(svg, /aria-hidden="true"/, estado);
    assert.match(svg, /<(path|circle|rect) /, estado);
  }
  // Con etiqueta, el ícono es accesible (role=img + aria-label) en vez de oculto.
  assert.match(svgIcono('logo', { etiqueta: 'opencode-orchestrator' }), /role="img" aria-label="opencode-orchestrator"/);
  // El shell trae el monograma, el favicon SVG y el theme-color de ambos temas.
  assert.match(PAGINA, /marca-logo/);
  assert.match(PAGINA, /rel="icon" href="\/static\/favicon\.svg" type="image\/svg\+xml"/);
  assert.match(PAGINA, /name="theme-color" content="#f7f8fa" media="\(prefers-color-scheme: light\)"/);
  assert.match(PAGINA, /name="theme-color" content="#0e1116" media="\(prefers-color-scheme: dark\)"/);
  assert.match(PAGINA, /<svg class="icono-svg"/);
});

test('panel: sin glifos Unicode antiguos en el JS/HTML/CSS servidos', async () => {
  // Los íconos son SVG; ningún emoji/símbolo del diseño viejo debe quedar.
  const prohibidos = ['⏳', '▶', '✗', '⛔', '✔', '⚠', '⊘', '✖', '⚙', '🔎', '⏸'];
  await conServidor(async (url) => {
    const rutas = ['/', '/auditoria', '/pizarron', '/static/app.js', '/static/lib.js', '/static/iconos.js', '/static/app.css'];
    for (const ruta of rutas) {
      const texto = await (await fetch(`${url}${ruta}`)).text();
      for (const glifo of prohibidos) {
        assert.ok(!texto.includes(glifo), `${ruta} no debe contener el glifo ${glifo}`);
      }
    }
  });
});

/** Extrae los tokens hex del bloque claro y del oscuro del CSS servido. */
function tokensDe(css) {
  const claro = /:root\{([\s\S]*?)\}/.exec(css);
  const oscuro = /prefers-color-scheme:dark\)\{\s*:root\{([\s\S]*?)\}\}/.exec(css);
  const parsear = (bloque) => {
    const mapa = {};
    for (const coincidencia of bloque.matchAll(/--([a-z0-9-]+):(#[0-9a-fA-F]{3,6});/g)) {
      mapa[coincidencia[1]] = coincidencia[2];
    }
    return mapa;
  };
  return { claro: parsear(claro[1]), oscuro: parsear(oscuro[1]) };
}

test('tokens: contraste AA (>=4.5 texto, >=3 UI) en tema claro y oscuro', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    const { claro, oscuro } = tokensDe(css);
    const textos = ['texto', 'texto-2', 'texto-3'];
    const semanticos = ['exito', 'aviso', 'error', 'en-curso', 'integrado', 'cancelado'];
    for (const [tema, tokens] of [['claro', claro], ['oscuro', oscuro]]) {
      for (const nombre of textos) {
        for (const superficie of ['sup', 'sup-elev']) {
          assert.ok(
            contraste(tokens[nombre], tokens[superficie]) >= 4.5,
            `${tema}: --${nombre} sobre --${superficie} debe dar >= 4.5`,
          );
        }
      }
      for (const nombre of semanticos) {
        assert.ok(
          contraste(tokens[nombre], tokens['sup-elev']) >= 4.5,
          `${tema}: --${nombre} sobre --sup-elev debe dar >= 4.5`,
        );
      }
      assert.ok(contraste(tokens.acento, tokens.sup) >= 3, `${tema}: --acento sobre --sup debe dar >= 3`);
      assert.ok(contraste(tokens.foco, tokens.sup) >= 3, `${tema}: --foco sobre --sup debe dar >= 3`);
    }
    // Bordes/UI: el borde fuerte delimita controles y supera 3:1 sobre la base.
    assert.ok(contraste(claro['borde-fuerte'], claro['sup-elev']) >= 3, 'claro: --borde-fuerte');
    assert.ok(contraste(oscuro['borde-fuerte'], oscuro['sup']) >= 3, 'oscuro: --borde-fuerte');
  });
});

test('auditoría: chips de tipo de evento coloreados por categoría', () => {
  const eventos = [
    { ts: 1, tipo: 'job.creado', jobId: 'abc12345', estado: 'queued', actor: 'sistema' },
    { ts: 2, tipo: 'merge', jobId: 'abc12345', estado: 'merged', actor: 'sistema' },
    { ts: 3, tipo: 'pizarron.post', jobId: null, estado: undefined, actor: 'agente' },
  ];
  const html = paginaAuditoria({ eventos });
  assert.match(html, /class="chip-evento chip-job"[^>]*title="job\.creado">Trabajo creado/);
  assert.match(html, /class="chip-evento chip-merge"[^>]*title="merge">Integrado/);
  assert.match(html, /class="chip-evento chip-pizarron"/);
});

test('lista vacía: el estado vacío solo aparece con 0 filas y `[hidden]` lo oculta de verdad', async () => {
  // La decisión sale de la lib pura y el cliente la aplica con `hidden`.
  assert.match(CLIENTE, /debeMostrarVacio\(visibles\.length\)/);
  assert.match(CLIENTE, /porId\('lista-vacia'\)\.hidden = !debeMostrarVacio\(visibles\.length\)/);
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // `.vacia{display:flex}` pisaba el `[hidden]` del navegador: la regla explícita
    // impide que «No hay trabajos que coincidan» quede visible con filas presentes.
    assert.match(css, /\.vacia\[hidden\]\{display:none\}/);
  });
});

test('toolbar angosta: segmentado en 4 columnas y grilla auto-fit de controles sin desborde', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // Fila 2: el segmentado reparte el ancho en 4 partes iguales.
    assert.match(css, /\.segmentado\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
    // Las etiquetas largas se cambian por cortas cuando la columna es angosta.
    assert.match(css, /@container \(max-width:520px\)/);
    assert.match(css, /\.chip-corto\{display:none\}/);
    // Fila 3: grilla que reencuadra sola, con min-width:0 y elipsis.
    assert.match(css, /\.toolbar-fila\{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(120px,1fr\)\)/);
    assert.match(css, /\.toolbar-fila select\{[^}]*min-width:0/);
  });
  // Cada chip lleva etiqueta larga y corta, con `title` y aria-label completos.
  assert.match(CLIENTE, /const ETIQUETA_CORTA_ESTADO/);
  assert.match(CLIENTE, /crear\('span', 'chip-largo', def\[1\]\)/);
  assert.match(CLIENTE, /crear\('span', 'chip-corto', ETIQUETA_CORTA_ESTADO/);
  assert.match(CLIENTE, /boton\.setAttribute\('aria-label', def\[1\]\)/);
});

test('cabecera: min-width:0, píldoras compactas y sin scroll horizontal de página', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // Red de seguridad de página + contenedores que pueden encogerse.
    assert.match(css, /html,body\{[^}]*overflow-x:hidden/);
    assert.match(css, /\.cabecera\{[^}]*min-width:0/);
    assert.match(css, /\.cabecera-titulo\{[^}]*min-width:0/);
    assert.match(css, /\.cabecera-nav\{[^}]*min-width:0/);
    // Móvil: píldoras compactas y «En vivo» como punto (el texto se oculta).
    assert.match(css, /@media \(max-width:640px\)/);
    assert.match(css, /\.pill-corto\{display:inline\}/);
    assert.match(css, /#conexion-texto\{display:none\}/);
  });
  // El aria-label del punto conserva el significado al ocultar el texto.
  assert.match(CLIENTE, /caja\.setAttribute\('aria-label', vivo \? 'En vivo' : 'Reconectando'\)/);
  // Una sola píldora de concurrencia y, si hay cola, una sola adicional.
  assert.equal((CLIENTE.match(/conElemento\('concurrencia'/g) || []).length, 1);
  assert.equal((CLIENTE.match(/conElemento\('cola'/g) || []).length, 1);
});

test('autoselección: solo en escritorio (>=900px) y nunca cuando hay ?job', () => {
  // La guardia por ancho evita abrir el detalle del primero en móvil/tablet.
  assert.match(CLIENTE, /app\.trabajos\.length && debeAutoseleccionar\(window\.innerWidth, false\)/);
});

test('tipografía: define los cuatro tokens de fuente y ninguna familia literal fuera de :root', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // Los cuatro roles tipográficos existen como tokens en :root.
    for (const token of ['--fuente-ui:', '--fuente-titulo:', '--fuente-codigo:', '--fuente-numeros:']) {
      assert.ok(css.includes(token), `falta el token ${token}`);
    }
    assert.match(css, /--fuente-ui:ui-sans-serif,/);
    assert.match(css, /--fuente-titulo:ui-sans-serif,/);
    assert.match(css, /--fuente-codigo:ui-monospace,/);
    assert.match(css, /--fuente-numeros:var\(--fuente-ui\)/);
    // Compatibilidad: los nombres previos apuntan a los tokens nuevos.
    assert.match(css, /--fuente:var\(--fuente-ui\)/);
    assert.match(css, /--fuente-mono:var\(--fuente-codigo\)/);
    // Sin webfonts ni familias literales fuera de los tokens: se quitan los :root.
    const sinRaiz = css.replace(/:root\{[\s\S]*?\}/g, '');
    assert.doesNotMatch(sinRaiz, /ui-sans-serif|ui-monospace|sans-serif|monospace|'Segoe UI'|Arial|Menlo|Consolas/i);
    // Toda declaración font-family de una regla sale de un token (o hereda).
    for (const coincidencia of sinRaiz.matchAll(/font-family:([^;}]+)/g)) {
      assert.match(coincidencia[1].trim(), /^(var\(--fuente-|inherit)/, `font-family literal: ${coincidencia[1]}`);
    }
  });
});

test('tipografía: controles nativos heredan la fuente y se les asigna su rol (13px/500)', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // Sin esto los botones/inputs caen en la fuente del navegador, no en la UI.
    assert.match(css, /button,input,select,textarea,summary,optgroup\{font:inherit\}/);
    assert.match(css, /::placeholder\{font-family:inherit/);
    // Botones y pestañas: 13px con peso 500 (nunca 400).
    assert.match(css, /\.boton\{[^}]*font-size:13px;font-weight:500/);
    assert.match(css, /\.tabs \[role=tab\]\{[^}]*font-size:13px;font-weight:500/);
    // Chips y badges: 600 con tracking liviano.
    assert.match(css, /\.chip\{[^}]*font-weight:600;letter-spacing:\.01em/);
    assert.match(css, /\.badge\{[^}]*font-weight:600;letter-spacing:\.01em/);
    assert.match(css, /\.chip-evento\{[^}]*font-weight:600;letter-spacing:\.01em/);
    // Renderizado y kerning consistentes en html/body.
    for (const prop of [
      'font-synthesis:none',
      'font-optical-sizing:auto',
      'text-size-adjust:100%',
      'font-kerning:normal',
      '-webkit-font-smoothing:antialiased',
      'text-rendering:optimizeLegibility',
    ]) {
      assert.ok(css.includes(prop), `falta ${prop}`);
    }
  });
});

test('tipografía: código en la monoespaciada, números tabulares y texto en la de UI', async () => {
  await conServidor(async (url) => {
    const css = await (await fetch(`${url}/static/app.css`)).text();
    // Consola, diff, rutas, ids de trabajo, ramas (`.mono`) y JSON del pizarrón.
    assert.match(css, /code,kbd,samp,pre,\.mono\{font-family:var\(--fuente-codigo\)/);
    assert.match(css, /\.consola-salida\{[^}]*font-family:var\(--fuente-codigo\)/);
    assert.match(css, /\.parche\{[^}]*font-family:var\(--fuente-codigo\)/);
    assert.match(css, /\.archivo-ruta\{font-family:var\(--fuente-codigo\)/);
    assert.match(css, /\.trabajo-id\{font-family:var\(--fuente-codigo\)/);
    assert.match(css, /\.valor-pizarron\{font-family:var\(--fuente-codigo\)/);
    // El código no lleva ligaduras que confundan (calt/liga en 0).
    assert.match(css, /code,kbd,samp,pre,\.mono\{[^}]*font-variant-ligatures:none/);
    assert.match(css, /code,kbd,samp,pre,\.mono\{[^}]*font-feature-settings:'calt' 0,'liga' 0/);
    // Números tabulares en contadores, duraciones y horas.
    assert.match(css, /\.num,\.tarjeta-valor,[^{]*\{font-variant-numeric:tabular-nums/);
    assert.match(css, /\.evento-hora\{[^}]*font-family:var\(--fuente-numeros\)/);
    assert.match(css, /\.tabla-auditoria time\{[^}]*font-family:var\(--fuente-numeros\)/);
    // Texto no-código (prompt, preview de tarea) en la fuente de UI, nunca mono.
    assert.match(css, /\.prompt\{[^}]*font-family:var\(--fuente-ui\)/);
    assert.match(css, /\.plegable-preview\{[^}]*font-family:var\(--fuente-ui\)/);
    assert.doesNotMatch(css, /\.plegable-preview\{[^}]*fuente-codigo/);
    // Títulos con la familia de display y la marca de página en el h1.
    assert.match(css, /h1,h2,h3\{font-family:var\(--fuente-titulo\)/);
    // En la auditoría la columna «Trabajo» es un enlace de UI.
    assert.match(css, /\.tabla-auditoria \.celda-trabajo a\{font-family:var\(--fuente-ui\)/);
  });
});

