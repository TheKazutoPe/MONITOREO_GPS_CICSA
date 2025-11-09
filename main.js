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
  trackingStart: null,
  trazoLayer: null,
};

// Inicializar trackingStart apenas carga el mapa
window.addEventListener("DOMContentLoaded", () => {
  state.trackingStart = new Date();
});

// Tu lógica original para inicializar el mapa, cargar capas base, íconos, eventos...

async function fetchInitial(triggerDraw = false){
  // Tu lógica original para traer ubicaciones y pintarlas...
  if (triggerDraw) dibujarRutaLimpiaReal();
}

ui.apply.addEventListener("click", () => fetchInitial(true));

// ================== TRAZADO LIMPIO EN TIEMPO REAL (desde trackingStart) ==================
async function dibujarRutaLimpiaReal(){
  if (!state.trackingStart) return;

  const brigadaActiva = (ui.brigada.value || "").trim();
  if (!brigadaActiva) return;

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp,acc,brigada")
    .eq("brigada", brigadaActiva)
    .gte("timestamp", state.trackingStart.toISOString())
    .order("timestamp", { ascending: true });

  if (error || !data?.length) {
    console.warn("Sin datos suficientes para trazar");
    return;
  }

  const puntos = data.map(r => ({
    lat: +r.latitud,
    lng: +r.longitud,
    timestamp: r.timestamp,
    acc: r.acc ?? 25
  })).filter(p => isFinite(p.lat) && isFinite(p.lng));

  if (puntos.length < 2) return;

  const limpios = cleanClosePoints(puntos, CLEAN_MIN_METERS);
  const segmentos = splitOnGaps(limpios, GAP_MINUTES, GAP_JUMP_METERS);

  for (const seg of segmentos){
    if (seg.length < 2) continue;

    const bloques = chunk(seg, MAX_MM_POINTS);
    let coordsTotales = [];

    for (let i = 0; i < bloques.length; i++) {
      const block = bloques[i];

      let finalBlock = densifySegment(block, DENSIFY_STEP);

      try {
        const mm = await mapMatchBlockSafe(block);
        if (mm?.length >= 2) finalBlock = mm;
      } catch (e) {
        console.warn("Matching falló en bloque", i, e);
      }

      if (!coordsTotales.length) {
        coordsTotales.push(...finalBlock);
      } else {
        const last = coordsTotales.at(-1);
        const first = finalBlock[0];
        if (distMeters(last, first) > 5) {
          const bridge = await smartBridge(last, first);
          if (bridge?.length) {
            coordsTotales.push(...bridge.slice(1));
          } else {
            coordsTotales.push(...finalBlock);
          }
        } else {
          coordsTotales.push(...finalBlock.slice(1));
        }
      }

      await sleep(PER_BLOCK_DELAY);
    }

    if (coordsTotales.length >= 2){
      const latlngs = coordsTotales.map(p => [p.lat, p.lng]);

      if (state.trazoLayer) state.map.removeLayer(state.trazoLayer);
      state.trazoLayer = L.polyline(latlngs, {
        color: "red",
        weight: 4,
        opacity: 0.85
      }).addTo(state.map);

      // Guardar trazado limpio en Supabase
      const geojsonLine = {
        type: "LineString",
        coordinates: coordsTotales.map(p => [p.lng, p.lat])
      };

      const bbox = [
        Math.min(...coordsTotales.map(p => p.lng)),
        Math.min(...coordsTotales.map(p => p.lat)),
        Math.max(...coordsTotales.map(p => p.lng)),
        Math.max(...coordsTotales.map(p => p.lat))
      ];

      const payload = {
        fecha: toYMD(new Date()),
        brigada: brigadaActiva,
        line_geojson: geojsonLine,
        puntos: coordsTotales.length,
        distancia_km: calcDistancia(coordsTotales),
        bbox: bbox
      };

      try {
        await supa.from("rutas_brigadas_dia").upsert(payload, {
          onConflict: "fecha,brigada"
        });
      } catch (err) {
        console.error("Error al guardar ruta:", err);
      }
    }
  }
}
