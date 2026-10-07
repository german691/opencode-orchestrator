/**
 * Protocolo MCP sobre stdio (JSON-RPC 2.0 delimitado por saltos de línea).
 *
 * POR QUÉ implementado a mano y sin dependencias: el subconjunto que necesitamos
 * (initialize, ping, tools/list, tools/call y notificaciones) es pequeño, y una
 * dependencia más en el camino de un servidor que corre dentro de WSL solo agrega
 * superficie de fallo.
 *
 * REGLA CRÍTICA: stdout es EXCLUSIVO del protocolo. Todo diagnóstico va a `log`
 * (stderr); un `console.log` suelto corrompería el flujo y el cliente cortaría.
 *
 * Los streams y el log se inyectan para poder probar el servidor completo sin
 * procesos reales.
 */

const PROTOCOLO_POR_DEFECTO = '2024-11-05';

/** Códigos de error JSON-RPC estándar. */
const ERROR = Object.freeze({
  PARSE: -32700,
  PETICION_INVALIDA: -32600,
  METODO_NO_ENCONTRADO: -32601,
  PARAMETROS_INVALIDOS: -32602,
  INTERNO: -32603,
});

/**
 * @typedef {object} Herramienta
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema
 * @property {(args: object) => Promise<{ text: string, isError?: boolean }>} manejar
 */

/**
 * Crea un servidor MCP.
 *
 * @param {object} opciones
 * @param {string} opciones.nombre nombre del servidor
 * @param {string} opciones.version versión
 * @param {Herramienta[]} opciones.herramientas herramientas expuestas
 * @param {NodeJS.ReadableStream} opciones.entrada stream de entrada (stdin)
 * @param {{ write: (texto: string) => unknown }} opciones.salida stream de salida (stdout)
 * @param {(...partes: unknown[]) => void} [opciones.log] diagnóstico (stderr)
 * @param {number} [opciones.maxLinea=8388608] tope de tamaño de una línea entrante
 * @returns {{ iniciar: () => void, detener: () => void, pendientes: () => number }}
 */
export function crearServidorMcp({ nombre, version, herramientas, entrada, salida, log = () => {}, maxLinea = 8 * 1024 * 1024 }) {
  const porNombre = new Map(herramientas.map((h) => [h.name, h]));
  let buffer = '';
  let activo = false;
  let enCurso = 0;

  /** Envía un mensaje al cliente (una línea JSON). */
  const enviar = (mensaje) => {
    try {
      salida.write(`${JSON.stringify(mensaje)}\n`);
    } catch (error) {
      log('no se pudo escribir en la salida:', error?.message ?? error);
    }
  };
  const responder = (id, result) => enviar({ jsonrpc: '2.0', id, result });
  const responderError = (id, code, message) => enviar({ jsonrpc: '2.0', id, error: { code, message } });

  /** Resultado de una herramienta que falló: se informa al modelo, no al protocolo. */
  const textoDeError = (error) => {
    if (error && error.name === 'ErrorDeGestor') return `Error: ${error.message}`;
    log('error inesperado en una herramienta:', error?.stack ?? error);
    return `Error interno: ${error?.message ?? String(error)}`;
  };

  /**
   * Atiende una petición con `id`.
   * @param {{ id: unknown, method: string, params?: any }} mensaje
   */
  async function atender(mensaje) {
    const { id, method, params } = mensaje;
    switch (method) {
      case 'initialize':
        return responder(id, {
          protocolVersion: (params && typeof params.protocolVersion === 'string' && params.protocolVersion) || PROTOCOLO_POR_DEFECTO,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: nombre, version },
        });
      case 'ping':
        return responder(id, {});
      case 'tools/list':
        return responder(id, {
          tools: herramientas.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const nombreHerramienta = params?.name;
        const herramienta = porNombre.get(nombreHerramienta);
        if (!herramienta) return responderError(id, ERROR.PARAMETROS_INVALIDOS, `Herramienta desconocida: ${nombreHerramienta}`);
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
        try {
          const { text, isError } = await herramienta.manejar(args);
          return responder(id, { content: [{ type: 'text', text }], isError: Boolean(isError) });
        } catch (error) {
          return responder(id, { content: [{ type: 'text', text: textoDeError(error) }], isError: true });
        }
      }
      default:
        return responderError(id, ERROR.METODO_NO_ENCONTRADO, `Método no encontrado: ${method}`);
    }
  }

  /** Procesa una línea completa. */
  function procesarLinea(linea) {
    const texto = linea.replace(/\r$/, '').trim();
    if (texto === '') return;
    let mensaje;
    try {
      mensaje = JSON.parse(texto);
    } catch {
      log('línea no parseable:', texto.slice(0, 200));
      return responderError(null, ERROR.PARSE, 'JSON inválido');
    }
    if (mensaje === null || typeof mensaje !== 'object' || Array.isArray(mensaje) || typeof mensaje.method !== 'string') {
      // Una respuesta del cliente a algo que no pedimos, o basura: se ignora con log.
      if (mensaje && typeof mensaje === 'object' && 'id' in mensaje && !('method' in mensaje)) return;
      return responderError(mensaje?.id ?? null, ERROR.PETICION_INVALIDA, 'Petición inválida');
    }
    const tieneId = mensaje.id !== undefined && mensaje.id !== null;
    if (!tieneId) {
      // Notificación: nunca se responde. La cancelación del cliente NO mata trabajos
      // (los trabajos viven más que la petición y se recogen con opencode_wait).
      if (mensaje.method === 'notifications/cancelled') log(`petición ${mensaje.params?.requestId} cancelada por el cliente (el trabajo sigue)`);
      return;
    }
    enCurso += 1;
    atender(mensaje)
      .catch((error) => {
        log('fallo atendiendo la petición:', error?.stack ?? error);
        responderError(mensaje.id, ERROR.INTERNO, 'Error interno');
      })
      .finally(() => {
        enCurso -= 1;
      });
  }

  const alDato = (fragmento) => {
    buffer += typeof fragmento === 'string' ? fragmento : fragmento.toString('utf8');
    let indice;
    while ((indice = buffer.indexOf('\n')) !== -1) {
      const linea = buffer.slice(0, indice);
      buffer = buffer.slice(indice + 1);
      procesarLinea(linea);
    }
    if (buffer.length > maxLinea) {
      log('línea entrante demasiado grande: se descarta');
      buffer = '';
      responderError(null, ERROR.PETICION_INVALIDA, 'Mensaje demasiado grande');
    }
  };

  return {
    iniciar() {
      if (activo) return;
      activo = true;
      if (typeof entrada.setEncoding === 'function') entrada.setEncoding('utf8');
      entrada.on('data', alDato);
    },
    detener() {
      if (!activo) return;
      activo = false;
      entrada.off('data', alDato);
    },
    pendientes: () => enCurso,
  };
}
