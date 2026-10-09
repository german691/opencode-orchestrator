# Perfil del repositorio (`.opencode-orchestrator.json`)

Referencia completa del archivo de perfil versionado en la raíz del repo objetivo. El servidor lo carga
en cada trabajo (con caché por `mtime`) y lo valida de forma **estricta**: cualquier campo desconocido,
tipo incorrecto o patrón inválido hace fallar `opencode_profile` y el envío, acumulando **todos** los
errores con la ruta del campo. Sin archivo rigen los valores por defecto seguros.

- El archivo se parsea con `JSON.parse`: **no admite comentarios** ni comas finales.
- `opencode_profile` (herramienta MCP) muestra el perfil ya resuelto y validado de un `cwd`.
- El diseño y el porqué de cada sección están en [`DISENO.md`](DISENO.md); acá va la superficie.

## Claves de primer nivel

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `$schema` | string | — | Opcional, para editores. Se acepta y se ignora. |
| `version` | number | — (obligatorio) | Debe ser exactamente `1`. |
| `name` | string | — (obligatorio; si falta, el nombre del repo) | Segmento de ruta seguro (`[A-Za-z0-9_][A-Za-z0-9._-]{0,63}`): se usa en `~/work/{name}`. |
| `baseBranch` | string | `"main"` | Rama base; la base **nunca** se escribe desde el servidor. |
| `integrationBranch` | string | `"staging"` | Rama donde `opencode_merge` integra. |
| `concurrency` | integer 1..8 | `3` | Tope de trabajos simultáneos **de este repo** (además del global `ORQ_CONCURRENCY`). |
| `jobBase` | `"base"` \| `"integracion"` | `"base"` | Rama desde la que parte el worktree. `integracion` ve lo integrado antes. |
| `promptPrefix` | string (≤ 20000) | `""` | Texto fijo antepuesto a la tarea de cada trabajo (convenciones del proyecto). |
| `timeoutMs` | number: 1 min a 6 h | `null` | Tope total por defecto de un trabajo (`null` = 30 min del servidor). |
| `aceptacionTimeoutMs` | number: 1 min a 6 h | `null` | Tope de la aceptación (`null` = 10 min del servidor). |
| `sinProgresoMs` | `0` o number: 1 min a 6 h | `null` | Corte del agente sin escribir nada (`0` = sin límite; `null` = 10 min). |
| `protected` | string[] | `[]` (sin archivo: `["**/.env", ".opencode-orchestrator.json"]`) | Patrones siempre prohibidos (ganan sobre `writes`). |
| `worktrees` | object | ver abajo | `root`, `link`, `linkConCopia`, `setup`. |
| `env` | object | `{}` | Variables de entorno del trabajo (nombres válidos, valores string). |
| `resources` | object | `{}` | Recursos exclusivos por trabajo (hoy solo `postgres-db`). |
| `accept` | object | `{}` | Comandos de aceptación por clave, o compuertas `{ paralelo }`. |
| `reanudacion` | object | `{ "habilitado": true, "maxRelanzamientos": 1 }` | Política ante corte de transporte (`socket closed`). |
| `mutaciones` | object | `{ "habilitado": true, "exigirTodas": false, "timeoutMs": 300000 }` | Ejecución de `.orq/mutaciones.json`. |
| `pizarron` | object | `{ "habilitado": false, "maxEntradasPorTrabajo": 30 }` | Documento compartido entre agentes (opt-in). |
| `revisor` | object | `{ "habilitado": false, ... }` | Revisor automático de solo lectura (opt-in). |
| `recetas` | object | `{}` | Plantillas de tarea con parámetros. |
| `autoIntegrar` | object | `{ "habilitado": false, "requiereRevisor": false, "soloSinAdvertencias": true }` | Integración automática de trabajos `safe`. |
| `esperarIntegracion` | boolean | `false` | No arrancar si solapa `writes` con un `succeeded` sin integrar. |
| `logs` | object | `{ "maxBytes": 20971520 }` | Tope de tamaño por archivo de log de un trabajo. |
| `retencion` | object | `{ "dias": 30, "maxEnMemoria": 500 }` | Retención de logs pesados y de trabajos en memoria. |
| `autor` | `{ nombre, email }` \| null | `null` | Identidad git con la que se firman (autor **y** committer) los commits nuevos. `null` = `user.name`/`user.email` del repo y, si faltan, `opencode-orchestrator <orquestador@localhost>`. |

## `worktrees`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `root` | string | `"~/work/{name}"` | Directorio de los worktrees: absoluto o `~/...`, sin `..`. `{name}` se expande con `name`. |
| `link` | string[] | `[]` | Rutas relativas que se **enlazan** (p. ej. `node_modules`) para no reinstalar. |
| `linkConCopia` | `{ dir, copiar }[]` | `[]` | El `dir` del worktree es real y enlaza cada entrada salvo las de `copiar`, que se copian (p. ej. el cliente de Prisma). `dir` no puede estar también en `link`. |
| `setup` | string[] | `[]` | Comandos que corren al crear el worktree. |

## `resources.<nombre>`

Solo `kind: "postgres-db"`. Crea una base propia por trabajo y la borra al liberar.

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `kind` | `"postgres-db"` | — (obligatorio) | Único tipo soportado. |
| `adminUrlEnv` | variable de entorno | — (obligatorio) | Variable con la URL de administración (p. ej. `ORQ_PG_ADMIN_URL`). Solo la usa el gestor; se quita del entorno del trabajo. |
| `template` | string no vacío | — (opcional) | Base plantilla de la que clonar; sin él se crea una vacía. |
| `name` | string con `{job}` y terminada en `_test` | — (obligatorio) | Nombre de la base. Para recursos de una aceptación paralela debe contener además `{shard}`. |
| `exportAs` | variable de entorno | — (obligatorio) | Variable donde se exporta la URL de la base del trabajo. |

## `accept.<clave>`

Cada valor es un comando literal (string) o una **compuerta en fragmentos**:

```json
{ "paralelo": { "shards": 3, "comando": "npx vitest run --shard={i}/{n}", "recurso": "db", "timeoutMs": 900000, "cortarAlPrimerFallo": false } }
```

| Clave de `paralelo` | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `shards` | integer 2..8 | — (obligatorio) | Cantidad de fragmentos en paralelo. |
| `comando` | string con `{i}` | — (obligatorio) | Comando del fragmento; `{i}` (1..N) y `{n}` (total) se sustituyen. |
| `recurso` | string | — (opcional) | Recurso del perfil a provisionar **por fragmento** (debe ser `postgres-db` con `{shard}`). |
| `timeoutMs` | number > 0 | `aceptacionTimeoutMs` | Tope de cada fragmento. |
| `cortarAlPrimerFallo` | boolean | `false` | `true` deja de esperar al resto al primer fragmento fallido. |

`accept.default` es el que se corre tras cada trabajo no `readonly`; en `readonly` solo corre una
`accept` explícita.

## `reanudacion`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `habilitado` | boolean | `true` | Reanuda ante un corte de transporte. |
| `maxRelanzamientos` | integer 0..3 | `1` | Relanzamientos permitidos cuando el agente no dejó cambios. |

## `mutaciones`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `habilitado` | boolean | `true` | Ejecuta el manifiesto `.orq/mutaciones.json` si existe. |
| `exigirTodas` | boolean | `false` | Si es `true`, una mutación no detectada deja el trabajo `rejected`. |
| `timeoutMs` | number: 1 s a 1 h | `300000` | Tope de cada corrida de mutación. |

## `pizarron`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `habilitado` | boolean | `false` | Crea el symlink `.orq/pizarron.json` y suma instrucciones al prompt (opt-in). |
| `maxEntradasPorTrabajo` | integer 1..1000 | `30` | Tope de entradas del aporte de un trabajo que se fusiona. |

## `revisor`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `habilitado` | boolean | `false` | Lanza el revisor de solo lectura tras un `safe` exitoso (opt-in). |
| `modelo` | string no vacío | `null` | Modelo del revisor (`null` = el del trabajo). |
| `maxDiffBytes` | integer 5000..300000 | `60000` | Tope del diff incluido en el prompt. |
| `reglas` | string[] | `[]` | Reglas del proyecto para el revisor. |
| `prompt` | string no vacío | `null` | Reemplaza el encabezado de rol del prompt. |

## `recetas.<nombre>`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `descripcion` | string | — | Texto corto que muestra `opencode_profile`. |
| `prompt` | string con `{param}` | — (obligatorio) | Plantilla de la tarea. |
| `writes` | string[] | — | Patrones (pueden usar `{param}`; sin saltos, `..` ni rutas absolutas). |
| `reads` | string[] | — | Patrones de lectura. |
| `mode` | `readonly` \| `safe` \| `auto` | — | Modo por defecto de la receta. |
| `accept` | string u objeto `{ paralelo }` | — | Aceptación de la receta. |
| `resources` | string[] | — | Recursos que necesita. |
| `solo_aceptacion` | boolean | — | Si es `true`, la receta no corre al agente. |

## `autoIntegrar`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `habilitado` | boolean | `false` | Integra solo los trabajos `safe` `succeeded` con commit. |
| `requiereRevisor` | boolean | `false` | Exige veredicto `APRUEBA` para integrar. |
| `soloSinAdvertencias` | boolean | `true` | Omite la integración si el trabajo dejó advertencias. |

## `logs`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `maxBytes` | integer 1 MB..200 MB | `20971520` (20 MB) | Tope de cada archivo de log de un trabajo (`stdout`/`stderr`/aceptación). Al superarlo se compacta dejando cabeza y cola con un aviso de los bytes omitidos. |

## `retencion`

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `dias` | integer 1..3650 | `30` | Días que se conservan los logs pesados de trabajos terminados; después se purgan (queda `job.json`). |
| `maxEnMemoria` | integer 1..100000 | `500` | Trabajos que el gestor carga en memoria al arrancar (los activos siempre se cargan). Los más antiguos quedan solo en disco, se leen bajo demanda y `opencode_list` los cuenta al final. |

## Ejemplo completo comentado

> Los comentarios `//` son solo para explicar: el archivo real se parsea con `JSON.parse` y **no** los
> admite. Si copiás este ejemplo, quitálos (o guardalo como JSON válido).

```jsonc
{
  "version": 1,
  "name": "sistema",
  "baseBranch": "dev",                 // la base no se escribe nunca desde el servidor
  "integrationBranch": "staging",      // acá integra opencode_merge
  "concurrency": 3,                    // tope de trabajos simultáneos de ESTE repo
  "jobBase": "integracion",            // los worktrees parten de lo ya integrado
  "timeoutMs": 3600000,                // 1 h por trabajo (suites largas)
  "aceptacionTimeoutMs": 1200000,      // 20 min de aceptación
  "sinProgresoMs": 600000,             // corta al agente si no escribe en 10 min
  "promptPrefix": "Convenciones del repo: ...",
  "protected": [
    "backend/prisma/migrations/**",    // migraciones aplicadas: prohibidas
    "**/.env",
    ".opencode-orchestrator.json"
  ],
  "worktrees": {
    "root": "~/work/{name}",
    "link": ["frontend/node_modules"], // enlaces compartidos
    "linkConCopia": [
      { "dir": "backend/node_modules", "copiar": [".prisma", "@prisma/client"] }
    ],
    "setup": ["npm ci"]
  },
  "env": { "NODE_ENV": "test" },
  "resources": {
    "db": {
      "kind": "postgres-db",
      "adminUrlEnv": "ORQ_PG_ADMIN_URL", // solo la usa el gestor
      "template": "compras_test",
      "name": "compras_{job}_test",      // siempre *_test
      "exportAs": "TEST_DATABASE_URL"
    }
  },
  "accept": {
    "default": "cd backend && npm run lint",
    "unit": "cd backend && npm test",
    "integracion": {
      "paralelo": {
        "shards": 3,
        "comando": "cd backend && npx vitest run --shard={i}/{n}",
        "recurso": "db",                 // requiere name con {shard}
        "timeoutMs": 900000
      }
    }
  },
  "reanudacion": { "habilitado": true, "maxRelanzamientos": 1 },
  "mutaciones": { "habilitado": true, "exigirTodas": false, "timeoutMs": 300000 },
  "pizarron": { "habilitado": true, "maxEntradasPorTrabajo": 30 },
  "revisor": { "habilitado": true, "modelo": "opencode-go/deepseek-v4.1-flash", "maxDiffBytes": 60000, "reglas": ["No usar any"] },
  "recetas": {
    "tests de {modulo}": {
      "descripcion": "tests unitarios de un módulo",
      "prompt": "Escribí los tests de {modulo} ...",
      "writes": ["backend/src/{modulo}/**/*.test.ts"],
      "accept": "unit"
    }
  },
  "autoIntegrar": { "habilitado": false, "requiereRevisor": true, "soloSinAdvertencias": true },
  "esperarIntegracion": true,
  "logs": { "maxBytes": 20971520 },         // 20 MB por archivo de log
  "retencion": { "dias": 30, "maxEnMemoria": 500 }
}
```

Notas de compatibilidad:

- Si un `writes` de una receta o de un envío cae dentro de `protected`, el servidor lo rechaza **al
  enviar**, antes de gastar una corrida.
- Un `resources.<nombre>` usado por una aceptación paralela debe declarar `{shard}` en `name`; el resto
  de recursos deben declarar `{job}`.
- `name` del perfil no admite `/`, `..` ni empezar con punto o guion porque forma parte de una ruta.
