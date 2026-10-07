/**
 * Herramientas MCP (§10): definición (nombre, esquema) y manejadores que delegan en
 * el gestor. Los manejadores devuelven `{ text, isError }`; los errores de uso
 * (`ErrorDeGestor`) los convierte el protocolo en un resultado de error legible.
 *
 * POR QUÉ ninguna herramienta bloquea más de `esperaMs` (~45 s): los clientes de
 * escritorio cancelan una petición a los ~60 s. Lo que tarda más es asíncrono: se
 * devuelve un `job_id` y se retoma con `opencode_wait`.
 */

import { ErrorDeGestor } from '../core/gestor.js';
import { esTerminal } from '../core/estados.js';
import { describirActivo, describirListado, describirPerfil, describirTerminado } from './formato.js';

const CANALES = ['stdout', 'stderr', 'events', 'aceptacion'];

/** Esquema común de un `job_id`. */
const ESQUEMA_JOB = { type: 'string', description: 'job_id devuelto por opencode_coding.' };

/**
 * Crea las herramientas ligadas a un gestor.
 *
 * @param {import('../core/gestor.js').Gestor} gestor
 * @param {{ esperaMs?: number, ahora?: () => number }} [opciones]
 * @returns {import('./protocolo.js').Herramienta[]}
 */
export function crearHerramientas(gestor, { esperaMs = 45000, ahora = Date.now } = {}) {
  /** Resultado de esperar a un trabajo: terminado (detalle) o sigue activo. */
  async function respuestaDe(id, ms) {
    const trabajo = await gestor.esperar(id, ms);
    if (!trabajo || !esTerminal(trabajo.estado)) {
      return { text: describirActivo(gestor.obtener(id), ahora()), isError: false };
    }
    const colas = {
      salida: gestor.logs(id, 'stdout', 4000),
      errores: trabajo.estado === 'failed' || trabajo.estado === 'rejected' ? gestor.logs(id, 'stderr', 1500) : '',
    };
    const malo = trabajo.estado === 'failed' || trabajo.estado === 'rejected' || trabajo.estado === 'lost';
    return { text: describirTerminado(trabajo, colas), isError: malo };
  }

  const exigirId = (args) => {
    if (typeof args.job_id !== 'string' || args.job_id === '') throw new ErrorDeGestor('`job_id` es obligatorio');
    return args.job_id;
  };

  return [
    {
      name: 'opencode_coding',
      description:
        'Delega una tarea de código a una instancia de opencode (DeepSeek). Admite VARIAS en paralelo (tope de ' +
        'concurrencia del perfil): cada trabajo escribe en su propio git worktree y rama job/<id>, con alcance ' +
        'declarado (`writes`) que el servidor VERIFICA con el git diff al terminar (lo que toque fuera, o en rutas ' +
        'protegidas del perfil, lo rechaza). `mode`: readonly (no escribe), safe (por defecto; exige `writes`), auto ' +
        '(solo si el usuario lo pide). Espera hasta ~45 s: si la tarea es más larga responde `STILL RUNNING` con un ' +
        'job_id; seguí con opencode_wait. Un trabajo succeeded queda en su rama: integralo con opencode_merge y revisá ' +
        'el diff. No hace push ni escribe en la rama base.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Instrucciones completas y autocontenidas (opencode no tiene memoria de esta conversación).' },
          cwd: { type: 'string', description: 'Ruta del repositorio (o de una subcarpeta). Define el perfil y la raíz del worktree.' },
          mode: { type: 'string', enum: ['readonly', 'safe', 'auto'], description: 'readonly = no modifica nada; safe = edita solo dentro de `writes` y sin shell destructivo (por defecto); auto = sin restricciones (opt-in explícito del usuario).' },
          writes: { type: 'array', items: { type: 'string' }, description: 'Patrones glob (relativos a la RAÍZ del repo) que el trabajo puede modificar, p. ej. ["backend/test-integracion/**"]. Obligatorio en safe. Lo que modifique fuera se rechaza.' },
          reads: { type: 'array', items: { type: 'string' }, description: 'Patrones que va a leer (informativo para el planificador). Por defecto todo.' },
          isolation: { type: 'string', enum: ['worktree', 'none'], description: 'worktree (por defecto en safe/auto): copia aislada. none (por defecto en readonly): trabaja en el árbol real.' },
          resources: { type: 'array', items: { type: 'string' }, description: 'Recursos del perfil que necesita (p. ej. ["db"] = una base de datos propia por trabajo).' },
          accept: { type: 'string', description: 'Comando de aceptación (o clave del perfil) que se corre al terminar; si falla, el trabajo queda rechazado.' },
          after: { type: 'array', items: { type: 'string' }, description: 'job_id previos que deben estar succeeded antes de empezar.' },
          timeout_ms: { type: 'number', description: 'Tope total en ms (por defecto 30 min).' },
          idle_timeout_ms: { type: 'number', description: 'Tope sin salida en ms (por defecto 10 min).' },
          files: { type: 'array', items: { type: 'string' }, description: 'Archivos a adjuntar al prompt.' },
          title: { type: 'string', description: 'Etiqueta corta para los listados.' },
          model: { type: 'string', description: 'Modelo proveedor/modelo (por defecto el del servidor).' },
          prioridad: { type: 'number', description: 'Mayor = antes en la cola.' },
        },
        required: ['prompt', 'cwd'],
        additionalProperties: false,
      },
      manejar: async (args) => {
        const trabajo = await gestor.enviar(args);
        return respuestaDe(trabajo.id, esperaMs);
      },
    },
    {
      name: 'opencode_wait',
      description: 'Espera hasta ~45 s a un trabajo iniciado con opencode_coding. Devuelve el resultado si terminó o `STILL RUNNING` otra vez: repetí hasta que termine.',
      inputSchema: { type: 'object', properties: { job_id: ESQUEMA_JOB }, required: ['job_id'], additionalProperties: false },
      manejar: async (args) => respuestaDe(exigirId(args), esperaMs),
    },
    {
      name: 'opencode_list',
      description: 'Lista los trabajos (estado, edad, modo, alcance) y la carga del servidor (corriendo y en cola). Usala antes de reenviar una tarea que parece no haber producido nada.',
      inputSchema: {
        type: 'object',
        properties: {
          estado: { type: 'string', description: 'Filtra por estado (queued, provisioning, running, verifying, succeeded, failed, cancelled, rejected, lost, merged).' },
          limite: { type: 'number', description: 'Máximo de trabajos (por defecto 20).' },
        },
        additionalProperties: false,
      },
      manejar: async (args) => {
        const limite = Number.isInteger(args.limite) && args.limite > 0 ? args.limite : 20;
        return { text: describirListado(gestor.listar({ estado: args.estado, limite }), gestor.resumen(), ahora()), isError: false };
      },
    },
    {
      name: 'opencode_logs',
      description: 'Final de la salida de un trabajo (stdout, stderr, events o aceptacion) sin esperar a que termine. Sirve para ver el avance de un trabajo largo.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: ESQUEMA_JOB,
          canal: { type: 'string', enum: CANALES, description: 'Canal a leer (por defecto stdout).' },
          bytes: { type: 'number', description: 'Cuántos bytes del final (por defecto 4000, máximo 100000).' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      manejar: async (args) => {
        const id = exigirId(args);
        const canal = args.canal ?? 'stdout';
        if (!CANALES.includes(canal)) throw new ErrorDeGestor(`canal inválido: ${canal} (permitidos: ${CANALES.join(', ')})`);
        const bytes = Math.min(Number.isInteger(args.bytes) && args.bytes > 0 ? args.bytes : 4000, 100000);
        const texto = canal === 'aceptacion' ? gestor.logsAceptacion(id, bytes) : gestor.logs(id, canal, bytes);
        return { text: texto === '' ? '(vacío)' : texto, isError: false };
      },
    },
    {
      name: 'opencode_cancel',
      description: 'Cancela un trabajo: si está en cola lo descarta; si corre, mata su grupo de procesos completo (incluidos los comandos que lanzó).',
      inputSchema: { type: 'object', properties: { job_id: ESQUEMA_JOB }, required: ['job_id'], additionalProperties: false },
      manejar: async (args) => {
        const trabajo = await gestor.cancelar(exigirId(args));
        return { text: describirTerminado(trabajo, {}), isError: false };
      },
    },
    {
      name: 'opencode_merge',
      description: 'Integra un trabajo succeeded en la rama de integración del perfil (git merge --no-ff dentro de un worktree propio). Ante conflicto aborta y lista los archivos; la rama de integración queda intacta. NUNCA toca la rama base ni hace push: revisá el diff base..integración y avanzá la base vos.',
      inputSchema: { type: 'object', properties: { job_id: ESQUEMA_JOB }, required: ['job_id'], additionalProperties: false },
      manejar: async (args) => {
        const resultado = await gestor.integrar(exigirId(args));
        if (resultado.ok) return { text: `Integrado en ${resultado.rama} (sha ${resultado.sha}). Revisá: git diff <base>..${resultado.rama}`, isError: false };
        return { text: `CONFLICTOS al integrar (la rama de integración quedó intacta):\n${resultado.conflictos.map((c) => `  - ${c}`).join('\n')}`, isError: true };
      },
    },
    {
      name: 'opencode_cleanup',
      description: 'Elimina los worktrees y ramas de trabajos terminados (no toca los activos ni borra su registro).',
      inputSchema: {
        type: 'object',
        properties: {
          job_ids: { type: 'array', items: { type: 'string' }, description: 'Solo estos trabajos (por defecto todos los terminados).' },
          mas_viejos_que_minutos: { type: 'number', description: 'Solo los terminados hace más de N minutos.' },
        },
        additionalProperties: false,
      },
      manejar: async (args) => {
        const antiguedadMs = Number.isFinite(args.mas_viejos_que_minutos) ? args.mas_viejos_que_minutos * 60000 : 0;
        const limpiados = await gestor.limpiar({ ids: args.job_ids, antiguedadMs });
        return { text: limpiados.length ? `Limpiados (${limpiados.length}): ${limpiados.join(', ')}` : 'No había nada que limpiar.', isError: false };
      },
    },
    {
      name: 'opencode_profile',
      description: 'Muestra (y valida) el perfil resuelto de un repositorio: rama base, rutas protegidas, recursos, comandos de aceptación y concurrencia.',
      inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Ruta del repositorio.' } }, required: ['cwd'], additionalProperties: false },
      manejar: async (args) => ({ text: describirPerfil(await gestor.verPerfil(args.cwd)), isError: false }),
    },
  ];
}
