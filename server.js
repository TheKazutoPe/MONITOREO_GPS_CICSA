// server.js
// npm start  |  requiere: express, ws, dotenv, @supabase/supabase-js
const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Supabase (server-side, service role) ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- Middlewares ----
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

// ---- HTTP server & WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Últimas posiciones en RAM para "snapshot" de clientes nuevos
const lastPos = new Map();

// Validación básica de payload de posición
function asPos(msg) {
  if (!msg || msg.type !== "pos") return null;
  const { id, lat, lng, acc, spd, ts } = msg;
  if (typeof id !== "string") return null;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    type: "pos", id, lat, lng,
    acc: typeof acc === "number" ? acc : undefined,
    spd: typeof spd === "number" ? spd : undefined,
    ts: typeof ts === "number" ? ts : Date.now(),
  };
}

function heartbeat() { this.isAlive = true; }

// ---- WS: conexión/broadcast ----
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ WS conectado: ${ip}`);

  // Snapshot inicial: últimas posiciones conocidas
  if (lastPos.size) {
    ws.send(JSON.stringify({ type: "snapshot", data: Object.fromEntries(lastPos) }));
  }

  ws.on("message", async (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }

    // Canal POS directo (opcional; la app móvil normalmente usará /api/posicion)
    const pos = asPos(parsed);
    if (!pos) return;

    lastPos.set(pos.id, { lat: pos.lat, lng: pos.lng, acc: pos.acc, spd: pos.spd, ts: pos.ts });
    const payload = JSON.stringify({ type: "point", data: pos });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));
  });

  ws.on("close", () => console.log("❌ WS desconectado"));
});

// Ping/pong para limpiar clientes caídos
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

// ----------------------------------------------------
//  API REST: login + guarda posición + consulta datos
// ----------------------------------------------------

// Login simple contra Supabase (usuario/clave creados por ti en Supabase)
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
    // No devolvemos la clave
    const { clave: _omit, ...safe } = data;
    res.json({ ok: true, usuario: safe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// Guarda posición en Supabase y hace broadcast por WS
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng, acc, spd } = req.body;

    // 1) Guardar en DB
    const { error } = await supabase.from("ubicaciones_brigadas").insert({
      usuario_id, tecnico, brigada, contrata, zona, cargo,
      latitud: lat, longitud: lng, acc, spd
    });
    if (error) throw error;

    // 2) Actualizar "lastPos" y broadcast
    const id = `${brigada || tecnico || usuario_id}`;
    const pos = { type: "pos", id, lat, lng, acc, spd, ts: Date.now() };
    lastPos.set(id, { lat, lng, acc, spd, ts: pos.ts });
    const payload = JSON.stringify({ type: "point", data: pos });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));

    res.json({ ok: true });
  } catch (e) {
    console.error("Error guardando ubicación:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Listado de últimas ubicaciones (para mapa)
app.get("/api/ubicaciones", async (req, res) => {
  try {
    const { zona, contrata, cargo, brigada } = req.query;
    let q = supabase.from("ubicaciones_brigadas").select("*").order("timestamp", { ascending: false }).limit(500);
    if (zona) q = q.eq("zona", zona);
    if (contrata) q = q.eq("contrata", contrata);
    if (cargo) q = q.eq("cargo", cargo);
    if (brigada) q = q.eq("brigada", brigada);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});
