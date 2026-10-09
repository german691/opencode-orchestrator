/**
 * COMPUERTA EN FRAGMENTOS PARALELOS.
 *
 * POR QUÉ existe este módulo: una aceptación pesada (p. ej. la suite de integración,
 * ~10 min) es el cuello de botella de la tanda. Partirla en N fragmentos que corran a la
 * vez reduce el tiempo; cada fragmento necesita SU PROPIA instancia del recurso (otra base
 * de datos) y su propia variable de entorno, y muchas herramientas ya saben hacerlo
 * (`vitest --shard=1/3`). Por eso el comando declara `{i}` (fragmento) y `{n}` (total).
 *
 * POR QUÉ NO se conecta todavía a `gestor.js`/`profile.js`: esta es la pieza aislada; el
 * diseño que la integra (cómo se descubren las variables del recurso, cuándo se liberan
 * respecto del ciclo de vida del trabajo) es otro cambio. Acá se expone una interfaz pura
 * y testeable con dependencias inyectadas.
 *
 * Reglas de operación (las que se quieren ver todos los fallos):
 * - Se lanzan los N fragmentos a la vez (no en serie).
 * - La liberación de cada recurso ocurre SIEMPRE en `finally`, aunque el fragmento falle.
 * - Si un fragmento falla, los demás NO se cancelan: se quieren todos los errores.
 *   `cortarAlPrimerFallo: true` es la excepción explícita: se deja de esperar al resto
 *   (se reportan como `cancelado`) para acortar el tiempo.
 */

/** Tope de fragmentos: por debajo de 2 no hay paralelismo y por encima de 8 no hay ganancia. */
const MIN_SHARDS = 2;
const MAX_SHARDS = 8;

/** Cuántas líneas de cada fragmento se guardan en la salida combinada. */
const LINEAS_COLA = 60;

/**
 * ¿Es un objeto plano (no null, no array)? Evita aceptar `[]` o `null` como sección.
 * @param {unknown} valor
 * @returns {boolean}
 */
function esObjetoPlano(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

/**
 * Valida y normaliza la sección `paralelo` de una aceptación.
 *
 * @param {object} spec aceptación con la forma `{ paralelo: { shards, comando, recurso?, timeoutMs? } }`
 * @returns {{ shards: number, comando: string, recurso: string|undefined, timeoutMs: number|undefined, cortarAlPrimerFallo: boolean }}
 * @throws {Error} con un mensaje claro ante cualquier campo inválido
 */
export function normalizarParalelo(spec) {
  if (!esObjetoPlano(spec)) {
    throw new Error("La aceptación debe ser un objeto con la sección 'paralelo'");
  }
  const paralelo = spec.paralelo;
  if (!esObjetoPlano(paralelo)) {
    throw new Error("La aceptación no declara la sección 'paralelo'");
  }

  const { shards } = paralelo;
  if (!Number.isInteger(shards) || shards < MIN_SHARDS || shards > MAX_SHARDS) {
    throw new Error(
      `paralelo.shards debe ser un entero entre ${MIN_SHARDS} y ${MAX_SHARDS} (recibido: ${JSON.stringify(shards)})`,
    );
  }

  const { comando } = paralelo;
  if (typeof comando !== 'string' || comando.trim() === '') {
    throw new Error('paralelo.comando no puede estar vacío');
  }
  if (!comando.includes('{i}')) {
    // Sin `{i}` los N fragmentos correrían el mismo comando: no habría reparto.
    throw new Error("paralelo.comando debe incluir '{i}' (el índice del fragmento, de 1 a N)");
  }

  let recurso;
  if (paralelo.recurso !== undefined) {
    if (typeof paralelo.recurso !== 'string' || paralelo.recurso.trim() === '') {
      throw new Error('paralelo.recurso debe ser un texto no vacío si se indica');
    }
    recurso = paralelo.recurso;
  }

  let timeoutMs;
  if (paralelo.timeoutMs !== undefined) {
    if (typeof paralelo.timeoutMs !== 'number' || !Number.isFinite(paralelo.timeoutMs) || paralelo.timeoutMs <= 0) {
      throw new Error('paralelo.timeoutMs debe ser un número positivo si se indica');
    }
    timeoutMs = paralelo.timeoutMs;
  }

  return {
    shards,
    comando,
    recurso,
    timeoutMs,
    // Solo un `true` explícito activa el corte; cualquier otro valor mantiene el comportamiento.
    cortarAlPrimerFallo: paralelo.cortarAlPrimerFallo === true,
  };
}

/**
 * Expande el comando a N strings, uno por fragmento, sustituyendo `{i}` (1..N) y `{n}`.
 *
 * @param {object} spec aceptación con sección `paralelo`
 * @returns {string[]} N comandos (en orden 1..N)
 */
export function expandirComandos(spec) {
  const { shards, comando } = normalizarParalelo(spec);
  const comandos = [];
  for (let i = 1; i <= shards; i += 1) {
    comandos.push(comando.replace(/\{i\}/g, String(i)).replace(/\{n\}/g, String(shards)));
  }
  return comandos;
}

/**
 * Últimas `maximo` líneas de un texto. Se guarda la cola porque el inicio de una salida de
 * tests es ruido y el final es donde está el veredicto.
 *
 * @param {string} texto
 * @param {number} [maximo]
 * @returns {string}
 */
function ultimasLineas(texto, maximo = LINEAS_COLA) {
  return String(texto ?? '').split('\n').slice(-maximo).join('\n');
}

/**
 * Clasifica el resultado crudo de un fragmento.
 *
 * POR QUÉ: el ejecutor devuelve `codigo: null` cuando el fragmento expira (`timeout`) o queda
 * sin salida (`idle`). Mapear `null` a 0 haría pasar la compuerta colgada y el trabajo se
 * commitearía/autointegraría. Un fragmento es OK SOLO si su `codigo` es el entero 0 y no hubo
 * corte; cualquier otro caso es fallo, con el código real (o -1) y un motivo legible.
 *
 * @param {object} resultado
 * @returns {{ codigo: number, fallo: boolean, motivo: string|undefined }}
 */
function clasificarResultado(resultado) {
  const codigo = Number.isInteger(resultado.codigo) ? resultado.codigo : -1;
  const senal =
    typeof resultado.senal === 'string' && resultado.senal
      ? resultado.senal
      : typeof resultado.signal === 'string' && resultado.signal
        ? resultado.signal
        : null;
  let motivo;
  if (resultado.timeout) motivo = 'timeout';
  else if (resultado.idle) motivo = 'idle';
  else if (senal) motivo = `senal:${senal}`;
  else if (!Number.isInteger(resultado.codigo)) motivo = 'sin_codigo';
  // Un código entero distinto de 0 es un fallo con su código real y sin motivo extra.
  return { codigo, fallo: codigo !== 0 || motivo !== undefined, motivo };
}

/**
 * Ejecuta la aceptación partida en N fragmentos en paralelo.
 *
 * @param {object} opciones
 * @param {object} opciones.spec aceptación con sección `paralelo`
 * @param {(comando: string, contexto: { env: Record<string,string>, indice: number }) => Promise<{ codigo: number|null, salida?: string, timeout?: boolean, idle?: boolean, signal?: string, senal?: string }>} opciones.ejecutar
 *   corre UN fragmento con su entorno; inyectable
 * @param {(indice: number) => Promise<{ env?: Record<string,string>, [clave: string]: unknown }>} [opciones.provisionar]
 *   crea el recurso del fragmento (otra base) y devuelve `env` + los datos para liberar;
 *   obligatorio si `spec.paralelo.recurso` está declarado
 * @param {(datos: object) => Promise<void>|void} [opciones.liberar] libera el recurso provisionado
 * @returns {Promise<{ ok: boolean, fragmentos: Array<{indice:number, comando:string, codigo:number, ms:number, salidaCola:string, cancelado?:boolean}>, salidaCombinada: string }>}
 */
export async function ejecutarParalelo({ spec, ejecutar, provisionar, liberar }) {
  if (typeof ejecutar !== 'function') {
    throw new Error("ejecutarParalelo exige una función 'ejecutar'");
  }
  const normalizado = normalizarParalelo(spec);
  const { shards, recurso, cortarAlPrimerFallo } = normalizado;
  if (recurso && typeof provisionar !== 'function') {
    throw new Error(`La aceptación declara el recurso '${recurso}' pero falta la función 'provisionar'`);
  }
  const comandos = expandirComandos(spec);
  const inicioLote = Date.now();

  /**
   * Corre un fragmento de punta a punta: provisiona, ejecuta y libera. Nunca rechaza: un
   * error de provisión o del comando es un fragmento fallido con su motivo en `salida`.
   * @param {number} indice
   * @param {string} comando
   */
  async function correrFragmento(indice, comando) {
    const inicio = Date.now();
    let datos = null;
    try {
      if (typeof provisionar === 'function') {
        datos = await provisionar(indice);
      }
      const env = (datos && datos.env) || {};
      const resultado = (await ejecutar(comando, { env, indice })) || {};
      const clasificado = clasificarResultado(resultado);
      const salida = typeof resultado.salida === 'string' ? resultado.salida : '';
      return {
        indice,
        comando,
        codigo: clasificado.codigo,
        motivo: clasificado.motivo,
        fallo: clasificado.fallo,
        ms: Date.now() - inicio,
        salida,
      };
    } catch (error) {
      const mensaje = error && error.message ? error.message : String(error);
      return { indice, comando, codigo: -1, motivo: undefined, fallo: true, ms: Date.now() - inicio, salida: mensaje };
    } finally {
      // Liberar SIEMPRE: si el fragmento falló, su base no debe quedar viva.
      if (datos && typeof liberar === 'function') {
        try {
          await liberar(datos);
        } catch {
          // Un fallo al liberar no debe ocultar el resultado del fragmento.
        }
      }
    }
  }

  // Lanzar los N a la vez. `Map` conserva el orden de lanzamiento (1..N).
  const pendientes = new Map();
  for (let i = 0; i < comandos.length; i += 1) {
    const indice = i + 1;
    pendientes.set(indice, correrFragmento(indice, comandos[i]));
  }

  const resultados = [];
  while (pendientes.size > 0) {
    const entradas = [...pendientes.entries()];
    const ganador = await Promise.race(
      entradas.map(([indice, promesa]) => promesa.then((resultado) => ({ indice, resultado }))),
    );
    pendientes.delete(ganador.indice);
    resultados.push(ganador.resultado);
    if (cortarAlPrimerFallo && ganador.resultado.fallo) break;
  }

  // Los que quedaron corriendo se reportan como cancelados. No se esperan; su `finally`
  // igual liberará el recurso cuando su `ejecutar` termine. `catch` evita rechazos sueltos.
  const cancelados = [];
  for (const [indice, promesa] of pendientes) {
    promesa.catch(() => {});
    cancelados.push({
      indice,
      comando: comandos[indice - 1],
      codigo: -1,
      motivo: undefined,
      fallo: true,
      ms: Date.now() - inicioLote,
      salida: 'cancelado: se cortó al primer fallo',
      cancelado: true,
    });
  }

  const todos = [...resultados, ...cancelados].sort((a, b) => a.indice - b.indice);
  const fragmentos = todos.map(({ indice, comando, codigo, motivo, ms, salida, cancelado }) => ({
    indice,
    comando,
    codigo,
    ...(motivo ? { motivo } : {}),
    ms,
    salidaCola: ultimasLineas(salida),
    ...(cancelado ? { cancelado: true } : {}),
  }));

  // OK solo si están todos y ninguno es fallo. Se usa el booleano `fallo` (no `codigo === 0`)
  // porque un fragmento expirado puede traer código 0 pero igual es un corte.
  const ok = todos.length === shards && todos.every((f) => !f.fallo);

  // La salida combinada pone primero los fallidos: el orquestador ve el problema sin buscar.
  const fallidos = todos.filter((f) => f.fallo);
  const exitosos = todos.filter((f) => !f.fallo);
  const salidaCombinada = [...fallidos, ...exitosos]
    .map((f) => {
      const motivo = f.motivo ? `, motivo ${f.motivo}` : '';
      return `[${f.indice}/${shards}] ${f.comando} (código ${f.codigo}, ${f.ms} ms${motivo})\n${ultimasLineas(f.salida)}`;
    })
    .join('\n\n');

  return { ok, fragmentos, salidaCombinada };
}
