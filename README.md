# opencode-orchestrator

Servidor MCP (stdio) para delegar trabajo de código a **varias instancias de opencode en
paralelo**, con aislamiento por trabajo (git worktree, base de datos propia), alcance de
archivos declarado y **verificado**, y ciclo de vida robusto (sin procesos huérfanos).

- Diseño y decisiones: [`docs/DISENO.md`](docs/DISENO.md)
- Referencia de la v2 (serializada, un solo árbol): [`legacy/server-v2.js`](legacy/server-v2.js)

## Requisitos

Debian/Ubuntu (WSL2 incluido) con Node 20+, git y opencode 2.x instalado en Linux
(`npm i -g @opencode/cli`). Las credenciales se heredan de Windows sin archivo intermedio:

```powershell
cmd /c "opencode auth export 2>nul | wsl -d Debian -u root -- opencode auth import >nul 2>&1"
```

## Conexión desde Claude Desktop (servidor dentro de WSL)

```json
"opencode-orchestrator": {
  "command": "wsl.exe",
  "args": ["-d", "Debian", "-u", "root", "--", "node", "/mnt/c/Users/<usuario>/Documents/GitHub/opencode-orchestrator/src/server.js"]
}
```

## Tests

```bash
npm test
```
