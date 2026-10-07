// Fixture: ignora SIGTERM a propósito para forzar el SIGKILL tras el grace.
//
// Proceso auxiliar, no prueba: el runner de tests de node ejecuta todo .js bajo test/.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

process.on('SIGTERM', () => {
  /* ignora a propósito */
});
process.stdout.write('listo\n');
setInterval(() => {}, 1000);
