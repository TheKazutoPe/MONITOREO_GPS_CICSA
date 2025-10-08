// server.js (primeras líneas)
// Cargar .env SOLO si no vienen variables del entorno (local)
if (!process.env.SUPABASE_URL) {
  try { require('dotenv').config(); } catch {}
}


// server.js
// npm i express ws @supabase/supabase-js adm-zip
require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");
const AdmZip = require("adm-zip");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const PORT = process.env.PORT || 3000;

// archivos estáticos
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Supabase con SERVICE KEY (solo en el servidor)
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Últimas posiciones en RAM para el snapshot de los viewers
const lastPos = new Map(); // user_id -> { lat,lng,ts, track_id }

// Validación de payload "pos"
function asPos(m) {
  if (!m || m.type !== "pos") return null;
  const { track_id, lat, lng, acc, spd, ts } = m;
  if (!track_id || typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    track_id,
    lat,
    lng,
    acc: typeof acc === "number" ? acc : null,
    spd: typeof spd === "number" ? spd : null,
    ts: typeof ts === "number" ? ts : Date.now(),
  };
}

// Upgrade de WS: validamos token Supabase y “colgamos” user en la conexión
server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/ws") return socket.destroy();
    const token = url.searchParams.get("token");
    if (!token) return socket.destroy();

    const { data, error } = await supa.auth.getUser(token);
    if (error || !data?.user) return socket.destroy();

    req.user = data.user;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = data.user;
      wss.emit("connection", ws, req);
    });
  } catch {
    try { socket.destroy(); } catch {}
  }
});

function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  // snapshot inicial
  if (lastPos.size) {
    ws.send(JSON.stringify({ type: "snapshot", data: Object.fromEntries(lastPos) }));
  }

  ws.on("message", async (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }

    // A) crear track
    if (m.type === "start") {
      const ins = await supa.from("tracks").insert({ user_id: ws.user.id }).select("id, started_at").single();
      if (ins.error) return ws.send(JSON.stringify({ type: "err", msg: ins.error.message }));
      return ws.send(JSON.stringify({ type: "ack", what: "start", track_id: ins.data.id, started_at: ins.data.started_at }));
    }

    // B) guardar y difundir posición
    if (m.type === "pos") {
      const p = asPos(m);
      if (!p) return;
      const ins = await supa.from("positions").insert({
        track_id: p.track_id, user_id: ws.user.id,
        lat: p.lat, lng: p.lng, acc: p.acc, spd: p.spd,
        ts: new Date(p.ts).toISOString()
      });
      if (ins.error) return ws.send(JSON.stringify({ type: "err", msg: ins.error.message }));

      lastPos.set(ws.user.id, { user_id: ws.user.id, track_id: p.track_id, lat: p.lat, lng: p.lng, ts: p.ts });

      const payload = JSON.stringify({ type: "point", data: { user_id: ws.user.id, track_id: p.track_id, lat: p.lat, lng: p.lng, ts: p.ts } });
      wss.clients.forEach(c => c.readyState === 1 && c.send(payload));
      return;
    }

    // C) cerrar track
    if (m.type === "stop") {
      const { track_id } = m;
      if (!track_id) return;
      const up = await supa.from("tracks").update({ ended_at: new Date().toISOString() })
        .eq("id", track_id).eq("user_id", ws.user.id);
      if (up.error) return ws.send(JSON.stringify({ type: "err", msg: up.error.message }));
      return ws.send(JSON.stringify({ type: "ack", what: "stop", track_id }));
    }
  });

  ws.on("close", () => {});
});

// limpieza de websockets caídos
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(interval));

// --------- APIs ---------

// Brigadas activas hoy
app.get("/api/active-today", async (req, res) => {
  const start = new Date(); start.setHours(0,0,0,0);
  const q = await supa
    .from("tracks")
    .select("id,user_id,started_at,ended_at, technicians!inner(username,brigada,contrata,zona)")
    .gte("started_at", start.toISOString());
  if (q.error) return res.status(500).json({ error: q.error.message });
  res.json({ tracks: q.data });
});

// Export KMZ (Authorization: Bearer <token>)
app.get("/api/track/:id.kmz", async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\\s+/i, "");
  const { data: auth } = await supa.auth.getUser(token);
  if (!auth?.user) return res.sendStatus(401);
  const trackId = +req.params.id;

  const tr = await supa.from("tracks").select("id,user_id,started_at,ended_at").eq("id", trackId).single();
  if (tr.error || !tr.data) return res.sendStatus(404);

  const me = await supa.from("technicians").select("role").eq("user_id", auth.user.id).single();
  const isSup = me.data?.role === "supervisor" || me.data?.role === "admin";
  if (!isSup && tr.data.user_id !== auth.user.id) return res.sendStatus(403);

  const pts = await supa.from("positions").select("lat,lng,ts").eq("track_id", trackId).order("ts", { ascending: true });
  if (pts.error) return res.status(500).send(pts.error.message);

  const coords = (pts.data || []).map(p => `${p.lng},${p.lat},0`).join(" ");
  const startP = pts.data?.[0], endP = pts.data?.[pts.data.length-1];

  const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <name>Track ${trackId}</name>
    <Style id="line"><LineStyle><color>ff0055ff</color><width>4</width></LineStyle></Style>
    <Placemark><name>Recorrido</name><styleUrl>#line</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
    </Placemark>
    ${startP ? `<Placemark><name>Inicio</name><Point><coordinates>${startP.lng},${startP.lat},0</coordinates></Point></Placemark>` : ""}
    ${endP ? `<Placemark><name>Fin</name><Point><coordinates>${endP.lng},${endP.lat},0</coordinates></Point></Placemark>` : ""}
  </Document></kml>`;

  const zip = new AdmZip();
  zip.addFile("doc.kml", Buffer.from(kml, "utf8"));
  const buf = zip.toBuffer();
  res.setHeader("Content-Type", "application/vnd.google-earth.kmz");
  res.setHeader("Content-Disposition", `attachment; filename="track_${trackId}.kmz"`);
  res.end(buf);
});

server.listen(PORT, () => {
  console.log(`HTTP : http://0.0.0.0:${PORT}`);
  console.log(`WS   : ws://0.0.0.0:${PORT}/ws?token=...`);
});
