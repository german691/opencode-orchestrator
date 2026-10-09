import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crearServidorPanel, hostPermitido, concurrenciaDeEntorno, CONCURRENCIA_POR_DEFECTO } from '../src/panel/servidor.js';
import { PAGINA } from '../src/panel/pagina.js';
import { CLIENTE } from '../src/panel/cliente.js';
import { PIZARRON_CLIENTE } from '../src/panel/pizarron-cliente.js';
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
    ['/static/pizarron.js', /^text\/javascript/],
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

test('UI: chips de repositorio, localStorage, ?repo=, aria-busy, Reintentar y Corriendo n/máx', () => {
  // El contenedor donde el cliente pinta los repositorios va en la columna izquierda.
  assert.match(PAGINA, /id="chips-repo"/);
  assert.match(PAGINA, /aria-label="Filtrar por repositorio"/);
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
  // La cabecera muestra 'Corriendo n/máx' con la concurrencia del entorno.
  assert.match(CLIENTE, /'Corriendo ' \+ usada \+ '\/' \+ maxima/);
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
    assert.match(css, /:focus-visible\{outline:3px solid var\(--foco\)/);
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
