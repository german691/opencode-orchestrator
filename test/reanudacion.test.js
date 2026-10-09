import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIRMAS_TRANSPORTE,
  ErrorDeReanudacion,
  esFalloDeTransporte,
  decidirReanudacion,
  configReanudacion,
  textoAdvertencia,
} from '../src/core/reanudacion.js';

/** Un stderr típico del corte real (exit 130) reportado en vivo. */
const STDERR_TRANSPORTE = 'Error: Transport: The socket connection was closed unexpectedly\n';

test('FIRMAS_TRANSPORTE cubre las marcas de corte de transporte observadas', () => {
  const obligatorias = [
    /Transport: The socket connection was closed unexpectedly/i,
    /socket hang up/i,
    /ECONNRESET/i,
    /fetch failed/i,
    /UND_ERR_SOCKET/i,
    /other side closed/i,
  ];
  assert.ok(Array.isArray(FIRMAS_TRANSPORTE));
  for (const firma of obligatorias) {
    assert.ok(
      FIRMAS_TRANSPORTE.some((f) => f.source === firma.source && f.flags === firma.flags),
      `falta la firma ${firma}`,
    );
  }
});

test('esFalloDeTransporte reconoce CADA firma cuando el proceso murió con 130', () => {
  const muestras = [
    'Transport: The socket connection was closed unexpectedly',
    'Error: socket hang up',
    'read ECONNRESET',
    'TypeError: fetch failed',
    'Error [UND_ERR_SOCKET]: other side closed',
    'other side closed',
  ];
  for (const muestra of muestras) {
    assert.equal(
      esFalloDeTransporte({ codigo: 130, motivo: 'exit', stderr: muestra, stdout: '' }),
      true,
      `no reconoció: ${muestra}`,
    );
  }
});

test('esFalloDeTransporte mira stderr y stdout, y solo la cola de 8 KB', () => {
  assert.equal(esFalloDeTransporte({ codigo: 130, motivo: 'exit', stderr: '', stdout: STDERR_TRANSPORTE }), true);
  // La firma vieja, tapada por más de 8 KB de salida reciente, ya no cuenta.
  const enterrada = `${STDERR_TRANSPORTE}${'x'.repeat(9000)}`;
  assert.equal(esFalloDeTransporte({ codigo: 130, motivo: 'exit', stderr: enterrada }), false);
});

test('esFalloDeTransporte exige corte anormal (código != 0 o motivo idle/error_interno)', () => {
  // Firma presente pero salida limpia: el agente imprimió un error de red de su test, no murió.
  assert.equal(esFalloDeTransporte({ codigo: 0, motivo: 'exit', stderr: STDERR_TRANSPORTE }), false);
  assert.equal(esFalloDeTransporte({ codigo: null, motivo: 'exit', stderr: STDERR_TRANSPORTE }), false);
  // Cualquier código distinto de cero con firma sí es reanudable.
  assert.equal(esFalloDeTransporte({ codigo: 1, motivo: 'exit', stderr: STDERR_TRANSPORTE }), true);
  // Idle: el servidor cortó por inactividad y el socket trae la firma.
  assert.equal(esFalloDeTransporte({ codigo: 0, motivo: 'idle', stderr: STDERR_TRANSPORTE }), true);
  assert.equal(esFalloDeTransporte({ codigo: null, motivo: 'error_interno', stderr: STDERR_TRANSPORTE }), true);
});

test('esFalloDeTransporte no da falsos positivos con salidas normales', () => {
  assert.equal(esFalloDeTransporte({ codigo: 1, motivo: 'exit', stderr: 'FAIL src/a.test.js\nAssertionError\n', stdout: 'ok 1 - algo' }), false);
  assert.equal(esFalloDeTransporte({ codigo: 0, motivo: 'exit', stderr: '', stdout: '' }), false);
  assert.equal(esFalloDeTransporte(), false);
});

test('los cortes deliberados del servidor NUNCA se reanudan, ni con firma presente', () => {
  for (const motivo of ['timeout', 'cancelado', 'alcance', 'sin_progreso']) {
    // codigo 130 + firma presente: sin el guardián de cortes deliberados daría true.
    assert.equal(
      esFalloDeTransporte({ codigo: 130, motivo, stderr: STDERR_TRANSPORTE }),
      false,
      `no debería reanudar ${motivo}`,
    );
  }
});

test('decidirReanudacion: deshabilitada o sin fallo de transporte no hace nada', () => {
  assert.deepEqual(
    decidirReanudacion({ fallo: { codigo: 130, stderr: STDERR_TRANSPORTE }, hayCambiosEnAlcance: true, config: { habilitado: false, maxRelanzamientos: 1 } }),
    { accion: 'ninguna', motivo: 'reanudacion_deshabilitada' },
  );
  assert.deepEqual(
    decidirReanudacion({ fallo: { codigo: 1, motivo: 'exit', stderr: 'AssertionError' }, hayCambiosEnAlcance: true, config: { habilitado: true, maxRelanzamientos: 1 } }),
    { accion: 'ninguna', motivo: 'no_es_fallo_de_transporte' },
  );
});

test('decidirReanudacion: con cambios en alcance continúa (aunque no queden relanzamientos)', () => {
  assert.deepEqual(
    decidirReanudacion({ fallo: { codigo: 130, stderr: STDERR_TRANSPORTE }, hayCambiosEnAlcance: true, relanzamientosPrevios: 9, config: { habilitado: true, maxRelanzamientos: 1 } }),
    { accion: 'continuar', motivo: 'hay_cambios_para_verificar' },
  );
});

test('decidirReanudacion: sin cambios relanza hasta el límite y luego no hace nada', () => {
  const config = { habilitado: true, maxRelanzamientos: 1 };
  const fallo = { codigo: 130, stderr: STDERR_TRANSPORTE };
  assert.deepEqual(
    decidirReanudacion({ fallo, hayCambiosEnAlcance: false, relanzamientosPrevios: 0, config }),
    { accion: 'relanzar', motivo: 'sin_cambios_con_intentos_disponibles' },
  );
  assert.deepEqual(
    decidirReanudacion({ fallo, hayCambiosEnAlcance: false, relanzamientosPrevios: 1, config }),
    { accion: 'ninguna', motivo: 'limite_de_relanzamientos_alcanzado' },
  );
  // maxRelanzamientos 0: nunca relanza.
  assert.deepEqual(
    decidirReanudacion({ fallo, hayCambiosEnAlcance: false, config: { habilitado: true, maxRelanzamientos: 0 } }),
    { accion: 'ninguna', motivo: 'limite_de_relanzamientos_alcanzado' },
  );
});

test('decidirReanudacion: config ausente usa los valores por defecto (habilitado, 1 relanzamiento)', () => {
  const fallo = { codigo: 130, stderr: STDERR_TRANSPORTE };
  assert.deepEqual(
    decidirReanudacion({ fallo, hayCambiosEnAlcance: false }),
    { accion: 'relanzar', motivo: 'sin_cambios_con_intentos_disponibles' },
  );
  assert.deepEqual(
    decidirReanudacion({ fallo, hayCambiosEnAlcance: false, relanzamientosPrevios: 1 }),
    { accion: 'ninguna', motivo: 'limite_de_relanzamientos_alcanzado' },
  );
});

test('configReanudacion normaliza ausente, vacía y válida', () => {
  assert.deepEqual(configReanudacion(undefined), { habilitado: true, maxRelanzamientos: 1 });
  assert.deepEqual(configReanudacion(null), { habilitado: true, maxRelanzamientos: 1 });
  assert.deepEqual(configReanudacion({}), { habilitado: true, maxRelanzamientos: 1 });
  assert.deepEqual(configReanudacion({ habilitado: false }), { habilitado: false, maxRelanzamientos: 1 });
  assert.deepEqual(configReanudacion({ maxRelanzamientos: 0 }), { habilitado: true, maxRelanzamientos: 0 });
  assert.deepEqual(configReanudacion({ habilitado: false, maxRelanzamientos: 3 }), { habilitado: false, maxRelanzamientos: 3 });
});

test('configReanudacion rechaza valores inválidos con mensajes claros', () => {
  const casos = [
    [{ maxRelanzamientos: 4 }, /maxRelanzamientos: debe ser un entero entre 0 y 3/],
    [{ maxRelanzamientos: -1 }, /maxRelanzamientos/],
    [{ maxRelanzamientos: 1.5 }, /maxRelanzamientos/],
    [{ maxRelanzamientos: '1' }, /maxRelanzamientos/],
    [{ habilitado: 'si' }, /habilitado: debe ser un booleano/],
    [{ desconocido: 1 }, /desconocido: campo desconocido/],
  ];
  for (const [entrada, esperado] of casos) {
    assert.throws(
      () => configReanudacion(entrada),
      (error) => {
        assert.ok(error instanceof ErrorDeReanudacion);
        assert.match(error.message, esperado);
        assert.ok(Array.isArray(error.errores));
        return true;
      },
      `no rechazó ${JSON.stringify(entrada)}`,
    );
  }
});

test('configReanudacion rechaza una sección que no es objeto', () => {
  for (const entrada of [true, 1, 'x', []]) {
    assert.throws(() => configReanudacion(entrada), ErrorDeReanudacion);
  }
});

test('textoAdvertencia redacta en español según la acción y los minutos', () => {
  const fallo = { duracionMs: 14 * 60 * 1000 };
  assert.equal(
    textoAdvertencia({ accion: 'continuar', motivo: 'hay_cambios_para_verificar' }, fallo),
    'REANUDADO: el agente murió por corte de transporte tras 14 min; se verificó alcance y aceptación sobre lo que dejó.',
  );
  assert.match(
    textoAdvertencia({ accion: 'relanzar', motivo: 'sin_cambios_con_intentos_disponibles' }, fallo),
    /^RELANZADO: el agente murió por corte de transporte tras 14 min sin dejar cambios/,
  );
  assert.match(
    textoAdvertencia({ accion: 'ninguna', motivo: 'reanudacion_deshabilitada' }),
    /^SIN REANUDAR: reanudacion_deshabilitada/,
  );
});
