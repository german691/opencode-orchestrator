/**
 * Pruebas del módulo de mutaciones (§13). Se usan directorios temporales reales y
 * un `correr` falso inyectable para no depender de la suite; además hay un caso
 * con el `correr` real (spawn de `node -e`) para validar el camino de producción.
 *
 * La propiedad central es la RESTAURACIÓN: al terminar (bien, con error de comando
 * o por timeout) el archivo debe quedar byte a byte como estaba.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  leerManifiesto,
  ejecutarMutaciones,
  resumen,
  nombreManifiesto,
  nombreJournalMutacion,
  recuperarMutacionPendiente,
} from '../src/core/mutaciones.js';

/** Directorio temporal propio de cada prueba. */
function crearWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-mut-'));
}

/** Escribe el manifiesto en `<worktree>/.orq/mutaciones.json`. */
function escribirManifiesto(worktree, contenido) {
  const ruta = path.join(worktree, nombreManifiesto);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2));
  return ruta;
}

/** sha256 de un Buffer, para aserciones de restauración byte a byte. */
function sha(contenido) {
  return createHash('sha256').update(contenido).digest('hex');
}

/**
 * `correr` falso que delega en `manejador(comando, opciones)` y registra llamadas.
 * @param {(comando: string, opciones: object) => object} manejador
 */
function correrFalso(manejador = () => ({ codigo: 0, salida: '' })) {
  const llamadas = [];
  const correr = async (comando, opciones) => {
    llamadas.push({ comando, opciones });
    return manejador(comando, opciones);
  };
  return { correr, llamadas };
}

const MUTACION_BASE = { archivo: 'x.js', buscar: 'original', reemplazar: 'mutado', comando: 'correr-tests' };

test('leerManifiesto: devuelve la lista normalizada', () => {
  const wt = crearWorktree();
  fs.writeFileSync(path.join(wt, 'x.js'), 'original\n');
  const ruta = escribirManifiesto(wt, { mutaciones: [MUTACION_BASE] });

  const lista = leerManifiesto(ruta);
  assert.deepEqual(lista, [MUTACION_BASE]);
});

test('leerManifiesto: `reemplazar` vacío es válido (borra el texto)', () => {
  const wt = crearWorktree();
  fs.writeFileSync(path.join(wt, 'x.js'), 'original\n');
  const ruta = escribirManifiesto(wt, {
    mutaciones: [{ ...MUTACION_BASE, reemplazar: '' }],
  });

  assert.equal(leerManifiesto(ruta)[0].reemplazar, '');
});

test('leerManifiesto: el manifiesto debe existir y ser JSON con `mutaciones` array', () => {
  const wt = crearWorktree();
  assert.throws(() => leerManifiesto(path.join(wt, 'no-existe.json')), /No se pudo leer/);

  const rutaJson = escribirManifiesto(wt, '{ no es json');
  assert.throws(() => leerManifiesto(rutaJson), /no es JSON válido/);

  fs.writeFileSync(path.join(wt, 'x.js'), 'original\n');
  const rutaSinCampo = escribirManifiesto(wt, { version: 1 });
  assert.throws(() => leerManifiesto(rutaSinCampo), /'mutaciones' debe ser un array/);

  const rutaArray = escribirManifiesto(wt, { mutaciones: 'no-array' });
  assert.throws(() => leerManifiesto(rutaArray), /'mutaciones' debe ser un array/);
});

test('leerManifiesto: rechaza más de 20 mutaciones', () => {
  const wt = crearWorktree();
  const muchas = Array.from({ length: 21 }, () => ({ ...MUTACION_BASE }));
  const ruta = escribirManifiesto(wt, { mutaciones: muchas });

  assert.throws(() => leerManifiesto(ruta), /máximo es 20/);
});

test('leerManifiesto: cada campo debe ser texto no vacío', () => {
  const wt = crearWorktree();
  fs.writeFileSync(path.join(wt, 'x.js'), 'original\n');

  for (const campo of ['archivo', 'buscar', 'comando']) {
    const ruta = escribirManifiesto(wt, { mutaciones: [{ ...MUTACION_BASE, [campo]: '' }] });
    assert.throws(() => leerManifiesto(ruta), new RegExp(`'${campo}' debe ser un texto no vacío`));
  }
  const rutaReemplazar = escribirManifiesto(wt, { mutaciones: [{ ...MUTACION_BASE, reemplazar: 5 }] });
  assert.throws(() => leerManifiesto(rutaReemplazar), /'reemplazar' debe ser un texto/);
});

test('leerManifiesto: rechaza rutas absolutas, con `..` y enlaces que escapan', () => {
  const wt = crearWorktree();
  fs.writeFileSync(path.join(wt, 'x.js'), 'original\n');

  const absoluta = escribirManifiesto(wt, { mutaciones: [{ ...MUTACION_BASE, archivo: path.join(wt, 'x.js') }] });
  assert.throws(() => leerManifiesto(absoluta), /no absoluto/);

  const conPuntos = escribirManifiesto(wt, { mutaciones: [{ ...MUTACION_BASE, archivo: '../fuera.js' }] });
  assert.throws(() => leerManifiesto(conPuntos), /no puede contener '\.\.'/);

  // Enlace dentro del worktree que apunta a un archivo de FUERA: no debe permitirse.
  const externo = path.join(os.tmpdir(), `orq-externo-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(externo, 'original\n');
  fs.symlinkSync(externo, path.join(wt, 'enlace.js'));
  const enlace = escribirManifiesto(wt, { mutaciones: [{ ...MUTACION_BASE, archivo: 'enlace.js' }] });
  assert.throws(() => leerManifiesto(enlace), /escapa del worktree/);

  fs.rmSync(externo, { force: true });
});

test('leerManifiesto: el archivo declarado debe existir', () => {
  const wt = crearWorktree();
  const ruta = escribirManifiesto(wt, { mutaciones: [{ ...MUTACION_BASE, archivo: 'no-existe.js' }] });
  assert.throws(() => leerManifiesto(ruta), /no existe/);
});

test('ejecutarMutaciones: detectada (comando sale distinto de 0) y restaura', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  const original = Buffer.from('function suma(a, b) { return a+b; }\n');
  fs.writeFileSync(archivo, original);

  const { correr, llamadas } = correrFalso(() => ({ codigo: 1, salida: 'test falló' }));
  const resultado = await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [{ ...MUTACION_BASE, buscar: 'a+b', reemplazar: 'a-b' }],
    permitido: () => true,
    correr,
  });

  assert.equal(resultado.total, 1);
  assert.equal(resultado.detectadas, 1);
  assert.equal(resultado.restauradoOk, true);
  assert.equal(resultado.detalle[0].estado, 'detectada');
  assert.equal(resultado.detalle[0].codigo, 1);
  assert.equal(typeof resultado.detalle[0].ms, 'number');
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].opciones.cwd, fs.realpathSync(wt));
  assert.equal(fs.readFileSync(archivo).equals(original), true);
});

test('ejecutarMutaciones: no detectada (comando sale 0) y restaura', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  const original = Buffer.from('original\n');
  fs.writeFileSync(archivo, original);

  const { correr } = correrFalso(() => ({ codigo: 0, salida: 'todo ok' }));
  const resultado = await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [{ ...MUTACION_BASE }],
    correr,
  });

  assert.equal(resultado.detectadas, 0);
  assert.equal(resultado.detalle[0].estado, 'no_detectada');
  assert.equal(resultado.detalle[0].codigo, 0);
  assert.equal(fs.readFileSync(archivo).equals(original), true);
});

test('ejecutarMutaciones: no aplicable si el texto no aparece (no corre nada)', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  const original = Buffer.from('otra cosa\n');
  fs.writeFileSync(archivo, original);

  const { correr, llamadas } = correrFalso();
  const resultado = await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [{ ...MUTACION_BASE, buscar: 'inexistente' }],
    correr,
  });

  assert.equal(resultado.detalle[0].estado, 'no_aplicable');
  assert.equal(llamadas.length, 0);
  assert.equal(fs.readFileSync(archivo).equals(original), true);
});

test('ejecutarMutaciones: no permitida no toca el archivo ni corre el comando', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  const original = Buffer.from('original\n');
  fs.writeFileSync(archivo, original);

  const { correr, llamadas } = correrFalso();
  const resultado = await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [{ ...MUTACION_BASE }],
    permitido: (ruta) => {
      assert.equal(ruta, 'x.js');
      return false;
    },
    correr,
  });

  assert.equal(resultado.detalle[0].estado, 'no_permitida');
  assert.equal(llamadas.length, 0);
  assert.equal(fs.readFileSync(archivo).equals(original), true);
});

test('ejecutarMutaciones: reemplaza SOLO la primera aparición', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  fs.writeFileSync(archivo, 'aaa bbb aaa\n');

  let visto = null;
  const { correr } = correrFalso(() => {
    visto = fs.readFileSync(archivo, 'utf8');
    return { codigo: 0, salida: '' };
  });
  await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [{ ...MUTACION_BASE, buscar: 'aaa', reemplazar: 'zzz' }],
    correr,
  });

  assert.equal(visto, 'zzz bbb aaa\n');
  assert.equal(fs.readFileSync(archivo, 'utf8'), 'aaa bbb aaa\n');
});

test('ejecutarMutaciones: restaura byte a byte si `correr` lanza', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  const original = Buffer.from('original\n');
  fs.writeFileSync(archivo, original);
  const originalSha = sha(original);

  const correr = async () => {
    throw new Error('el comando explotó');
  };
  await assert.rejects(
    ejecutarMutaciones({ worktree: wt, manifiesto: [{ ...MUTACION_BASE }], correr }),
    /el comando explotó/,
  );

  assert.equal(sha(fs.readFileSync(archivo)), originalSha);
});

test('ejecutarMutaciones: restaura byte a byte ante timeout con el `correr` real', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  const original = Buffer.from('original\n');
  fs.writeFileSync(archivo, original);
  const originalSha = sha(original);

  const resultado = await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [
      { ...MUTACION_BASE, comando: 'node -e "setTimeout(function(){}, 5000)"' },
    ],
    timeoutMs: 300,
  });

  assert.equal(resultado.detalle[0].estado, 'detectada');
  assert.equal(resultado.detalle[0].codigo, null);
  assert.equal(sha(fs.readFileSync(archivo)), originalSha);
});

test('ejecutarMutaciones: con `correr` real (`node -e`) detecta y restaura', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  const original = Buffer.from('original\n');
  fs.writeFileSync(archivo, original);

  const resultado = await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [{ ...MUTACION_BASE, comando: 'node -e "process.exit(1)"' }],
    timeoutMs: 10000,
  });

  assert.equal(resultado.detalle[0].estado, 'detectada');
  assert.equal(fs.readFileSync(archivo).equals(original), true);
});

test('ejecutarMutaciones: preserva bytes binarios y CRLF', async () => {
  const wt = crearWorktree();
  const binario = Buffer.concat([
    Buffer.from([0x00, 0xff]),
    Buffer.from('MUTA'),
    Buffer.from([0xfe, 0x0d, 0x0a]),
    Buffer.from('MUTA'),
  ]);
  const archivoBin = path.join(wt, 'bin.dat');
  fs.writeFileSync(archivoBin, binario);

  const crlf = Buffer.from('linea1\r\nlinea2\r\n');
  const archivoCrlf = path.join(wt, 'crlf.txt');
  fs.writeFileSync(archivoCrlf, crlf);

  let vistoBin = null;
  let vistoCrlf = null;
  const { correr } = correrFalso((comando) => {
    if (comando === 'bin') vistoBin = fs.readFileSync(archivoBin);
    if (comando === 'crlf') vistoCrlf = fs.readFileSync(archivoCrlf, 'utf8');
    return { codigo: 0, salida: '' };
  });

  await ejecutarMutaciones({
    worktree: wt,
    manifiesto: [
      { archivo: 'bin.dat', buscar: 'MUTA', reemplazar: 'Z', comando: 'bin' },
      { archivo: 'crlf.txt', buscar: 'linea1', reemplazar: 'LINEA1', comando: 'crlf' },
    ],
    correr,
  });

  assert.equal(vistoBin.toString('hex'), Buffer.concat([binario.subarray(0, 2), Buffer.from('Z'), binario.subarray(6)]).toString('hex'));
  assert.equal(vistoCrlf, 'LINEA1\r\nlinea2\r\n');
  assert.equal(fs.readFileSync(archivoBin).equals(binario), true);
  assert.equal(fs.readFileSync(archivoCrlf).equals(crlf), true);
});

test('resumen: N/M sobre aplicables y una línea por no detectada', () => {
  const texto = resumen({
    detalle: [
      { archivo: 'a.js', comando: 'test a', estado: 'detectada' },
      { archivo: 'b.js', comando: 'test b', estado: 'no_detectada' },
      { archivo: 'c.js', comando: 'test c', estado: 'no_aplicable' },
      { archivo: 'd.js', comando: 'test d', estado: 'no_permitida' },
      { archivo: 'e.js', comando: 'test e', estado: 'no_detectada' },
    ],
  });

  assert.equal(
    texto,
    ['MUTACION: detectada 1/3', '  no detectada: b.js (test b)', '  no detectada: e.js (test e)'].join('\n'),
  );
});

test('ejecutarMutaciones: si la restauración no puede verificar, lanza RESTAURACION_FALLIDA', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  fs.writeFileSync(archivo, 'original\n');

  // Simulamos un disco que "acepta" la escritura de restauración pero guarda otra
  // cosa: el hash no coincidirá ni en el reintento y debe lanzarse el error duro.
  const originalWrite = fs.writeFileSync;
  let escrituras = 0;
  fs.writeFileSync = (ruta, datos, ...resto) => {
    if (ruta === archivo) {
      escrituras += 1;
      if (escrituras >= 2) return originalWrite(ruta, Buffer.from('corrupto'), ...resto);
    }
    return originalWrite(ruta, datos, ...resto);
  };

  try {
    await assert.rejects(
      ejecutarMutaciones({
        worktree: wt,
        manifiesto: [{ ...MUTACION_BASE }],
        correr: async () => ({ codigo: 0, salida: '' }),
      }),
      /RESTAURACION_FALLIDA/,
    );
  } finally {
    fs.writeFileSync = originalWrite;
  }
});

// ---------------------------------------------------------------------------
// Journal de mutación pendiente (recuperación tras caída del servidor)
// ---------------------------------------------------------------------------

/**
 * Simula una caída a mitad de una mutación: escribe una copia exacta del original en
 * el respaldo y el journal, y deja el archivo mutado en disco.
 * @param {string} wt
 * @param {string} archivoRel
 * @param {Buffer} original
 * @param {Buffer} mutado
 */
function simularCaidaDeMutacion(wt, archivoRel, original, mutado) {
  const dirOrq = path.join(wt, '.orq');
  fs.mkdirSync(dirOrq, { recursive: true });
  fs.writeFileSync(path.join(wt, archivoRel), mutado);
  fs.writeFileSync(path.join(dirOrq, 'mutacion-pendiente.bak'), original);
  fs.writeFileSync(
    path.join(wt, nombreJournalMutacion),
    JSON.stringify({ archivo: archivoRel, sha256Original: sha(original), rutaRespaldo: '.orq/mutacion-pendiente.bak' }),
  );
}

test('ejecutarMutaciones: deja el journal ANTES de mutar y lo borra al restaurar', async () => {
  const wt = crearWorktree();
  const archivo = path.join(wt, 'x.js');
  fs.writeFileSync(archivo, 'original\n');

  let journalDurante = null;
  let mutadoDurante = null;
  const { correr } = correrFalso(() => {
    journalDurante = fs.existsSync(path.join(wt, nombreJournalMutacion));
    mutadoDurante = fs.readFileSync(archivo, 'utf8');
    return { codigo: 0, salida: '' };
  });
  await ejecutarMutaciones({ worktree: wt, manifiesto: [{ ...MUTACION_BASE }], correr });

  assert.equal(journalDurante, true, 'el journal debe existir mientras la mutación está aplicada');
  assert.equal(mutadoDurante, 'mutado\n', 'la mutación debe estar aplicada cuando corre el comando');
  assert.equal(fs.existsSync(path.join(wt, nombreJournalMutacion)), false, 'el journal se borra al restaurar');
  assert.equal(fs.readFileSync(archivo, 'utf8'), 'original\n');
});

test('recuperarMutacionPendiente: sin journal no hace nada', () => {
  const wt = crearWorktree();
  assert.deepEqual(recuperarMutacionPendiente(wt), { recuperado: false });
});

test('recuperarMutacionPendiente: restaura el original tras una caída y borra journal y respaldo', () => {
  const wt = crearWorktree();
  const original = Buffer.from('original\n');
  simularCaidaDeMutacion(wt, 'x.js', original, Buffer.from('mutado\n'));

  const res = recuperarMutacionPendiente(wt);
  assert.deepEqual(res, { recuperado: true, archivo: 'x.js', restaurado: true });
  assert.equal(fs.readFileSync(path.join(wt, 'x.js'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(wt, nombreJournalMutacion)), false);
  assert.equal(fs.existsSync(path.join(wt, '.orq', 'mutacion-pendiente.bak')), false);
});

test('recuperarMutacionPendiente: un respaldo que no coincide con el sha256 no se restaura', () => {
  const wt = crearWorktree();
  simularCaidaDeMutacion(wt, 'x.js', Buffer.from('original\n'), Buffer.from('mutado\n'));
  // El respaldo se corrompe: el hash del journal ya no coincide.
  fs.writeFileSync(path.join(wt, '.orq', 'mutacion-pendiente.bak'), Buffer.from('otra cosa\n'));

  const res = recuperarMutacionPendiente(wt);
  assert.equal(res.recuperado, false);
  assert.equal(res.motivo, 'hash_no_coincide');
  assert.equal(fs.readFileSync(path.join(wt, 'x.js'), 'utf8'), 'mutado\n', 'no se toca a ciegas');
  assert.equal(fs.existsSync(path.join(wt, nombreJournalMutacion)), false, 'el journal inválido se descarta');
});
