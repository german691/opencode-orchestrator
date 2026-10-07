# opencode-orchestrator — diseño

Servidor MCP (stdio) que permite a un orquestador (Claude) delegar trabajo de código a
**varias instancias de opencode en paralelo**, sin que se pisen entre sí y con garantías
verificables sobre qué archivos puede tocar cada una.

Estado: especificación para la v3. Reemplaza al `server.js` único de la v2 (serializado,
un solo árbol, sin tests).

## 1. Hallazgos que fijan el diseño (Fase 0, medidos)

| Hecho | Consecuencia |
| --- | --- |
| opencode v2.0.24 instalado **dentro de WSL** funciona nativo; sus credenciales se heredan de Windows con `opencode auth export \| opencode auth import` por tubería (sin archivo intermedio) | El MCP corre en Linux. Windows solo reenvía stdio (`wsl.exe -d Debian -- node ...`) |
| 3 corridas `opencode run --standalone` simultáneas, cada una en su directorio, terminan bien (17 s en total contra ~40 s en serie) | El paralelismo es viable; el tope lo ponen cuota y recursos, no opencode |
| `opencode run` sin flags usa un **servicio en segundo plano compartido**; `--standalone` levanta un servidor privado | Usar `--standalone` por trabajo: aislamiento total y cancelación limpia |
| `setsid` + `kill -TERM -<pgid>` mata a opencode **y a todos sus hijos** (probado con un `sleep`) | Cada trabajo corre en su propio grupo de procesos; cancelar = matar el grupo |
| El kill de la v2 mataba a opencode pero dejaba vivo el `vitest` que este había lanzado | Es el bug que motivó el rediseño |
| Los clientes MCP de escritorio cancelan una llamada a los ~60 s | Ninguna llamada bloquea más de ~45 s; el resto es asíncrono por `job_id` |

## 2. Objetivos y no-objetivos

Objetivos:

1. Concurrencia configurable (por defecto 3) con **aislamiento por trabajo**.
2. **Alcance declarado y verificado**: cada trabajo declara qué puede leer y escribir; el
   servidor lo hace cumplir mirando el `git diff`, no confiando en el modelo.
3. Entornos de desarrollo reproducibles descritos en un **perfil por repo**.
4. Ciclo de vida robusto: sin procesos huérfanos, timeout por inactividad, logs, recuperación tras reinicio.
5. Integración de resultados controlada (rama de integración).
6. Compatibilidad con la API de la v2 (`opencode_coding`, `opencode_wait`, `opencode_cancel`).

No-objetivos (por ahora): UI web, multi-máquina, soportar otros agentes distintos de opencode,
escribir código por sí mismo (solo orquesta).

## 3. Modelo de trabajo (job)

Estados: `queued → provisioning → running → verifying → succeeded`, o terminan en
`failed`, `cancelled`, `rejected` (violó el alcance o falló la aceptación) o `lost`
(el servidor se reinició y el proceso ya no existe). `merged` es un estado posterior de un
trabajo `succeeded`.

Especificación de un trabajo (entrada de `opencode_coding`):

| Campo | Tipo | Significado |
| --- | --- | --- |
| `prompt` | string | Instrucciones completas (opencode no tiene memoria) |
| `cwd` | string | Ruta del repositorio (o subcarpeta); se resuelve su raíz git y su perfil |
| `mode` | `readonly`\|`safe`\|`auto` | Permisos de opencode (agentes `coder-readonly`, `coder`, sin agente) |
| `isolation` | `worktree`\|`none` | `worktree` (por defecto en `safe`/`auto`): copia aislada en rama `job/<id>`. `none`: trabaja en el árbol real (solo lectura o trabajos que lo exijan; toma bloqueos) |
| `reads` | string[] | Patrones que puede leer (por defecto `**`). Informativo para el planificador y para el prompt |
| `writes` | string[] | Patrones que **puede escribir**. Obligatorio si `mode != readonly`. `readonly` fuerza `[]` |
| `resources` | string[] | Recursos exclusivos del perfil que necesita (por ejemplo `db`) |
| `accept` | string | Clave o comando de aceptación (del perfil o literal) que se corre al terminar |
| `after` | string[] | `job_id` previos que deben estar `succeeded` |
| `timeout_ms` / `idle_timeout_ms` | number | Tope total y tope sin salida (por defecto 25 min / 5 min) |
| `files` | string[] | Archivos a adjuntar |
| `title` | string | Etiqueta corta para listados |

Resultado (estructurado, además del texto): `id, status, exit, duration_ms, queued_ms,
files_changed[], diffstat, scope_violations[], accept{cmd, exit, tail}, branch, worktree,
log_tail`.

## 4. Alcance (scope)

- Glob mínimo sin dependencias: `**`, `*`, `?`, rutas relativas a la raíz del repo con `/`.
- `writes` define la lista de permitidos. El perfil define `protected` (siempre prohibido,
  gana sobre `writes`): por ejemplo migraciones aplicadas, `.env`, el propio perfil.
- **Verificación posterior** (la garantía real): al terminar la corrida, `git status --porcelain`
  + `git diff --name-only <base>` del worktree. Todo archivo cambiado, creado o borrado
  que no coincida con `writes`, o que coincida con `protected`, es una violación:
  el trabajo pasa a `rejected`, **no se integra**, y el resultado lista las violaciones.
- Además se le entrega a opencode un agente generado con permisos de edición acotados
  a `writes` (mejor esfuerzo; el modelo puede ignorarlo, la verificación no).
- `readonly`: cualquier cambio en el árbol es una violación.

## 5. Planificador y bloqueos

- Cola FIFO con prioridad opcional; ejecuta mientras `corriendo < concurrencia`.
- Un trabajo es **elegible** si sus `after` están `succeeded` y no entra en conflicto con los
  que corren:
  - `isolation: none` con `writes` toma bloqueos de escritura sobre esos patrones; choca con
    cualquier trabajo (con o sin aislamiento) que lea o escriba patrones superpuestos del
    **mismo repo**.
  - `isolation: worktree`: los trabajos no se ven entre sí, pero si sus `writes` se superponen se
    **serializan** (opción `serializeOverlappingWrites`, activa por defecto) para evitar
    conflictos al integrar.
  - `resources`: cada recurso con nombre es exclusivo, o con capacidad N (ver §7).
- Superposición de patrones (conservadora): se reduce cada patrón a su prefijo literal
  (la parte antes del primer comodín); se superponen si un prefijo es prefijo del otro.
  Puede serializar de más, nunca de menos.

## 6. Perfil del entorno

Archivo `.opencode-orchestrator.json` en la raíz del repo objetivo (versionado):

```json
{
  "version": 1,
  "name": "sistema",
  "baseBranch": "dev",
  "integrationBranch": "staging",
  "concurrency": 3,
  "protected": ["backend/prisma/migrations/**", "**/.env", ".opencode-orchestrator.json"],
  "worktrees": {
    "root": "~/work/{name}",
    "link": ["backend/node_modules", "frontend/node_modules"],
    "setup": []
  },
  "env": { "NODE_ENV": "test" },
  "resources": {
    "db": { "kind": "postgres-db", "adminUrlEnv": "ORQ_PG_ADMIN_URL", "template": "compras_test",
            "name": "compras_{job}_test", "exportAs": "TEST_DATABASE_URL" }
  },
  "accept": {
    "default": "cd backend && npm run lint",
    "unit": "cd backend && npm test",
    "integracion": "cd backend && npx vitest run --config vitest.integracion.config.ts {files}"
  }
}
```

El servidor valida el perfil (versión, tipos, rutas relativas, patrones válidos) y rechaza
perfiles inválidos con un mensaje claro. Sin perfil, se usan valores seguros por defecto
(worktrees en `~/work/<repo>`, sin recursos, aceptación vacía).

## 7. Aislamiento

- **Worktree por trabajo**: `git worktree add -b job/<id> <root>/<id> <baseBranch>`; se elimina al
  limpiar (`opencode_cleanup`) o por política tras N horas. `link` crea enlaces simbólicos
  (por ejemplo `node_modules`) para no reinstalar; `setup` corre comandos tras crear el worktree.
- **Recursos**: interfaz `provision(job) → {env}` / `release(job)`. Implementación inicial
  `postgres-db`: crea la base `compras_<job>_test` (nombre siempre terminado en `_test`),
  exporta su URL en la variable indicada y la elimina al liberar. Los trabajos que necesitan
  la base declaran `resources: ["db"]`.
- Variables de entorno del trabajo = entorno del perfil + las de los recursos + `ORQ_JOB_ID`,
  `ORQ_WORKTREE`, `ORQ_BRANCH`.

## 8. Ciclo de vida y proceso

- Cada trabajo = `spawn(opencode run --standalone ...)` con `detached: true` (grupo propio).
  Cancelar/expirar: `SIGTERM` al grupo, `SIGKILL` tras 5 s. Verificado que alcanza a los hijos.
- Timeouts: total y por inactividad (sin bytes en stdout/stderr).
- Estado persistente en `$ORQ_STATE_DIR` (por defecto `~/.local/state/opencode-orchestrator`):
  `jobs/<id>/job.json`, `stdout.log`, `stderr.log`, `events.jsonl`. Al arrancar, los trabajos
  `running` cuyo pid ya no existe pasan a `lost`; si el pid existe y es del servidor anterior,
  se mata su grupo (no se dejan huérfanos).
- Concurrencia por defecto 3 (`concurrency` del perfil o `ORQ_CONCURRENCY`).
- Registro de auditoría en `events.jsonl` por trabajo y `audit.log` global.

## 9. Integración

- `opencode_merge(job_id)`: exige `succeeded`, sin violaciones, aceptación en verde. Hace
  `git merge --no-ff job/<id>` sobre la rama `integrationBranch` en un worktree propio de
  integración. Si hay conflicto: aborta, deja la rama intacta y reporta los archivos en conflicto.
- El orquestador revisa `git diff baseBranch..integrationBranch` y **él** avanza la rama base.
  El servidor nunca escribe en `baseBranch` ni hace `push`.

## 10. Herramientas MCP

| Herramienta | Qué hace |
| --- | --- |
| `opencode_coding` | Encola un trabajo; espera hasta ~45 s; devuelve resultado o `STILL RUNNING` + `job_id` |
| `opencode_wait` | Espera hasta ~45 s a un trabajo |
| `opencode_list` | Lista trabajos (estado, edad, título, alcance, cola y recursos ocupados) |
| `opencode_logs` | Cola de stdout/stderr/eventos de un trabajo (`tail`, `stream`) |
| `opencode_cancel` | Cancela un trabajo (mata el grupo de procesos) |
| `opencode_merge` | Integra un trabajo `succeeded` en la rama de integración |
| `opencode_cleanup` | Elimina worktrees, ramas y recursos de trabajos terminados |
| `opencode_profile` | Muestra y valida el perfil resuelto de un repo |

## 11. Seguridad

- `readonly` y `safe` mantienen su semántica; `auto` solo por pedido explícito del usuario.
- Nunca se pasan secretos en prompts ni logs; los logs se truncan y no se vuelcan al cliente completos.
- Nunca `push`, nunca escritura en `baseBranch`, nunca `git reset --hard` ni `clean -fd` sobre el árbol real.
- Los recursos de base de datos solo operan sobre nombres que terminen en `_test`.
- Las rutas de `cwd`, `files` y `worktrees.root` se resuelven y validan (sin escapar de la raíz del repo).

## 12. Estrategia de pruebas

`node --test` (sin dependencias). Capas:

1. **Unitarias puras**: globs, superposición, planificador, validación de perfil, máquina de estados.
2. **Con procesos falsos**: un ejecutable `opencode` falso (script) parametrizable por entorno
   (escribe archivos, duerme, ignora `SIGTERM`, imprime N bytes) para probar runner, timeouts,
   kill de grupo e hijos huérfanos.
3. **Con repos git temporales**: worktrees, enlaces, verificación de alcance sobre diffs reales,
   merge con y sin conflicto.
4. **Protocolo**: el servidor real por stdio con mensajes JSON-RPC (initialize, tools/list,
   llamadas, cancelación del cliente).
5. Cada requisito de seguridad (alcance, protected, readonly, `_test`) tiene test que **falla
   si la guarda se quita** (mutación manual documentada en el PR).

## 13. Fases

- **Fase 1 (núcleo)**: repo + protocolo + runner (grupo de procesos, timeouts, logs, persistencia)
  + planificador con concurrencia + worktrees + perfil + herramientas `coding/wait/list/logs/cancel`.
- **Fase 2 (garantías)**: alcance verificado (`writes`/`protected`/`readonly`), recursos (`postgres-db`),
  `after`, `opencode_merge`, `opencode_cleanup`.
- **Fase 3 (productividad)**: plantillas de tarea, `opencode_mutate` (mutación automática con
  restauración garantizada), revisores de solo lectura en paralelo, métricas de consumo.

## 14. Hallazgos adicionales de la Fase 0 (medidos con opencode 2.0.24 en WSL)

| Hecho | Consecuencia en el diseño |
| --- | --- |
| Un archivo de configuración apuntado por **`OPENCODE_CONFIG`** se fusiona con la configuración global y admite agentes definidos en línea (`agent.<nombre>.permission`) | El agente de cada trabajo se genera como un JSON en el directorio de estado del trabajo y se pasa por `OPENCODE_CONFIG`: **no se escribe ningún archivo en el worktree** |
| **`OPENCODE_CONFIG_DIR` reemplaza** la configuración global (se perdió el modelo y cayó a otro proveedor) | No se usa jamás `OPENCODE_CONFIG_DIR` |
| Los permisos `edit` aceptan **patrones de ruta** (`"allowed/**": "allow"`) y opencode los respeta (rechaza lo demás) | `writes` se traduce a reglas `edit` del agente (mejor esfuerzo) |
| En las reglas de permiso **gana la ÚLTIMA que coincide**: `{"*":"deny","a/**":"allow","a/secreto/**":"deny"}` bloquea `a/secreto`, pero con el `deny` antes del `allow` no | Orden obligatorio del agente generado: `"*": deny`, luego `writes: allow`, y **al final `protected: deny`** |
| La edición por herramienta se puede acotar, pero un comando de shell (`echo > ruta`) podría escribir fuera de `writes` | Confirma que la **verificación posterior del `git diff`** (§4) es la garantía real y las reglas del agente solo reducen el riesgo |
| `--auto` aprueba lo no denegado explícitamente; lo denegado sigue denegado | Se usa `--auto` y toda restricción se expresa como `deny` explícito |
