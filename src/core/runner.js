/**
 * Runner de procesos de un trabajo (§8): lanza un comando como líder de su propio
 * grupo de procesos, vuelca stdout/stderr a archivos en streaming, entrega cada
 * fragmento a un observador y garantiza que cancelar/expirar mata a TODO el grupo
 * (no solo al proceso raíz, que es el bug de la v2: mataba a opencode pero dejaba
 * vivo al vitest que este había lanzado).
 *
 * POR QUÉ grupo propio (`detached: true`): en Linux el proceso queda como líder de
 * grupo; matar con `process.kill(-pgid, señal)` alcanza a hijos y nietos. Sin esto
 * no hay forma portátil de matar el árbol completo.
 *
 * POR QUÉ no acumulamos salida: un trabajo puede escupir cientos de MB. Volcamos a
 * disco respetando contrapresión y solo pasamos fragmentos al observador, de modo
 * que la memoria del orquestador no crece con el volumen de salida.
 *
 * POR QUÉ resolvemos según la EXISTENCIA DEL GRUPO y no según el evento `close`: un
 * nieto que hereda las tuberías puede mantenerlas abiertas tras morir el padre y
 * `close` no llega nunca. Sondeamos `process.kill(-pgid, 0)` con un tope corto para
 * no colgar jamás.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Espera asíncrona en milisegundos. */
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Paso de sondeo del grupo; corto para que cancelar sea ágil. */
const PASO_SONDEO_MS = 25;

/** Tope duro para confirmar la muerte del grupo tras SIGKILL: nunca colgar. */
const TOPE_ESPERA_GRUPO_MS = 2000;

/** Tope para vaciar las tuberías tras la salida natural del proceso. */
const TOPE_VACIADO_PIPES_MS = 1000;

/**
 * Tope por defecto de un log de trabajo (20 MB). Al superarlo se conserva la cabeza
 * (primeros `LOG_HEAD_BYTES_DEFECTO`) y la cola (últimos `LOG_TAIL_BYTES_DEFECTO`),
 * con una línea marcadora en el medio. Así un agente que escupe cientos de MB no
 * llena el disco, pero se sigue viendo cómo empezó y cómo terminó.
 */
const LOG_MAX_BYTES_DEFECTO = 20 * 1024 * 1024;
const LOG_HEAD_BYTES_DEFECTO = 2 * 1024 * 1024;
const LOG_TAIL_BYTES_DEFECTO = 8 * 1024 * 1024;

/**
 * Mensaje legible de un error, sin asumir que trae `.message`.
 * @param {unknown} error
 * @returns {string}
 */
function mensajeDe(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * ¿Sigue existiendo el grupo de procesos `pgid`?
 *
 * `process.kill(-pgid, 0)` no envía señal: solo comprueba existencia. Si el grupo
 * desapareció lanza `ESRCH`; `EPERM` significa que existe pero no tenemos permiso
 * para señalarlo, así que lo contamos como vivo (conservador).
 *
 * @param {number} pgid id de grupo (positivo)
 * @returns {boolean}
 */
export function existeGrupo(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * Mata un grupo de procesos entero: `SIGTERM`, espera `graceMs`, y si sigue vivo
 * `SIGKILL`. Después sondea hasta confirmar que no queda ningún miembro (con tope).
 *
 * Es idempotente y nunca lanza: si el grupo ya no existe, retorna de inmediato.
 *
 * @param {number} pgid id de grupo del proceso (el pid del líder con `detached`)
 * @param {number} [graceMs=5000] margen entre SIGTERM y SIGKILL
 * @returns {Promise<'SIGTERM'|'SIGKILL'|null>} la señal con la que se mató el grupo, o
 *   `null` si no había nada que matar. POR QUÉ se devuelve: el llamador conserva en el
 *   resultado del runner con qué señal murió el proceso aunque no llegue su `exit`.
 */
export async function matarGrupo(pgid, graceMs = 5000) {
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  if (!existeGrupo(pgid)) return null;

  let senal = 'SIGTERM';
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    /* el grupo pudo morir entre la comprobación y la señal */
  }

  const limiteTerm = Date.now() + Math.max(0, graceMs);
  while (existeGrupo(pgid) && Date.now() < limiteTerm) {
    await dormir(PASO_SONDEO_MS);
  }

  if (existeGrupo(pgid)) {
    senal = 'SIGKILL';
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* carrea: la siguiente comprobación decide */
    }
  }

  const limiteKill = Date.now() + TOPE_ESPERA_GRUPO_MS;
  while (existeGrupo(pgid) && Date.now() < limiteKill) {
    await dormir(PASO_SONDEO_MS);
  }
  return senal;
}

/**
 * Ejecuta un comando como un trabajo: grupo propio, logs en streaming, timeouts de
 * total e inactividad, y cancelación que mata el grupo completo.
 *
 * El valor devuelto es una promesa que resuelve a
 * `{ code, signal, motivo, duracionMs, pid, pgid, mensaje }` y que ADEMÁS expone:
 *  - `.promesa`  : la misma promesa,
 *  - `.cancelar()`: cancela el trabajo (idempotente),
 *  - `.pid`      : el pid del líder (o `null` si no llegó a lanzarse).
 * Así sirve tanto `await ejecutar(...)` como
 * `const { promesa, cancelar, pid } = ejecutar(...)`.
 *
 * @param {object} opciones
 * @param {string} opciones.cmd ejecutable
 * @param {string[]} [opciones.args]
 * @param {string} [opciones.cwd]
 * @param {NodeJS.ProcessEnv} [opciones.env] entorno (si falta, hereda el del orquestador)
 * @param {string} [opciones.stdoutPath] archivo (append) para stdout
 * @param {string} [opciones.stderrPath] archivo (append) para stderr
 * @param {number} [opciones.maxLogBytes] tope por archivo de log (por defecto 20 MB);
 *   al superarlo se conserva la cabeza y la cola con una línea marcadora
 * @param {number} [opciones.logHeadBytes] bytes de cabeza conservados al truncar
 * @param {number} [opciones.logTailBytes] bytes de cola conservados al truncar
 * @param {number} [opciones.timeoutMs] tope total; 0/ausente = sin tope
 * @param {number} [opciones.idleTimeoutMs] tope sin bytes en stdout/stderr
 * @param {number} [opciones.graceMs=5000] margen SIGTERM -> SIGKILL
 * @param {(evento: { canal: 'stdout'|'stderr', texto: string }) => void} [opciones.onSalida]
 * @param {(datos: { pid: number, pgid: number }) => void} [opciones.onLanzado] callback
 *   SÍNCRONO que se dispara justo tras un spawn exitoso (con el pid/pgid reales),
 *   antes de cualquier otra cosa. POR QUÉ: el gestor necesita persistir el pgid en
 *   cuanto nace el grupo; si esperara a `onSalida` o a la resolución, un fallo
 *   temprano dejaría una ventana en la que el proceso existiría sin constancia.
 *   No se invoca si el binario no existe (spawn sin pid).
 * @param {AbortSignal} [opciones.signal] señal de cancelación
 * @returns {Promise<{ code: number|null, signal: string|null, motivo: string, duracionMs: number, pid: number|null, pgid: number|null, mensaje: string|null }>}
 */
export function ejecutar(opciones = {}) {
  const {
    cmd,
    args = [],
    cwd,
    env,
    stdoutPath,
    stderrPath,
    maxLogBytes = LOG_MAX_BYTES_DEFECTO,
    logHeadBytes = LOG_HEAD_BYTES_DEFECTO,
    logTailBytes = LOG_TAIL_BYTES_DEFECTO,
    timeoutMs,
    idleTimeoutMs,
    graceMs = 5000,
    onSalida,
    onLanzado,
    signal,
  } = opciones || {};

  const hayObservador = typeof onSalida === 'function';

  let resolver;
  const promesa = new Promise((res) => {
    resolver = res;
  });

  const estado = {
    code: /** @type {number|null} */ (null),
    signal: /** @type {string|null} */ (null),
    pid: /** @type {number|null} */ (null),
    pgid: /** @type {number|null} */ (null),
    mensaje: /** @type {string|null} */ (null),
    inicio: Date.now(),
    terminado: false,
    matando: /** @type {string|null} */ (null),
  };

  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  /** @type {NodeJS.Timeout|null} */
  let timerTotal = null;
  /** @type {NodeJS.Timeout|null} */
  let timerIdle = null;
  /** @type {{ escribir: (f: Buffer) => void, cerrar: () => void }|null} */
  let archivoOut = null;
  /** @type {{ escribir: (f: Buffer) => void, cerrar: () => void }|null} */
  let archivoErr = null;
  const decOut = new StringDecoder('utf8');
  const decErr = new StringDecoder('utf8');

  /** (Re)programa el temporizador de inactividad a partir de este instante. */
  const programarIdle = () => {
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;
    if (timerIdle) clearTimeout(timerIdle);
    timerIdle = setTimeout(() => {
      void matar('idle');
    }, idleTimeoutMs);
  };

  /** Escribe un fragmento en el log (síncrono: da contrapresión real al proceso). */
  const escribir = (archivo, fragmento) => {
    if (archivo) archivo.escribir(fragmento);
  };

  /** Entrega cada fragmento al observador (si lo hay) y reinicia la inactividad. */
  const alDato = (canal, fragmento) => {
    if (estado.terminado) return;
    if (hayObservador) {
      const texto = (canal === 'stdout' ? decOut : decErr).write(fragmento);
      if (texto) {
        try {
          onSalida({ canal, texto });
        } catch {
          /* el observador no debe tumbar la corrida */
        }
      }
    }
    programarIdle();
  };

  /** Cierra un archivo de log; espera a que termine la compactación que esté en curso. */
  const cerrarArchivo = (archivo) => {
    if (!archivo) return Promise.resolve();
    return Promise.resolve(archivo.cerrar());
  };

  /**
   * Único punto de resolución. Idempotente: la primera llamada gana.
   * @param {string} motivo
   * @param {{code?: number|null, signal?: string|null, mensaje?: string|null}} [extra]
   */
  const finalizar = (motivo, extra = {}) => {
    if (estado.terminado) return;
    estado.terminado = true;
    if (timerTotal) {
      clearTimeout(timerTotal);
      timerTotal = null;
    }
    if (timerIdle) {
      clearTimeout(timerIdle);
      timerIdle = null;
    }
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', cancelar);
    }

    // Dejamos de leer y destruimos las tuberías: evita escribir a logs ya cerrados
    // y libera descriptores aunque un nieto siga vivo (no dependemos de su EOF).
    if (child) {
      try {
        child.stdout?.removeAllListeners('data');
      } catch {
        /* ignora */
      }
      try {
        child.stderr?.removeAllListeners('data');
      } catch {
        /* ignora */
      }
      try {
        child.stdout?.destroy();
      } catch {
        /* ignora */
      }
      try {
        child.stderr?.destroy();
      } catch {
        /* ignora */
      }
    }

    Promise.all([cerrarArchivo(archivoOut), cerrarArchivo(archivoErr)]).then(() => {
      // Últimos caracteres multibyte retenidos por los decodificadores.
      if (hayObservador) {
        const restoOut = decOut.end();
        if (restoOut) {
          try {
            onSalida({ canal: 'stdout', texto: restoOut });
          } catch {
            /* ignora */
          }
        }
        const restoErr = decErr.end();
        if (restoErr) {
          try {
            onSalida({ canal: 'stderr', texto: restoErr });
          } catch {
            /* ignora */
          }
        }
      }
      resolver({
        code: extra.code ?? estado.code,
        signal: extra.signal ?? estado.signal,
        motivo,
        duracionMs: Date.now() - estado.inicio,
        pid: estado.pid,
        pgid: estado.pgid,
        mensaje: extra.mensaje ?? estado.mensaje,
      });
    });
  };

  /**
   * Mata el grupo y resuelve con `motivo` (timeout/idle/cancelado).
   * @param {string} motivo
   */
  const matar = async (motivo) => {
    if (estado.terminado || estado.matando) return;
    estado.matando = motivo;
    if (timerTotal) {
      clearTimeout(timerTotal);
      timerTotal = null;
    }
    if (timerIdle) {
      clearTimeout(timerIdle);
      timerIdle = null;
    }
    let senalDelGrupo = null;
    if (estado.pgid) {
      try {
        senalDelGrupo = await matarGrupo(estado.pgid, graceMs);
      } catch {
        /* nunca colgar por un fallo al matar */
      }
    }
    // Conservamos el `code` real (si lo hubo) y, si el proceso murió por nuestra señal
    // (el evento `exit` puede no haber llegado todavía), la señal con la que lo matamos.
    finalizar(motivo, { code: estado.code, signal: estado.signal ?? senalDelGrupo });
  };

  /** Cancela el trabajo. Idempotente: repetirla o llamarla tras terminar es inocuo. */
  const cancelar = () => {
    if (estado.terminado || estado.matando) return;
    void matar('cancelado');
  };

  const adjuntar = () => {
    promesa.promesa = promesa;
    promesa.cancelar = cancelar;
    Object.defineProperty(promesa, 'pid', {
      get: () => estado.pid,
      enumerable: true,
      configurable: true,
    });
    return promesa;
  };

  // Cancelación pedida antes de lanzar: no arrancamos nada.
  if (signal && signal.aborted) {
    finalizar('cancelado', {});
    return adjuntar();
  }

  /**
   * Lee `longitud` bytes del descriptor `descriptor` desde `posicion`, sin traer el
   * resto del archivo. POR QUÉ `fs.read` por rangos: nunca se materializa el log
   * entero en memoria, que es justo lo que desbordaba el event loop.
   *
   * @param {number} descriptor
   * @param {number} posicion
   * @param {number} longitud
   * @returns {Promise<Buffer>}
   */
  const leerRango = (descriptor, posicion, longitud) =>
    new Promise((resolver, rechazar) => {
      if (longitud <= 0) {
        resolver(Buffer.alloc(0));
        return;
      }
      const buffer = Buffer.allocUnsafe(longitud);
      let leido = 0;
      const paso = (error, n) => {
        if (error) {
          rechazar(error);
          return;
        }
        leido += n;
        if (n === 0 || leido >= longitud) {
          resolver(buffer.subarray(0, leido));
          return;
        }
        fs.read(descriptor, buffer, leido, longitud - leido, posicion + leido, paso);
      };
      fs.read(descriptor, buffer, 0, longitud, posicion, paso);
    });

  /**
   * Abre (creando el directorio) un log en modo append con tope: al superar
   * `maxLogBytes` conserva la cabeza (`logHeadBytes`) y la cola (`logTailBytes`)
   * separadas por una línea marcadora.
   *
   * POR QUÉ YA NO se lee el archivo entero: con `maxLogBytes` de hasta 200 MB, leerlo
   * y reescribirlo con I/O síncrona dentro del manejador `data` bloqueaba el event loop
   * y frenaba todos los trabajos y el servidor MCP. Ahora la compactación lee solo
   * cabeza y cola por rangos (asíncrono), se agenda con `setImmediate` —fuera del
   * manejador— y escribe a un temporal del mismo directorio para renombrarlo
   * atómicamente. Mientras compacta, los fragmentos que llegan se ENCOLAN (con tope) y
   * se escriben en orden al terminar. La escritura directa al fd sigue siendo síncrona:
   * da contrapresión real al proceso y evita pelear con el buffer de un WriteStream.
   */
  const abrirLog = (ruta) => {
    if (!ruta) return null;
    /** @type {number|null} */
    let fd;
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fd = fs.openSync(ruta, 'a+');
    } catch {
      return null;
    }
    let bytes = 0;
    try {
      bytes = fs.fstatSync(fd).size;
    } catch {
      /* tamaño desconocido: se recalcula al compactar */
    }
    let cabeza = Number.isFinite(logHeadBytes) && logHeadBytes > 0 ? logHeadBytes : 0;
    let cola = Number.isFinite(logTailBytes) && logTailBytes > 0 ? logTailBytes : 0;
    // Si la configuración pide más cabeza+cola que el propio tope, se escala para que el
    // archivo quede por debajo del tope y no se compacte en cada byte.
    if (cabeza + cola >= maxLogBytes) {
      cabeza = Math.floor(maxLogBytes * 0.1);
      cola = Math.floor(maxLogBytes * 0.4);
    }
    // Tope de la cola en memoria: lo que sobrevive es la cola del log, así que encolar
    // más que eso no aporta y sí arriesga la memoria mientras compacta.
    const topeCola = cola > 0 ? cola : 1024 * 1024;

    let compactando = false;
    /** @type {NodeJS.Immediate|null} */
    let inmediato = null;
    /** @type {Promise<void>|null} */
    let promesaCompacta = null;
    let cerrando = false;
    /** Fragmentos llegados durante la compactación; se escriben en orden al terminar. */
    let colaPendiente = [];
    let colaBytes = 0;
    /** Bytes descartados de la cola por exceder el tope; se suman al marcador. */
    let omitidosCola = 0;

    const encolar = (fragmento) => {
      colaPendiente.push(fragmento);
      colaBytes += fragmento.length;
      // Descartar lo más viejo: lo nuevo es lo que el usuario quiere ver. Se conserva al
      // menos un fragmento para no perder la salida viva por completo.
      while (colaBytes > topeCola && colaPendiente.length > 1) {
        const viejo = colaPendiente.shift();
        colaBytes -= viejo.length;
        omitidosCola += viejo.length;
      }
    };

    /** Escribe en orden, al fd actual, lo que llegó mientras se compactaba. */
    const drenarCola = () => {
      const pendientes = colaPendiente;
      colaPendiente = [];
      colaBytes = 0;
      for (const fragmento of pendientes) {
        if (fd === null) break;
        try {
          fs.writeSync(fd, fragmento);
          bytes += fragmento.length;
        } catch {
          /* un log que falla no debe tumbar la corrida */
        }
      }
    };

    /** Ejecuta la compactación en curso (ya agendada); nunca rechaza. */
    const compactar = async () => {
      if (fd === null) return;
      compactando = true;
      try {
        const actual = fs.fstatSync(fd).size;
        if (actual <= maxLogBytes || actual <= cabeza + cola) {
          bytes = actual;
          drenarCola();
          return;
        }
        const [bufferCabeza, bufferColaBruto] = await Promise.all([
          leerRango(fd, 0, Math.min(cabeza, actual)),
          leerRango(fd, actual - cola, cola),
        ]);
        // No cortar un carácter multibyte: avanzar hasta el inicio del siguiente.
        let desfase = 0;
        while (desfase < bufferColaBruto.length && (bufferColaBruto[desfase] & 0xc0) === 0x80) desfase += 1;
        const bufferCola = bufferColaBruto.subarray(desfase);
        const inicioCola = actual - cola + desfase;
        const omitidosMedio = inicioCola - bufferCabeza.length;
        // La cola pudo descartar datos mientras leíamos: el marcador debe reflejarlos.
        const omitidos = omitidosMedio + omitidosCola;
        omitidosCola = 0;
        const marcador = Buffer.from(`\n[… ${omitidos} bytes omitidos …]\n`, 'utf8');

        // Volcado síncrono del temporal: su tamaño está acotado por cabeza+cola (nunca el
        // archivo entero) y no hay `await` entre calcular el marcador y drenar la cola, con
        // lo que los bytes omitidos quedan exactos.
        const temporal = `${ruta}.${process.pid}.${Date.now()}.tmp`;
        try {
          const fdTemporal = fs.openSync(temporal, 'w');
          try {
            fs.writeSync(fdTemporal, bufferCabeza);
            fs.writeSync(fdTemporal, marcador);
            fs.writeSync(fdTemporal, bufferCola);
          } finally {
            fs.closeSync(fdTemporal);
          }
          fs.renameSync(temporal, ruta);
        } catch (error) {
          try {
            fs.unlinkSync(temporal);
          } catch {
            /* el temporal pudo no llegar a crearse */
          }
          throw error;
        }

        // El fd viejo apunta al inodo reemplazado: hay que reabrir el archivo compactado.
        try {
          fs.closeSync(fd);
        } catch {
          /* ignora */
        }
        fd = null;
        fd = fs.openSync(ruta, 'a+');
        bytes = bufferCabeza.length + marcador.length + bufferCola.length;

        // Drenar en orden lo que llegó mientras compactábamos.
        drenarCola();
      } catch {
        /* la compactación es best-effort: nunca tumba la corrida */
      } finally {
        compactando = false;
        // Si todavía supera el tope, otra vuelta (siempre agendada, nunca en línea).
        if (!cerrando && fd !== null && bytes > maxLogBytes) agendarCompactacion();
      }
    };

    const agendarCompactacion = () => {
      if (fd === null || compactando || inmediato || cerrando) return;
      compactando = true; // se bloquea la escritura directa ya: el archivo debe quedar quieto
      inmediato = setImmediate(() => {
        inmediato = null;
        promesaCompacta = compactar();
      });
    };

    return {
      escribir(fragmento) {
        if (fd === null) return;
        if (compactando) {
          encolar(fragmento);
          return;
        }
        try {
          fs.writeSync(fd, fragmento);
          bytes += fragmento.length;
        } catch {
          return; // un log que falla no debe tumbar la corrida
        }
        if (bytes > maxLogBytes) agendarCompactacion();
      },
      async cerrar() {
        cerrando = true;
        if (inmediato) {
          clearImmediate(inmediato);
          inmediato = null;
          compactando = false;
        }
        if (promesaCompacta) {
          try {
            await promesaCompacta;
          } catch {
            /* best-effort */
          }
          promesaCompacta = null;
        }
        // Si quedó por encima del tope (p. ej. una compactación agendada que cancelamos),
        // una última pasada acotada antes de cerrar para respetar el tope observable.
        let guardas = 0;
        while (fd !== null && bytes > maxLogBytes && guardas < 4) {
          guardas += 1;
          try {
            await compactar();
          } catch {
            break;
          }
        }
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignora */
          }
          fd = null;
        }
      },
    };
  };
  archivoOut = abrirLog(stdoutPath);
  archivoErr = abrirLog(stderrPath);

  try {
    child = spawn(cmd, args, {
      cwd,
      env,
      detached: true, // líder de su propio grupo: kill(-pgid) alcanza hijos y nietos
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    estado.mensaje = mensajeDe(error);
    finalizar('error_al_lanzar', { mensaje: estado.mensaje });
    return adjuntar();
  }

  estado.pid = Number.isInteger(child.pid) ? child.pid : null;
  estado.pgid = estado.pid; // con detached, el pid del líder ES el id del grupo

  // Aviso síncrono del lanzamiento: con el grupo ya identificable y antes de
  // suscribirnos a la salida, para que quien persista el pgid no pierda la
  // carrera contra el primer dato del proceso. Un callback que lanza no debe
  // tumbar la corrida, por eso se aísla.
  if (estado.pid !== null && typeof onLanzado === 'function') {
    try {
      onLanzado({ pid: estado.pid, pgid: estado.pgid });
    } catch {
      /* el observador no debe tumbar la corrida */
    }
  }

  if (child.stdout) {
    child.stdout.on('data', (fragmento) => {
      escribir(archivoOut, fragmento);
      alDato('stdout', fragmento);
    });
    child.stdout.on('error', () => {
      /* el cierre de la tubería no es un error del trabajo */
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (fragmento) => {
      escribir(archivoErr, fragmento);
      alDato('stderr', fragmento);
    });
    child.stderr.on('error', () => {
      /* idem */
    });
  }

  if (signal) {
    if (signal.aborted) cancelar();
    else signal.addEventListener('abort', cancelar, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timerTotal = setTimeout(() => {
      void matar('timeout');
    }, timeoutMs);
  }
  programarIdle();

  child.once('error', (error) => {
    if (estado.terminado || estado.matando) return;
    estado.mensaje = mensajeDe(error);
    finalizar('error_al_lanzar', { mensaje: estado.mensaje });
  });

  child.once('exit', (code, senal) => {
    void alSalir(code, senal);
  });

  /**
   * Salida natural del proceso: matamos cualquier resto del grupo (nietos) y
   * vaciamos las tuberías antes de resolver, para no dejar huérfanos ni perder el
   * final de la salida. No esperamos a `close` (un nieto lo retrasaría sin fin).
   * @param {number|null} code
   * @param {string|null} senal
   */
  async function alSalir(code, senal) {
    if (estado.terminado) return;
    estado.code = Number.isInteger(code) ? code : null;
    estado.signal = senal ?? null;
    if (estado.matando) return; // el flujo de kill resolverá con su propio motivo

    if (estado.pgid && existeGrupo(estado.pgid)) {
      try {
        await matarGrupo(estado.pgid, graceMs);
      } catch {
        /* nunca colgar */
      }
    }
    await esperarTuberias();
    finalizar('exit', { code: estado.code, signal: estado.signal });
  }

  /**
   * Espera a que stdout/stderr lleguen a EOF, con tope. Si un nieto sigue vivo ya
   * lo hemos matado antes, así que el EOF debería llegar; el tope evita cualquier
   * cuelgue residual.
   * @returns {Promise<void>}
   */
  function esperarTuberias() {
    const pendientes = [];
    for (const flujo of [child.stdout, child.stderr]) {
      if (!flujo) continue;
      if (flujo.readableEnded || flujo.destroyed) continue;
      pendientes.push(
        new Promise((res) => {
          flujo.once('end', res);
          flujo.once('close', res);
          flujo.once('error', res);
        }),
      );
    }
    if (pendientes.length === 0) return Promise.resolve();
    return Promise.race([Promise.all(pendientes), dormir(TOPE_VACIADO_PIPES_MS)]);
  }

  return adjuntar();
}
