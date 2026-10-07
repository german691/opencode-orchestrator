// Fixture: imprime una línea en cada canal y sale con el código indicado.
// Uso: node eco.js <codigoSalida>
//
// El runner de tests de node descubre y ejecuta cualquier .js bajo test/. Este
// archivo es un proceso auxiliar, no una prueba: si lo lanza el runner, no hace nada.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const codigo = Number(process.argv[2] ?? 0);

process.stdout.write('salida-normal\n', () => {
  process.stderr.write('error-normal\n', () => process.exit(Number.isFinite(codigo) ? codigo : 0));
});
