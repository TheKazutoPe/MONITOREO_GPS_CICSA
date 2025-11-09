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

// ====== Estado global ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  subscription: null,
};

// ====== Iconos carros ======
const ICONS = {
  green: L.icon({
    iconUrl: "assets/carro-green.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12],
  }),
  yellow: L.icon({
    iconUrl: "assets/carro-orange.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12],
  }),
  gray: L.icon({
    iconUrl: "assets/carro-gray.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12],
  }),
};

function getIconFor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return ICONS.green;
  if (mins <= 5) return ICONS.yellow;
  return ICONS.gray;
}

// ====== Helpers ======
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
      Acc: ${isNaN(acc) ? "-" : acc + " m"} · Vel: ${isNaN(spd) ? "-" : spd + " m/s"}<br>
      ${ts}
    </div>
  `;
}

function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  let el = document.getElementById(`u-${uid}`);

  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const brig = row.brigada || "-";
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
    // efecto leve cuando llega nueva posición
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }
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

  ui.apply.onclick = () => {
    // recarga con filtro
    fetchInitial(true);
  };
}

initMap();

// ====== Carga inicial (últimas 24h) ======
async function fetchInitial(clear) {
  try {
    setStatus("Cargando posiciones...", "gray");
    if (clear) {
      ui.userList.innerHTML = "";
      state.cluster.clearLayers();
      state.users.clear();
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", since)
      .order("timestamp", { ascending: false });

    if (error) {
      console.error(error);
      setStatus("Error al cargar datos", "gray");
      return;
    }

    const brigFilter = (ui.brigada.value || "").trim().toLowerCase();
    const grouped = new Map();
    const perUser = 1; // solo el último punto por usuario para vista actual

    for (const r of data) {
      if (!isFinite(r.latitud) || !isFinite(r.longitud)) continue;

      if (
        brigFilter &&
        !(r.brigada || "").toLowerCase().includes(brigFilter)
      ) {
        continue;
      }

      const uid = String(r.usuario_id || "0");
      if (!grouped.has(uid)) grouped.set(uid, []);
      if (grouped.get(uid).length >= perUser) continue;
      grouped.get(uid).push(r);
    }

    grouped.forEach((rows, uid) => {
      const last = rows[0];
      const marker = L.marker([last.latitud, last.longitud], {
        icon: getIconFor(last),
      }).bindPopup(buildPopup(last));

      state.cluster.addLayer(marker);
      state.users.set(uid, { marker, lastRow: last });
      addOrUpdateUserInList(last);
    });

    setStatus("Conectado", "green");

    // asegurar suscripción realtime activa
    setupRealtime();
  } catch (e) {
    console.error(e);
    setStatus("Error inesperado", "gray");
  }
}

// ====== Animación suave del movimiento ======
function animateMarkerMovement(marker, fromRow, toRow, duration = 800) {
  const startLat = parseFloat(fromRow.latitud);
  const startLng = parseFloat(fromRow.longitud);
  const endLat = parseFloat(toRow.latitud);
  const endLng = parseFloat(toRow.longitud);

  if (!isFinite(startLat) || !isFinite(startLng) || !isFinite(endLat) || !isFinite(endLng)) {
    // si algo viene mal, solo “teletransporta”
    marker.setLatLng([endLat, endLng]);
    marker.setIcon(getIconFor(toRow));
    marker.bindPopup(buildPopup(toRow));
    return;
  }

  const startTime = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const curLat = startLat + (endLat - startLat) * t;
    const curLng = startLng + (endLng - startLng) * t;

    marker.setLatLng([curLat, curLng]);

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      // al final de la animación, actualizamos icono y popup
      marker.setIcon(getIconFor(toRow));
      marker.bindPopup(buildPopup(toRow));
    }
  }

  requestAnimationFrame(frame);
}

// ====== Realtime Supabase ======
function setupRealtime() {
  if (state.subscription) {
    supa.removeChannel(state.subscription);
    state.subscription = null;
  }

  const channel = supa
    .channel("ubicaciones_brigadas_live")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" },
      (payload) => {
        const row = payload.new;
        handleRealtimeRow(row);
      }
    )
    .subscribe((status) => {
      console.log("[RT] Estado suscripción:", status);
      if (status === "SUBSCRIBED") {
        setStatus("Conectado (tiempo real)", "green");
      }
    });

  state.subscription = channel;
}

function handleRealtimeRow(row) {
  if (!row) return;
  if (!isFinite(row.latitud) || !isFinite(row.longitud)) return;

  const brigFilter = (ui.brigada.value || "").trim().toLowerCase();
  if (
    brigFilter &&
    !(row.brigada || "").toLowerCase().includes(brigFilter)
  ) {
    return;
  }

  const uid = String(row.usuario_id || "0");
  const existing = state.users.get(uid);

  if (!existing) {
    // Nueva brigada en línea
    const marker = L.marker([row.latitud, row.longitud], {
      icon: getIconFor(row),
    }).bindPopup(buildPopup(row));

    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: row });
    addOrUpdateUserInList(row);
  } else {
    // Actualizar con animación suave
    animateMarkerMovement(existing.marker, existing.lastRow, row);
    existing.lastRow = row;
    addOrUpdateUserInList(row);
  }
}

// ====== Arranque ======
setStatus("Cargando...", "gray");
fetchInitial(true);
