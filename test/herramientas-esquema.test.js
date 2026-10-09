/**
 * Esquema MCP: el `tools/list` viaja en cada sesión y gasta contexto del orquestador,
 * así que se fija un tope de tamaño, límites por descripción y la referencia a la
 * documentación completa. También se cubren los textos que se repiten en cada espera.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crearHerramientas } from '../src/mcp/herramientas.js';
import { EXPLICACION_ACTIVO } from '../src/mcp/formato.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(AQUI, '..', 'docs', 'HERRAMIENTAS.md');

/**
 * Tamaño en bytes del JSON de `tools/list` medido ANTES de acortar las descripciones
 * (crearHerramientas({}) + JSON.stringify del payload `tools/list`). El tope es el 55%:
 * 6193 bytes. Si se agregaran descripciones largas, este test falla.
 */
const BASE_BYTES = 11260;
const TOPE_BYTES = Math.floor(BASE_BYTES * 0.55);

/** Serializa el payload exacto de `tools/list`. */
function payloadDe(herramientas) {
  return {
    tools: herramientas.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
}

test('el JSON de tools/list queda en ≤ 55% del tamaño previo', () => {
  const herramientas = crearHerramientas({});
  const bytes = Buffer.byteLength(JSON.stringify(payloadDe(herramientas)), 'utf8');
  assert.ok(
    bytes <= TOPE_BYTES,
    `tools/list mide ${bytes} bytes y el tope es ${TOPE_BYTES} (55% de ${BASE_BYTES})`,
  );
});

test('cada descripción de herramienta es ≤ 220 y la de cada parámetro ≤ 100, en una línea', () => {
  for (const herramienta of crearHerramientas({})) {
    assert.ok(
      herramienta.description.length <= 220,
      `${herramienta.name}: la descripción mide ${herramienta.description.length}`,
    );
    assert.ok(!herramienta.description.includes('\n'), `${herramienta.name}: la descripción no puede tener párrafos`);
    for (const [parametro, definicion] of Object.entries(herramienta.inputSchema.properties ?? {})) {
      const descripcion = definicion?.description ?? '';
      assert.ok(
        descripcion.length <= 100,
        `${herramienta.name}.${parametro}: la descripción del parámetro mide ${descripcion.length}`,
      );
      assert.ok(!descripcion.includes('\n'), `${herramienta.name}.${parametro}: debe ser una sola línea`);
    }
  }
});

test('opencode_coding referencia docs/HERRAMIENTAS.md y el archivo tiene una sección por herramienta', () => {
  const herramientas = crearHerramientas({});
  const coding = herramientas.find((h) => h.name === 'opencode_coding');
  assert.match(coding.description, /docs\/HERRAMIENTAS\.md/);

  const docs = fs.readFileSync(DOCS, 'utf8');
  for (const { name } of herramientas) {
    assert.ok(docs.includes(`## \`${name}\``), `docs/HERRAMIENTAS.md no tiene sección para ${name}`);
  }
});

test('opencode_wait_any imprime la explicación de activos UNA sola vez, no por trabajo', async () => {
  const trabajos = {
    a: { id: 'a', estado: 'running', creadoEn: 0, titulo: 'A' },
    b: { id: 'b', estado: 'running', creadoEn: 0, titulo: 'B' },
  };
  const gestor = {
    esperarAlguno: async () => ({ terminados: [], activos: ['a', 'b'] }),
    obtener: (id) => trabajos[id],
  };
  const waitAny = crearHerramientas(gestor).find((h) => h.name === 'opencode_wait_any');
  const { text } = await waitAny.manejar({ job_ids: ['a', 'b'] });
  const veces = text.split(EXPLICACION_ACTIVO).length - 1;
  assert.equal(veces, 1, `la explicación debe aparecer una vez (aparece ${veces})`);
});

test('la cola de stdout por defecto se pide en ≤ 1500 bytes; con completo, sin recorte', async () => {
  let ultimo = null;
  const terminado = { id: 't1', estado: 'succeeded', mode: 'safe', isolation: 'worktree', resultado: {}, creadoEn: 0 };
  const gestor = {
    esperar: async () => terminado,
    obtener: () => terminado,
    logs: (id, canal, bytes) => {
      ultimo = { canal, bytes };
      return 'linea\n';
    },
  };
  const wait = crearHerramientas(gestor).find((h) => h.name === 'opencode_wait');

  await wait.manejar({ job_id: 't1' });
  assert.equal(ultimo.canal, 'stdout');
  assert.equal(ultimo.bytes, 1500, 'por defecto la cola de stdout se acota a 1500 bytes');

  await wait.manejar({ job_id: 't1', completo: true });
  assert.equal(ultimo.bytes, 100000, 'con completo se pide toda la salida');
});
