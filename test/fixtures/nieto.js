// Fixture: lanza un nieto de larga vida en el MISMO grupo de procesos y anota su
// pid en un archivo.
//
//   modo 'vive'        : el padre sigue vivo (prueba la cancelación del grupo).
//   modo 'padre_muere' : el padre sale dejando que el nieto conserve stdout/stderr
//                        abiertos (prueba que la promesa no se cuelga esperando a
//                        que se cierren las tuberías).
//
// Uso: node nieto.js <archivoPid> <modo>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Proceso auxiliar, no prueba: el runner de tests de node ejecuta todo .js bajo test/.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const archivoPid = process.argv[2];
const modo = process.argv[3] ?? 'vive';

const nieto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  // Hereda las tuberías del padre: si el padre muere, el nieto las mantiene abiertas.
  stdio: ['ignore', 'inherit', 'inherit'],
});
writeFileSync(archivoPid, String(nieto.pid));

if (modo === 'padre_muere') {
  process.exit(0);
} else {
  process.stdout.write('listo\n');
  setInterval(() => {}, 1000);
}
