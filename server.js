// server.js
// Ejecuta: npm start
// Requiere: express ws dotenv @supabase/supabase-js

const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Supabase ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- Middlewares ----
app.use(express.json());
app.use(
  express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true })
);

// ---- HTTP + WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Memoria temporal en RAM
const ubicaciones = {}; // {id: {lat,lng,meta,ts,hist:[]}}

function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ WS conectado: ${ip}`);

  // Snapshot inicial
  if (Object.keys(ubicaciones).length > 0) {
    ws.send(JSON.stringify({
      type: "snapshot",
      data: Object.fromEntries(
        Object.entries(ubicaciones).map(([id, v]) => [
          id, { lat: v.lat, lng: v.lng, ts: v.ts, meta: v.meta }
        ])
      )
    }));
  }

  ws.on("close", () => console.log("❌ WS desconectado"));
});

// Limpieza de WS inactivos
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(interval));

// ===================================================
//  LOGIN Y RECEPCIÓN DE POSICIONES DESDE LOS TÉCNICOS
// ===================================================

// /api/login -> valida credenciales
app.post("/api/login", async (req, res) => {
  try {
    const { usuario, clave } = req.body;
    const { data, error } = await supabase
      .from("usuarios_brigadas")
      .select("*")
      .eq("usuario", usuario)
      .eq("clave", clave)
      .eq("activo", true)
      .single();

    if (error || !data)
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });

    const { clave: _, ...safe } = data;
    res.json({ ok: true, usuario: safe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// /api/posicion -> guarda ubicación y emite broadcast
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng, acc, spd } = req.body;

    // Inserta en Supabase
    const row = {
      usuario_id, tecnico, brigada, contrata, zona, cargo,
      latitud: lat, longitud: lng
    };
    const { error } = await supabase.from("ubicaciones_brigadas").insert(row);
    if (error) throw error;

    // Actualiza en memoria
    const id = `u${usuario_id}`;
    const meta = { display: tecnico || brigada || `ID ${usuario_id}`, brigada, zona, contrata, cargo };
    const ts = Date.now();

    if (!ubicaciones[id]) ubicaciones[id] = { hist: [] };
    ubicaciones[id].lat = lat;
    ubicaciones[id].lng = lng;
    ubicaciones[id].meta = meta;
    ubicaciones[id].ts = ts;
    ubicaciones[id].hist.push({ lat, lng, ts, meta });
    if (ubicaciones[id].hist.length > 50) ubicaciones[id].hist.shift();

    // Broadcast WS
    const payload = JSON.stringify({
      type: "point",
      data: { id, lat, lng, ts, meta }
    });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));

    res.json({ ok: true });
  } catch (e) {
    console.error("Error guardando ubicación:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===================================================
//   ENDPOINTS PARA MAPA Y FILTROS
// ===================================================

// /api/ubicaciones -> snapshot actual
app.get("/api/ubicaciones", (req, res) => {
  const data = Object.entries(ubicaciones).map(([id, v]) => ({
    id,
    lat: v.lat,
    lng: v.lng,
    zona: v.meta?.zona,
    contrata: v.meta?.contrata,
    brigada: v.meta?.brigada,
    meta: v.meta
  }));
  res.json({ ok: true, data });
});

// /api/recorridos -> histórico reciente (3h)
app.get("/api/recorridos", (req, res) => {
  const { zona, contrata, brigada } = req.query;
  const ahora = Date.now();
  const data = {};

  for (const [id, v] of Object.entries(ubicaciones)) {
    const arr = (v.hist || []).filter(p => ahora - p.ts < 3 * 60 * 60 * 1000);
    if (!arr.length) continue;

    if (zona && v.meta?.zona !== zona) continue;
    if (contrata && v.meta?.contrata !== contrata) continue;
    if (brigada && v.meta?.brigada !== brigada) continue;

    data[id] = arr;
  }

  res.json({ ok: true, data });
});

// ===================================================
// ARRANQUE
// ===================================================
server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});
