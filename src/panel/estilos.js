/**
 * CSS del panel como string.
 *
 * POR QUÉ en un módulo y no en línea en el HTML: la CSP del servidor prohíbe
 * estilos y scripts en línea (`style-src 'self'`), así que el navegador solo
 * puede cargar este archivo desde `/static/app.css`.
 *
 * Sistema de diseño: tokens semánticos en `:root` (tema claro) y su par oscuro
 * por `prefers-color-scheme`. La regla es simple: ninguna regla de componente
 * escribe un color literal; todas salen de un token. Así el contraste AA y la
 * coherencia se auditan (ver `contraste()` en cliente-lib.js y sus tests).
 */
export const ESTILOS = `:root{
  color-scheme:light;
  /* Superficies: base, elevada (tarjetas) y hundida (consolas/código). */
  --sup:#f7f8fa; --sup-elev:#ffffff; --sup-suave:#eef1f5; --sup-hover:#f2f4f7;
  --sup-hund:#0d1117; --sup-hund-suave:#161b22; --hund-fg:#e6edf3; --hund-borde:#2b3441; --hund-mut:#8b949e;
  /* Bordes en dos intensidades: sutil (separadores) y fuerte (límite de control). */
  --borde:#dbe0e6; --borde-fuerte:#8b95a1;
  /* Texto en tres niveles. */
  --texto:#171a20; --texto-2:#4c5666; --texto-3:#626c79;
  /* Acento único (índigo apagado): selección, foco y enlaces. */
  --acento:#5450d6; --acento-suave:#ecebfb; --acento-borde:#c7c4f2; --foco:#5450d6;
  --sobre-acento:#ffffff;
  /* Semánticos: color y fondo tenue propio. */
  --exito:#15803d; --exito-suave:#e7f4ea; --exito-borde:#b7e0c4;
  --aviso:#8a5a00; --aviso-suave:#fbf1d7; --aviso-borde:#e6cf94;
  --error:#b42318; --error-suave:#fdecea; --error-borde:#f2c0bb;
  --cola:#8a5a00; --cola-suave:#fbf1d7; --cola-borde:#e6cf94;
  --en-curso:#1d4ed8; --en-curso-suave:#e8eefc; --en-curso-borde:#bcd0f7;
  --integrado:#6d28d9; --integrado-suave:#f1e9fe; --integrado-borde:#d6c3f7;
  --cancelado:#57606a; --cancelado-suave:#eef0f3; --cancelado-borde:#cfd5dc;
  /* Compatibilidad con los nombres previos (los usan reglas heredadas). */
  --activo:var(--acento); --activo-suave:var(--acento-suave);
  --bg:var(--sup); --card:var(--sup-elev); --suave:var(--sup-suave); --mut:var(--texto-3);
  --ok:var(--exito); --ok-suave:var(--exito-suave); --mal:var(--error); --mal-suave:var(--error-suave);
  --code:var(--sup-hund); --codefg:var(--hund-fg);
  /* Forma y ritmo. */
  --radio-s:6px; --radio:8px; --radio-l:12px; --radio-p:999px;
  --esp:4px;
  --trans:120ms ease;
  --sombra:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
  --sombra-suave:0 1px 2px rgba(16,24,40,.05);
  --fuente:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Inter,Roboto,'Helvetica Neue',Arial,sans-serif;
  --fuente-mono:ui-monospace,'Cascadia Code','JetBrains Mono',Menlo,Consolas,'Liberation Mono',monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --sup:#0e1116; --sup-elev:#161b22; --sup-suave:#1c222b; --sup-hover:#1f2630;
    --sup-hund:#0a0d12; --sup-hund-suave:#12171e; --hund-fg:#e6edf3; --hund-borde:#2b3441; --hund-mut:#8b949e;
    --borde:#262d38; --borde-fuerte:#5a6575;
    --texto:#e8edf3; --texto-2:#aab4c0; --texto-3:#7f8a99;
    --acento:#a9b6ff; --acento-suave:#1a1c34; --acento-borde:#343a63; --foco:#a9b6ff;
    --sobre-acento:#0b1020;
    --exito:#5ddc8a; --exito-suave:#11271b; --exito-borde:#1e4630;
    --aviso:#f0c24b; --aviso-suave:#2a2210; --aviso-borde:#4d3f1a;
    --error:#ff8b82; --error-suave:#2a1614; --error-borde:#4a2420;
    --cola:#f0c24b; --cola-suave:#2a2210; --cola-borde:#4d3f1a;
    --en-curso:#8ab4ff; --en-curso-suave:#15203a; --en-curso-borde:#263c6b;
    --integrado:#c4a5ff; --integrado-suave:#20163a; --integrado-borde:#3c2c63;
    --cancelado:#9aa4b2; --cancelado-suave:#1b2028; --cancelado-borde:#333b47;
    /* En oscuro las sombras casi no se ven: se apoyan en el borde. */
    --sombra:0 1px 2px rgba(0,0,0,.4);
    --sombra-suave:none;
  }
}
*{box-sizing:border-box}
/* Barras de scroll finas y coherentes con los tokens; el scroll vive en las
   zonas internas (lista, salida de consola, paneles, tablas), nunca en la página. */
*{scrollbar-width:thin;scrollbar-color:var(--borde-fuerte) transparent}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-thumb{background:var(--borde-fuerte);border-radius:var(--radio-p);border:2px solid transparent;background-clip:padding-box}
*::-webkit-scrollbar-thumb:hover{background:var(--texto-3);background-clip:padding-box}
*::-webkit-scrollbar-track{background:transparent}
::selection{background:var(--acento-suave);color:var(--texto)}
html,body{height:100%;max-width:100%;overflow-x:hidden}
body{
  margin:0; background:var(--sup); color:var(--texto); width:100%;
  font:14px/1.5 var(--fuente); -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
a{color:var(--acento);text-underline-offset:2px}
a:hover{color:var(--foco)}
h1{font-size:16px;margin:0;letter-spacing:-.01em;text-wrap:balance}
h2{font-size:15px;margin:0;letter-spacing:-.01em;text-wrap:balance}
h3{font-size:13px;margin:0;letter-spacing:-.005em;text-wrap:balance}
.mono,pre,code{font-family:var(--fuente-mono)}
.num,.tarjeta-valor,.tiempo,.pill,.barra,.evento-hora,time{font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1}
.oculto{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.saltar{position:absolute;left:8px;top:-48px;z-index:10;background:var(--sup-elev);color:var(--texto);border:1px solid var(--borde);border-radius:var(--radio);padding:8px 12px;text-decoration:none}
.saltar:focus{top:8px}
:focus-visible{outline:2px solid var(--foco);outline-offset:2px}
.icono-svg{display:inline-block;vertical-align:-0.15em;flex:none}
.icono-estado{width:16px;height:16px}

/* Cabecera ---------------------------------------------------------------- */
.cabecera{
  display:flex;flex-wrap:wrap;align-items:center;gap:calc(var(--esp)*3);
  width:100%;max-width:100%;min-width:0;box-sizing:border-box;
  padding:calc(var(--esp)*2) calc(var(--esp)*4);background:var(--sup-elev);
  border-bottom:1px solid var(--borde);position:sticky;top:0;z-index:5;
}
.cabecera-titulo{display:flex;align-items:center;gap:calc(var(--esp)*2);min-width:0}
.cabecera-titulo h1{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.marca-logo{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--radio-s);background:var(--acento-suave);color:var(--acento);border:1px solid var(--acento-borde)}
.cabecera .marca{color:var(--texto-3);font-size:12px}
.conexion{display:inline-flex;align-items:center;gap:var(--esp);font-size:12px;color:var(--texto-3)}
.punto{width:8px;height:8px;border-radius:50%;background:var(--texto-3);display:inline-block;position:relative}
.conexion.vivo{color:var(--exito)}
.conexion.vivo .punto{background:var(--exito)}
.conexion.vivo .punto::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:1px solid var(--exito);animation:latido 1.8s ease-out infinite}
.conexion.reconectando .punto{background:var(--aviso)}
@keyframes latido{0%{opacity:.7;transform:scale(.6)}70%{opacity:0;transform:scale(1.2)}100%{opacity:0}}
.pill{display:inline-flex;align-items:center;gap:var(--esp);max-width:100%;min-width:0;font-size:12px;color:var(--texto-2);background:var(--sup-suave);border:1px solid var(--borde);border-radius:var(--radio-p);padding:2px 10px}
.pill .pill-largo,.pill .pill-corto{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill-corto{display:none}
.pill-cola{color:var(--aviso);background:var(--aviso-suave);border-color:var(--aviso-borde)}
.concurrencia[hidden]{display:none}
.barra{width:min(96px,20vw);height:6px;background:var(--sup-suave);border:1px solid var(--borde);border-radius:var(--radio-p);overflow:hidden;appearance:none;flex:none}
.barra::-webkit-progress-bar{background:var(--sup-suave)}
.barra::-webkit-progress-value{background:var(--en-curso)}
.barra::-moz-progress-bar{background:var(--en-curso)}
.barra-relleno{height:100%;background:var(--en-curso)}
.cabecera-nav{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:calc(var(--esp)*2);min-width:0;max-width:100%;justify-content:flex-end}
.cabecera-nav a{font-size:13px;color:var(--texto-2);text-decoration:none;padding:4px 6px;border-radius:var(--radio-s)}
.cabecera-nav a:hover{color:var(--texto);background:var(--sup-suave)}
.cabecera-nav a[aria-current=page]{color:var(--acento);font-weight:600}
.boton{
  font:inherit;font-size:13px;min-height:32px;padding:5px 10px;cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;justify-content:center;
  background:var(--sup-elev);color:var(--texto);border:1px solid var(--borde);
  border-radius:var(--radio-s);transition:background-color var(--trans),border-color var(--trans),color var(--trans);
}
.boton:hover{background:var(--sup-hover);border-color:var(--borde-fuerte)}
.boton:active{background:var(--sup-suave);transform:translateY(.5px)}
.boton:disabled{opacity:.5;cursor:not-allowed}
.boton[aria-pressed=true]{background:var(--acento-suave);border-color:var(--acento-borde);color:var(--acento)}
/* Variantes: secundario (por defecto) y fantasma (sin borde hasta el hover). */
.boton-secundario{background:var(--sup-suave);border-color:var(--borde);color:var(--texto)}
.boton-fantasma{background:transparent;border-color:transparent;color:var(--texto-2)}
.boton-fantasma:hover{background:var(--sup-suave);border-color:transparent;color:var(--texto)}

/* Cuerpo / columnas (layout de aplicación) -------------------------------- */
/* POR QUÉ 100dvh y flex: la cabecera queda fija y la grilla ocupa EXACTAMENTE
   el alto restante; el scroll vive en cada columna y no en la página, para que
   la lista y el detalle no se empujen entre sí. */
body.panel-app{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
body.panel-app .cabecera{flex:none}
.cuerpo{
  --ancho-lista:clamp(320px,28vw,420px);
  flex:1 1 auto;min-height:0;min-width:0;display:grid;
  grid-template-columns:var(--ancho-lista) 6px minmax(0,1fr);
  overflow:hidden;background:var(--sup);
}
@media (min-width:1700px){.cuerpo{--ancho-lista:440px}}
/* Divisor arrastrable ----------------------------------------------------- */
.divisor{position:relative;background:var(--borde);cursor:col-resize;touch-action:none;outline:none;transition:background-color var(--trans)}
.divisor::after{content:'';position:absolute;inset:0 -3px}
.divisor:hover{background:var(--acento)}
.divisor:focus-visible{outline:2px solid var(--foco);outline-offset:-1px;background:var(--acento)}

/* Páginas secundarias (auditoría y pizarrón) ------------------------------ */
/* Mismo sistema de tokens que la principal: padding 20/24 px y ancho cómodo.
   El ancho explícito (y no depender del shrink-to-fit del contenedor) evita
   que la cabecera y el contenido queden en una columna angosta en las páginas
   que no traen contenido propio hasta que hidrata el cliente (pizarrón). */
.pagina{
  display:flex;flex-direction:column;gap:calc(var(--esp)*4);
  padding:calc(var(--esp)*5) calc(var(--esp)*6);
  width:100%;max-width:1100px;margin-inline:auto;box-sizing:border-box;min-width:0;
}
.filtros{
  display:flex;flex-wrap:wrap;align-items:flex-end;gap:calc(var(--esp)*3);
  background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);
  padding:calc(var(--esp)*3) calc(var(--esp)*4);box-shadow:var(--sombra-suave);
}
.filtros .campo{display:flex;flex-direction:column;gap:var(--esp)}
.filtros label{font-size:12px;color:var(--texto-2);font-weight:600}
.filtros input,.filtros select{
  font:inherit;min-height:34px;padding:4px 8px;color:var(--texto);
  background:var(--sup);border:1px solid var(--borde-fuerte);border-radius:var(--radio-s);
}
.filtros .acciones{display:flex;gap:var(--esp);margin-left:auto}
.boton-primario{background:var(--acento);color:var(--sobre-acento);border-color:var(--acento);font-weight:600}
.boton-primario:hover{background:var(--foco);border-color:var(--foco);color:var(--sobre-acento)}
.tabla-envoltorio{overflow:auto;width:100%;max-width:100%;max-height:70vh;border:1px solid var(--borde);border-radius:var(--radio);background:var(--sup-elev)}
.tabla-envoltorio table{border:0;border-radius:0}
.paginacion{display:flex;justify-content:center}
.badge-historico{color:var(--cola);border-color:var(--cola-borde);background:var(--cola-suave)}
.campo-iso{font-family:var(--fuente-mono);font-size:12px;color:var(--texto-3)}

/* Angosto (móvil): el padding se achica y los campos ocupan todo el ancho para
   que el panel no genere scroll horizontal de página a 360 px; las tablas ya
   scrollean dentro de .tabla-envoltorio. */
@media (max-width:600px){
  .pagina{padding:calc(var(--esp)*4) calc(var(--esp)*3)}
  .filtros{padding:calc(var(--esp)*2) calc(var(--esp)*3)}
  .filtros .campo{flex:1 1 100%;min-width:0}
  .filtros input,.filtros select{width:100%;max-width:100%}
  .filtros .acciones{margin-left:0;width:100%}
}

/* Lista de trabajos ------------------------------------------------------- */
.lista{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;background:var(--sup);border-right:1px solid var(--borde);container-type:inline-size}
/* La toolbar queda pegada arriba de la lista (la lista scrollea por debajo). Las
   tres filas (búsqueda / segmentado / controles) se apilan y nunca desbordan. */
.toolbar{flex:none;position:sticky;top:0;z-index:3;display:flex;flex-direction:column;gap:var(--esp);min-width:0;padding:calc(var(--esp)*2) calc(var(--esp)*3);background:var(--sup-elev);border-bottom:1px solid var(--borde)}
.busqueda{margin:0}
.busqueda-caja{position:relative;display:flex;align-items:center;color:var(--texto-3)}
.busqueda-caja>.icono-svg{position:absolute;left:9px;pointer-events:none}
#filtro-texto{
  width:100%;font:inherit;min-height:36px;padding:4px 34px;color:var(--texto);
  background:var(--sup);border:1px solid var(--borde-fuerte);border-radius:var(--radio-s);
}
#filtro-texto:focus-visible{background:var(--sup-elev)}
.boton-limpiar{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;font:inherit;cursor:pointer;background:transparent;color:var(--texto-3);border:1px solid transparent;border-radius:var(--radio-s)}
.boton-limpiar:hover{background:var(--sup-suave);color:var(--texto)}
.boton-limpiar[hidden]{display:none}
::placeholder{color:var(--texto-3);opacity:1}
/* Control segmentado de estado: 4 columnas IGUALES que reparten el ancho de la
   columna; las etiquetas se acortan por contenedor solo si no entran. */
.segmentado{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px;padding:2px;background:var(--sup-suave);border:1px solid var(--borde);border-radius:var(--radio-s);overflow:hidden}
.segmentado::-webkit-scrollbar{display:none}
/* Los tres controles en una grilla que reencuadra sola: a 280 px caen a 2+1 y a
   560 px entran los tres, sin desbordar nunca el ancho de la columna. */
.toolbar-fila{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));align-items:center;gap:var(--esp);min-width:0}
.toolbar-fila select{width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;font:inherit;font-size:13px;min-height:32px;padding:2px 8px;color:var(--texto);background:var(--sup-elev);border:1px solid var(--borde-fuerte);border-radius:var(--radio-s)}
.toolbar-fila #densidad{width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis}
.chip{
  font:inherit;font-size:12px;min-height:30px;padding:3px 8px;cursor:pointer;white-space:nowrap;min-width:0;overflow:hidden;
  display:inline-flex;align-items:center;justify-content:center;background:transparent;color:var(--texto-2);
  border:1px solid transparent;border-radius:var(--radio-s);transition:background-color var(--trans),color var(--trans);
}
.chip .chip-largo,.chip .chip-corto{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip-corto{display:none}
/* En columnas anchas entra la etiqueta completa; en angostas, la corta. */
@container (max-width:520px){
  .chip-largo{display:none}
  .chip-corto{display:inline}
}
.chip:hover{color:var(--texto);background:var(--sup-hover)}
.chip .cuenta{color:var(--texto-3);margin-left:5px;font-variant-numeric:tabular-nums}
.chip[aria-pressed=true]{background:var(--sup-elev);border-color:var(--borde);color:var(--texto);font-weight:600}
.chip[aria-pressed=true] .cuenta{color:var(--texto-2)}
.trabajos{list-style:none;margin:0;padding:var(--esp);overflow:auto;display:flex;flex-direction:column;gap:var(--esp);min-height:0;flex:1 1 auto;overscroll-behavior:contain}
.grupo-encabezado{position:sticky;top:0;z-index:2;display:flex;align-items:baseline;justify-content:space-between;gap:var(--esp);padding:6px 8px;margin-top:calc(var(--esp)*-1);background:var(--sup);border-bottom:1px solid var(--borde);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--texto-3)}
.grupo-cuenta{font-weight:400;font-variant-numeric:tabular-nums}
.trabajo{
  width:100%;text-align:left;font:inherit;cursor:pointer;display:grid;gap:3px;
  padding:9px 11px;min-height:46px;color:var(--texto);background:var(--sup-elev);
  border:1px solid var(--borde);border-radius:var(--radio);border-left:3px solid var(--borde);
  transition:background-color var(--trans),border-color var(--trans),box-shadow var(--trans);
}
.trabajo:hover{background:var(--sup-hover);border-color:var(--borde-fuerte)}
.trabajo[aria-current=true]{border-color:var(--acento);border-left-color:var(--acento);background:var(--acento-suave);box-shadow:var(--sombra-suave)}
.trabajo-estado{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600}
.trabajo-estado .icono{font-size:13px}
.trabajo-titulo{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:14px}
.trabajo-meta{display:flex;flex-wrap:wrap;gap:calc(var(--esp)*2);font-size:12px;color:var(--texto-3);align-items:center}
.trabajo-semaforo{border-radius:var(--radio-p);padding:0 7px;border:1px solid var(--borde);background:var(--sup-suave)}
.semaforo-verde{color:var(--exito);border-color:var(--exito-borde);background:var(--exito-suave)}
.semaforo-amarillo{color:var(--cola);border-color:var(--cola-borde);background:var(--cola-suave)}
.semaforo-rojo{color:var(--error);border-color:var(--error-borde);background:var(--error-suave)}
.trabajo-espera{color:var(--aviso)}
.trabajo-aviso{color:var(--aviso);display:inline-flex;align-items:center;gap:4px}
/* Densidad compacta: filas y gaps ~30% más chicos, sin perder el objetivo táctil. */
.cuerpo.densidad-compacta .trabajos{gap:2px}
.cuerpo.densidad-compacta .trabajo{padding:6px 9px;min-height:38px}
.cuerpo.densidad-compacta .trabajo-meta,.cuerpo.densidad-compacta .trabajo-estado{font-size:11px}
.vacia{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:calc(var(--esp)*2);text-align:center;color:var(--texto-3);font-size:13px;padding:calc(var(--esp)*8) calc(var(--esp)*3)}
/* .vacia fija display:flex, que pisa el [hidden] del navegador: sin esta
   regla el estado vacío de la lista quedaba visible aun con filas. */
.vacia[hidden]{display:none}
.vacia .icono-svg{color:var(--borde-fuerte)}
.estado-vacio-accion{color:var(--acento);font-size:12px}

/* Estados: texto + ícono + color ------------------------------------------ */
.estado-ok{color:var(--exito)}
.estado-mal{color:var(--error)}
.estado-cola{color:var(--cola)}
.estado-activo{color:var(--en-curso)}
.estado-neutro{color:var(--cancelado)}

/* Detalle y pestañas ------------------------------------------------------ */
.detalle{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--sup)}
.volver{display:none;align-self:flex-start;margin:calc(var(--esp)*2) calc(var(--esp)*3) 0}
#sin-seleccion{padding:calc(var(--esp)*5) calc(var(--esp)*4)}
#detalle-trabajo{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
/* Solo el contenido de la pestaña scrollea: la barra de título + tabs queda fija. */
.detalle-cabecera{flex:none;position:sticky;top:0;z-index:2;background:var(--sup);padding:calc(var(--esp)*2) calc(var(--esp)*3) 0;border-bottom:1px solid var(--borde)}
.titulo-trabajo{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:17px;font-weight:600;letter-spacing:-.01em}
.tabs{display:flex;flex-wrap:nowrap;gap:2px;border-bottom:1px solid var(--borde);overflow-x:auto;margin-bottom:calc(var(--esp)*-1);scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs [role=tab]{
  font:inherit;font-size:13px;min-height:34px;padding:7px 12px;cursor:pointer;white-space:nowrap;
  display:inline-flex;align-items:center;gap:5px;
  background:transparent;color:var(--texto-2);border:none;border-bottom:2px solid transparent;
  margin-bottom:-1px;transition:color var(--trans),border-color var(--trans),background-color var(--trans);
}
.tabs [role=tab]:hover{color:var(--texto);background:var(--sup-suave)}
.tabs [role=tab][aria-selected=true]{color:var(--acento);border-bottom-color:var(--acento);font-weight:600}
[role=tabpanel]{overflow:auto;min-height:0;flex:1 1 auto;padding:calc(var(--esp)*3);overscroll-behavior:contain;scroll-padding-top:52px}
.cargando,.nota{color:var(--texto-3);font-size:13px}
.error{color:var(--error)}
dl.resumen{display:grid;grid-template-columns:max-content 1fr;gap:calc(var(--esp)*2) calc(var(--esp)*3);margin:0 0 calc(var(--esp)*4)}
dl.resumen dt{color:var(--texto-3);font-size:13px}
dl.resumen dd{margin:0;word-break:break-word}
.prompt{background:var(--sup-suave);border:1px solid var(--borde);border-radius:var(--radio);padding:8px;white-space:pre-wrap;max-height:40vh;overflow:auto;font-size:12px}
pre.salida{background:var(--sup-hund);color:var(--hund-fg);border-radius:var(--radio);padding:10px;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto;font-size:12px;margin:0}
ul.lista-simple{margin:0;padding-left:20px}

/* Consola ----------------------------------------------------------------- */
/* La pestaña ocupa TODA la altura disponible; el scroll vive en la salida. */
#panel-consola.consola-panel{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:calc(var(--esp)*2) calc(var(--esp)*3)}
.consola-barra{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:var(--esp);align-items:center;padding:var(--esp) 0;background:var(--sup);border-bottom:1px solid var(--borde)}
.consola-barra label{font-size:13px;color:var(--texto-3)}
.consola-barra select,.consola-barra input{font:inherit;min-height:32px;padding:2px 8px;background:var(--sup-elev);color:var(--texto);border:1px solid var(--borde-fuerte);border-radius:var(--radio-s)}
.consola-buscar{flex:1 1 160px;min-width:120px}
.consola-tamano{font-size:12px;color:var(--texto-3);min-width:3ch;text-align:center}
.consola-coincidencias{font-size:12px;color:var(--texto-3)}
.consola-cuerpo{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;margin-top:var(--esp)}
.consola-salida{flex:1 1 auto;min-height:0;background:var(--sup-hund);color:var(--hund-fg);border:1px solid var(--hund-borde);border-radius:var(--radio);padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0}
/* «Ajustar líneas» desactivado: sin wrap y con scroll horizontal DENTRO de la consola. */
.consola-salida.sin-ajuste{white-space:pre;word-break:normal;overflow-x:auto}
.consola-linea{white-space:inherit}
.consola-linea.linea-error{color:var(--error)}
.consola-linea.linea-ok{color:var(--exito)}
.coincidencia{background:var(--aviso-suave);color:var(--texto);border-radius:3px}
.coincidencia-activa{outline:2px solid var(--foco);outline-offset:-1px}
.consola-pausa{position:absolute;top:8px;right:10px;display:inline-flex;align-items:center;gap:4px;font-size:12px;background:var(--aviso-suave);color:var(--aviso);border:1px solid var(--aviso-borde);border-radius:var(--radio-p);padding:2px 9px}
.consola-ir-final{position:absolute;right:12px;bottom:12px;box-shadow:var(--sombra)}
.consola-pausa[hidden],.consola-ir-final[hidden]{display:none}
.consola-pie{flex:none;margin:var(--esp) 0 0;font-size:12px;color:var(--texto-3)}
.aviso-lineas{font-size:12px;color:var(--aviso);margin:0 0 var(--esp)}

/* Esqueletos de carga (nunca un «Cargando…» pelado) ----------------------- */
.esqueleto{display:flex;flex-direction:column;gap:calc(var(--esp)*2);padding:var(--esp) 0}
.esqueleto-linea{height:14px;border-radius:var(--radio-s);background:linear-gradient(90deg,var(--sup-suave),var(--borde),var(--sup-suave));background-size:200% 100%;animation:esqueleto 1.2s ease-in-out infinite}
@keyframes esqueleto{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* Tarjetas y cajas del Resumen -------------------------------------------- */
.tarjetas-resumen{display:flex;flex-wrap:wrap;gap:calc(var(--esp)*3);margin-bottom:calc(var(--esp)*3)}
.tarjeta{display:flex;flex-direction:column;gap:3px;min-width:128px;padding:9px 12px;background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);box-shadow:var(--sombra-suave)}
.tarjeta-etiqueta{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--texto-3);font-weight:600}
.tarjeta-valor{font-weight:600;display:flex;flex-wrap:wrap;align-items:center;gap:var(--esp)}
.tarjeta-rama{display:flex;align-items:center;gap:var(--esp);min-width:0}
.resumen-acciones{display:flex;flex-wrap:wrap;gap:var(--esp);margin-bottom:calc(var(--esp)*3)}
.caja{background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);padding:10px 12px;margin-bottom:calc(var(--esp)*3)}
.caja-titulo{margin-bottom:6px;color:var(--texto-3);text-transform:uppercase;letter-spacing:.05em;font-size:11px;font-weight:700}
.caja-aviso{border-left:3px solid var(--aviso)}
.caja-advertencia{border-left:3px solid var(--aviso);background:var(--aviso-suave)}
.caja-error{border-left:3px solid var(--error);background:var(--error-suave)}
.boton-mini{font-size:12px;min-height:28px;padding:3px 9px}


/* Diff -------------------------------------------------------------------- */
.diff-archivos{display:flex;flex-direction:column;gap:var(--esp)}
.diff-cabecera{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:var(--esp);align-items:center;padding:var(--esp) 0;background:var(--sup);border-bottom:1px solid var(--borde);margin-bottom:var(--esp)}
.diff-resumen{font-weight:600;font-variant-numeric:tabular-nums}
.diff-salto{margin-left:auto;font:inherit;font-size:12px;min-height:30px;max-width:220px;padding:2px 6px;background:var(--sup-elev);color:var(--texto);border:1px solid var(--borde-fuerte);border-radius:var(--radio-s)}
details.archivo{background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);scroll-margin-top:56px;overflow:hidden}
details.archivo>summary{cursor:pointer;padding:7px 11px;min-height:36px;display:flex;gap:var(--esp);align-items:center;flex-wrap:wrap;list-style:none}
details.archivo>summary::-webkit-details-marker{display:none}
/* El encabezado del archivo queda visible mientras se scrollea su contenido. */
details.archivo>summary{position:sticky;top:34px;z-index:1;background:var(--sup-elev)}
details.archivo>summary::marker{color:var(--texto-3)}
.archivo-barra{height:6px;min-width:16px;max-width:120px;background:var(--en-curso);border-radius:3px;display:inline-block}
.archivo-ver{margin-left:auto}

.archivo-estado{display:inline-flex;align-items:center;width:18px;justify-content:center}
.estado-add{color:var(--exito)}
.estado-del{color:var(--error)}
.estado-mod{color:var(--aviso)}
.estado-ren{color:var(--en-curso)}
.archivo-ruta{font-family:var(--fuente-mono);word-break:break-all}
.archivo-cambios{color:var(--texto-3);font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums}
.parche{margin:0;border-top:1px solid var(--borde);overflow:auto;max-height:50vh;font-size:12px;font-family:var(--fuente-mono);background:var(--sup-hund);color:var(--hund-fg)}
.parche .hunk-encabezado{background:var(--sup-hund-suave);color:var(--hund-mut);padding:3px 10px;white-space:pre-wrap}
.linea{display:flex;gap:var(--esp);padding:0 10px;white-space:pre-wrap;word-break:break-word}
.linea .num{color:var(--hund-mut);min-width:4ch;text-align:right;user-select:none}
.linea .signo{min-width:1ch;user-select:none;font-weight:700}
.linea-add{background:var(--exito-suave);color:var(--exito)}
.linea-add .signo{color:var(--exito)}
.linea-del{background:var(--error-suave);color:var(--error)}
.linea-del .signo{color:var(--error)}
.linea-ctx .signo{color:var(--hund-mut)}
.binario{color:var(--hund-mut);padding:6px 12px}

/* Alcance ----------------------------------------------------------------- */
.alcance{display:flex;flex-direction:column;gap:calc(var(--esp)*3)}
.alcance section{background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);padding:10px 12px}
.alcance h3{margin-bottom:6px}
.alcance ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.alcance li{display:flex;gap:var(--esp);align-items:center;font-size:13px}
.marca-fuera{color:var(--error);font-weight:700}
.fuera-item{color:var(--error)}
.badge{font-size:12px;border:1px solid var(--borde);border-radius:var(--radio-p);padding:0 7px;color:var(--texto-2);background:var(--sup-suave)}

/* Resumen plegable -------------------------------------------------------- */
.titulo-fila{display:flex;align-items:center;gap:calc(var(--esp)*2)}
.titulo-fila .titulo-trabajo{min-width:0}
.titulo-fila .boton{flex:none}
details.plegable{background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);margin:calc(var(--esp)*2) 0}
details.plegable>summary{cursor:pointer;padding:7px 11px;min-height:36px;display:flex;flex-wrap:wrap;gap:var(--esp);align-items:center}
details.plegable>summary::marker{color:var(--texto-3)}
.plegable-preview{white-space:pre-wrap;color:var(--texto-3);font-size:12px;font-family:var(--fuente-mono);flex:1;min-width:0}
.plegable-accion{margin-left:auto;color:var(--acento);font-size:12px;white-space:nowrap}
details.plegable[open] .plegable-accion{display:none}
details.plegable>pre{border-radius:0 0 var(--radio) var(--radio)}

/* Pizarrón ---------------------------------------------------------------- */
.tabla-pizarron{border-collapse:collapse;width:100%;background:var(--sup-elev)}
.tabla-pizarron th,.tabla-pizarron td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--borde);font-size:13px;vertical-align:top}
.tabla-pizarron th{color:var(--texto-3);font-weight:600;position:sticky;top:0;background:var(--sup-elev);z-index:1;text-transform:uppercase;font-size:11px;letter-spacing:.05em}
.tabla-pizarron tbody tr:hover{background:var(--sup-hover)}
.tabla-pizarron tbody tr:nth-child(even){background:var(--sup-suave)}
.valor-pizarron{font-family:var(--fuente-mono);word-break:break-word;display:block}
.valor-pizarron-resumen{cursor:pointer;color:var(--texto);display:flex;gap:var(--esp);align-items:baseline}
.valor-pizarron-resumen .plegable-accion{margin-left:auto}
.valor-pizarron pre{margin:var(--esp) 0 0;white-space:pre-wrap;word-break:break-word;background:var(--sup-hund);color:var(--hund-fg);border-radius:var(--radio);padding:8px;max-height:40vh;overflow:auto}
.marca-conflicto{color:var(--error);font-weight:700}
.notas-pizarron{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--esp)}
.nota-pizarron{display:flex;flex-wrap:wrap;gap:calc(var(--esp)*2);align-items:baseline;background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);padding:9px 12px;font-size:13px}
.nota-pizarron .nota-autor{font-weight:600}
.nota-pizarron .nota-texto{flex:1;min-width:0}

/* Auditoría --------------------------------------------------------------- */
.tabla-auditoria{border-collapse:collapse;width:100%;background:var(--sup-elev)}
.tabla-auditoria th,.tabla-auditoria td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--borde);font-size:13px;vertical-align:top}
.tabla-auditoria th{color:var(--texto-3);font-weight:600;position:sticky;top:0;background:var(--sup-elev);z-index:1;text-transform:uppercase;font-size:11px;letter-spacing:.05em}
.tabla-auditoria tbody tr:hover{background:var(--sup-hover)}
.tabla-auditoria tbody tr:nth-child(even){background:var(--sup-suave)}
.tabla-auditoria time{white-space:nowrap;font-family:var(--fuente-mono);font-size:12px}
.chip-evento{display:inline-block;font-size:12px;border-radius:var(--radio-p);padding:1px 9px;border:1px solid var(--borde);background:var(--sup-suave);color:var(--texto-2);white-space:nowrap}
.chip-evento.chip-job{color:var(--en-curso);background:var(--en-curso-suave);border-color:var(--en-curso-borde)}
.chip-evento.chip-merge{color:var(--integrado);background:var(--integrado-suave);border-color:var(--integrado-borde)}
.chip-evento.chip-servidor{color:var(--cancelado);background:var(--cancelado-suave);border-color:var(--cancelado-borde)}
.chip-evento.chip-pizarron{color:var(--exito);background:var(--exito-suave);border-color:var(--exito-borde)}
.chip-evento.chip-cleanup{color:var(--aviso);background:var(--aviso-suave);border-color:var(--aviso-borde)}
.chip-evento.chip-otro{color:var(--texto-2);background:var(--sup-suave);border-color:var(--borde)}


/* Eventos ----------------------------------------------------------------- */
.eventos{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--esp)}
.evento{display:grid;grid-template-columns:auto auto 1fr;gap:calc(var(--esp)*2);align-items:baseline;background:var(--sup-elev);border:1px solid var(--borde);border-radius:var(--radio);padding:7px 11px;font-size:13px}
.evento-hora{color:var(--texto-3);font-family:var(--fuente-mono);font-size:12px}
.evento-tipo{font-weight:600}
.evento-transicion{color:var(--en-curso)}
.evento-motivo{color:var(--texto-3)}

/* Diálogo de ayuda -------------------------------------------------------- */
.dialogo{border:1px solid var(--borde);border-radius:var(--radio-l);background:var(--sup-elev);color:var(--texto);max-width:420px;padding:calc(var(--esp)*4);box-shadow:var(--sombra)}
.dialogo::backdrop{background:rgba(8,12,20,.5)}
.ayuda-lista{list-style:none;margin:calc(var(--esp)*2) 0;padding:0;display:flex;flex-direction:column;gap:var(--esp)}
.ayuda-lista li{display:flex;justify-content:space-between;gap:calc(var(--esp)*3)}
kbd{font-family:var(--fuente-mono);font-size:12px;background:var(--sup-suave);border:1px solid var(--borde);border-radius:var(--radio-s);padding:1px 6px}

/* Layout adaptable: maestro-detalle (móvil) --------------------------------- */
/* Por debajo de 900 px se ve la lista O el detalle, nunca los dos apilados: al
   elegir un trabajo se muestra el detalle a pantalla completa con «← Trabajos». */
@media (max-width:899px){
  .cuerpo{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
  .divisor{display:none}
  .lista{display:flex;border-right:none}
  .detalle{display:none}
  body.detalle-abierto .lista{display:none}
  body.detalle-abierto .detalle{display:flex}
  .volver{display:inline-flex;margin:calc(var(--esp)*3) calc(var(--esp)*3) 0}
  .volver[hidden]{display:none}
  /* Objetivos táctiles >= 36 px y sin resaltado azul del toque. */
  .trabajo{min-height:52px;padding:10px 12px}
  .chip{min-height:36px}
  .toolbar-fila select,.boton-limpiar,#densidad{min-height:36px;height:36px}
  .tabs [role=tab]{min-height:40px}
  /* Cabecera compacta: píldoras y conexión siguen visibles sin comer alto. */
  .cabecera{gap:var(--esp);padding:6px 10px}
  .cabecera .marca{display:none}
  .pill,.conexion{font-size:11px}
  .cabecera-nav a{font-size:12px}
}

/* Móvil (<640 px): píldoras compactas, «En vivo» como punto y enlaces juntos. */
@media (max-width:640px){
  .pill-largo{display:none}
  .pill-corto{display:inline}
  #conexion-texto{display:none}
  .conexion{gap:0}
  .cabecera-nav{width:100%;justify-content:flex-start;gap:var(--esp)}
  .cabecera-nav a{padding:3px 5px}
  .cabecera-nav #ayuda{padding:3px 8px}
}

/* Accesibilidad ----------------------------------------------------------- */
*{-webkit-tap-highlight-color:rgba(127,127,127,.18)}
@media (prefers-reduced-motion:reduce){
  .trabajos{scroll-behavior:auto}
  .conexion.vivo .punto::after{animation:none;display:none}
  .esqueleto-linea{animation:none;background:var(--sup-suave)}
  *{transition:none !important;animation:none !important}
}
@media (forced-colors:active){
  .punto,.barra-relleno{border:1px solid CanvasText}
  .trabajo[aria-current=true]{outline:2px solid Highlight}
  .trabajo,.chip,.boton,.tabs [role=tab]{border:1px solid ButtonText}
}
.trabajo,.chip,.boton,.conexion,.barra-relleno{transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease}
`;
