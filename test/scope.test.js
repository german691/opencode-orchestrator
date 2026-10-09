import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prefijoLiteral,
  seSuperponen,
  gruposSeSuperponen,
  verificarCambios,
} from '../src/core/scope.js';
import { coincide } from '../src/core/glob.js';

test('prefijoLiteral recorta antes del primer comodín y hasta la última barra', () => {
  assert.equal(prefijoLiteral('backend/src/**'), 'backend/src');
  assert.equal(prefijoLiteral('docs/*.md'), 'docs');
  assert.equal(prefijoLiteral('*.md'), '');
  assert.equal(prefijoLiteral('?'), '');
  assert.equal(prefijoLiteral('**'), '');
  assert.equal(prefijoLiteral('a/b?.js'), 'a');
  assert.equal(prefijoLiteral('.env'), '.env');
});

test('prefijoLiteral rechaza entradas no válidas', () => {
  assert.throws(() => prefijoLiteral(''), TypeError);
  assert.throws(() => prefijoLiteral(7), TypeError);
});

test('seSuperponen: un prefijo contiene al otro respetando límites de directorio', () => {
  assert.equal(seSuperponen('backend/**', 'backend/src/**'), true);
  assert.equal(seSuperponen('backend/src/**', 'backend/**'), true);
});

test('seSuperponen NO confunde prefijos parecidos por límite de directorio', () => {
  assert.equal(seSuperponen('backend/test/**', 'backend/test-integracion/**'), false);
  assert.equal(seSuperponen('backend/prisma/migrations/**', 'backend/prisma/migrations-x/a.sql'), false);
});

test('seSuperponen: dos literales distintos de la misma carpeta NO se superponen; el mismo sí', () => {
  // Regresión (observada en vivo): se serializaban trabajos con archivos disjuntos de un mismo directorio.
  assert.equal(seSuperponen('backend/src/lib/archivos.ts', 'backend/src/lib/mailer.ts'), false);
  assert.equal(seSuperponen('backend/src/lib/mailer.ts', 'backend/src/lib/archivos.ts'), false);
  assert.equal(seSuperponen('backend/src/lib/mailer.ts', 'backend/src/lib/mailer.ts'), true);
  assert.equal(seSuperponen('package.json', 'README.md'), false);
});

test('seSuperponen: comodín en un nombre contra literales de la misma carpeta', () => {
  assert.equal(seSuperponen('t/auth-*.test.ts', 't/archivos-contenido.test.ts'), false);
  assert.equal(seSuperponen('t/auth-*.test.ts', 't/auth-claves.test.ts'), true);
  assert.equal(seSuperponen('t/*.test.ts', 't/auth-claves.test.ts'), true);
  assert.equal(seSuperponen('t/auth-*', 't/soporte/x.ts'), false);
  assert.equal(seSuperponen('t/soporte/**', 't/soporte/correo.ts'), true);
  assert.equal(seSuperponen('t/soporte/**', 't/auth-claves.test.ts'), false);
});

test('** se superpone con todo', () => {
  assert.equal(seSuperponen('**', 'docs/**'), true);
  assert.equal(seSuperponen('docs/**', '**'), true);
  assert.equal(seSuperponen('**', 'a/b/c.txt'), true);
});

test('*.md (raíz) y docs/** no se superponen', () => {
  assert.equal(seSuperponen('*.md', 'docs/**'), false);
  assert.equal(seSuperponen('docs/**', '*.md'), false);
});

test('dos patrones de la raíz sí se consideran superpuestos (conservador)', () => {
  assert.equal(seSuperponen('*.md', '*.txt'), true);
});

test('seSuperponen: literal de la raíz contra comodín de la raíz (bug corregido)', () => {
  // Antes daba false: el prefijo del literal ('package.json') no se relacionaba
  // con el del comodín de la raíz (''), aunque ambos apuntan a la raíz.
  assert.equal(seSuperponen('package.json', '*.json'), true);
  assert.equal(seSuperponen('*.json', 'package.json'), true);
  assert.equal(seSuperponen('README.md', '*.md'), true);
  assert.equal(seSuperponen('*.md', 'README.md'), true);
});

test('seSuperponen: comodín en el primer segmento alcanza subdirectorios', () => {
  assert.equal(seSuperponen('*/x.js', 'a/x.js'), true);
  assert.equal(seSuperponen('a/x.js', '*/x.js'), true);
  assert.equal(seSuperponen('*/x.js', '**'), true);
});

test('seSuperponen: "?" dentro de un segmento de directorio', () => {
  assert.equal(seSuperponen('doc?/a', 'docs/a'), true);
  assert.equal(seSuperponen('doc?/a', 'docs/**'), true);
  assert.equal(seSuperponen('docs/a', 'doc?/a'), true);
});

test('seSuperponen: comodín dentro de un segmento de directorio', () => {
  assert.equal(seSuperponen('src/x*', 'src/xy/**'), true);
  assert.equal(seSuperponen('src/x*', 'src/xz.js'), true);
  assert.equal(seSuperponen('src/x*', 's*/xz.js'), true);
});

test('seSuperponen: "**" en el medio del patrón', () => {
  // 'a/**/b' solo casa archivos que TERMINAN en 'b'; 'a/x/b/c' no es uno de ellos (antes la
  // regla de prefijos lo daba por superpuesto de más). El universo de soundness lo respalda.
  assert.equal(seSuperponen('a/**/b', 'a/x/b/c'), false);
  assert.equal(seSuperponen('a/**/b', 'a/x/b/**'), true);
  assert.equal(seSuperponen('a/**/b', 'a/x/b'), true);
  assert.equal(seSuperponen('a/**/b', 'a/b'), true);
});

test('patrones literales se comparan por directorio', () => {
  assert.equal(seSuperponen('a/b/c', 'a/**'), true);
  assert.equal(seSuperponen('a/b/c', 'b/**'), false);
});

test('gruposSeSuperponen detecta cualquier par y trata listas vacías', () => {
  assert.equal(gruposSeSuperponen(['docs/**', 'src/**'], ['src/a.js']), true);
  assert.equal(gruposSeSuperponen(['docs/**'], ['src/**']), false);
  assert.equal(gruposSeSuperponen([], ['src/**']), false);
  assert.equal(gruposSeSuperponen(['src/**'], []), false);
});

test('verificarCambios: lista vacía es ok', () => {
  assert.deepEqual(verificarCambios({ archivosCambiados: [], writes: ['**'], protegidos: [] }), {
    ok: true,
    violaciones: [],
  });
});

test('verificarCambios: archivo dentro de writes no viola', () => {
  const r = verificarCambios({ archivosCambiados: ['src/a.js'], writes: ['src/**'], protegidos: [] });
  assert.deepEqual(r, { ok: true, violaciones: [] });
});

test('verificarCambios: fuera de writes es fuera_de_alcance', () => {
  const r = verificarCambios({ archivosCambiados: ['docs/a.md'], writes: ['src/**'], protegidos: [] });
  assert.deepEqual(r, { ok: false, violaciones: [{ ruta: 'docs/a.md', motivo: 'fuera_de_alcance' }] });
});

test('verificarCambios: protegido gana sobre writes', () => {
  const r = verificarCambios({
    archivosCambiados: ['backend/prisma/migrations/001.sql'],
    writes: ['backend/**'],
    protegidos: ['backend/prisma/migrations/**'],
  });
  assert.deepEqual(r, {
    ok: false,
    violaciones: [{ ruta: 'backend/prisma/migrations/001.sql', motivo: 'protegido' }],
  });
});

test('verificarCambios: prefijo parecido a un protegido NO es protegido', () => {
  const r = verificarCambios({
    archivosCambiados: ['backend/prisma/migrations-x/a.sql'],
    writes: ['backend/prisma/migrations-x/**'],
    protegidos: ['backend/prisma/migrations/**'],
  });
  assert.deepEqual(r, { ok: true, violaciones: [] });
});

test('verificarCambios: modo readonly marca cualquier cambio como solo_lectura', () => {
  const r = verificarCambios({
    archivosCambiados: ['src/a.js'],
    writes: ['**'],
    protegidos: [],
    modo: 'readonly',
  });
  assert.deepEqual(r, { ok: false, violaciones: [{ ruta: 'src/a.js', motivo: 'solo_lectura' }] });
});

test('verificarCambios: en readonly el protegido gana sobre solo_lectura', () => {
  const r = verificarCambios({
    archivosCambiados: ['.env'],
    writes: ['**'],
    protegidos: ['**/.env'],
    modo: 'readonly',
  });
  assert.deepEqual(r, { ok: false, violaciones: [{ ruta: '.env', motivo: 'protegido' }] });
});

test('verificarCambios: rutas con espacios y tildes', () => {
  const r = verificarCambios({
    archivosCambiados: ['docs/ñandú con espacios.md', 'src/a.js'],
    writes: ['docs/**'],
    protegidos: [],
  });
  assert.deepEqual(r, {
    ok: false,
    violaciones: [{ ruta: 'src/a.js', motivo: 'fuera_de_alcance' }],
  });
  const ok = verificarCambios({ archivosCambiados: ['docs/ñandú con espacios.md'], writes: ['docs/**'] });
  assert.equal(ok.ok, true);
});

test('verificarCambios: deduplica archivos repetidos', () => {
  const r = verificarCambios({
    archivosCambiados: ['docs/a.md', 'docs/a.md', 'docs\\a.md'],
    writes: ['src/**'],
    protegidos: [],
  });
  assert.equal(r.violaciones.length, 1);
  assert.deepEqual(r.violaciones, [{ ruta: 'docs/a.md', motivo: 'fuera_de_alcance' }]);
});

test('verificarCambios: acumula varias violaciones en orden', () => {
  const r = verificarCambios({
    archivosCambiados: ['docs/a.md', '.env', 'src/a.js'],
    writes: ['src/**'],
    protegidos: ['**/.env'],
  });
  assert.deepEqual(r.violaciones, [
    { ruta: 'docs/a.md', motivo: 'fuera_de_alcance' },
    { ruta: '.env', motivo: 'protegido' },
  ]);
});

test('verificarCambios: entradas hostiles lanzan', () => {
  assert.throws(() => verificarCambios({ archivosCambiados: 'no-array' }), TypeError);
  assert.throws(() => verificarCambios({ writes: 'no-array' }), TypeError);
  assert.throws(() => verificarCambios({ protegidos: 'no-array' }), TypeError);
  assert.throws(() => verificarCambios({ archivosCambiados: [123] }), TypeError);
  assert.throws(() => verificarCambios({ modo: 'banana' }), /modo desconocido/);
});

// --- Corrección por universo (propiedad de soundness) -------------------------
//
// POR QUÉ: la guarda de bloqueos debe ser conservadora. La propiedad que de
// verdad importa es la de soundness: si DOS patrones alcanzan una misma ruta
// real, seSuperponen DEBE decir `true`. Como no podemos enumerar todas las
// rutas posibles, construimos un universo determinista y representativo y, para
// cada par de patrones, buscamos un testigo: si existe, exigimos `true`. Así un
// falso negativo se manifiesta con el par y la ruta que lo delata. También
// comprobamos la simetría, porque el planificador compara en ambos sentidos.

/** Construye el universo determinista de rutas (raíz + 3 niveles). */
function construirUniverso() {
  const archivos = ['a', 'b', 'src', 'docs', 'x.js', 'y.md', 'package.json', '.env'];
  const dirs = ['a', 'b', 'src', 'docs'];
  const rutas = new Set();

  for (const f of archivos) rutas.add(f); // raíz

  for (const d of dirs) {
    for (const f of archivos) rutas.add(`${d}/${f}`); // 1 nivel
  }

  for (const d1 of dirs) {
    for (const d2 of dirs) {
      for (const f of archivos) rutas.add(`${d1}/${d2}/${f}`); // 2 niveles
    }
  }

  for (const d1 of ['a', 'b', 'src']) {
    for (const d2 of ['a', 'b', 'docs']) {
      for (const d3 of ['src', 'docs']) {
        for (const f of ['x.js', 'y.md']) rutas.add(`${d1}/${d2}/${d3}/${f}`); // 3 niveles
      }
    }
  }

  return [...rutas];
}

/** Conjunto de patrones variados: literales y comodines en todas las posiciones. */
function construirPatrones() {
  return [
    // Literales de la raíz.
    'a', 'b', 'src', 'docs', 'x.js', 'y.md', 'package.json', '.env',
    // Literales en subdirectorios.
    'a/x.js', 'src/x.js', 'docs/x.js', 'a/b/x.js', 'src/docs/x.js', 'a/b/c', 'src/a/b',
    // Comodines en la raíz.
    '*', '?', '*.js', '*.md', '*.json', '*.txt', 'a*', '?.*', '**', '*.env', '?*', 'a?', '*a*', '?.js',
    // Comodines en subdirectorios.
    'src/*', 'src/*.js', 'src/**', 'docs/**', 'a/**', 'a/*', 'a/b/**', 'a/*/*.js', 'docs/*.md', 'docs/**/*.md',
    // Comodín en el primer segmento.
    '*/x.js', '*/**', '*/*.js', '*/a.js', '*/b/x.js',
    // '**' al inicio y en medio.
    '**/x.js', '**/*.md', '**/package.json', '**/.env', 'src/**/*.js', 'a/**/*.md', '**/src/**',
    'a/**/b', 'a/**/x.js', 'a/*/x.js', '**/docs/**', '**/*',
    // '?' y '*' dentro de segmentos de directorio.
    '?ocs/**', 'doc?/**', 's?c/**', 'a/?/x.js', 'src/x?', 'src/x*', 'src/x*/**', 'src/*/x.js',
    'a/b*', 'a/b*/**',
    // '**' no confinado a un segmento (fallback conservador).
    'src/a**', 'a**b',
  ];
}

test('seSuperponen: soundness sobre un universo (ruta común ⇒ true) y simetría', () => {
  const universo = construirUniverso();
  assert.ok(
    universo.length >= 150 && universo.length <= 300,
    `el universo debe tener entre 150 y 300 rutas, tiene ${universo.length}`,
  );

  const patrones = construirPatrones();
  assert.ok(patrones.length >= 60, `se esperaban al menos 60 patrones, hay ${patrones.length}`);

  // Precomputamos qué rutas alcanza cada patrón para no recompilar regex por par.
  const alcanza = patrones.map((p) => universo.map((r) => coincide(p, r)));

  let paresVerificados = 0;
  for (let i = 0; i < patrones.length; i += 1) {
    for (let j = 0; j < patrones.length; j += 1) {
      paresVerificados += 1;
      const a = patrones[i];
      const b = patrones[j];

      let testigo;
      for (let k = 0; k < universo.length; k += 1) {
        if (alcanza[i][k] && alcanza[j][k]) {
          testigo = universo[k];
          break;
        }
      }

      if (testigo !== undefined) {
        assert.equal(
          seSuperponen(a, b),
          true,
          `Falso negativo: "${a}" y "${b}" comparten la ruta "${testigo}"`,
        );
      }

      assert.equal(
        seSuperponen(a, b),
        seSuperponen(b, a),
        `Asimetría: "${a}" vs "${b}"`,
      );
    }
  }

  assert.ok(
    paresVerificados >= 60 * 60,
    `se esperaban al menos 3600 pares, se verificaron ${paresVerificados}`,
  );
});

test('verificarCambios: los protegidos NO distinguen mayúsculas (sistemas de archivos de Windows) pero writes sí', () => {
  const r = verificarCambios({
    archivosCambiados: ['Backend/prisma/MIGRATIONS/0001.sql', 'BACKEND/src/a.js', 'backend/src/b.js'],
    writes: ['backend/src/**', 'Backend/**'],
    protegidos: ['backend/prisma/migrations/**'],
    modo: 'safe',
  });
  assert.deepEqual(r.violaciones, [
    { ruta: 'Backend/prisma/MIGRATIONS/0001.sql', motivo: 'protegido' },
    { ruta: 'BACKEND/src/a.js', motivo: 'fuera_de_alcance' },
  ]);
});

test('escriturasEnRutaProtegida: marca los writes que caen dentro de una ruta protegida', async () => {
  const { escriturasEnRutaProtegida } = await import('../src/core/scope.js');
  const protegidos = ['backend/prisma/migrations/**', '**/.env'];
  assert.deepEqual(
    escriturasEnRutaProtegida(['backend/prisma/migrations/2026*/**', 'backend/src/**', 'backend/.env'], protegidos),
    [
      { write: 'backend/prisma/migrations/2026*/**', protegido: 'backend/prisma/migrations/**' },
      { write: 'backend/.env', protegido: '**/.env' },
    ],
  );
  // Un writes amplio que solo PODRÍA rozar un protegido no se marca (lo cubre la verificación final).
  assert.deepEqual(escriturasEnRutaProtegida(['backend/**'], protegidos), []);
});

test('escriturasEnRutaProtegida: proteger migraciones por nombre deja agregar una nueva', async () => {
  const { escriturasEnRutaProtegida } = await import('../src/core/scope.js');
  const protegidos = ['backend/prisma/migrations/0001_init/**', 'backend/prisma/migrations/migration_lock.toml'];
  assert.deepEqual(escriturasEnRutaProtegida(['backend/prisma/migrations/20261008*/**'], protegidos), []);
  assert.equal(escriturasEnRutaProtegida(['backend/prisma/migrations/0001_init/**'], protegidos).length, 1);
});

test('verificarCambios ignora el directorio reservado .orq (manifiesto de mutaciones)', () => {
  // `.orq` no es un cambio del trabajo: no puede violar el alcance ni siquiera en readonly.
  assert.deepEqual(
    verificarCambios({ archivosCambiados: ['.orq/mutaciones.json', 'subA/x.js'], writes: ['subA/**'], protegidos: [] }),
    { ok: true, violaciones: [] },
  );
  assert.equal(
    verificarCambios({ archivosCambiados: ['.orq/mutaciones.json'], writes: [], protegidos: [], modo: 'readonly' }).ok,
    true,
  );
  // Un archivo fuera de `.orq` sigue marcándose: el filtro no es un agujero.
  assert.equal(verificarCambios({ archivosCambiados: ['otro/x.js'], writes: ['subA/**'] }).ok, false);
});
