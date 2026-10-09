/**
 * Pizarrón compartido (§nuevo): documento vivo donde los agentes leen en vivo
 * contratos y decisiones y al que aportan SIN pisarse.
 *
 * POR QUÉ un módulo independiente: el orquestador y cada worktree necesitan un
 * punto común de coordinación sin acoplarse a `gestor.js`/`workspace.js`. El
 * servidor (proceso único) es el único que escribe el archivo vivo
 * `<dir>/pizarron.json` de forma ATÓMICA; los worktrees reciben un symlink de
 * SOLO LECTURA y cada agente deja sus aportes en su propio `.orq/aporte.json`.
 *
 * POR QUÉ escrituras síncronas: dos aportes simultáneos del MISMO proceso no
 * pueden intercalarse si cada operación (leer-modificar-escribir) corre entera
 * sin ceder el hilo; así no hace falta una cola ni promesas y nunca se pierde un
 * cambio. La atomicidad frente a un corte a mitad la da el rename.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Claves permitidas: cortas y sin caracteres que compliquen rutas o diffs. */
const RE_CLAVE = /^[a-zA-Z0-9_.:/-]{1,80}$/;

/**
 * Claves que JAMÁS se aceptan aunque cumplan `RE_CLAVE`: asignarlas sobre un objeto
 * normal dispara el prototipo (`__proto__`) o pisa miembros heredados (`constructor`,
 * `prototype`). Rechazarlas es la primera barrera contra la contaminación de objetos;
 * la segunda es usar `claves` sin prototipo (ver `documentoVacio`).
 * @type {ReadonlySet<string>}
 */
const CLAVES_RESERVADAS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Tope de bytes del archivo de aporte. Un aporte más grande se ignora SIN leerlo
 * entero: se valida con `stat` antes de `readFileSync` (cada vigilancia de 30 s no
 * debe cargar en memoria un archivo arbitrariamente grande).
 */
export const MAX_APORTE_BYTES = 1024 * 1024;

/** Tope de bytes del `valor` ya serializado (8 KB). */
const MAX_VALOR_BYTES = 8 * 1024;

/** Tope de caracteres de una `nota`. */
const MAX_NOTA = 500;

/** Cuántas entradas de historial se conservan por clave (las más nuevas). */
const MAX_HISTORIAL = 20;

/** Nombre del archivo vivo dentro de `dir`. */
const ARCHIVO_VIVO = 'pizarron.json';

/**
 * ¿Es un objeto JSON plano (no null, no array)?
 * @param {unknown} valor
 * @returns {boolean}
 */
function esObjetoPlano(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * Compara dos valores JSON por su serialización. Se usa para detectar aportes
 * idénticos ya fusionados; el orden de claves se preserva al venir ambos de un
 * `JSON.parse`, por lo que la comparación es estable.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function equivalente(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Documento vacío: versión 0 y sin claves ni notas.
 * @returns {{ version: number, actualizado: number, claves: object, notas: object[] }}
 */
function documentoVacio() {
  // `claves` sin prototipo: una clave `__proto__` queda como propiedad propia y no
  // puede cambiar el prototipo del objeto (contaminación).
  return { version: 0, actualizado: 0, claves: Object.create(null), notas: [] };
}

/**
 * Normaliza un documento leído para que el resto del módulo pueda confiar en su
 * forma sin romperse ante un archivo escrito por una versión anterior.
 * @param {object} doc
 * @returns {object}
 */
function normalizarDocumento(doc) {
  const clavesEntrantes = esObjetoPlano(doc.claves) ? doc.claves : {};
  /** @type {Record<string, object>} */
  const claves = Object.create(null);
  for (const [clave, entrada] of Object.entries(clavesEntrantes)) {
    // Claves reservadas de un documento persistido (JSON.parse las crea como propias):
    // se descartan para que no contaminen nada ni reaparezcan como claves válidas.
    if (CLAVES_RESERVADAS.has(clave)) continue;
    if (!esObjetoPlano(entrada)) continue;
    claves[clave] = {
      valor: entrada.valor,
      nota: typeof entrada.nota === 'string' ? entrada.nota : '',
      jobId: entrada.jobId,
      ts: entrada.ts,
      historial: Array.isArray(entrada.historial) ? entrada.historial.slice(-MAX_HISTORIAL) : [],
    };
  }
  return {
    version: Number.isInteger(doc.version) ? doc.version : 0,
    actualizado: Number.isFinite(doc.actualizado) ? doc.actualizado : 0,
    claves,
    notas: Array.isArray(doc.notas) ? doc.notas.filter(esObjetoPlano) : [],
  };
}

/**
 * ¿Por qué NO se debe leer este archivo de aporte? `null` si es legible y razonable.
 *
 * Se comprueba ANTES de `readFileSync` porque el aporte se relee en cada vigilancia
 * (30 s): leer un archivo de gigabytes o seguir un enlace a una ruta arbitraria
 * agotaría memoria o permitiría leer fuera del worktree. Un enlace cuyo destino real
 * sale del worktree se rechaza aunque el texto de la ruta se vea inocente.
 *
 * @param {string} rutaAporte
 * @param {string} [raizWorktree] raíz contra la que validar un symlink
 * @returns {string|null} motivo de rechazo, o `null` si es válido
 */
export function motivoAporteInvalido(rutaAporte, raizWorktree) {
  let info;
  try {
    info = fs.lstatSync(rutaAporte);
  } catch {
    return null; // ausente o ilegible: `fusionarAporte` lo tolera como hasta ahora
  }
  if (info.isSymbolicLink() && typeof raizWorktree === 'string' && raizWorktree !== '') {
    let destinoReal;
    let raizReal;
    try {
      destinoReal = fs.realpathSync(rutaAporte);
      raizReal = fs.realpathSync(raizWorktree);
    } catch {
      return 'enlace_roto';
    }
    if (destinoReal !== raizReal && !destinoReal.startsWith(`${raizReal}${path.sep}`)) {
      return 'fuera_del_worktree';
    }
  }
  let tamano;
  try {
    tamano = fs.statSync(rutaAporte).size; // sigue el enlace: pesa el destino real
  } catch {
    return 'ilegible';
  }
  if (tamano > MAX_APORTE_BYTES) return 'demasiado_grande';
  return null;
}

/**
 * Crea la vista del pizarrón sobre `dir`. El directorio puede no existir todavía:
 * se crea en la primera escritura.
 *
 * @param {{ dir: string, ahora?: () => number }} opciones
 *   `ahora` es inyectable para tests deterministas; por defecto `Date.now`.
 * @returns {{
 *   leer: () => object,
 *   post: (entrada: object) => { aplicado: boolean, conflicto: boolean, motivo?: string },
 *   fusionarAporte: (jobId: string, rutaAporte: string, opciones?: { raizWorktree?: string }) => { fusionadas: number, ignoradas: number, conflictos?: number, invalido?: boolean, motivo?: string },
 *   rutaViva: () => string,
 *   version: () => number,
 * }}
 */
export function crearPizarron({ dir, ahora = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('crearPizarron espera un directorio válido');
  }
  const base = path.resolve(dir);
  const ruta = path.join(base, ARCHIVO_VIVO);

  /** @returns {string} ruta del archivo vivo */
  function rutaViva() {
    return ruta;
  }

  /**
   * Aparta un archivo ilegible en vez de borrarlo: conserva la evidencia por si
   * hubo una escritura de otra versión que conviene inspeccionar.
   * @returns {void}
   */
  function apartarCorrupto() {
    const sello = String(ahora());
    let destino = path.join(base, `pizarron.corrupto.${sello}.json`);
    let sufijo = 1;
    while (fs.existsSync(destino)) {
      destino = path.join(base, `pizarron.corrupto.${sello}-${sufijo}.json`);
      sufijo += 1;
    }
    try {
      fs.renameSync(ruta, destino);
    } catch {
      /* si no se puede apartar, igual arrancamos vacío */
    }
  }

  /**
   * Escribe el documento en `pizarron.json.tmp` y lo renombra: un lector ve la
   * versión anterior o la nueva, jamás una mezcla.
   * @param {object} doc
   * @returns {void}
   */
  function escribir(doc) {
    fs.mkdirSync(base, { recursive: true });
    const temporal = `${ruta}.tmp`;
    fs.writeFileSync(temporal, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(temporal, ruta);
  }

  /**
   * Devuelve el documento actual. Un archivo ausente da uno vacío; uno corrupto
   * se aparta y también arranca vacío (nunca lanza).
   * @returns {object}
   */
  function leer() {
    let texto;
    try {
      texto = fs.readFileSync(ruta, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return documentoVacio();
      return documentoVacio();
    }
    let doc;
    try {
      doc = JSON.parse(texto);
    } catch {
      apartarCorrupto();
      return documentoVacio();
    }
    if (!esObjetoPlano(doc)) {
      apartarCorrupto();
      return documentoVacio();
    }
    return normalizarDocumento(doc);
  }

  /**
   * Valida y normaliza una entrada de `post`. Devuelve `null` si es inválida.
   * @param {object} entrada
   * @returns {{ clave: string, valor: unknown, nota: string, jobId: string, forzar: boolean }|null}
   */
  function validarEntrada(entrada) {
    if (!esObjetoPlano(entrada)) return null;
    const { clave, jobId } = entrada;
    if (typeof clave !== 'string' || !RE_CLAVE.test(clave)) return null;
    // `__proto__`/`constructor`/`prototype` cumplen `RE_CLAVE` pero no deben tratarse
    // como claves: se cuentan como inválidas (ignoradas) en lugar de dejar que rompan.
    if (CLAVES_RESERVADAS.has(clave)) return null;
    if (typeof jobId !== 'string' || jobId === '') return null;

    let serializado;
    try {
      serializado = JSON.stringify(entrada.valor);
    } catch {
      return null; // circular o con BigInt: no es JSON válido
    }
    if (serializado === undefined) return null; // funciones/símbolos/undefined
    if (Buffer.byteLength(serializado, 'utf8') > MAX_VALOR_BYTES) return null;

    const notaBruta = entrada.nota;
    if (notaBruta !== undefined && notaBruta !== null && typeof notaBruta !== 'string') return null;
    const nota = notaBruta == null ? '' : notaBruta;
    if (nota.length > MAX_NOTA) return null;

    return { clave, valor: entrada.valor, nota, jobId, forzar: entrada.forzar === true };
  }

  /**
   * Publica una clave. Reglas pensadas para que dos trabajos no se pisen:
   *  - clave nueva: se crea;
   *  - clave del MISMO trabajo: se actualiza y se registra en el historial;
   *  - clave de OTRO trabajo: NO se pisa; solo se agrega el intento al historial
   *    marcado `conflicto: true`, salvo `forzar: true` (reservado al orquestador).
   *
   * @param {object} entrada
   * @returns {{ aplicado: boolean, conflicto: boolean, motivo?: string }}
   */
  function post(entrada) {
    const limpia = validarEntrada(entrada);
    if (!limpia) return { aplicado: false, conflicto: false, motivo: 'invalida' };
    const { clave, valor, nota, jobId, forzar } = limpia;

    const doc = leer();
    const ts = ahora();
    const nueva = { valor, nota, jobId, ts };
    // `Object.hasOwn` y no `doc.claves[clave]`: con un objeto sin prototipo alcanza,
    // pero además evita tratar un miembro heredado como clave existente.
    const actual = Object.hasOwn(doc.claves, clave) ? doc.claves[clave] : undefined;
    let aplicado = true;
    let conflicto = false;

    if (!actual) {
      doc.claves[clave] = { ...nueva, historial: [nueva] };
    } else if (actual.jobId === jobId) {
      doc.claves[clave] = {
        ...nueva,
        historial: [...actual.historial, nueva].slice(-MAX_HISTORIAL),
      };
    } else {
      conflicto = true;
      const intento = { ...nueva, conflicto: true };
      if (forzar) {
        doc.claves[clave] = {
          ...nueva,
          historial: [...actual.historial, intento].slice(-MAX_HISTORIAL),
        };
      } else {
        aplicado = false; // se preserva el valor vigente y su dueño
        doc.claves[clave] = {
          ...actual,
          historial: [...actual.historial, intento].slice(-MAX_HISTORIAL),
        };
      }
    }

    doc.version += 1;
    doc.actualizado = ts;
    escribir(doc);
    return conflicto ? { aplicado, conflicto, motivo: forzar ? 'forzado' : 'conflicto' } : { aplicado, conflicto };
  }

  /**
   * ¿La última entrada del historial de `clave` ya es este mismo aporte del mismo
   * trabajo? Hace idempotente a `fusionarAporte` sin importar cuántas veces se lea
   * el archivo de aporte.
   * @param {object} doc
   * @param {string} clave
   * @param {unknown} valor
   * @param {string} nota
   * @param {string} jobId
   * @returns {boolean}
   */
  function yaFusionado(doc, clave, valor, nota, jobId) {
    const actual = doc.claves && Object.hasOwn(doc.claves, clave) ? doc.claves[clave] : undefined;
    if (!actual || !Array.isArray(actual.historial) || actual.historial.length === 0) return false;
    const ultima = actual.historial[actual.historial.length - 1];
    return ultima.jobId === jobId && equivalente(ultima.valor, valor) && (ultima.nota ?? '') === nota;
  }

  /**
   * Fusiona el archivo de aporte de un trabajo. Es TOLERANTE: un archivo ausente
   * o corrupto no lanza y no aporta nada. Un aporte rechazado (gigante o con un
   * enlace que escapa) se cuenta como ignorado y se informa `invalido`.
   *
   * @param {string} jobId
   * @param {string} rutaAporte
   * @param {{ raizWorktree?: string }} [opciones]
   * @returns {{ fusionadas: number, ignoradas: number, conflictos?: number, invalido?: boolean, motivo?: string }}
   */
  function fusionarAporte(jobId, rutaAporte, { raizWorktree } = {}) {
    const rechazo = motivoAporteInvalido(rutaAporte, raizWorktree);
    if (rechazo) return { fusionadas: 0, ignoradas: 1, invalido: true, motivo: rechazo };
    let texto;
    try {
      texto = fs.readFileSync(rutaAporte, 'utf8');
    } catch {
      return { fusionadas: 0, ignoradas: 0 };
    }
    let aporte;
    try {
      aporte = JSON.parse(texto);
    } catch {
      return { fusionadas: 0, ignoradas: 0 };
    }
    if (!esObjetoPlano(aporte)) return { fusionadas: 0, ignoradas: 0 };

    const entradas = Array.isArray(aporte.entradas) ? aporte.entradas : [];
    let fusionadas = 0;
    let ignoradas = 0;
    let conflictos = 0;

    for (const cruda of entradas) {
      const limpia = validarEntrada(cruda === undefined ? {} : { ...(esObjetoPlano(cruda) ? cruda : {}), jobId });
      if (!limpia) {
        ignoradas += 1;
        continue;
      }
      if (yaFusionado(leer(), limpia.clave, limpia.valor, limpia.nota, jobId)) {
        ignoradas += 1;
        continue;
      }
      const res = post({ clave: limpia.clave, valor: limpia.valor, nota: limpia.nota, jobId });
      if (res.aplicado) fusionadas += 1;
      else ignoradas += 1;
      if (res.conflicto) conflictos += 1;
    }

    const notas = Array.isArray(aporte.notas) ? aporte.notas : [];
    const doc = leer();
    const ts = ahora();
    let agregadas = 0;
    for (const textoNota of notas) {
      if (typeof textoNota !== 'string' || textoNota === '') continue;
      const ultima = doc.notas[doc.notas.length - 1];
      // Misma idea que en las entradas: re-leer el aporte no debe duplicar notas.
      if (ultima && ultima.jobId === jobId && ultima.texto === textoNota) continue;
      doc.notas.push({ jobId, ts, texto: textoNota });
      agregadas += 1;
    }
    if (agregadas > 0) {
      doc.version += 1;
      doc.actualizado = ts;
      escribir(doc);
    }

    return { fusionadas, ignoradas, conflictos };
  }

  /** @returns {number} versión actual del documento */
  function version() {
    return leer().version;
  }

  return { leer, post, fusionarAporte, rutaViva, version };
}

/**
 * Texto breve para inyectar en el prompt de cada agente. Explica qué es el
 * pizarrón, que es de solo lectura y cómo aportar sin pisar a los demás.
 * @returns {string}
 */
export function instruccionesParaAgente() {
  return [
    'PIZARRÓN COMPARTIDO (de SOLO LECTURA):',
    '- `.orq/pizarron.json` reúne contratos y decisiones de los demás agentes: leelo al empezar y respetalos.',
    '- No lo edites: el servidor es el único que lo escribe. Para compartir algo, escribí tu propio `.orq/aporte.json`.',
    '- No toques nada más dentro de `.orq/` salvo `mutaciones.json`.',
    'Formato de `.orq/aporte.json`:',
    '```json',
    '{',
    '  "entradas": [ { "clave": "api.ruta", "valor": { "path": "/v1/x" }, "nota": "definido" } ],',
    '  "notas": [ "texto libre para el orquestador" ]',
    '}',
    '```',
    '- `clave` corta (1-80), `valor` JSON de hasta 8 KB y `nota` de hasta 500 caracteres.',
  ].join('\n');
}
