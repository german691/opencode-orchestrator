# opencode-orchestrator

Servidor MCP (stdio) que permite a un orquestador (Claude) delegar trabajo de código a
**varias instancias de opencode en paralelo**, con aislamiento por trabajo, alcance de
archivos **declarado y verificado**, y un ciclo de vida sin procesos huérfanos.

- Diseño, decisiones y mediciones: [`docs/DISENO.md`](docs/DISENO.md)
- Referencia de la v2 (serializada, un solo árbol): [`legacy/server-v2.js`](legacy/server-v2.js)

## Qué garantiza

| Garantía | Cómo |
| --- | --- |
| Los trabajos no se pisan | Cada trabajo escribe en su propio `git worktree` y rama `job/<id>`; los que declaran `writes` superpuestos se serializan |
| Nada fuera de lo declarado llega a la rama | Al terminar se verifica el `git diff`: lo modificado fuera de `writes`, o en rutas `protected` del perfil, deja el trabajo **rechazado** y sin commit |
| Solo se commitea lo verificado | El commit incluye únicamente los archivos que pasaron el alcance (los artefactos de la aceptación quedan fuera) |
| La rama base nunca se toca | No hay `push` ni escritura en la base; `opencode_merge` integra en una rama aparte (`integrationBranch`) |
| Cancelar mata todo | Cada trabajo es líder de su grupo de procesos: cancelar, expirar o cerrar el servidor mata también a los comandos que lanzó |
| Una caída no deja huérfanos | Al arrancar se reconcilian los trabajos anteriores y se mata el grupo **solo si es verificablemente nuestro** (`boot_id` + inicio del proceso) |
| Un solo servidor por estado | Un bloqueo exclusivo impide que dos servidores se pisen |
| Un corte de transporte no pierde el trabajo | Si el agente muere por «socket closed» (exit 130, idle), con cambios ya escritos el servidor **continúa** (verifica y acepta lo que dejó) o **relanza** una vez (reanudación automática) |
| Las mutaciones se restauran siempre | El agente declara `.orq/mutaciones.json`; el servidor aplica el cambio, corre el comando y restaura el original verificando sha256 (el archivo nunca queda mutado) |
| El agente fuera de alcance se detiene en vivo | Cada 30 s se revisa el diff del worktree; si persiste fuera de `writes`/`protected` en dos revisiones seguidas, se lo corta y el trabajo queda `rejected` sin esperar al final |
| El pizarrón no se pisa | El servidor es el único que escribe `pizarron.json`; cada agente aporta en su `.orq/aporte.json` y pisar la clave de otro requiere `forzar` |
| La salida no inunda el contexto | Los resultados se recortan por líneas; `completo: true` recupera todo y `opencode_logs` consulta el resto |

## Requisitos

Debian/Ubuntu (WSL2 incluido) con Node 20+, git y opencode 2.x **instalado en Linux**
(`npm i -g @opencode/cli`). Las credenciales se heredan de Windows por tubería, sin archivo intermedio:

```powershell
cmd /c "opencode auth export 2>nul | wsl -d Debian -u root -- opencode auth import >nul 2>&1"
```

Copiá también `~/.config/opencode/opencode.jsonc` y `agent/` si querés los mismos modelos y agentes.

Si los repositorios viven en el disco de Windows (`/mnt/c/...`), git de Linux los ve con otro dueño
y responde «dubious ownership». Declaralos una sola vez como seguros (el servidor NO lo hace por
vos: relajar esa protección es una decisión del usuario):

```bash
git config --global --add safe.directory '/mnt/c/Users/<usuario>/Documents/GitHub/<repo>'
```

Las rutas de Windows (`C:\Users\...`, `C:/...`, `\\wsl$\Debian\...`) que lleguen en `cwd` o `files`
se traducen solas a rutas de Linux.

## Conexión desde Claude Desktop (el servidor corre dentro de WSL)

```json
"opencode-orchestrator": {
  "command": "wsl.exe",
  "args": ["-d", "Debian", "-u", "root", "--", "node",
           "/mnt/c/Users/<usuario>/Documents/GitHub/opencode-orchestrator/src/server.js"]
}
```

Variables opcionales (en `~/.config/opencode-orchestrator/env`, una `CLAVE=valor` por línea; no pisan
las del entorno):

| Variable | Efecto | Por defecto |
| --- | --- | --- |
| `ORQ_STATE_DIR` | Directorio de estado (trabajos, logs, `eventos.jsonl`, pizarrón) | `~/.local/state/opencode-orchestrator` |
| `ORQ_CONCURRENCY` | Tope **global** de trabajos simultáneos (1 a 16). Cada repo se acota además por `perfil.concurrency` (1 a 8) | 8 (tope por repo = `perfil.concurrency`, por defecto 3) |
| `ORQ_OPENCODE_BIN` | Ejecutable de opencode | `/usr/local/bin/opencode` o `opencode` del PATH |
| `OPENCODE_MODEL` | Modelo por defecto (`proveedor/modelo`) | el compilado en el gestor |
| `ORQ_WAIT_MS` | Cuánto bloquea cada herramienta de espera antes de responder `STILL RUNNING` | 45000 |
| `ORQ_PG_ADMIN_URL` | URL de administración de Postgres para el recurso `postgres-db` (la usa solo el gestor; nunca llega al agente) | — |
| `ORQ_PANEL_PORT` / `ORQ_PANEL_HOST` | Puerto y host del panel en vivo | 7480 / `127.0.0.1` |
| `ORQ_PANEL_ALLOW_REMOTE` | `1` permite escuchar el panel fuera de loopback (sin autenticación: solo a conciencia) | desactivado |

El archivo debe ser `0600` (el servidor avisa si es legible por otros) y nunca debe contener valores
que ya existan en el entorno: los del entorno ganan.

## Herramientas

| Herramienta | Uso |
| --- | --- |
| `opencode_coding` | Encola un trabajo y espera hasta ~45 s. Si no termina responde `STILL RUNNING` + `job_id` |
| `opencode_wait` | Espera a un trabajo (repetir hasta que termine) |
| `opencode_wait_any` | Espera ~45 s a que termine alguno de varios trabajos |
| `opencode_list` | Estado de todos los trabajos y carga del servidor |
| `opencode_status` | Tabla compacta de sondeo: contadores, activos y `succeeded` sin integrar |
| `opencode_batch` | Encola 1 a 12 tareas en una sola llamada, sin esperar |
| `opencode_logs` | Final de stdout/stderr/events/aceptacion, también mientras corre |
| `opencode_cancel` | Cancela (en cola o mata el grupo de procesos) |
| `opencode_merge` | Integra un trabajo `succeeded` en la rama de integración |
| `opencode_cleanup` | Elimina worktrees y ramas de trabajos terminados |
| `opencode_profile` | Muestra y valida el perfil del repo |
| `opencode_board_get` | Lee el pizarrón compartido entre agentes |
| `opencode_board_post` | Publica una clave en el pizarrón compartido |

Referencia completa de parámetros, matices y ejemplos: [`docs/HERRAMIENTAS.md`](docs/HERRAMIENTAS.md).

Un trabajo típico:

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

Reglas: `writes` es obligatorio en `safe` y son patrones relativos a la **raíz del repo**; `readonly`
no modifica nada (revisiones, análisis); `auto` solo cuando el usuario lo pide.

## Perfil del repositorio (`.opencode-orchestrator.json`)

Versionado en la raíz del repo objetivo. Sin archivo se usan valores seguros (rama actual como base,
sin recursos, `**/.env` protegido). La referencia completa de cada sección, clave, tipo y default, con
un ejemplo comentado, está en [`docs/PERFIL.md`](docs/PERFIL.md). Diseño y porqué de cada sección, en
[`docs/DISENO.md`](docs/DISENO.md).

## Flujo recomendado para el orquestador

1. Dividir el trabajo en tareas con `writes` **disjuntos** y lanzarlas juntas (corren en paralelo).
2. `opencode_wait` / `opencode_list` hasta que terminen.
3. Un trabajo `succeeded` ya pasó alcance y aceptación; revisar su diff (`git diff base..job/<id>`).
4. `opencode_merge` por cada uno; revisar `git diff base..staging` y avanzar la base a mano.
5. `opencode_cleanup`.

Un trabajo `rejected` (alcance o aceptación) no se integra: leer el motivo, corregir y reenviar.
Para tandas largas conviene una **compuerta**: cada trabajo corre una aceptación liviana y la suite
completa se corre UNA vez sobre la integración (`solo_aceptacion: true` con `base: "integracion"`).

## Panel en vivo (solo lectura)

```bash
node src/panel.js   # http://127.0.0.1:7480 (ORQ_PANEL_PORT / ORQ_PANEL_HOST)
```

El panel es **opcional** y estrictamente de solo lectura: nunca escribe en el directorio de estado ni
toma el lock del servidor, por lo que puede convivir con el MCP en vivo. Atiende solo `GET`/`HEAD` y
no tiene autenticación: por defecto escucha en loopback y se niega a hacerlo fuera de él salvo
`ORQ_PANEL_ALLOW_REMOTE=1`.

Rutas:

- `/` — lista de trabajos (activos primero) con buscador, chips de estado y de repo, y el detalle con
  pestañas **Resumen**, **Consola** (transcript en vivo), **Diff** (parche git), **Alcance** (`writes`,
  archivos tocados y cuáles quedaron fuera) y **Eventos** (registro del trabajo).
- `/auditoria` — registro global `eventos.jsonl` en una tabla, con filtros por `jobId`, `tipo`, `desde`
  y `hasta`.
- `/pizarron` — documento del pizarrón compartido (solo lectura).
- `/api/...` — JSON del mismo estado (`/api/trabajos`, `/api/trabajos/:id`, `/api/eventos`,
  `/api/estado`, `/api/trabajos/:id/log|diff|alcance|eventos`, `/api/pizarron`) y `/api/stream` (SSE).

Atajos de teclado (botón «Atajos (?)»): `j`/`k` trabajo siguiente/anterior, `/` buscar, `1`–`5`
pestañas, `f` seguir/pausar la consola, `?` ayuda. Accesibilidad: enlace «Saltar al contenido»,
`role="tablist"`/`tabpanel`, `aria-live` para anuncios y estados con texto + ícono (nunca solo color),
y CSP estricta sin código en línea.

## Prueba de humo

`node scripts/humo.js` valida de punta a punta **este checkout** (handshake MCP, las 13 herramientas,
un trabajo real con receta, integración, pizarrón y limpieza) sobre un repo y un `ORQ_STATE_DIR`
temporales, sin tocar el servidor en vivo. Detalle y flags en [`docs/HUMO.md`](docs/HUMO.md).

## Actualizar el servidor y volver atrás

El servidor en vivo se actualiza desde la rama de integración (`staging`) una vez revisada:

```bash
git checkout main
git merge --ff-only staging      # la base avanza a lo integrado y verificado
```

El tag **`pre-mejoras-2026-10-09`** marca el estado previo al lote de mejoras (panel, pizarrón,
revisor, reanudación, mutaciones, eventos). Para volver atrás:

```bash
git checkout pre-mejoras-2026-10-09   # inspección
# o, para reinstalar esa versión:
git reset --hard pre-mejoras-2026-10-09
```

Volver atrás no borra los directorios de estado: `jobs/`, `eventos.jsonl` y `pizarron.json` viven en
`$ORQ_STATE_DIR` y los sobrevive una reinstalación. Reiniciá el MCP (y el panel, si estaba) después
de cambiar de versión.

## Pruebas

```bash
npm test      # node --test (unitarias, con git real y procesos reales, y e2e del servidor)
```

Todas las pruebas usan directorios temporales y un opencode falso (`test/fixtures/opencode-falso.js`);
ninguna toca repos reales ni gasta cuota. Se ejecutan en Linux/WSL. Para correrlas sin que una
configuración global de opencode interfiera: `env -u OPENCODE_CONFIG node --test test/`.
