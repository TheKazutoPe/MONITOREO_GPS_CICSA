// server.js
// Autor: Kevin Layme / InsightPy Solutions
// Versión estable para Render (Monitoreo GPS CICSA)

const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 10000;

// === SUPABASE ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === MIDDLEWARE ===
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// === SERVIDOR HTTP + WS ===
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// === MEMORIA DE UBICACIONES ===
const ubicaciones = {}; // { usuario_id: { lat, lng, ts, meta, hist: [] } }

// === WS CONNECTION ===
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ Cliente WS conectado (${ip})`);

  // Enviar snapshot inicial
  if (Object.keys(ubicaciones).length > 0) {
    const snap = {};
    for (const [id, v] of Object.entries(ubicaciones)) {
      snap[id] = { lat: v.lat, lng: v.lng, ts: v.ts, meta: v.meta };
    }
    ws.send(JSON.stringify({ type: "snapshot", data: snap }));
  }

  ws.on("close", () => console.log("❌ WS desconectado"));
});

// Mantener WS activos
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ====================================================
// LOGIN Y UBICACIONES
// ====================================================

// /api/login
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

    if (error || !data) return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    const { clave: _omit, ...safe } = data;
    res.json({ ok: true, usuario: safe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// /api/posicion
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ ok: false, error: "Falta lat/lng" });

    // Guardar en Supabase
    const { error } = await supabase.from("ubicaciones_brigadas").insert({
      usuario_id, tecnico, brigada, contrata, zona, cargo,
      latitud: lat, longitud: lng
    });
    if (error) console.warn("Supabase error (ubicaciones):", error.message);

    // Actualizar en memoria
    const id = `u${usuario_id}`;
    const meta = { display: tecnico || brigada || `ID ${usuario_id}`, brigada, zona, contrata, cargo };
    const ts = Date.now();

    if (!ubicaciones[id]) ubicaciones[id] = { hist: [] };
    ubicaciones[id].lat = lat;
    ubicaciones[id].lng = lng;
    ubicaciones[id].ts = ts;
    ubicaciones[id].meta = meta;

    ubicaciones[id].hist.push({ lat, lng, ts, meta });
    if (ubicaciones[id].hist.length > 80) ubicaciones[id].hist.shift();

    // Broadcast a todos los clientes
    const msg = JSON.stringify({ type: "point", data: { id, lat, lng, ts, meta } });
    wss.clients.forEach(c => c.readyState === 1 && c.send(msg));

    res.json({ ok: true });
  } catch (e) {
    console.error("Error en /api/posicion:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================================================
// API PARA EL MAPA
// ====================================================

// /api/recorridos -> últimos 3h (para mapa.html)
app.get("/api/recorridos", (req, res) => {
  try {
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
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /api/ubicaciones -> snapshot de todos los técnicos
app.get("/api/ubicaciones", (req, res) => {
  const data = Object.entries(ubicaciones).map(([id, v]) => ({
    id,
    lat: v.lat,
    lng: v.lng,
    meta: v.meta
  }));
  res.json({ ok: true, data });
});

// ====================================================
// INICIO DEL SERVIDOR
// ====================================================
server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP en puerto ${PORT}`);
  console.log(`🔌 WebSocket en ws://localhost:${PORT}/ws`);
});
