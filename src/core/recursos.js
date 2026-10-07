/**
 * Recursos exclusivos por trabajo (§7): interfaz `provisionar(job) -> { env, liberar }`
 * y una fábrica por `kind`. Hoy solo `postgres-db`.
 *
 * POR QUÉ el nombre de la base es una barrera de seguridad: crear y, sobre todo,
 * borrar bases de datos es la operación más destructiva del orquestador. Para que
 * un fallo de configuración no toque una base real, el nombre resultante debe
 * cumplir `/^[a-z][a-z0-9_]{0,62}_test$/`: minúsculas, termina en `_test` y el
 * `{job}` se sustituye por el id del trabajo (único). Cualquier otro nombre se
 * rechaza ANTES de invocar `psql`.
 *
 * POR QUÉ psql con argumentos en array (nunca shell): el SQL no debe pasar por una
 * capa que interprete `;`, `$()` ni comillas. Con `execFile('psql', args)` cada
 * valor es un argumento literal.
 *
 * POR QUÉ las credenciales viajan por el ENTORNO del hijo y no por `argv`: la URL
 * de administración lleva la contraseña. Si se pasara como `-d <url>`, cualquier
 * usuario del sistema podría leerla en `/proc/<pid>/cmdline` mientras psql corre.
 * Por eso se parsea la URL y se arma un entorno con PGHOST/PGPORT/PGUSER/
 * PGPASSWORD/PGDATABASE (y PGSSLMODE si la URL trae `sslmode`); `argv` solo lleva
 * el SQL. La URL exportada al trabajo SÍ conserva la contraseña (la app la
 * necesita) pero también se entrega por el entorno del trabajo, no por argumentos.
 *
 * POR QUÉ `ejecutarPsql` es inyectable: permite probar toda la lógica (SQL exacto,
 * validaciones, idempotencia y el entorno recibido) sin una base de Postgres real;
 * el test de integración usa el real y se saltea si no está disponible.
 */

import { execFile } from 'node:child_process';

/** Único patrón de nombre de base permitido: minúsculas, `_test` final. */
export const NOMBRE_BASE_TEST = /^[a-z][a-z0-9_]{0,62}_test$/;

/** Ejecutable de Postgres; fijo y sin shell. */
const PSQL = 'psql';

/** Argumentos comunes de psql: sin `.psqlrc` (`-X`), abortando ante el primer error
 * y sin `-d` (los datos de conexión van por entorno, no por `argv`). */
const PSQL_BASE = ['-X', '-v', 'ON_ERROR_STOP=1'];

/**
 * Envuelve un identificador SQL entre comillas dobles, duplicando las internas.
 * @param {string} nombre
 * @returns {string}
 */
function citarIdentificador(nombre) {
  return `"${String(nombre).replace(/"/g, '""')}"`;
}

/**
 * Envuelve un valor SQL como literal de texto, duplicando las comillas simples.
 * @param {string} texto
 * @returns {string}
 */
function citarLiteral(texto) {
  return `'${String(texto).replace(/'/g, "''")}'`;
}

/**
 * Traduce una URL de Postgres a las variables PG* que entiende `psql`. Es la
 * pieza que evita exponer la contraseña en `argv`: estos valores van al entorno
 * del proceso hijo.
 *
 * @param {URL} url URL ya parseada (no se valida aquí)
 * @returns {Record<string,string>} SOLO variables PG* (nunca PGPASSFILE/PGSERVICE/PGOPTIONS)
 */
export function entornoPgDesdeUrl(url) {
  /**
   * Decodifica un componente de la URL con tolerancia: una `%` suelta (entrada
   * malformada) no debe tumbar la conexión con un URIError críptico.
   * @param {string} valor
   * @returns {string}
   */
  const decodificar = (valor) => {
    try {
      return decodeURIComponent(valor);
    } catch {
      return valor;
    }
  };

  /** @type {Record<string,string>} */
  const entorno = {};
  if (url.hostname) entorno.PGHOST = url.hostname;
  if (url.port) entorno.PGPORT = url.port;
  const usuario = decodificar(url.username);
  if (usuario) entorno.PGUSER = usuario;
  const contrasena = decodificar(url.password);
  // Solo si la URL trae contraseña: no se inventa una vacía que psql interpretaría.
  if (contrasena) entorno.PGPASSWORD = contrasena;
  // Operaciones administrativas: la base de la URL tal cual (normalmente 'postgres').
  const base = decodificar(url.pathname.replace(/^\//, ''));
  if (base) entorno.PGDATABASE = base;
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) entorno.PGSSLMODE = sslmode;
  return entorno;
}

/**
 * Combina el entorno heredado (para conservar PATH y demás, necesario para
 * localizar el binario) con las PG* de la URL, que siempre mandan. Elimina del
 * heredado PGPASSFILE/PGSERVICE/PGOPTIONS: podrían desviar la conexión a otro
 * host/servicio y saltarse la credencial de la URL.
 *
 * @param {Record<string,string|undefined>} env variables PG* calculadas desde la URL
 * @param {Record<string,string|undefined>} [heredado=process.env] entorno del orquestador
 * @returns {Record<string,string|undefined>} entorno final del proceso hijo (sin mutar el heredado)
 */
export function entornoDePsql(env, heredado = process.env) {
  const base = { ...heredado };
  delete base.PGPASSFILE;
  delete base.PGSERVICE;
  delete base.PGOPTIONS;
  return { ...base, ...env };
}

/**
 * Ejecuta `psql` con una lista de argumentos y devuelve el resultado normalizado.
 * Es la implementación por defecto de `ejecutarPsql`; no usa shell. Los datos de
 * conexión llegan en `env` (PG*) y se inyectan en el entorno del proceso hijo; la
 * implementación real los mezcla con `process.env` (PATH, etc.).
 *
 * @param {string[]} args argumentos de psql (solo SQL e indicadores, sin `-d`)
 * @param {{ env?: Record<string,string> }} [opciones] variables PG* de la conexión
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function ejecutarPsql(args, { env } = {}) {
  return new Promise((resolve) => {
    execFile(
      PSQL,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        // Las PG* de la URL mandan; del heredado se limpian las que desvían la conexión.
        env: entornoDePsql(env ?? {}),
      },
      (error, stdout, stderr) => {
        // `error.code` puede ser numérico (código de salida) o ENOENT; normalizamos.
        const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * Crea un proveedor de recursos a partir de su definición de perfil.
 *
 * @param {object} definicion definición del perfil:
 *   `{ kind, adminUrlEnv, template?, name (con '{job}'), exportAs }`
 * @param {object} [opciones]
 * @param {Record<string,string>} [opciones.env={}] entorno de donde leer la URL de administración
 * @param {(args: string[], opciones?: { env?: Record<string,string> }) => Promise<{code:number,stdout:string,stderr:string}>} [opciones.ejecutarPsql]
 *   inyectable para tests; recibe los argumentos de psql y las PG* de la conexión;
 *   por defecto ejecuta el `psql` real
 * @returns {{ definicion: object, provisionar: (job?: object) => Promise<{ env: Record<string,string>, liberar: () => Promise<void> }> }}
 * @throws {Error} si el `kind` es desconocido o la definición está incompleta
 */
export function crearProveedor(definicion, opciones = {}) {
  if (!definicion || typeof definicion !== 'object' || Array.isArray(definicion)) {
    throw new Error('La definición del recurso debe ser un objeto');
  }
  if (definicion.kind !== 'postgres-db') {
    throw new Error(
      `kind de recurso no soportado: ${JSON.stringify(definicion.kind)} (permitido: postgres-db)`,
    );
  }

  const { adminUrlEnv, name, exportAs } = definicion;
  if (typeof adminUrlEnv !== 'string' || adminUrlEnv.trim() === '') {
    throw new Error("El recurso 'postgres-db' exige 'adminUrlEnv' (nombre de variable de entorno)");
  }
  if (typeof name !== 'string' || !name.includes('{job}')) {
    throw new Error("El recurso 'postgres-db' exige que 'name' contenga '{job}'");
  }
  if (typeof exportAs !== 'string' || exportAs.trim() === '') {
    throw new Error("El recurso 'postgres-db' exige 'exportAs' (nombre de variable de entorno)");
  }
  const template = definicion.template;
  if (template !== undefined && (typeof template !== 'string' || template.trim() === '')) {
    throw new Error("'template' debe ser un texto no vacío si se indica");
  }

  const entorno = opciones.env ?? {};
  const ejecutar = typeof opciones.ejecutarPsql === 'function' ? opciones.ejecutarPsql : ejecutarPsql;

  /** SQL de borrado, idempotente por `IF EXISTS` y `FORCE` (corta conexiones). */
  const sqlBorrar = (nombre) => `DROP DATABASE IF EXISTS ${citarIdentificador(nombre)} WITH (FORCE)`;

  /** Arma los argumentos de una sentencia `-c`. La conexión va por entorno, no aquí. */
  const argsSql = (sql) => [...PSQL_BASE, '-c', sql];

  /**
   * Provisiona la base del trabajo: valida el nombre, limpia cualquier resto con
   * ese nombre (trabajo anterior sucio), la crea y devuelve su URL exportada.
   *
   * @param {{ id?: string }} [job] trabajo (se usa `job.id` para `{job}`)
   * @returns {Promise<{ env: Record<string,string>, liberar: () => Promise<void> }>}
   * @throws {Error} sin mostrar la URL de administración en ningún mensaje
   */
  async function provisionar(job = {}) {
    const id = job && job.id !== undefined && job.id !== null ? String(job.id) : '';
    if (id === '') throw new Error('El trabajo no tiene id; no se puede nombrar la base');

    const nombre = name.replace(/\{job\}/g, id);
    if (!NOMBRE_BASE_TEST.test(nombre)) {
      // Barrera: nunca se crea ni se borra una base que no sea de test con el id dado.
      throw new Error(
        'Nombre de base rechazado por seguridad: se exige /^[a-z][a-z0-9_]{0,62}_test$/ ' +
          'y el id del trabajo debe producir un nombre válido (no se toca ninguna base real)',
      );
    }

    const adminUrl = entorno[adminUrlEnv];
    if (typeof adminUrl !== 'string' || adminUrl.trim() === '') {
      // OJO: el mensaje NUNCA incluye la URL (no se filtra el secreto).
      throw new Error(`Falta la variable de entorno ${adminUrlEnv} con la URL de administración de Postgres`);
    }
    let url;
    try {
      url = new URL(adminUrl);
    } catch {
      throw new Error(`La variable ${adminUrlEnv} no contiene una URL de Postgres válida`);
    }

    // Datos de conexión derivados de la URL: viajan por el entorno del hijo, NUNCA por argv.
    const envPg = entornoPgDesdeUrl(url);

    // ¿Existe la plantilla declarada? Solo entonces se usa TEMPLATE.
    let usarTemplate = false;
    if (template) {
      const consulta = await ejecutar(
        argsSql(`SELECT 1 FROM pg_database WHERE datname = ${citarLiteral(template)}`),
        { env: envPg },
      );
      if (consulta.code !== 0) {
        throw new Error(`No se pudo comprobar la plantilla '${template}': ${(consulta.stderr || '').trim()}`);
      }
      usarTemplate = /(^|\D)1(\D|$)/.test(consulta.stdout);
    }

    // Limpia un resto previo con el mismo nombre (el id es único, así que es seguro).
    await ejecutar(argsSql(sqlBorrar(nombre)), { env: envPg });

    const sqlCrear =
      `CREATE DATABASE ${citarIdentificador(nombre)}` +
      (usarTemplate ? ` TEMPLATE ${citarIdentificador(template)}` : '');
    const creacion = await ejecutar(argsSql(sqlCrear), { env: envPg });
    if (creacion.code !== 0) {
      // "No deja nada": intentamos borrar el posible resto y propagamos el error.
      await ejecutar(argsSql(sqlBorrar(nombre)), { env: envPg });
      throw new Error(`No se pudo crear la base '${nombre}': ${(creacion.stderr || '').trim()}`);
    }

    // La URL exportada es la de administración con el nombre de base cambiado.
    url.pathname = `/${nombre}`;
    const urlExportada = url.toString();

    /**
     * Elimina la base creada. Idempotente: `DROP ... IF EXISTS` no falla si ya no
     * está, así que puede llamarse varias veces sin efecto.
     * @returns {Promise<void>}
     */
    async function liberar() {
      const borrado = await ejecutar(argsSql(sqlBorrar(nombre)), { env: envPg });
      if (borrado.code !== 0) {
        throw new Error(`No se pudo eliminar la base '${nombre}': ${(borrado.stderr || '').trim()}`);
      }
    }

    return { env: { [exportAs]: urlExportada }, liberar };
  }

  return { definicion: { ...definicion }, provisionar };
}
