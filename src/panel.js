#!/usr/bin/env node
/**
 * Panel en vivo de los trabajos de opencode-orchestrator (solo lectura).
 * Uso: `node src/panel.js` -> http://localhost:7070 (`ORQ_PANEL_PORT`, `ORQ_PANEL_HOST`).
 */
import { crearServidorPanel } from './panel/servidor.js';

const puerto = Number(process.env.ORQ_PANEL_PORT ?? 7070);
const host = process.env.ORQ_PANEL_HOST ?? '127.0.0.1';
const servidor = crearServidorPanel();
servidor.listen(puerto, host, () => {
  process.stderr.write(`panel de trabajos en http://${host}:${puerto}\n`);
});
