#!/usr/bin/env node
// Fixture ejecutable que imita a `opencode run` para los tests del gestor (§12.2).
//
// Se invoca con `process.execPath` (no depende del bit de ejecución) y se
// parametriza por variables ORQ_FAKE_*:
//   ORQ_FAKE_ESCRIBIR='ruta1;ruta2'  escribe esos archivos (relativos al cwd), creando directorios
//   ORQ_FAKE_DORMIR=<ms>            espera antes de salir
//   ORQ_FAKE_SALIDA_BYTES=<n>       imprime n bytes por stdout
//   ORQ_FAKE_SALIDA_CODIGO=<n>      código de salida
//   ORQ_FAKE_IGNORA_TERM=1          ignora SIGTERM (para forzar el SIGKILL del grupo)
//   ORQ_FAKE_NIETO=1                lanza un nieto de larga vida y anota su pid en ORQ_FAKE_PIDFILE
//   ORQ_FAKE_VOLCADO=<ruta>         vuelca args + variables relevantes + la config apuntada, en JSON
//   ORQ_FAKE_REVISOR=<texto>        si la invocación es del REVISOR (su prompt exige VEREDICTO:),
//                                   imprime este texto y sale (vacío = respuesta ilegible)
//   ORQ_FAKE_REVISOR_CODIGO=<n>     código de salida del revisor (por defecto 0)
//   ORQ_FAKE_REVISOR_DORMIR=<ms>    espera antes de responder como revisor (para forzar timeout)
//
// Proceso auxiliar, no prueba: el runner de tests de node ejecuta todo .js bajo test/.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const env = process.env;

/** Convierte a número finito o devuelve el valor por defecto. */
const aNumero = (valor, porDefecto = 0) => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
};

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (env.ORQ_FAKE_IGNORA_TERM === '1') {
  process.on('SIGTERM', () => {
    /* ignora a propósito para forzar SIGKILL */
  });
}

// 0) Revisor automático: SOLO cuando la invocación es del revisor (su prompt siempre
// exige un `VEREDICTO:`), se devuelve la respuesta fija pedida por ORQ_FAKE_REVISOR y se
// sale ANTES de escribir archivos pensados para el agente principal. Se discrimina por
// el prompt y no por una variable extra: así el fixture no obliga a cambiar el gestor.
const argumentos = process.argv.slice(2);
const esRevision = argumentos.some(
  (argumento) => argumento.includes('REVISOR AUTOMÁTICO') || argumento.includes('VEREDICTO: APRUEBA'),
);
if (env.ORQ_FAKE_REVISOR !== undefined && esRevision) {
  const demoraRevision = Math.max(0, Math.trunc(aNumero(env.ORQ_FAKE_REVISOR_DORMIR)));
  if (demoraRevision > 0) await dormir(demoraRevision);
  if (env.ORQ_FAKE_REVISOR !== '') process.stdout.write(env.ORQ_FAKE_REVISOR);
  process.exit(Math.trunc(aNumero(env.ORQ_FAKE_REVISOR_CODIGO)) & 0xff);
}

// 1) Escribe archivos indicados, creando los directorios necesarios.
const archivos = String(env.ORQ_FAKE_ESCRIBIR || '')
  .split(';')
  .map((r) => r.trim())
  .filter((r) => r !== '');
for (const relativa of archivos) {
  const destino = path.resolve(process.cwd(), relativa);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, `escrito por opencode-falso: ${relativa}\n`);
}

// 1b) Archivos con CONTENIDO exacto: `ORQ_FAKE_ESCRIBIR_CONTENIDO='[{"ruta":"...","contenido":"..."}]'`.
// Se usa para el manifiesto de mutaciones (`.orq/mutaciones.json`), que debe ser JSON válido.
const conContenido = String(env.ORQ_FAKE_ESCRIBIR_CONTENIDO || '');
if (conContenido !== '') {
  for (const item of JSON.parse(conContenido)) {
    const destino = path.resolve(process.cwd(), item.ruta);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, item.contenido);
  }
}

// 2) Nieto de larga vida (mismo grupo de procesos); anota su pid.
if (env.ORQ_FAKE_NIETO === '1') {
  const nieto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (env.ORQ_FAKE_PIDFILE) {
    const archivoPid = path.resolve(env.ORQ_FAKE_PIDFILE);
    fs.mkdirSync(path.dirname(archivoPid), { recursive: true });
    fs.writeFileSync(archivoPid, String(nieto.pid));
  }
}

// 3) Volcado para inspección (args, entorno relevante y contenido de la config).
if (env.ORQ_FAKE_VOLCADO) {
  let config = null;
  if (env.OPENCODE_CONFIG) {
    try {
      config = fs.readFileSync(env.OPENCODE_CONFIG, 'utf8');
    } catch {
      config = null;
    }
  }
  const volcado = {
    args: process.argv.slice(2),
    cwd: process.cwd(),
    opencodeConfig: env.OPENCODE_CONFIG ?? null,
    opencodeConfigDir: env.OPENCODE_CONFIG_DIR ?? null,
    config,
    env: {
      ORQ_FAKE_ESCRIBIR: env.ORQ_FAKE_ESCRIBIR ?? null,
      ORQ_FAKE_DORMIR: env.ORQ_FAKE_DORMIR ?? null,
      ORQ_FAKE_SALIDA_BYTES: env.ORQ_FAKE_SALIDA_BYTES ?? null,
      ORQ_FAKE_SALIDA_CODIGO: env.ORQ_FAKE_SALIDA_CODIGO ?? null,
      ORQ_FAKE_IGNORA_TERM: env.ORQ_FAKE_IGNORA_TERM ?? null,
      ORQ_FAKE_NIETO: env.ORQ_FAKE_NIETO ?? null,
      ORQ_FAKE_PIDFILE: env.ORQ_FAKE_PIDFILE ?? null,
      // POR QUÉ además las variables del Gestor: los tests de integración
      // comprueban que ORQ_JOB_ID/ORQ_WORKTREE/ORQ_BRANCH y las de recursos
      // (p. ej. TEST_DATABASE_URL) llegan de verdad al proceso de opencode.
      ORQ_JOB_ID: env.ORQ_JOB_ID ?? null,
      PWD: env.PWD ?? null,
      ORQ_WORKTREE: env.ORQ_WORKTREE ?? null,
      ORQ_BRANCH: env.ORQ_BRANCH ?? null,
      TEST_DATABASE_URL: env.TEST_DATABASE_URL ?? null,
      // Credenciales de administración: NUNCA deben llegar al trabajo (ver gestor.js).
      ORQ_PG_ADMIN_URL: env.ORQ_PG_ADMIN_URL ?? null,
      OTRA_ADMIN_URL: env.OTRA_ADMIN_URL ?? null,
      VARIABLE_COMUN: env.VARIABLE_COMUN ?? null,
    },
  };
  const archivoVolcado = path.resolve(env.ORQ_FAKE_VOLCADO);
  fs.mkdirSync(path.dirname(archivoVolcado), { recursive: true });
  fs.writeFileSync(archivoVolcado, JSON.stringify(volcado, null, 2));
}

// 4) Salida de N bytes (esperando el flush antes de continuar).
const bytes = Math.max(0, Math.trunc(aNumero(env.ORQ_FAKE_SALIDA_BYTES)));
if (bytes > 0) {
  await new Promise((resolve, reject) => {
    process.stdout.write(Buffer.alloc(bytes, 0x61), (error) => (error ? reject(error) : resolve()));
  });
}

// 5) Espera pedida. Si se pide ignorar SIGTERM sin dormir, el proceso debe
// quedarse VIVO hasta que lo maten: un manejador de señal por sí solo no mantiene
// vivo el bucle de eventos, así que sin esto saldría antes del timeout.
const ms = Math.max(0, Math.trunc(aNumero(env.ORQ_FAKE_DORMIR)));
if (ms > 0) await dormir(ms);
else if (env.ORQ_FAKE_IGNORA_TERM === '1') await dormir(600000);

// 6) Código de salida.
process.exit(Math.trunc(aNumero(env.ORQ_FAKE_SALIDA_CODIGO)) & 0xff);
