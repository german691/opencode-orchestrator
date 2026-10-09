/**
 * Servidor HTTP del panel en vivo (solo lectura).
 *
 * POR QUÉ: dar tranquilidad de que los agentes trabajan (o detectar rápido que
 * uno está atascado) sin tocar al orquestador. Solo atiende GET, nunca escribe
 * en el directorio de estado y no usa dependencias.
 *
 * Rutas: GET /            página
 *        GET /auditoria               página de auditoría (registro de eventos)
 *        GET /api/trabajos            lista con semáforo de atasco
 *        GET /api/trabajos/:id        detalle (transcript, respuesta, fallos)
 *        GET /api/eventos             eventos de auditoría filtrables
 *        GET /api/estado              resumen global (cola, corriendo, último evento)
 *        GET /api/trabajos/:id/log    log por rangos (agente/aceptación/stderr)
 *        GET /api/trabajos/:id/diff   diff git contra la base del trabajo
 *        GET /api/trabajos/:id/alcance writes/tocados/fuera del trabajo
 *        GET /api/trabajos/:id/eventos eventos del registro para ese trabajo
 *        GET /pizarron                página del pizarrón compartido
 *        GET /api/pizarron            documento del pizarrón (solo lectura)
 *        GET /api/stream              Server-Sent Events (trabajos y estado)
 */
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  directorioEstado,
  listarTrabajos,
  listarTrabajosPaginado,
  detalleDeTrabajo,
  resumenDeTrabajo,
  estadoDelPanel,
  alcanceDeTrabajo,
  leerTrabajo,
  leerPizarron,
  idValido,
  idDePanel,
} from './datos.js';
import { leerRango, archivoDeFuente, LIMITE_MAX } from './logs.js';
import { diffDeTrabajo } from './diff.js';
import { crearFlujoEventos } from './stream.js';
import { PAGINA, paginaAuditoria, paginaPizarron, PASO_EVENTOS } from './pagina.js';
import { crearHistorial } from './historial.js';
import { PIZARRON_CLIENTE } from './pizarron-cliente.js';
import { ESTILOS } from './estilos.js';
import { CLIENTE } from './cliente.js';
import { TIPOS } from '../core/eventos.js';

// El cliente importa la librería pura como módulo ES desde `/static/lib.js`; se
// sirve el mismo archivo que importan los tests, leído tal cual para no duplicarlo.
const LIB = readFileSync(new URL('./cliente-lib.js', import.meta.url), 'utf8');

/**
 * CSP restrictiva del panel: sin recursos ni código en línea (todo sale de
 * `/static/*` o de la propia API). Se aplica a las páginas HTML.
 */
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:";

/**
 * Hosts considerados loopback. El panel NO tiene autenticación, así que escuchar
 * fuera de estos expondría el estado de los trabajos a la red.
 */
const HOSTS_LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/**
 * Decide si se puede escuchar en `host`. Función PURA (sin abrir sockets) para
 * poder testear la negativa sin arrancar el servidor.
 * @param {string} host
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function hostPermitido(host, env = process.env) {
  if (env.ORQ_PANEL_ALLOW_REMOTE === '1') return true;
  return HOSTS_LOOPBACK.has(String(host ?? '').toLowerCase());
}

/**
 * Mismo tope por defecto que usa el servidor MCP: `src/server.js` toma 8 para
 * `ORQ_CONCURRENCY`. Se duplica acá con un comentario para no acoplar el panel al
 * servidor; si cambia el default global hay que tocar los dos lugares.
 */
export const CONCURRENCIA_POR_DEFECTO = 8;

/**
 * Concurrencia configurada por entorno, acotada a 1..16 igual que el servidor MCP.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function concurrenciaDeEntorno(env = process.env) {
  const valor = Number(env.ORQ_CONCURRENCY);
  if (!Number.isInteger(valor) || valor < 1) return CONCURRENCIA_POR_DEFECTO;
  return Math.min(16, valor);
}

/** Cabeceras de las páginas HTML (CSP + anti sniffing). */
const CABECERAS_HTML = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
};

/** ETag fuerte y estable del contenido estático (permite 304 al revalidar). */
function etagDe(texto) {
  return `"${createHash('sha1').update(texto).digest('hex')}"`;
}

/**
 * Sirve contenido estático con `no-cache` + ETag. POR QUÉ `no-cache` y no
 * `no-store`: el navegador puede revalidar y recibir 304 sin volver a bajar el
 * cuerpo, que es lo óptimo para un panel que se recarga seguido.
 */
function servirEstatico(req, res, contenido, tipo) {
  const etag = etagDe(contenido);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': tipo,
    'cache-control': 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
  });
  res.end(contenido);
}

function responderJson(res, estado, cuerpo) {
  const texto = JSON.stringify(cuerpo);
  // `nosniff` también en JSON: evita que el navegador intente interpretar la
  // respuesta como otro tipo y `no-store` evita cachear el estado en vivo.
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(texto);
}

/** Convierte un parámetro de query a número finito; `undefined` si viene vacío. */
function numeroDeQuery(valor) {
  if (valor === null || valor === '') return undefined;
  const n = Number(valor);
  return Number.isFinite(n) ? n : undefined;
}

/** Extrae los filtros soportados por el registro desde el query string. */
function leerFiltros(params) {
  const filtros = {};
  const jobId = params.get('jobId');
  const tipo = params.get('tipo');
  const desde = numeroDeQuery(params.get('desde'));
  const hasta = numeroDeQuery(params.get('hasta'));
  const limite = numeroDeQuery(params.get('limite'));
  if (jobId) filtros.jobId = jobId;
  if (tipo) filtros.tipo = tipo;
  if (desde !== undefined) filtros.desde = desde;
  if (hasta !== undefined) filtros.hasta = hasta;
  if (limite !== undefined) filtros.limite = limite;
  return filtros;
}

/** Normaliza el `limite` de eventos: por defecto 200, acotado a 1..10000. */
function normalizarLimiteEventos(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return PASO_EVENTOS;
  return Math.min(10_000, Math.trunc(n));
}

/**
 * Atiende las rutas NUEVAS por trabajo (`log`, `diff`, `alcance`, `eventos`).
 * @returns {Promise<boolean>} si la ruta fue manejada
 */
async function atenderSubruta(res, { accion, id, dirTrabajos, ahora, historial, params }) {
  // El id se valida ANTES de tocar el disco: ninguna variante (codificada o no)
  // puede colarse como ruta.
  if (!idDePanel(id)) {
    responderJson(res, 400, { error: 'id de trabajo inválido' });
    return true;
  }
  if (!resumenDeTrabajo(dirTrabajos, id, ahora())) {
    responderJson(res, 404, { error: 'trabajo no encontrado' });
    return true;
  }

  if (accion === 'log') {
    const fuente = params.get('fuente') ?? 'agente';
    const archivo = archivoDeFuente(fuente);
    if (!archivo) {
      responderJson(res, 400, { error: `fuente desconocida: ${fuente}` });
      return true;
    }
    const desde = numeroDeQuery(params.get('desde')) ?? 0;
    const limite = numeroDeQuery(params.get('limite')) ?? LIMITE_MAX;
    const ansi = params.get('ansi') === '1';
    responderJson(res, 200, leerRango(path.join(dirTrabajos, id, archivo), { desde, limite, ansi }));
    return true;
  }

  if (accion === 'diff') {
    responderJson(res, 200, await diffDeTrabajo(leerTrabajo(dirTrabajos, id)));
    return true;
  }

  if (accion === 'alcance') {
    responderJson(res, 200, await alcanceDeTrabajo(dirTrabajos, id, { ahora: ahora() }));
    return true;
  }

  // eventos: el historial filtrado por jobId (reconstruido si el registro no tiene ese trabajo).
  const limite = numeroDeQuery(params.get('limite')) ?? 200;
  responderJson(res, 200, historial.listar({ jobId: id, limite }));
  return true;
}

/**
 * Crea (sin escuchar) el servidor del panel.
 * @param {object} [opciones]
 * @param {string} [opciones.baseDir] directorio de estado (contiene `jobs/`)
 * @param {() => number} [opciones.ahora] reloj inyectable
 * @param {object} [opciones.registro] registro de eventos inyectable
 * @param {object} [opciones.historial] historial inyectable (registro + reconstrucción)
 * @param {number|null} [opciones.concurrencia] concurrencia del perfil, si se conoce
 * @param {object} [opciones.stream] overrides del flujo SSE (intervalos, máximo)
 */
export function crearServidorPanel({
  baseDir,
  ahora = Date.now,
  registro,
  historial = null,
  concurrencia = null,
  stream,
} = {}) {
  const dirEstado = baseDir ?? directorioEstado();
  const dirTrabajos = `${dirEstado}/jobs`;
  const historialEfectivo =
    historial ?? crearHistorial({ dirTrabajos, dirEstado, registro, ahora: () => ahora() });
  const flujo = crearFlujoEventos({
    trabajos: () => listarTrabajos(dirTrabajos, ahora()),
    estado: () => estadoDelPanel(dirTrabajos, { ahora: ahora(), registro, concurrencia }),
    ahora: () => ahora(),
    ...stream,
  });
  const servidor = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/') {
        res.writeHead(200, CABECERAS_HTML);
        res.end(PAGINA);
        return;
      }
      if (pathname === '/auditoria') {
        const filtros = leerFiltros(url.searchParams);
        const limite = normalizarLimiteEventos(filtros.limite);
        // Se pide uno de más para saber si queda otra página sin contar todo.
        const encontrados = historialEfectivo.listar({ ...filtros, limite: limite + 1 });
        const hayMas = encontrados.length > limite;
        const eventos = hayMas ? encontrados.slice(0, limite) : encontrados;
        res.writeHead(200, CABECERAS_HTML);
        res.end(
          paginaAuditoria({
            eventos,
            tipos: registro?.tipos ?? TIPOS,
            filtros,
            disponible: Boolean(registro),
            titulos: historialEfectivo.titulos(),
            limite,
            hayMas,
          }),
        );
        return;
      }
      if (pathname === '/pizarron') {
        res.writeHead(200, CABECERAS_HTML);
        res.end(paginaPizarron());
        return;
      }
      if (pathname === '/static/app.css') {
        servirEstatico(req, res, ESTILOS, 'text/css; charset=utf-8');
        return;
      }
      if (pathname === '/static/app.js') {
        servirEstatico(req, res, CLIENTE, 'text/javascript; charset=utf-8');
        return;
      }
      if (pathname === '/static/pizarron.js') {
        servirEstatico(req, res, PIZARRON_CLIENTE, 'text/javascript; charset=utf-8');
        return;
      }
      if (pathname === '/static/lib.js') {
        servirEstatico(req, res, LIB, 'text/javascript; charset=utf-8');
        return;
      }
      if (pathname === '/api/pizarron') {
        responderJson(res, 200, leerPizarron(dirEstado));
        return;
      }
      if (pathname === '/api/eventos') {
        if (!registro) {
          responderJson(res, 503, { error: 'auditoría no disponible' });
          return;
        }
        const filtros = leerFiltros(url.searchParams);
        filtros.limite = normalizarLimiteEventos(filtros.limite);
        responderJson(res, 200, { ahora: ahora(), eventos: historialEfectivo.listar(filtros) });
        return;
      }
      if (pathname === '/api/estado') {
        responderJson(res, 200, estadoDelPanel(dirTrabajos, { ahora: ahora(), registro, concurrencia }));
        return;
      }
      if (pathname === '/api/stream') {
        flujo.atender(req, res);
        return;
      }
      const subruta = /^\/api\/trabajos\/([^/]+)\/(log|diff|alcance|eventos)$/.exec(pathname);
      if (subruta) {
        const id = decodeURIComponent(subruta[1]);
        await atenderSubruta(res, {
          accion: subruta[2],
          id,
          dirTrabajos,
          ahora,
          historial: historialEfectivo,
          params: url.searchParams,
        });
        return;
      }
      if (pathname === '/api/trabajos') {
        // El listado es liviano (sin prompt/transcript) y acepta `?limite=` (300 por
        // defecto, máx 1000), `?desde=` (id o timestamp, para paginar) y `?repo=`.
        // Compatibilidad: se mantienen los campos de siempre y solo se AGREGAN.
        const { trabajos, total } = listarTrabajosPaginado(dirTrabajos, {
          ahora: ahora(),
          limite: url.searchParams.get('limite'),
          desde: url.searchParams.get('desde'),
          repo: url.searchParams.get('repo'),
        });
        responderJson(res, 200, { ahora: ahora(), trabajos, total });
        return;
      }
      const coincide = /^\/api\/trabajos\/([^/]+)$/.exec(pathname);
      if (coincide) {
        const id = decodeURIComponent(coincide[1]);
        const detalle = idValido(id) ? detalleDeTrabajo(dirTrabajos, id, ahora()) : null;
        if (!detalle) responderJson(res, 404, { error: 'trabajo no encontrado' });
        else responderJson(res, 200, detalle);
        return;
      }
      responderJson(res, 404, { error: 'no encontrado' });
    } catch (error) {
      responderJson(res, 500, { error: String(error?.message ?? error) });
    }
  });
  // Al apagar, cerrar los clientes SSE para no dejar timers vivos.
  servidor.on('close', () => flujo.cerrar());
  return servidor;
}
