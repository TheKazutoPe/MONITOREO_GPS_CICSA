/* Monitoreo brigadas + export KMZ con Mapbox Map Matching */
(() => {
  // ---- Config ----
  const CFG = window.CONFIG || {};
  const SUPABASE_URL = CFG.SUPABASE_URL;
  const SUPABASE_ANON = CFG.SUPABASE_ANON_KEY;
  const MAPBOX_TOKEN = CFG.MAPBOX_TOKEN;
  const DEFAULT_CENTER = CFG.DEFAULT_CENTER || [-12.0464, -77.0428];
  const DEFAULT_ZOOM = CFG.DEFAULT_ZOOM || 12;

  if (!SUPABASE_URL || !SUPABASE_ANON) {
    console.error("Configura SUPABASE_URL y SUPABASE_ANON_KEY en config.js");
  }
  const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  // ---- Estado mínimo ----
  const state = {
    map: null,
    markers: new Map(), // usuario_id -> marker
    lastRows: new Map(), // usuario_id -> última fila
  };

  // ---- Utilidades ----
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function ymdStr(date){
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    const d = (date instanceof Date) ? date : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const dd = String(d.getDate()).padStart(2,"0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function escapeHtml(s){ return String(s||"").replace(/[&<>\"]+/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

  // ---- Mapa ----
  function initMap(){
    const osm = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 20, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors' }
    );
    const map = L.map("map", { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, layers: [osm] });
    state.map = map;
  }

  function getIcon(){
    return L.icon({
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      iconAnchor:[12,41], popupAnchor:[1,-34]
    });
  }

  function upsertMarker(row){
    const uid = String(row.usuario_id || row.tecnico || Math.random());
    const lat = row.latitud, lng = row.longitud;
    if (typeof lat !== "number" || typeof lng !== "number") return;

    let mk = state.markers.get(uid);
    if (!mk){
      mk = L.marker([lat,lng], {icon: getIcon()}).addTo(state.map);
      state.markers.set(uid, mk);
    } else {
      mk.setLatLng([lat,lng]);
    }
    const acc = (row.acc ?? 0).toFixed(1);
    const spd = (row.spd ?? 0).toFixed(1);
    mk.bindPopup(
      `<b>${escapeHtml(row.tecnico || "Técnico")}</b><br>`+
      `Brigada: ${escapeHtml(row.brigada || "-")}<br>`+
      `Lat/Lng: ${lat.toFixed(6)}, ${lng.toFixed(6)}<br>`+
      `ACC: ${acc} | SPD: ${spd}`
    );
    state.lastRows.set(uid, row);
  }

  function renderList(){
    const ul = document.getElementById("brigList");
    if (!ul) return;
    ul.innerHTML = "";
    const rows = Array.from(state.lastRows.values());
    rows.sort((a,b)=> (a.brigada||"").localeCompare(b.brigada||""));
    for (const r of rows){
      const li = document.createElement("li");
      li.textContent = `${r.brigada || "-"} — ${r.tecnico || "Técnico"}`;
      ul.appendChild(li);
    }
  }

  // ---- Carga inicial ----
  async function loadDay(brigada, ymd){
    // calcula rango local Lima
    const d0 = new Date(`${ymd}T00:00:00-05:00`);
    const d1 = new Date(d0.getTime() + 24*60*60*1000);
    const ymdNext = ymdStr(d1);

    let q = supa.from("ubicaciones_brigadas")
      .select("id,usuario_id,tecnico,brigada,latitud,longitud,acc,spd,timestamp,timestamp_pe")
      .gte("timestamp_pe", ymd).lt("timestamp_pe", ymdNext)
      .order("timestamp_pe", { ascending: true });
    if (brigada && brigada.trim()){
      q = q.ilike("brigada", `%${brigada.trim()}%`);
    }

    const { data, error } = await q;
    if (error){ console.error(error); return; }

    // Limpia capa
    for (const mk of state.markers.values()) mk.remove();
    state.markers.clear();
    state.lastRows.clear();

    // Dibuja últimos por usuario
    const byUser = new Map();
    for (const r of (data || [])){
      const uid = String(r.usuario_id || r.tecnico || "0");
      byUser.set(uid, r);
    }
    for (const r of byUser.values()) upsertMarker(r);
    renderList();

    // Centra si hay puntos
    if (data && data.length){
      const last = data[data.length - 1];
      state.map.setView([last.latitud, last.longitud], 14);
    }
  }

  // ---- Realtime (opcional) ----
  function wireRealtime(brigada){
    try {
      const channel = supa.channel("realtime:ubicaciones")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" }, payload => {
          const r = payload.new;
          if (!r) return;
          if (brigada && brigada.trim() && !(r.brigada||"").toLowerCase().includes(brigada.trim().toLowerCase())) return;
          upsertMarker(r);
          renderList();
        })
        .subscribe();
      // Nota: si no usas Supabase Realtime, puedes comentar esto.
    } catch (e) {
      console.warn("Realtime no disponible:", e);
    }
  }

  // ---- Mapbox Map Matching + KMZ ----
  const MAPBOX_MATCH_URL = "https://api.mapbox.com/matching/v5/mapbox/driving";
  const MAX_MM_POINTS = 90;   // seguro < 100
  const REQ_DELAY_MS = 900;   // respeta rate limit
  const MAX_RETRIES = 3;

  async function fetchWithRetry(url, init = {}, maxRetries = MAX_RETRIES){
    let wait = 500;
    for (let i=0; i<=maxRetries; i++){
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (i === maxRetries) return res;
      await sleep(wait);
      wait *= 2;
    }
  }

  function chunkWithOverlap(arr, size, overlap = 1){
    if (arr.length <= size) return [arr];
    const blocks = [];
    for (let i = 0; i < arr.length; i += (size - overlap)) {
      const slice = arr.slice(i, i + size);
      blocks.push(slice);
      if (i + size >= arr.length) break;
    }
    return blocks;
  }

  async function getPointsForBrigadaDate(brigada, fechaYMD){
    const ymd = ymdStr(fechaYMD);
    const d0 = new Date(`${ymd}T00:00:00-05:00`);
    const d1 = new Date(d0.getTime() + 24*60*60*1000);
    const ymdNext = ymdStr(d1);

    let q = supa.from("ubicaciones_brigadas")
      .select("usuario_id,tecnico,brigada,latitud,longitud,acc,spd,timestamp,timestamp_pe")
      .gte("timestamp_pe", ymd).lt("timestamp_pe", ymdNext)
      .order("timestamp_pe", { ascending: true });
    if (brigada && brigada.trim()){
      q = q.ilike("brigada", `%${brigada.trim()}%`);
    }
    const { data, error } = await q;
    if (error) throw error;

    return (data || [])
      .filter(r => typeof r.latitud === "number" && typeof r.longitud === "number")
      .map(r => ({
        lat: r.latitud, lng: r.longitud,
        ts: r.timestamp_pe || r.timestamp,
        tecnico: r.tecnico, usuario_id: r.usuario_id, brigada: r.brigada,
        acc: r.acc, spd: r.spd
      }));
  }

  async function mapMatchBlocks(points, token){
    const blocks = chunkWithOverlap(points, MAX_MM_POINTS, 1);
    const out = [];
    for (let i = 0; i < blocks.length; i++){
      const b = blocks[i];
      if (b.length < 2) continue;
      const coords = b.map(p => `${p.lng},${p.lat}`).join(";");
      // timestamps ayudan al matching
      const tsArr = b.map(p => {
        const t = (typeof p.ts === "string") ? new Date(p.ts) :
                  (p.ts instanceof Date ? p.ts : null);
        return t ? Math.floor(t.getTime()/1000) : null;
      });
      const hasAllTs = tsArr.every(x => Number.isInteger(x));
      const tsParam = hasAllTs ? `&timestamps=${tsArr.join(";")}` : "";

      const url = `${MAPBOX_MATCH_URL}/${coords}?access_token=${encodeURIComponent(token)}&geometries=geojson&overview=full&steps=false&tidy=true${tsParam}`;
      const res = await fetchWithRetry(url);
      if (!res.ok){
        console.warn("Mapbox match fallo", i+1, "/", blocks.length, await res.text());
      } else {
        const json = await res.json();
        const best = (json && Array.isArray(json.matchings) && json.matchings[0]) ? json.matchings[0] : null;
        if (best && best.geometry && best.geometry.type === "LineString"){
          out.push(best.geometry);
        }
      }
      if (i < blocks.length - 1) await sleep(REQ_DELAY_MS);
    }
    return out;
  }

  function mergeLineStrings(lineStrings){
    const coords = [];
    for (const ls of lineStrings){
      if (!ls || !Array.isArray(ls.coordinates)) continue;
      if (coords.length === 0){
        coords.push(...ls.coordinates);
      } else {
        const last = coords[coords.length - 1];
        const firstNext = ls.coordinates[0];
        const isSame =
          last && firstNext &&
          Math.abs(last[0]-firstNext[0]) < 1e-10 &&
          Math.abs(last[1]-firstNext[1]) < 1e-10;
        coords.push(...(isSame ? ls.coordinates.slice(1) : ls.coordinates));
      }
    }
    return { type: "LineString", coordinates: coords };
  }

  function buildKmlFromLineString(lineString, opts = {}){
    const {
      name = "Recorrido brigada",
      description = "",
      lineColorAABBGGRR = "ff0000FF", // rojo (aabbggrr)
      lineWidth = 4
    } = opts;
    const coordStr = (lineString.coordinates || []).map(c => `${c[0]},${c[1]}`).join(" ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escapeHtml(name)}</name>
  <description>${escapeHtml(description)}</description>
  <Style id="routeStyle">
    <LineStyle>
      <color>${lineColorAABBGGRR}</color>
      <width>${lineWidth}</width>
    </LineStyle>
  </Style>
  <Placemark>
    <name>${escapeHtml(name)}</name>
    <styleUrl>#routeStyle</styleUrl>
    <LineString>
      <tessellate>1</tessellate>
      <coordinates>${coordStr}</coordinates>
    </LineString>
  </Placemark>
</Document>
</kml>`;
  }

  async function downloadKmz(filename, kmlString){
    const zip = new JSZip();
    zip.file("doc.kml", kmlString);
    const blob = await zip.generateAsync({
      type:"blob",
      compression:"DEFLATE",
      compressionOptions:{level:4}
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename.endsWith(".kmz") ? filename : `${filename}.kmz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  async function exportKmzForBrigadaFecha(brigada, fechaYMD){
    try {
      if (!MAPBOX_TOKEN || !MAPBOX_TOKEN.startsWith("pk.")){
        alert("Configura MAPBOX_TOKEN público (pk.*) en config.js");
        return;
      }
      const bName = (brigada||"").trim();
      if (!bName){ alert("Ingresa/selecciona una brigada"); return; }
      const ymd = ymdStr(fechaYMD || new Date());

      const pts = await getPointsForBrigadaDate(bName, ymd);
      if (!pts.length){ alert(`No hay puntos para ${bName} en ${ymd}`); return; }

      const matched = await mapMatchBlocks(pts, MAPBOX_TOKEN);
      if (!matched.length){ alert("No se pudo map-matchear la ruta."); return; }

      const merged = mergeLineStrings(matched);
      const kml = buildKmlFromLineString(merged, {
        name: `Recorrido ${bName} - ${ymd}`,
        description: `Ruta ajustada a pistas con Mapbox (brigada ${bName}, fecha ${ymd}).`,
        lineColorAABBGGRR: "ff0000FF",
        lineWidth: 4
      });
      await downloadKmz(`recorrido_${bName.toLowerCase().replace(/\s+/g,"_")}_${ymd}.kmz`, kml);
    } catch (e){
      console.error(e);
      alert("Error exportando KMZ (ver consola).");
    }
  }

  // ---- UI wiring ----
  function wireUI(){
    const inpB = document.getElementById("brigadaFilter");
    const inpD = document.getElementById("fechaFilter");
    const btnApply = document.getElementById("applyFilters");
    const btnKmz = document.getElementById("exportKmzBtn");

    if (inpD && !inpD.value) {
      const today = ymdStr(new Date());
      inpD.value = today;
    }

    btnApply?.addEventListener("click", async () => {
      const b = inpB?.value || "";
      const d = inpD?.value || ymdStr(new Date());
      await loadDay(b, d);
    });

    btnKmz?.addEventListener("click", async () => {
      const b = inpB?.value || "";
      const d = inpD?.value || ymdStr(new Date());
      await exportKmzForBrigadaFecha(b, d);
    });
  }

  // ---- Arranque ----
  window.addEventListener("load", async () => {
    initMap();
    wireUI();
    const b = document.getElementById("brigadaFilter")?.value || "";
    const d = document.getElementById("fechaFilter")?.value || ymdStr(new Date());
    await loadDay(b, d);
    wireRealtime(b);
  });
})();
