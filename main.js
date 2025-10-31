// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),
  pointsByUser: new Map(),
};

// ====== Config ======
const ROUTE_BRIDGE_M = 250;
const GAP_MINUTES = 5;
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== Íconos ======
const ICONS = {
  green: L.icon({ iconUrl: "assets/carro-green.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  yellow: L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  gray:   L.icon({ iconUrl: "assets/carro-gray.png",   iconSize: [40, 24], iconAnchor: [20, 12] }),
};
function getIconFor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return ICONS.green;
  if (mins <= 5) return ICONS.yellow;
  return ICONS.gray;
}

// ====== Helpers ======
function distMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) *
    Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ====== Animación ======
function animateMarker(marker, from, to) {
  if (!from || !to) { marker.setLatLng(to || from); return; }
  const d = distMeters(from, to);
  const dur = clamp((d / 40) * 1000, 300, 4000);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / dur, 1);
    const lat = from.lat + (to.lat - from.lat) * t;
    const lng = from.lng + (to.lng - from.lng) * t;
    marker.setLatLng([lat, lng]);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ====== Mapbox (para vista y puentes finos) ======
async function routeBetween(a, b) {
  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
    const r = await fetch(url, { mode: "cors", cache: "no-cache" });
    if (!r.ok) throw new Error(`Mapbox error: ${r.status}`);
    const j = await r.json();
    const coords = j.routes?.[0]?.geometry?.coordinates || [];
    return coords.map(([lng, lat]) => ({ lat, lng }));
  } catch (err) {
    console.warn("routeBetween error:", err);
    return [a, b];
  }
}
async function snapSegmentToRoad(seg) {
  if (seg.length < 2) return seg;
  const coords = seg.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&tidy=true&radiuses=${seg.map(() => 40).join(";")}&access_token=${MAPBOX_TOKEN}`;
  try {
    const r = await fetch(url, { mode: "cors", cache: "no-cache" });
    if (!r.ok) throw new Error(`Mapbox error: ${r.status}`);
    const j = await r.json();
    const c = j.matchings?.[0]?.geometry?.coordinates || [];
    return c.map(([lng, lat]) => ({ lat, lng }));
  } catch (err) {
    console.warn("snapSegmentToRoad error:", err);
    return seg;
  }
}
async function mergeOrBridgeCoords(a, b) {
  if (!a.length) return b;
  const last = a[a.length - 1], first = b[0];
  const gap = distMeters(last, first);
  if (gap > ROUTE_BRIDGE_M) {
    const bridge = await routeBetween(last, first);
    return [...a, ...bridge, ...b];
  }
  return [...a, ...b];
}

// ====== Inicializar mapa ======
function initMap() {
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 });
  state.baseLayers.sat = L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", { subdomains: ["mt0","mt1","mt2","mt3"] });
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12, layers: [state.baseLayers.osm] });
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== Popup y status ======
function buildPopup(r) {
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}
function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

// ====== Cargar datos iniciales (lista y marcadores) ======
async function fetchInitial(clear) {
  setStatus("Cargando…", "gray");
  if (clear) ui.userList.innerHTML = "";
  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) { setStatus("Error", "gray"); return; }

  const brig = (ui.brigada.value || "").trim();
  const perUser = 100;
  const grouped = new Map();

  for (const r of data) {
    if (brig && (r.brigada || "").toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  state.pointsByUser.clear();
  state.cluster.clearLayers();
  state.users.clear();

  grouped.forEach((rows, uid) => {
    const last = rows[0];
    const marker = L.marker([last.latitud, last.longitud], { icon: getIconFor(last) }).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: last });
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  });
  setStatus("Conectado", "green");
}

// ====== Render lista lateral ======
function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  let el = document.getElementById(`u-${uid}`);
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const cls = mins <= 2 ? "text-green" : (mins <= 5 ? "text-yellow" : "text-gray");
  const hora = new Date(row.timestamp).toLocaleTimeString();

  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = `brigada-item ${cls}`;
    el.innerHTML = `
      <div class="brigada-header">
        <div class="brigada-info">
          <b>${row.tecnico || "Sin nombre"}</b>
          <div class="brigada-sub">${row.brigada || "-"}</div>
        </div>
        <div class="brigada-hora">${hora}</div>
      </div>
    `;
    el.onclick = () => {
      // Al hacer clic, autocompleta el filtro (sin cambiar nada más)
      ui.brigada.value = row.brigada || "";
      fetchInitial(true);
    };
    ui.userList.appendChild(el);
  } else {
    el.className = `brigada-item ${cls} marker-pulse`;
    el.querySelector(".brigada-sub").textContent = row.brigada || "-";
    el.querySelector(".brigada-hora").textContent = hora;
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }
}

// ============================================================================
// ====== Optimizaciones para exportar KMZ por brigada y día (rápido) ========
// ============================================================================

// Distancia rápida (aprox) en metros
function distMetersFast(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const x = dLon * Math.cos((lat1 + lat2) / 2);
  const y = dLat;
  return Math.sqrt(x * x + y * y) * R;
}

// Douglas-Peucker (epsilon en metros)
function rdpSimplify(points, epsilonMeters = 22) {
  if (!points || points.length <= 2) return points || [];
  function perpDist(p, a, b) {
    const ax = 0, ay = 0;
    const bx = distMetersFast(a, { lat: a.lat, lng: b.lng }) * Math.sign(b.lng - a.lng);
    const by = distMetersFast(a, { lat: b.lat, lng: a.lng }) * Math.sign(b.lat - a.lat);
    const px = distMetersFast(a, { lat: a.lat, lng: p.lng }) * Math.sign(p.lng - a.lng);
    const py = distMetersFast(a, { lat: p.lat, lng: a.lng }) * Math.sign(p.lat - a.lat);
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const c1 = vx * wx + vy * wy;
    const c2 = vx * vx + vy * vy;
    let t = c2 ? c1 / c2 : 0; t = Math.max(0, Math.min(1, t));
    const projx = ax + t * vx, projy = ay + t * vy;
    const dx = px - projx, dy = py - projy;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function rec(pts, s, e, keep) {
    if (e <= s + 1) return;
    let md = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > md) { md = d; idx = i; }
    }
    if (md > epsilonMeters && idx !== -1) {
      keep.add(idx);
      rec(pts, s, idx, keep);
      rec(pts, idx, e, keep);
    }
  }
  const keep = new Set([0, points.length - 1]);
  rec(points, 0, points.length - 1, keep);
  return points.filter((_, i) => keep.has(i));
}

function chunkByPoints(arr, maxPts = 100) {
  const res = [];
  for (let i = 0; i < arr.length; i += maxPts) res.push(arr.slice(i, i + maxPts));
  return res;
}

function splitOnGaps(points, maxGapMin = 12, maxGapMeters = 800) {
  const groups = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (cur.length === 0) { cur.push(p); continue; }
    const prev = cur[cur.length - 1];
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp)) / 60000;
    const dm = distMetersFast(prev, p);
    if (dtMin > maxGapMin || dm > maxGapMeters) {
      if (cur.length > 1) groups.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length > 1) groups.push(cur);
  return groups;
}

async function mapMatchChunk(chunk) {
  const coords = chunk.map(p => `${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&tidy=true&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Mapbox map-matching error");
  const j = await r.json();
  const match = (j.matchings && j.matchings[0]) ? j.matchings[0] : null;
  const g = match ? match.geometry : null;
  if (!g || !g.coordinates) throw new Error("Sin geometría en match");
  return g.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

// Concurrencia controlada
async function runWithConcurrency(tasks, limit = 3) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await tasks[idx](); }
      catch (e) { results[idx] = e; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ====== Exportar KMZ por brigada + día (rápido) ======
async function exportKMZFromState() {
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ (rápido)…", "gray");
    if (ui?.exportKmz) { prevDisabled = ui.exportKmz.disabled; ui.exportKmz.disabled = true; }

    // 1) Brigada requerida
    const brig = (ui.brigada.value || "").trim();
    if (!brig) { alert("Escribe el nombre EXACTO de la brigada para exportar su KMZ."); return; }

    // 2) Fecha (hoy por defecto)
    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value + "T00:00:00") : new Date();
    const start = new Date(chosen.getFullYear(), chosen.getMonth(), chosen.getDate());
    const end   = new Date(chosen.getFullYear(), chosen.getMonth(), chosen.getDate() + 1);

    // 3) Consulta ligera: solo columnas necesarias
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("latitud,longitud,timestamp,tecnico,usuario_id,brigada")
      .eq("brigada", brig)
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString())
      .order("timestamp", { ascending: true });

    if (error) throw new Error("Error al leer Supabase");
    if (!data || data.length < 2) {
      alert(`⚠️ Sin datos suficientes para "${brig}" en ${start.toISOString().slice(0,10)}.`);
      return;
    }

    // 4) Agrupar por usuario_id (si hay más de un equipo con la misma brigada)
    const groupsByUser = new Map();
    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (!groupsByUser.has(uid)) groupsByUser.set(uid, []);
      groupsByUser.get(uid).push({
        lat: r.latitud, lng: r.longitud, timestamp: r.timestamp,
        tecnico: r.tecnico || `Tecnico ${uid}`
      });
    }

    // 5) Construir KML
    let kml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>${brig} - ${start.toISOString().slice(0,10)}</name>`;
    let placemarks = 0;

    for (const [uid, rows] of groupsByUser.entries()) {
      if (rows.length < 2) continue;
      const segments = splitOnGaps(rows, 12, 800);
      if (!segments.length) continue;

      const tecnicoName = (rows[0].tecnico || `Tecnico ${uid}`).replace(/&/g, "&amp;");

      for (const seg of segments) {
        const simplified = rdpSimplify(seg, 22);
        if (simplified.length < 2) continue;

        const chunks = chunkByPoints(simplified, 100);
        const tasks = chunks.map(chunk => async () => {
          try { return await mapMatchChunk(chunk); }
          catch { return chunk.map(p => ({ lat: p.lat, lng: p.lng })); }
        });
        const results = await runWithConcurrency(tasks, 3);

        const matched = [];
        for (const r of results) {
          if (r instanceof Error) continue;
          if (matched.length && r.length) {
            const last = matched[matched.length - 1];
            const first = r[0];
            if (distMetersFast(last, first) < 2) matched.push(...r.slice(1));
            else matched.push(...r);
          } else {
            matched.push(...r);
          }
        }
        if (matched.length < 2) continue;

        const coords = matched.map(p => `${p.lng},${p.lat},0`).join(" ");
        kml += `
          <Placemark>
            <name>${tecnicoName} (${brig})</name>
            <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
            <LineString><coordinates>${coords}</coordinates></LineString>
          </Placemark>`;
        placemarks++;
      }
    }

    kml += `</Document></kml>`;
    if (!placemarks) throw new Error("No se generó ninguna traza válida.");

    // 6) Empaquetar KMZ con compresión baja (más rápido)
    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 1 }
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recorrido_${safeBrig}_${start.toISOString().slice(0,10)}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ listo para "${brig}" (${placemarks} tramo(s))`);
  } catch (e) {
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado", "green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ====== Arranque ======
setStatus("Cargando...", "gray");
fetchInitial(true);
