/**
 * Formato de texto de los resultados que ve el orquestador (Claude).
 *
 * POR QUÉ texto estructurado y corto: el resultado entra al contexto del modelo.
 * Se prioriza lo que permite decidir (estado, qué cambió, violaciones, aceptación)
 * y el final de la salida; el resto se consulta con `opencode_logs`.
 */

import { esTerminal } from '../core/estados.js';

/** Máximo de archivos que se listan en línea. */
const MAX_ARCHIVOS = 40;

/** Duración legible: 1h 02m 03s. */
export function duracion(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Recorta un texto a su final, avisando de lo omitido. */
function cola(texto, max) {
  const t = String(texto ?? '').trim();
  if (t.length <= max) return t;
  return `[... ${t.length - max} caracteres omitidos ...]\n${t.slice(-max)}`;
}

/**
 * Mensaje para un trabajo que sigue activo tras la espera de la llamada.
 * @param {object} trabajo
 * @param {number} [ahora]
 * @returns {string}
 */
export function describirActivo(trabajo, ahora = Date.now()) {
  const edad = duracion(ahora - (trabajo.creadoEn ?? ahora));
  return (
    `STILL RUNNING | job_id=${trabajo.id} | estado=${trabajo.estado} | edad=${edad} | tarea="${trabajo.titulo ?? ''}"\n` +
    'No es un error: opencode sigue trabajando en segundo plano. Llamá a opencode_wait con este job_id ' +
    '(repetí hasta que diga finished), opencode_logs para ver el avance u opencode_cancel para detenerlo.'
  );
}

/**
 * Descripción completa de un trabajo terminado.
 *
 * @param {object} trabajo
 * @param {{ salida?: string, errores?: string }} [colas] final de stdout/stderr
 * @returns {string}
 */
export function describirTerminado(trabajo, colas = {}) {
  const r = trabajo.resultado ?? {};
  const encabezado = [
    `job_id=${trabajo.id} (finished)`,
    `estado=${trabajo.estado}`,
    `modo=${trabajo.mode}`,
    `aislamiento=${trabajo.isolation}`,
    `duracion=${duracion((trabajo.finEn ?? Date.now()) - (trabajo.inicioEn ?? trabajo.creadoEn ?? 0))}`,
    trabajo.motivoFin ? `motivo=${trabajo.motivoFin}` : null,
    r.proceso?.exit !== undefined && r.proceso?.exit !== null ? `exit=${r.proceso.exit}` : null,
  ].filter(Boolean);

  const partes = [encabezado.join(' | ')];
  if (trabajo.titulo) partes.push(`tarea: ${trabajo.titulo}`);
  if (trabajo.rama) partes.push(`rama: ${trabajo.rama}${r.commit ? `  commit: ${r.commit}` : '  (sin commit)'}`);
  if (trabajo.worktree) partes.push(`worktree: ${trabajo.worktree}${trabajo.limpiado ? ' (limpiado)' : ''}`);
  if (trabajo.error) partes.push(`error: ${trabajo.error}`);

  if (Array.isArray(r.archivos)) {
    const lista = r.archivos.slice(0, MAX_ARCHIVOS).join(', ');
    const extra = r.archivos.length > MAX_ARCHIVOS ? ` (+${r.archivos.length - MAX_ARCHIVOS} más)` : '';
    partes.push(`archivos modificados (${r.archivos.length}): ${lista || '(ninguno)'}${extra}`);
  }
  if (Array.isArray(r.violaciones) && r.violaciones.length > 0) {
    partes.push(
      `VIOLACIONES DE ALCANCE (${r.violaciones.length}) - el trabajo NO se integra:\n` +
        r.violaciones.slice(0, MAX_ARCHIVOS).map((v) => `  - ${v.ruta}: ${v.motivo}`).join('\n'),
    );
  }
  if (Array.isArray(r.advertencias) && r.advertencias.length > 0) {
    partes.push(`ADVERTENCIAS:\n${r.advertencias.map((a) => `  - ${a}`).join('\n')}`);
  }
  if (r.aceptacion?.ejecutada) {
    const ok = r.aceptacion.exit === 0 && r.aceptacion.motivo === 'exit';
    partes.push(`aceptacion: ${ok ? 'OK' : 'FALLO'} (exit=${r.aceptacion.exit}) $ ${r.aceptacion.cmd}`);
    if (!ok && r.aceptacion.cola) partes.push(`--- salida de la aceptacion ---\n${cola(r.aceptacion.cola, 1500)}`);
  }
  if (colas.salida) partes.push(`--- salida de opencode (final) ---\n${cola(colas.salida, 3000)}`);
  if (colas.errores) partes.push(`--- stderr (final) ---\n${cola(colas.errores, 1000)}`);
  return partes.join('\n');
}

/**
 * Listado de trabajos en texto.
 * @param {object[]} trabajos
 * @param {{ concurrencia: number, corriendo: string[], enCola: string[] }} resumen
 * @param {number} [ahora]
 * @returns {string}
 */
export function describirListado(trabajos, resumen, ahora = Date.now()) {
  const cabecera = `concurrencia=${resumen.concurrencia} | corriendo=${resumen.corriendo.length} | en cola=${resumen.enCola.length}`;
  if (trabajos.length === 0) return `${cabecera}\n(sin trabajos)`;
  const filas = trabajos.map((t) => {
    const activo = !esTerminal(t.estado);
    const edad = duracion((activo ? ahora : t.finEn ?? ahora) - (t.creadoEn ?? ahora));
    const alcance = t.writes?.length ? ` writes=[${t.writes.join(',')}]` : '';
    return `job_id=${t.id} | ${t.estado}${t.motivoFin ? `(${t.motivoFin})` : ''} | ${activo ? 'edad' : 'duracion'}=${edad} | ${t.mode}/${t.isolation}${alcance} | "${t.titulo ?? ''}"`;
  });
  return `${cabecera}\n${filas.join('\n')}`;
}

/**
 * Perfil resuelto en texto legible.
 * @param {{ repo: string, archivo: string, existe: boolean, perfil: object }} info
 * @returns {string}
 */
export function describirPerfil({ repo, archivo, existe, perfil }) {
  return [
    `repo: ${repo}`,
    existe ? `perfil: ${archivo}` : `perfil: (sin archivo; valores por defecto seguros. Creá ${archivo} para personalizarlo)`,
    JSON.stringify(perfil, null, 2),
  ].join('\n');
}
