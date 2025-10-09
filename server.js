const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Middlewares ---
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- WebSocket + memoria en vivo ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const lastPos = new Map();
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  // snapshot inicial
  const snap = {};
  for (const [id, p] of lastPos.entries()) {
    snap[id] = { lat: p.lat, lng: p.lng, ts: p.ts, meta: p.meta };
  }
  ws.send(JSON.stringify({ type: "snapshot", data: snap }));
  console.log("🔌 Cliente WS conectado");
});

// limpieza
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// --- API Login técnicos ---
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
    res.json({ ok: true, usuario: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- API para recibir posición del técnico ---
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng } = req.body;

    const { error } = await supabase
      .from("ubicaciones_brigadas")
      .insert({ usuario_id, tecnico, brigada, contrata, zona, cargo, latitud: lat, longitud: lng });
    if (error) throw error;

    const id = `u${usuario_id}`;
    const meta = { display: tecnico || brigada, brigada, contrata, zona, cargo };
    const ts = Date.now();

    lastPos.set(id, { lat, lng, ts, meta });
    const payload = JSON.stringify({ type: "point", data: { id, lat, lng, ts, meta } });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Rutas frontend ---
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/mapa", (req, res) => res.sendFile(path.join(__dirname, "public", "mapa.html")));

server.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`🛰 WS listo en ws://localhost:${PORT}/ws`);
});
