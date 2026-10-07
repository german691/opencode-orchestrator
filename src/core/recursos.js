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
 * POR QUÉ psql con argumentos en array (nunca shell): la URL de administración y
 * el SQL no deben pasar por una capa que interprete `;`, `$()` ni comillas. Con
 * `execFile('psql', args)` cada valor es un argumento literal.
 *
 * POR QUÉ `ejecutarPsql` es inyectable: permite probar toda la lógica (SQL exacto,
 * validaciones, idempotencia) sin una base de Postgres real; el test de
 * integración usa el real y se saltea si no está disponible.
 */

import { execFile } from 'node:child_process';

/** Único patrón de nombre de base permitido: minúsculas, `_test` final. */
export const NOMBRE_BASE_TEST = /^[a-z][a-z0-9_]{0,62}_test$/;

/** Ejecutable de Postgres; fijo y sin shell. */
const PSQL = 'psql';

/** Argumentos comunes de psql: sin `.psqlrc` (`-X`) y abortando ante el primer error. */
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
 * Ejecuta `psql` con una lista de argumentos y devuelve el resultado normalizado.
 * Es la implementación por defecto de `ejecutarPsql`; no usa shell.
 *
 * @param {string[]} args argumentos de psql
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function ejecutarPsql(args) {
  return new Promise((resolve) => {
    execFile(
      PSQL,
      args,
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
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
 * @param {(args: string[]) => Promise<{code:number,stdout:string,stderr:string}>} [opciones.ejecutarPsql]
 *   inyectable para tests; por defecto ejecuta el `psql` real
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

  /** Arma los argumentos de una sentencia `-c` sobre la URL de administración. */
  const argsSql = (adminUrl, sql) => [...PSQL_BASE, '-d', adminUrl, '-c', sql];

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

    // ¿Existe la plantilla declarada? Solo entonces se usa TEMPLATE.
    let usarTemplate = false;
    if (template) {
      const consulta = await ejecutar(
        argsSql(adminUrl, `SELECT 1 FROM pg_database WHERE datname = ${citarLiteral(template)}`),
      );
      if (consulta.code !== 0) {
        throw new Error(`No se pudo comprobar la plantilla '${template}': ${(consulta.stderr || '').trim()}`);
      }
      usarTemplate = /(^|\D)1(\D|$)/.test(consulta.stdout);
    }

    // Limpia un resto previo con el mismo nombre (el id es único, así que es seguro).
    await ejecutar(argsSql(adminUrl, sqlBorrar(nombre)));

    const sqlCrear =
      `CREATE DATABASE ${citarIdentificador(nombre)}` +
      (usarTemplate ? ` TEMPLATE ${citarIdentificador(template)}` : '');
    const creacion = await ejecutar(argsSql(adminUrl, sqlCrear));
    if (creacion.code !== 0) {
      // "No deja nada": intentamos borrar el posible resto y propagamos el error.
      await ejecutar(argsSql(adminUrl, sqlBorrar(nombre)));
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
      const borrado = await ejecutar(argsSql(adminUrl, sqlBorrar(nombre)));
      if (borrado.code !== 0) {
        throw new Error(`No se pudo eliminar la base '${nombre}': ${(borrado.stderr || '').trim()}`);
      }
    }

    return { env: { [exportAs]: urlExportada }, liberar };
  }

  return { definicion: { ...definicion }, provisionar };
}
