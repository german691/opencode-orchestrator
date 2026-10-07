/**
 * Persistencia en disco de los trabajos (§8): sobrevivir a un reinicio del
 * servidor sin perder el rastro de lo que estaba corriendo.
 *
 * POR QUÉ en disco y no en memoria: el servidor MCP puede reiniciarse (o el
 * cliente cancelar la sesión) en medio de un trabajo. Al arrancar, los trabajos
 * que quedaron en estados no terminales deben poder reconciliarse: matar el grupo
 * de procesos si sigue vivo y marcarlos `lost` (no hay cola persistente). Sin
 * esto quedarían procesos huérfanos y trabajos eternamente "running".
 *
 * Por trabajo: `jobs/<id>/job.json`, `stdout.log`, `stderr.log`, `events.jsonl`.
 * Global: `audit.log`. Todas las escrituras de `job.json` son ATÓMICAS (temporal
 * en el mismo directorio + rename), de modo que un parche concurrente o un corte
 * a mitad nunca dejan un JSON a medias: la lectura ve siempre la versión anterior
 * o la nueva, jamás una mezcla.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ESTADOS, esTerminal, transicionar } from './estados.js';
import { existeGrupo, matarGrupo } from './runner.js';
import { coincideIdentidad, identidadDeProceso, bootIdActual } from './identidad.js';

/** Id de trabajo en disco: minúsculas/dígitos, guiones, sin punto ni barra. */
const ID_ALMACEN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Tope por defecto del `audit.log` antes de rotar (5 MB). */
const TOPE_AUDITORIA_BYTES = 5 * 1024 * 1024;

/** Edad por defecto de un temporal huérfano antes de poder borrarlo (1 h). */
const EDAD_TEMPORAL_MS = 60 * 60 * 1000;

/** Canales de log soportados por `leerCola`. */
const ARCHIVO_CANAL = Object.freeze({
  stdout: 'stdout.log',
  stderr: 'stderr.log',
  events: 'events.jsonl',
});

/** Longitud máxima del prompt que se conserva en la auditoría (§11). */
const LIMITE_PROMPT_AUDITORIA = 120;

/**
 * ¿Es un objeto JSON plano (no null, no array)?
 * @param {unknown} valor
 * @returns {boolean}
 */
function esObjetoPlano(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * ¿Existe el proceso `pid`? `EPERM` cuenta como vivo (existe pero no es nuestro).
 * @param {unknown} pid
 * @returns {boolean}
 */
function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * Valida un id de trabajo, fuente primaria de path traversal: rechaza `..`, `/`
 * y cualquier cosa que no sea id de almacén.
 *
 * @param {unknown} id
 * @returns {string}
 * @throws {TypeError|Error}
 */
function validarId(id) {
  if (typeof id !== 'string' || !ID_ALMACEN.test(id)) {
    throw new Error(`id de trabajo inválido: ${JSON.stringify(id)} (se espera /^[a-z0-9][a-z0-9-]{0,63}$/)`);
  }
  return id;
}

/**
 * Sustituye recursivamente cualquier campo `prompt` por sus primeros 120
 * caracteres. POR QUÉ: la auditoría no debe volcar instrucciones completas
 * (pueden contener secretos o datos del usuario); solo se guarda una pista.
 *
 * @param {unknown} valor
 * @param {number} [profundidad=0]
 * @returns {unknown}
 */
function sanearPrompt(valor, profundidad = 0) {
  if (profundidad > 12) return '[demasiado profundo]';
  if (Array.isArray(valor)) return valor.map((v) => sanearPrompt(v, profundidad + 1));
  if (esObjetoPlano(valor)) {
    /** @type {Record<string, unknown>} */
    const salida = {};
    for (const [clave, v] of Object.entries(valor)) {
      if (clave === 'prompt' && typeof v === 'string') {
        salida.prompt = v.slice(0, LIMITE_PROMPT_AUDITORIA);
        if (v.length > LIMITE_PROMPT_AUDITORIA) salida.promptTruncado = true;
      } else {
        salida[clave] = sanearPrompt(v, profundidad + 1);
      }
    }
    return salida;
  }
  return valor;
}

/**
 * Almacén de trabajos en disco.
 *
 * @example
 * const almacen = new AlmacenDeTrabajos();
 * const trabajo = almacen.crear({ prompt: '...', estado: 'queued' });
 * almacen.actualizar(trabajo.id, { estado: 'running' });
 */
export class AlmacenDeTrabajos {
  /**
   * @param {{ dir?: string, topeAuditoriaBytes?: number }} [opciones] directorio de
   *   estado; por defecto `$ORQ_STATE_DIR` o `~/.local/state/opencode-orchestrator`.
   *   `topeAuditoriaBytes` es el tamaño a partir del cual `auditar` rota el log.
   */
  constructor({ dir, topeAuditoriaBytes = TOPE_AUDITORIA_BYTES } = {}) {
    const base =
      dir ??
      process.env.ORQ_STATE_DIR ??
      path.join(os.homedir(), '.local', 'state', 'opencode-orchestrator');
    this.dir = path.resolve(base);
    /** @type {number} contador para nombres de temporales únicos */
    this.contador = 0;
    /** @type {number} tope de bytes del audit.log antes de rotar */
    this.topeAuditoriaBytes = Number.isFinite(topeAuditoriaBytes) && topeAuditoriaBytes > 0
      ? topeAuditoriaBytes
      : TOPE_AUDITORIA_BYTES;
    /** @type {{ pid: number, identidad: object|null }|null} nuestro lock de instancia */
    this._lockPropio = null;
  }

  /**
   * Ruta de un canal de log de un trabajo (no comprueba existencia).
   * @param {string} id
   * @returns {{ dir: string, job: string, stdout: string, stderr: string, events: string }}
   */
  rutasDeLogs(id) {
    validarId(id);
    const dir = path.join(this.dir, 'jobs', id);
    return {
      dir,
      job: path.join(dir, 'job.json'),
      stdout: path.join(dir, 'stdout.log'),
      stderr: path.join(dir, 'stderr.log'),
      events: path.join(dir, 'events.jsonl'),
    };
  }

  /**
   * Genera un id corto aleatorio de 8 caracteres hex que no colisione.
   * @returns {string}
   */
  generarId() {
    for (;;) {
      const id = crypto.randomBytes(4).toString('hex');
      if (!fs.existsSync(this.rutasDeLogs(id).job)) return id;
    }
  }

  /**
   * Escribe un JSON de forma atómica: temporal en el MISMO directorio y rename.
   * El rename dentro del mismo sistema de archivos es atómico, así que un lector
   * ve el contenido viejo o el nuevo, nunca uno truncado.
   *
   * @param {string} destino
   * @param {unknown} objeto
   * @returns {void}
   */
  escribirAtomico(destino, objeto) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    this.contador += 1;
    const temporal = `${destino}.tmp-${process.pid}-${this.contador}`;
    fs.writeFileSync(temporal, JSON.stringify(objeto, null, 2), 'utf8');
    fs.renameSync(temporal, destino);
  }

  /**
   * Borra los temporales `*.tmp-*` huérfanos (de un `escribirAtomico` que murió
   * antes del rename) que superen `edadMs`. POR QUÉ la edad: un temporal recién
   * creado puede pertenecer a una escritura en curso de otro proceso; borrarlo
   * podría romper un rename ajeno. Solo se tocan los que ya nadie va a renombrar.
   *
   * @param {{ edadMs?: number }} [opciones] edad mínima (por defecto 1 hora)
   * @returns {string[]} rutas borradas
   */
  limpiarTemporales({ edadMs = EDAD_TEMPORAL_MS } = {}) {
    const limite = Date.now() - (Number.isFinite(edadMs) && edadMs >= 0 ? edadMs : EDAD_TEMPORAL_MS);
    /** @type {string[]} */
    const borrados = [];
    /** @type {string[]} */
    const pendientes = [path.join(this.dir, 'jobs'), this.dir];

    while (pendientes.length > 0) {
      const actual = pendientes.pop();
      let entradas;
      try {
        entradas = fs.readdirSync(actual, { withFileTypes: true });
      } catch {
        continue; // no existe todavía: nada que limpiar
      }
      for (const entrada of entradas) {
        const ruta = path.join(actual, entrada.name);
        if (entrada.isDirectory()) {
          pendientes.push(ruta);
          continue;
        }
        if (!entrada.name.includes('.tmp-')) continue;
        try {
          const info = fs.statSync(ruta);
          if (info.mtimeMs > limite) continue; // demasiado joven: puede estar en uso
          fs.rmSync(ruta, { force: true });
          borrados.push(ruta);
        } catch {
          /* best-effort: un temporal que no se puede borrar no debe romper nada */
        }
      }
    }
    return borrados;
  }

  /**
   * Crea un trabajo. Si falta el id, se genera uno de 8 hex. Valida el estado
   * inicial contra la máquina de estados.
   *
   * @param {object} [trabajo]
   * @returns {object} el trabajo persistido (con id y `creadoEn`)
   * @throws {TypeError|Error}
   */
  crear(trabajo = {}) {
    if (!esObjetoPlano(trabajo)) throw new TypeError('crear espera un objeto de trabajo');

    let id = trabajo.id;
    if (id === undefined || id === null || id === '') {
      id = this.generarId();
    } else {
      validarId(id);
      if (fs.existsSync(this.rutasDeLogs(id).job)) {
        throw new Error(`Ya existe un trabajo con id ${id}`);
      }
    }

    const completo = {
      estado: 'queued',
      creadoEn: Date.now(),
      ...trabajo,
      id, // el id validado/generado manda sobre el entrante
    };
    if (!ESTADOS.includes(completo.estado)) {
      throw new Error(`estado inicial desconocido: ${completo.estado}`);
    }

    const rutas = this.rutasDeLogs(id);
    fs.mkdirSync(rutas.dir, { recursive: true });
    for (const archivo of [rutas.stdout, rutas.stderr, rutas.events]) {
      if (!fs.existsSync(archivo)) fs.closeSync(fs.openSync(archivo, 'a'));
    }
    this.escribirAtomico(rutas.job, completo);
    return completo;
  }

  /**
   * Lee un trabajo. Devuelve `null` si no existe. Si el JSON está corrupto,
   * lanza el error de parseo (quien lista es quien tolera, no quien lee).
   *
   * @param {string} id
   * @returns {object|null}
   * @throws {Error} si el id es inválido o el JSON está corrupto
   */
  leer(id) {
    validarId(id);
    const ruta = this.rutasDeLogs(id).job;
    if (!fs.existsSync(ruta)) return null;
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
  }

  /**
   * Aplica un parche a un trabajo existente y lo persiste atómicamente. Si el
   * parche trae `estado` distinto, se valida con la máquina de estados y se sellan
   * las marcas de tiempo. El `id` no se puede cambiar.
   *
   * @param {string} id
   * @param {object} parche
   * @returns {object} el trabajo actualizado
   * @throws {TypeError|Error}
   */
  actualizar(id, parche) {
    if (!esObjetoPlano(parche)) throw new TypeError('actualizar espera un objeto de parche');
    const actual = this.leer(id);
    if (!actual) throw new Error(`No existe el trabajo ${id}`);

    const copia = { ...actual };
    if (parche.estado !== undefined && parche.estado !== copia.estado) {
      transicionar(copia, parche.estado); // valida la transición y sella inicioEn/finEn
    }
    for (const [clave, valor] of Object.entries(parche)) {
      if (clave === 'estado' || clave === 'id') continue; // estado ya aplicado; id inmutable
      copia[clave] = valor;
    }
    this.escribirAtomico(this.rutasDeLogs(id).job, copia);
    return copia;
  }

  /**
   * Lista trabajos ordenados por creación descendente, con filtro opcional por
   * estado y límite. Los `job.json` corruptos se OMITEN y se reportan en
   * `corruptos` para que un archivo roto no tumbe el listado completo.
   *
   * @param {{ estado?: string, limite?: number }} [opciones]
   * @returns {{ trabajos: object[], corruptos: Array<{ id: string, error: string }> }}
   */
  listar({ estado, limite } = {}) {
    const dirJobs = path.join(this.dir, 'jobs');
    /** @type {object[]} */
    const trabajos = [];
    /** @type {Array<{ id: string, error: string }>} */
    const corruptos = [];

    let entradas = [];
    try {
      entradas = fs.readdirSync(dirJobs, { withFileTypes: true });
    } catch {
      return { trabajos, corruptos }; // aún no hay directorio de trabajos
    }

    for (const entrada of entradas) {
      if (!entrada.isDirectory()) continue;
      const id = entrada.name;
      try {
        const texto = fs.readFileSync(path.join(dirJobs, id, 'job.json'), 'utf8');
        const trabajo = JSON.parse(texto);
        if (!esObjetoPlano(trabajo)) throw new Error('el job.json no es un objeto');
        trabajos.push(trabajo);
      } catch (error) {
        corruptos.push({ id, error: String(error && error.message ? error.message : error) });
      }
    }

    trabajos.sort((a, b) => (b.creadoEn ?? 0) - (a.creadoEn ?? 0));
    let resultado = trabajos;
    if (estado !== undefined) resultado = resultado.filter((t) => t.estado === estado);
    if (Number.isInteger(limite) && limite >= 0) resultado = resultado.slice(0, limite);
    return { trabajos: resultado, corruptos };
  }

  /**
   * Agrega un evento al `events.jsonl` del trabajo con marca de tiempo.
   * @param {string} id
   * @param {object} [evento]
   * @returns {object} el evento persistido
   */
  agregarEvento(id, evento = {}) {
    validarId(id);
    const rutas = this.rutasDeLogs(id);
    fs.mkdirSync(rutas.dir, { recursive: true });
    const completo = {
      ...(esObjetoPlano(evento) ? evento : {}),
      ocurridoEn: Date.now(),
    };
    fs.appendFileSync(rutas.events, `${JSON.stringify(completo)}\n`);
    return completo;
  }

  /**
   * Agrega una línea JSON al `audit.log` global, sin el prompt completo. Si el
   * log supera `topeAuditoriaBytes`, lo rota antes a `audit.log.1` (un único
   * respaldo, se sobrescribe). POR QUÉ rotar: sin tope, el log de auditoría
   * crecería sin límite en un servidor de larga vida.
   *
   * @param {object} [entrada]
   * @returns {object} la entrada saneada que se escribió
   */
  auditar(entrada = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const destino = path.join(this.dir, 'audit.log');
    this.rotarAuditoria(destino);
    const limpia = sanearPrompt(esObjetoPlano(entrada) ? entrada : { dato: entrada });
    const completa = { ...limpia, auditadoEn: Date.now() };
    fs.appendFileSync(destino, `${JSON.stringify(completa)}\n`);
    return completa;
  }

  /**
   * Rota `audit.log` a `audit.log.1` si ya alcanzó el tope. Se conserva un solo
   * respaldo: el anterior `.1` se reemplaza (rename atómico en el mismo directorio).
   *
   * @param {string} destino ruta del audit.log
   * @returns {boolean} si rotó
   */
  rotarAuditoria(destino) {
    let tamano;
    try {
      tamano = fs.statSync(destino).size;
    } catch {
      return false; // aún no existe: nada que rotar
    }
    if (tamano < this.topeAuditoriaBytes) return false;
    try {
      fs.renameSync(destino, `${destino}.1`);
      return true;
    } catch {
      return false; // si no se puede rotar, se sigue escribiendo en el mismo archivo
    }
  }

  /**
   * Lee los últimos `bytes` de un log SIN leer el archivo entero (open + fstat +
   * read desde el offset). Tolera un corte en medio de un carácter multibyte:
   * descarta los bytes de continuación iniciales para no devolver basura.
   *
   * @param {string} id
   * @param {'stdout'|'stderr'|'events'} canal
   * @param {number} bytes
   * @returns {string}
   * @throws {Error} si el canal es desconocido
   */
  leerCola(id, canal, bytes) {
    validarId(id);
    const archivo = ARCHIVO_CANAL[canal];
    if (!archivo) throw new Error(`canal desconocido: ${canal} (permitidos: stdout, stderr, events)`);
    const cantidad = Number.isInteger(bytes) && bytes > 0 ? bytes : 0;
    const ruta = path.join(this.rutasDeLogs(id).dir, archivo);
    if (cantidad === 0 || !fs.existsSync(ruta)) return '';

    const fd = fs.openSync(ruta, 'r');
    try {
      const tamano = fs.fstatSync(fd).size;
      const aLeer = Math.min(cantidad, tamano);
      if (aLeer === 0) return '';
      const buffer = Buffer.alloc(aLeer);
      fs.readSync(fd, buffer, 0, aLeer, tamano - aLeer);
      // Si el corte cayó dentro de un carácter, el primer byte del buffer es de
      // continuación (10xxxxxx). Lo saltamos hasta el inicio del siguiente carácter.
      let inicio = 0;
      while (inicio < buffer.length && (buffer[inicio] & 0xc0) === 0x80) inicio += 1;
      return buffer.subarray(inicio).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Registra una advertencia en el `events.jsonl` del trabajo sin romper la
   * reconciliación si el log no se puede escribir.
   *
   * @param {string} id
   * @param {string} advertencia
   * @param {number} pgid
   * @returns {void}
   */
  advertir(id, advertencia, pgid) {
    try {
      this.agregarEvento(id, { tipo: 'advertencia', advertencia, pgid });
    } catch {
      /* un log de eventos que falla no debe impedir marcar el trabajo como perdido */
    }
  }

  /**
   * Toma el bloqueo de instancia del directorio de estado (§8, S2): impide que
   * DOS servidores operen sobre el mismo `$ORQ_STATE_DIR`, lo que corrompería
   * contadores, listados y reconciliaciones. Se crea `server.lock` de forma
   * EXCLUSIVA (`wx`): si ya existía, se decide si es de otro servidor vivo o un
   * lock obsoleto.
   *
   * POR QUÉ se compara la identidad y no solo el pid: tras un reinicio de WSL o
   * de la máquina, el pid del lock puede pertenecer a un proceso AJENO. Un lock
   * con pid muerto, otro `bootId` o identidad distinta es obsoleto y se reemplaza.
   *
   * @returns {{ pid: number, identidad: object|null }} el lock propio
   * @throws {Error} si hay otro servidor activo (mismo pid vivo e identidad)
   */
  adquirirBloqueoDeInstancia() {
    fs.mkdirSync(this.dir, { recursive: true });
    const ruta = path.join(this.dir, 'server.lock');
    const propia = { pid: process.pid, identidad: identidadDeProceso(process.pid) };

    try {
      fs.writeFileSync(ruta, JSON.stringify(propia), { flag: 'wx' });
      this._lockPropio = propia;
      return propia;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }

    /** @type {any} */
    let existente = null;
    try {
      existente = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch {
      existente = null; // lock ilegible: se considera obsoleto
    }
    const pid = esObjetoPlano(existente) ? existente.pid : null;
    const vivo = pidVivo(pid);
    const identidadExistente = vivo ? identidadDeProceso(pid) : null;
    if (vivo && coincideIdentidad(existente.identidad, identidadExistente)) {
      throw new Error(`otro servidor activo pid ${pid}`);
    }

    // Lock obsoleto (proceso muerto, otro bootId o identidad distinta): se reemplaza.
    fs.writeFileSync(ruta, JSON.stringify(propia), { flag: 'w' });
    this._lockPropio = propia;
    return propia;
  }

  /**
   * Libera el bloqueo de instancia SOLO si es nuestro (mismo pid e identidad).
   * Así un servidor no borra el lock de otro que legítimamente lo tenga tomado.
   *
   * @returns {boolean} si se borró
   */
  liberarBloqueoDeInstancia() {
    const ruta = path.join(this.dir, 'server.lock');
    /** @type {any} */
    let existente = null;
    try {
      existente = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch {
      return false; // no existe o ilegible: no hay nada nuestro que borrar
    }
    const propia = identidadDeProceso(process.pid);
    if (!esObjetoPlano(existente) || existente.pid !== process.pid || !coincideIdentidad(existente.identidad, propia)) {
      return false;
    }
    try {
      fs.rmSync(ruta, { force: true });
    } catch {
      return false;
    }
    this._lockPropio = null;
    return true;
  }

  /**
   * Reconcilia los trabajos que quedaron vivos tras un reinicio del servidor.
   *
   * Reglas (§8, S1):
   *  - Los que están en `queued` pasan a `lost`: no hay cola persistente.
   *  - Los que tienen `pgid` e `identidad` registrados: SOLO se mata el grupo si
   *    el proceso que hoy ocupa ese pgid es el MISMO (mismo `bootId` y mismo
   *    `starttime`). Si no coincide, no hay identidad guardada o el `bootId`
   *    cambió, NO se mata (podría ser un proceso ajeno) y se deja una advertencia.
   *  - Cualquier otro trabajo no terminal también pasa a `lost`.
   *
   * @param {{ procesoVivo?: (pgid: number) => boolean, identidadDe?: (pid: number) => object|null }} [opciones]
   *   sondas inyectables; por defecto `existeGrupo` y `identidadDeProceso`.
   * @returns {Promise<string[]>} ids pasados a `lost`
   */
  async marcarPerdidos({ procesoVivo = existeGrupo, identidadDe = identidadDeProceso } = {}) {
    const { trabajos } = this.listar();
    /** @type {string[]} */
    const afectados = [];
    const bootActual = bootIdActual();

    for (const trabajo of trabajos) {
      if (esTerminal(trabajo.estado)) continue;
      const pgid = Number.isInteger(trabajo.pgid) && trabajo.pgid > 0 ? trabajo.pgid : null;
      let motivo = 'servidor_reiniciado';

      if (trabajo.estado !== 'queued' && pgid !== null) {
        let sigueVivo = false;
        try {
          sigueVivo = procesoVivo(pgid);
        } catch {
          sigueVivo = false;
        }

        if (sigueVivo) {
          const guardada = esObjetoPlano(trabajo.identidad) ? trabajo.identidad : null;
          if (!guardada) {
            // Sin identidad no podemos demostrar que el grupo sea nuestro.
            motivo = 'sin_identidad';
            this.advertir(trabajo.id, 'sin_identidad', pgid);
          } else if (typeof guardada.bootId === 'string' && bootActual !== null && guardada.bootId !== bootActual) {
            // Otro arranque del kernel: nada de lo nuestro pudo sobrevivir.
            motivo = 'reinicio_del_sistema';
            this.advertir(trabajo.id, 'reinicio_del_sistema', pgid);
          } else {
            let actual = null;
            try {
              actual = identidadDe(pgid);
            } catch {
              actual = null;
            }
            if (coincideIdentidad(guardada, actual)) {
              try {
                await matarGrupo(pgid);
              } catch {
                /* matar es best-effort: igualmente marcamos el trabajo como perdido */
              }
              motivo = 'servidor_reiniciado';
            } else {
              motivo = 'identidad_no_coincide';
              this.advertir(trabajo.id, 'identidad_no_coincide', pgid);
            }
          }
        }
      }

      this.actualizar(trabajo.id, { estado: 'lost', perdidoMotivo: motivo });
      afectados.push(trabajo.id);
    }

    return afectados;
  }
}
