/* main.js — versión corregida para trazo limpio incremental desde “ahora”
   Requisitos:
   - window.CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY, MAPBOX_TOKEN } (pk.*), MAPBOX_PROFILE (opcional)
   - Tabla rutas_brigadas_dia(fecha, brigada, usuario_id, line_geojson, puntos, distancia_km, bbox, created_at, updated_at)
   - UNIQUE(fecha, brigada), trigger set_updated_at()
*/

(() => {
  // =========================
  // Config & Constantes
  // =========================
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    MAPBOX_TOKEN,
    MAPBOX_PROFILE = "mapbox/driving",
  } = window.CONFIG || {};

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("[INIT] Faltan credenciales de Supabase en config.js");
  }
  if (!MAPBOX_TOKEN || !MAPBOX_TOKEN.startsWith("pk.")) {
    console.warn(
      "[INIT] MAPBOX_TOKEN no parece un token público (pk.*). Cámbialo en config.js para frontend."
    );
  }

  // Trazado arranca desde "ahora"
  const traceStartMs = Date.now();

  // Parámetros de limpieza / matching
  const SMALL_MOVE_M = 7; // radio para considerar “mismo rango” (jitter)
  const DWELL_WINDOW = 4; // # de puntos recientes para evaluar quietud
  const MAX_GAP_SEC = 120; // gap de desconexión; si se supera, se corta tramo
  const MAX_JUMP_M = 700; // salto espacial para cortar
  const MAX_MM_POINTS = 80; // por bloque al Map Matching (márgen para query)
  const ENDPOINT_TOL_M = 40; // tolerancia para unir colas y evitar “dientes”
  const CONFIDENCE_MIN = 0.3; // confianza mínima aceptable del matching
  const PER_BLOCK_DELAY_MS = 220; // respiro entre bloques para no saturar

  // =========================
  // Utilidades Geoespaciales
  // =========================
  function toRad(d) {
    return (d * Math.PI) / 180;
  }
  function haversineMeters(a, b) {
    // a={lat,lon}, b={lat,lon}
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bboxOfCoords(coords) {
    // coords: [[lon,lat],...]
    if (!coords.length) return null;
    let minLon = coords[0][0],
      minLat = coords[0][1],
      maxLon = coords[0][0],
      maxLat = coords[0][1];
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    return [minLon, minLat, maxLon, maxLat];
  }
  function kmOfCoords(coords) {
    let km = 0;
    for (let i = 1; i < coords.length; i++) {
      km += haversineMeters(
        { lat: coords[i - 1][1], lon: coords[i - 1][0] },
        { lat: coords[i][1], lon: coords[i][0] }
      );
    }
    return km / 1000;
  }

  // =========================
  // Supabase & Mapa
  // =========================
  const supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );

  // Leaflet
  const map = L.map("map", {
    center: [-12.0464, -77.0428], // Lima centro aprox.
    zoom: 12,
    worldCopyJump: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/">OSM</a> contributors',
  }).addTo(map);

  // Capa de marcadores y de líneas por brigada
  const markersByUser = new Map(); // key: usuario_id -> L.Marker
  const lineLayerByBrigada = new Map(); // key: brigada -> L.Polyline

  // =========================
  // Estado por Brigada
  // =========================
  // points: puntos CRUDOS recibidos desde traceStartMs
  // buffer: sub-arreglo incremental a enviar a Map Matching
  // clean: coords ya “matched” [[lon,lat],...]
  // lastTs, lastCleanIdx: control incremental
  const brigadas = new Map(); // key: brigada -> state

  function getOrCreateBrigadaState(brigada) {
    if (!brigadas.has(brigada)) {
      brigadas.set(brigada, {
        points: [],
        buffer: [],
        clean: [],
        lastTs: null,
        lastCleanIdx: 0,
        usuario_id: null,
      });
      console.log(`[STATE] Nueva brigada en memoria: ${brigada}`);
    }
    return brigadas.get(brigada);
  }

  // =========================
  // Suscripción Realtime — INSERT ubicaciones_brigadas
  // =========================
  async function subscribeRealtime() {
    console.log("[RT] Suscribiendo a inserts de ubicaciones_brigadas…");
    const channel = supabase
      .channel("rt-ubicaciones_brigadas")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ubicaciones_brigadas",
        },
        async (payload) => {
          try {
            const row = payload.new;
            // Campos esperados: brigada, usuario_id, latitud, longitud, accuracy, timestamp
            const ts = new Date(row.timestamp || row.created_at).getTime();
            if (ts < traceStartMs) {
              // ignorar histórico
              return;
            }

            const brigada = row.brigada || "SIN_BRIGADA";
            const usuarioId = row.usuario_id || row.usuario || null;
            const point = {
              lat: Number(row.latitud || row.lat || row.latitude),
              lon: Number(row.longitud || row.lon || row.longitude),
              acc: Number(row.accuracy || row.acc || 0),
              ts,
              usuarioId,
            };

            if (
              !isFinite(point.lat) ||
              !isFinite(point.lon) ||
              Math.abs(point.lat) < 0.0001 ||
              Math.abs(point.lon) < 0.0001
            ) {
              console.log(
                `[RT][${brigada}] Punto inválido ignorado:`,
                JSON.stringify(point)
              );
              return;
            }

            // Actualizar marker del usuario
            updateUserMarker(point, usuarioId, brigada);

            // Registrar en estado y evaluar si se agrega
            await onNewPoint(brigada, point);
          } catch (e) {
            console.error("[RT] Error manejando insert:", e);
          }
        }
      )
      .subscribe((status) => {
        console.log("[RT] Estado suscripción:", status);
      });
  }

  function updateUserMarker(point, usuarioId, brigada) {
    let marker = markersByUser.get(usuarioId);
    const ll = [point.lat, point.lon];
    if (!marker) {
      marker = L.marker(ll, {
        title: `${brigada} • ${usuarioId || "sin_usuario"}`,
      }).addTo(map);
      markersByUser.set(usuarioId, marker);
    } else {
      marker.setLatLng(ll);
    }
  }

  // =========================
  // Lógica de filtrado (dwell/jitter) y cortes
  // =========================
  function isWithinSmallRange(newPoint, lastPoint) {
    const d = haversineMeters(
      { lat: newPoint.lat, lon: newPoint.lon },
      { lat: lastPoint.lat, lon: lastPoint.lon }
    );
    return d <= SMALL_MOVE_M;
  }

  function looksLikeDwell(points) {
    // últimos DWELL_WINDOW puntos dentro del rango SMALL_MOVE_M
    if (points.length < DWELL_WINDOW) return false;
    const last = points[points.length - 1];
    for (let i = points.length - DWELL_WINDOW; i < points.length - 1; i++) {
      if (!isWithinSmallRange(points[i], last)) return false;
    }
    return true;
  }

  function hasBigGapOrJump(prev, curr) {
    const dt = (curr.ts - prev.ts) / 1000;
    if (dt > MAX_GAP_SEC) return true;
    const d = haversineMeters(
      { lat: prev.lat, lon: prev.lon },
      { lat: curr.lat, lon: curr.lon }
    );
    return d > MAX_JUMP_M;
  }

  // =========================
  // Pipeline: onNewPoint -> buffer -> Map Matching -> clean -> persist -> dibujar
  // =========================
  async function onNewPoint(brigada, p) {
    const st = getOrCreateBrigadaState(brigada);
    st.usuario_id = st.usuario_id || p.usuarioId;
    const pts = st.points;

    // Empuja punto crudo
    pts.push(p);

    // Descarta dwell/jitter repetitivo
    if (looksLikeDwell(pts)) {
      console.log(`[${brigada}] Punto descartado (dwell/jitter):`, p);
      return;
    }

    // Cortes por gap o salto
    if (pts.length >= 2) {
      const prev = pts[pts.length - 2];
      if (hasBigGapOrJump(prev, p)) {
        console.log(
          `[${brigada}] Corte de tramo por gap/jump. prev_ts=${new Date(
            prev.ts
          ).toLocaleTimeString()} curr_ts=${new Date(p.ts).toLocaleTimeString()}`
        );
        // Reinicia buffer para no forzar un “puente diagonal”
        st.buffer = [];
      }
    }

    // Agregar al buffer de matching
    st.buffer.push(p);

    // Cuando el buffer tenga suficientes puntos, procesar bloques
    if (st.buffer.length >= 3) {
      await processMatchingBlocks(brigada, st);
    }
  }

  async function processMatchingBlocks(brigada, st) {
    // Enviar el buffer en bloques seguros al Map Matching
    while (st.buffer.length >= 3) {
      const block = st.buffer.slice(0, Math.min(MAX_MM_POINTS, st.buffer.length));
      try {
        const matched = await mapMatchBlock(block);
        if (!matched || !matched.coords || matched.coords.length < 2) {
          console.log(`[${brigada}] Matching vacío o inválido, descarto bloque.`);
          // Eliminar al menos el primer punto para avanzar
          st.buffer.shift();
        } else {
          // Validar confianza
          if (matched.confidence < CONFIDENCE_MIN) {
            console.log(
              `[${brigada}] Confianza baja (${matched.confidence.toFixed(
                2
              )}), descarto bloque.`
            );
            st.buffer.shift();
          } else {
            // Unir con tolerancia de cola
            const beforeLen = st.clean.length;
            appendWithEndpointTolerance(st.clean, matched.coords, ENDPOINT_TOL_M);
            console.log(
              `[${brigada}] Matching OK: +${st.clean.length - beforeLen} vértices. conf=${matched.confidence.toFixed(
                2
              )}`
            );

            // Avanzar buffer (consumimos blockSize-1 para solapar suavemente)
            const consume = Math.max(1, block.length - 1);
            st.buffer.splice(0, consume);

            // Persistir a Supabase
            await persistCleanLine(brigada, st);
            // Redibujar capa
            drawCleanLine(brigada, st.clean);
          }
        }
      } catch (e) {
        console.error(`[${brigada}] Error map matching bloque:`, e);
        // Evitar loop infinito: descartar el primer punto del bloque y continuar
        st.buffer.shift();
      }
      await delay(PER_BLOCK_DELAY_MS);
    }
  }

  function appendWithEndpointTolerance(targetCoords, newCoords, tolMeters) {
    if (targetCoords.length === 0) {
      targetCoords.push(...newCoords);
      return;
    }
    // Si extremos quedan muy juntos, evita duplicar “dientes”
    const last = targetCoords[targetCoords.length - 1];
    const firstNew = newCoords[0];
    const d = haversineMeters(
      { lat: last[1], lon: last[0] },
      { lat: firstNew[1], lon: firstNew[0] }
    );
    if (d <= tolMeters) {
      // pega sin repetir el primero
      targetCoords.push(...newCoords.slice(1));
    } else {
      // Inicia tramo nuevo “virtual”: para LineString continuo, concatenamos igual
      // (si prefieres cortar visualmente, podrías insertar un salto lógico)
      targetCoords.push(...newCoords);
    }
  }

  async function mapMatchBlock(points) {
    // Construye query para Map Matching
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
    const timestamps = points.map((p) => Math.floor(p.ts / 1000)).join(",");
    // radius (en metros) por precision (accuracy). Limitar entre 5 y 50m
    const radiuses = points
      .map((p) => Math.min(50, Math.max(5, Math.round(p.acc || 15))))
      .join(";");

    const url =
      `https://api.mapbox.com/matching/v5/${MAPBOX_PROFILE}/${coords}` +
      `?geometries=geojson&tidy=true&steps=false&annotations=false` +
      `&timestamps=${timestamps}` +
      `&radiuses=${radiuses}` +
      `&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Mapbox MM HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.matchings || !data.matchings.length) {
      return null;
    }
    // Seleccionar la mejor por confianza
    data.matchings.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const best = data.matchings[0];
    return {
      coords: best.geometry.coordinates, // [[lon,lat],...]
      confidence: best.confidence || 0,
    };
  }

  async function persistCleanLine(brigada, st) {
    const coords = st.clean;
    if (!coords.length) return;

    // Calcular fecha (Lima -05:00)
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const fecha = `${y}-${m}-${d}`;

    const geom = {
      type: "LineString",
      coordinates: coords,
    };

    const payload = {
      fecha,
      brigada,
      usuario_id: st.usuario_id,
      line_geojson: geom,
      puntos: coords.length,
      distancia_km: Number(kmOfCoords(coords).toFixed(3)),
      bbox: bboxOfCoords(coords),
    };

    console.log(`[${brigada}] Persistiendo rutas_brigadas_dia…`, payload);

    // upsert por (fecha, brigada)
    const { error } = await supabase.from("rutas_brigadas_dia").upsert(payload, {
      onConflict: "fecha,brigada",
    });
    if (error) {
      console.error(`[${brigada}] Error persistiendo rutas_brigadas_dia:`, error);
    } else {
      console.log(
        `[${brigada}] Persistido OK: ${coords.length} vértices / ${payload.distancia_km} km`
      );
    }
  }

  function drawCleanLine(brigada, coords) {
    let layer = lineLayerByBrigada.get(brigada);
    const latlngs = coords.map((c) => [c[1], c[0]]);
    if (!layer) {
      layer = L.polyline(latlngs, { weight: 4, opacity: 0.9 });
      layer.addTo(map);
      lineLayerByBrigada.set(brigada, layer);
    } else {
      layer.setLatLngs(latlngs);
    }
    if (latlngs.length) {
      // opcional: centrar suave al último punto
      // map.panTo(latlngs[latlngs.length - 1], { animate: true, duration: 0.4 });
    }
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // =========================
  // Bootstrap
  // =========================
  async function init() {
    console.log(
      "%c[INIT]%c Trazado limpio empezará solo desde ahora.",
      "color:#fff;background:#111;padding:2px 4px;border-radius:3px;",
      "color:#0c0"
    );
    console.log(
      "[INIT] traceStart:",
      new Date(traceStartMs).toLocaleString(),
      "(Lima)"
    );
    await subscribeRealtime();

    // Nota: NO cargamos histórico (intencional).
    // Si quisieras “sembrar” 1-2 puntos recientes, podrías hacer una consulta con time >= traceStartMs-5s.
  }

  init();
})();
