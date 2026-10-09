#!/usr/bin/env node
/**
 * Datos de demostración del panel (`node scripts/panel-demo.js [--puerto N]`).
 *
 * POR QUÉ: para revisar el acabado visual de `/auditoria` y `/pizarron` (y de la
 * lista de trabajos) hace falta un estado REPRESENTATIVO: trabajos de todos los
 * estados, eventos reales de todos los tipos, trabajos viejos sin registro (que
 * la UI reconstruye), pizarrón con una clave en conflicto y logs largos con ANSI.
 *
 * SEGURIDAD: siempre corre sobre un directorio TEMPORAL propio; si el entorno ya
 * trae un `ORQ_STATE_DIR` que existe en disco (el estado REAL del usuario) se
 * niega a arrancar en vez de escribir sobre él. Al salir con Ctrl-C borra el
 * temporal.
 *
 * Uso: `node scripts/panel-demo.js --puerto 7490` -> http://127.0.0.1:7490
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearServidorPanel } from '../src/panel/servidor.js';
import { crearRegistroEventos } from '../src/core/eventos.js';

/** Puerto por defecto del panel de demostración (no pisa el 7480 real). */
export const PUERTO_DEMO = 7490;

/** Timestamp fijo de referencia para que la demo se vea estable. */
const BASE_TS = Date.parse('2026-10-09T12:00:00.000Z');

/** ¿El `ORQ_STATE_DIR` del entorno apunta a un estado real ya existente? */
export function estadoRealPreexistente(env = process.env) {
  const dir = env.ORQ_STATE_DIR;
  if (typeof dir !== 'string' || dir === '') return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Escribe un `job.json` y devuelve el directorio del trabajo. */
function escribirTrabajo(base, definicion) {
  const { id, ...resto } = definicion;
  const dir = path.join(base, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, ...resto }, null, 2));
  return dir;
}

/** Log de ejemplo con líneas largas, ANSI y varios cientos de líneas. */
function logDeEjemplo(etiqueta, lineas, { ansi = false, larga = false } = {}) {
  const salida = [];
  for (let i = 1; i <= lineas; i += 1) {
    const prefijo = ansi ? '\u001b[36m' : '';
    const sufijo = ansi ? '\u001b[0m' : '';
    const cola = larga && i % 20 === 0 ? ' ' + 'detalle-largo-'.repeat(30) : '';
    salida.push(`${prefijo}${etiqueta} ${String(i).padStart(4, '0')} ${new Date(BASE_TS + i * 1000).toISOString()}${sufijo}${cola}`);
  }
  return salida.join('\n') + '\n';
}

/**
 * Genera el estado de demostración completo dentro de `base`.
 * @param {string} base directorio de estado temporal
 * @returns {{ trabajos: string[], eventos: number, claves: number, notas: number }}
 */
export function crearEstadoDemo(base) {
  const ahora = BASE_TS + 6 * 60 * 60 * 1000;
  const dirJobs = path.join(base, 'jobs');
  fs.mkdirSync(dirJobs, { recursive: true });

  const seg = (n) => ahora - n * 1000;
  const definiciones = [
    { id: 'demo0001', titulo: 'Refactor del carrito', estado: 'running', repoNombre: 'compras', mode: 'safe', modelo: 'deepseek/v4', rama: 'job/demo0001', writes: ['src/carrito/**'], creadoEn: seg(700), inicioEn: seg(650) },
    { id: 'demo0002', titulo: 'Migrar tests de pagos', estado: 'running', repoNombre: 'compras', mode: 'safe', modelo: 'deepseek/v4', rama: 'job/demo0002', writes: ['tests/pagos/**'], creadoEn: seg(300), inicioEn: seg(280) },
    { id: 'demo0003', titulo: 'Arreglar índice de búsqueda', estado: 'queued', repoNombre: 'compras', mode: 'safe', writes: ['src/busqueda/**'], creadoEn: seg(120), espera: { motivo: 'concurrencia', por: ['demo0001'] } },
    { id: 'demo0004', titulo: 'Documentar la API', estado: 'succeeded', repoNombre: 'opencode-orchestrator', mode: 'safe', modelo: 'deepseek/v4', rama: 'job/demo0004', writes: ['docs/**'], creadoEn: seg(9000), inicioEn: seg(8900), finEn: seg(7200), motivoFin: null, resultado: { archivos: ['docs/API.md'], aceptacion: { cmd: 'npm test', ejecutada: true, exit: 0 }, advertencias: [] } },
    { id: 'demo0005', titulo: 'Integrar panel en vivo', estado: 'merged', repoNombre: 'opencode-orchestrator', mode: 'safe', rama: 'job/demo0005', writes: ['src/panel/**'], creadoEn: seg(20000), inicioEn: seg(19900), finEn: seg(17000), resultado: { commit: 'abc1234', archivos: ['src/panel/pagina.js'] } },
    { id: 'demo0006', titulo: 'Reintentar compilación', estado: 'failed', repoNombre: 'compras', mode: 'safe', rama: 'job/demo0006', writes: ['build/**'], creadoEn: seg(15000), inicioEn: seg(14900), finEn: seg(14000), motivoFin: 'exit_distinto_de_cero' },
    { id: 'demo0007', titulo: 'Tocar archivo prohibido', estado: 'rejected', repoNombre: 'compras', mode: 'safe', rama: 'job/demo0007', writes: ['src/**'], creadoEn: seg(25000), inicioEn: seg(24900), finEn: seg(24000), motivoFin: 'alcance' },
    { id: 'demo0008', titulo: 'Aceptación en rojo', estado: 'rejected', repoNombre: 'opencode-orchestrator', mode: 'safe', rama: 'job/demo0008', writes: ['test/**'], creadoEn: seg(30000), inicioEn: seg(29900), finEn: seg(29000), motivoFin: 'aceptacion', resultado: { aceptacion: { cmd: 'npm test', ejecutada: true, exit: 1 } } },
    { id: 'demo0009', titulo: 'Cancelar despliegue', estado: 'cancelled', repoNombre: 'compras', mode: 'safe', rama: 'job/demo0009', writes: ['deploy/**'], creadoEn: seg(40000), inicioEn: seg(39900), finEn: seg(39000), motivoFin: 'cancelado' },
    { id: 'demo0010', titulo: 'Con advertencias de alcance', estado: 'succeeded', repoNombre: 'opencode-orchestrator', mode: 'safe', rama: 'job/demo0010', writes: ['src/panel/**'], creadoEn: seg(50000), inicioEn: seg(49900), finEn: seg(48000), resultado: { advertencias: ['se tocó un archivo protegido y se restauró', 'aceptación con tests saltados'], archivos: ['src/panel/datos.js'] } },
    { id: 'demo0011', titulo: 'Mutaciones verificadas', estado: 'succeeded', repoNombre: 'compras', mode: 'safe', rama: 'job/demo0011', writes: ['src/**'], creadoEn: seg(60000), inicioEn: seg(59900), finEn: seg(58000), resultado: { mutaciones: { detectada: 2, total: 2 }, archivos: ['src/carrito/calculo.js'] } },
    { id: 'demo0012', titulo: 'Revisión con observaciones', estado: 'succeeded', repoNombre: 'opencode-orchestrator', mode: 'readonly', rama: 'job/demo0012', writes: [], creadoEn: seg(70000), inicioEn: seg(69900), finEn: seg(68000), resultado: { revision: { veredicto: 'OBSERVA', detalle: 'faltan casos borde' } } },
  ];

  for (const definicion of definiciones) escribirTrabajo(base, definicion);

  // Logs de ejemplo: el agente y la aceptación con cientos de líneas.
  const conLogs = ['demo0001', 'demo0004', 'demo0006', 'demo0008', 'demo0010'];
  for (const id of conLogs) {
    const dir = path.join(dirJobs, id);
    fs.writeFileSync(path.join(dir, 'stderr.log'), logDeEjemplo('\u001b[32m[agente]\u001b[0m', 420, { ansi: true, larga: true }));
    fs.writeFileSync(path.join(dir, 'stdout.log'), logDeEjemplo('[respuesta]', 60, { larga: true }));
    fs.writeFileSync(path.join(dir, 'aceptacion.log'), logDeEjemplo('PASS test/caso', 320, { larga: true }));
    fs.writeFileSync(path.join(dir, 'aceptacion.err.log'), logDeEjemplo('\u001b[31mFAIL test/roto\u001b[0m', 180, { ansi: true, larga: true }));
  }

  // Registro real: se registran eventos de TODOS los tipos para algunos trabajos.
  // Los que no tienen eventos (demo0007, demo0011, demo0012) la UI los reconstruye.
  const registro = crearRegistroEventos({ dir: base, ahora: () => ahora });
  const conRegistro = ['demo0001', 'demo0002', 'demo0003', 'demo0004', 'demo0005', 'demo0006', 'demo0008', 'demo0009', 'demo0010'];
  registro.registrar({ tipo: 'servidor.arranque', actor: 'servidor' });
  registro.registrar({ tipo: 'servidor.recuperacion', actor: 'servidor', detalle: { trabajos: 3 } });
  registro.registrar({ tipo: 'pizarron.post', actor: 'servidor', detalle: { claves: 5 } });
  registro.registrar({ tipo: 'pizarron.aporte_invalido', actor: 'servidor', motivo: 'enlace_roto' });
  registro.registrar({ tipo: 'job.creado', jobId: 'demo0001', estado: 'queued', actor: 'herramienta:coding' });
  registro.registrar({ tipo: 'job.estado', jobId: 'demo0001', anterior: 'queued', estado: 'running', actor: 'servidor' });
  registro.registrar({ tipo: 'job.espera', jobId: 'demo0003', motivo: 'concurrencia', actor: 'planificador' });
  registro.registrar({ tipo: 'job.reintento', jobId: 'demo0006', actor: 'servidor' });
  registro.registrar({ tipo: 'job.reanudado', jobId: 'demo0004', actor: 'servidor' });
  registro.registrar({ tipo: 'job.mutaciones', jobId: 'demo0011', detalle: { detectada: 2, total: 2 }, actor: 'servidor' });
  registro.registrar({ tipo: 'job.revision', jobId: 'demo0012', detalle: { veredicto: 'OBSERVA' }, actor: 'revisor' });
  registro.registrar({ tipo: 'job.fin', jobId: 'demo0004', estado: 'succeeded', actor: 'servidor' });
  registro.registrar({ tipo: 'job.fin', jobId: 'demo0008', estado: 'rejected', motivo: 'aceptacion', actor: 'servidor' });
  registro.registrar({ tipo: 'job.cancelado', jobId: 'demo0009', motivo: 'cancelado', actor: 'herramienta:cancel' });
  registro.registrar({ tipo: 'merge', jobId: 'demo0005', estado: 'merged', actor: 'herramienta:merge' });
  registro.registrar({ tipo: 'avanzar_base', actor: 'herramienta:merge', detalle: { rama: 'main' } });
  registro.registrar({ tipo: 'cleanup', actor: 'herramienta:cleanup', detalle: { borrados: 2 } });

  // Pizarrón: 5 claves (una en conflicto) y notas.
  const pizarron = {
    version: 5,
    actualizado: ahora,
    claves: {
      'api.ruta': { valor: { path: '/v1/salud', metodo: 'GET' }, nota: 'definido por el trabajo de la API', jobId: 'demo0004', ts: seg(8000), historial: [{ valor: { path: '/v1/salud' }, jobId: 'demo0004', ts: seg(8000) }] },
      'carrito.moneda': { valor: { codigo: 'ARS', decimales: 2 }, nota: 'confirmado', jobId: 'demo0001', ts: seg(500) },
      'build.target': { valor: 'es2022', nota: 'no bajar la versión', jobId: 'demo0006', ts: seg(13000) },
      'db.pool': { valor: { minimo: 2, maximo: 10, timeoutMs: 5000 }, nota: 'ajustado con el equipo', jobId: 'demo0010', ts: seg(47000) },
      'cache.ttl': { valor: { segundos: 60, reintentos: 3, clave: 'carrito-por-usuario' }, nota: 'propuesta inicial', jobId: 'demo0002', ts: seg(250), historial: [{ valor: { segundos: 30 }, jobId: 'demo0001', ts: seg(700), conflicto: true }] },
    },
    notas: [
      { jobId: 'demo0001', ts: seg(600), texto: 'El contrato de la API quedó fijado en api.ruta; no lo cambien.' },
      { jobId: 'demo0004', ts: seg(7500), texto: 'Documenté el panel en docs/API.md.' },
      { jobId: 'demo0002', ts: seg(200), texto: 'La clave cache.ttl está en disputa: esperen a que se resuelva.' },
    ],
  };
  fs.writeFileSync(path.join(base, 'pizarron.json'), JSON.stringify(pizarron, null, 2));

  return { trabajos: definiciones.map((d) => d.id), eventos: conRegistro.length + 3, claves: 5, notas: 3 };
}

/**
 * Crea el estado temporal, levanta el panel en un puerto y devuelve cómo cerrarlo.
 * @param {{ puerto?: number, host?: string }} [opciones]
 * @returns {Promise<{ servidor: import('node:http').Server, base: string, url: string, resumen: object, cerrar: () => Promise<void> }>}
 */
export async function iniciarDemo({ puerto = PUERTO_DEMO, host = '127.0.0.1' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-panel-demo-'));
  const resumen = crearEstadoDemo(base);
  process.env.ORQ_STATE_DIR = base;
  const registro = crearRegistroEventos({ dir: base });
  const servidor = crearServidorPanel({ baseDir: base, registro, concurrencia: 4 });
  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(puerto, host, resolve);
  });
  const url = `http://${host}:${servidor.address().port}`;
  const cerrar = () =>
    new Promise((resolve) => {
      servidor.close(() => {
        try {
          fs.rmSync(base, { recursive: true, force: true });
        } catch {
          // el temporal quedará para inspección; no es crítico
        }
        resolve();
      });
    });
  return { servidor, base, url, resumen, cerrar };
}

/** Arranca desde la línea de comandos; se detiene con Ctrl-C limpiando el temporal. */
async function main() {
  const args = process.argv.slice(2);
  const indice = args.findIndex((a) => a === '--puerto' || a === '--port');
  const puerto = indice !== -1 ? Number(args[indice + 1]) : PUERTO_DEMO;
  if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535) {
    process.stderr.write(`panel-demo: puerto inválido '${args[indice + 1] ?? ''}'\n`);
    process.exit(1);
  }
  if (estadoRealPreexistente()) {
    process.stderr.write(
      `panel-demo: ORQ_STATE_DIR apunta a un estado real ('${process.env.ORQ_STATE_DIR}'); ` +
        'este script solo usa un temporal. Quitá la variable para continuar.\n',
    );
    process.exit(1);
  }
  const demo = await iniciarDemo({ puerto });
  process.stdout.write(`panel de demostración en ${demo.url} (${demo.resumen.trabajos.length} trabajos falsos)\n`);
  process.stdout.write('Ctrl-C para detener y borrar el estado temporal.\n');
  let cerrando = false;
  const apagar = () => {
    if (cerrando) return;
    cerrando = true;
    demo.cerrar().then(() => process.exit(0));
  };
  process.on('SIGINT', apagar);
  process.on('SIGTERM', apagar);
}

// Solo arranca cuando se ejecuta como script (no al importarlo desde los tests).
if (process.argv[1] && process.argv[1].endsWith('panel-demo.js')) {
  main().catch((error) => {
    process.stderr.write(`panel-demo: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
