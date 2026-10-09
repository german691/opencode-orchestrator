#!/usr/bin/env node
/**
 * Panel en vivo de los trabajos de opencode-orchestrator (solo lectura).
 * Uso: `node src/panel.js` -> http://localhost:7480 (`ORQ_PANEL_PORT`, `ORQ_PANEL_HOST`).
 */
import { crearServidorPanel } from './panel/servidor.js';
import { directorioEstado } from './panel/datos.js';
import { crearRegistroEventos } from './core/eventos.js';

const puerto = Number(process.env.ORQ_PANEL_PORT ?? 7480);
const host = process.env.ORQ_PANEL_HOST ?? '127.0.0.1';
// El panel abre su propio registro sobre el MISMO directorio de estado que el servidor
// (append-only), así /auditoria y /api/eventos dejan de decir "no disponible".
const registro = crearRegistroEventos({ dir: directorioEstado() });
const servidor = crearServidorPanel({ registro });
servidor.listen(puerto, host, () => {
  process.stderr.write(`panel de trabajos en http://${host}:${puerto}\n`);
});
