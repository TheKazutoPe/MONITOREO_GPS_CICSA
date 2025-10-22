// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById('status'),
  brigada: document.getElementById('brigadaFilter'),
  minAcc: document.getElementById('minAcc'),
  baseSel: document.getElementById('baseMapSel'),
  apply: document.getElementById('applyFilters'),
  exportKmz: document.getElementById('exportKmzBtn'),
  userList: document.getElementById('userList'),
};

// ====== Estado general ======
const state = {
  map: null,
  baseLayers: {},
  markers: new Map(),     // uid -> { marker, lastRow, color }
  paths: new Map(),       // uid -> L.polyline[]
  brigadaColors: new Map(),
};

// ====== Helpers ======
function randColor(seed) {
  // genera color distintivo estable por brigada
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const h = hash % 360;
  return `hsl(${h}, 80%, 55%)`;
}
function dist(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function lerp(a,b,t){ return a + (b - a) * t; }
function easeInOut(t){ return t<.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function minsAgo(ts){ return Math.round((Date.now()-new Date(ts).getTime())/60000); }
function fmtTimeAgo(ts){
  const m = minsAgo(ts);
  if(m<1) return 'hace segundos';
  if(m===1) return 'hace 1 min';
  return `hace ${m} min`;
}

// ====== Mapa base ======
function initMap(){
  state.baseLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:20});
  state.baseLayers.sat = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',{subdomains:['mt0','mt1','mt2','mt3']});
  state.baseLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');
  state.baseLayers.light = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png');
  state.baseLayers.topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png');
  state.baseLayers.gray = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner-lite/{z}/{x}/{y}.png');

  state.map = L.map('map', {center:[-12.0464,-77.0428], zoom:12, layers:[state.baseLayers.osm]});
  ui.baseSel.onchange = () => {
    Object.values(state.baseLayers).forEach(l=>state.map.removeLayer(l));
    (state.baseLayers[ui.baseSel.value] || state.baseLayers.osm).addTo(state.map);
  };
  ui.apply.onclick = ()=>fetchInitial(true);
  ui.exportKmz.onclick = ()=>exportKmzAll();
}
initMap();

// ====== Marker animation ======
function animateMarker(marker, from, to, spd){
  if(!from||!to) return marker.setLatLng(to||from);
  const d = dist(from,to);
  const dur = clamp(d / (spd>0?spd:8) * 800, 300, 3000);
  const start = performance.now();
  function step(now){
    const t = clamp((now-start)/dur,0,1);
    const k = easeInOut(t);
    const cur = L.latLng(lerp(from.lat,to.lat,k), lerp(from.lng,to.lng,k));
    marker.setLatLng(cur);
    if(t<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ====== Popup & status ======
function computeStatus(r){
  const m = minsAgo(r.timestamp);
  if(m<=2) return 'green';
  if(m<=5) return 'yellow';
  return 'gray';
}
function buildPopup(r){
  return `
    <b>${r.tecnico || '(sin nombre)'}</b><br/>
    Brigada: ${r.brigada || '-'}<br/>
    Zona: ${r.zona || '-'}<br/>
    Velocidad: ${(r.spd||0).toFixed(1)} m/s<br/>
    Exactitud: ${(r.acc||0).toFixed(1)} m<br/>
    ${new Date(r.timestamp).toLocaleString()}
  `;
}
function setStatus(text, kind){
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}

// ====== Carga inicial ======
async function fetchInitial(clear){
  setStatus('Cargando...', 'gray');
  if(clear){
    ui.userList.innerHTML='';
    state.markers.forEach(m=>state.map.removeLayer(m.marker));
    state.paths.forEach(p=>p.forEach(pl=>state.map.removeLayer(pl)));
    state.markers.clear(); state.paths.clear();
  }

  const {data,error} = await supa.from('ubicaciones_brigadas')
    .select('*')
    .gte('timestamp', new Date(Date.now()-24*3600*1000).toISOString())
    .order('timestamp',{ascending:false});
  if(error){console.error(error); setStatus('Error','gray'); return;}

  const brigF = ui.brigada.value.trim().toLowerCase();
  const minAcc = parseFloat(ui.minAcc.value)||0;
  const grouped = new Map();
  for(const r of data){
    if(brigF && !(r.brigada||'').toLowerCase().includes(brigF)) continue;
    if((r.acc||0)<minAcc) continue;
    const id = r.usuario_id||0;
    if(!grouped.has(id)) grouped.set(id,[]);
    grouped.get(id).push(r);
  }

  grouped.forEach((rows,uid)=>{
    const last = rows[0];
    const brig = last.brigada||`Brig-${uid}`;
    const color = state.brigadaColors.get(brig) || randColor(brig);
    state.brigadaColors.set(brig,color);

    const icon = L.icon({iconUrl:'assets/carro-animado.png',iconSize:[42,26],iconAnchor:[21,13]});
    const marker = L.marker([last.latitud,last.longitud],{icon}).bindPopup(buildPopup(last));
    marker.addTo(state.map);

    state.markers.set(uid,{marker,lastRow:last,color});
    addUserItem(uid,last);

    drawPathForUser(uid,rows,color);
  });
  setStatus('Conectado','green');
}

// ====== Lista lateral ======
function addUserItem(uid,row){
  const li=document.createElement('li');
  li.className='user-item';
  li.dataset.uid=uid;
  li.innerHTML=`
    <div class="title"><span class="dot ${computeStatus(row)}"></span>${row.tecnico||'(sin nombre)'}</div>
    <div class="meta">Brigada: ${row.brigada||'-'} · ${fmtTimeAgo(row.timestamp)}</div>`;
  li.onclick=()=>{
    const u=state.markers.get(uid);
    if(u) state.map.setView(u.marker.getLatLng(),15);
  };
  ui.userList.appendChild(li);
}
function refreshUser(uid,row){
  const card=ui.userList.querySelector(`[data-uid="${uid}"]`);
  if(card){
    card.querySelector('.dot').className=`dot ${computeStatus(row)}`;
    card.querySelector('.meta').innerHTML=`Brigada: ${row.brigada||'-'} · ${fmtTimeAgo(row.timestamp)}`;
  }
}

// ====== Realtime ======
function subscribeRealtime(){
  supa.channel('ubicaciones_brigadas-changes')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'ubicaciones_brigadas'},p=>onInsert(p.new))
    .subscribe(()=>setStatus('Conectado','green'));
}
subscribeRealtime();

function onInsert(r){
  const brigF = ui.brigada.value.trim().toLowerCase();
  const minAcc = parseFloat(ui.minAcc.value)||0;
  if(brigF && !(r.brigada||'').toLowerCase().includes(brigF)) return;
  if((r.acc||0)<minAcc) return;

  const uid=r.usuario_id||0;
  const brig=r.brigada||`Brig-${uid}`;
  const color = state.brigadaColors.get(brig) || randColor(brig);
  state.brigadaColors.set(brig,color);

  let u=state.markers.get(uid);
  if(!u){
    const icon=L.icon({iconUrl:'assets/carro-animado.png',iconSize:[42,26],iconAnchor:[21,13]});
    const marker=L.marker([r.latitud,r.longitud],{icon}).bindPopup(buildPopup(r));
    marker.addTo(state.map);
    state.markers.set(uid,{marker,lastRow:r,color});
    addUserItem(uid,r);
    drawPathForUser(uid,[r],color);
    return;
  }

  const prev=u.lastRow;
  const from={lat:prev.latitud,lng:prev.longitud};
  const to={lat:r.latitud,lng:r.longitud};
  const gapMin=(new Date(r.timestamp)-new Date(prev.timestamp))/60000;

  // animación
  animateMarker(u.marker,from,to,r.spd||5);
  u.marker.setPopupContent(buildPopup(r));
  u.lastRow=r;
  refreshUser(uid,r);
  updatePath(uid,from,to,gapMin,color);
}

// ====== Dibujar rutas ======
function drawPathForUser(uid,rows,color){
  const points=rows.map(r=>[r.latitud,r.longitud]);
  const poly=L.polyline(points,{color,weight:4,opacity:0.9}).addTo(state.map);
  state.paths.set(uid,[poly]);
}
function updatePath(uid,from,to,gapMin,color){
  const segOk=gapMin<=4;
  const style=segOk
    ? {color,weight:4,opacity:0.9}
    : {color,weight:3,opacity:0.6,dashArray:'6,6'};
  const seg=L.polyline([[from.lat,from.lng],[to.lat,to.lng]],style).addTo(state.map);
  const arr=state.paths.get(uid)||[];
  arr.push(seg);
  state.paths.set(uid,arr);
}

// ====== Exportar KMZ ======
async function exportKmzAll(){
  const today=new Date();
  const start=new Date(today.getFullYear(),today.getMonth(),today.getDate(),0,0,0);
  const end=new Date(today.getFullYear(),today.getMonth(),today.getDate()+1,0,0,0);
  const {data,error}=await supa.from('ubicaciones_brigadas')
    .select('*').gte('timestamp',start.toISOString()).lt('timestamp',end.toISOString()).order('timestamp',{ascending:true});
  if(error){alert('Error al consultar datos');return;}

  const byUser=new Map();
  for(const r of data){
    const id=r.usuario_id||0;
    if(!byUser.has(id)) byUser.set(id,[]);
    byUser.get(id).push(r);
  }

  let kml=`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n`;
  kml+=`<name>Monitoreo GPS - ${start.toISOString().slice(0,10)}</name>\n`;

  byUser.forEach((rows,uid)=>{
    if(!rows.length)return;
    const name=(rows[0].tecnico||`Usuario ${uid}`).replace(/&/g,'&amp;');
    const brig=rows[0].brigada||`Brig-${uid}`;
    const colorHex=rgbToKml(state.brigadaColors.get(brig)||randColor(brig));
    kml+=`<Folder><name>${brig} - ${name}</name>\n`;

    for(let i=1;i<rows.length;i++){
      const a=rows[i-1],b=rows[i];
      const gapMin=(new Date(b.timestamp)-new Date(a.timestamp))/60000;
      const dash=gapMin>4;
      const styleId=dash?'reconstruido':'normal';
      kml+=`<Style id="${styleId}"><LineStyle><color>${dash?'7d': 'ff'}${colorHex}</color><width>${dash?3:4}</width></LineStyle></Style>\n`;
      const coords=`${a.longitud},${a.latitud},0 ${b.longitud},${b.latitud},0`;
      kml+=`<Placemark><styleUrl>#${styleId}</styleUrl><LineString><coordinates>${coords}</coordinates></LineString></Placemark>\n`;
    }
    const last=rows[rows.length-1];
    kml+=`<Placemark><name>${name} (último)</name><Point><coordinates>${last.longitud},${last.latitud},0</coordinates></Point></Placemark>\n`;
    kml+='</Folder>\n';
  });
  kml+='</Document></kml>';

  const zip=new JSZip();
  zip.file('doc.kml',kml);
  const blob=await zip.generateAsync({type:'blob'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`CICSA_Monitoreo_${start.toISOString().slice(0,10)}.kmz`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function rgbToKml(hsl){
  const tmp=document.createElement('div');
  tmp.style.color=hsl;
  document.body.appendChild(tmp);
  const rgb=getComputedStyle(tmp).color;
  document.body.removeChild(tmp);
  const [r,g,b]=rgb.match(/\d+/g).map(Number);
  const hex=x=>x.toString(16).padStart(2,'0');
  return `${hex(b)}${hex(g)}${hex(r)}`;
}

// ====== Boot ======
fetchInitial(true);
setInterval(()=>fetchInitial(false),5*60*1000);
