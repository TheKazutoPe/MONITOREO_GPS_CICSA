// main.js
(() => {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    MAPBOX_TOKEN,
    KMZ
  } = window.APP_CONFIG;

  if (!MAPBOX_TOKEN || !MAPBOX_TOKEN.startsWith('pk.')) {
    console.warn('⚠️ Debes configurar MAPBOX_TOKEN (pk.*) en config.js');
  }

  // ========= Supabase =========
  const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ========= UI refs =========
  const ui = {
    conn: document.getElementById('conn-badge'),
    fit: document.getElementById('btn-fit'),
    listado: document.getElementById('listado'),
    brigada: document.getElementById('f-brigada'),
    limit: document.getElementById('f-limit'),
    aplicar: document.getElementById('btn-aplicar'),

    // KMZ
    kmzBrigada: document.getElementById('kmz-brigada'),
    kmzDesde: document.getElementById('kmz-desde'),
    kmzHasta: document.getElementById('kmz-hasta'),
    kmzBtn: document.getElementById('btn-exportar-kmz')
  };

  // ========= Estado =========
  const state = {
    map: null,
    cluster: null,
    markers: new Map(),    // brigada -> { marker, last:{lat,lon,ts}, anim:{...} }
    baseLayers: {},
    appliedFilter: { brigada: '', limit: 100 },
  };

  // ========= Inicialización del mapa =========
  function initMap() {
    state.map = L.map('map', {
      center: [-12.0464, -77.0428],
      zoom: 12,
      worldCopyJump: true
    });

    state.baseLayers.streets = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      { tileSize: 512, zoomOffset: -1, attribution: '© OpenStreetMap © Mapbox' }
    ).addTo(state.map);

    state.baseLayers.sat = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      { tileSize: 512, zoomOffset: -1, attribution: '© OpenStreetMap © Mapbox' }
    );

    L.control.layers({ Calle: state.baseLayers.streets, Satélite: state.baseLayers.sat }, null, { position: 'topleft' }).addTo(state.map);

    state.cluster = L.markerClusterGroup({ maxClusterRadius: 40 });
    state.map.addLayer(state.cluster);

    ui.fit.addEventListener('click', fitToMarkers);
    window.addEventListener('offline',  () => setConn('Sin conexión', 'warning'));
    window.addEventListener('online',   () => setConn('Reconectando…', 'secondary'));
  }

  function setConn(text, look='secondary') {
    ui.conn.className = `badge bg-${look}`;
    ui.conn.textContent = text;
  }

  function fitToMarkers() {
    const layers = state.cluster.getLayers();
    if (!layers.length) return;
    const bounds = L.latLngBounds(layers.map(m => m.getLatLng()));
    state.map.fitBounds(bounds, { padding: [40, 40] });
  }

  // ========= Helpers =========
  const toUnix = d => Math.floor(new Date(d).getTime() / 1000);
  const haversine = (a, b) => {
    const R = 6371000, toRad = x => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(A));
  };
  const bearing = (a, b) => { // grados 0..360
    const toRad = x => x * Math.PI / 180, toDeg = x => x * 180 / Math.PI;
    const φ1 = toRad(a.lat), φ2 = toRad(b.lat), λ1 = toRad(a.lon), λ2 = toRad(b.lon);
    const y = Math.sin(λ2-λ1) * Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };
  const ease = t => t<.5 ? 2*t*t : -1+(4-2*t)*t; // easeInOutQuad

  function statusFromAge(seconds){
    if (seconds <= 120) return 'live';
    if (seconds <= 300) return 'warn';
    return 'idle';
  }

  function carDivIcon(status='idle', deg=0) {
    const html = `<div class="car-icon ${status}" style="transform: rotate(${deg}deg)"></div>`;
    return L.divIcon({ html, className: 'car-wrap', iconSize: [32,20], iconAnchor: [16,10] });
  }

  function updateListItem(b, lastTs, status){
    const id = `li-${b}`;
    let li = document.getElementById(id);
    const dateStr = new Date(lastTs*1000).toLocaleString('es-PE', { hour12:false });
    const dot = status==='live' ? 'dot-live' : status==='warn' ? 'dot-warn' : 'dot-idle';
    const html = `
      <div class="d-flex justify-content-between align-items-center">
        <div class="text-truncate">
          <span class="badge-dot ${dot}"></span>
          <strong>${b}</strong>
        </div>
        <span class="text-secondary ms-2">${dateStr}</span>
      </div>`;
    if (!li) {
      li = document.createElement('li');
      li.id = id;
      li.className = 'list-group-item';
      ui.listado.prepend(li);
    }
    li.innerHTML = html;
  }

  // ========= Marcadores con animación =========
  function ensureMarker(brigada, lat, lon, ts){
    let rec = state.markers.get(brigada);
    const now = Math.floor(Date.now()/1000);
    const status = statusFromAge(now - ts);

    if (!rec) {
      const icon = carDivIcon(status, 0);
      const marker = L.marker([lat, lon], { icon });
      marker.bindPopup(`<b>${brigada}</b><br>${new Date(ts*1000).toLocaleString('es-PE', {hour12:false})}`);
      state.cluster.addLayer(marker);
      rec = { marker, last: { lat, lon, ts }, anim: null, bearing: 0 };
      state.markers.set(brigada, rec);
      updateListItem(brigada, ts, status);
      return;
    }

    // Animación: interpolar en 600–900ms según distancia (cap)
    const start = rec.last;
    const end = { lat, lon, ts };
    const dist = haversine(start, end);
    const dur = Math.min(900, Math.max(400, dist / 8)); // ms
    const brg = bearing(start, end);

    // cancelar animación previa si existe
    if (rec.anim && rec.anim.cancel) rec.anim.cancel = true;

    const mk = rec.marker;
    const startPos = L.latLng(start.lat, start.lon);
    const endPos   = L.latLng(end.lat, end.lon);
    const t0 = performance.now();
    const anim = { cancel:false };
    rec.anim = anim;

    (function step(t){
      if (anim.cancel) return;
      const dt = (t - t0) / dur;
      const k = dt >= 1 ? 1 : ease(dt);
      const latI = startPos.lat + (endPos.lat - startPos.lat) * k;
      const lonI = startPos.lng + (endPos.lng - startPos.lng) * k;
      mk.setLatLng([latI, lonI]);

      // rotación
      if (mk._icon) mk._icon.firstChild.style.transform = `rotate(${brg}deg)`;

      if (dt < 1) requestAnimationFrame(step); else {
        // estado final
        const now2 = Math.floor(Date.now()/1000);
        const s2 = statusFromAge(now2 - end.ts);
        mk.setIcon(carDivIcon(s2, brg));
        mk.setPopupContent(`<b>${brigada}</b><br>${new Date(end.ts*1000).toLocaleString('es-PE',{hour12:false})}`);
        state.markers.set(brigada, { marker: mk, last: end, anim: null, bearing: brg });
        updateListItem(brigada, end.ts, s2);
      }
    })(t0);
  }

  // ========= Carga inicial & realtime =========
  async function fetchInitial(resetBounds=false){
    const brig = state.appliedFilter.brigada.trim();
    const lim  = Number(state.appliedFilter.limit) || 100;

    ui.listado.innerHTML = '';

    // limpiamos cluster/markers
    state.cluster.clearLayers();
    state.markers.clear();

    let q = supabaseClient.from('ubicaciones_brigadas')
      .select('brigada, latitud, longitud, timestamp')
      .order('timestamp', { ascending: false });

    if (brig) q = q.eq('brigada', brig);
    q = q.limit(Math.min(5000, lim * 20)); // tope

    const { data, error } = await q;
    if (error) { console.error(error); return; }

    // agrupa por brigada y toma los últimos N por brigada
    const byB = new Map();
    for (const r of data) {
      const b = r.brigada || 'SIN_NOMBRE';
      if (!byB.has(b)) byB.set(b, []);
      const arr = byB.get(b);
      if (arr.length < lim) arr.push(r);
    }

    // dibuja últimos puntos
    byB.forEach((arr, b) => {
      const last = arr[0];
      ensureMarker(b, Number(last.latitud), Number(last.longitud), Math.floor(new Date(last.timestamp).getTime()/1000));
    });

    if (resetBounds) fitToMarkers();
  }

  function applyFilter(){
    state.appliedFilter.brigada = ui.brigada.value || '';
    state.appliedFilter.limit   = ui.limit.value || 100;
    fetchInitial(true);
  }

  // realtime
  function subscribeRealtime(){
    setConn('Conectando…', 'secondary');
    const channel = supabaseClient
      .channel('ubicaciones-stream')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, payload => {
        const r = payload.new;
        if (!r) return;
        const matchBrig = (state.appliedFilter.brigada || '').trim();
        if (matchBrig && r.brigada !== matchBrig) return;
        const lat = Number(r.latitud), lon = Number(r.longitud);
        const ts  = Math.floor(new Date(r.timestamp).getTime()/1000);
        ensureMarker(r.brigada || 'SIN_NOMBRE', lat, lon, ts);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setConn('Conectado', 'success');
      });

    // reintento simple si se cae
    supabaseClient.getChannels().forEach(c => c.on('close', () => setConn('Reconectando…', 'warning')));
  }

  // ========= KMZ preciso (Map Matching SOLO en export) =========
  async function loadDistinctBrigadas(){
    const { data, error } = await supabaseClient
      .from('ubicaciones_brigadas')
      .select('brigada')
      .not('brigada','is',null)
      .order('brigada', { ascending:true })
      .limit(10000);

    if (error) { console.error(error); return; }
    const set = new Set(data.map(d => (d.brigada||'').trim()).filter(Boolean));
    ui.kmzBrigada.innerHTML = '<option value="">(Selecciona brigada)</option>' + [...set].map(b=>`<option>${b}</option>`).join('');
  }

  async function fetchPointsFor(brigada, fromISO, toISO){
    let q = supabaseClient.from('ubicaciones_brigadas')
      .select('latitud,longitud,timestamp')
      .eq('brigada', brigada)
      .order('timestamp', { ascending: true })
      .limit(20000);

    if (fromISO) q = q.gte('timestamp', fromISO);
    if (toISO)   q = q.lte('timestamp', toISO);

    const { data, error } = await q;
    if (error) throw error;

    return (data||[]).map(r => ({
      lat: Number(r.latitud),
      lon: Number(r.longitud),
      ts: Math.floor(new Date(r.timestamp).getTime()/1000)
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }

  function decimate(points, minMeters=KMZ.MIN_METERS, minSecs=KMZ.MIN_SECONDS){
    if (points.length <= 2) return points;
    const out = [points[0]];
    let last = points[0];
    for (let i=1;i<points.length;i++){
      const p = points[i];
      const dt = p.ts - last.ts;
      if (dt < minSecs) continue;
      if (haversine(last, p) < minMeters) continue;
      out.push(p); last = p;
    }
    if (out[out.length-1] !== points[points.length-1]) out.push(points[points.length-1]);
    return out;
  }

  function chunk(arr, size=KMZ.CHUNK_SIZE){
    const out = [];
    for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size));
    return out;
  }

  async function mapMatchChunk(points){
    if (points.length < 2) return null;
    const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
    const timestamps = points.map(p => p.ts).join(';');
    const radiuses = points.map(() => KMZ.RADIUS_METERS).join(';');

    const url = `https://api.mapbox.com/matching/v5/mapbox/${KMZ.PROFILE}/${coords}`
      + `?access_token=${MAPBOX_TOKEN}`
      + `&geometries=geojson&tidy=true&timestamps=${timestamps}&radiuses=${radiuses}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error('Map Matching error ' + r.status);
    const j = await r.json();
    const best = (j.matchings && j.matchings[0]) || null;
    return best ? best.geometry : null; // {type:'LineString', coordinates:[[lon,lat],...]}
  }

  function kmlForLineString(name, coordsLonLat){
    const coordsTxt = coordsLonLat.map(([lon,lat]) => `${lon},${lat},0`).join(' ');
    return `
<Placemark>
  <name>${name}</name>
  <Style>
    <LineStyle><color>ff00A6FF</color><width>4</width></LineStyle>
  </Style>
  <LineString><tessellate>1</tessellate><coordinates>${coordsTxt}</coordinates></LineString>
</Placemark>`;
  }

  function kmlForPoint(name, lon, lat, color='ff00FF00'){
    return `
<Placemark>
  <name>${name}</name>
  <Style>
    <IconStyle><color>${color}</color><scale>1.2</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon>
    </IconStyle>
  </Style>
  <Point><coordinates>${lon},${lat},0</coordinates></Point>
</Placemark>`;
  }

  async function exportKMZ(){
    try{
      const brig = ui.kmzBrigada.value.trim();
      if (!brig) return alert('Selecciona una brigada');
      const fromISO = ui.kmzDesde.value ? new Date(ui.kmzDesde.value).toISOString() : null;
      const toISO   = ui.kmzHasta.value ? new Date(ui.kmzHasta.value).toISOString() : null;

      ui.kmzBtn.disabled = true;
      ui.kmzBtn.textContent = 'Generando…';

      const raw = await fetchPointsFor(brig, fromISO, toISO);
      if (!raw.length) throw new Error('Sin puntos en el rango seleccionado');

      const pts = decimate(raw);
      const chunks = chunk(pts);

      const matchedCoords = [];
      for (const c of chunks){
        const geo = await mapMatchChunk(c);
        if (geo && geo.coordinates && geo.coordinates.length) {
          matchedCoords.push(...geo.coordinates);
        }
      }
      if (!matchedCoords.length) throw new Error('No se pudo limpiar el trazo con Map Matching');

      const start = matchedCoords[0], end = matchedCoords[matchedCoords.length-1];

      const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Recorrido ${brig}</name>
  ${kmlForLineString(`Recorrido ${brig}`, matchedCoords)}
  ${kmlForPoint('Inicio', start[0], start[1], 'ff00FF00')}
  ${kmlForPoint('Fin', end[0], end[1], 'ff0000FF')}
</Document>
</kml>`.trim();

      // empaquetar como KMZ
      const zip = new JSZip();
      zip.file('doc.kml', kml);
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      const nice = now.toISOString().replace(/[:T]/g,'-').slice(0,16);
      a.href = url;
      a.download = `recorrido_${brig}_${nice}.kmz`;
      a.click();
      URL.revokeObjectURL(url);
    } catch(e){
      console.error(e);
      alert('Error al generar KMZ: ' + e.message);
    } finally {
      ui.kmzBtn.disabled = false;
      ui.kmzBtn.textContent = 'Exportar KMZ (preciso)';
    }
  }

  // ========= Boot =========
  async function boot(){
    initMap();

    // eventos UI
    ui.aplicar.addEventListener('click', applyFilter);
    ui.brigada.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilter(); });
    ui.kmzBtn.addEventListener('click', exportKMZ);

    await fetchInitial(true);
    subscribeRealtime();
    await loadDistinctBrigadas();
  }

  // start
  boot();

})();
