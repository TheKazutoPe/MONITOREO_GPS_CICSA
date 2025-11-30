// ============================== main.js ===============================
// Configuración base
// =====================================================================

const CONFIG = window.CONFIG || {};
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN || "";

const AUTO_REFRESH_MS = 15000; // 15 segundos
const MAX_POINTS_PER_USER = 200;
const DENSIFY_STEP = 60;       // metros para densificar
const MAX_MM_POINTS = 160;
const BRIDGE_MAX_METERS = 8000;
const DIRECTIONS_PROFILE = "driving";
const DIRECTIONS_HOP_METERS = 1800;
const PER_BLOCK_DELAY = 40;

// =====================================================================
// UI y estado
// =====================================================================

const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  timeRange: document.getElementById("timeRange"),
  statusFilter: document.getElementById("statusFilter"),
};

const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rows]
};

// =====================================================================
// Helpers
// =====================================================================

function minutesDiff(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

function getMinutesSince(row) {
  if (!row || !row.timestamp) return Infinity;
  const now = Date.now();
  const t = new Date(row.timestamp).getTime();
  return (now - t) / 60000;
}

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function getBearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lng - a.lng);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  let brng = toDeg(Math.atan2(y, x));
  if (brng < 0) brng += 360;
  return brng;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// densificar una ruta
function densifySegment(points, step = DENSIFY_STEP) {
  if (!points || points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = distMeters(a, b);
    if (!isFinite(d) || d <= 0) continue;

    const hops = Math.max(1, Math.round(d / step));
    for (let h = 0; h < hops; h++) {
      const t = h / hops;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        timestamp: a.timestamp,
        acc: a.acc ?? null,
        spd: a.spd ?? null,
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// =====================================================================
// Iconos / marcadores
// =====================================================================

const ICONS = {
  online: L.divIcon({
    className: "brig-marker brig-status-online",
    html: `
      <div class="brig-marker-outer">
        <div class="brig-marker-inner"></div>
      </div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  }),
  recent: L.divIcon({
    className: "brig-marker brig-status-recent",
    html: `
      <div class="brig-marker-outer">
        <div class="brig-marker-inner"></div>
      </div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  }),
  offline: L.divIcon({
    className: "brig-marker brig-status-offline",
    html: `
      <div class="brig-marker-outer">
        <div class="brig-marker-inner"></div>
      </div>
    `,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  }),
};

function getIconFor(row) {
  const mins = getMinutesSince(row);
  if (mins <= 5) return ICONS.online;
  if (mins <= 120) return ICONS.recent;
  return ICONS.offline;
}

// =====================================================================
// Filtros por estado
// =====================================================================

function statusMatches(row) {
  const mode = ui.statusFilter ? ui.statusFilter.value : "all";
  const mins = getMinutesSince(row);
  switch (mode) {
    case "active":
      return mins <= 5;
    case "recent":
      return mins <= 120;
    case "offline":
      return mins > 30;
    default:
      return true;
  }
}

// =====================================================================
// UI: status y stats
// =====================================================================

function setStatus(text, kind) {
  if (!ui.status) return;
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

function updateGlobalStats({ onlineNow, totalBrigadas, lastTs, hoursWindow }) {
  const statOnline = document.getElementById("statOnline");
  const statTotal = document.getElementById("statTotal");
  const statRange = document.getElementById("statRangeText");
  const statUpdated = document.getElementById("statUpdated");

  if (statOnline) statOnline.textContent = onlineNow ?? 0;
  if (statTotal) statTotal.textContent = totalBrigadas ?? 0;
  if (statRange) statRange.textContent = `Últimas ${hoursWindow} h`;

  if (statUpdated) {
    if (!lastTs) statUpdated.textContent = "--:--:--";
    else statUpdated.textContent = new Date(lastTs).toLocaleTimeString();
  }
}

// =====================================================================
// POPUP y lista lateral
// =====================================================================

function buildPopup(row) {
  const mins = getMinutesSince(row);
  let txt = "";
  if (!isFinite(mins)) txt = "Sin tiempo registrado";
  else if (mins < 1) txt = "Hace menos de 1 min";
  else txt = `Hace ${mins.toFixed(1)} min`;

  const lat = Number(row.latitud).toFixed(5);
  const lng = Number(row.longitud).toFixed(5);

  return `
    <div class="popup">
      <div><strong>${row.brigada || "-"}</strong></div>
      <div>${row.tecnico || row.usuario_id || ""}</div>
      <div>${lat}, ${lng}</div>
      <div>${txt}</div>
    </div>
  `;
}

function addOrUpdateUserInList(row) {
  if (!ui.userList) return;
  const brigada = row.brigada || "-";
  const hora = new Date(row.timestamp).toLocaleTimeString();
  const mins = getMinutesSince(row);

  let status = "offline";
  let ledColor = "#9ca3af";
  if (mins <= 5) {
    status = "online";
    ledColor = "#22c55e";
  } else if (mins <= 120) {
    status = "recent";
    ledColor = "#eab308";
  }

  const id = `brig-${brigada}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.className = "brigada-item";
    el.innerHTML = `
      <div class="brigada-header">
        <div style="display:flex;gap:6px;align-items:flex-start;">
          <div class="brigada-dot"></div>
          <div class="brigada-info">
            <div class="brigada-name">${brigada}</div>
            <div class="brigada-meta"></div>
          </div>
        </div>
        <div class="brigada-time"></div>
      </div>
    `;
    ui.userList.appendChild(el);
  }

  el.classList.remove("status-online", "status-recent", "status-offline");
  el.classList.add(`status-${status}`);

  const meta = el.querySelector(".brigada-meta");
  const timeEl = el.querySelector(".brigada-time");
  const dot = el.querySelector(".brigada-dot");

  if (meta) {
    meta.innerHTML = `${row.tecnico || row.usuario_id || ""}<br>${Number(
      row.latitud
    ).toFixed(5)}, ${Number(row.longitud).toFixed(5)}`;
  }
  if (timeEl) timeEl.textContent = hora;
  if (dot) dot.style.background = ledColor;

  el.onclick = () => {
    const uid = String(row.usuario_id || "0");
    const userState = state.users.get(uid);
    if (userState?.marker) {
      const latlng = userState.marker.getLatLng();
      state.map.setView(latlng, 16);
      userState.marker.openPopup();
    }
  };
}

// =====================================================================
// Animación de marcadores
// =====================================================================

function animateMarker(marker, fromRow, toRow) {
  if (!marker || !toRow) return;
  const startLatLng = marker.getLatLng();
  const endLatLng = L.latLng(toRow.latitud, toRow.longitud);

  const d = distMeters(
    { lat: startLatLng.lat, lng: startLatLng.lng },
    { lat: endLatLng.lat, lng: endLatLng.lng }
  );
  if (!isFinite(d) || d < 3 || d > 3000) {
    marker.setLatLng(endLatLng);
    return;
  }

  const duration = Math.min(4000, Math.max(800, (d / 10) * 100));
  const startTime = performance.now();
  const bearing = getBearing(
    { lat: startLatLng.lat, lng: startLatLng.lng },
    { lat: endLatLng.lat, lng: endLatLng.lng }
  );

  function frame(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const lat = startLatLng.lat + (endLatLng.lat - startLatLng.lat) * t;
    const lng = startLatLng.lng + (endLatLng.lng - startLatLng.lng) * t;
    marker.setLatLng([lat, lng]);

    if (marker._icon) {
      const el = marker._icon;
      el.style.transformOrigin = "center";
      let base = el.getAttribute("data-base-transform") || "";
      if (!base) {
        base = el.style.transform || "";
        el.setAttribute("data-base-transform", base);
      }
      el.style.transform = `${base} rotate(${bearing}deg)`;
    }

    if (t < 1) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

// =====================================================================
// Map Matching / Directions (stub mínimo para KMZ)
// =====================================================================

// NO usamos Map Matching online (ahorra errores y consumo):
async function mapMatchBlockSafe(seg) {
  return null;
}

async function directionsBetween(a, b) {
  if (!MAPBOX_TOKEN) return null;
  const direct = distMeters(a, b);
  if (direct > BRIDGE_MAX_METERS) return null;

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${DIRECTIONS_PROFILE}/` +
    `${a.lng},${a.lat};${b.lng},${b.lat}` +
    `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    console.warn("Directions fetch error:", e);
    return null;
  }
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const coords = j?.routes?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  return coords.map(([lng, lat]) => ({ lat, lng, timestamp: a.timestamp }));
}

async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > BRIDGE_MAX_METERS) return null;

  if (d <= DIRECTIONS_HOP_METERS) {
    return await directionsBetween(a, b);
  }

  const hops = Math.ceil(d / DIRECTIONS_HOP_METERS);
  const out = [a];
  let prev = a;

  for (let i = 1; i <= hops; i++) {
    const t = i / hops;
    const mid = {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      timestamp: a.timestamp,
    };
    const seg = await directionsBetween(prev, mid);
    if (!seg) return null;
    out.push(...seg.slice(1));
    prev = mid;
    await sleep(60);
  }

  const tail = await directionsBetween(prev, b);
  if (!tail) return null;
  out.push(...tail.slice(1));
  return out;
}

// =====================================================================
// Mapa
// =====================================================================

function initMap() {
  state.map = L.map("map", {
    center: [-12.0464, -77.0428],
    zoom: 13,
    zoomControl: true,
    attributionControl: false,
  });

  state.baseLayers = {
    Dark: L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
      {
        maxZoom: 22,
        tileSize: 256,
        zoomOffset: 0,
      }
    ),
    Satélite: L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
      {
        maxZoom: 22,
        tileSize: 256,
        zoomOffset: 0,
      }
    ),
  };

  state.baseLayers.Dark.addTo(state.map);

  L.control
    .layers(
      {
        Dark: state.baseLayers.Dark,
        Satélite: state.baseLayers.Satélite,
      },
      null,
      { position: "topright" }
    )
    .addTo(state.map);

  state.cluster = L.markerClusterGroup({
    disableClusteringAtZoom: 17,
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
  });
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
  if (ui.timeRange) ui.timeRange.onchange = () => fetchInitial(true);
  if (ui.statusFilter) ui.statusFilter.onchange = () => fetchInitial(true);
}

// =====================================================================
// Fetch principal
// =====================================================================

async function fetchInitial(clear) {
  setStatus("Cargando…", "gray");
  if (clear) ui.userList.innerHTML = "";

  const hours = ui.timeRange ? Number(ui.timeRange.value || 24) : 24;
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", sinceIso)
    .order("timestamp", { ascending: false });

  if (error) {
    console.error(error);
    setStatus("Error", "red");
    return;
  }

  if (!data || !data.length) {
    state.pointsByUser.clear();
    state.cluster.clearLayers();
    state.users.clear();
    updateGlobalStats({
      onlineNow: 0,
      totalBrigadas: 0,
      lastTs: null,
      hoursWindow: hours,
    });
    setStatus("Sin datos", "gray");
    return;
  }

  const prevUsers = new Map(state.users);

  // stats globales
  const idsSet = new Set();
  let onlineNow = 0;
  for (const r of data) {
    const uid = String(r.usuario_id || "0");
    idsSet.add(uid);
    if (getMinutesSince(r) <= 5) onlineNow++;
  }
  updateGlobalStats({
    onlineNow,
    totalBrigadas: idsSet.size,
    lastTs: data[0].timestamp,
    hoursWindow: hours,
  });

  // filtros
  const brigFilter = (ui.brigada.value || "").trim().toLowerCase();
  const grouped = new Map();
  const perUser = MAX_POINTS_PER_USER;

  for (const r of data) {
    if (brigFilter && !(r.brigada || "").toLowerCase().includes(brigFilter))
      continue;
    if (!statusMatches(r)) continue;

    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  state.cluster.clearLayers();
  state.pointsByUser.clear();
  const newUsers = new Map();

  grouped.forEach((rows, uid) => {
    rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const last = rows[rows.length - 1];
    if (
      !last ||
      !isFinite(last.latitud) ||
      !isFinite(last.longitud)
    )
      return;

    const prev = prevUsers.get(uid);
    let marker;

    if (prev && prev.marker) {
      marker = prev.marker;
      marker.setIcon(getIconFor(last));
      marker.setPopupContent(buildPopup(last));
      animateMarker(marker, prev.lastRow, last);
      state.cluster.addLayer(marker);
    } else {
      marker = L.marker([last.latitud, last.longitud], {
        icon: getIconFor(last),
      }).bindPopup(buildPopup(last));
      state.cluster.addLayer(marker);
    }

    newUsers.set(uid, { marker, lastRow: last });
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  });

  state.users = newUsers;

  if (clear && state.cluster.getLayers().length > 0) {
    state.map.fitBounds(state.cluster.getBounds(), {
      padding: [40, 40],
      maxZoom: 13,
    });
  }

  setStatus("Conectado", "green");
}

// =====================================================================
// Exportar KMZ
// =====================================================================

async function exportKMZFromState() {
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ…", "gray");
    if (ui?.exportKmz) {
      prevDisabled = ui.exportKmz.disabled;
      ui.exportKmz.disabled = true;
    }

    const brig = (prompt("Brigada EXACTA para exportar su KMZ:") || "").trim();
    if (!brig) {
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    const dateInput = prompt("Fecha (YYYY-MM-DD). ENTER = hoy:");
    const chosen = dateInput ? new Date(dateInput) : new Date();
    if (Number.isNaN(chosen.getTime())) {
      alert("Fecha no válida.");
      return;
    }

    const ymd = toYMD(chosen);
    const next = new Date(chosen.getTime() + 24 * 60 * 60 * 1000);
    const ymdNext = toYMD(next);

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select(
        "latitud,longitud,timestamp,tecnico,usuario_id,timestamp_pe,brigada,acc,spd"
      )
      .eq("brigada", brig)
      .gte("timestamp_pe", ymd)
      .lt("timestamp_pe", ymdNext)
      .order("timestamp_pe", { ascending: true });

    if (error) throw new Error(error.message);
    if (!data || data.length < 2) {
      alert(`⚠️ No hay datos para "${brig}" en ${ymd}.`);
      return;
    }

    const all = data
      .map((r) => ({
        lat: +r.latitud,
        lng: +r.longitud,
        timestamp: r.timestamp_pe || r.timestamp,
        acc: r.acc ?? null,
        spd: r.spd ?? null,
      }))
      .filter(
        (p) =>
          isFinite(p.lat) && isFinite(p.lng) && p.timestamp
      )
      .sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

    if (all.length < 2) {
      alert(`⚠️ Muy pocos puntos válidos para "${brig}" en ${ymd}.`);
      return;
    }

    const dense = densifySegment(all, DENSIFY_STEP);
    const blocks = chunk(dense, MAX_MM_POINTS);
    const renderedSegments = [];
    let current = [];

    for (const block of blocks) {
      let finalBlock = densifySegment(block, DENSIFY_STEP);
      try {
        const mm = await mapMatchBlockSafe(block);
        if (mm && mm.length >= 2) finalBlock = mm;
      } catch (_) {}

      if (!current.length) {
        current.push(...finalBlock);
      } else {
        const a = current[current.length - 1];
        const b = finalBlock[0];
        const d = distMeters(a, b);
        if (d > 50) {
          let appended = false;
          if (d <= BRIDGE_MAX_METERS) {
            const bridge = await smartBridge(a, b);
            if (bridge && bridge.length >= 2) {
              current.push(...bridge.slice(1));
              appended = true;
            }
          }
          if (!appended) {
            if (current.length > 1) renderedSegments.push(current);
            current = [...finalBlock];
            await sleep(PER_BLOCK_DELAY);
            continue;
          }
        }
        current.push(...finalBlock.slice(1));
      }

      await sleep(PER_BLOCK_DELAY);
    }

    if (current.length > 1) renderedSegments.push(current);

    if (!renderedSegments.length) {
      alert(
        `⚠️ No se pudieron construir tramos plausibles para "${brig}" en ${ymd}.`
      );
      return;
    }

    let kml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>${brig} - ${ymd}</name>` +
      `<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>`;

    for (const seg of renderedSegments) {
      const coordsStr = seg.map((p) => `${p.lng},${p.lat},0`).join(" ");
      kml += `
        <Placemark>
          <name>${brig} (${ymd})</name>
          <styleUrl>#routeStyle</styleUrl>
          <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
        </Placemark>`;
    }

    kml += `</Document></kml>`;

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 1 },
    });

    const ymdNice = ymd.replace(/-/g, "");
    const fileName = `RUTA_${brig}_${ymdNice}.kmz`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(
      `✅ KMZ listo: ${brig} (${ymd}) — ${renderedSegments.length} tramo(s) plausibles`
    );
  } catch (e) {
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado", "green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// =====================================================================
// Arranque
// =====================================================================

initMap();
setStatus("Cargando...", "gray");
fetchInitial(true);
setInterval(() => fetchInitial(false), AUTO_REFRESH_MS);
