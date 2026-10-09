# Herramientas de opencode-orchestrator

Referencia completa de las herramientas MCP. El esquema que viaja al cliente
(`tools/list`) mantiene descripciones cortas para ahorrar contexto del orquestador;
este documento concentra el detalle, los matices y los ejemplos.

Reglas generales:

- Cada trabajo escribe en su propio `git worktree` y rama `job/<id>`. El servidor
  **verifica** el `git diff` al terminar: lo modificado fuera de `writes` (o en rutas
  `protected` del perfil) deja el trabajo `rejected` y sin commit.
- No hay `push` ni escritura en la rama base: la integración ocurre en la rama
  `integrationBranch` del perfil.
- Los `writes` son patrones glob relativos a la **raíz del repo**; en `mode: safe` son
  obligatorios.
- Las herramientas de espera bloquean hasta ~45 s (configurable con `ORQ_WAIT_MS`). Si
  un trabajo no termina responden `STILL RUNNING` con su `job_id`; seguí con
  `opencode_wait` o `opencode_wait_any`.
- Los mensajes y el pizarrón usan texto en español.

## `opencode_coding`

Delega una tarea de código a una instancia de opencode (DeepSeek) y espera hasta ~45 s.
Si no termina, devuelve `STILL RUNNING | job_id=…`; retomá con `opencode_wait`.

Parámetros:

- `prompt` (obligatorio salvo `solo_aceptacion`/`receta`): instrucciones completas y
  autocontenidas; opencode no ve esta conversación.
- `cwd` (obligatorio): ruta del repositorio o de una subcarpeta. Define el perfil y la
  raíz del worktree.
- `mode`: `readonly` (no escribe), `safe` (por defecto; exige `writes`), `auto` (solo
  opt-in explícito del usuario).
- `writes`: patrones glob que el trabajo puede modificar. Obligatorio en `safe`.
- `reads`: patrones que va a leer (informativo para el planificador). Por defecto todo.
- `isolation`: `worktree` (por defecto en `safe`/`auto`) o `none` (por defecto en
  `readonly`; trabaja en el árbol real).
- `resources`: recursos del perfil que necesita (p. ej. `["db"]` = una base de datos
  propia por trabajo).
- `accept`: comando de aceptación o clave del perfil (`accept.default`); si falla, el
  trabajo queda rechazado.
- `after`: `job_id` previos que deben estar `succeeded` antes de arrancar.
- `timeout_ms` / `idle_timeout_ms`: topes total y sin salida (por defecto 30 y 10 min).
- `files`: archivos a adjuntar al prompt.
- `title`: etiqueta corta para los listados.
- `model`: modelo `proveedor/modelo` (por defecto el del servidor).
- `prioridad`: mayor = antes en la cola.
- `base`: `base` (la base del perfil) o `integracion` (la rama de integración, con lo
  ya integrado). Por defecto, el `jobBase` del perfil.
- `solo_aceptacion`: no corre al agente; solo ejecuta `accept` sobre un worktree. Se usa
  como **compuerta** sobre la integración (con `base: "integracion"` y `accept` la suite
  completa) o para re-verificar un trabajo ya arreglado (con `desde_job`). No requiere
  `prompt` ni `writes`.
- `desde_job`: retoma un trabajo terminado (rechazado, fallido o caído) que conserve su
  worktree. El nuevo parte del mismo commit y recibe los archivos que dejó, y hereda su
  `writes`, `resources` y `accept`. Con `solo_aceptacion` solo repite la aceptación; sin
  ella el agente continúa con el nuevo `prompt`.
- `completo`: devuelve TODA la salida del agente y de la aceptación, sin recortar.
  Acepta `true` o `"true"`.
- `receta`: nombre de una receta del perfil. Su `prompt` (con `{param}`) y sus campos
  (`writes`, `mode`, `accept`, `resources`, `reads`) se expanden con `params`. Lo que
  pases explícito pisa a la receta, y `prompt` se agrega como «Notas adicionales».
- `params`: valores de los `{param}` de la receta. Cada valor es un texto; los que se
  usan en `writes` no admiten saltos de línea, `..` ni rutas absolutas.

Ejemplo:

```json
{
  "prompt": "Escribí los tests de X en backend/test-integracion/x.test.ts ...",
  "cwd": "C:/ruta/al/repo",
  "mode": "safe",
  "writes": ["backend/test-integracion/**"],
  "resources": ["db"],
  "accept": "unit",
  "title": "tests de X"
}
```

## `opencode_batch`

Encola varias tareas (1 a 12) en UNA sola llamada, cada una con los mismos campos que
`opencode_coding` (incluidos `receta` y `params`). No espera: devuelve una línea por
trabajo con el formato `<id> | <título> | <estado> | <motivo de espera>`. Si una tarea es
inválida, su error va en su propia línea sin impedir las demás. Después seguí con
`opencode_wait` / `opencode_wait_any`.

## `opencode_status`

Tabla compacta del estado del servidor: contadores (corriendo / en cola / verificando) y
una línea por trabajo ACTIVO o `succeeded` sin integrar
(`<id> | <estado> | <edad> | <título>`), más la lista de ids «sin integrar» para saber
qué falta mergear. Pensada para sondeo rápido.

## `opencode_wait`

Espera hasta ~45 s a un trabajo iniciado con `opencode_coding`. Devuelve el resultado si
terminó, o `STILL RUNNING` otra vez: repetí hasta que termine. `completo: true` recupera
toda la salida sin recortar.

## `opencode_wait_any`

Espera hasta ~45 s a que TERMINE alguno de varios trabajos y devuelve el resumen de los
que ya terminaron (con su detalle) y el estado de los que siguen activos. Evita sondear
uno por uno; repetí hasta que no quede ninguno activo. La explicación de que «no es un
error» se imprime UNA sola vez para todos los activos, no por trabajo.

## `opencode_list`

Lista los trabajos (estado, edad, modo, alcance) y la carga del servidor (corriendo y en
cola). Parámetros: `estado` (filtra) y `limite` (por defecto 20). Usala antes de
reenviar una tarea que parece no haber producido nada.

## `opencode_logs`

Final de la salida de un trabajo sin esperar a que termine. Canales: `stdout` (por
defecto), `stderr`, `events` y `aceptacion`. `bytes` acota cuántos bytes del final se
leen (por defecto 4000, máximo 100000). Sirve para ver el avance de un trabajo largo.

## `opencode_cancel`

Cancela un trabajo: si está en cola lo descarta; si corre, mata su grupo de procesos
completo (incluidos los comandos que lanzó). Es idempotente.

## `opencode_merge`

Integra un trabajo `succeeded` en la rama de integración del perfil (`git merge --no-ff`
dentro de un worktree propio). Ante conflicto aborta y lista los archivos; la rama de
integración queda intacta. Antes de integrar sincroniza la base DENTRO de la integración
(nunca al revés).

Por defecto NO toca la rama base ni hace push: revisá el diff `base..integración` y
avanzá la base vos. Con `avanzar_base: true` (opt-in) el servidor intenta avanzar la base
por fast-forward; si no se puede, la integración igual queda hecha y se explica el motivo.

## `opencode_cleanup`

Elimina los worktrees y ramas de trabajos terminados (no toca los activos ni borra su
registro). Parámetros: `job_ids` (solo esos) y `mas_viejos_que_minutos` (solo los
terminados hace más de N minutos).

## `opencode_profile`

Muestra y valida el perfil resuelto de un repositorio (`.opencode-orchestrator.json`):
rama base, rama de integración, rutas protegidas, `worktrees`, recursos, comandos de
aceptación, recetas, concurrencia y demás secciones. Parámetro: `cwd`.

## `opencode_board_get`

Lee el pizarrón compartido entre agentes (documento de contratos y decisiones). Sin
`clave`: devuelve la versión, la lista corta de claves con su valor vigente (truncado a
200 caracteres) y las últimas 5 notas. Con `clave`: el valor completo y su historial. El
pizarrón es de SOLO LECTURA para los agentes: ellos aportan en `.orq/aporte.json`.

## `opencode_board_post`

Publica una clave en el pizarrón compartido. El orquestador publica con `jobId`
«orquestador». `valor` es JSON o texto. Una clave de OTRO trabajo no se pisa por
accidente: devuelve conflicto salvo `forzar: true`. `nota` es opcional (hasta 500
caracteres); la clave debe ser corta (1-80) y sin espacios.
