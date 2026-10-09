/**
 * Flujo de eventos (SSE) del panel en vivo.
 *
 * POR QUÉ SSE y no sondear: el navegador recibe solo lo que cambió. El módulo es
 * inyectable (reloj y temporizadores) para poder testear el envío, el tope de
 * clientes y el cierre sin fugas de timers.
 *
 * Eventos emitidos:
 *  - `trabajos`: cuando cambia el estado/semáforo/segundosSinSalida de algún trabajo
 *    (se revisa cada `intervaloRevisionMs`, por defecto 1 s).
 *  - `estado`: el resumen de `/api/estado` cada `intervaloEstadoMs` (5 s).
 *  - comentario `: keepalive` cada `intervaloKeepaliveMs` (15 s).
 */
export const MAX_CLIENTES = 8;

/** Firma de lo que muestra la lista; si cambia, hay un evento `trabajos`. */
export function firmaDeTrabajo(trabajo) {
  return `${trabajo?.estado}|${trabajo?.semaforo}|${trabajo?.segundosSinSalida}`;
}

/**
 * Trabajos cuya firma difiere de la última vista.
 * @param {Map<string, string>} anteriores firmas por id
 * @param {object[]} actuales resúmenes actuales
 * @returns {object[]}
 */
export function trabajosCambiados(anteriores, actuales) {
  const cambiados = [];
  for (const trabajo of actuales) {
    if (anteriores.get(trabajo.id) !== firmaDeTrabajo(trabajo)) cambiados.push(trabajo);
  }
  return cambiados;
}

/**
 * Crea el gestor de SSE.
 * @param {object} [opciones]
 * @param {() => object[]} [opciones.trabajos] resúmenes actuales
 * @param {() => object} [opciones.estado] resumen para `/api/estado`
 * @param {() => number} [opciones.ahora] reloj inyectable
 * @param {number} [opciones.maxClientes]
 * @param {number} [opciones.intervaloRevisionMs]
 * @param {number} [opciones.intervaloEstadoMs]
 * @param {number} [opciones.intervaloKeepaliveMs]
 * @param {{ setInterval: Function, clearInterval: Function }} [opciones.temporizadores]
 * @returns {object}
 */
export function crearFlujoEventos({
  trabajos = () => [],
  estado = () => ({}),
  ahora = Date.now,
  maxClientes = MAX_CLIENTES,
  intervaloRevisionMs = 1000,
  intervaloEstadoMs = 5000,
  intervaloKeepaliveMs = 15000,
  temporizadores = { setInterval, clearInterval },
} = {}) {
  const programar = temporizadores.setInterval;
  const cancelar = temporizadores.clearInterval;
  /** @type {Set<object>} */
  const clientes = new Set();

  function escribir(res, texto) {
    try {
      res.write(texto);
    } catch {
      // Cliente ido entre revisiones: el cierre del socket limpia sus timers.
    }
  }

  function enviarEvento(res, nombre, datos) {
    escribir(res, `event: ${nombre}\ndata: ${JSON.stringify(datos)}\n\n`);
  }

  /** Calcula y emite `trabajos` solo si algo cambió desde la última firma. */
  function revisar(cliente) {
    const actuales = trabajos();
    const cambiados = trabajosCambiados(cliente.ultimo, actuales);
    if (cambiados.length === 0) return;
    cliente.ultimo = new Map(actuales.map((t) => [t.id, firmaDeTrabajo(t)]));
    enviarEvento(cliente.res, 'trabajos', { ahora: ahora(), cambiados, eliminados: [] });
  }

  /** Emite el resumen de estado. */
  function enviarEstado(cliente) {
    enviarEvento(cliente.res, 'estado', estado());
  }

  /**
   * Atiende una conexión SSE. Devuelve `false` (con 503) si ya hay `maxClientes`.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean}
   */
  function atender(req, res) {
    if (clientes.size >= maxClientes) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify({ error: 'demasiados clientes de stream' }));
      return false;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': conectado\n\n');

    const cliente = { res, ultimo: new Map(), timers: [] };
    // La línea de base son los trabajos que ya existen: un trabajo nuevo o un cambio
    // posterior dispara el evento (no reenviamos lo que el cliente acaba de pedir).
    for (const trabajo of trabajos()) cliente.ultimo.set(trabajo.id, firmaDeTrabajo(trabajo));
    clientes.add(cliente);

    cliente.timers.push(programar(() => revisar(cliente), intervaloRevisionMs));
    cliente.timers.push(programar(() => enviarEstado(cliente), intervaloEstadoMs));
    cliente.timers.push(programar(() => escribir(res, ': keepalive\n\n'), intervaloKeepaliveMs));

    const limpiar = () => {
      if (!clientes.has(cliente)) return;
      for (const timer of cliente.timers) cancelar(timer);
      cliente.timers = [];
      clientes.delete(cliente);
    };
    req.on('close', limpiar);
    res.on('close', limpiar);
    res.on('error', limpiar);
    return true;
  }

  /** Cierra todos los clientes y sus timers (apagado ordenado). */
  function cerrar() {
    for (const cliente of [...clientes]) {
      for (const timer of cliente.timers) cancelar(timer);
      cliente.timers = [];
      clientes.delete(cliente);
      try {
        cliente.res.end();
      } catch {
        // Ya cerrado.
      }
    }
  }

  return { atender, revisar, enviarEstado, cerrar, cantidadClientes: () => clientes.size };
}
