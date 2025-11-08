// ============================== main.js ==============================
// Usa CONFIG y supabase globales cargados en index.html
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== UI refs (mismos IDs que tu HTML) ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ====== Estado del mapa/lista ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rows]
  trackingStart: new Date().toISOString() // desde este punto se graficará matching
};

// (...)
// AQUÍ VA TODO TU CÓDIGO IGUAL — sin modificar absolutamente nada,
// desde líneas como:
//  - const CLEAN_MIN_METERS = 6;
//  - const ICONS = { green, yellow, gray }
//  - distMeters, sleep, toYMD, chunk, densifySegment...
//  - mapMatchBlockSafe, smartBridge, directionsBetween
//  - initMap(), buildPopup(), etc...

// Solo modifica esta función clave ↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓
async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear) ui.userList.innerHTML = "";

  const {data, error} = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", state.trackingStart) // <=== SOLO puntos nuevos desde el arranque
    .order("timestamp",{ascending:false});

  if (error){ setStatus("Error","gray"); return; }

  const brigFilter = (ui.brigada.value||"").trim().toLowerCase();
  const grouped = new Map();
  const perUser = 100;

  for (const r of data){
    if (brigFilter && !(r.brigada||"").toLowerCase().includes(brigFilter)) continue;
    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  state.pointsByUser.clear();
  state.cluster.clearLayers();
  state.users.clear();

  grouped.forEach((rows, uid)=>{
    const last = rows[0];
    const marker = L.marker([last.latitud,last.longitud],{icon:getIconFor(last)}).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid,{marker,lastRow:last});
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  });

  setStatus("Conectado","green");

  // 🔁 Después de cargar los puntos → trazado limpio solo desde este punto en adelante
  dibujarRutaLimpiaReal();
}

// ====== Dibuja trazo limpio (real-time, solo puntos recientes) ======
async function dibujarRutaLimpiaReal(){
  const brig = (ui.brigada.value || "").trim();
  if (!brig) return;

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp,acc,spd")
    .eq("brigada", brig)
    .gte("timestamp", state.trackingStart) // ← clave: SOLO desde ahora
    .order("timestamp", { ascending: true });

  if (error || !data || data.length < 2) return;

  const raw = data.map(p => ({
    lat: p.latitud, lng: p.longitud,
    timestamp: p.timestamp,
    acc: p.acc ?? null, spd: p.spd ?? null
  }));

  const cleaned = [raw[0], ...cleanClosePoints(raw.slice(1), CLEAN_MIN_METERS)];
  const segs = splitOnGaps(cleaned, GAP_MINUTES, GAP_JUMP_METERS);

  const fullMatched = [];

  for (const seg of segs){
    if (seg.length < 2) continue;

    const blocks = chunk(seg, MAX_MM_POINTS);
    let current = [];

    for (let i = 0; i < blocks.length; i++){
      const block = blocks[i];
      let finalBlock = densifySegment(block, DENSIFY_STEP);

      try {
        const mm = await mapMatchBlockSafe(block);
        if (mm && mm.length >= 2) finalBlock = mm;
      } catch(_) {}

      if (!current.length){
        current.push(...finalBlock);
      } else {
        const last  = current.at(-1);
        const first = finalBlock[0];
        const gapM  = distMeters(last, first);
        let appended = false;

        if (gapM <= BRIDGE_MAX_METERS){
          const bridge = await smartBridge(last, first);
          if (bridge?.length){
            current.push(...bridge.slice(1));
            appended = true;
          }
        }

        if (!appended){
          if (current.length > 1) fullMatched.push(current);
          current = [...finalBlock];
          continue;
        }
        current.push(...finalBlock.slice(1));
      }

      await sleep(PER_BLOCK_DELAY);
    }

    if (current.length > 1) fullMatched.push(current);
  }

  if (!fullMatched.length) return;

  if (state.trazoLayer){
    state.map.removeLayer(state.trazoLayer);
    state.trazoLayer = null;
  }

  const lines = fullMatched.map(seg => L.polyline(
    seg.map(p => [p.lat, p.lng]),
    { color: "#0074cc", weight: 4, opacity: 0.8 }
  ));

  state.trazoLayer = L.layerGroup(lines).addTo(state.map);
}
