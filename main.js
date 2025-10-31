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

// ====== Mapbox básico (solo para puentes si hace falta) ======
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

// ====== Render lista lateral (CON LED) ======
function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  let el = document.getElementById(`u-${uid}`);

  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const cls = mins <= 2 ? "text-green" : (mins <= 5 ? "text-yellow" : "text-gray");
  const hora = new Date(row.timestamp).toLocaleTimeString();
  const brig = row.brigada || "-";

  const ledColor =
    mins <= 2 ? "#4ade80" :
    mins <= 5 ? "#eab308" :
    "#777";

  const content = `
    <div class="brigada-header">
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <div class="brigada-dot" style="background:${ledColor};"></div>
        <div class="brigada-info">
          <b>${row.tecnico || "Sin nombre"}</b>
          <div class="brigada-sub">${brig}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
  `;

  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = `brigada-item ${cls}`;
    el.innerHTML = content;
    el.onclick = () => {
      ui.brigada.value = brig;
      fetchInitial(true);
    };
    ui.userList.appendChild(el);
  } else {
    el.className = `brigada-item ${cls} marker-pulse`;
    el.innerHTML = content;
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }
}

// ============================================================================
// ====== Exportar KMZ por brigada y día (prioriza recorrido real) ============
// ============================================================================

// distancia rápida
function distMetersFast(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const x = dLon * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const y = dLat;
  return Math.sqrt(x * x + y * y) * R;
}

// simplificación ligera
function rdpSimplify(points, epsilonMeters = 15) {
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

// partir en tramos si hay huecos
function splitOnGaps(points, maxGapMin = 15, maxGapMeters = 900) {
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

// map-matching SOLO si el tramo es razonable
async function safeMapMatch(points) {
  if (!MAPBOX_TOKEN || !points || points.length < 2) return null;
  if (points.length > 100) return null; // no map-matching en tramos muy largos
  const coords = points.map(p => `${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&tidy=true&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const match = (j.matchings && j.matchings[0]) ? j.matchings[0] : null;
  const g = match ? match.geometry : null;
  if (!g || !g.coordinates) return null;
  return g.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

// ====== Exportar ======
async function exportKMZFromState() {
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ…", "gray");
    if (ui?.exportKmz) { prevDisabled = ui.exportKmz.disabled; ui.exportKmz.disabled = true; }

    const brig = (ui.brigada.value || "").trim();
    if (!brig) {
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value + "T00:00:00") : new Date();
    const start = new Date(chosen.getFullYear(), chosen.getMonth(), chosen.getDate());
    const end   = new Date(chosen.getFullYear(), chosen.getMonth(), chosen.getDate() + 1);

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("latitud,longitud,timestamp,tecnico,usuario_id")
      .eq("brigada", brig)
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString())
      .order("timestamp", { ascending: true });

    if (error) throw new Error("Error al leer Supabase");
    if (!data || data.length < 2) {
      alert(`⚠️ Sin datos para "${brig}" en ${start.toISOString().slice(0,10)}.`);
      return;
    }

    // agrupar por usuario_id
    const byUser = new Map();
    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push({
        lat: r.latitud,
        lng: r.longitud,
        timestamp: r.timestamp,
        tecnico: r.tecnico || `Tecnico ${uid}`
      });
    }

    let kml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>${brig} - ${start.toISOString().slice(0,10)}</name>`;

    let placemarks = 0;

    // por cada usuario (teléfono) de esa brigada
    for (const [uid, rows] of byUser.entries()) {
      if (rows.length < 2) continue;

      // si son pocos puntos → no tocamos nada
      if (rows.length <= 400) {
        const coords = rows.map(p => `${p.lng},${p.lat},0`).join(" ");
        const name = (rows[0].tecnico || `Tecnico ${uid}`).replace(/&/g, "&amp;");
        kml += `
          <Placemark>
            <name>${name} (${brig})</name>
            <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
            <LineString><coordinates>${coords}</coordinates></LineString>
          </Placemark>`;
        placemarks++;
        continue;
      }

      // si son muchos → partimos en tramos naturales
      const segments = splitOnGaps(rows, 15, 900);
      const name = (rows[0].tecnico || `Tecnico ${uid}`).replace(/&/g, "&amp;");

      for (const seg of segments) {
        if (seg.length < 2) continue;

        // intenta map-matching si el tramo es chiquito
        let finalSeg = null;
        if (seg.length <= 100) {
          const matched = await safeMapMatch(seg);
          if (matched && matched.length >= 2) {
            finalSeg = matched;
          }
        }

        // si no hubo match, usamos una simplificación MUY ligera
        if (!finalSeg) {
          finalSeg = seg.length > 600 ? rdpSimplify(seg, 15) : seg;
        }

        const coords = finalSeg.map(p => `${p.lng},${p.lat},0`).join(" ");
        kml += `
          <Placemark>
            <name>${name} (${brig})</name>
            <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
            <LineString><coordinates>${coords}</coordinates></LineString>
          </Placemark>`;
        placemarks++;
      }
    }

    kml += `</Document></kml>`;

    if (!placemarks) throw new Error("No se generó ninguna traza válida.");

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
