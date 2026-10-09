/**
 * Prueba de la prueba de humo: corre `scripts/humo.js` de punta a punta contra el
 * opencode FALSO del repo, en su propio repo git temporal y con ORQ_STATE_DIR
 * temporal. No toca el servidor en vivo ni el estado real.
 *
 * POR QUÉ existe: el humo es la antesala de reemplazar el servidor real; si el
 * propio script se rompe (una herramienta cambia de formato, el perfil deja de
 * validar), esta prueba lo detecta sin gastar cuota ni arrancar el opencode real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const HUMO = path.join(AQUI, '..', 'scripts', 'humo.js');
const FALSO = path.join(AQUI, 'fixtures', 'opencode-falso.js');

test('scripts/humo.js valida el flujo completo contra el opencode falso', () => {
  const salida = spawnSync(
    process.execPath,
    [HUMO, '--opencode', FALSO, '--timeout', '60'],
    {
      encoding: 'utf8',
      // El falso escribe este archivo en el worktree del trabajo.
      env: { ...process.env, ORQ_FAKE_ESCRIBIR: 'hola.txt' },
      timeout: 120_000,
    },
  );

  const detalle = `${salida.stdout ?? ''}\n${salida.stderr ?? ''}`;
  assert.equal(salida.status, 0, detalle);
  for (const marca of [
    '✔ herramientas MCP',
    '✔ receta crear-archivo',
    '✔ trabajo succeeded',
    '✔ archivo en la rama del trabajo',
    '✔ status sin integrar',
    '✔ merge a staging',
    '✔ pasa a merged',
    '✔ pizarrón ida y vuelta',
    '✔ eventos.jsonl',
    '✔ cleanup',
    '✔ cierre limpio',
  ]) {
    assert.ok(salida.stdout.includes(marca), `falta «${marca}»:\n${detalle}`);
  }
  assert.match(salida.stdout, /HUMO OK: 13\/13 pasos/, detalle);
});
