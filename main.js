// main.js

// ================== CONFIGURACIONES GLOBALES ==================
const GAP_MINUTES = 5;           // minutos de salto de tiempo
const ROUTE_BRIDGE_M = 150;      // metros de salto de distancia
const MAX_POINTS_PER_USER = 100; // para carga inicial
const MAPBOX_DRIVING_PROFILE = "driving";

// 🔹 leer config global que viene de config.js
const CONFIG = window.CONFIG || {};
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN || "";

// ================== ESTADO GLOBAL ==================
const ui = {
  brigada: null,
  brigadaList: null,
  exportKmz: null,
  statusBar: null,
};

let map;
let markerCluster;
let markersByUser = new Map(); // usuario_id -> { marker, row }
let supa;

// ================== ARRANQUE ==================
window.addEventListener("DOMContentLoaded", async () => {
  // referenciar elementos
  ui.brigada = document.getElementById("brigadaFilter");
  ui.brigadaList = document.getElementById("brigadaList");
  ui.exportKmz = document.getElementById("exportKmz");
  ui.statusBar = document.getElementById("statusBar");

  initMap();
  initSupabase();
  bindUI();

  await fetchInitialData();
  await subscribeRealtime();

  setStatus("Conectado", "green");
});

// ================== SUPABASE ==================
function initSupabase() {
  const cfg = window.CONFIG || {};
  const url = cfg.SUPABASE_URL;
  const anon = cfg.SUPABASE_ANON_KEY;

  if (!window.supabase) {
    console.error("❌ No se cargó la librería de Supabase UMD.");
    return;
  }
  if (!url || !anon) {
    console.error("❌ Faltan SUPABASE_URL o SUPABASE_ANON_KEY en config.js");
    return;
  }

  supa = window.supabase.createClient(url, anon);
}

// ================== MAPA ==================
function initMap() {
  map = L.map("map").setView([-12.0464, -77.0428], 12);

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const sat = L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
    maxZoom: 20,
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
    attribution: "© Google",
  });

  L.control
    .layers(
      {
        "OpenStreetMap": osm,
        "Satélite": sat,
      },
      {},
      { position: "topleft" }
    )
    .addTo(map);

  markerCluster = L.markerClusterGroup({
    disableClusteringAtZoom: 16,
  });
  map.addLayer(markerCluster);
}

// ================== UI ==================
function bindUI() {
  const applyBtn = document.getElementById("applyFilters");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      renderListFromMarkers();
    });
  }

  if (ui.exportKmz) {
    ui.exportKmz.addEventListener("click", () => {
      exportKMZFromState();
    });
  }
}

// ================== CARGA INICIAL ==================
async function fetchInitialData() {
  try {
    setStatus("Cargando datos iniciales...", "gray");

    // hoy 00:00 → mañana 00:00
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    if (!supa) {
      console.warn("⚠️ Supabase no inicializado, no puedo hacer la carga inicial.");
      return;
    }

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString())
      .order("timestamp", { ascending: false });

    if (error) throw error;

    // agrupar por usuario
    const grouped = new Map();
    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (!grouped.has(uid)) grouped.set(uid, []);
      if (grouped.get(uid).length >= MAX_POINTS_PER_USER) continue;
      grouped.get(uid).push(r);
    }

    // dibujar último punto
    for (const [uid, rows] of grouped.entries()) {
      const latest = rows[0]; // ya están en descendente
      addOrUpdateMarker(latest);
    }

    renderListFromMarkers();
  } catch (err) {
    console.error("Error carga inicial:", err);
    setStatus("Error al cargar datos iniciales", "red");
  }
}

// ================== SUSCRIPCIÓN REALTIME ==================
async function subscribeRealtime() {
  if (!supa) return;

  supa
    .channel("ubicaciones_brigadas-changes")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "ubicaciones_brigadas",
      },
      (payload) => {
        const r = payload.new;
        addOrUpdateMarker(r);
        renderListFromMarkers();
      }
    )
    .subscribe();
}

// ================== MARCADORES ==================
function addOrUpdateMarker(row) {
  const uid = String(row.usuario_id || "0");
  const lat = parseFloat(row.latitud);
  const lng = parseFloat(row.longitud);
  if (isNaN(lat) || isNaN(lng)) return;

  const color = getColorFromTimestamp(row.timestamp);
  const icon = L.divIcon({
    className: "custom-marker",
    html: `<div class="dot" style="background:${color}"></div>`,
    iconSize: [16, 16],
  });
  const popupHtml = buildPopupHtml(row);

  const existing = markersByUser.get(uid);
  if (existing) {
    existing.marker.setLatLng([lat, lng]);
    existing.marker.setIcon(icon);
    existing.marker.setPopupContent(popupHtml);
    markersByUser.set(uid, { marker: existing.marker, row });
  } else {
    const marker = L.marker([lat, lng], { icon });
    marker.bindPopup(popupHtml);
    markerCluster.addLayer(marker);
    markersByUser.set(uid, { marker, row });
  }
}

function buildPopupHtml(r) {
  const fecha = new Date(r.timestamp).toLocaleString("es-PE", { hour12: false });
  return `
    <div>
      <b>${r.tecnico || r.usuario || "Sin nombre"}</b><br/>
      Brigada: ${r.brigada || "-"}<br/>
      Lat/Lon: ${r.latitud}, ${r.longitud}<br/>
      Vel: ${r.velocidad || 0} km/h<br/>
      ${r.accuracy ? `Precisión: ${r.accuracy} m<br/>` : ""}
      <small>${fecha}</small>
    </div>
  `;
}

function getColorFromTimestamp(ts) {
  const now = Date.now();
  const t = new Date(ts).getTime();
  const diffMin = (now - t) / 60000;
  if (diffMin <= 2) return "#30d158"; // verde
  if (diffMin <= 5) return "#ffd60a"; // amarillo
  return "#9e9e9e"; // gris
}

// ================== LISTA LATERAL ==================
function renderListFromMarkers() {
  if (!ui.brigadaList) return;

  const filter = (ui.brigada.value || "").toLowerCase();
  ui.brigadaList.innerHTML = "";

  const items = Array.from(markersByUser.values())
    .map((x) => x.row)
    .filter((r) => {
      if (!filter) return true;
      const b = (r.brigada || "").toLowerCase();
      const t = (r.tecnico || "").toLowerCase();
      return b.includes(filter) || t.includes(filter);
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  for (const r of items) {
    const el = document.createElement("div");
    el.className = "brigada-item";

    const fecha = new Date(r.timestamp).toLocaleTimeString("es-PE", {
      hour12: false,
    });

    el.innerHTML = `
      <div class="title">${r.tecnico || r.usuario || "Sin nombre"}</div>
      <div class="subtitle">${r.brigada || "-"}</div>
      <div class="time">${fecha}</div>
    `;

    // al hacer click: centro y lleno el filtro con esa brigada
    el.addEventListener("click", () => {
      ui.brigada.value = r.brigada || "";
      renderListFromMarkers();
      map.setView([r.latitud, r.longitud], 16);
    });

    ui.brigadaList.appendChild(el);
  }
}

// ================== EXPORTAR KMZ ==================
async function exportKMZFromState() {
  try {
    setStatus("Generando KMZ...", "gray");
    ui.exportKmz.disabled = true;

    const brig = (ui.brigada.value || "").trim();
    const dateInput = document.getElementById("kmzDate");

    let baseDate;
    if (dateInput && dateInput.value) {
      baseDate = new Date(dateInput.value + "T00:00:00");
    } else {
      const today = new Date();
      baseDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    }

    const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    const end = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1);

    if (!supa) {
      alert("❌ Supabase no está inicializado.");
      return;
    }

    // query a supabase con fecha y (opcional) brigada
    let query = supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString())
      .order("timestamp", { ascending: true });

    if (brig) {
      query = query.ilike("brigada", `%${brig}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error("Error en Supabase: " + error.message);

    if (!data || data.length === 0) {
      alert(
        "⚠️ No hay datos para ese día" + (brig ? ` y brigada "${brig}".` : ".")
      );
      return;
    }

    // agrupar por usuario
    const byUser = new Map();
    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(r);
    }

    const dayStr = start.toISOString().slice(0, 10);
    const docName = brig ? `Ruta ${brig} ${dayStr}` : `Rutas ${dayStr}`;
    let kml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${docName}</name>`;

    let totalProcessed = 0;

    for (const [uid, rows] of byUser.entries()) {
      if (rows.length < 2) continue;

      // ordenar por tiempo
      rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const name = (rows[0].tecnico || rows[0].brigada || `Brigada ${uid}`).replace(/&/g, "&amp;");

      let full = [];

      for (let i = 0; i < rows.length - 1; i++) {
        const a = {
          lat: rows[i].latitud,
          lng: rows[i].longitud,
          timestamp: rows[i].timestamp,
        };
        const b = {
          lat: rows[i + 1].latitud,
          lng: rows[i + 1].longitud,
          timestamp: rows[i + 1].timestamp,
        };

        const dt = (new Date(b.timestamp) - new Date(a.timestamp)) / 60000;
        const gap = distMeters(a, b);

        let seg = [a, b];

        // sólo ruteo cuando hay salto de tiempo/distancia
        if (dt > GAP_MINUTES || gap > ROUTE_BRIDGE_M) {
          seg = await routeBetween(a, b);
          if (dt > GAP_MINUTES || gap > ROUTE_BRIDGE_M) {
            await sleep(120);
          }
        } else if (gap > 40) {
          // aquí sí tiene sentido snapear
          seg = await snapSegmentToRoad(seg);
          await sleep(120);
        }

        full = await mergeOrBridgeCoords(full, seg);
      }

      if (full.length < 2) continue;

      const coords = full.map((s) => `${s.lng},${s.lat},0`).join(" ");
      kml += `<Placemark>
        <name>${name}</name>
        <Style>
          <LineStyle>
            <color>ff00a6ff</color>
            <width>4</width>
          </LineStyle>
        </Style>
        <LineString>
          <coordinates>${coords}</coordinates>
        </LineString>
      </Placemark>`;

      totalProcessed++;
    }

    kml += `</Document></kml>`;

    if (totalProcessed === 0) {
      alert("⚠️ No se generó ninguna ruta válida.");
      return;
    }

    // descargar KMZ
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);

    const safeBrig = brig ? brig.replace(/\s+/g, "_") : "todas";
    a.download = `kmz_${safeBrig}_${dayStr}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ generado (${totalProcessed} ruta(s)).`);
  } catch (err) {
    console.error("Error al exportar KMZ:", err);
    alert("❌ No se pudo generar el KMZ:\n" + err.message);
  } finally {
    setStatus("Conectado", "green");
    if (ui.exportKmz) ui.exportKmz.disabled = false;
  }
}

// ================== FUNCIONES MAPBOX ==================
async function routeBetween(a, b) {
  if (!MAPBOX_TOKEN) {
    console.warn("⚠️ No hay MAPBOX_TOKEN, uso puntos crudos.");
    return [a, b];
  }
  const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/${MAPBOX_DRIVING_PROFILE}/${coords}?geometries=geojson&access_token=${MAPBOX_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn("routeBetween falló, uso puntos crudos");
    return [a, b];
  }
  const json = await res.json();
  const line = json.routes?.[0]?.geometry?.coordinates || [];
  if (!line.length) return [a, b];
  return line.map((c) => ({ lng: c[0], lat: c[1] }));
}

async function snapSegmentToRoad(seg) {
  if (!MAPBOX_TOKEN) {
    console.warn("⚠️ No hay MAPBOX_TOKEN, no puedo snapear.");
    return seg;
  }
  if (!seg || seg.length < 2) return seg;
  const coords = seg.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&access_token=${MAPBOX_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn("snapSegmentToRoad falló, uso seg crudo");
    return seg;
  }
  const json = await res.json();
  const line = json.matchings?.[0]?.geometry?.coordinates || [];
  if (!line.length) return seg;
  return line.map((c) => ({ lng: c[0], lat: c[1] }));
}

async function mergeOrBridgeCoords(full, seg) {
  if (!full.length) return seg.slice();
  const last = full[full.length - 1];
  const out = full.slice();
  for (let i = 0; i < seg.length; i++) {
    const p = seg[i];
    if (i === 0) {
      const d = distMeters(last, p);
      if (d < 3) continue;
    }
    out.push(p);
  }
  return out;
}

// ================== UTILIDADES ==================
function distMeters(a, b) {
  const R = 6371e3;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;

  const sinΔφ = Math.sin(Δφ / 2);
  const sinΔλ = Math.sin(Δλ / 2);

  const c =
    sinΔφ * sinΔφ +
    Math.cos(φ1) * Math.cos(φ2) * sinΔλ * sinΔλ;
  const d = 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));

  return R * d;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function setStatus(msg, color = "gray") {
  if (!ui.statusBar) return;
  ui.statusBar.textContent = msg;
  ui.statusBar.style.background = color;
}
