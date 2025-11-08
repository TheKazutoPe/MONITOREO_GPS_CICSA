// ============================== main.js ==============================
// Usa CONFIG y supabase globales cargados en index.html
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),
  pointsByUser: new Map(),
  trackingStart: new Date().toISOString(),
  trazoLayer: null,
  trazoGeojson: null,
};

// ... tu código original intacto ...

ui.exportKmz.addEventListener("click", () => exportarKMZ());

async function dibujarRutaLimpiaReal(){
  const brig = (ui.brigada.value || "").trim();
  if (!brig) return;

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp,acc,spd")
    .eq("brigada", brig)
    .gte("timestamp", state.trackingStart)
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
        const last = current.at(-1);
        const first = finalBlock[0];
        const gapM = distMeters(last, first);
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

  const allCoords = fullMatched.flat().map(p => [p.lng, p.lat]);

  state.trazoGeojson = {
    type: "LineString",
    coordinates: allCoords
  };

  const lines = fullMatched.map(seg => L.polyline(
    seg.map(p => [p.lat, p.lng]),
    { color: "#0074cc", weight: 4, opacity: 0.8 }
  ));

  state.trazoLayer = L.layerGroup(lines).addTo(state.map);

  await guardarTrazoEnSupabase(brig, state.trazoGeojson);
}

async function guardarTrazoEnSupabase(brigada, geojson){
  if (!geojson?.coordinates?.length) return;
  const fecha = new Date().toISOString().substring(0,10);
  const coords = geojson.coordinates;
  const puntos = coords.length;

  const bbox = [
    Math.min(...coords.map(p => p[0])),
    Math.min(...coords.map(p => p[1])),
    Math.max(...coords.map(p => p[0])),
    Math.max(...coords.map(p => p[1])),
  ];

  let distancia = 0;
  for (let i = 1; i < coords.length; i++)
    distancia += distMetersLatLon(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);

  await supa.from("rutas_brigadas_dia").upsert({
    fecha,
    brigada,
    line_geojson: geojson,
    puntos,
    distancia_km: (distancia/1000).toFixed(2),
    bbox
  }, { onConflict: ["fecha", "brigada"] });
}

function exportarKMZ(){
  if (!state.trazoGeojson) return alert("No hay trazo disponible");
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n  <Placemark><LineString><coordinates>
    ${state.trazoGeojson.coordinates.map(c => `${c[0]},${c[1]},0`).join(" ")}
  </coordinates></LineString></Placemark>\n</Document>\n</kml>`;

  const zip = new JSZip();
  zip.file("doc.kml", kml);
  zip.generateAsync({type:"blob"}).then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trazo_brigada_${(ui.brigada.value||"ruta")}.kmz`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
// ====================================================================