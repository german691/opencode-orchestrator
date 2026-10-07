/**
 * Conversión de rutas del cliente a rutas del servidor.
 *
 * POR QUÉ: el servidor corre dentro de WSL (Linux) pero el cliente (Claude Desktop en
 * Windows) manda rutas como `C:\Users\x\repo`. Sin convertirlas, Linux las toma como una
 * ruta RELATIVA al directorio de arranque del servidor (observado en vivo:
 * `/mnt/c/Windows/system32/C:\Users\...`). Se aceptan además las rutas UNC de WSL
 * (`\\wsl$\Debian\home\x` y `\\wsl.localhost\Debian\home\x`).
 */

import os from 'node:os';

/**
 * Convierte una ruta estilo Windows a su equivalente de Linux/WSL; cualquier otra ruta
 * se devuelve sin cambios.
 *
 * @param {string} ruta
 * @param {string} [plataforma=os.platform()] solo en Linux se convierte (inyectable para tests)
 * @returns {string}
 */
export function aRutaDelServidor(ruta, plataforma = os.platform()) {
  if (typeof ruta !== 'string' || plataforma !== 'linux') return ruta;

  // C:\dir\sub  o  C:/dir/sub  ->  /mnt/c/dir/sub  (la raíz C:\ sola da /mnt/c)
  const unidad = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(ruta);
  if (unidad) {
    const resto = (unidad[2] ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
    return `/mnt/${unidad[1].toLowerCase()}${resto ? `/${resto}` : ''}`;
  }

  // \\wsl$\Distro\ruta  o  \\wsl.localhost\Distro\ruta  ->  /ruta (la distro es la propia)
  const unc = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/][^\\/]+(?:[\\/](.*))?$/i.exec(ruta);
  if (unc) {
    const resto = (unc[1] ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    return `/${resto}`;
  }

  return ruta;
}
