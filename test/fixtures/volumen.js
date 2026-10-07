// Fixture: escribe N megabytes en stdout respetando contrapresión y sale con 0.
// Sirve para probar que el runner vuelca a disco sin acumular en memoria.
// Uso: node volumen.js <megabytes>
//
// Proceso auxiliar, no prueba: el runner de tests de node ejecuta todo .js bajo test/.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const megabytes = Number(process.argv[2] ?? 5);
const trozo = Buffer.alloc(64 * 1024, 0x78); // 'x'
let restante = Math.max(0, megabytes) * 1024 * 1024;

function bombear() {
  while (restante > 0) {
    const n = Math.min(trozo.length, restante);
    restante -= n;
    const datos = n === trozo.length ? trozo : trozo.subarray(0, n);
    if (!process.stdout.write(datos)) {
      process.stdout.once('drain', bombear);
      return;
    }
  }
  process.exit(0);
}

bombear();
