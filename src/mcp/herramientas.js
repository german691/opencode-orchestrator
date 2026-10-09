/**
 * Herramientas MCP (§10): definición (nombre, esquema) y manejadores que delegan en
 * el gestor. Los manejadores devuelven `{ text, isError }`; los errores de uso
 * (`ErrorDeGestor`) los convierte el protocolo en un resultado de error legible.
 *
 * POR QUÉ las descripciones son tan cortas: el cliente recibe TODO `tools/list` en cada
 * sesión y esos tokens salen del contexto del orquestador. El detalle de cada herramienta
 * (ejemplos, `desde_job`, `solo_aceptacion`, recetas, lotes, pizarrón, etc.) vive en
 * `docs/HERRAMIENTAS.md`, referenciado desde `opencode_coding`.
 *
 * POR QUÉ ninguna herramienta bloquea más de `esperaMs` (~45 s): los clientes de
 * escritorio cancelan una petición a los ~60 s. Lo que tarda más es asíncrono: se
 * devuelve un `job_id` y se retoma con `opencode_wait`.
 */

import { ErrorDeGestor } from '../core/gestor.js';
import { esTerminal } from '../core/estados.js';
import {
  EXPLICACION_ACTIVO,
  describirActivo,
  describirEspera,
  describirEstado,
  describirListado,
  describirPerfil,
  describirPizarronClave,
  describirPizarronLista,
  describirTerminado,
} from './formato.js';

const CANALES = ['stdout', 'stderr', 'events', 'aceptacion'];

/** Esquema común de un `job_id`. */
const ESQUEMA_JOB = { type: 'string', description: 'job_id de coding.' };

/**
 * Crea las herramientas ligadas a un gestor.
 *
 * @param {import('../core/gestor.js').Gestor} gestor
 * @param {{ esperaMs?: number, ahora?: () => number }} [opciones]
 * @returns {import('./protocolo.js').Herramienta[]}
 */
export function crearHerramientas(gestor, { esperaMs = 45000, ahora = Date.now } = {}) {
  /** Resultado de esperar a un trabajo: terminado (detalle) o sigue activo. */
  async function respuestaDe(id, ms, completo = false) {
    const trabajo = await gestor.esperar(id, ms);
    if (!trabajo || !esTerminal(trabajo.estado)) {
      return { text: describirActivo(gestor.obtener(id), ahora()), isError: false };
    }
    const colas = {
      // `completo` trae una ventana mucho mayor para que el cliente recupere todo el log;
      // por defecto la cola de stdout se acota a 1500 bytes para ahorrar contexto.
      salida: gestor.logs(id, 'stdout', completo ? 100000 : 1500),
      errores: trabajo.estado === 'failed' || trabajo.estado === 'rejected' ? gestor.logs(id, 'stderr', completo ? 100000 : 1500) : '',
    };
    const malo = trabajo.estado === 'failed' || trabajo.estado === 'rejected' || trabajo.estado === 'lost';
    return { text: describirTerminado(trabajo, colas, { completo }), isError: malo };
  }

  /** `completo` llega como booleano o como texto "true" (clientes con el esquema en caché). */
  const esCompleto = (args) => args?.completo === true || args?.completo === 'true';

  const exigirId = (args) => {
    if (typeof args.job_id !== 'string' || args.job_id === '') throw new ErrorDeGestor('`job_id` es obligatorio');
    return args.job_id;
  };

  return [
    {
      name: 'opencode_coding',
      description: 'Delega una tarea a opencode en paralelo (worktree, writes verificado). Si no termina devuelve job_id. Ver docs/HERRAMIENTAS.md.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Instrucciones completas y autocontenidas.' },
          cwd: { type: 'string', description: 'Ruta del repositorio.' },
          mode: { type: 'string', enum: ['readonly', 'safe', 'auto'], description: 'readonly no escribe; safe limita a writes; auto libre.' },
          writes: { type: 'array', items: { type: 'string' }, description: 'Globs (raíz) que puede modificar; obligatorio en safe.' },
          reads: { type: 'array', items: { type: 'string' }, description: 'Globs que leerá (por defecto todo).' },
          isolation: { type: 'string', enum: ['worktree', 'none'], description: 'worktree aísla; none usa el árbol real.' },
          resources: { type: 'array', items: { type: 'string' }, description: 'Recursos del perfil (p. ej. db).' },
          accept: { type: 'string', description: 'Comando o clave de aceptación.' },
          after: { type: 'array', items: { type: 'string' }, description: 'job_id que deben estar succeeded.' },
          timeout_ms: { type: 'number', description: 'Tope total en ms (30 min).' },
          idle_timeout_ms: { type: 'number', description: 'Tope sin salida en ms (10 min).' },
          files: { type: 'array', items: { type: 'string' }, description: 'Archivos a adjuntar.' },
          title: { type: 'string', description: 'Etiqueta corta.' },
          model: { type: 'string', description: 'Modelo proveedor/modelo.' },
          prioridad: { type: 'number', description: 'Mayor = antes.' },
          base: { type: 'string', enum: ['base', 'integracion'], description: 'Parte de la base o de integración.' },
          solo_aceptacion: { type: 'boolean', description: 'Solo accept, sin agente.' },
          desde_job: { type: 'string', description: 'Retoma un job con su worktree.' },
          completo: { type: 'boolean', description: 'Toda la salida sin recortar.' },
          receta: { type: 'string', description: 'Receta del perfil (con params).' },
          params: { type: 'object', description: 'Valores de los {param}.' },
        },
        required: ['cwd'],
        additionalProperties: false,
      },
      manejar: async (args) => {
        const trabajo = await gestor.enviar(args, { actor: 'herramienta:coding' });
        return respuestaDe(trabajo.id, esperaMs, esCompleto(args));
      },
    },
    {
      name: 'opencode_batch',
      description: 'Encola 1 a 12 tareas (campos de coding), sin esperar; una línea por trabajo.',
      inputSchema: {
        type: 'object',
        properties: {
          tareas: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: { type: 'object', description: 'Un trabajo (campos de coding).' },
            description: 'Tareas a encolar (1 a 12).',
          },
        },
        required: ['tareas'],
        additionalProperties: false,
      },
      manejar: async (args) => {
        const tareas = Array.isArray(args?.tareas) ? args.tareas : [];
        if (tareas.length < 1 || tareas.length > 12) {
          throw new ErrorDeGestor('`tareas` debe ser un array de 1 a 12 tareas');
        }
        const lineas = [];
        let malo = false;
        for (const tarea of tareas) {
          try {
            const creado = await gestor.enviar(tarea, { actor: 'herramienta:batch' });
            const actual = gestor.obtener(creado.id);
            lineas.push(`${actual.id} | ${actual.titulo} | ${actual.estado} | ${describirEspera(actual) || '-'}`);
          } catch (error) {
            malo = true;
            lineas.push(`ERROR: ${error?.message ?? error}`);
          }
        }
        return { text: lineas.join('\n'), isError: malo };
      },
    },
    {
      name: 'opencode_status',
      description: 'Contadores y trabajos activos o sin integrar.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      manejar: async () => ({
        text: describirEstado({ trabajos: gestor.listar({ limite: 200 }), resumen: gestor.resumen(), ahora: ahora() }),
        isError: false,
      }),
    },
    {
      name: 'opencode_wait',
      description: 'Espera hasta ~45 s a un trabajo; repetí hasta que termine.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: ESQUEMA_JOB,
          completo: { type: 'boolean', description: 'Toda la salida sin recortar.' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      manejar: async (args) => respuestaDe(exigirId(args), esperaMs, esCompleto(args)),
    },
    {
      name: 'opencode_wait_any',
      description: 'Espera hasta ~45 s a que termine alguno de varios trabajos.',
      inputSchema: {
        type: 'object',
        properties: {
          job_ids: { type: 'array', items: ESQUEMA_JOB, minItems: 1, description: 'job_id a esperar.' },
          completo: { type: 'boolean', description: 'Toda la salida sin recortar.' },
        },
        required: ['job_ids'],
        additionalProperties: false,
      },
      manejar: async (args) => {
        const ids = Array.isArray(args.job_ids) ? args.job_ids.filter((id) => typeof id === 'string' && id !== '') : [];
        if (ids.length === 0) throw new ErrorDeGestor('`job_ids` debe ser una lista no vacía de job_id');
        const { terminados, activos } = await gestor.esperarAlguno(ids, esperaMs);
        const completo = esCompleto(args);
        const partes = [];
        let malo = false;
        for (const id of terminados) {
          const r = await respuestaDe(id, 0, completo);
          malo = malo || r.isError;
          partes.push(r.text);
        }
        // La explicación de un trabajo activo se imprime UNA sola vez, no por trabajo.
        for (const id of activos) partes.push(describirActivo(gestor.obtener(id), ahora(), { conExplicacion: false }));
        if (activos.length > 0) partes.push(EXPLICACION_ACTIVO);
        const cabecera = `terminados=${terminados.length} | activos=${activos.length}`;
        return { text: `${cabecera}\n\n${partes.join('\n\n---\n\n')}`, isError: malo };
      },
    },
    {
      name: 'opencode_list',
      description: 'Lista trabajos y la carga del servidor.',
      inputSchema: {
        type: 'object',
        properties: {
          estado: { type: 'string', description: 'Filtra por estado.' },
          limite: { type: 'number', description: 'Máximo (por defecto 20).' },
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
      description: 'Final de la salida de un trabajo (stdout, stderr, events o aceptacion).',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: ESQUEMA_JOB,
          canal: { type: 'string', enum: CANALES, description: 'Canal (por defecto stdout).' },
          bytes: { type: 'number', description: 'Bytes del final (por defecto 4000).' },
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
      description: 'Cancela un trabajo: lo descarta en cola o mata su grupo.',
      inputSchema: { type: 'object', properties: { job_id: ESQUEMA_JOB }, required: ['job_id'], additionalProperties: false },
      manejar: async (args) => {
        const trabajo = await gestor.cancelar(exigirId(args), { actor: 'herramienta:cancel' });
        return { text: describirTerminado(trabajo, {}), isError: false };
      },
    },
    {
      name: 'opencode_merge',
      description: 'Integra un succeeded en la rama de integración (merge --no-ff).',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: ESQUEMA_JOB,
          avanzar_base: { type: 'boolean', description: 'Avanza la base por fast-forward.' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      manejar: async (args) => {
        const resultado = await gestor.integrar(exigirId(args), { avanzarBase: args?.avanzar_base === true || args?.avanzar_base === 'true', actor: 'herramienta:merge' });
        if (resultado.ok) {
          let texto = `Integrado en ${resultado.rama} (sha ${resultado.sha}). Revisá: git diff <base>..${resultado.rama}`;
          if (resultado.baseAvanzada) {
            texto += resultado.baseAvanzada.ok
              ? `\nBase '${resultado.base}' avanzada a ${resultado.baseAvanzada.sha}${resultado.baseAvanzada.cambio ? '' : ' (ya estaba al día)'}.`
              : `\nLa base '${resultado.base}' NO se avanzó: ${resultado.baseAvanzada.motivo}.`;
          }
          return { text: texto, isError: false };
        }
        const porBase = resultado.motivo === 'base_no_sincronizable' ? ' (al sincronizar la base dentro de la integración)' : '';
        return { text: `CONFLICTOS al integrar${porBase} (la rama de integración quedó intacta):\n${resultado.conflictos.map((c) => `  - ${c}`).join('\n')}`, isError: true };
      },
    },
    {
      name: 'opencode_cleanup',
      description: 'Elimina worktrees y ramas de trabajos terminados.',
      inputSchema: {
        type: 'object',
        properties: {
          job_ids: { type: 'array', items: { type: 'string' }, description: 'Solo estos jobs.' },
          mas_viejos_que_minutos: { type: 'number', description: 'Terminados hace más de N minutos.' },
        },
        additionalProperties: false,
      },
      manejar: async (args) => {
        const antiguedadMs = Number.isFinite(args.mas_viejos_que_minutos) ? args.mas_viejos_que_minutos * 60000 : 0;
        const limpiados = await gestor.limpiar({ ids: args.job_ids, antiguedadMs, actor: 'herramienta:cleanup' });
        return { text: limpiados.length ? `Limpiados (${limpiados.length}): ${limpiados.join(', ')}` : 'No había nada que limpiar.', isError: false };
      },
    },
    {
      name: 'opencode_profile',
      description: 'Muestra y valida el perfil resuelto del repo.',
      inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Ruta del repositorio.' } }, required: ['cwd'], additionalProperties: false },
      manejar: async (args) => ({ text: describirPerfil(await gestor.verPerfil(args.cwd)), isError: false }),
    },
    {
      name: 'opencode_board_get',
      description: 'Pizarrón compartido: sin clave lista; con clave da valor e historial.',
      inputSchema: {
        type: 'object',
        properties: {
          clave: { type: 'string', description: 'Clave a consultar (opcional).' },
        },
        additionalProperties: false,
      },
      manejar: async (args) => {
        if (!gestor?.pizarron) return { text: 'El pizarrón no está disponible en este servidor.', isError: true };
        const clave = typeof args?.clave === 'string' ? args.clave : '';
        if (clave !== '') {
          const doc = gestor.pizarron.leer();
          return { text: describirPizarronClave(clave, doc.claves?.[clave]), isError: false };
        }
        return { text: describirPizarronLista(gestor.pizarron.leer()), isError: false };
      },
    },
    {
      name: 'opencode_board_post',
      description: 'Publica una clave en el pizarrón; no pisa la de otro salvo forzar.',
      inputSchema: {
        type: 'object',
        properties: {
          clave: { type: 'string', description: 'Clave corta (1-80) sin espacios.' },
          valor: { description: 'JSON o texto.' },
          nota: { type: 'string', description: 'Nota breve (hasta 500).' },
          forzar: { type: 'boolean', description: 'Pisa la clave de otro job.' },
        },
        required: ['clave', 'valor'],
        additionalProperties: false,
      },
      manejar: async (args) => {
        if (!gestor?.pizarron) return { text: 'El pizarrón no está disponible en este servidor.', isError: true };
        const res = gestor.pizarron.post({
          clave: args?.clave,
          valor: args?.valor,
          nota: args?.nota,
          jobId: 'orquestador',
          forzar: args?.forzar === true || args?.forzar === 'true',
        });
        if (!res.aplicado && !res.conflicto) {
          return { text: `No se pudo publicar '${args?.clave}': clave inválida (1-80, sin espacios), valor JSON de hasta 8 KB o nota de hasta 500 caracteres.`, isError: true };
        }
        if (res.conflicto && !res.aplicado) {
          return { text: `CONFLICTO: la clave '${args.clave}' pertenece a otro trabajo y no se pisó. Usá forzar: true si querés reemplazarla.`, isError: true };
        }
        return { text: `Publicado '${args.clave}'${res.motivo === 'forzado' ? ' (forzado)' : ''} en el pizarrón.`, isError: false };
      },
    },
  ];
}
