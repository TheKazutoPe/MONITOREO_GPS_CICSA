// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status:      document.getElementById('status'),
  brigada:     document.getElementById('brigadaFilter'),
  minAcc:      document.getElementById('minAcc'),
  lastN:       document.getElementById('lastN'),
  baseSel:     document.getElementById('baseMapSel'),
  showAcc:     document.getElementById('showAcc'),
  followSel:   document.getElementById('followSel'),
  apply:       document.getElementById('applyFilters'),
  exportKmz:   document.getElementById('exportKmzBtn'),
  userList:    document.getElementById('userList')
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  pathLayer: null,
  users: new Map(),
  pointsByUser: new Map(),
  selectedUid: null,
  userPaths: new Map()
};

// ====== Config lógica ======
const SNAP_ALWAYS = true;

// ====== Íconos ======
const ICONS = {
  green : L.icon({ iconUrl: 'assets/carro-green.png',  iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
  yellow: L.icon({ iconUrl: 'assets/carro-orange.png', iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
  gray  : L.icon({ iconUrl: 'assets/carro-gray.png',   iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
  base  : L.icon({ iconUrl: 'assets/carro.png',        iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
};
function getIconFor(row){
  const st = computeStatus(row);
  return ICONS[st] || ICONS.base;
}
['assets/carro.png','assets/carro-green.png','assets/carro-orange.png','assets/carro-gray.png']
  .forEach(src => { const i = new Image(); i.src = src; });

// ====== Helpers ======
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function lerp(a,b,t){return a+(b-a)*t;}
function toRad(x){return x*Math.PI/180;}
function toDeg(x){return x*180/Math.PI;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function distMeters(a,b){const R=6371000;const dLat=toRad(b.lat-a.lat);const dLng=toRad(b.lng-a.lng);const s1=Math.sin(dLat/2),s2=Math.sin(dLng/2);const aa=s1*s1+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*s2*s2;return 2*R*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));}
function speedKmh(a,b){const d=distMeters(a,b)/1000;const dtH=Math.max((new Date(b.timestamp)-new Date(a.timestamp))/3600000,1e-6);return d/dtH;}

// ====== Config filtros segmentación ======
const GAP_MINUTES=4;
const ROUTE_BRIDGE_M=200;
const MAX_JOIN_GAP_M=150;

// ====== Mapbox snap ======
async function routeBetween(a,b){
  try{
    if(CONFIG.MAPBOX_TOKEN){
      const url=`https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${CONFIG.MAPBOX_TOKEN}`;
      const r=await fetch(url);
      const j=await r.json();
      const coords=j.routes?.[0]?.geometry?.coordinates||[];
      return coords.map(([lng,lat])=>({lat,lng}));
    }
  }catch(e){console.warn('routeBetween fail',e);}
  return [a,b];
}
async function mergeOrBridgeCoords(a,b){
  if(!a.length)return b.slice();if(!b.length)return a.slice();
  const last=a[a.length-1],first=b[0];const gap=distMeters(last,first);
  if(gap<=MAX_JOIN_GAP_M)return [...a,...b];
  if(gap<=ROUTE_BRIDGE_M){
    const conn=await routeBetween(last,first);
    return [...a,...conn,...b];
  }
  return [...a];
}
async function snapSegmentToRoad(seg){
  if((CONFIG.ROUTE_PROVIDER||'none')!=='mapbox')return seg;
  try{
    const coords=seg.map(p=>`${p.lng},${p.lat}`).join(';');
    const url=`https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&tidy=true&radiuses=${seg.map(_=>45).join(';')}&access_token=${CONFIG.MAPBOX_TOKEN}`;
    const r=await fetch(url);
    const j=await r.json();
    const geom=j.matchings?.[0]?.geometry?.coordinates||[];
    return geom.map(([lng,lat])=>({lat,lng}));
  }catch(e){console.warn('snap fail',e);return seg;}
}

// ====== Status ======
function computeStatus(r){const m=Math.round((Date.now()-new Date(r.timestamp))/60000);if(m<=2)return'green';if(m<=5)return'yellow';return'gray';}
function buildPopup(r){
  const acc=Math.round(r.acc||0);const spd=(r.spd||0).toFixed(1);
  return `<div><b>${r.tecnico||'(sin nombre)'}</b><br>Brigada: ${r.brigada||'-'}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${new Date(r.timestamp).toLocaleString()}</div>`;
}
function setStatus(t,k){ui.status.textContent=t;ui.status.className=`status-badge ${k||'gray'}`;}

// ====== Mapa ======
function initMap(){
  state.baseLayers.osm=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:20});
  state.baseLayers.sat=L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',{subdomains:['mt0','mt1','mt2','mt3']});
  state.baseLayers.dark=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');
  state.map=L.map('map',{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster=L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);
  ui.baseSel.onchange=()=>{Object.values(state.baseLayers).forEach(l=>state.map.removeLayer(l));(state.baseLayers[ui.baseSel.value]||state.baseLayers.osm).addTo(state.map);};
  ui.apply.onclick=()=>fetchInitial(true);
  ui.exportKmz.onclick=()=>exportKMZFromState();
}
initMap();

// ====== Carga ======
async function fetchInitial(clear){
  setStatus('Cargando…','gray');
  if(clear)ui.userList.innerHTML='';
  const {data,error}=await supa.from('ubicaciones_brigadas')
    .select('*').gte('timestamp',new Date(Date.now()-24*60*60*1000).toISOString())
    .order('timestamp',{ascending:false});
  if(error){setStatus('Error','gray');return;}
  const brig=(ui.brigada.value||'').trim();const minAcc=parseFloat(ui.minAcc.value)||0;const perUser=parseInt(ui.lastN.value||'100');
  const grouped=new Map();
  for(const r of data){
    if(brig&&(r.brigada||'').toLowerCase().indexOf(brig.toLowerCase())===-1)continue;
    if((r.acc||0)<minAcc)continue;
    const uid=String(r.usuario_id||'0');
    if(!grouped.has(uid))grouped.set(uid,[]);
    if(grouped.get(uid).length>=perUser)continue;
    grouped.get(uid).push(r);
  }
  state.pointsByUser.clear();state.cluster.clearLayers();state.users.clear();
  grouped.forEach((rows,uid)=>{
    const last=rows[0];
    const marker=L.marker([last.latitud,last.longitud],{icon:getIconFor(last)}).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid,{marker,lastRow:last});
  });
  setStatus('OK','green');
}

// ====== Realtime ======
function subscribeRealtime(){
  supa.channel('ubicaciones_brigadas-changes')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'ubicaciones_brigadas'},payload=>{
      const row=payload.new;
      const uid=String(row.usuario_id||'0');
      let u=state.users.get(uid);
      if(!u){
        const m=L.marker([row.latitud,row.longitud],{icon:getIconFor(row)}).bindPopup(buildPopup(row));
        state.cluster.addLayer(m);state.users.set(uid,{marker:m,lastRow:row});
        return;
      }
      u.lastRow=row;
      u.marker.setLatLng([row.latitud,row.longitud]).setPopupContent(buildPopup(row)).setIcon(getIconFor(row));
    }).subscribe(()=>setStatus('Conectado','green'));
}
subscribeRealtime();

// ====== Exportar KMZ con autocompletado ======
async function exportKMZFromState(){
  const today=new Date();
  const start=new Date(today.getFullYear(),today.getMonth(),today.getDate(),0,0,0);
  const end=new Date(today.getFullYear(),today.getMonth(),today.getDate()+1,0,0,0);
  const brig=(ui.brigada.value||'').trim();
  const {data,error}=await supa.from('ubicaciones_brigadas')
    .select('*').gte('timestamp',start.toISOString()).lt('timestamp',end.toISOString()).order('timestamp',{ascending:true});
  if(error){alert('Error al exportar');return;}

  const byUser=new Map();
  for(const r of data){
    if(brig&&(r.brigada||'').toLowerCase().indexOf(brig.toLowerCase())===-1)continue;
    const uid=String(r.usuario_id||'0');
    if(!byUser.has(uid))byUser.set(uid,[]);
    byUser.get(uid).push(r);
  }

  let kml=`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Monitoreo GPS ${start.toISOString().slice(0,10)}</name>`;
  for(const [uid,rows] of byUser.entries()){
    if(rows.length<2)continue;
    let segs=[rows.map(r=>({lat:r.latitud,lng:r.longitud,timestamp:r.timestamp}))];
    let full=[];
    for(const seg of segs){
      let snap=await snapSegmentToRoad(seg);
      full=await mergeOrBridgeCoords(full,snap);
      await sleep(100);
    }
    const coords=full.map(s=>`${s.lng},${s.lat},0`).join(' ');
    const name=(rows[0].tecnico||`Brigada ${uid}`).replace(/&/g,'&amp;');
    kml+=`<Placemark><name>${name}</name><Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
  }
  kml+=`</Document></kml>`;

  const zip=new JSZip();zip.file('doc.kml',kml);
  const blob=await zip.generateAsync({type:'blob'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=`monitoreo_${start.toISOString().slice(0,10)}.kmz`;a.click();
  URL.revokeObjectURL(a.href);
}

setStatus('Cargando...','gray');
fetchInitial(true);
