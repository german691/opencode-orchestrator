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

1. Concurrencia configurable (global por defecto 8 con `ORQ_CONCURRENCY`; por repo 3 con `perfil.concurrency`) con **aislamiento por trabajo**.
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
    "integracion": "cd backend && npx vitest run --config vitest.integracion.config.ts"
  }
}
```

El servidor valida el perfil (versión, tipos, rutas relativas, patrones válidos) y rechaza
perfiles inválidos con un mensaje claro. Sin perfil, se usan valores seguros por defecto
(worktrees en `~/work/<repo>`, sin recursos, aceptación vacía).

Secciones opcionales de retención y logs: `logs.maxBytes` acota cada archivo de log de un
trabajo (1 MB a 200 MB; por defecto 20 MB) y `retencion.dias` / `retencion.maxEnMemoria`
definen cuántos días se conservan los logs pesados de trabajos terminados (por defecto 30) y
cuántos trabajos carga el gestor en memoria al arrancar (por defecto 500; los activos siempre
se cargan). Los que quedan solo en disco no se listan en `opencode_list` y este los cuenta al
final para que el orquestador sepa que puede leerlos con `opencode_logs <id>`.

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
- Concurrencia: tope **global** configurable con `ORQ_CONCURRENCY` (1 a 16; el servidor usa 8 si no
  se define, igual que `DEFECTOS.concurrencia` del gestor) y tope **por repo** = `perfil.concurrency`
  (1 a 8, por defecto 3). El planificador aplica ambos a la vez:
  nunca arranca más de los que permiten el global y el del repo; el motivo reportado es `tope_global`
  (gana si los dos están llenos) o `tope_del_repo`.
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
| `opencode_batch` | Encola 1 a 12 tareas (campos de `coding`) en una llamada; una línea por trabajo |
| `opencode_status` | Tabla compacta: contadores, activos y `succeeded` sin integrar |
| `opencode_wait` | Espera hasta ~45 s a un trabajo |
| `opencode_wait_any` | Espera hasta ~45 s a que termine alguno de varios |
| `opencode_list` | Lista trabajos (estado, edad, título, alcance, cola y recursos ocupados) |
| `opencode_logs` | Final de stdout, stderr, events o aceptacion de un trabajo (`bytes`), también mientras corre |
| `opencode_cancel` | Cancela un trabajo (mata el grupo de procesos) |
| `opencode_merge` | Integra un trabajo `succeeded` en la rama de integración |
| `opencode_cleanup` | Elimina worktrees, ramas y recursos de trabajos terminados |
| `opencode_profile` | Muestra y valida el perfil resuelto de un repo |
| `opencode_board_get` | Lee el pizarrón compartido (claves vigentes y notas) |
| `opencode_board_post` | Publica una clave en el pizarrón; no pisa la de otro salvo `forzar` |

Detalle completo en [`docs/HERRAMIENTAS.md`](HERRAMIENTAS.md).

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

## 15. Estado de implementación (v3.0.0-dev)

Implementado y probado: planificador con bloqueos de alcance y topes por repo, runner con grupo de procesos,
worktrees git con cerrojo por repo, almacén persistente con identidad de proceso y bloqueo de instancia, adaptador
de opencode con configuración de agente por trabajo (`OPENCODE_CONFIG`), recursos `postgres-db`, gestor con el
ciclo de vida completo (verificación de alcance, aceptación, commit de lo verificado, integración, limpieza,
cierre), servidor MCP con las **13 herramientas** y panel en vivo de solo lectura.

Decisiones de implementación que se apartan del texto original:

- El comando de aceptación es estático (sin `{files}`): el perfil lo declara completo. También admite la
  compuerta en fragmentos (`{ paralelo }`, §21).
- El commit del trabajo incluye **solo los archivos verificados** contra el alcance; los artefactos que genere la
  aceptación quedan sin commitear.
- Un trabajo `isolation: none` no produce rama ni commit; los archivos ya modificados antes de empezar no cuentan
  como violación si no cambian durante el trabajo.
- `opencode_cleanup` y `opencode_merge` operan sobre trabajos terminados; `limpiar` no borra el registro.
- Fase 3 implementada además: mutaciones con restauración verificada (§19), reanudación automática (§20),
  revisor automático (§22), pizarrón (§23), recetas y lotes (§24), autointegración (§25) y `concurrency` por perfil.

## 16. Seguridad: decisiones y limitaciones conocidas

Decisiones (con su test):

- **Credenciales de administración fuera del agente.** La URL de administración de Postgres (`adminUrlEnv`,
  `ORQ_PG_ADMIN_URL`) solo la usa el gestor para provisionar; se quita del entorno de los trabajos. El trabajo
  recibe únicamente la URL de SU base (`exportAs`). Sin esto un agente con shell podría saltarse la barrera de
  nombres `_test` y borrar una base real.
- **`psql` recibe la conexión por variables `PG*`, no por argumentos**: la contraseña no aparece en
  `/proc/<pid>/cmdline`. Los mensajes de error nunca contienen la URL.
- **Protegidos sin distinguir mayúsculas.** El repo real puede vivir en un sistema de archivos que no las
  distingue (drvfs de Windows) mientras el worktree está en ext4; `Backend/prisma/MIGRATIONS/x` debe contar
  como protegido. Los `writes` sí distinguen (más estricto).
- **`external_directory: deny`** en `safe` y `readonly` (medido: no rompe leer a través de enlaces simbólicos ni los
  comandos relativos).
- **Advertencia por cambios en el árbol real** durante un trabajo aislado (archivos o `HEAD`): el agente pudo salir
  del worktree. Es una advertencia, no un rechazo (una edición manual produce lo mismo).
- **Perfil validado**: `name` es un segmento de ruta seguro, `worktrees.root` absoluta (o `~`) sin `..`, ramas sin
  los caracteres que git rechaza, patrones válidos, `postgres-db` solo con nombre `*_test`.
- **Un solo servidor por directorio de estado** y reconciliación segura tras una caída (identidad del proceso).
- **El MCP v2 dejaba sesiones vivas** porque ejecutaba `opencode run` contra el servicio compartido: un corte por
  tiempo mataba al cliente pero la sesión seguía editando archivos. La v3 usa `--standalone` (un servidor privado
  por trabajo, que muere con su grupo de procesos).

Limitaciones conocidas (no resueltas):

- **El shell del agente puede escribir donde quiera** (`echo > ruta`): las reglas `edit` del agente reducen el
  riesgo, pero la garantía real es la verificación del `git diff` y la advertencia por cambios en el árbol real.
  Un agente podría escribir **fuera** del repo y de su worktree (p. ej. en `$HOME`); no hay forma de detectarlo
  sin un sandbox de sistema de archivos.
- **Archivos ignorados por `.gitignore`** que el agente cree dentro del worktree no aparecen en el diff (ni se
  commitean); son inofensivos para la rama pero existen en el disco hasta `opencode_cleanup`.
- **`link` comparte directorios con el repo real** (p. ej. `node_modules`): un `npm install` dentro del trabajo
  modifica el original. Usar `setup` (`npm ci`) para dependencias propias si la tarea toca dependencias.
- **El perfil del repo ejecuta comandos** (`setup`, `accept`): se confía en el repo objetivo igual que en sus
  scripts de `npm`. No usar el orquestador sobre repositorios no confiables.
- **Los trabajos en cola no sobreviven a un reinicio** (pasan a `lost`).

## 17. Mejoras de la sesión 2026-10-08 (trabajo encadenado)

Surgieron de ejecutar ~20 trabajos dependientes sobre el mismo repo:

- **Motivo de espera visible**: el planificador devuelve `esperas` (dependencia, concurrencia,
  recurso, solapa_alcance, veterano_adelante + ids que frenan) y el gestor lo guarda en
  `job.espera`; lo muestran `opencode_list`, `STILL RUNNING` y el panel.
- **`writes` vs `protected` al enviar**: `escriturasEnRutaProtegida` rechaza al instante un
  `writes` que cae dentro de una ruta protegida (antes se descubría tras una corrida completa).
  Para permitir migraciones NUEVAS sin abrir el historial, el perfil protege cada migración
  existente por nombre y no la carpeta entera.
- **`jobBase: "integracion"`** (perfil): los worktrees parten de la rama de integración, ya
  sincronizada con la base, así un trabajo ve lo integrado antes aunque la base no haya
  avanzado. Si no se puede sincronizar (conflicto, árbol sucio) cae a la base y deja un evento.
- **Sincronización base → integración**: `integrar` hace primero `merge base` DENTRO de la
  integración (nunca al revés), de modo que lo commiteado directo en la base no deja la
  integración atrás y la base se puede avanzar con fast-forward.
- **`opencode_merge avanzar_base`** (opt-in): avanza la base a la integración con `--ff-only`,
  solo si el árbol real está en la base y sin cambios sin commitear; si no, la integración
  queda hecha y se explica el motivo. Sigue sin haber `push`.
- **`promptPrefix` y `timeoutMs` por perfil**: texto fijo del proyecto antepuesto a cada tarea y
  tope total por defecto (p. ej. 1 h para backend). El encabezado del agente ahora manda
  detenerse y reportar (no esquivar) ante un archivo fuera de `writes`.

### Segunda tanda (misma sesión)

- **Compuerta sobre la integración**: `opencode_coding` con `solo_aceptacion: true` no corre al agente, solo la `accept` sobre un worktree (con `base: "integracion"` mide la rama de integración). Así cada trabajo corre una aceptación liviana y la suite completa corre UNA vez por tanda.
- **Retomar un trabajo**: `desde_job: <id>` crea un worktree desde el mismo commit base, copia los archivos que dejó el trabajo rechazado/fallido/caído (si conserva su worktree) y hereda `writes`, `resources` y `accept`; con `solo_aceptacion` repite solo la aceptación, sin ella el agente continúa con el nuevo prompt.
- **`opencode_wait_any([ids])`**: espera ~45 s a que termine alguno y devuelve terminados + activos, en vez de sondear de a uno.
- **Vigilancia de alcance en vivo**: cada 30 s (`vigilanciaAlcanceMs`) se revisa el diff del worktree; si el agente persiste fuera de `writes`/protegidos en dos revisiones seguidas, se lo detiene y el trabajo queda `rejected` (`motivoFin: alcance`, proceso `detenido_por_alcance`) en vez de rechazarse recién al final.

Pendientes: avisos activos de fin de trabajo (hoy hay que preguntar), y limpieza automática de worktrees tras integrar.

### Cliente de Prisma por trabajo (`worktrees.linkConCopia`)

Con `node_modules` enlazado una sola vez, un `prisma generate` dentro de un worktree reescribía
`node_modules/.prisma/client` del repo real: pisaba el cliente de todos los trabajos en curso y el
de los servicios en vivo (se vio al correr lotes que cambian el esquema en paralelo). El perfil
puede declarar `worktrees.linkConCopia: [{ "dir": "backend/node_modules", "copiar": [".prisma", "@prisma/client"] }]`:
el `node_modules` del worktree es un directorio real con un enlace por cada entrada del original,
salvo lo listado en `copiar`, que se copia y queda propio del trabajo. Un dir no puede estar a la
vez en `link` y en `linkConCopia`.

### Corte por falta de progreso (`sinProgresoMs`)

Un agente puede pasarse mucho tiempo "explorando" (leer, buscar) sin escribir nada (se vio en vivo:
21 minutos y cero archivos). El vigilante de alcance (revisa el diff cada 30 s) ahora también corta al
agente si en `sinProgresoMs` (perfil; por defecto 10 min; `0` = sin límite) todavía no hay NINGÚN cambio
propio en el worktree. El trabajo termina `failed` con `motivoFin: sin_progreso` y una advertencia que
explica cómo relanzar (prompt acotado con archivos y líneas exactas; `desde_job` no sirve: no hay nada
que retomar). No aplica a `readonly` ni a `solo_aceptacion`. Además el encabezado del agente le pide
acotar la exploración. Recomendación de uso: ante una tarea transversal, buscar primero los lugares
exactos (grep) y darlos en el prompt.

## 18. Registro de eventos (`eventos.jsonl`)

**Problema observado.** Al correr ~20 trabajos encadenados no había forma de reconstruir qué pasó
(si un trabajo se frenó por concurrencia, por recursos o por un alcance solapado) sin leer los logs de
cada trabajo; y el panel necesitaba una fuente estable para mostrar auditoría.

**Decisión.** Un registro global append-only (`<ORQ_STATE_DIR>/eventos.jsonl`) separado del `audit.log`
y de los `events.jsonl` por trabajo. Cada línea es un `{ ts, tipo, jobId?, estado?, anterior?, motivo?,
detalle?, actor }`; `detalle` se trunca a 4 KB y el tipo se valida contra una lista cerrada
(`src/core/eventos.js`). El registro **nunca lanza por fallo de E/S**: la observabilidad no puede frenar
la operación auditada.

Tipos: `servidor.arranque`, `servidor.recuperacion`, `job.creado`, `job.estado`, `job.espera`,
`job.fin`, `job.reintento`, `job.reanudado`, `job.cancelado`, `job.mutaciones`, `job.revision`,
`merge`, `avanzar_base`, `cleanup`, `pizarron.post`. El gestor registra cada transición una sola vez
(centralizado en `#guardar`), el motivo de espera solo cuando cambia, y el registro se rota a un único
respaldo `eventos.1.jsonl` al pasar 5 MB.

## 19. Mutaciones del servidor (`.orq/mutaciones.json`)

**Problema observado.** Los agentes mutaban un archivo a mano (romperlo) para comprobar que un test
falla, y lo restauraban ellos; si el proceso moría a mitad, el archivo quedaba mutado y el commit
incluía la mutación.

**Decisión.** El agente **declara** la mutación en `<worktree>/.orq/mutaciones.json`
(`{ archivo, buscar, reemplazar, comando }`, hasta 20). El servidor la aplica byte a byte (Buffer, para
no tocar CRLF ni binarios), corre el comando en el worktree con el mismo entorno de la aceptación y
**restaura siempre** el original en un `finally`, verificando por sha256 (reintenta una vez y, si no
puede, falla con `RESTAURACION_FALLIDA` y el trabajo nunca se commitea). Una mutación se considera
**detectada** cuando el comando sale distinto de 0 (o expira): un test que pasa tras la mutación no la
detecta. `.orq/` está en el exclude de git y `validarArchivo` resuelve el `realpath` para que ningún
enlace simbólico permita mutar fuera del worktree.

Campo del perfil: `mutaciones.habilitado` (por defecto `true`), `mutaciones.exigirTodas` (por defecto
`false`; si es `true`, una sola mutación no detectada deja el trabajo `rejected`) y
`mutaciones.timeoutMs` (por defecto 300000).

## 20. Reanudación automática ante corte de transporte

**Problema observado.** En vivo los agentes opencode morían a los 10-16 min con
`Error: Transport: The socket connection was closed unexpectedly` (exit 130 o corte por idle), casi
siempre **después** de escribir lo suyo mientras corrían tests largos; el orquestador humano retomaba a
mano con `desde_job` + `solo_aceptacion`.

**Decisión.** `src/core/reanudacion.js` (lógica pura) reconoce las firmas de transporte en la **cola**
de stderr/stdout (`Transport: The socket...`, `socket hang up`, `ECONNRESET`, `fetch failed`,
`UND_ERR_SOCKET`, `other side closed`), exige salida anormal y descarta los cortes deliberados
(`timeout`, `cancelado`, `alcance`, `sin_progreso`). Decide `continuar` si el agente ya dejó cambios en
alcance (se verifica y acepta lo que hay, sin gastar otro intento), `relanzar` si no dejó nada y quedan
intentos, o `ninguna`. El perfil lo regula con `reanudacion.habilitado` (por defecto `true`) y
`reanudacion.maxRelanzamientos` (0 a 3; por defecto 1). La decisión queda como advertencia en el
resultado y como evento (`job.reanudado` / `job.reintento`).

## 21. Compuerta en fragmentos (`accept.paralelo`)

**Problema observado.** La suite de integración tardaba 10 min (y, corrida en serie sobre cada trabajo
de una tanda, 13-15 min de cuello de botella). Partirla a mano no resolvía el aislamiento: cada
fragmento necesitaba su propia base de datos.

**Decisión.** Una `accept` puede declararse como `{ "paralelo": { "shards": N, "comando": "... {i} ...",
"recurso": "db" } }` (`src/core/paralelo.js`). Se lanzan los N fragmentos **a la vez**, cada uno con
`{i}` (índice 1..N) y `{n}` (total); el comando debe incluir `{i}` o todos correrían lo mismo. Si
declara `recurso`, se provisiona **una instancia por fragmento** (base `postgres-db` cuyo `name` debe
contener `{shard}`) y se libera **siempre** en `finally`, aunque el fragmento falle. Por defecto un
fragmento fallido NO cancela a los demás (se quieren todos los errores); `cortarAlPrimerFallo: true` los
corta. La salida combinada pone primero los fallidos y recorta la cola de cada uno; `shards` va de 2 a 8.
El trabajo consume el recurso por fragmento, no como instancia única.

## 22. Revisor automático

**Problema observado.** Un trabajo `safe` podía pasar alcance y aceptación y aun así no cumplir lo
pedido o no dejar tests que fallen al revertir.

**Decisión.** Un agente interno de **solo lectura** recomienda APROBAR/OBSERVAR contrastando el diff con
la tarea y las reglas del proyecto (`src/core/revisor.js`). Corre **secuencialmente** después de la
aceptación (no ocupa cupo de la cola), en el mismo worktree, con tope de 5 min, y es **best-effort**:
un fail/timeout/respuesta ilegible queda `INDETERMINADO` con advertencia y **nunca** tumba el trabajo.
El prompt siempre lleva tarea, alcance, archivos, diff, reglas y el formato exigido
(`VEREDICTO: APRUEBA|OBSERVA` + hasta 5 observaciones); una `revisor.prompt` del perfil solo reemplaza
el encabezado. Se configura con `revisor.habilitado` (por defecto `false`), `revisor.modelo`,
`revisor.maxDiffBytes` (5 KB a 300 KB; por defecto 60000), `revisor.reglas` y `revisor.prompt`. El
resultado se guarda en `resultado.revision` y como evento `job.revision`.

## 23. Pizarrón compartido

**Problema observado.** Varios agentes del mismo repo definían contratos (rutas de API, formatos)
incompatibles entre sí porque no se veían.

**Decisión.** Un documento vivo `<ORQ_STATE_DIR>/pizarron.json` al que los agentes **leen** por un
symlink de solo lectura `.orq/pizarron.json` y al que **aportan** escribiendo su propio
`.orq/aporte.json` (`{ entradas: [{ clave, valor, nota }], notas: [...] }`). El proceso servidor es el
único que escribe el archivo vivo, de forma síncrona y atómica (tmp + rename); cada worktree recibe el
symlink con el archivo ya materializado. Una clave nueva se crea, la del **mismo** trabajo se actualiza
con historial, y la de **otro** trabajo NO se pisa: se registra como `conflicto` (salvo `forzar`). El
aporte se fusiona al vuelo (el vigilante cada 30 s) y al terminar el trabajo, con un tope
`pizarron.maxEntradasPorTrabajo` (1 a 1000; por defecto 30). El pizarrón es **opt-in**
(`pizarron.habilitado`, por defecto `false`): activarlo crea el symlink y suma instrucciones al prompt.
Las herramientas `opencode_board_get` / `opencode_board_post` lo exponen al orquestador (el orquestador
publica como `jobId: "orquestador"`).

## 24. Recetas y lotes

**Problema observado.** El orquestador repetía el mismo prompt y el mismo alcance en cada llamada de una
tanda.

**Decisión.** El perfil declara `recetas.<nombre>` (plantillas con `{param}` en `prompt` y `writes`); el
envío usa `receta: <nombre>` + `params` y los campos explícitos pisan a la receta (el `prompt` de la
llamada se agrega como «Notas adicionales»). Los valores que entran en `writes` no admiten saltos de
línea, `..` ni rutas absolutas (validado antes de encolar); cada placeholder debe estar definido y no
puede quedar ninguno sin resolver. `opencode_batch` encola de 1 a 12 tareas (mismos campos que
`opencode_coding`, incluidas `receta`/`params`) en una sola llamada y devuelve una línea por trabajo
(`<id> | <título> | <estado> | <motivo de espera>`); una tarea inválida no impide las demás.

## 25. Autointegración y espera de integración

**Problema observado.** Dos cosas distintas, ambas de "partir de una base desactualizada": (a) tener que
llamar `opencode_merge` trabajo por trabajo; (b) un trabajo que arranca justo cuando otro `succeeded`
solapa sus `writes` y descubre el conflicto recién al integrar.

**Decisión.**

- `autoIntegrar` (opt-in, por defecto apagado): un trabajo `safe` `succeeded` con commit se integra solo
  reutilizando `integrar` (nunca avanza la base). `requiereRevisor` exige veredicto `APRUEBA`;
  `soloSinAdvertencias` (por defecto `true`) omite la integración si hay advertencias. Ante conflicto
  queda `succeeded` con una advertencia y el motivo.
- `esperarIntegracion` (bool, por defecto `false`): el planificador no arranca un trabajo mientras haya
  un `succeeded` del mismo repo **sin integrar** que solape sus `writes`; queda en cola con motivo
  `esperando_integracion` y arranca al integrarse (o al llamar `opencode_merge`).
- `jobBase: "base" | "integracion"` (por defecto `base`): con `integracion`, el worktree parte de la
  rama de integración ya sincronizada con la base, así ve lo integrado antes aunque la base no haya
  avanzado. Si no se puede sincronizar (conflicto, árbol sucio) cae a la base y deja un evento.

## 26. Salida compacta y `completo: true`

**Problema observado.** Un trabajo de una hora devolvía una salida enorme al contexto del orquestador.

**Decisión.** `src/mcp/formato.js` recorta por defecto: 40 líneas de stdout, 15 de stderr, 40 de
aceptación (con las líneas de fallo primero y los subtests `ok` omitidos), hasta 40 archivos, valores
del pizarrón a 200 caracteres y 25 líneas en `opencode_status`; la cola de stdout se pide en 1500 bytes.
Siempre queda el aviso de cuánto se omitió y la invitación a `opencode_logs`. `completo: true` (acepta
también `"true"`, por clientes con el esquema en caché) desactiva los topes y pide hasta 100000 bytes.

## 27. Límites y retención de logs

Implementado en el almacén y el registro:

- `audit.log` global: se rota a un único `audit.log.1` al llegar a 5 MB y el `prompt` se guarda
  recortado a 120 caracteres (§11).
- `eventos.jsonl` global: se rota a `eventos.1.jsonl` al llegar a 5 MB; cada `detalle` se trunca a 4 KB.
- Por trabajo: `stdout.log` / `stderr.log` / `events.jsonl` no se rotan, pero todo lo que se **devuelve**
  al orquestador o al panel se lee por la cola (`leerCola`/`leerRango`) con topes.
- El panel lee logs por rangos de hasta 64 KB por pedido y recorta el diff a 400 KB y el detalle a 64 KB.
- `opencode_logs` acota `bytes` a 4000 por defecto y 100000 como máximo.
- El tope por archivo es configurable con `logs.maxBytes` (perfil; por defecto 20 MB) y la purga de
  logs pesados con `retencion.dias` (por defecto 30); `retencion.maxEnMemoria` (por defecto 500) es
  cuántos trabajos carga el gestor en memoria.
- `limpiarTemporales` borra temporales huérfanos con más de 1 h; `opencode_cleanup` borra los worktrees
  terminados, no el registro.

## 28. Panel en vivo (solo lectura)

**Problema observado.** No había forma de mirar en vivo si un agente avanzaba o estaba atascado sin
interferir con el orquestador.

**Decisión.** Un servidor HTTP aparte (`node src/panel.js`, puerto 7480) que **solo lee** los mismos
archivos del estado (`job.json`, logs, `eventos.jsonl`, `pizarron.json`); nunca escribe, no toma el lock
y no comparte proceso con el MCP. Atiende solo `GET`/`HEAD`, con CSP estricta sin código en línea.

Rutas: `/` (lista + detalle con pestañas Resumen, Consola, Diff, Alcance, Eventos),
`/auditoria` (tabla de `eventos.jsonl` con filtros), `/pizarron`, y la API `/api/trabajos`,
`/api/trabajos/:id`, `/api/eventos`, `/api/estado`, `/api/trabajos/:id/{log,diff,alcance,eventos}`,
`/api/pizarron`, `/api/stream` (SSE). El `log` se lee por rangos de bytes (`fuente=agente|aceptacion|stderr`
y `desde`/`limite`); el `diff` usa `git diff` sin shell y con `safe.directory` acotado al trabajo; el
`alcance` resume `writes`, archivos tocados y cuáles quedaron fuera.

Atajos: `j`/`k` (siguiente/anterior), `/` (buscar), `1`–`5` (pestañas), `f` (seguir/pausar consola),
`?` (ayuda). Accesibilidad: enlace «Saltar al contenido», `role="tablist"`/`tabpanel`, regiones
`aria-live`, y estados con texto + ícono (nunca solo color). No tiene autenticación: escucha en loopback
y se niega a salir de él salvo `ORQ_PANEL_ALLOW_REMOTE=1`.
