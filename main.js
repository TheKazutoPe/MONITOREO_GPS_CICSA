// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== Estado y UI ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  baseSel: document.getElementById("baseMapSel"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList")
};

const state = {
  map: null,
  cluster: null,
  markers: new Map(), // uid → { marker, lastRow }
  pathLayer: null
};

// ====== Helpers ======
function fmtAgo(ts) {
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "hace segundos";
  if (m === 1) return "hace 1 min";
  return `hace ${m} min`;
}
function brigadaColor(str) {
  const seed = [...str].reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = (seed * 47) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}
async function getSnapped(from, to) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}?geometries=geojson&access_token=${CONFIG.MAPBOX_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  const coords = json.routes?.[0]?.geometry?.coordinates || [];
  return coords.map(c => [c[1], c[0]]);
}
function animMarker(marker, from, to, steps = 30, dur = 400) {
  let i = 0;
  const latStep = (to.lat - from.lat) / steps;
  const lngStep = (to.lng - from.lng) / steps;
  const interval = setInterval(() => {
    i++;
    marker.setLatLng([from.lat + latStep * i, from.lng + lngStep * i]);
    if (i >= steps) clearInterval(interval);
  }, dur / steps);
}

// ====== MAPA ======
function initMap() {
  state.map = L.map("map", {
    center: [-12.0464, -77.0428],
    zoom: 12,
    zoomControl: true
  });
  const baseLayers = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 }),
    sat: L.tileLayer("https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=" + CONFIG.MAPBOX_TOKEN),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png")
  };
  baseLayers.osm.addTo(state.map);
  state.pathLayer = L.layerGroup().addTo(state.map);
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.map.addLayer(state.cluster);

  ui.baseSel.onchange = () => {
    state.map.eachLayer(l => state.map.removeLayer(l));
    baseLayers[ui.baseSel.value].addTo(state.map);
    state.map.addLayer(state.cluster);
  };
  ui.apply.onclick = () => updateVehicles();
  ui.exportKmz.onclick = () => exportKmz();
}
initMap();

// ====== VEHÍCULOS EN TIEMPO REAL ======
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
      iconAnchor: [21, 13]
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
      const marker = L.marker([last.latitud, last.longitud], { icon }).addTo(state.cluster);
      marker.bindPopup(popup);
      state.markers.set(uid, { marker, lastRow: last });
    } else {
      const prev = entry.lastRow;
      animMarker(entry.marker, { lat: prev.latitud, lng: prev.longitud }, { lat: last.latitud, lng: last.longitud });
      entry.marker.setPopupContent(popup);
      entry.lastRow = last;
    }
  }
}
setInterval(updateVehicles, 20000);
updateVehicles();

// ====== EXPORTAR KMZ ======
async function exportKmz() {
  try {
    ui.exportKmz.textContent = "Generando KMZ...";
    ui.exportKmz.disabled = true;
    if (typeof JSZip === "undefined") {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("No se pudo cargar JSZip."));
        document.head.appendChild(s);
      });
    }

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order("timestamp", { ascending: true });
    if (error) throw error;
    if (!data?.length) {
      alert("No hay datos para exportar hoy.");
      return;
    }

    const grouped = new Map();
    for (const r of data) {
      const u = String(r.usuario_id || r.tecnico || "sin-id");
      if (!grouped.has(u)) grouped.set(u, []);
      grouped.get(u).push(r);
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
    for (const [uid, rows] of grouped) {
      const last = rows.at(-1);
      const brig = last.brigada || `Brig-${uid}`;
      const color = brigadaColor(brig);
      const tmp = document.createElement("div");
      tmp.style.color = color;
      document.body.appendChild(tmp);
      const rgb = getComputedStyle(tmp).color.match(/\d+/g).map(Number);
      document.body.removeChild(tmp);
      const [rr, gg, bb] = rgb;
      const hex = `ff${bb.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${rr.toString(16).padStart(2, "0")}`;

      kml += `<Folder><name>${brig}</name>`;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        const from = { lat: a.latitud, lng: a.longitud };
        const to = { lat: b.latitud, lng: b.longitud };
        const coords = await getSnapped(from, to);
        kml += `<Placemark><Style><LineStyle><color>${hex}</color><width>4</width></LineStyle></Style>`;
        kml += `<LineString><coordinates>${coords.map(c => `${c[1]},${c[0]},0`).join(" ")}</coordinates></LineString></Placemark>`;
      }
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
  } catch (e) {
    console.error(e);
    alert("Error al generar KMZ. Revisa consola.");
    ui.exportKmz.textContent = "Exportar KMZ (día)";
    ui.exportKmz.disabled = false;
  }
}
