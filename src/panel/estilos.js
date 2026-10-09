/**
 * CSS del panel como string.
 *
 * POR QUÉ en un módulo y no en línea en el HTML: la CSP del servidor prohíbe
 * estilos y scripts en línea (`style-src 'self'`), así que el navegador solo
 * puede cargar este archivo desde `/static/app.css`. Tokens en `:root`, tema
 * claro/oscuro por preferencia del sistema y contraste ≥ 4.5:1.
 */
export const ESTILOS = `:root{
  --bg:#f6f7f9; --fg:#1b1f27; --mut:#556072; --card:#ffffff; --bd:#d3d9e0;
  --suave:#eef1f5; --foco:#0b5fff; --code:#0f141b; --codefg:#dde4ee;
  --ok:#1a7f37; --ok-suave:#e6f4ea; --mal:#b3261e; --mal-suave:#fbeae9;
  --cola:#8a5a00; --cola-suave:#fdf3dc; --activo:#0b5fff; --activo-suave:#e7eefe;
  --radio:6px; --esp:4px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0f1319; --fg:#e6eaf0; --mut:#a3adbb; --card:#171d26; --bd:#2c3441;
    --suave:#1d242e; --foco:#8ab4ff; --code:#0a0d12; --codefg:#d5dce6;
    --ok:#5ddc8a; --ok-suave:#12271b; --mal:#ff8b82; --mal-suave:#2a1614;
    --cola:#f0c24b; --cola-suave:#2a2210; --activo:#8ab4ff; --activo-suave:#141d31;
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0; background:var(--bg); color:var(--fg); width:100%;
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
a{color:var(--foco)}
h1{font-size:16px;margin:0}
h2{font-size:15px;margin:0}
h3{font-size:13px;margin:0}
.mono,pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.oculto{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.saltar{position:absolute;left:8px;top:-48px;z-index:10;background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:var(--radio);padding:8px 12px;text-decoration:none}
.saltar:focus{top:8px}
:focus-visible{outline:3px solid var(--foco);outline-offset:2px}

/* Cabecera ---------------------------------------------------------------- */
.cabecera{
  display:flex;flex-wrap:wrap;align-items:center;gap:calc(var(--esp)*3);
  width:100%;box-sizing:border-box;
  padding:calc(var(--esp)*2) calc(var(--esp)*4);background:var(--card);
  border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:5;
}
.cabecera-titulo{display:flex;align-items:baseline;gap:calc(var(--esp)*2)}
.cabecera .marca{color:var(--mut);font-size:12px}
.conexion{display:inline-flex;align-items:center;gap:var(--esp);font-size:12px;color:var(--mut)}
.punto{width:10px;height:10px;border-radius:50%;background:var(--mut);display:inline-block}
.conexion.vivo .punto{background:var(--ok)}
.conexion.reconectando .punto{background:var(--cola)}
.contadores{font-size:12px;color:var(--mut)}
.concurrencia{display:inline-flex;align-items:center;gap:var(--esp);font-size:12px;color:var(--mut)}
.barra{width:96px;height:8px;background:var(--suave);border:1px solid var(--bd);border-radius:4px;overflow:hidden}
.barra-relleno{height:100%;background:var(--activo)}
.cabecera-nav{margin-left:auto;display:flex;align-items:center;gap:calc(var(--esp)*2)}
.cabecera-nav a{font-size:13px}
.boton{
  font:inherit;font-size:13px;min-height:32px;padding:4px 10px;cursor:pointer;
  background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:var(--radio);
}
.boton:hover{background:var(--suave)}
.boton[aria-pressed=true]{background:var(--activo-suave);border-color:var(--activo)}

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
  overflow:hidden;background:var(--bg);
}
@media (min-width:1700px){.cuerpo{--ancho-lista:440px}}
/* Divisor arrastrable ----------------------------------------------------- */
.divisor{position:relative;background:var(--bd);cursor:col-resize;touch-action:none;outline:none}
.divisor::after{content:'';position:absolute;inset:0 -3px}
.divisor:hover{background:var(--foco)}
.divisor:focus-visible{outline:3px solid var(--foco);outline-offset:-1px;background:var(--foco)}

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
  background:var(--card);border:1px solid var(--bd);border-radius:var(--radio);
  padding:calc(var(--esp)*3) calc(var(--esp)*4);
}
.filtros .campo{display:flex;flex-direction:column;gap:var(--esp)}
.filtros label{font-size:12px;color:var(--mut);font-weight:600}
.filtros input,.filtros select{
  font:inherit;min-height:34px;padding:4px 8px;color:var(--fg);
  background:var(--bg);border:1px solid var(--bd);border-radius:var(--radio);
}
.filtros .acciones{display:flex;gap:var(--esp);margin-left:auto}
.boton-primario{background:var(--activo);color:#fff;border-color:var(--activo);font-weight:600}
.boton-primario:hover{background:var(--foco);border-color:var(--foco);color:#fff}
@media (prefers-color-scheme:dark){.boton-primario,.boton-primario:hover{color:#08122a}}
.tabla-envoltorio{overflow:auto;width:100%;max-width:100%;max-height:70vh;border:1px solid var(--bd);border-radius:var(--radio);background:var(--card)}
.tabla-envoltorio table{border:0;border-radius:0}
.paginacion{display:flex;justify-content:center}
.badge-historico{color:var(--cola);border-color:var(--cola)}
.campo-iso{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--mut)}

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
.lista{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;background:var(--bg);border-right:1px solid var(--bd)}
/* La toolbar queda pegada arriba de la lista (la lista scrollea por debajo). */
.toolbar{flex:none;position:sticky;top:0;z-index:3;display:flex;flex-direction:column;gap:var(--esp);padding:calc(var(--esp)*2) calc(var(--esp)*3);background:var(--card);border-bottom:1px solid var(--bd)}
.busqueda{margin:0}
.busqueda-caja{position:relative;display:flex;align-items:center}
#filtro-texto{
  width:100%;font:inherit;min-height:36px;padding:4px 34px 4px 10px;color:var(--fg);
  background:var(--bg);border:1px solid var(--bd);border-radius:var(--radio);
}
#filtro-texto:focus-visible{background:var(--card)}
.boton-limpiar{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;font:inherit;font-size:16px;line-height:1;cursor:pointer;background:transparent;color:var(--mut);border:1px solid transparent;border-radius:var(--radio)}
.boton-limpiar:hover{background:var(--suave);color:var(--fg)}
/* Control segmentado de estado: una sola fila, no se confunde con repos. */
.segmentado{display:flex;gap:2px;padding:2px;background:var(--suave);border:1px solid var(--bd);border-radius:var(--radio);overflow-x:auto;scrollbar-width:none}
.segmentado::-webkit-scrollbar{display:none}
.toolbar-fila{display:flex;align-items:center;gap:var(--esp)}
.toolbar-fila select{flex:1 1 auto;min-width:0;font:inherit;font-size:13px;min-height:32px;padding:2px 6px;color:var(--fg);background:var(--card);border:1px solid var(--bd);border-radius:var(--radio)}
.toolbar-fila #densidad{flex:none}
.chip{
  font:inherit;font-size:12px;min-height:30px;padding:3px 8px;cursor:pointer;white-space:nowrap;
  background:transparent;color:var(--fg);border:1px solid transparent;border-radius:var(--radio);
}
.chip .cuenta{color:var(--mut);margin-left:4px}
.chip[aria-pressed=true]{background:var(--card);border-color:var(--bd);font-weight:600}
.trabajos{list-style:none;margin:0;padding:var(--esp);overflow:auto;display:flex;flex-direction:column;gap:var(--esp);min-height:0;flex:1 1 auto;overscroll-behavior:contain}
.grupo-encabezado{position:sticky;top:0;z-index:2;display:flex;align-items:baseline;justify-content:space-between;gap:var(--esp);padding:5px 8px;margin-top:calc(var(--esp)*-1);background:var(--bg);border-bottom:1px solid var(--bd);font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--mut)}
.grupo-cuenta{font-weight:400}
.trabajo{
  width:100%;text-align:left;font:inherit;cursor:pointer;display:grid;gap:2px;
  padding:8px 10px;min-height:44px;color:var(--fg);background:var(--card);
  border:1px solid var(--bd);border-radius:var(--radio);border-left-width:4px;
}
.trabajo:hover{background:var(--suave)}
.trabajo[aria-current=true]{border-color:var(--activo);background:var(--activo-suave)}
.trabajo-estado{display:inline-flex;align-items:center;gap:var(--esp);font-size:12px;font-weight:600}
.trabajo-estado .icono{font-size:13px}
.trabajo-titulo{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:14px}
.trabajo-meta{display:flex;flex-wrap:wrap;gap:calc(var(--esp)*2);font-size:12px;color:var(--mut)}
.trabajo-semaforo{border-radius:999px;padding:0 6px;border:1px solid var(--bd)}
.semaforo-verde{color:var(--ok);border-color:var(--ok)}
.semaforo-amarillo{color:var(--cola);border-color:var(--cola)}
.semaforo-rojo{color:var(--mal);border-color:var(--mal)}
.trabajo-espera{color:var(--cola)}
.trabajo-aviso{color:var(--cola)}
/* Densidad compacta: filas y gaps ~30% más chicos, sin perder el objetivo táctil. */
.cuerpo.densidad-compacta .trabajos{gap:2px}
.cuerpo.densidad-compacta .trabajo{padding:5px 8px;min-height:36px}
.cuerpo.densidad-compacta .trabajo-meta,.cuerpo.densidad-compacta .trabajo-estado{font-size:11px}
.vacia{color:var(--mut);font-size:13px;padding:8px}

/* Estados: texto + ícono + color ------------------------------------------ */
.estado-ok{color:var(--ok)}
.estado-mal{color:var(--mal)}
.estado-cola{color:var(--cola)}
.estado-activo{color:var(--activo)}
.estado-neutro{color:var(--mut)}

/* Detalle y pestañas ------------------------------------------------------ */
.detalle{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
.volver{display:none;align-self:flex-start;margin:calc(var(--esp)*2) calc(var(--esp)*3) 0}
#sin-seleccion{padding:calc(var(--esp)*5) calc(var(--esp)*4)}
#detalle-trabajo{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
/* Solo el contenido de la pestaña scrollea: la barra de título + tabs queda fija. */
.detalle-cabecera{flex:none;position:sticky;top:0;z-index:2;background:var(--bg);padding:calc(var(--esp)*2) calc(var(--esp)*3) 0;border-bottom:1px solid var(--bd)}
.titulo-trabajo{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:17px;font-weight:600}
.tabs{display:flex;flex-wrap:nowrap;gap:var(--esp);border-bottom:1px solid var(--bd);overflow-x:auto;margin-bottom:calc(var(--esp)*-1)}
.tabs [role=tab]{
  font:inherit;font-size:13px;min-height:34px;padding:6px 12px;cursor:pointer;white-space:nowrap;
  background:transparent;color:var(--mut);border:1px solid transparent;border-bottom:none;
  border-radius:var(--radio) var(--radio) 0 0;
}
.tabs [role=tab]:hover{color:var(--fg);background:var(--suave)}
.tabs [role=tab][aria-selected=true]{color:var(--fg);background:var(--card);border-color:var(--bd);font-weight:600}
[role=tabpanel]{overflow:auto;min-height:0;flex:1 1 auto;padding:calc(var(--esp)*2) calc(var(--esp)*3);overscroll-behavior:contain}
.cargando,.nota{color:var(--mut);font-size:13px}
.error{color:var(--mal)}
dl.resumen{display:grid;grid-template-columns:max-content 1fr;gap:calc(var(--esp)*2) calc(var(--esp)*3);margin:0 0 calc(var(--esp)*4)}
dl.resumen dt{color:var(--mut);font-size:13px}
dl.resumen dd{margin:0;word-break:break-word}
.prompt{background:var(--suave);border:1px solid var(--bd);border-radius:var(--radio);padding:8px;white-space:pre-wrap;max-height:40vh;overflow:auto;font-size:12px}
pre.salida{background:var(--code);color:var(--codefg);border-radius:var(--radio);padding:10px;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto;font-size:12px;margin:0}
ul.lista-simple{margin:0;padding-left:20px}

/* Consola ----------------------------------------------------------------- */
.consola-barra{display:flex;flex-wrap:wrap;gap:var(--esp);align-items:center;margin-bottom:calc(var(--esp)*2)}
.consola-barra label{font-size:13px;color:var(--mut)}
.consola-barra select,.consola-barra input{font:inherit;min-height:32px;padding:2px 6px;background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:var(--radio)}
.consola-salida{background:var(--code);color:var(--codefg);border-radius:var(--radio);padding:10px;overflow:auto;max-height:60vh;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0}
.aviso-lineas{font-size:12px;color:var(--cola);margin:0 0 var(--esp)}

/* Diff -------------------------------------------------------------------- */
.diff-archivos{display:flex;flex-direction:column;gap:var(--esp)}
details.archivo{background:var(--card);border:1px solid var(--bd);border-radius:var(--radio)}
details.archivo>summary{cursor:pointer;padding:6px 10px;min-height:34px;display:flex;gap:var(--esp);align-items:center;flex-wrap:wrap}
details.archivo>summary::marker{color:var(--mut)}
.archivo-estado{font-weight:700;width:2ch;text-align:center}
.estado-add{color:var(--ok)}
.estado-del{color:var(--mal)}
.estado-mod{color:var(--cola)}
.estado-ren{color:var(--activo)}
.archivo-ruta{font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.archivo-cambios{color:var(--mut);font-size:12px;margin-left:auto}
.parche{margin:0;border-top:1px solid var(--bd);overflow:auto;max-height:50vh;font-size:12px;font-family:ui-monospace,Consolas,monospace}
.parche .hunk-encabezado{background:var(--suave);color:var(--mut);padding:2px 8px;white-space:pre-wrap}
.linea{display:flex;gap:var(--esp);padding:0 8px;white-space:pre-wrap;word-break:break-word}
.linea .num{color:var(--mut);min-width:4ch;text-align:right;user-select:none}
.linea .signo{min-width:1ch;user-select:none;font-weight:700}
.linea-add{background:var(--ok-suave)}
.linea-add .signo{color:var(--ok)}
.linea-del{background:var(--mal-suave)}
.linea-del .signo{color:var(--mal)}
.linea-ctx .signo{color:var(--mut)}
.binario{color:var(--mut);padding:4px 10px}

/* Alcance ----------------------------------------------------------------- */
.alcance{display:flex;flex-direction:column;gap:calc(var(--esp)*3)}
.alcance section{background:var(--card);border:1px solid var(--bd);border-radius:var(--radio);padding:8px 10px}
.alcance h3{margin-bottom:var(--esp)}
.alcance ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.alcance li{display:flex;gap:var(--esp);align-items:center;font-size:13px}
.marca-fuera{color:var(--mal);font-weight:700}
.fuera-item{color:var(--mal)}
.badge{font-size:12px;border:1px solid var(--bd);border-radius:999px;padding:0 6px;color:var(--mut)}

/* Resumen plegable -------------------------------------------------------- */
.titulo-fila{display:flex;align-items:center;gap:calc(var(--esp)*2)}
.titulo-fila .titulo-trabajo{min-width:0}
.titulo-fila .boton{flex:none}
details.plegable{background:var(--card);border:1px solid var(--bd);border-radius:var(--radio);margin:calc(var(--esp)*2) 0}
details.plegable>summary{cursor:pointer;padding:6px 10px;min-height:34px;display:flex;flex-wrap:wrap;gap:var(--esp);align-items:center}
details.plegable>summary::marker{color:var(--mut)}
.plegable-preview{white-space:pre-wrap;color:var(--mut);font-size:12px;font-family:ui-monospace,Consolas,monospace;flex:1;min-width:0}
.plegable-accion{margin-left:auto;color:var(--foco);font-size:12px;white-space:nowrap}
details.plegable[open] .plegable-accion{display:none}
details.plegable>pre{border-radius:0 0 var(--radio) var(--radio)}

/* Pizarrón ---------------------------------------------------------------- */
.tabla-pizarron{border-collapse:collapse;width:100%;background:var(--card)}
.tabla-pizarron th,.tabla-pizarron td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);font-size:13px;vertical-align:top}
.tabla-pizarron th{color:var(--mut);font-weight:600;position:sticky;top:0;background:var(--card);z-index:1}
.tabla-pizarron tbody tr:hover{background:var(--suave)}
.valor-pizarron{font-family:ui-monospace,Consolas,monospace;word-break:break-word;display:block}
.valor-pizarron-resumen{cursor:pointer;color:var(--fg);display:flex;gap:var(--esp);align-items:baseline}
.valor-pizarron-resumen .plegable-accion{margin-left:auto}
.valor-pizarron pre{margin:var(--esp) 0 0;white-space:pre-wrap;word-break:break-word;background:var(--code);color:var(--codefg);border-radius:var(--radio);padding:8px;max-height:40vh;overflow:auto}
.marca-conflicto{color:var(--mal);font-weight:700}
.notas-pizarron{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--esp)}
.nota-pizarron{display:flex;flex-wrap:wrap;gap:calc(var(--esp)*2);align-items:baseline;background:var(--card);border:1px solid var(--bd);border-radius:var(--radio);padding:8px 10px;font-size:13px}
.nota-pizarron .nota-autor{font-weight:600}
.nota-pizarron .nota-texto{flex:1;min-width:0}

/* Auditoría --------------------------------------------------------------- */
.tabla-auditoria{border-collapse:collapse;width:100%;background:var(--card)}
.tabla-auditoria th,.tabla-auditoria td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);font-size:13px;vertical-align:top}
.tabla-auditoria th{color:var(--mut);font-weight:600;position:sticky;top:0;background:var(--card);z-index:1}
.tabla-auditoria tbody tr:hover{background:var(--suave)}
.tabla-auditoria time{white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:12px}


/* Eventos ----------------------------------------------------------------- */
.eventos{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--esp)}
.evento{display:grid;grid-template-columns:auto auto 1fr;gap:calc(var(--esp)*2);align-items:baseline;background:var(--card);border:1px solid var(--bd);border-radius:var(--radio);padding:6px 10px;font-size:13px}
.evento-hora{color:var(--mut);font-family:ui-monospace,Consolas,monospace;font-size:12px}
.evento-tipo{font-weight:600}
.evento-transicion{color:var(--activo)}
.evento-motivo{color:var(--mut)}

/* Diálogo de ayuda -------------------------------------------------------- */
.dialogo{border:1px solid var(--bd);border-radius:var(--radio);background:var(--card);color:var(--fg);max-width:420px;padding:calc(var(--esp)*4)}
.dialogo::backdrop{background:rgba(0,0,0,.45)}
.ayuda-lista{list-style:none;margin:calc(var(--esp)*2) 0;padding:0;display:flex;flex-direction:column;gap:var(--esp)}
.ayuda-lista li{display:flex;justify-content:space-between;gap:calc(var(--esp)*3)}
kbd{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--suave);border:1px solid var(--bd);border-radius:4px;padding:0 6px}

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
  /* Cabecera compacta: contadores y conexión siguen visibles sin comer alto. */
  .cabecera{gap:var(--esp);padding:6px 10px}
  .cabecera .marca{display:none}
  .contadores,.conexion{font-size:11px}
  .cabecera-nav a{font-size:12px}
}

/* Accesibilidad ----------------------------------------------------------- */
*{-webkit-tap-highlight-color:rgba(127,127,127,.18)}
@media (prefers-reduced-motion:reduce){
  .trabajos{scroll-behavior:auto}
  *{transition:none !important;animation:none !important}
}
@media (forced-colors:active){
  .punto,.barra-relleno{border:1px solid CanvasText}
  .trabajo[aria-current=true]{outline:2px solid Highlight}
  .trabajo,.chip,.boton,.tabs [role=tab]{border:1px solid ButtonText}
}
.trabajo,.chip,.boton,.conexion,.barra-relleno{transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease}
`;
