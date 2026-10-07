// Fixture: imprime un pulso periódico. Prueba que la actividad reinicia el
// temporizador de inactividad.
//
// Proceso auxiliar, no prueba: el runner de tests de node ejecuta todo .js bajo test/.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

setInterval(() => {
  process.stdout.write('pulso\n');
}, 40);
