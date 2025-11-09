// ============================== main.js ==============================
// Usa CONFIG y supabase globales cargados en index.html

const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  userList: document.getElementById("userList"),
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
};

// ====== Iconos ======
const ICONS = {
  green: L.icon({ iconUrl: "assets/carro-green.png",  iconSize: [40, 24], iconAnchor: [20, 12] }),
  yellow: L.icon({ iconUrl: "assets/carro-orange.png",iconSize: [40, 24], iconAnchor: [20, 12] }),
  gray:   L.icon({ iconUrl: "assets/carro-gray.png",  iconSize: [40, 24], iconAnchor: [20, 12] }),
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

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  const latlng = u.marker.getLatLng();
  state.map.setView(latlng, 17, { animate: true });
  u.marker.openPopup();
}

function buildPopup(r) {
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `
    <div>
      <b>${r.tecnico || "Sin nombre"}</b><br>
      Brigada: ${r.brigada || "-"}<br>
      Acc: ${isNaN(acc) ? "-" : acc + " m"} · Vel: ${spd} m/s<br>
      ${ts}
    </div>
  `;
}

// ====== Lista lateral (con pequeño efecto al actualizar) ======
function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  const brig = row.brigada || "-";
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const hora = new Date(row.timestamp).toLocaleTimeString();

  const ledColor = mins <= 2 ? "#4ade80" : mins <= 5 ? "#eab308" : "#777";
  const cls = mins <= 2 ? "text-green" : mins <= 5 ? "text-yellow" : "text-gray";

  const html = `
    <div class="brigada-header">
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <div class="brigada-dot" style="background:${ledColor};"></div>
        <div class="brigada-info">
          <b class="brig-name">${row.tecnico || "Sin nombre"}</b>
          <div class="brigada-sub">${brig}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
  `;

  let el = document.getElementById(`u-${uid}`);
  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = `brigada-item ${cls}`;
    el.innerHTML = html;
    el.onclick = () => {
      focusOnUser(uid);
      ui.brigada.value = brig;
    };
    ui.userList.appendChild(el);
  } else {
    el.className = `brigada-item ${cls} marker-pulse`;
    el.innerHTML = html;
    el.onclick = () => {
      focusOnUser(uid);
      ui.brigada.value = brig;
    };
    // quitar clase de animación luego de un rato
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }
}

// ====== Animación suave del marcador ======
function animateMarkerMove(marker, fromLatLng, toLatLng, duration = 900) {
  // si el movimiento es muy pequeño, solo actualiza sin animar
  const d = distMeters(
    { lat: fromLatLng.lat, lng: fromLatLng.lng },
    { lat: toLatLng.lat, lng: toLatLng.lng }
  );
  if (d < 2) {
    marker.setLatLng(toLatLng);
    return;
  }

  const start = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    // easing suave (easeInOutQuad)
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    const lat =
      fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * eased;
    const lng =
      fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * eased;

    marker.setLatLng([lat, lng]);

    if (t < 1) {
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}

// ====== Crear / actualizar marcador de brigada ======
function upsertBrigadaMarker(row) {
  const uid = String(row.usuario_id || "0");
  const lat = Number(row.latitud);
  const lng = Number(row.longitud);
  if (!isFinite(lat) || !isFinite(lng)) return;

  const brig = row.brigada || "-";

  let entry = state.users.get(uid);

  if (!entry) {
    // Crear nuevo marcador
    const marker = L.marker([lat, lng], {
      icon: getIconFor(row),
    }).bindPopup(buildPopup(row));

    state.cluster.addLayer(marker);

    entry = {
      marker,
      lastRow: row,
    };
    state.users.set(uid, entry);
  } else {
    // Actualizar marcador existente con animación
    const marker = entry.marker;
    const from = marker.getLatLng();
    const to = L.latLng(lat, lng);

    marker.setIcon(getIconFor(row));
    marker.setPopupContent(buildPopup(row));

    animateMarkerMove(marker, from, to, 900);

    entry.lastRow = row;
  }

  addOrUpdateUserInList(row);
}

// ====== Carga inicial (últimas 24h, 1 punto por usuario) ======
async function fetchInitial(clearList) {
  try {
    setStatus("Cargando ubicaciones…", "gray");
    if (clearList) ui.userList.innerHTML = "";
    state.cluster.clearLayers();
    state.users.clear();

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", since)
      .order("timestamp", { ascending: false });

    if (error) {
      console.error(error);
      setStatus("Error al cargar", "gray");
      return;
    }

    const brigFilter = (ui.brigada.value || "").trim().toLowerCase();
    const seen = new Set();

    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (seen.has(uid)) continue;

      if (
        brigFilter &&
        !(r.brigada || "").toLowerCase().includes(brigFilter)
      ) {
        continue;
      }

      seen.add(uid);
      upsertBrigadaMarker(r);
    }

    setStatus("Conectado", "green");
  } catch (e) {
    console.error(e);
    setStatus("Error inesperado", "gray");
  }
}

// ====== Realtime: animar movimiento en vivo ======
function setupRealtime() {
  const channel = supa
    .channel("ubicaciones_brigadas_stream")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "ubicaciones_brigadas",
      },
      (payload) => {
        const row = payload.new;
        const brigFilter = (ui.brigada.value || "").trim().toLowerCase();

        // aplica filtro de brigada si está escrito
        if (
          brigFilter &&
          !(row.brigada || "").toLowerCase().includes(brigFilter)
        ) {
          return;
        }

        upsertBrigadaMarker(row);
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setStatus("Conectado (Tiempo real)", "green");
      }
      if (status === "CHANNEL_ERROR") {
        console.warn("Error en canal realtime");
        setStatus("Realtime error", "yellow");
      }
      if (status === "CLOSED") {
        console.warn("Canal realtime cerrado");
        setStatus("Conexión cerrada", "gray");
      }
    });
}

// ====== Inicializar mapa ======
function initMap() {
  state.baseLayers.osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 20 }
  );

  state.map = L.map("map", {
    center: [-12.0464, -77.0428],
    zoom: 12,
    layers: [state.baseLayers.osm],
  });

  state.cluster = L.markerClusterGroup({
    disableClusteringAtZoom: 16,
  });

  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
}

initMap();
setStatus("Cargando...", "gray");
fetchInitial(true);
setupRealtime();
