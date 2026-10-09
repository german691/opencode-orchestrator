# Prueba de humo (scripts/humo.js)

Valida de punta a punta **la versión de este checkout** del servidor MCP
(`src/server.js`) sin tocar el servidor en vivo ni el estado real
(`~/.local/state/opencode-orchestrator`). Crea su propio repositorio git temporal,
un perfil mínimo y un `ORQ_STATE_DIR` temporal, y recorre el flujo completo de un
trabajo real. Termina con código `0` si todos los pasos pasan y `1` si alguno falla
(imprime `✔`/`✘` por paso y un resumen `HUMO OK`/`HUMO FALLÓ`).

## Requisitos

- Node 20+ y `git` en el PATH.
- Para la corrida con el opencode **real**: `opencode` 2.x instalado en Linux
  (`npm i -g @opencode/cli`) y sus credenciales. Para la corrida con el **falso** no
  hace falta opencode ni cuota.

## Correrlo en WSL

Desde dentro de la distro (Debian/Ubuntu en WSL2), parado en la raíz del repo:

```bash
node scripts/humo.js
```

No hace falta `wsl.exe`: el script y el servidor corren en el mismo Linux. Lo que
sí importa es que `opencode` esté instalado en Linux (no el de Windows).

## Correrlo con el opencode real

```bash
# Usa 'opencode' del PATH (o /usr/local/bin/opencode si existe).
node scripts/humo.js

# O un binario puntual:
node scripts/humo.js --opencode /usr/local/bin/opencode

# O por variable de entorno (server.js también la lee):
ORQ_OPENCODE_BIN=/usr/local/bin/opencode node scripts/humo.js
```

El trabajo lo ejecuta el agente real sobre un repo descartable, así que **gasta una
cantidad mínima de cuota**. El tope de espera por defecto es de 5 minutos
(`--timeout 300`).

## Correrlo con el opencode falso del repo

No gasta cuota y es lo que usa `test/humo.test.js`:

```bash
ORQ_FAKE_ESCRIBIR=hola.txt \
  node scripts/humo.js --opencode test/fixtures/opencode-falso.js --timeout 60
```

Si `--opencode` (o `ORQ_OPENCODE_BIN`) apunta a un `.js`, el humo lo envuelve con
`node` para poder lanzarlo: el runner usa `spawn(cmd, args)` sin shell y un `.js`
sin bit de ejecución no sirve como ejecutable directo.

## Flags

| Flag | Efecto |
| --- | --- |
| `--opencode <ruta>` | Ejecutable de opencode (pisa a `ORQ_OPENCODE_BIN`; por defecto `opencode`). |
| `--timeout <seg>` | Tope de espera del trabajo en segundos (por defecto `300`). |
| `--mantener` | No borra el directorio temporal al terminar (para depurar). |
| `-h`, `--help` | Muestra la ayuda. |

## Qué valida

1. **Repo temporal y perfil**: `git init` con un commit inicial y un
   `.opencode-orchestrator.json` con `baseBranch`/`integrationBranch`, una receta
   `crear-archivo` (`writes: ['{archivo}']`), `reanudacion`, `pizarron` habilitado,
   `revisor` deshabilitado y `accept.default = "true"`.
2. **Handshake MCP** con `initialize`.
3. **`tools/list`**: están las 13 herramientas esperadas y se imprime el tamaño en bytes.
4. **`opencode_profile`**: lista la receta `crear-archivo` y la rama `staging`.
5. **Trabajo completo** con `opencode_coding` usando `receta: 'crear-archivo'` y
   `params: { archivo: 'hola.txt', texto: 'hola' }`, esperando con `opencode_wait`
   hasta `(finished)`:
   - estado `succeeded`;
   - el archivo está en el commit de la rama `job/<id>`;
   - `opencode_status` lo muestra como *sin integrar*;
   - `opencode_merge` lo integra en `staging` y el trabajo pasa a `merged`;
   - `opencode_board_post` / `opencode_board_get` ida y vuelta;
   - `eventos.jsonl` del directorio de estado tiene `job.creado`, `job.estado`,
     `job.fin` y `merge`.
6. **`opencode_cleanup`** y **cierre limpio** del servidor (código 0), borrando el
   directorio temporal.

## Seguridad

- El script **falla con error claro** si `ORQ_STATE_DIR` ya está definido: siempre
  usa un temporal propio y nunca debe arriesgar un estado existente.
- Todos los repos, worktrees y estado viven bajo un `mkdtemp` en `/tmp`, y se borran
  al terminar salvo `--mantener`.
- No arranca ni afecta al servidor que esté orquestando otros trabajos.
