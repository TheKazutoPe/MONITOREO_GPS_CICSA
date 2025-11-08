// ============================== main.js ==============================
// 🚀 Versión modificada: traza rutas limpias en tiempo real Y las guarda en Supabase

const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  userList: document.getElementById("userList"),
};

const state = {
  map: null,
  cluster: null,
  users: new Map(),
  pointsByUser: new Map(),
  lastLines: new Map(),
  geojsonByUser: new Map()
};

const trackingStartTime = new Date();

const CLEAN_MIN_METERS = 6;
const DENSIFY_STEP = 10;
const MAX_MM_POINTS = 40;
const MAX_MATCH_INPUT = 90;
const CONFIDENCE_MIN = 0.7;
const MAX_DIST_RATIO = 0.35;
const ENDPOINT_TOL = 25;

function distMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function adaptiveRadius(p) {
  const acc = (p && p.acc != null) ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));
}

async function mapMatchBlockSafe(seg) {
  if (!MAPBOX_TOKEN || !seg || seg.length < 2 || seg.length > MAX_MM_POINTS) return null;

  const coords = seg.map(p => `${p.lng},${p.lat}`).join(";");
  const tsArr = seg.map(p => Math.floor(new Date(p.timestamp).getTime() / 1000)).join(";");
  const radArr = seg.map(p => adaptiveRadius(p)).join(";");

  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
    `?geometries=geojson&overview=full&tidy=true` +
    `&timestamps=${tsArr}&radiuses=${radArr}` +
    `&access_token=${MAPBOX_TOKEN}`;

  let res;
  try { res = await fetch(url); } catch { return null; }
  if (!res.ok) return null;

  const j = await res.json().catch(() => null);
  const m = j?.matchings?.[0];
  if (!m?.geometry?.coordinates || m.confidence < CONFIDENCE_MIN) return null;

  const rawDist = seg.slice(1).reduce((acc, p, i) => acc + distMeters(seg[i], p), 0);
  const matched = m.geometry.coordinates.map(([lng, lat], i) => ({ lat, lng, timestamp: seg[i]?.timestamp }));
  const mmDist = matched.slice(1).reduce((acc, p, i) => acc + distMeters(matched[i], p), 0);

  if (Math.abs(mmDist - rawDist) / Math.max(rawDist, 1) > MAX_DIST_RATIO) return null;
  if (distMeters(seg[0], matched[0]) > ENDPOINT_TOL || distMeters(seg.at(-1), matched.at(-1)) > ENDPOINT_TOL) return null;

  return matched;
}

function initMap() {
  const base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 });
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12, layers: [base] });
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.map.addLayer(state.cluster);
  ui.apply.onclick = fetchInitial;
}

function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  const el = document.getElementById(`u-${uid}`) || document.createElement("div");
  el.id = `u-${uid}`;
  el.className = "brigada-item text-green marker-pulse";
  el.innerHTML = `<div class='brigada-header'><div>${row.tecnico || "Sin nombre"} — ${row.brigada}</div></div>`;
  el.onclick = () => focusOnUser(uid);
  if (!el.parentNode) ui.userList.appendChild(el);
  setTimeout(() => el.classList.remove("marker-pulse"), 600);
}

function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u) return;
  state.map.setView([u.row.latitud, u.row.longitud], 17, { animate: true });
}

async function fetchInitial() {
  const { data, error } = await supa.from("ubicaciones_brigadas")
    .select("*").gte("timestamp", trackingStartTime.toISOString()).order("timestamp", { ascending: true });
  if (error || !data?.length) return;

  for (const r of data) await processNewRow(r);
}

async function saveRouteToSupabase(uid, brigada) {
  const coords = state.geojsonByUser.get(uid);
  if (!coords?.length) return;
  const geojson = {
    type: "LineString",
    coordinates: coords.map(p => [p.lng, p.lat])
  };
  const fecha = new Date().toISOString().slice(0, 10);
  await supa.from("rutas_brigadas_dia").upsert({
    fecha,
    brigada,
    line_geojson: geojson,
    puntos: coords.length
  }, { onConflict: ["fecha", "brigada"] });
}

async function processNewRow(row) {
  const uid = String(row.usuario_id || "0");
  if (!state.pointsByUser.has(uid)) state.pointsByUser.set(uid, []);
  const list = state.pointsByUser.get(uid);
  list.push({ lat: row.latitud, lng: row.longitud, timestamp: row.timestamp, acc: row.acc ?? null });

  if (list.length >= 2) {
    const seg = list.slice(-2);
    const mm = await mapMatchBlockSafe(seg);
    if (mm?.length >= 2) {
      if (state.lastLines.has(uid)) state.map.removeLayer(state.lastLines.get(uid));
      const poly = L.polyline(mm.map(p => [p.lat, p.lng]), { color: "#ff5500", weight: 4 });
      poly.addTo(state.map);
      state.lastLines.set(uid, poly);

      if (!state.geojsonByUser.has(uid)) state.geojsonByUser.set(uid, []);
      const coords = state.geojsonByUser.get(uid);
      coords.push(...mm.map(p => ({ lat: p.lat, lng: p.lng })));
      await saveRouteToSupabase(uid, row.brigada);
    }
  }

  const marker = L.marker([row.latitud, row.longitud]);
  state.cluster.addLayer(marker);
  state.users.set(uid, { row, marker });
  addOrUpdateUserInList(row);
}

initMap();
fetchInitial();

supa.channel('ubicaciones_brigadas-changes')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, async (payload) => {
    const r = payload.new;
    if (new Date(r.timestamp) > trackingStartTime) await processNewRow(r);
  })
  .subscribe();
