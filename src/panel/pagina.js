/**
 * Página única del panel (HTML + JS + CSS en línea, sin dependencias).
 * El texto del agente se inserta SIEMPRE con textContent (nunca innerHTML).
 */
export const PAGINA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trabajos de opencode</title>
<style>
:root{--bg:#f5f6f8;--fg:#1d2330;--card:#fff;--bd:#d9dde4;--mut:#6b7385;--ok:#1a9a4a;--warn:#d89a00;--bad:#d03a3a;--code:#10141c;--codefg:#d6dde8}
@media(prefers-color-scheme:dark){:root{--bg:#12151c;--fg:#e3e7ef;--card:#1b2029;--bd:#2c3340;--mut:#8f99ad;--code:#0b0e13}}
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 16px;border-bottom:1px solid var(--bd);display:flex;gap:12px;align-items:baseline}
h1{font-size:16px;margin:0}#meta{color:var(--mut);font-size:12px}
main{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:12px;padding:12px;height:calc(100vh - 50px)}
@media(max-width:800px){main{grid-template-columns:1fr;height:auto}}
#lista{overflow:auto;display:flex;flex-direction:column;gap:8px}
.job{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px;cursor:pointer}
.job.sel{outline:2px solid #4a7dff}.job h3{margin:0 0 4px;font-size:13px}
.fila{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--mut);font-size:12px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:var(--bd)}
.verde{background:var(--ok)}.amarillo{background:var(--warn)}.rojo{background:var(--bad)}
.est{font-weight:600;color:var(--fg)}
.st-rejected,.st-failed,.st-lost{color:var(--bad)}.st-succeeded,.st-merged{color:var(--ok)}
#detalle{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px;overflow:auto}
pre{background:var(--code);color:var(--codefg);padding:10px;border-radius:6px;overflow:auto;max-height:55vh;white-space:pre-wrap;word-break:break-word;font:12px ui-monospace,Consolas,monospace}
.err{border-left:4px solid var(--bad)}h2{font-size:14px;margin:14px 0 6px}
button{font:inherit;padding:2px 8px}
</style></head><body>
<header><h1>Trabajos de opencode</h1><span id="meta">cargando…</span></header>
<main><section id="lista"></section><section id="detalle"><p>Elegí un trabajo.</p></section></main>
<script>
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e};
let sel=null,seguir=true;
const dur=s=>{if(s==null)return '–';const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'h '+m+'m':m?m+'m '+(s%60)+'s':s+'s'};
const MOTIVOS={dependencia:'espera sus dependencias',concurrencia:'tope de concurrencia',recurso:'espera un recurso compartido (base de datos)',solapa_alcance:'sus writes se solapan con otro trabajo',veterano_adelante:'otro trabajo más antiguo va primero'};
const textoEspera=e=>(MOTIVOS[e.motivo]||e.motivo)+(e.por&&e.por.length?' ['+e.por.join(', ')+']':'');
function tarjeta(j){
  const d=el('div','job'+(j.id===sel?' sel':''));d.onclick=()=>{sel=j.id;pintarDetalle()};
  d.append(el('h3','',j.titulo||j.id));
  const f=el('div','fila');
  const dot=el('span','dot '+(j.semaforo||''));f.append(dot);
  f.append(el('span','est st-'+j.estado,j.estado));
  f.append(el('span','',dur(j.duracionS)));
  if(j.semaforo)f.append(el('span','','última salida hace '+dur(j.segundosSinSalida)));
  f.append(el('span','',j.id));
  d.append(f);
  if(j.espera){d.append(el('div','fila','En cola: '+textoEspera(j.espera)))}
  return d}
async function pintarLista(){
  try{
    const r=await (await fetch('api/trabajos')).json();
    const l=document.getElementById('lista');l.replaceChildren(...r.trabajos.map(tarjeta));
    const act=r.trabajos.filter(j=>j.semaforo).length;
    document.getElementById('meta').textContent=r.trabajos.length+' trabajos · '+act+' activos · actualizado '+new Date(r.ahora).toLocaleTimeString();
    if(!sel&&r.trabajos[0]){sel=r.trabajos[0].id}
  }catch(e){document.getElementById('meta').textContent='sin conexión con el panel'}
}
async function pintarDetalle(){
  if(!sel)return;const box=document.getElementById('detalle');
  try{
    const r=await fetch('api/trabajos/'+encodeURIComponent(sel));if(!r.ok)return;const j=await r.json();
    const ant=box.querySelector('pre.tr');const abajo=!ant||ant.scrollTop+ant.clientHeight>=ant.scrollHeight-40;
    const nodos=[];
    const cab=el('div','fila');cab.append(el('span','dot '+(j.semaforo||'')),el('b','st-'+j.estado,j.estado),
      el('span','',dur(j.duracionS)),el('span','',j.modelo||''),el('span','',j.rama||''));
    if(j.semaforo)cab.append(el('b','','última salida hace '+dur(j.segundosSinSalida)));
    nodos.push(el('h2','',j.titulo||j.id),cab);
    if(j.error)nodos.push(el('pre','err',String(j.error)));
    if(j.fallos){nodos.push(el('h2','','Aceptación: qué falló'));nodos.push(el('pre','err',j.fallos))}
    else if(j.aceptacion){nodos.push(el('h2','','Aceptación: '+(j.aceptacion.exit===0?'OK':'exit '+j.aceptacion.exit)+' — '+(j.aceptacion.cmd||'')))}
    nodos.push(el('h2','','Lo que hace el agente (transcript en vivo)'));
    const tr=el('pre','tr',j.transcript||'(sin salida todavía)');nodos.push(tr);
    if(j.respuesta){nodos.push(el('h2','','Respuesta final del agente'));nodos.push(el('pre','',j.respuesta))}
    if(j.advertencias.length){nodos.push(el('h2','','Advertencias'));nodos.push(el('pre','',j.advertencias.join('\\n')))}
    box.replaceChildren(...nodos);
    if(abajo)tr.scrollTop=tr.scrollHeight;
  }catch(e){}
}
async function ciclo(){await pintarLista();await pintarDetalle()}
ciclo();setInterval(ciclo,2500);
</script></body></html>`;
