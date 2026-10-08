/**
 * Servidor HTTP del panel en vivo (solo lectura).
 *
 * POR QUÉ: dar tranquilidad de que los agentes trabajan (o detectar rápido que
 * uno está atascado) sin tocar al orquestador. Solo atiende GET, nunca escribe
 * en el directorio de estado y no usa dependencias.
 *
 * Rutas: GET /            página
 *        GET /api/trabajos            lista con semáforo de atasco
 *        GET /api/trabajos/:id        detalle (transcript, respuesta, fallos)
 */
import http from 'node:http';
import { directorioEstado, listarTrabajos, detalleDeTrabajo, idValido } from './datos.js';
import { PAGINA } from './pagina.js';

function responderJson(res, estado, cuerpo) {
  const texto = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(texto);
}

/**
 * Crea (sin escuchar) el servidor del panel.
 * @param {{ baseDir?: string, ahora?: () => number }} [opciones]
 */
export function crearServidorPanel({ baseDir, ahora = Date.now } = {}) {
  const dirTrabajos = `${baseDir ?? directorioEstado()}/jobs`;
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGINA);
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
