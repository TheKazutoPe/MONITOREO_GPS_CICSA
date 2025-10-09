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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const lastPos = new Map();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(data);
  });
  console.log(`📡 Enviado a ${wss.clients.size} clientes`);
}

function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ WS conectado: ${ip}`);

  if (lastPos.size) {
    const snap = {};
    for (const [id, p] of lastPos.entries()) {
      snap[id] = { lat: p.lat, lng: p.lng, ts: p.ts, meta: p.meta };
    }
    ws.send(JSON.stringify({ type: "snapshot", data: snap }));
  }

  ws.on("close", () => console.log("❌ WS desconectado"));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// --- API DE POSICIÓN ---
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng } = req.body;

    const row = { usuario_id, tecnico, brigada, contrata, zona, cargo, latitud: lat, longitud: lng };
    const { error } = await supabase.from("ubicaciones_brigadas").insert(row);
    if (error) throw error;

    const wid = `u${usuario_id}`;
    const display = tecnico || brigada || `ID ${usuario_id}`;
    const ts = Date.now();

    const meta = { display, brigada, zona, contrata, cargo };
    lastPos.set(wid, { lat, lng, ts, meta });

    broadcast({ type: "point", data: { id: wid, lat, lng, ts, meta } });
    res.json({ ok: true });
  } catch (e) {
    console.error("Error guardando ubicación:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});
