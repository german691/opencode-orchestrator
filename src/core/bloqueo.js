/**
 * Toma el bloqueo de instancia esperando unos segundos si otro servidor lo tiene.
 *
 * POR QUÉ: al reiniciar el cliente MCP, el servidor viejo tarda un instante en morir
 * y el nuevo arranca antes de que libere el bloqueo; sin espera el nuevo se rendía
 * para siempre ('otro servidor activo') y la sesión quedaba sin herramientas. Un
 * segundo servidor realmente vivo sigue siendo rechazado, solo que tras la espera.
 */
const dormirReal = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * @param {{ adquirirBloqueoDeInstancia: () => any }} almacen
 * @param {{ esperaMs?: number, intervaloMs?: number, dormir?: (ms: number) => Promise<void> }} [opciones]
 * @returns {Promise<any>} el bloqueo propio
 * @throws {Error} el último error 'otro servidor activo …' si se agota la espera
 */
export async function adquirirBloqueoConEspera(almacen, { esperaMs = 10000, intervaloMs = 250, dormir = dormirReal } = {}) {
  let esperado = 0;
  for (;;) {
    try {
      return almacen.adquirirBloqueoDeInstancia();
    } catch (error) {
      const ocupado = error instanceof Error && error.message.startsWith('otro servidor activo');
      if (!ocupado || esperado >= esperaMs) throw error;
      await dormir(intervaloMs);
      esperado += intervaloMs;
    }
  }
}
