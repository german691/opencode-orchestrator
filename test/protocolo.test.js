import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { crearServidorMcp } from '../src/mcp/protocolo.js';

/** Servidor con streams en memoria: `enviar` escribe al servidor, `recibidos` guarda sus respuestas. */
function montar(herramientas, opciones = {}) {
  const entrada = new PassThrough();
  const recibidos = [];
  const logs = [];
  const salida = { write: (texto) => recibidos.push(...texto.split('\n').filter(Boolean).map((l) => JSON.parse(l))) };
  const servidor = crearServidorMcp({
    nombre: 'prueba',
    version: '1.2.3',
    herramientas,
    entrada,
    salida,
    log: (...partes) => logs.push(partes.join(' ')),
    ...opciones,
  });
  servidor.iniciar();
  const enviar = (mensaje) => entrada.write(`${typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje)}\n`);
  const esperar = async (cantidad, ms = 1000) => {
    const limite = Date.now() + ms;
    while (recibidos.length < cantidad && Date.now() < limite) await new Promise((r) => setTimeout(r, 5));
    return recibidos;
  };
  return { servidor, entrada, enviar, recibidos, logs, esperar };
}

const eco = {
  name: 'eco',
  description: 'devuelve el texto',
  inputSchema: { type: 'object' },
  manejar: async (args) => ({ text: `eco:${args.texto ?? ''}`, isError: false }),
};

test('initialize devuelve nombre, versión y repite la versión de protocolo del cliente', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const [r] = await esperar(1);
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.serverInfo, { name: 'prueba', version: '1.2.3' });
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
});

test('initialize sin versión usa la versión por defecto', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const [r] = await esperar(1);
  assert.equal(r.result.protocolVersion, '2024-11-05');
});

test('tools/list expone nombre, descripción y esquema, sin el manejador', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const [r] = await esperar(1);
  assert.deepEqual(r.result.tools, [{ name: 'eco', description: 'devuelve el texto', inputSchema: { type: 'object' } }]);
});

test('tools/call devuelve el texto del manejador y isError', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'eco', arguments: { texto: 'hola' } } });
  const [r] = await esperar(1);
  assert.deepEqual(r.result, { content: [{ type: 'text', text: 'eco:hola' }], isError: false });
});

test('tools/call sin arguments (o con arguments inválidos) llama al manejador con {}', async () => {
  const vistos = [];
  const h = { ...eco, manejar: async (args) => (vistos.push(args), { text: 'ok' }) };
  const { enviar, esperar } = montar([h]);
  enviar({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eco' } });
  enviar({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'eco', arguments: [1, 2] } });
  enviar({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'eco', arguments: 'x' } });
  await esperar(3);
  assert.deepEqual(vistos, [{}, {}, {}]);
});

test('una herramienta desconocida responde un error JSON-RPC -32602 con el nombre', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_existe' } });
  const [r] = await esperar(1);
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /no_existe/);
});

test('un ErrorDeGestor se informa como resultado de error legible, sin traza', async () => {
  const h = {
    ...eco,
    manejar: async () => {
      const e = new Error('el prompt es obligatorio');
      e.name = 'ErrorDeGestor';
      throw e;
    },
  };
  const { enviar, esperar, logs } = montar([h]);
  enviar({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'eco', arguments: {} } });
  const [r] = await esperar(1);
  assert.deepEqual(r.result, { content: [{ type: 'text', text: 'Error: el prompt es obligatorio' }], isError: true });
  assert.equal(logs.length, 0, 'un error de uso no es un fallo del servidor: no se loguea como inesperado');
});

test('un error inesperado se informa como "Error interno" y se loguea con la traza', async () => {
  const h = { ...eco, manejar: async () => { throw new TypeError('algo raro'); } };
  const { enviar, esperar, logs } = montar([h]);
  enviar({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'eco', arguments: {} } });
  const [r] = await esperar(1);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'Error interno: algo raro');
  assert.ok(logs.some((l) => l.includes('algo raro')));
});

test('un método desconocido responde -32601', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  const [r] = await esperar(1);
  assert.equal(r.error.code, -32601);
});

test('ping responde un objeto vacío', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 8, method: 'ping' });
  const [r] = await esperar(1);
  assert.deepEqual(r.result, {});
});

test('las notificaciones (sin id) NUNCA se responden, incluida la cancelación del cliente', async () => {
  const { enviar, esperar, recibidos, logs } = montar([eco]);
  enviar({ jsonrpc: '2.0', method: 'notifications/initialized' });
  enviar({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
  enviar({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await esperar(1);
  assert.equal(recibidos.length, 1, 'solo el ping tiene respuesta');
  assert.ok(logs.some((l) => l.includes('cancelada por el cliente')), 'la cancelación se registra pero no mata nada');
});

test('JSON inválido responde -32700 con id null y no tumba el servidor', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar('{esto no es json');
  enviar({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const respuestas = await esperar(2);
  assert.equal(respuestas[0].error.code, -32700);
  assert.equal(respuestas[0].id, null);
  assert.deepEqual(respuestas[1].result, {});
});

test('mensajes que no son una petición válida responden -32600', async () => {
  const { enviar, esperar } = montar([eco]);
  enviar('[1,2,3]');
  enviar('42');
  // Un objeto con id pero sin method se trata como una respuesta del cliente: se ignora.
  enviar({ jsonrpc: '2.0', id: 3 });
  enviar({ jsonrpc: '2.0', id: 4, method: 123 });
  const respuestas = await esperar(3);
  assert.deepEqual(respuestas.map((r) => r.error?.code), [-32600, -32600, -32600]);
  assert.equal(respuestas[2].id, 4, 'el method no textual con id se rechaza como petición inválida');
});

test('una respuesta del cliente (id sin method) se ignora', async () => {
  const { enviar, esperar, recibidos } = montar([eco]);
  enviar({ jsonrpc: '2.0', id: 99, result: {} });
  enviar({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await esperar(1);
  assert.equal(recibidos.length, 1);
});

test('reensambla líneas partidas en varios fragmentos y tolera CRLF y líneas en blanco', async () => {
  const { entrada, esperar } = montar([eco]);
  const linea = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  entrada.write(linea.slice(0, 10));
  entrada.write(`${linea.slice(10)}\r\n\n  \n`);
  const [r] = await esperar(1);
  assert.deepEqual(r.result, {});
});

test('varias peticiones juntas en un mismo fragmento se atienden todas', async () => {
  const { entrada, esperar } = montar([eco]);
  const m = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
  entrada.write(`${m(1)}\n${m(2)}\n${m(3)}\n`);
  const respuestas = await esperar(3);
  assert.deepEqual(respuestas.map((r) => r.id).sort(), [1, 2, 3]);
});

test('las llamadas son concurrentes: una lenta no bloquea a una rápida', async () => {
  const lenta = { ...eco, name: 'lenta', manejar: () => new Promise((r) => setTimeout(() => r({ text: 'lenta' }), 150)) };
  const rapida = { ...eco, name: 'rapida', manejar: async () => ({ text: 'rapida' }) };
  const { enviar, esperar } = montar([lenta, rapida]);
  enviar({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lenta' } });
  enviar({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rapida' } });
  const respuestas = await esperar(2, 2000);
  assert.deepEqual(respuestas.map((r) => r.id), [2, 1], 'la rápida contesta antes');
});

test('el stdout contiene SOLO mensajes JSON del protocolo: el diagnóstico va al log', async () => {
  const h = { ...eco, manejar: async () => { throw new Error('x'); } };
  const entrada = new PassThrough();
  const crudo = [];
  const servidor = crearServidorMcp({
    nombre: 'p', version: '1', herramientas: [h], entrada, salida: { write: (t) => crudo.push(t) }, log: () => {},
  });
  servidor.iniciar();
  entrada.write('basura\n');
  entrada.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eco' } })}\n`);
  await new Promise((r) => setTimeout(r, 50));
  for (const fragmento of crudo) {
    for (const linea of fragmento.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(linea), `no es JSON: ${linea}`);
  }
});

test('una línea gigante sin salto se descarta con error y el servidor sigue vivo', async () => {
  const { entrada, enviar, esperar } = montar([eco], { maxLinea: 1000 });
  entrada.write('x'.repeat(2000));
  enviar({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const respuestas = await esperar(2);
  assert.equal(respuestas[0].error.code, -32600);
  assert.deepEqual(respuestas[1].result, {});
});

test('detener() deja de atender y pendientes() cuenta las llamadas en curso', async () => {
  let liberar;
  const bloqueada = { ...eco, manejar: () => new Promise((r) => { liberar = () => r({ text: 'fin' }); }) };
  const { servidor, enviar, esperar, recibidos } = montar([bloqueada]);
  enviar({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eco' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(servidor.pendientes(), 1);
  liberar();
  await esperar(1);
  assert.equal(servidor.pendientes(), 0);
  servidor.detener();
  enviar({ jsonrpc: '2.0', id: 2, method: 'ping' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(recibidos.length, 1, 'tras detener no se atiende nada más');
});
