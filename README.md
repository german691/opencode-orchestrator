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
las del entorno): `ORQ_CONCURRENCY` (1 a 16, por defecto 3), `ORQ_STATE_DIR`, `ORQ_OPENCODE_BIN`,
`OPENCODE_MODEL`, `ORQ_WAIT_MS` (por defecto 45000), `ORQ_PG_ADMIN_URL` (recurso `postgres-db`).

## Herramientas

| Herramienta | Uso |
| --- | --- |
| `opencode_coding` | Encola un trabajo y espera hasta ~45 s. Si no termina responde `STILL RUNNING` + `job_id` |
| `opencode_wait` | Espera a un trabajo (repetir hasta que termine) |
| `opencode_list` | Estado de todos los trabajos y carga del servidor |
| `opencode_logs` | Final de stdout/stderr/events/aceptacion, también mientras corre |
| `opencode_cancel` | Cancela (en cola o mata el grupo de procesos) |
| `opencode_merge` | Integra un trabajo `succeeded` en la rama de integración |
| `opencode_cleanup` | Elimina worktrees y ramas de trabajos terminados |
| `opencode_profile` | Muestra y valida el perfil del repo |

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
sin recursos, `**/.env` protegido). Ejemplo en [`docs/DISENO.md`](docs/DISENO.md) §6:
`baseBranch`, `integrationBranch`, `protected`, `worktrees` (`root`, `link`, `setup`), `env`,
`resources` (`postgres-db`: una base de datos propia por trabajo) y `accept` (comandos de aceptación; el `default` se corre tras cada trabajo salvo en `readonly`, donde solo corre una `accept` explícita).

## Flujo recomendado para el orquestador

1. Dividir el trabajo en tareas con `writes` **disjuntos** y lanzarlas juntas (corren en paralelo).
2. `opencode_wait` / `opencode_list` hasta que terminen.
3. Un trabajo `succeeded` ya pasó alcance y aceptación; revisar su diff (`git diff base..job/<id>`).
4. `opencode_merge` por cada uno; revisar `git diff base..staging` y avanzar la base a mano.
5. `opencode_cleanup`.

Un trabajo `rejected` (alcance o aceptación) no se integra: leer el motivo, corregir y reenviar.

## Pruebas

```bash
npm test      # node --test (unitarias, con git real y procesos reales, y e2e del servidor)
```

Todas las pruebas usan directorios temporales y un opencode falso (`test/fixtures/opencode-falso.js`);
ninguna toca repos reales ni gasta cuota. Se ejecutan en Linux/WSL.
