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
 */
import http from 'node:http';
import { directorioEstado, listarTrabajos, detalleDeTrabajo, idValido } from './datos.js';
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
 * Crea (sin escuchar) el servidor del panel.
 * @param {{ baseDir?: string, ahora?: () => number, registro?: object }} [opciones]
 */
export function crearServidorPanel({ baseDir, ahora = Date.now, registro } = {}) {
  const dirTrabajos = `${baseDir ?? directorioEstado()}/jobs`;
  return http.createServer((req, res) => {
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
}
