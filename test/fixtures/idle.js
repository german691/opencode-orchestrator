// Fixture: imprime una vez y luego calla (sin salir). Prueba el timeout por
// inactividad y el timeout total.
//
// Proceso auxiliar, no prueba: el runner de tests de node ejecuta todo .js bajo test/.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

process.stdout.write('listo\n');
setInterval(() => {}, 1000);
