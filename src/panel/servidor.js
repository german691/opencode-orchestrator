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
 *        GET /api/stream              Server-Sent Events (trabajos y estado)
 */
import http from 'node:http';
import path from 'node:path';
import {
  directorioEstado,
  listarTrabajos,
  detalleDeTrabajo,
  resumenDeTrabajo,
  estadoDelPanel,
  alcanceDeTrabajo,
  eventosDeTrabajo,
  leerTrabajo,
  idValido,
  idDePanel,
} from './datos.js';
import { leerRango, archivoDeFuente, LIMITE_MAX } from './logs.js';
import { diffDeTrabajo } from './diff.js';
import { crearFlujoEventos } from './stream.js';
import { PAGINA, paginaAuditoria } from './pagina.js';
import { TIPOS } from '../core/eventos.js';

function responderJson(res, estado, cuerpo) {
  const texto = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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

/**
 * Atiende las rutas NUEVAS por trabajo (`log`, `diff`, `alcance`, `eventos`).
 * @returns {Promise<boolean>} si la ruta fue manejada
 */
async function atenderSubruta(res, { accion, id, dirTrabajos, ahora, registro, params }) {
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

  // eventos: el registro filtrado por jobId, tal cual (vacío si no hay registro).
  const limite = numeroDeQuery(params.get('limite')) ?? 200;
  responderJson(res, 200, eventosDeTrabajo(registro, id, { limite }));
  return true;
}

/**
 * Crea (sin escuchar) el servidor del panel.
 * @param {object} [opciones]
 * @param {string} [opciones.baseDir] directorio de estado (contiene `jobs/`)
 * @param {() => number} [opciones.ahora] reloj inyectable
 * @param {object} [opciones.registro] registro de eventos inyectable
 * @param {number|null} [opciones.concurrencia] concurrencia del perfil, si se conoce
 * @param {object} [opciones.stream] overrides del flujo SSE (intervalos, máximo)
 */
export function crearServidorPanel({ baseDir, ahora = Date.now, registro, concurrencia = null, stream } = {}) {
  const dirTrabajos = `${baseDir ?? directorioEstado()}/jobs`;
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
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGINA);
        return;
      }
      if (pathname === '/auditoria') {
        const filtros = leerFiltros(url.searchParams);
        const eventos = registro ? registro.listar(filtros) : [];
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(paginaAuditoria({ eventos, tipos: registro?.tipos ?? TIPOS, filtros, disponible: Boolean(registro) }));
        return;
      }
      if (pathname === '/api/eventos') {
        if (!registro) {
          responderJson(res, 503, { error: 'auditoría no disponible' });
          return;
        }
        responderJson(res, 200, { ahora: ahora(), eventos: registro.listar(leerFiltros(url.searchParams)) });
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
          registro,
          params: url.searchParams,
        });
        return;
      }
      if (pathname === '/api/trabajos') {
        responderJson(res, 200, { ahora: ahora(), trabajos: listarTrabajos(dirTrabajos, ahora()) });
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
