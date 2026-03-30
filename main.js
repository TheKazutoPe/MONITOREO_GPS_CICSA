const ADMIN_PASS = "cicsaconnect";
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

const ui = {
  status: document.getElementById("status"),
  userList: document.getElementById("userList"),
  mapStyleSelect: document.getElementById("mapStyleSelect"),
  siteSearch: document.getElementById("siteSearch"),
  siteSuggestions: document.getElementById("siteSuggestions"),
  routesPanel: document.getElementById("routesPanel"),
  btnClearRoute: document.getElementById("btnClearRoute"),
  filterBrigada: document.getElementById("filterBrigada"),
  filterZona: document.getElementById("filterZona"),
  filterContrata: document.getElementById("filterContrata"),
  filterStatus: document.getElementById("filterStatus"),
  mainSidebar: document.getElementById("mainSidebar"),
  btnToggleSidebar: document.getElementById("btnToggleSidebar"),
  toastContainer: document.getElementById("toastContainer"),
  btnExportCSV: document.getElementById("btnExportCSV"),
  btnExportKML: document.getElementById("btnExportKML"),
  kmlModal: document.getElementById("kmlModal"),
  kmlBrigadaSelect: document.getElementById("kmlBrigadaSelect"),
  kmlDateSelect: document.getElementById("kmlDateSelect"),
  btnGenerateKML: document.getElementById("btnGenerateKML"),
  btnCloseKmlModal: document.getElementById("btnCloseKmlModal")
};

const state = { map: null, markers: new Map(), users: new Map(), routeLayer: null, siteMarker: null, currentBase: "osm", baseLayers: {} };

const ICONS = {
  online: L.icon({ iconUrl: "assets/carro-green.png", iconSize: [40, 24], iconAnchor: [20, 12], className: '' }),
  mid: L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40, 24], iconAnchor: [20, 12], className: '' }),
  off: L.icon({ iconUrl: "assets/carro-gray.png", iconSize: [40, 24], iconAnchor: [20, 12], className: '' })
};

function initMap() {
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
  state.baseLayers.streets = L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`);
  state.baseLayers.satellite = L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`);

  state.map = L.map("map", { center: [-12.04, -77.02], zoom: 6, layers: [state.baseLayers.osm], zoomControl: false });
  state.routeLayer = L.layerGroup().addTo(state.map);

  // Asegurar renderizado correcto del mapa
  setTimeout(() => state.map.invalidateSize(), 500);

  // --- DETECTOR INTELIGENTE DE COORDENADAS ---
  ui.siteSearch.oninput = async (e) => {
    const q = e.target.value.trim();

    // Regex para detectar coordenadas: latitud, longitud
    const coordRegex = /^([-+]?\d+\.\d+)\s*,\s*([-+]?\d+\.\d+)$/;
    const match = q.match(coordRegex);

    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      ui.siteSuggestions.innerHTML = `
            <div class="suggestion-item" style="background: #ff3b30; color: #fff; font-weight: 800;" 
                 onclick="selSite(${lng},${lat},'Coord. Manual')">
                📍 IR A COORDENADA: ${lat}, ${lng}
            </div>`;
      ui.siteSuggestions.style.display = "block";
      return;
    }

    if (q.length < 3) { ui.siteSuggestions.style.display = "none"; return; }

    // Búsqueda normal por Site Name en base de datos
    const { data } = await supa.from("sites_nacional_tabla").select("*").ilike("Site_Name", `%${q}%`).limit(15);
    if (data) {
      ui.siteSuggestions.innerHTML = data.map(s => `<div class="suggestion-item" onclick="selSite(${s.Longitude},${s.Latitude},'${s.Site_Name}')">🏢 ${s.Site_Name}</div>`).join("");
      ui.siteSuggestions.style.display = "block";
    }
  };

  ui.btnClearRoute.onclick = () => {
    ui.siteSearch.value = ""; ui.routesPanel.innerHTML = ""; ui.btnClearRoute.style.display = "none";
    if (state.siteMarker) state.map.removeLayer(state.siteMarker);
    state.routeLayer.clearLayers();
    state.map.setView([-12.04, -77.02], 6);
  };

  ui.filterBrigada.oninput = applyFilters;
  ui.filterZona.onchange = applyFilters;
  if(ui.filterContrata) ui.filterContrata.onchange = applyFilters;
  ui.filterStatus.onchange = applyFilters;

  // Clic Derecho en Mapa para Ruteo Rápido
  state.map.on('contextmenu', (e) => {
    L.popup()
      .setLatLng(e.latlng)
      .setContent(`
              <div style="text-align:center;">
                  <b style="font-size:12px;">Coordenada manual:</b><br><small>${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}</small><br><br>
                  <button onclick="selSite(${e.latlng.lng}, ${e.latlng.lat}, 'Coord. Manual'); state.map.closePopup();" 
                          style="background:#ff3b30; color:#fff; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:bold;">
                  📍 Enviar Brigadas Aquí
                  </button>
              </div>
          `)
      .openOn(state.map);
  });

  ui.btnToggleSidebar.onclick = () => {
    ui.mainSidebar.classList.toggle('collapsed');
    setTimeout(() => state.map.invalidateSize(), 400);
  };

  if (ui.btnExportCSV) ui.btnExportCSV.onclick = exportToCSV;
  
  const btnExportWP = document.getElementById("btnExportWP");
  if (btnExportWP) btnExportWP.onclick = generateWhatsAppStatus;
  
  const btnCloseWpModal = document.getElementById("btnCloseWpModal");
  if (btnCloseWpModal) btnCloseWpModal.onclick = () => { document.getElementById("wpModal").style.display = "none"; };

  if (ui.btnExportKML) {
    ui.btnExportKML.onclick = () => {
      const brigs = [...new Set(Array.from(state.users.values()).map(u => u.lastRow.brigada))].sort();
      ui.kmlBrigadaSelect.innerHTML = brigs.map(b => `<option value="${b}">${b}</option>`).join("");
      ui.kmlDateSelect.valueAsDate = new Date();
      ui.kmlModal.style.display = "flex";
    };
  }
  if (ui.btnCloseKmlModal) ui.btnCloseKmlModal.onclick = () => ui.kmlModal.style.display = "none";
  if (ui.btnGenerateKML) ui.btnGenerateKML.onclick = executeKMLGeneration;

  syncData();
  initRealtime();
}

function updateMapLayer(k) { state.map.removeLayer(state.baseLayers[state.currentBase]); state.map.addLayer(state.baseLayers[k]); state.currentBase = k; }

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-alert ${type}`;
  el.innerHTML = msg;
  ui.toastContainer.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 4000);
}

function generateWhatsAppStatus() {
  const wpModal = document.getElementById("wpModal");
  const wpContainer = document.getElementById("wpContainer");
  wpModal.style.display = "flex";
  
  const rows = Array.from(state.users.values()).map(u => u.lastRow).filter(r => r && r.brigada);
  const sortWeight = { 'off': 1, 'mid': 2, 'online': 3 };
  const getStatusText = (key) => key === 'off' ? 'Pendiente (Desconectado)' : key === 'mid' ? 'Alerta (Sin reporte rec.)' : 'Conectado (Online)';
  const getStatusColor = (key) => key === 'off' ? '#cc0000' : key === 'mid' ? '#b8860b' : '#1b5e20';

  const formatted = rows.map(r => ({
    zona: (r.zona || 'SIN ZONA').toUpperCase().trim(),
    contrata: (r.contrata || 'SIN CONTRATA').toUpperCase().trim(),
    brigada: r.brigada.toUpperCase(),
    tecnico: r.tecnico || 'N/A',
    estadoKey: getStatusKey(r),
    estadoTxt: getStatusText(getStatusKey(r)),
    estadoColor: getStatusColor(getStatusKey(r)),
    peso: sortWeight[getStatusKey(r)]
  }));

  // Agrupar por Zona
  const grouped = {};
  formatted.forEach(f => {
    if (!grouped[f.zona]) grouped[f.zona] = [];
    grouped[f.zona].push(f);
  });

  wpContainer.innerHTML = "";

  Object.keys(grouped).sort().forEach(zona => {
    grouped[zona].sort((a, b) => {
      if (a.peso !== b.peso) return a.peso - b.peso;
      if (a.contrata !== b.contrata) return a.contrata.localeCompare(b.contrata);
      return a.brigada.localeCompare(b.brigada);
    });

    const tableId = 'wp-tb-' + zona.replace(/[^a-zA-Z0-9]/g, '');
    
    let html = `
      <div style="background:#222; padding:15px; border-radius:8px; border:1px solid #444;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <h4 style="margin:0; color:#fff;">STATUS ${zona}</h4>
          <button onclick="copyTableImage('${tableId}', '${zona}')" style="background:#25d366; color:#fff; border:none; padding:6px 16px; border-radius:6px; font-weight:bold; cursor:pointer;">📸 Copiar Imagen</button>
        </div>
        
        <div id="${tableId}" style="background:#ffffff; color:#000; font-family:'Calibri', sans-serif; padding:2px; display:inline-block;">
          <table style="border-collapse: collapse; min-width: 600px; font-size: 13px;">
            <thead>
              <tr>
                <th style="background:#0b1a2a; color:#fff; border:1px solid #ccc; padding:6px; font-size:12px;">ZONA</th>
                <th style="background:#0b1a2a; color:#fff; border:1px solid #ccc; padding:6px; font-size:12px;">CONTRATA</th>
                <th style="background:#0b1a2a; color:#fff; border:1px solid #ccc; padding:6px; font-size:12px;">BRIGADA</th>
                <th style="background:#0b1a2a; color:#fff; border:1px solid #ccc; padding:6px; font-size:12px;">ESTADO ACTUAL</th>
                <th style="background:#0b1a2a; color:#fff; border:1px solid #ccc; padding:6px; font-size:12px;">TÉCNICO</th>
              </tr>
            </thead>
            <tbody>
    `;

    grouped[zona].forEach(r => {
      html += `
              <tr>
                <td style="border:1px solid #ccc; padding:4px 8px; font-weight:bold;">${r.zona}</td>
                <td style="border:1px solid #ccc; padding:4px 8px;">${r.contrata}</td>
                <td style="border:1px solid #ccc; padding:4px 8px;"><b>${r.brigada}</b></td>
                <td style="border:1px solid #ccc; padding:4px 8px; color:${r.estadoColor}; font-weight:bold;">${r.estadoTxt}</td>
                <td style="border:1px solid #ccc; padding:4px 8px;">${r.tecnico.replace(/[\r\n]+/g, ' ')}</td>
              </tr>
      `;
    });

    html += `</tbody></table></div></div>`;
    wpContainer.innerHTML += html;
  });
}

window.copyTableImage = function(elementId, zonaName) {
  const el = document.getElementById(elementId);
  const btn = event.currentTarget;
  const originalText = btn.innerText;
  btn.innerText = "⏳ Copiando...";
  btn.style.opacity = "0.7";
  
  html2canvas(el, { scale: 2, backgroundColor: '#ffffff' }).then(canvas => {
    canvas.toBlob(blob => {
      try {
        navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
        showToast("✅ Imagen de " + zonaName + " copiada. Usa Ctrl+V en WhatsApp.", "info");
        btn.innerText = "✅ ¡Copiado!";
        btn.style.background = "#10b981";
      } catch (err) {
        showToast("❌ Error copiando imagen. Revisa permisos.", "error");
        btn.innerText = originalText;
      }
      setTimeout(() => {
         btn.innerText = "📸 Copiar Imagen";
         btn.style.background = "#25d366";
         btn.style.opacity = "1";
      }, 3000);
    });
  });
}

function exportToCSV() {
  const rows = Array.from(state.users.values())
    .map(u => u.lastRow)
    .filter(r => r && r.brigada); // Filtrar data inválida

  const sortWeight = { 'off': 1, 'mid': 2, 'online': 3 };
  const getStatusText = (key) => key === 'off' ? 'Pendiente (Desconectado)' : key === 'mid' ? 'Alerta (Sin reporte rec.)' : 'Conectado (Online)';

  const formattedRows = rows.map(r => {
    const key = getStatusKey(r);
    return {
      zona: (r.zona || 'SIN ZONA').toUpperCase().trim(),
      contrata: (r.contrata || 'SIN CONTRATA').toUpperCase().trim(),
      brigada: r.brigada.toUpperCase(),
      tecnico: r.tecnico || 'N/A',
      estadoKey: key,
      estadoTxt: getStatusText(key),
      estadoPeso: sortWeight[key],
      lat: r.latitud || 0,
      lng: r.longitud || 0,
      fecha: new Date(r.timestamp).toLocaleString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit'})
    };
  });

  // Ordenar: 1° Zona (A-Z) -> 2° Estado (Pendiente primero) -> 3° Contrata (A-Z) -> 4° Brigada (A-Z)
  formattedRows.sort((a, b) => {
    if (a.zona !== b.zona) return a.zona.localeCompare(b.zona);
    if (a.estadoPeso !== b.estadoPeso) return a.estadoPeso - b.estadoPeso; 
    if (a.contrata !== b.contrata) return a.contrata.localeCompare(b.contrata);
    return a.brigada.localeCompare(b.brigada);
  });

  const now = new Date();
  const dateStr = now.toLocaleDateString('es-PE').replace(/\//g, '-');

  let excelHTML = `
  <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
  <head>
    <meta charset="UTF-8">
    <style>
      .table { border-collapse: collapse; font-family: Calibri, sans-serif; }
      .table th { background-color: #0b1a2a; color: #ffffff; font-weight: bold; border: 1px solid #bbbbbb; padding: 10px; font-size: 14px; }
      .table td { border: 1px solid #bbbbbb; padding: 8px; font-size: 13px; text-align: center; }
      .zona { font-weight: bold; text-align: left; background-color: #f7f9fc; }
      .off { background-color: #ffeaea; color: #cc0000; font-weight: bold; }
      .mid { background-color: #fff8e1; color: #b8860b; font-weight: bold; }
      .online { background-color: #e8f5e9; color: #1b5e20; font-weight: bold; }
    </style>
  </head>
  <body>
    <h3>Status Nacional de Brigadas - Generado: ${now.toLocaleString()}</h3>
    <table class="table">
      <thead>
        <tr>
          <th>ZONA</th><th>CONTRATA</th><th>BRIGADA</th><th>ESTADO ACTUAL</th><th>ÚLTIMO REPORTE</th><th>TÉCNICO</th><th>LATITUD</th><th>LONGITUD</th>
        </tr>
      </thead>
      <tbody>
  `;

  formattedRows.forEach(f => {
    const tecClean = String(f.tecnico || '').replace(/[\r\n]+/g, ' ');
    const briClean = String(f.brigada || '').replace(/[\r\n]+/g, ' ');
    excelHTML += `
        <tr>
          <td class="zona">${f.zona}</td>
          <td>${f.contrata}</td>
          <td><b>${briClean}</b></td>
          <td class="${f.estadoKey}">${f.estadoTxt}</td>
          <td>${f.fecha}</td>
          <td style="text-align:left;">${tecClean}</td>
          <td>${f.lat}</td>
          <td>${f.lng}</td>
        </tr>`;
  });

  excelHTML += `</tbody></table></body></html>`;

  const blob = new Blob([excelHTML], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.setAttribute("download", `Status_Nacional_Brigadas_${dateStr}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("✅ Status Nacional EXCEL generado con éxito.", "info");
}

async function executeKMLGeneration() {
  const brigada = ui.kmlBrigadaSelect.value;
  const dateStr = ui.kmlDateSelect.value;
  if (!brigada || !dateStr) { showToast("❌ Selecciona brigada y fecha", "error"); return; }
  
  ui.kmlModal.style.display = 'none';
  showToast(`⏳ Recopilando historial de ${brigada} para el ${dateStr}...`, "warn");

  const [y, m, d] = dateStr.split('-');
  const startOfDay = new Date(y, m-1, d, 0, 0, 0).toISOString();
  const endOfDay = new Date(y, m-1, d, 23, 59, 59).toISOString();
  
  const { data, error } = await supa.from("ubicaciones_brigadas")
    .select("usuario_id, brigada, latitud, longitud, timestamp, acc")
    .eq("brigada", brigada)
    .gte("timestamp", startOfDay)
    .lte("timestamp", endOfDay)
    .order("timestamp", { ascending: true });
    
  if (error || !data || data.length === 0) {
     showToast(`❌ No hay recorridos para ${brigada} el ${dateStr}.`, "error"); return;
  }

  // ── Filtro 1: coordenadas válidas + precisión GPS aceptable (acc <= 50m)
  const ACC_MAX = 50;
  let points = data.filter(r =>
    isFinite(r.latitud) && isFinite(r.longitud) &&
    (r.acc == null || r.acc <= ACC_MAX)
  );
  showToast(`🔍 ${data.length} puntos brutos → ${points.length} con precisión ≤${ACC_MAX}m`, 'warn');
  const filtered = [];
  let lastTime = 0;
  let lastP = null;

  // Array para puntos por minuto (solo filtro de tiempo, sin restricción de distancia)
  const minutePoints = [];
  let lastMinTime = 0;
  
  const calcDist = (lat1, lon1, lat2, lon2) => {
     const R = 6371e3, p1 = lat1 * Math.PI/180, p2 = lat2 * Math.PI/180;
     const dp = (lat2-lat1) * Math.PI/180, dl = (lon2-lon1) * Math.PI/180;
     const a = Math.sin(dp/2)*Math.sin(dp/2) + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
     return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  const MAX_SPEED_KMH = 120; // velocidad máxima realista (km/h)
  let lastValidP = null;     // último punto aceptado por el filtro de velocidad

  for (const p of points) {
     const t = new Date(p.timestamp).getTime();

     // ── Filtro 2: velocidad máxima entre puntos (descarta saltos fantasma)
     if (lastValidP) {
        const dt_h = (t - new Date(lastValidP.timestamp).getTime()) / 3600000; // horas
        const dist_km = calcDist(lastValidP.latitud, lastValidP.longitud, p.latitud, p.longitud) / 1000;
        const speed = dt_h > 0 ? dist_km / dt_h : 0;
        if (speed > MAX_SPEED_KMH) continue; // punto imposible, se descarta
     }
     lastValidP = p;

     // ── Filtro 3 (ruta): cada 60s Y > 80m de movimiento
     if (t - lastTime >= 60000) { 
        if (!lastP || calcDist(lastP.latitud, lastP.longitud, p.latitud, p.longitud) > 80) {
           filtered.push(p);
           lastTime = t;
           lastP = p;
        }
     }
     // ── Filtro para puntos por minuto: solo cada 60s (sin importar distancia)
     if (t - lastMinTime >= 60000) {
        minutePoints.push(p);
        lastMinTime = t;
     }
  }
  
  if (filtered.length < 2) {
     showToast("❌ No hay suficientes datos (separados x 1min) para trazar ruta.", "error"); return;
  }

  showToast(`🗺️ Trazando ruta real en servidores Mapbox para ${brigada}...`, "info");
  
  let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Recorrido ${brigada} - ${dateStr}</name>
    <Style id="routeStyle"><LineStyle><color>ff0000ff</color><width>5</width></LineStyle></Style>
    <Style id="startIcon"><IconStyle><scale>2.0</scale><Icon><href>https://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle><LabelStyle><scale>1.2</scale></LabelStyle></Style>
    <Style id="endIcon"><IconStyle><scale>2.0</scale><Icon><href>https://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle><LabelStyle><scale>1.2</scale></LabelStyle></Style>
    <Style id="pointIcon"><IconStyle><scale>0.6</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon><hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle><LabelStyle><scale>0.8</scale></LabelStyle></Style>
    <Style id="minuteIcon"><IconStyle><scale>1.4</scale><color>ff00aaff</color><Icon><href>https://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle><LabelStyle><scale>1.0</scale></LabelStyle></Style>
    <Folder><name>${brigada}</name>\n`;

  const pStart = points[0];
  const pEnd = points[points.length - 1];
  
  kml += `      <Placemark><name>🚀 INICIO: ${new Date(pStart.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</name><styleUrl>#startIcon</styleUrl><Point><coordinates>${pStart.longitud},${pStart.latitud}</coordinates></Point></Placemark>\n`;

  if (points.length > 1) {
     kml += `      <Placemark><name>🏁 FIN: ${new Date(pEnd.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</name><styleUrl>#endIcon</styleUrl><Point><coordinates>${pEnd.longitud},${pEnd.latitud}</coordinates></Point></Placemark>\n`;
  }

  for (let j = 0; j < filtered.length - 1; j += 24) {
      const chunk = filtered.slice(j, j + 25);
      if (chunk.length < 2) continue;
      
      const coordsPath = chunk.map(p => `${p.longitud},${p.latitud}`).join(';');
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordsPath}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
      
      try {
          const resp = await fetch(url);
          const json = await resp.json();
          if (json.routes && json.routes[0]) {
              const geom = json.routes[0].geometry.coordinates;
              const kmlCoords = geom.map(c => `${c[0]},${c[1]}`).join(' ');
              kml += `      <Placemark><name>Tramo ${Math.floor(j/24) + 1}</name><styleUrl>#routeStyle</styleUrl><LineString><tessellate>1</tessellate><coordinates>${kmlCoords}</coordinates></LineString></Placemark>\n`;
          } else {
              const kmlCoords = chunk.map(p => `${p.longitud},${p.latitud}`).join(' ');
              kml += `      <Placemark><name>Tramo (Directo)</name><styleUrl>#routeStyle</styleUrl><LineString><tessellate>1</tessellate><coordinates>${kmlCoords}</coordinates></LineString></Placemark>\n`;
          }
      } catch (e) {
          console.error("Mapbox err", e);
      }
  }

  // --- Carpeta: Puntos por Minuto ---
  kml += `    </Folder>\n    <Folder><name>⏱️ Puntos por Minuto (${minutePoints.length})</name>\n`;
  minutePoints.forEach((p, idx) => {
    const timeStr = new Date(p.timestamp).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const isFirst = idx === 0;
    const isLast  = idx === minutePoints.length - 1;
    const style   = isFirst ? '#startIcon' : isLast ? '#endIcon' : '#minuteIcon';
    const label   = isFirst ? `🚀 Inicio ${timeStr}` : isLast ? `🏁 Fin ${timeStr}` : `⏱️ ${timeStr}`;
    kml += `      <Placemark><name>${label}</name><description>Brigada: ${brigada}\nHora: ${timeStr}\nLat: ${p.latitud}\nLon: ${p.longitud}</description><styleUrl>${style}</styleUrl><Point><coordinates>${p.longitud},${p.latitud}</coordinates></Point></Placemark>\n`;
  });
  kml += `    </Folder>\n  </Document>\n</kml>`;
  
  const blob = new Blob([kml], {type: 'application/vnd.google-earth.kml+xml;charset=utf-8;'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', `Ruta_${brigada.replace(/[^a-zA-Z0-9_-]/g, '_')}_${dateStr}.kml`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("✅ ¡Ruta KML generada con éxito!", "info");
}

async function calcularRutas(slat, slng) {
  if (!isFinite(slat) || !isFinite(slng)) return;
  ui.routesPanel.innerHTML = "<div class='status-badge green' style='width:100%'>⚡ Trazado de alta precisión...</div>";
  state.routeLayer.clearLayers();

  const candidates = Array.from(state.users.values())
    .map(u => u.lastRow)
    .filter(r => r && isFinite(r.latitud) && isFinite(r.longitud))
    .map(r => ({ ...r, airDist: Math.sqrt(Math.pow(slng - r.longitud, 2) + Math.pow(slat - r.latitud, 2)) }))
    .sort((a, b) => a.airDist - b.airDist).slice(0, 10);

  const colors = ["#00FF41", "#00E5FF", "#FF00F7"];

  const fetchPromises = candidates.map(async (u) => {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${u.longitud},${u.latitud};${slng},${slat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
    try {
      const resp = await fetch(url);
      const json = await resp.json();
      if (json.routes && json.routes[0]) {
        const r = json.routes[0];
        return { b: u.brigada, t: Math.round(r.duration / 60), d: (r.distance / 1000).toFixed(1), geo: r.geometry };
      }
    } catch (e) { } return null;
  });

  const results = (await Promise.all(fetchPromises)).filter(r => r !== null).sort((a, b) => a.t - b.t);
  const top3 = results.slice(0, 3);

  ui.routesPanel.innerHTML = top3.map((r, i) => {
    L.geoJSON(r.geo, { style: { color: colors[i], weight: 8, opacity: 0.9, smoothFactor: 0 } }).addTo(state.routeLayer);
    return `<div class="route-card rank-${i + 1}"><div style="display:flex; justify-content:space-between"><b>${i + 1}° ${r.b}</b><b style="color:${colors[i]}">${r.t} MIN</b></div><small style="color:#71717a">Distancia: ${r.d} KM</small></div>`;
  }).join("");

  if (state.routeLayer.getLayers().length > 0) state.map.fitBounds(state.routeLayer.getBounds(), { padding: [50, 50] });
  showToast(`📍 Rutas óptimas trazadas para ${top3.length} brigadas.`, 'info');
}

function getStatusKey(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  return mins <= 2 ? "online" : (mins <= 5 ? "mid" : "off");
}

function isHoyElReporte(row) {
  const ahora = new Date();
  const reporte = new Date(row.timestamp);
  return reporte.getFullYear() === ahora.getFullYear() &&
         reporte.getMonth() === ahora.getMonth() &&
         reporte.getDate() === ahora.getDate();
}

function applyFilters() {
  const bText = ui.filterBrigada.value.toLowerCase();
  const zValue = ui.filterZona.value.trim().toLowerCase();
  const cValue = ui.filterContrata ? ui.filterContrata.value.trim().toLowerCase() : "";
  const sValue = ui.filterStatus.value;
  const zoom = state.map.getZoom();

  state.users.forEach((u, uid) => {
    const row = u.lastRow;
    const key = getStatusKey(row);
    // Ocultar brigadas desconectadas cuyo último reporte sea de un día anterior
    if (key === 'off' && !isHoyElReporte(row)) {
      const card = document.getElementById(`u-${uid}`);
      if (card) card.style.display = "none";
      if (u.marker) state.map.removeLayer(u.marker);
      return;
    }
    const zRow = (row.zona || "").trim().toLowerCase();
    const cRow = (row.contrata || "Sin Contrata").trim().toLowerCase();
    const matches = (!bText || (row.brigada && row.brigada.toLowerCase().includes(bText))) && (!zValue || zRow === zValue) && (!cValue || cRow === cValue) && (!sValue || key === sValue);
    const card = document.getElementById(`u-${uid}`);
    if (card) card.style.display = matches ? "flex" : "none";
    if (u.marker) {
      if (matches && isFinite(row.latitud)) {
        if (!state.map.hasLayer(u.marker)) u.marker.addTo(state.map);
        u.marker.setLatLng([row.latitud, row.longitud]).setIcon(zoom >= 11 ? ICONS[key] : L.divIcon({ className: `marker-dot marker-dot-${key}`, iconSize: [14, 14] }));
      } else { state.map.removeLayer(u.marker); }
    }
  });
  updateStats();
}

function updateStats() {
  let on = 0, mid = 0, off = 0;
  state.users.forEach(u => { const k = getStatusKey(u.lastRow); if (k === 'online') on++; else if (k === 'mid') mid++; else off++; });
  document.getElementById("countOnline").textContent = on;
  document.getElementById("countMid").textContent = mid;
  document.getElementById("countOff").textContent = off;
}

async function syncData() {
  // Cargar solo desde el inicio del día actual (medianoche hora local)
  const hoy = new Date();
  const inicioDelDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 0, 0, 0).toISOString();
  const { data } = await supa.from("ubicaciones_brigadas").select("*").gte("timestamp", inicioDelDia).order("timestamp", { ascending: false });
  if (data) {
    const grouped = new Map();
    data.forEach(r => { if (!grouped.has(String(r.usuario_id))) grouped.set(String(r.usuario_id), r); });
    
    grouped.forEach(row => {
      const uid = String(row.usuario_id);
      if (!state.users.has(uid)) {
        let m = null;
        if (isFinite(row.latitud)) {
          m = L.marker([row.latitud, row.longitud]).bindPopup(buildPopup(row));
        }
        state.users.set(uid, { marker: m, lastRow: row });
      } else {
        const u = state.users.get(uid);
        if (new Date(row.timestamp) > new Date(u.lastRow.timestamp)) {
          u.lastRow = row;
          if (isFinite(row.latitud)) {
            if (!u.marker) {
               u.marker = L.marker([row.latitud, row.longitud]).bindPopup(buildPopup(row));
            } else {
               u.marker.setPopupContent(buildPopup(row));
            }
          }
        }
      }
      addOrUpdateUserInList(state.users.get(uid).lastRow);
    });

    const prevZona = ui.filterZona.value;
    const zonas = [...new Set(Array.from(grouped.values()).map(r => (r.zona || "").trim()).filter(Boolean))].sort();
    const newZonasHtml = '<option value="">Todas las Zonas</option>' + zonas.map(z => `<option value="${z}">${z}</option>`).join("");
    if (ui.filterZona.innerHTML !== newZonasHtml) {
      ui.filterZona.innerHTML = newZonasHtml;
      ui.filterZona.value = prevZona || "";
    }

    if (ui.filterContrata) {
      const prevContrata = ui.filterContrata.value;
      const contratas = [...new Set(Array.from(grouped.values()).map(r => (r.contrata || "Sin Contrata").trim()).filter(Boolean))].sort();
      const newContratasHtml = '<option value="">Todas las Contratas</option>' + contratas.map(c => `<option value="${c}">${c}</option>`).join("");
      if (ui.filterContrata.innerHTML !== newContratasHtml) {
        ui.filterContrata.innerHTML = newContratasHtml;
        ui.filterContrata.value = prevContrata || "";
      }
    }

    applyFilters();
    ui.status.textContent = "Conectado"; ui.status.className = "status-badge green";
  }
}

function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id), key = getStatusKey(row);
  let el = document.getElementById(`u-${uid}`);
  if (!el) { el = document.createElement("div"); el.id = `u-${uid}`; el.className = "brigada-item"; ui.userList.appendChild(el); }
  el.onclick = () => { if (isFinite(row.latitud)) { state.map.setView([row.latitud, row.longitud], 16); state.users.get(uid).marker.openPopup(); } };
  el.innerHTML = `<div class="brig-main"><span class="brig-name">${row.brigada}</span><span class="brig-sub">${row.tecnico} | 🏢 ${row.contrata || 'Sin Contrata'}</span><div class="brig-info">📍 ${row.zona || '-'} · Reporte: ${new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div><div class="brig-led ${key}"></div>`;
}

window.selSite = (lng, lat, nom) => {
  ui.siteSearch.value = (nom === 'Coord. Manual') ? `${lat}, ${lng}` : nom;
  ui.siteSuggestions.style.display = "none"; ui.btnClearRoute.style.display = "block";
  if (state.siteMarker) state.map.removeLayer(state.siteMarker);
  state.siteMarker = L.marker([lat, lng], { icon: L.icon({ iconUrl: 'https://docs.mapbox.com/help/demos/custom-markers-gl-js/mapbox-icon.png', iconSize: [30, 40] }) }).addTo(state.map);
  state.map.setView([lat, lng], 15);
  calcularRutas(lat, lng);
};

function buildPopup(r) { return `<div style="min-width:180px;"><b style="color:#ff3b30; font-size:14px;">${r.brigada}</b><br><b>${r.tecnico}</b><br><small>🏢 ${r.contrata || 'Sin Contrata'}</small><hr><small>📍 ZONA: ${r.zona || '-'}</small><br><small>🛰️ Precisión: ${Math.round(r.acc)}m | ⏰ ${new Date(r.timestamp).toLocaleTimeString()}</small></div>`; }
function initRealtime() {
  supa.channel('ubicaciones').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, (p) => {
    const row = p.new;
    if (!isFinite(row.latitud)) return;
    const uid = String(row.usuario_id);

    if (!state.users.has(uid)) {
      const m = L.marker([row.latitud, row.longitud]).bindPopup(buildPopup(row));
      state.users.set(uid, { marker: m, lastRow: row });
      showToast(`🚀 Nueva brigada en línea: <b>${row.brigada}</b>`, 'info');
    } else {
      const u = state.users.get(uid);
      const oldRow = u.lastRow;
      u.lastRow = row;
      
      if (!u.marker) {
          u.marker = L.marker([row.latitud, row.longitud]).bindPopup(buildPopup(row));
      } else {
          u.marker.setPopupContent(buildPopup(row));
      }

      if (getStatusKey(oldRow) === 'off' && getStatusKey(row) !== 'off') {
        showToast(`✅ <b>${row.brigada}</b> ha reconectado.`, 'info');
      }
    }
    
    // Auto-update Contratas if new one appears gracefully
    if (ui.filterContrata && row.contrata) {
      const cLabel = row.contrata.trim();
      let exists = false;
      Array.from(ui.filterContrata.options).forEach(opt => { if (opt.value === cLabel) exists = true; });
      if (!exists && cLabel) {
        const opt = document.createElement("option");
        opt.value = cLabel;
        opt.text = cLabel;
        ui.filterContrata.appendChild(opt);
      }
    }

    addOrUpdateUserInList(state.users.get(uid).lastRow);
    applyFilters();
  }).subscribe();
}

initMap();
setInterval(applyFilters, 60000);   // Auto-refrescar estados cada minuto
setInterval(syncData, 120000);      // Sincronizar datos por si websocket falla (cada 2 min)

// ============================================================
//  DASHBOARD
// ============================================================

// Validates that a row is a real brigade (not a ghost entry)
function isValidRow(r) {
  if (!r) return false;
  if (!r.brigada || r.brigada.trim() === '') return false;
  if (!r.contrata || r.contrata.trim() === '' || r.contrata.trim().toLowerCase() === 'sin contrata') return false;
  if (!r.tecnico || r.tecnico.trim() === '') return false;
  return true;
}

function buildDashboard() {
  const now = new Date();

  // Only valid rows from today
  const rows = Array.from(state.users.values())
    .map(u => u.lastRow)
    .filter(r => r && isHoyElReporte(r) && isValidRow(r));

  // --- KPIs ---
  let on = 0, mid = 0, off = 0;
  const contratasSet = new Set(), zonasSet = new Set();

  rows.forEach(r => {
    const k = getStatusKey(r);
    if (k === 'online') on++;
    else if (k === 'mid') mid++;
    else off++;
    contratasSet.add(r.contrata.trim());
    if (r.zona && r.zona.trim()) zonasSet.add(r.zona.trim());
  });

  const total = rows.length;
  const connected = on + mid;
  const pctConn = total > 0 ? Math.round((connected / total) * 100) : 0;

  document.getElementById('dOnline').textContent    = on;
  document.getElementById('dMid').textContent       = mid;
  document.getElementById('dOff').textContent       = off;
  document.getElementById('dContratas').textContent = contratasSet.size;
  document.getElementById('dZonas').textContent     = zonasSet.size;
  document.getElementById('dTotal').textContent     = total;
  document.getElementById('dashDate').textContent   =
    'Resumen del ' + now.toLocaleDateString('es-PE', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  // Update compliance ring
  const ring = document.getElementById('dashConnRing');
  const ringPct = document.getElementById('dashConnPct');
  if (ring && ringPct) {
    const circ = 2 * Math.PI * 28;
    ring.style.strokeDasharray = `${(pctConn / 100) * circ} ${circ}`;
    ring.style.stroke = pctConn >= 80 ? '#10b981' : pctConn >= 50 ? '#f59e0b' : '#ff3b30';
    ringPct.textContent = pctConn + '%';
  }

  // --- Stacked bar: por Contrata ---
  const byContrata = {};
  rows.forEach(r => {
    const c = r.contrata.trim();
    if (!byContrata[c]) byContrata[c] = { on: 0, mid: 0, off: 0 };
    const k = getStatusKey(r);
    byContrata[c][k === 'online' ? 'on' : k === 'mid' ? 'mid' : 'off']++;
  });
  renderStackedChart('chartContratas', byContrata);

  // --- Stacked bar: por Zona ---
  const byZona = {};
  rows.forEach(r => {
    const z = (r.zona && r.zona.trim()) ? r.zona.trim() : null;
    if (!z) return; // skip rows without zone
    if (!byZona[z]) byZona[z] = { on: 0, mid: 0, off: 0 };
    const k = getStatusKey(r);
    byZona[z][k === 'online' ? 'on' : k === 'mid' ? 'mid' : 'off']++;
  });
  renderStackedChart('chartZonas', byZona);

  // --- Tabla actividad reciente (valid rows only) ---
  const sorted = [...rows].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const tbody = document.getElementById('dashTableBody');
  const labels = { online: 'Online', mid: 'Alerta', off: 'Offline' };
  tbody.innerHTML = sorted.map(r => {
    const k = getStatusKey(r);
    const t = new Date(r.timestamp).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
    return `<tr>
      <td><b>${r.brigada}</b></td>
      <td>${r.tecnico}</td>
      <td>${r.contrata}</td>
      <td>${r.zona || '—'}</td>
      <td><span class="dash-badge ${k}">${labels[k]}</span></td>
      <td>${t}</td>
    </tr>`;
  }).join('');
}

function renderStackedChart(containerId, dataObj) {
  const container = document.getElementById(containerId);
  const entries = Object.entries(dataObj)
    .map(([label, d]) => ({ label, total: d.on + d.mid + d.off, ...d }))
    .sort((a, b) => b.total - a.total);

  const maxTotal = entries[0]?.total || 1;

  container.innerHTML = entries.map(({ label, total, on, mid, off }) => {
    const pctConn = Math.round(((on + mid) / total) * 100);
    const connColor = pctConn >= 80 ? '#10b981' : pctConn >= 50 ? '#f59e0b' : '#ff3b30';
    const wOn  = Math.round((on  / maxTotal) * 100);
    const wMid = Math.round((mid / maxTotal) * 100);
    const wOff = Math.round((off / maxTotal) * 100);
    return `<div class="bar-row">
      <span class="bar-label" title="${label}">${label}</span>
      <div class="bar-track stacked">
        <div class="bar-seg seg-on"  style="width:0%" data-target="${wOn}%"  title="Online: ${on}"></div>
        <div class="bar-seg seg-mid" style="width:0%" data-target="${wMid}%" title="Alerta: ${mid}"></div>
        <div class="bar-seg seg-off" style="width:0%" data-target="${wOff}%" title="Offline: ${off}"></div>
      </div>
      <span class="bar-conn" style="color:${connColor}" title="${on+mid} conectadas / ${total}">${pctConn}%</span>
      <span class="bar-count">${total}</span>
    </div>`;
  }).join('');

  // Animate after paint
  requestAnimationFrame(() => {
    container.querySelectorAll('.bar-seg').forEach(el => {
      el.style.width = el.dataset.target;
    });
  });
}

// Wire up dashboard buttons (script loads at end of body — no need for DOMContentLoaded)
(function wireDashboard() {
  const btnDash    = document.getElementById('btnDashboard');
  const modal      = document.getElementById('dashboardModal');
  const btnClose   = document.getElementById('btnCloseDash');
  const btnRefresh = document.getElementById('btnRefreshDash');

  if (btnDash)    btnDash.onclick    = () => { buildDashboard(); modal.style.display = 'flex'; };
  if (btnClose)   btnClose.onclick   = () => { modal.style.display = 'none'; };
  if (btnRefresh) btnRefresh.onclick = () => buildDashboard();
  if (modal)      modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
})();