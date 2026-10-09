#!/usr/bin/env node
/**
 * opencode-orchestrator: servidor MCP (stdio) que orquesta varias instancias de
 * opencode en paralelo. Diseño y decisiones: docs/DISENO.md.
 *
 * Variables de entorno:
 *   ORQ_STATE_DIR        directorio de estado (por defecto ~/.local/state/opencode-orchestrator)
 *   ORQ_CONCURRENCY      tope de trabajos simultáneos (1 a 16; por defecto 8)
 *   ORQ_OPENCODE_BIN     ejecutable de opencode (por defecto /usr/local/bin/opencode o `opencode`)
 *   OPENCODE_MODEL       modelo por defecto (proveedor/modelo)
 *   ORQ_WAIT_MS          cuánto bloquea cada llamada antes de devolver STILL RUNNING (por defecto 45000)
 *
 * REGLA: stdout es EXCLUSIVO del protocolo MCP; todo diagnóstico va a stderr.
 */

import fs from 'node:fs';

import { Gestor } from './core/gestor.js';
import { cargarEntornoDeArchivo } from './entorno.js';
import { AlmacenDeTrabajos } from './core/store.js';
import { crearRegistroEventos } from './core/eventos.js';
import { crearPizarron } from './core/pizarron.js';
import { adquirirBloqueoConEspera } from './core/bloqueo.js';
import { crearHerramientas } from './mcp/herramientas.js';
import { crearServidorMcp } from './mcp/protocolo.js';

const NOMBRE = 'opencode-orchestrator';
const VERSION = '3.0.0-dev';

// El log NUNCA puede romper ni realimentar al servidor: si el cliente se fue, el pipe de
// stderr está roto y cada escritura dispara un EPIPE asíncrono; sin este manejador ese
// error llegaba a `uncaughtException`, cuyo manejador volvía a loguear y generaba otro
// EPIPE, en un bucle infinito que dejaba un proceso huérfano al 100 % de CPU (observado
// en vivo: 11 h de CPU). Se ignoran los errores de escritura de stderr.
process.stderr.on('error', () => {});

const log = (...partes) => {
  try {
    process.stderr.write(`[${NOMBRE}] ${partes.join(' ')}\n`);
  } catch {
    /* sin stderr no hay a dónde loguear: se ignora */
  }
};

/** Ejecutable de opencode: variable de entorno, ruta nativa de Linux, o el del PATH. */
function ejecutableDeOpencode() {
  if (process.env.ORQ_OPENCODE_BIN) return process.env.ORQ_OPENCODE_BIN;
  if (fs.existsSync('/usr/local/bin/opencode')) return '/usr/local/bin/opencode';
  return 'opencode';
}

/** Entero positivo de una variable de entorno, o el valor por defecto. */
function enteroDeEntorno(nombre, porDefecto) {
  const valor = Number(process.env[nombre]);
  return Number.isInteger(valor) && valor > 0 ? valor : porDefecto;
}

/**
 * Herramientas de reemplazo cuando no se pudo arrancar el gestor: informan el motivo.
 *
 * POR QUÉ `reintentar`: si el bloqueo lo tenía otro servidor que luego murió (p.ej. una
 * sesión remota que se cerró), este servidor se recuperaba solo al reiniciar el cliente;
 * ahora cada llamada vuelve a intentar tomar el bloqueo (sin esperar) y, si lo consigue,
 * pasa a funcionar sin reconectar.
 *
 * @param {string} motivo
 * @param {Array<{ name: string, manejar: Function }>} herramientas
 * @param {(() => Promise<Array<{ name: string, manejar: Function }> | null>) | null} [reintentar]
 */
function herramientasBloqueadas(motivo, herramientas, reintentar = null) {
  return herramientas.map((h) => ({
    ...h,
    manejar: async (args) => {
      if (reintentar) {
        const reales = await reintentar();
        const real = reales ? reales.find((r) => r.name === h.name) : null;
        if (real) return real.manejar(args);
      }
      return { text: `El servidor no está operativo: ${motivo}`, isError: true };
    },
  }));
}

async function main() {
  // Variables opcionales de ~/.config/opencode-orchestrator/env (no pisan las del entorno).
  const entornoArchivo = cargarEntornoDeArchivo({ log });
  if (entornoArchivo.cargadas.length > 0) log(`variables cargadas del archivo de entorno: ${entornoArchivo.cargadas.join(', ')}`);

  const almacen = new AlmacenDeTrabajos();
  // Registro global de eventos (auditoría) en el MISMO directorio de estado del almacén:
  // lo comparten el gestor y el panel (que lo abre por su cuenta) para /auditoria.
  const registro = crearRegistroEventos({ dir: almacen.dir });
  // Pizarrón compartido: vive en el MISMO directorio de estado (el panel lo puede abrir por
  // su cuenta más adelante). El servidor es el único que escribe el archivo vivo; cada
  // worktree recibe un symlink de solo lectura al habilitarse en el perfil del repo.
  const pizarron = crearPizarron({ dir: almacen.dir });
  const concurrencia = Math.min(16, enteroDeEntorno('ORQ_CONCURRENCY', 8));
  const esperaMs = enteroDeEntorno('ORQ_WAIT_MS', 45000);

  let gestor = null;
  let herramientas;
  let bloqueoAdquirido = false;

  /**
   * Toma el bloqueo de instancia y arranca el gestor. Se usa al iniciar (con una espera corta:
   * tras reiniciar el cliente, el servidor anterior puede estar aún apagándose) y, si falló,
   * en cada llamada posterior sin esperar. Un solo servidor por directorio de estado: dos
   * servidores se pisarían los trabajos.
   */
  async function arrancarGestor(esperaBloqueoMs) {
    await adquirirBloqueoConEspera(almacen, { esperaMs: esperaBloqueoMs });
    bloqueoAdquirido = true;
    try {
      // Lo que quedó vivo de una ejecución anterior se reconcilia (y se mata si es nuestro).
      const perdidos = await almacen.marcarPerdidos();
      if (perdidos.length > 0) log(`trabajos de una ejecución anterior marcados como perdidos: ${perdidos.join(', ')}`);
      almacen.limpiarTemporales();

      const nuevo = new Gestor({
        almacen,
        opencode: { cmd: ejecutableDeOpencode() },
        concurrencia,
        modelo: process.env.OPENCODE_MODEL || undefined,
        registro,
        pizarron,
      });
      nuevo.registrarArranque({ recuperados: perdidos });
      // Retención de logs pesados: purga al arrancar y luego cada 6 h (unref + cancelada
      // en gestor.cerrar()). Sin esto el estado crecería sin límite en un servidor de larga vida.
      nuevo.iniciarRetencion();
      gestor = nuevo;
      return crearHerramientas(nuevo, { esperaMs });
    } catch (error) {
      // Si algo falla después de tomar el bloqueo, se suelta: si no, el reintento chocaría con el propio.
      bloqueoAdquirido = false;
      try {
        almacen.liberarBloqueoDeInstancia();
      } catch {
        /* ignora */
      }
      throw error;
    }
  }

  try {
    herramientas = await arrancarGestor(enteroDeEntorno('ORQ_LOCK_WAIT_MS', 10000));
  } catch (error) {
    // No se aborta: el cliente ve las herramientas y recibe el motivo en cada llamada; cada
    // llamada reintenta tomar el bloqueo por si el otro servidor ya se fue.
    log('no se pudo iniciar el gestor:', error?.message ?? error);
    const vacio = crearHerramientas({}, { esperaMs });
    let recuperadas = null;
    let reintentando = null;
    const reintentar = async () => {
      if (recuperadas) return recuperadas;
      if (!reintentando) {
        reintentando = arrancarGestor(0)
          .then((reales) => {
            log('bloqueo de instancia recuperado: el servidor pasó a operativo');
            recuperadas = reales;
            return reales;
          })
          .catch(() => null)
          .finally(() => {
            reintentando = null;
          });
      }
      return reintentando;
    };
    herramientas = herramientasBloqueadas(error?.message ?? String(error), vacio, reintentar);
  }

  const servidor = crearServidorMcp({
    nombre: NOMBRE,
    version: VERSION,
    herramientas,
    entrada: process.stdin,
    salida: process.stdout,
    log,
  });

  let cerrando = false;
  /** Cierre ordenado: cancela lo que corre (matando los grupos) y libera el bloqueo. */
  const cerrar = async (motivo, codigo = 0) => {
    if (cerrando) return;
    cerrando = true;
    // Red de seguridad: si algo del cierre ordenado se cuelga, el proceso igual termina.
    setTimeout(() => process.exit(codigo), 30_000).unref();
    log(`cerrando (${motivo})`);
    servidor.detener();
    try {
      if (gestor) await gestor.cerrar();
    } catch (error) {
      log('error al cerrar el gestor:', error?.message ?? error);
    }
    if (bloqueoAdquirido) {
      try {
        almacen.liberarBloqueoDeInstancia();
      } catch {
        /* ignora */
      }
    }
    process.exit(codigo);
  };

  // Si el cliente se va, nadie puede leer resultados: se cierra y no se dejan huérfanos.
  process.stdin.on('end', () => void cerrar('stdin cerrado'));
  process.stdin.on('close', () => void cerrar('stdin cerrado'));
  process.on('SIGTERM', () => void cerrar('SIGTERM'));
  process.on('SIGINT', () => void cerrar('SIGINT'));
  process.on('SIGHUP', () => void cerrar('SIGHUP'));
  // Si el cliente cerró stdout/stdin, no hay nadie para leer respuestas: se cierra.
  process.stdout.on('error', () => void cerrar('stdout cerrado'));
  process.on('uncaughtException', (error) => {
    // Un pipe roto (EPIPE) significa que el cliente se fue: se cierra sin loguear más.
    if (error?.code === 'EPIPE') {
      void cerrar('pipe roto');
      return;
    }
    log('excepción no capturada:', error?.stack ?? error);
    void cerrar('excepción no capturada', 1);
  });
  process.on('unhandledRejection', (razon) => {
    log('promesa rechazada sin manejar:', razon?.stack ?? razon);
  });
  // Última red de seguridad: síncrona, para el caso de caída sin cierre ordenado.
  process.on('exit', () => {
    try {
      gestor?.matarTodoSincrono();
    } catch {
      /* ignora */
    }
  });

  servidor.iniciar();
  log(`iniciado (v${VERSION}, concurrencia=${concurrencia}, opencode=${ejecutableDeOpencode()})`);
}

main().catch((error) => {
  log('fallo fatal al arrancar:', error?.stack ?? error);
  process.exit(1);
});
