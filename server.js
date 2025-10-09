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
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

// ---- HTTP + WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Últimas posiciones
const lastPos = new Map();
function heartbeat() { this.isAlive = true; }

// Conexión WS
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  console.log("✅ WS conectado");

  if (lastPos.size) {
    const snap = {};
    for (const [id, p] of lastPos.entries()) {
      snap[id] = {
        lat: p.lat, lng: p.lng, ts: p.ts,
        meta: { display: p.display, brigada: p.brigada, zona: p.zona, contrata: p.contrata, cargo: p.cargo }
      };
    }
    ws.send(JSON.stringify({ type: "snapshot", data: snap }));
  }
});
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

// ---------------------------
//   ENDPOINTS API PRINCIPALES
// ---------------------------

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

    if (error || !data)
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });

    const { clave: _omit, ...safe } = data;
    res.json({ ok: true, usuario: safe });
  } catch (e) {
    console.error("Error login:", e);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// /api/posicion
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng } = req.body;

    const row = { usuario_id, tecnico, brigada, contrata, zona, cargo, latitud: lat, longitud: lng };
    const { error } = await supabase.from("ubicaciones_brigadas").insert(row);
    if (error) throw error;

    const wid = `u${usuario_id}`;
    const display = tecnico || brigada || `ID ${usuario_id}`;
    const ts = Date.now();

    lastPos.set(wid, { lat, lng, ts, display, brigada, zona, contrata, cargo });

    const payload = JSON.stringify({
      type: "point",
      data: { id: wid, lat, lng, ts, meta: { display, brigada, zona, contrata, cargo } }
    });

    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));
    console.log(`📡 Actualización enviada (${display})`);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error guardando ubicación:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------
//   FRONTEND (LOGIN y MAPA)
// ---------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/mapa", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mapa.html"));
});

// catch-all
app.get("*", (req, res) => {
  res.status(404).send("Ruta no encontrada");
});

// Arranque
server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});
