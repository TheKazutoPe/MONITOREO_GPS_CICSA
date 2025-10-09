// server.js - Monitoreo GPS CICSA (versión estable)
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
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// === SERVIDOR HTTP + WS ===
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// === MEMORIA EN VIVO ===
const lastPos = new Map();

// === Helper: fecha/hora de Lima (UTC-5) en ISO ===
function nowLimaISO() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Lima" })
  ).toISOString();
}

function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ WS conectado: ${ip}`);

  // Snapshot inicial
  if (lastPos.size) {
    const snap = {};
    for (const [id, p] of lastPos.entries()) {
      snap[id] = {
        lat: p.lat,
        lng: p.lng,
        ts: p.ts,
        meta: {
          display: p.display,
          brigada: p.brigada,
          zona: p.zona,
          contrata: p.contrata,
          cargo: p.cargo
        }
      };
    }
    try {
      ws.send(JSON.stringify({ type: "snapshot", data: snap }));
    } catch (e) {}
  }

  ws.on("close", () => console.log("❌ WS desconectado"));
});

// Limpieza de WS inactivos
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ======================================================
// LOGIN Y POSICIONES
// ======================================================

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

    res.json({
      ok: true,
      usuario: {
        id: data.id,
        tecnico: data.tecnico,
        brigada: data.brigada,
        contrata: data.contrata,
        zona: data.zona,
        cargo: data.cargo,
        display: data.tecnico || data.usuario || `ID ${data.id}`
      }
    });
  } catch (e) {
    console.error("Error en /api/login:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /api/posicion
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng } = req.body || {};

    if (typeof usuario_id !== "number" || typeof lat !== "number" || typeof lng !== "number")
      return res.status(400).json({ ok: false, error: "Parámetros inválidos" });

    // Guardar en Supabase
    const row = {
      usuario_id, tecnico, brigada, contrata, zona, cargo,
      latitud: lat, longitud: lng, timestamp: nowLimaISO()
    };
    const { error } = await supabase.from("ubicaciones_brigadas").insert(row);
    if (error) console.warn("Supabase insert error:", error.message);

    // Memoria y broadcast
    const id = `u${usuario_id}`;
    const display = tecnico || `ID ${usuario_id}`;
    const ts = Date.now();

    lastPos.set(id, { lat, lng, ts, display, brigada, zona, contrata, cargo });

    // Broadcast WS
    const payload = JSON.stringify({
      type: "point",
      data: { id, lat, lng, ts, meta: { display, brigada, zona, contrata, cargo } }
    });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));

    res.json({ ok: true });
  } catch (e) {
    console.error("Error en /api/posicion:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ======================================
// ENDPOINTS PARA MAPA Y FILTROS
// ======================================

// /api/recorridos
app.get("/api/recorridos", async (req, res) => {
  try {
    const minutes = Math.max(5, Math.min(24 * 60, parseInt(req.query.minutes || "180", 10)));
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    let q = supabase
      .from("ubicaciones_brigadas")
      .select("usuario_id,tecnico,brigada,latitud,longitud,timestamp,contrata,zona")
      .gte("timestamp", since)
      .order("timestamp", { ascending: true });

    const { contrata, zona } = req.query;
    if (contrata) q = q.eq("contrata", contrata);
    if (zona) q = q.eq("zona", zona);

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const tracks = {};
    for (const r of data || []) {
      const id = `u${r.usuario_id}`;
      if (!tracks[id]) tracks[id] = [];
      tracks[id].push({
        lat: r.latitud,
        lng: r.longitud,
        ts: new Date(r.timestamp).getTime(),
        meta: {
          display: r.tecnico || `ID ${r.usuario_id}`,
          brigada: r.brigada,
          zona: r.zona,
          contrata: r.contrata
        }
      });
    }
    res.json({ ok: true, data: tracks });
  } catch (e) {
    console.error("Error en /api/recorridos:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /api/conectados – activos (último minuto)
app.get("/api/conectados", async (_req, res) => {
  const now = Date.now();
  const activos = [];
  for (const [id, p] of lastPos.entries()) {
    if (now - (p.ts || 0) < 60000)
      activos.push({
        id,
        lat: p.lat,
        lng: p.lng,
        ts: p.ts,
        display: p.display,
        meta: {
          brigada: p.brigada,
          zona: p.zona,
          contrata: p.contrata,
          cargo: p.cargo
        }
      });
  }
  res.json({ ok: true, data: activos });
});

// === NUEVO: detener transmisión de un usuario ===
app.post("/api/stop", async (req, res) => {
  try {
    const { usuario_id } = req.body || {};
    if (!usuario_id) return res.status(400).json({ ok: false, error: "usuario_id requerido" });

    const id = `u${usuario_id}`;

    const existed = lastPos.delete(id);

    const payload = JSON.stringify({ type: "remove", data: { id } });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));

    return res.json({ ok: true, removed: !!existed });
  } catch (e) {
    console.error("Error en /api/stop:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Arranque
server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});

