/* main.js — versión sin Luxon + animación de movimiento y rotación */

/* ==============================
   1) Supabase & Config
================================ */
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/* ==============================
   2) Estado global
================================ */
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(), // uid -> { marker, lastRow, history: [LatLng], lastSeenMs }
  ui: {},
  maxPointsPerUser: 100,
  minAcc: 0,
  followSelected: false,
  selectedUid: null,
  hideInactiveAfterMs: 5 * 60 * 1000, // 5 minutos
};

/* ==============================
   3) Utilidades de tiempo y animación
================================ */
function parseTsToMs(ts) {
  // Acepta timestamptz ISO (UTC) de Postgres
  const d = new Date(ts);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}
function timeAgoText(ms) {
  const diff = (Date.now() - ms) / 60000;
  if (diff < 1) return 'hace segundos';
  if (diff < 60) return `hace ${Math.round(diff)} min`;
  const h = Math.floor(diff / 60);
  return `hace ${h} h`;
}
function bearingDeg(a, b) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const φ1 = a.lat * toRad;
  const φ2 = b.lat * toRad;
  const Δλ = (b.lng - a.lng) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const brng = Math.atan2(y, x) * toDeg;
  return (brng + 360) % 360;
}
const Easing = {
  // easeInOutCubic
  ioCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};
function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Anima un marker desde su posición actual hasta `to`, en `duration` ms,
 * con easing. También rota el ícono hacia el rumbo del movimiento.
 */
function animateMarkerTo(marker, to, { duration = 1100 } = {}) {
  const from = marker.getLatLng();
  const start = performance.now();
  const end = start + duration;
  const rot = bearingDeg(from, to);

  // aplica rotación al <img> del icono (si existe)
  if (marker._icon) {
    marker._icon.style.transition = 'transform 180ms linear';
    marker._icon.style.transform = `rotate(${rot}deg)`;
    marker._icon.style.transformOrigin = '50% 50%';
    marker._icon.style.willChange = 'transform';
  }

  function frame(now) {
    const t = Math.min(1, (now - start) / (end - start));
    const e = Easing.ioCubic(t);
    const lat = lerp(from.lat, to.lat, e);
    const lng = lerp(from.lng, to.lng, e);
    marker.setLatLng([lat, lng]);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ==============================
   4) Iconos y helpers de Marker
================================ */
const CarIcon = L.icon({
  iconUrl: 'assets/carro.png',
  iconSize: [38, 20],      // más ancho pero no estirado
  iconAnchor: [19, 10],    // centro del “carro”
  popupAnchor: [0, -10]
});
const CarIconGray = L.icon({
  iconUrl: 'assets/carro.png',
  iconSize: [32, 17],
  iconAnchor: [16, 9],
  className: 'icon-gray'
});
const AccCircleStyle = {
  color: '#4cc9f0',
  fillColor: '#4cc9f0',
  fillOpacity: 0.12,
  weight: 1
};

function userKey(row) {
  // usa usuario_id si existe; si no, cae a "tecnico"
  return (row.usuario_id && String(row.usuario_id)) || (row.tecnico ?? 'desconocido');
}
function statusKind(lastSeenMs) {
  const diff = Date.now() - lastSeenMs;
  if (diff <= 60 * 1000) return 'online';
  if (diff <= 5 * 60 * 1000) return 'idle';
  return 'offline';
}
function iconFor(kind) {
  return kind === 'online' ? CarIcon : (kind === 'idle' ? CarIcon : CarIconGray);
}

/* ==============================
   5) UI y Mapa
================================ */
function initUIRefs() {
  state.ui.brigada = document.getElementById('brigadaFilter');
  state.ui.minAcc = document.getElementById('minAcc');
  state.ui.tail = document.getElementById('tailPoints');
  state.ui.apply = document.getElementById('applyFilters');
  state.ui.userList = document.getElementById('userList');
  state.ui.status = document.getElementById('status');
  state.ui.baseSelect = document.getElementById('baseMap');
  state.ui.exportKmz = document.getElementById('exportKmz');
  state.ui.follow = document.getElementById('chkFollow');
}

function setStatus(text, kind = 'gray') {
  state.ui.status.textContent = text;
  state.ui.status.className = `dot ${kind}`;
}

function initMap() {
  state.map = L.map('map', { zoomControl: false, minZoom: 3 });
  L.control.zoom({ position: 'topleft' }).addTo(state.map);

  // Capas base
  state.baseLayers = {
    'Callejero': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OpenStreetMap'
    }),
    'Humanitario': L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OSM Humanitarian'
    }),
    'Satélite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, attribution: 'Esri'
    }),
  };
  state.baseLayers['Callejero'].addTo(state.map);
  L.control.layers(state.baseLayers, null, { position: 'topleft' }).addTo(state.map);

  // capa simple para markers
  state.cluster = L.layerGroup().addTo(state.map);

  // Centro por defecto (Lima)
  state.map.setView([-12.046, -77.042], 12);
}

function readFilters() {
  state.maxPointsPerUser = parseInt(state.ui.tail.value || '100', 10);
  state.minAcc = parseFloat(state.ui.minAcc.value || '0');
  state.followSelected = state.ui.follow.checked;
}

/* ==============================
   6) Pintado / mantenimiento de usuarios
================================ */
function buildPopup(row, lastSeenMs, kind) {
  const t = timeAgoText(lastSeenMs);
  const brig = row.brigada || '-';
  const vel = (row.spd || 0).toFixed(1);
  const acc = Math.round(row.acc || 0);
  return `
    <div style="min-width:220px">
      <strong>${row.tecnico || '—'}</strong><br>
      Brigada: <b>${brig}</b><br>
      Lat: <b>${row.latitud.toFixed(5)}</b> · Lon: <b>${row.longitud.toFixed(5)}</b><br>
      Acc: <b>${acc} m</b> · Vel: <b>${vel} m/s</b><br>
      <span class="badge ${kind}">${kind === 'online' ? 'Online' : (kind === 'idle' ? 'Inactivo' : 'Offline')}</span>
      <div style="opacity:.7;margin-top:4px">${t}</div>
    </div>`;
}

/**
 * Crea o actualiza el marker de un usuario.
 * - Aplica animación si ya existe y cambió de posición.
 * - Rota el icono hacia el rumbo del movimiento.
 * - Oculta si lleva > 5 min inactivo.
 */
function upsertUser(row) {
  if (row.acc != null && row.acc < state.minAcc) return; // filtra por precisión

  const uid = userKey(row);
  const seenMs = parseTsToMs(row.timestamp);
  const kind = statusKind(seenMs);

  // si pasó el umbral de inactividad, borra del mapa si existe
  if (Date.now() - seenMs > state.hideInactiveAfterMs) {
    const ex = state.users.get(uid);
    if (ex?.marker) {
      state.cluster.removeLayer(ex.marker);
      if (ex.marker._accCircle) state.cluster.removeLayer(ex.marker._accCircle);
    }
    state.users.delete(uid);
    renderUserList();
    return;
  }

  const latLng = L.latLng(row.latitud, row.longitud);
  let u = state.users.get(uid);

  if (!u) {
    // Crear nuevo marker
    const marker = L.marker(latLng, { icon: iconFor(kind), title: row.tecnico || uid });
    marker.addTo(state.cluster);
    marker.bindPopup(buildPopup(row, seenMs, kind));
    marker.on('click', () => {
      state.selectedUid = uid;
      if (state.followSelected) state.map.setView(marker.getLatLng(), Math.max(state.map.getZoom(), 15));
    });

    // círculo de precisión (opcional, a demanda con checkbox "Mostrar precisión")
    marker._accCircle = null;

    u = { marker, lastRow: row, history: [], lastSeenMs: seenMs };
    state.users.set(uid, u);
  } else {
    // animar de posición anterior a la nueva
    const prev = L.latLng(u.lastRow.latitud, u.lastRow.longitud);
    const changed = prev.distanceTo(latLng) > 0.5; // más de ~0.5m
    // icono por estado
    u.marker.setIcon(iconFor(kind));

    if (changed) {
      animateMarkerTo(u.marker, latLng, { duration: 1100 });
    } else {
      u.marker.setLatLng(latLng);
    }

    // actualizar popup
    u.marker.setPopupContent(buildPopup(row, seenMs, kind));
  }

  // guarda histórico en memoria para KMZ (no se dibuja)
  u.history.push([row.longitud, row.latitud]); // [lng,lat] para KML
  if (u.history.length > state.maxPointsPerUser) u.history.shift();

  u.lastRow = row;
  u.lastSeenMs = seenMs;

  // seguir seleccionado
  if (state.followSelected && state.selectedUid === uid) {
    state.map.setView(u.marker.getLatLng(), Math.max(state.map.getZoom(), 15));
  }
}

/* ==============================
   7) Listado de usuarios
================================ */
function renderUserList() {
  const el = state.ui.userList;
  el.innerHTML = '';
  const rows = [];
  state.users.forEach((u, uid) => rows.push({ uid, last: u.lastRow, lastSeenMs: u.lastSeenMs }));
  rows.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  for (const { uid, last, lastSeenMs } of rows) {
    const kind = statusKind(lastSeenMs);
    const li = document.createElement('li');
    li.className = 'user-item';
    li.innerHTML = `
      <div class="name">${last.tecnico || uid}</div>
      <div class="sub">Brig: ${last.brigada || '-'} · ${timeAgoText(lastSeenMs)}</div>
      <span class="chip ${kind}">${kind === 'online' ? 'Online' : (kind === 'idle' ? 'Inactivo' : 'Offline')}</span>
    `;
    li.onclick = () => {
      state.selectedUid = uid;
      const u = state.users.get(uid);
      if (u?.marker) {
        u.marker.openPopup();
        state.map.setView(u.marker.getLatLng(), Math.max(state.map.getZoom(), 16));
      }
    };
    el.appendChild(li);
  }
}

/* ==============================
   8) Carga inicial y Realtime
================================ */
async function initialLoad() {
  setStatus('Conectando...', 'gray');
  readFilters();

  // Trae lo más reciente (ej: 1000 últimos) y arma “último por usuario”
  // Filtra por brigada si se pide
  const col = [];
  const sel = supa.from('ubicaciones_brigadas')
    .select('usuario_id,tecnico,brigada,contrata,zona,cargo,latitud,longitud,acc,spd,timestamp')
    .order('timestamp', { ascending: false })
    .limit(1200);

  const brig = state.ui.brigada.value.trim();
  const { data, error } = brig
    ? await sel.eq('brigada', brig)
    : await sel;

  if (error) {
    setStatus('Error al cargar', 'red');
    console.error(error);
    return;
  }
  const seenByUid = new Map();
  for (const r of data) {
    const uid = userKey(r);
    if (!seenByUid.has(uid)) {
      seenByUid.set(uid, true);
      col.push(r);
    }
  }

  // limpiar capa y estado
  state.cluster.clearLayers();
  state.users.clear();

  // pintar
  for (const r of col.reverse()) upsertUser(r);
  renderUserList();
  setStatus('Conectado', 'green');

  // suscripción realtime
  subscribeRealtime();
}

function subscribeRealtime() {
  const chan = supa.channel('realtime:ubicaciones')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, payload => {
      const r = payload.new;
      // filtro de brigada
      const brig = state.ui.brigada.value.trim();
      if (brig && String(r.brigada || '').trim() !== brig) return;

      upsertUser(r);
      renderUserList();
    })
    .subscribe();

  // guardar por si luego quieres cerrar canal
  state._chan = chan;
}

/* ==============================
   9) Exportar KMZ (recorrido actual)
================================ */
function buildKmlForUser(uid, displayName) {
  const u = state.users.get(uid);
  if (!u || u.history.length < 2) return null;

  const when = new Date().toISOString();
  const coords = u.history.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
  const name = (displayName || uid).replace(/[<>]/g, '');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
      <name>${name} – recorrido</name>
      <Placemark>
        <name>${name}</name>
        <description>Exportado ${when}</description>
        <Style>
          <LineStyle><color>ff00aaff</color><width>4</width></LineStyle>
        </Style>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>${coords}</coordinates>
        </LineString>
      </Placemark>
    </Document>
  </kml>`;
  return kml;
}

function downloadKmzFor(uid) {
  const u = state.users.get(uid);
  if (!u) return;
  const kml = buildKmlForUser(uid, u.lastRow?.tecnico || uid);
  if (!kml) {
    alert('No hay suficientes puntos para exportar.');
    return;
  }
  // KMZ = zip con KML; para simplificar entregamos .kml (Google Earth lo abre igual)
  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `recorrido_${(u.lastRow?.tecnico || uid).replace(/\s+/g, '_')}.kml`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/* ==============================
   10) Eventos UI
================================ */
function wireUI() {
  state.ui.apply.onclick = () => initialLoad();

  state.ui.baseSelect.onchange = () => {
    const name = state.ui.baseSelect.value;
    Object.values(state.baseLayers).forEach(l => state.map.removeLayer(l));
    state.baseLayers[name].addTo(state.map);
  };

  state.ui.exportKmz.onclick = () => {
    if (!state.selectedUid) {
      alert('Selecciona un usuario de la lista para exportar su recorrido.');
      return;
    }
    downloadKmzFor(state.selectedUid);
  };

  // “Mostrar precisión” (círculo)
  const chkAcc = document.getElementById('chkAcc');
  chkAcc.addEventListener('change', () => {
    state.users.forEach(u => {
      const has = !!u.marker._accCircle;
      if (chkAcc.checked && !has && u.lastRow?.acc) {
        const latlng = u.marker.getLatLng();
        u.marker._accCircle = L.circle(latlng, { radius: u.lastRow.acc, ...AccCircleStyle }).addTo(state.cluster);
      } else if (!chkAcc.checked && has) {
        state.cluster.removeLayer(u.marker._accCircle);
        u.marker._accCircle = null;
      }
    });
  });
}

/* ==============================
   11) Bootstrap
================================ */
window.addEventListener('DOMContentLoaded', () => {
  initUIRefs();
  initMap();
  wireUI();
  initialLoad().catch(console.error);
});
