import test from 'node:test';
import assert from 'node:assert/strict';

import { elegibles } from '../src/core/planificador.js';

const REPO = 'app';
const AHORA = 1_000_000;

/**
 * Descriptor de trabajo con defaults cómodos para las pruebas.
 * @param {object} [extra]
 * @returns {object}
 */
function job(extra = {}) {
  return {
    repo: REPO,
    mode: 'safe',
    isolation: 'worktree',
    writes: [],
    reads: ['**'],
    resources: [],
    after: [],
    prioridad: 0,
    ...extra,
  };
}

/** Motivo único de bloqueo por dependencia. */
const DEP = { motivo: 'bloqueado_por_dependencia' };

/**
 * Tabla de escenarios: cada uno con su entrada y el resultado esperado calculado
 * a mano. Se ejecutan todos con el mismo arnés.
 */
const ESCENARIOS = [
  {
    nombre: 'cola vacía no arranca nada',
    entrada: { cola: [], corriendo: [], concurrencia: 2, trabajos: {} },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'un trabajo listo arranca',
    entrada: { cola: ['a'], corriendo: [], concurrencia: 1, trabajos: { a: job({ estado: 'queued' }) } },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'trabajos de repos distintos arrancan en paralelo',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 2,
      trabajos: { a: job({ repo: 'r1' }), b: job({ repo: 'r2' }) },
    },
    esperado: { arrancar: ['a', 'b'], bloqueados: [] },
  },
  {
    nombre: 'FIFO con concurrencia 1',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job(), b: job() },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'mayor prioridad primero',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ prioridad: 0 }), b: job({ prioridad: 5 }) },
    },
    esperado: { arrancar: ['b'], bloqueados: [] },
  },
  {
    nombre: 'empate de prioridad se resuelve por llegada',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ prioridad: 3 }), b: job({ prioridad: 3 }) },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'concurrencia llena no arranca nada',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 1,
      trabajos: { a: job(), x: job() },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'respeta los huecos libres exactos',
    entrada: {
      cola: ['a', 'b'],
      corriendo: ['x', 'y'],
      concurrencia: 3,
      trabajos: { a: job(), b: job(), x: job(), y: job() },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'after succeeded permite arrancar',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ after: ['d'] }), d: job({ estado: 'succeeded' }) },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'after pendiente no arranca ni bloquea',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ after: ['d'] }), d: job({ estado: 'queued' }) },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'after failed bloquea',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ after: ['d'] }), d: job({ estado: 'failed' }) },
    },
    esperado: { arrancar: [], bloqueados: [{ id: 'a', ...DEP }] },
  },
  {
    nombre: 'after rejected bloquea',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ after: ['d'] }), d: job({ estado: 'rejected' }) },
    },
    esperado: { arrancar: [], bloqueados: [{ id: 'a', ...DEP }] },
  },
  {
    nombre: 'after cancelled bloquea',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ after: ['d'] }), d: job({ estado: 'cancelled' }) },
    },
    esperado: { arrancar: [], bloqueados: [{ id: 'a', ...DEP }] },
  },
  {
    nombre: 'after lost bloquea',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ after: ['d'] }), d: job({ estado: 'lost' }) },
    },
    esperado: { arrancar: [], bloqueados: [{ id: 'a', ...DEP }] },
  },
  {
    nombre: 'un trabajo bloqueado no impide arrancar al siguiente',
    entrada: {
      cola: ['b', 'a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job(), b: job({ after: ['muerto'] }), muerto: job({ estado: 'failed' }) },
    },
    esperado: { arrancar: ['a'], bloqueados: [{ id: 'b', ...DEP }] },
  },
  {
    nombre: 'escritor none choca con otro escritor none del mismo repo solapado',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'none', writes: ['src/a.js'], reads: [] }),
        x: job({ isolation: 'none', writes: ['src/**'], reads: [] }),
      },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'escritores none con patrones disjuntos no chocan',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'none', writes: ['docs/**'], reads: [] }),
        x: job({ isolation: 'none', writes: ['src/**'], reads: [] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'repos distintos no chocan aunque escriban lo mismo',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ repo: 'r2', isolation: 'none', writes: ['src/**'], reads: [] }),
        x: job({ repo: 'r1', isolation: 'none', writes: ['src/**'], reads: [] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'escritor none choca con un readonly none que lee todo',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'none', writes: ['src/**'], reads: [] }),
        x: job({ isolation: 'none', mode: 'readonly', writes: [], reads: ['**'] }),
      },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'readonly none no choca con otro readonly none',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'none', mode: 'readonly', writes: [], reads: ['**'] }),
        x: job({ isolation: 'none', mode: 'readonly', writes: [], reads: ['**'] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'dos worktree con writes solapados se serializan',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'worktree', writes: ['src/a.js'], reads: [] }),
        x: job({ isolation: 'worktree', writes: ['src/**'], reads: [] }),
      },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'dos worktree con writes disjuntos corren en paralelo',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'worktree', writes: ['docs/**'], reads: [] }),
        x: job({ isolation: 'worktree', writes: ['src/**'], reads: [] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'serializarEscrituras=false permite solapar writes de worktrees',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      serializarEscrituras: false,
      trabajos: {
        a: job({ isolation: 'worktree', writes: ['src/a.js'], reads: [] }),
        x: job({ isolation: 'worktree', writes: ['src/**'], reads: [] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'conflicto dentro de la misma pasada: solo arranca el primero',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'worktree', writes: ['src/**'], reads: [] }),
        b: job({ isolation: 'worktree', writes: ['src/b.js'], reads: [] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'recurso exclusivo ocupado impide arrancar',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      recursos: { db: 1 },
      trabajos: { a: job({ resources: ['db'] }), x: job({ resources: ['db'] }) },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'recurso con capacidad 2 admite un segundo trabajo',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      recursos: { db: 2 },
      trabajos: { a: job({ resources: ['db'] }), x: job({ resources: ['db'] }) },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'recurso con capacidad 2 saturado no arranca',
    entrada: {
      cola: ['a'],
      corriendo: ['x', 'y'],
      concurrencia: 3,
      recursos: { db: 2 },
      trabajos: { a: job({ resources: ['db'] }), x: job({ resources: ['db'] }), y: job({ resources: ['db'] }) },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'recursos distintos no se estorban',
    entrada: {
      cola: ['a'],
      corriendo: ['x'],
      concurrencia: 2,
      recursos: { db: 1 },
      trabajos: { a: job({ resources: ['cache'] }), x: job({ resources: ['db'] }) },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'anti-inanición: el veterano reserva su lugar',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 1,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      trabajos: {
        a: job({ isolation: 'none', writes: ['src/**'], reads: [], encoladoEn: AHORA - 100000, prioridad: 0 }),
        b: job({ isolation: 'none', writes: ['src/b.js'], reads: [], prioridad: 10 }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    // Regresión (cola estancada en vivo): dos veteranos que chocan entre sí, sin nadie
    // corriendo, se bloqueaban mutuamente. Debe arrancar el primero del orden.
    nombre: 'anti-inanición: dos veteranos en conflicto no se bloquean entre sí (arranca el primero)',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 3,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      trabajos: {
        a: job({ writes: ['src/x.js'], reads: [], encoladoEn: AHORA - 100000 }),
        b: job({ writes: ['src/x.js'], reads: [], encoladoEn: AHORA - 90000 }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'anti-inanición: tres veteranos en conflicto arrancan de a uno en orden de llegada y prioridad',
    entrada: {
      cola: ['a', 'b', 'c'],
      corriendo: [],
      concurrencia: 3,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      trabajos: {
        a: job({ writes: ['src/x.js'], reads: [], encoladoEn: AHORA - 100000, prioridad: 0 }),
        b: job({ writes: ['src/x.js'], reads: [], encoladoEn: AHORA - 90000, prioridad: 5 }),
        c: job({ writes: ['src/x.js'], reads: [], encoladoEn: AHORA - 80000, prioridad: 0 }),
      },
    },
    esperado: { arrancar: ['b'], bloqueados: [] },
  },
  {
    nombre: 'sin superar la espera máxima, gana la prioridad',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 1,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      trabajos: {
        a: job({ isolation: 'none', writes: ['src/**'], reads: [], encoladoEn: AHORA - 500, prioridad: 0 }),
        b: job({ isolation: 'none', writes: ['src/b.js'], reads: [], prioridad: 10 }),
      },
    },
    esperado: { arrancar: ['b'], bloqueados: [] },
  },
  {
    nombre: 'el veterano no bloquea a un candidato no conflictivo',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 1,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      trabajos: {
        a: job({ isolation: 'none', writes: ['src/**'], reads: [], encoladoEn: AHORA - 100000, prioridad: 0 }),
        b: job({ isolation: 'none', writes: ['docs/**'], reads: [], prioridad: 10 }),
      },
    },
    esperado: { arrancar: ['b'], bloqueados: [] },
  },
  {
    nombre: 'varios bloqueados se reportan en orden de cola',
    entrada: {
      cola: ['x', 'y'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        x: job({ after: ['muerto'] }),
        y: job({ after: ['muerto'] }),
        muerto: job({ estado: 'failed' }),
      },
    },
    esperado: { arrancar: [], bloqueados: [{ id: 'x', ...DEP }, { id: 'y', ...DEP }] },
  },
  {
    nombre: 'una prioridad conflictiva no bloquea a la siguiente compatible',
    entrada: {
      cola: ['a', 'b'],
      corriendo: ['x'],
      concurrencia: 2,
      trabajos: {
        a: job({ isolation: 'none', writes: ['src/a.js'], reads: [], prioridad: 5 }),
        b: job({ isolation: 'none', writes: ['docs/**'], reads: [], prioridad: 0 }),
        x: job({ isolation: 'none', writes: ['src/**'], reads: [] }),
      },
    },
    esperado: { arrancar: ['b'], bloqueados: [] },
  },
  {
    nombre: 'varias dependencias: una fallida bloquea',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: {
        a: job({ after: ['d1', 'd2'] }),
        d1: job({ estado: 'succeeded' }),
        d2: job({ estado: 'failed' }),
      },
    },
    esperado: { arrancar: [], bloqueados: [{ id: 'a', ...DEP }] },
  },
  {
    // Bug (a): `merged` es un `succeeded` ya integrado y debe satisfacer igual.
    nombre: 'after merged (ya integrado) satisface la dependencia',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: { a: job({ after: ['d'] }), d: job({ estado: 'merged' }) },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'after succeeded y merged a la vez satisface',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 1,
      trabajos: {
        a: job({ after: ['d1', 'd2'] }),
        d1: job({ estado: 'succeeded' }),
        d2: job({ estado: 'merged' }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    // Bug (b): el veterano v necesita db+cache; db está ocupado (no puede arrancar
    // todavía). El candidato c compite por cache y, sin el arreglo, se adelantaría.
    nombre: 'anti-inanición: no adelantar a un veterano bloqueado por recurso',
    entrada: {
      cola: ['v', 'c'],
      corriendo: ['x'],
      concurrencia: 2,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      recursos: { db: 1, cache: 1 },
      trabajos: {
        v: job({ resources: ['db', 'cache'], encoladoEn: AHORA - 100000, prioridad: 0 }),
        c: job({ resources: ['cache'], prioridad: 10 }),
        x: job({ resources: ['db'] }),
      },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    // Bug (b) con capacidad > 1: hay hueco para db (capacidad 2, x usa 1), pero si
    // el candidato se adelanta consume el último hueco y el veterano no arranca.
    nombre: 'anti-inanición: recurso con capacidad 2 no deja adelantar al candidato',
    entrada: {
      cola: ['v', 'c'],
      corriendo: ['x'],
      concurrencia: 2,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      recursos: { db: 2 },
      trabajos: {
        v: job({ resources: ['db'], encoladoEn: AHORA - 100000, prioridad: 0 }),
        c: job({ resources: ['db'], prioridad: 10 }),
        x: job({ resources: ['db'] }),
      },
    },
    esperado: { arrancar: ['v'], bloqueados: [] },
  },
  {
    // La reserva por recurso solo aplica cuando hay recurso compartido: un candidato
    // con recursos disjuntos sigue arrancando (y en su orden de prioridad).
    nombre: 'anti-inanición por recurso no bloquea a un candidato sin recurso común',
    entrada: {
      cola: ['v', 'c'],
      corriendo: [],
      concurrencia: 2,
      ahora: AHORA,
      esperaMaximaMs: 60000,
      recursos: { db: 1 },
      trabajos: {
        v: job({ isolation: 'none', writes: ['src/**'], reads: [], resources: ['db'], encoladoEn: AHORA - 100000, prioridad: 0 }),
        c: job({ isolation: 'none', writes: ['docs/**'], reads: [], resources: ['cache'], prioridad: 10 }),
      },
    },
    esperado: { arrancar: ['c', 'v'], bloqueados: [] },
  },
  {
    // `esperarIntegracion`: no partir de una base que quedará obsoleta cuando integren
    // al anterior (hoy arranca y el conflicto aparece recién en el merge).
    nombre: 'esperarIntegracion: no arranca si otro succeeded integrable del mismo repo solapa writes',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'], esperarIntegracion: true }),
        previo: job({ estado: 'succeeded', integrable: true, writes: ['src/a.js'] }),
      },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    // Hallazgo real: un `succeeded` SIN commit no se puede integrar; si frenara, la cola
    // quedaría trabada para siempre ('no produjo ningún commit').
    nombre: 'esperarIntegracion: un succeeded sin commit NO frena (no es integrable)',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'], esperarIntegracion: true }),
        previo: job({ estado: 'succeeded', writes: ['src/a.js'] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    // También cuando el no-integrable viene dado por `resultado.commit` ausente/null.
    nombre: 'esperarIntegracion: un succeeded con resultado.commit vacío no frena',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'], esperarIntegracion: true }),
        previo: job({ estado: 'succeeded', resultado: { commit: null }, writes: ['src/a.js'] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    // Un `succeeded` con commit se detecta igual aunque no venga el booleano explícito.
    nombre: 'esperarIntegracion: un succeeded con resultado.commit deriva integrable y frena',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'], esperarIntegracion: true }),
        previo: job({ estado: 'succeeded', resultado: { commit: 'abc123' }, writes: ['src/a.js'] }),
      },
    },
    esperado: { arrancar: [], bloqueados: [] },
  },
  {
    nombre: 'esperarIntegracion: un merged (ya integrado) no frena',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'], esperarIntegracion: true }),
        previo: job({ estado: 'merged', integrable: true, writes: ['src/a.js'] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'esperarIntegracion: un cancelado o rechazado no frena',
    entrada: {
      cola: ['a', 'b'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'], esperarIntegracion: true }),
        b: job({ writes: ['docs/**'], esperarIntegracion: true }),
        cancelado: job({ estado: 'cancelled', integrable: true, writes: ['src/a.js'] }),
        rechazado: job({ estado: 'rejected', integrable: true, writes: ['docs/x.md'] }),
      },
    },
    esperado: { arrancar: ['a', 'b'], bloqueados: [] },
  },
  {
    nombre: 'esperarIntegracion: writes disjuntos no frenan',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'], esperarIntegracion: true }),
        previo: job({ estado: 'succeeded', writes: ['docs/**'] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'esperarIntegracion apagado por defecto: arranca aunque solape',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ writes: ['src/**'] }),
        previo: job({ estado: 'succeeded', writes: ['src/a.js'] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
  {
    nombre: 'esperarIntegracion: repos distintos no se frenan',
    entrada: {
      cola: ['a'],
      corriendo: [],
      concurrencia: 2,
      trabajos: {
        a: job({ repo: 'r2', writes: ['src/**'], esperarIntegracion: true }),
        previo: job({ repo: 'r1', estado: 'succeeded', writes: ['src/a.js'] }),
      },
    },
    esperado: { arrancar: ['a'], bloqueados: [] },
  },
];

for (const escenario of ESCENARIOS) {
  test(`planificador: ${escenario.nombre}`, () => {
    // `esperas` (el porqué de cada espera) se prueba aparte: acá solo la decisión.
    const { arrancar, bloqueados } = elegibles(escenario.entrada);
    assert.deepEqual({ arrancar, bloqueados }, escenario.esperado);
  });
}

test('planificador: esperas explica quién frena a cada trabajo en cola', () => {
  const r = elegibles({
    cola: ['dep', 'solapa', 'recurso', 'libre'],
    corriendo: ['en-curso'],
    concurrencia: 4,
    recursos: { db: 1 },
    trabajos: {
      'en-curso': job({ writes: ['src/a.js'], resources: ['db'] }),
      previo: job({ estado: 'running' }),
      dep: job({ after: ['previo'] }),
      solapa: job({ writes: ['src/a.js'] }),
      recurso: job({ writes: ['docs/x.md'], resources: ['db'] }),
      libre: job({ writes: ['otro/z.js'] }),
    },
  });
  assert.deepEqual(r.arrancar, ['libre']);
  assert.deepEqual(r.esperas.get('dep'), { motivo: 'dependencia', por: ['previo'] });
  assert.deepEqual(r.esperas.get('solapa'), { motivo: 'solapa_alcance', por: ['en-curso'] });
  assert.deepEqual(r.esperas.get('recurso'), { motivo: 'recurso', por: ['en-curso'] });
  assert.equal(r.esperas.has('libre'), false, 'el que arranca no tiene espera');
});

test('planificador: esperas marca el tope global cuando no hay otro motivo', () => {
  const r = elegibles({
    cola: ['a', 'b'],
    corriendo: [],
    concurrencia: 1,
    trabajos: { a: job({ writes: ['x/**'] }), b: job({ writes: ['y/**'] }) },
  });
  assert.deepEqual(r.arrancar, ['a']);
  assert.deepEqual(r.esperas.get('b'), { motivo: 'tope_global', por: ['a'] });
});

test('planificador: tope por repo limita aunque el global tenga hueco', () => {
  const r = elegibles({
    cola: ['a', 'b', 'c'],
    corriendo: [],
    concurrencia: 8,
    trabajos: {
      a: job({ repo: 'r1', concurrenciaRepo: 1, writes: ['a/**'] }),
      b: job({ repo: 'r1', concurrenciaRepo: 1, writes: ['b/**'] }),
      c: job({ repo: 'r2', concurrenciaRepo: 1, writes: ['c/**'] }),
    },
  });
  assert.deepEqual(r.arrancar, ['a', 'c']);
  assert.deepEqual(r.esperas.get('b'), { motivo: 'tope_del_repo', por: ['a'] });
});

test('planificador: topes de repo distintos se aplican por separado', () => {
  const r = elegibles({
    cola: ['a2', 'a3', 'b2'],
    corriendo: ['a1'],
    concurrencia: 8,
    trabajos: {
      a1: job({ repo: 'r1', concurrenciaRepo: 2 }),
      a2: job({ repo: 'r1', concurrenciaRepo: 2, writes: ['a2/**'] }),
      a3: job({ repo: 'r1', concurrenciaRepo: 2, writes: ['a3/**'] }),
      b2: job({ repo: 'r2', concurrenciaRepo: 3, writes: ['b2/**'] }),
    },
  });
  assert.deepEqual(r.arrancar, ['a2', 'b2']);
  assert.deepEqual(r.esperas.get('a3'), { motivo: 'tope_del_repo', por: ['a1', 'a2'] });
});

test('planificador: el tope global gana como motivo si también se alcanzó el del repo', () => {
  const r = elegibles({
    cola: ['b'],
    corriendo: ['a'],
    concurrencia: 1,
    trabajos: {
      a: job({ repo: 'r1', concurrenciaRepo: 1 }),
      b: job({ repo: 'r1', concurrenciaRepo: 1, writes: ['b/**'] }),
    },
  });
  assert.deepEqual(r.arrancar, []);
  assert.deepEqual(r.esperas.get('b'), { motivo: 'tope_global', por: ['a'] });
});

test('planificador: entradas hostiles lanzan TypeError', () => {
  assert.throws(() => elegibles({ cola: 'x', corriendo: [], concurrencia: 1, trabajos: {} }), TypeError);
  assert.throws(() => elegibles({ cola: [], corriendo: 'x', concurrencia: 1, trabajos: {} }), TypeError);
});

test('planificador: concurrencia inválida se trata como 0', () => {
  const resultado = elegibles({ cola: ['a'], corriendo: [], concurrencia: -1, trabajos: { a: job() } });
  assert.deepEqual(resultado.arrancar, []);
  assert.deepEqual(resultado.bloqueados, []);
});

test('planificador: esperarIntegracion explica a qué ids espera', () => {
  const r = elegibles({
    cola: ['a', 'libre'],
    corriendo: [],
    concurrencia: 3,
    trabajos: {
      a: job({ writes: ['src/**'], esperarIntegracion: true }),
      previoA: job({ estado: 'succeeded', integrable: true, writes: ['src/a.js'] }),
      previoB: job({ estado: 'succeeded', integrable: true, writes: ['src/b.js'] }),
      libre: job({ writes: ['docs/**'], esperarIntegracion: true }),
    },
  });
  assert.deepEqual(r.arrancar, ['libre']);
  assert.deepEqual(r.esperas.get('a'), { motivo: 'esperando_integracion', por: ['previoA', 'previoB'] });
  assert.equal(r.esperas.has('libre'), false);
});
