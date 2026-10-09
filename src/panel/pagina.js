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
<header><h1>Trabajos de opencode</h1><a href="/auditoria">Auditoría</a><span id="meta">cargando…</span></header>
<main><section id="lista"></section><section id="detalle"><p>Elegí un trabajo.</p></section></main>
<script>
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e};
let sel=new URLSearchParams(location.search).get('job'),seguir=true;
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

/** Escapa texto para insertarlo en HTML (la auditoría muestra datos leídos de disco). */
function escaparHtml(valor) {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Hora en ISO UTC: estable para tests y para comparar entre máquinas. */
function horaEvento(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n).toISOString() : '';
}

/** Columna estado: muestra `anterior → nuevo` cuando hay transición. */
function estadoEvento(evento) {
  if (evento.anterior !== undefined && evento.estado !== undefined) {
    return `${evento.anterior} → ${evento.estado}`;
  }
  return evento.estado !== undefined ? evento.estado : '';
}

/**
 * Página de auditoría (HTML plano, renderizado en el servidor, sin JS pesado).
 * Los filtros viajan por query string y se reenvían al registro.
 * @param {{ eventos?: object[], tipos?: readonly string[], filtros?: object, disponible?: boolean }} [datos]
 * @returns {string}
 */
export function paginaAuditoria({ eventos = [], tipos = [], filtros = {}, disponible = true } = {}) {
  const opciones = ['', ...tipos]
    .map((t) => {
      const sel = t === filtros.tipo ? ' selected' : '';
      return `<option value="${escaparHtml(t)}"${sel}>${escaparHtml(t || 'todos')}</option>`;
    })
    .join('');
  const filas = eventos
    .map((e) => {
      const trabajo = e.jobId
        ? `<a href="/?job=${encodeURIComponent(e.jobId)}">${escaparHtml(e.jobId)}</a>`
        : '';
      return `<tr><td>${escaparHtml(horaEvento(e.ts))}</td><td>${escaparHtml(e.tipo)}</td>` +
        `<td>${trabajo}</td><td>${escaparHtml(estadoEvento(e))}</td>` +
        `<td>${escaparHtml(e.motivo)}</td><td>${escaparHtml(e.actor)}</td></tr>`;
    })
    .join('');
  const cuerpo = disponible
    ? `<table><thead><tr><th>hora</th><th>tipo</th><th>trabajo</th><th>estado</th><th>motivo</th><th>actor</th></tr></thead><tbody>${filas}</tbody></table>`
    : '<p>Auditoría no disponible</p>';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auditoría de opencode</title>
<style>
:root{--bg:#f5f6f8;--fg:#1d2330;--card:#fff;--bd:#d9dde4;--mut:#6b7385;--code:#10141c}
@media(prefers-color-scheme:dark){:root{--bg:#12151c;--fg:#e3e7ef;--card:#1b2029;--bd:#2c3340;--mut:#8f99ad}}
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 16px;border-bottom:1px solid var(--bd);display:flex;gap:12px;align-items:baseline}
h1{font-size:16px;margin:0}a{color:inherit}
main{padding:12px}
form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
input,select,button{font:inherit;padding:3px 6px;background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:4px}
table{border-collapse:collapse;width:100%;background:var(--card)}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd);font-size:13px;vertical-align:top}
th{color:var(--mut);font-weight:600}
</style></head><body>
<header><h1>Auditoría de opencode</h1><a href="/">← Trabajos</a></header>
<main>
<form method="get" action="/auditoria">
<label>trabajo <input name="jobId" value="${escaparHtml(filtros.jobId ?? '')}"></label>
<label>tipo <select name="tipo">${opciones}</select></label>
<label>desde <input name="desde" value="${escaparHtml(filtros.desde ?? '')}" size="14"></label>
<label>hasta <input name="hasta" value="${escaparHtml(filtros.hasta ?? '')}" size="14"></label>
<button type="submit">Filtrar</button>
<a href="/auditoria">Recargar</a>
</form>
${cuerpo}
</main></body></html>`;
}
