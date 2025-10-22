// ========================= Supabase =========================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ========================= Estado global =========================
const ui = {
  baseSel: document.getElementById("baseMapSel"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

const state = {
  map: null,
  markers: new Map(),
  routeCache: new Map(),
};

// ========================= Utilidades =========================
function fmtAgo(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if (m < 1) return "hace segundos";
  if (m === 1) return "hace 1 min";
  return `hace ${m} min`;
}
function brigadaColor(str) {
  const seed = [...str].reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = (seed * 47) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}
function animMarker(marker, from, to, steps = 30, dur = 600) {
  let i = 0;
  const latStep = (to.lat - from.lat) / steps;
  const lngStep = (to.lng - from.lng) / steps;
  const interval = setInterval(() => {
    i++;
    marker.setLatLng([from.lat + latStep * i, from.lng + lngStep * i]);
    if (i >= steps) clearInterval(interval);
  }, dur / steps);
}
async function getSnapped(from, to) {
  const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  if (state.routeCache.has(key)) return state.routeCache.get(key);
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}?geometries=geojson&access_token=${CONFIG.MAPBOX_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  const coords = json.routes?.[0]?.geometry?.coordinates?.map(c => [c[1], c[0]]) || [[from.lat, from.lng], [to.lat, to.lng]];
  state.routeCache.set(key, coords);
  return coords;
}

// ========================= MAPA =========================
function initMap() {
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12 });
  const layers = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }),
    sat: L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${CONFIG.MAPBOX_TOKEN}`),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"),
  };
  layers.osm.addTo(state.map);
  ui.baseSel.onchange = () => {
    Object.values(layers).forEach(l => state.map.removeLayer(l));
    layers[ui.baseSel.value].addTo(state.map);
  };
  ui.apply.onclick = () => updateVehicles();
  ui.exportKmz.onclick = () => exportKmz();
}
initMap();

// ========================= VEHÍCULOS =========================
async function updateVehicles() {
  const { data } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: true });

  if (!data?.length) return;

  const grouped = new Map();
  for (const r of data) {
    const u = String(r.usuario_id || r.tecnico);
    if (!grouped.has(u)) grouped.set(u, []);
    grouped.get(u).push(r);
  }

  ui.userList.innerHTML = "";
  for (const [uid, rows] of grouped) {
    const last = rows.at(-1);
    const brig = last.brigada || `Brig-${uid}`;
    const color = brigadaColor(brig);
    const icon = L.icon({
      iconUrl: "assets/carro-animado.png",
      iconSize: [42, 26],
      iconAnchor: [21, 13],
    });

    let entry = state.markers.get(uid);
    const popup = `
      <b>🚘 Brigada:</b> ${brig}<br>
      <b>Técnico:</b> ${last.tecnico || "—"}<br>
      <b>Contrata:</b> ${last.contrata || "—"}<br>
      <b>Zona:</b> ${last.zona || "—"}<br>
      <b>Última actualización:</b> ${fmtAgo(last.timestamp)}
    `;

    if (!entry) {
      const marker = L.marker([last.latitud, last.longitud], { icon }).addTo(state.map);
      marker.bindPopup(popup);
      marker.on("click", () => {
        marker.openPopup();
        state.map.setView([last.latitud, last.longitud], 15);
      });
      state.markers.set(uid, { marker, lastRow: last });
    } else {
      const prev = entry.lastRow;
      animMarker(entry.marker, { lat: prev.latitud, lng: prev.longitud }, { lat: last.latitud, lng: last.longitud });
      entry.marker.setPopupContent(popup);
      entry.lastRow = last;
    }

    const li = document.createElement("li");
    li.innerHTML = `<span style="color:${color}">●</span> ${last.tecnico || uid} — ${brig}`;
    li.onclick = () => state.map.setView([last.latitud, last.longitud], 15);
    ui.userList.appendChild(li);
  }
}
setInterval(updateVehicles, 20000);
updateVehicles();

// ========================= EXPORTAR KMZ =========================
async function exportKmz() {
  try {
    ui.exportKmz.textContent = "Generando KMZ...";
    ui.exportKmz.disabled = true;

    const { data } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order("timestamp", { ascending: true });
    if (!data?.length) {
      alert("No hay datos para exportar hoy.");
      ui.exportKmz.textContent = "Exportar KMZ (día)";
      ui.exportKmz.disabled = false;
      return;
    }

    const grouped = new Map();
    for (const r of data) {
      const key = String(r.usuario_id || r.tecnico || "sin-id");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>`;
    for (const [uid, rows] of grouped) {
      const brig = rows.at(-1).brigada || `Brig-${uid}`;
      const tecnico = rows.at(-1).tecnico || "—";
      const contrata = rows.at(-1).contrata || "—";
      const zona = rows.at(-1).zona || "—";

      const color = brigadaColor(brig);
      const tmp = document.createElement("div");
      tmp.style.color = color;
      document.body.appendChild(tmp);
      const rgb = getComputedStyle(tmp).color.match(/\d+/g).map(Number);
      document.body.removeChild(tmp);
      const [r, g, b] = rgb;
      const hex = `ff${b.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${r.toString(16).padStart(2, "0")}`;

      kml += `<Folder><name>${brig} - ${tecnico}</name>`;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        const from = { lat: a.latitud, lng: a.longitud };
        const to = { lat: b.latitud, lng: b.longitud };
        const gap = (new Date(b.timestamp) - new Date(a.timestamp)) / 60000;
        const dash = gap > 5;
        const coords = await getSnapped(from, to);

        kml += `<Placemark><Style><LineStyle><color>${dash ? "7d" + hex.slice(2) : hex}</color><width>${dash ? 3 : 4}</width></LineStyle></Style>`;
        kml += `<LineString><coordinates>${coords.map(c => `${c[1]},${c[0]},0`).join(" ")}</coordinates></LineString></Placemark>`;
      }

      const lastP = rows.at(-1);
      kml += `<Placemark><name>Fin</name><Point><coordinates>${lastP.longitud},${lastP.latitud},0</coordinates></Point></Placemark>`;
      kml += `</Folder>`;
    }
    kml += `</Document></kml>`;

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Monitoreo_CICSA_${new Date().toISOString().slice(0, 10)}.kmz`;
    a.click();
    a.remove();

    ui.exportKmz.textContent = "Exportar KMZ (día)";
    ui.exportKmz.disabled = false;
    alert("✅ KMZ generado correctamente.");
  } catch (e) {
    console.error(e);
    alert("❌ Error al generar KMZ. Revisa consola.");
    ui.exportKmz.textContent = "Exportar KMZ (día)";
    ui.exportKmz.disabled = false;
  }
}
