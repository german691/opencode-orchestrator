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

/** Tope para cerrar y vaciar los archivos de log. */
const TOPE_CIERRE_LOGS_MS = 1000;

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
 * @returns {Promise<void>}
 */
export async function matarGrupo(pgid, graceMs = 5000) {
  if (!Number.isInteger(pgid) || pgid <= 0) return;
  if (!existeGrupo(pgid)) return;

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
 * @param {number} [opciones.timeoutMs] tope total; 0/ausente = sin tope
 * @param {number} [opciones.idleTimeoutMs] tope sin bytes en stdout/stderr
 * @param {number} [opciones.graceMs=5000] margen SIGTERM -> SIGKILL
 * @param {(evento: { canal: 'stdout'|'stderr', texto: string }) => void} [opciones.onSalida]
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
    timeoutMs,
    idleTimeoutMs,
    graceMs = 5000,
    onSalida,
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
  /** @type {import('node:fs').WriteStream|null} */
  let archivoOut = null;
  /** @type {import('node:fs').WriteStream|null} */
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

  /** Escribe un fragmento respetando contrapresión (pausa la fuente si hace falta). */
  const escribir = (archivo, fragmento, origen) => {
    if (!archivo) return;
    let drenado;
    try {
      drenado = archivo.write(fragmento);
    } catch {
      return; // un log que falla no debe tumbar la corrida
    }
    if (!drenado) {
      origen.pause();
      archivo.once('drain', () => {
        try {
          origen.resume();
        } catch {
          /* el flujo pudo cerrarse mientras estaba en pausa */
        }
      });
    }
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

  /** Cierra un archivo de log y espera a que se vacíe, con tope para no colgar. */
  const cerrarArchivo = (archivo) =>
    new Promise((res) => {
      if (!archivo) return res();
      let listo = false;
      const fin = () => {
        if (!listo) {
          listo = true;
          res();
        }
      };
      archivo.once('finish', fin);
      archivo.once('close', fin);
      archivo.once('error', fin);
      try {
        archivo.end();
      } catch {
        fin();
      }
      setTimeout(fin, TOPE_CIERRE_LOGS_MS);
    });

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
    if (estado.pgid) {
      try {
        await matarGrupo(estado.pgid, graceMs);
      } catch {
        /* nunca colgar por un fallo al matar */
      }
    }
    finalizar(motivo, {});
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

  /** Abre (creando el directorio) un log en modo append. */
  const abrirLog = (ruta) => {
    if (!ruta) return null;
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      const archivo = fs.createWriteStream(ruta, { flags: 'a' });
      archivo.on('error', () => {
        /* un log roto no debe tumbar la corrida */
      });
      return archivo;
    } catch {
      return null;
    }
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

  if (child.stdout) {
    child.stdout.on('data', (fragmento) => {
      escribir(archivoOut, fragmento, child.stdout);
      alDato('stdout', fragmento);
    });
    child.stdout.on('error', () => {
      /* el cierre de la tubería no es un error del trabajo */
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (fragmento) => {
      escribir(archivoErr, fragmento, child.stderr);
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
