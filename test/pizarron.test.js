/**
 * Pruebas del pizarrón compartido (§nuevo). Usan directorios temporales propios
 * (sin git ni procesos): el módulo solo trata con archivos JSON.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { crearPizarron, instruccionesParaAgente } from '../src/core/pizarron.js';

/** Directorios temporales a limpiar al final. */
const dirs = [];
function dirTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-pizarron-'));
  dirs.push(dir);
  return dir;
}

/** Reloj inyectable: avanza de a 1 para que los `ts` sean deterministas. */
function reloj(inicial = 1000) {
  let t = inicial;
  return () => {
    t += 1;
    return t;
  };
}

/** Escribe un aporte con el contenido dado dentro de `dir`. */
function escribirAporte(dir, contenido) {
  const ruta = path.join(dir, 'aporte.json');
  fs.writeFileSync(ruta, contenido);
  return ruta;
}

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('leer: sin archivo devuelve un documento vacío versión 0', () => {
  const p = crearPizarron({ dir: dirTemporal() });
  const doc = p.leer();
  assert.equal(doc.version, 0);
  assert.deepEqual(doc.claves, {});
  assert.deepEqual(doc.notas, []);
  assert.equal(fs.existsSync(p.rutaViva()), false);
  assert.equal(p.version(), 0);
});

test('post: una clave nueva se crea con su historial y sube la versión', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  const res = p.post({ clave: 'contrato.api', valor: { ruta: '/v1' }, nota: 'inicial', jobId: 'job1' });
  assert.deepEqual(res, { aplicado: true, conflicto: false });

  const doc = p.leer();
  assert.equal(doc.version, 1);
  const entrada = doc.claves['contrato.api'];
  assert.deepEqual(entrada.valor, { ruta: '/v1' });
  assert.equal(entrada.nota, 'inicial');
  assert.equal(entrada.jobId, 'job1');
  assert.equal(entrada.historial.length, 1);
  assert.deepEqual(entrada.historial[0], { valor: { ruta: '/v1' }, nota: 'inicial', jobId: 'job1', ts: entrada.ts });
});

test('post: el mismo trabajo actualiza el valor y agrega al historial', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  p.post({ clave: 'k', valor: 1, jobId: 'job1' });
  p.post({ clave: 'k', valor: 2, jobId: 'job1' });

  const doc = p.leer();
  assert.equal(doc.version, 2);
  assert.equal(doc.claves.k.valor, 2);
  assert.equal(doc.claves.k.historial.length, 2);
  assert.equal(doc.claves.k.historial[1].valor, 2);
});

test('post: otro trabajo NO pisa el valor vigente y lo marca en conflicto', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  p.post({ clave: 'k', valor: 'A', jobId: 'job1' });
  const res = p.post({ clave: 'k', valor: 'B', nota: 'intento', jobId: 'job2' });

  assert.equal(res.aplicado, false);
  assert.equal(res.conflicto, true);
  const entrada = p.leer().claves.k;
  assert.equal(entrada.valor, 'A');
  assert.equal(entrada.jobId, 'job1');
  assert.equal(entrada.historial.length, 2);
  assert.equal(entrada.historial[1].conflicto, true);
  assert.equal(entrada.historial[1].jobId, 'job2');
  assert.equal(entrada.historial[1].valor, 'B');
});

test('post: forzar pisa la clave de otro trabajo y lo deja en el historial', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  p.post({ clave: 'k', valor: 'A', jobId: 'job1' });
  const res = p.post({ clave: 'k', valor: 'B', jobId: 'job2', forzar: true });

  assert.deepEqual(res, { aplicado: true, conflicto: true, motivo: 'forzado' });
  const entrada = p.leer().claves.k;
  assert.equal(entrada.valor, 'B');
  assert.equal(entrada.jobId, 'job2');
  assert.equal(entrada.historial[1].conflicto, true);
});

test('post: el historial se acota a las 20 entradas más nuevas', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  for (let i = 0; i < 25; i += 1) p.post({ clave: 'k', valor: i, jobId: 'job1' });

  const entrada = p.leer().claves.k;
  assert.equal(entrada.historial.length, 20);
  assert.equal(entrada.historial[0].valor, 5);
  assert.equal(entrada.historial[19].valor, 24);
});

test('post: entradas inválidas se ignoran y NO cambian el documento', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  const base = p.leer();
  const circular = {};
  circular.yo = circular;

  const invalidas = [
    { clave: 'a b', valor: 1, jobId: 'j' },
    { clave: '', valor: 1, jobId: 'j' },
    { clave: 'x'.repeat(81), valor: 1, jobId: 'j' },
    { clave: 123, valor: 1, jobId: 'j' },
    { clave: 'ok', valor: undefined, jobId: 'j' },
    { clave: 'ok', valor: circular, jobId: 'j' },
    { clave: 'ok', valor: 'a'.repeat(9000), jobId: 'j' },
    { clave: 'ok', valor: 1, nota: 'x'.repeat(501), jobId: 'j' },
    { clave: 'ok', valor: 1, nota: 5, jobId: 'j' },
    { clave: 'ok', valor: 1 },
    { clave: 'ok', valor: 1, jobId: '' },
  ];
  invalidas.forEach((entrada, indice) => {
    assert.equal(p.post(entrada).aplicado, false, `entrada inválida #${indice}`);
  });
  assert.deepEqual(p.leer(), base);
});

test('post: acepta valores JSON como null, false, 0 y cadena vacía', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  assert.equal(p.post({ clave: 'nulo', valor: null, jobId: 'j' }).aplicado, true);
  assert.equal(p.post({ clave: 'falso', valor: false, jobId: 'j' }).aplicado, true);
  assert.equal(p.post({ clave: 'cero', valor: 0, jobId: 'j' }).aplicado, true);
  assert.equal(p.post({ clave: 'vacio', valor: '', jobId: 'j' }).aplicado, true);
});

test('version(): sube en cada cambio y no en los inválidos', () => {
  const p = crearPizarron({ dir: dirTemporal(), ahora: reloj() });
  assert.equal(p.version(), 0);
  p.post({ clave: 'a', valor: 1, jobId: 'j' });
  assert.equal(p.version(), 1);
  p.post({ clave: 'b', valor: 2, jobId: 'j' });
  assert.equal(p.version(), 2);
  p.post({ clave: 'b', valor: 3, jobId: 'j' });
  assert.equal(p.version(), 3);
  p.post({ clave: 'x y', valor: 1, jobId: 'j' });
  assert.equal(p.version(), 3);
});

test('fusionarAporte: aplica entradas y notas del archivo', () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  const ruta = escribirAporte(
    dir,
    JSON.stringify({
      entradas: [
        { clave: 'a', valor: 1, nota: 'uno' },
        { clave: 'b', valor: { y: 2 } },
      ],
      notas: ['hola', 'mundo'],
    }),
  );

  const res = p.fusionarAporte('job1', ruta);
  assert.deepEqual(res, { fusionadas: 2, ignoradas: 0, conflictos: 0 });

  const doc = p.leer();
  assert.equal(doc.claves.a.valor, 1);
  assert.equal(doc.claves.a.jobId, 'job1');
  assert.equal(doc.claves.b.jobId, 'job1');
  assert.equal(doc.notas.length, 2);
  assert.deepEqual(doc.notas.map((n) => n.texto), ['hola', 'mundo']);
  assert.equal(doc.notas[0].jobId, 'job1');
  assert.equal(typeof doc.notas[0].ts, 'number');
});

test('fusionarAporte: archivo inexistente no lanza y no aporta', () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  const res = p.fusionarAporte('j', path.join(dir, 'no-existe.json'));
  assert.deepEqual(res, { fusionadas: 0, ignoradas: 0 });
  assert.equal(p.version(), 0);
});

test('fusionarAporte: JSON corrupto o truncado no lanza', () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  const truncado = escribirAporte(dir, '{ "entradas": [ { "clave": "a",');
  assert.deepEqual(p.fusionarAporte('j', truncado), { fusionadas: 0, ignoradas: 0 });
  assert.equal(p.version(), 0);

  const noObjeto = escribirAporte(dir, '42');
  assert.deepEqual(p.fusionarAporte('j', noObjeto), { fusionadas: 0, ignoradas: 0 });
  assert.equal(p.version(), 0);
});

test('fusionarAporte: cuenta como ignoradas las entradas inválidas del aporte', () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  const ruta = escribirAporte(dir, JSON.stringify({ entradas: [{ clave: 'a b', valor: 1 }, null, 7] }));
  const res = p.fusionarAporte('j', ruta);
  assert.equal(res.fusionadas, 0);
  assert.equal(res.ignoradas, 3);
  assert.equal(p.version(), 0);
});

test('fusionarAporte: es idempotente (no re-fusiona ni duplica notas)', () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  const ruta = escribirAporte(
    dir,
    JSON.stringify({ entradas: [{ clave: 'a', valor: { x: 1 }, nota: 'n' }], notas: ['hola'] }),
  );

  const primero = p.fusionarAporte('j', ruta);
  assert.equal(primero.fusionadas, 1);
  const versionTrasPrimera = p.version();

  const segundo = p.fusionarAporte('j', ruta);
  assert.equal(segundo.fusionadas, 0);
  assert.equal(segundo.ignoradas, 1);
  assert.equal(p.version(), versionTrasPrimera);

  const doc = p.leer();
  assert.equal(doc.claves.a.historial.length, 1);
  assert.equal(doc.notas.length, 1);
});

test('fusionarAporte: reporta conflicto cuando otro trabajo ya fijó la clave', () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  p.post({ clave: 'k', valor: 'A', jobId: 'job1' });
  const ruta = escribirAporte(dir, JSON.stringify({ entradas: [{ clave: 'k', valor: 'B' }] }));

  const res = p.fusionarAporte('job2', ruta);
  assert.equal(res.conflictos, 1);
  assert.equal(res.fusionadas, 0);
  assert.equal(res.ignoradas, 1);
  assert.equal(p.leer().claves.k.valor, 'A');
});

test('leer: un pizarron.json corrupto se aparta y arranca vacío', () => {
  const dir = dirTemporal();
  fs.writeFileSync(path.join(dir, 'pizarron.json'), '{ roto');
  const p = crearPizarron({ dir, ahora: reloj(5000) });

  const doc = p.leer();
  assert.equal(doc.version, 0);
  assert.equal(fs.existsSync(path.join(dir, 'pizarron.json')), false);
  const corruptos = fs.readdirSync(dir).filter((n) => n.startsWith('pizarron.corrupto.'));
  assert.equal(corruptos.length, 1);
  assert.match(corruptos[0], /^pizarron\.corrupto\.\d+\.json$/);
});

test('escritura atómica: tras escribir no queda el temporal .tmp', () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  p.post({ clave: 'a', valor: 1, jobId: 'j' });
  p.post({ clave: 'b', valor: 2, jobId: 'j' });

  assert.equal(fs.existsSync(path.join(dir, 'pizarron.json.tmp')), false);
  assert.equal(fs.existsSync(path.join(dir, 'pizarron.json')), true);
});

test('post: dos llamadas en el mismo proceso no se pisan entre sí', async () => {
  const dir = dirTemporal();
  const p = crearPizarron({ dir, ahora: reloj() });
  await Promise.all([
    Promise.resolve().then(() => p.post({ clave: 'a', valor: 1, jobId: 'j' })),
    Promise.resolve().then(() => p.post({ clave: 'b', valor: 2, jobId: 'j' })),
  ]);

  const doc = p.leer();
  assert.equal(doc.claves.a.valor, 1);
  assert.equal(doc.claves.b.valor, 2);
  assert.equal(doc.version, 2);
});

test('instruccionesParaAgente: corto y menciona los dos archivos de .orq', () => {
  const texto = instruccionesParaAgente();
  assert.ok(texto.split('\n').length <= 12, `demasiadas líneas: ${texto.split('\n').length}`);
  assert.match(texto, /\.orq\/pizarron\.json/);
  assert.match(texto, /\.orq\/aporte\.json/);
  assert.match(texto, /SOLO LECTURA/i);
  assert.match(texto, /mutaciones\.json/);
});
