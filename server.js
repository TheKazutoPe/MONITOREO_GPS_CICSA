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
    ws.send(JSON.stringify({ type: "snapshot", data: snap }));
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

    const { clave: _, ...safe } = data;
    res.json({ ok: true, usuario: safe });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /api/posicion
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng } = req.body;

    // Guardar en Supabase
    const row = {
      usuario_id, tecnico, brigada, contrata, zona, cargo,
      latitud: lat, longitud: lng, timestamp: new Date().toISOString()
    };
    const { error } = await supabase.from("ubicaciones_brigadas").insert(row);
    if (error) console.warn("Supabase insert error:", error.message);

    // Guardar en memoria
    const id = `u${usuario_id}`;
    const display = tecnico || brigada || `ID ${usuario_id}`;
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

// ======================================================
// ENDPOINTS PARA MAPA Y FILTROS
// ======================================================

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

    if (req.query.zona) q = q.eq("zona", req.query.zona);
    if (req.query.contrata) q = q.eq("contrata", req.query.contrata);
    if (req.query.brigada) q = q.eq("brigada", req.query.brigada);

    const { data, error } = await q;
    if (error) throw error;

    const grouped = {};
    for (const r of data) {
      if (!r.latitud || !r.longitud) continue;
      const id = `u${r.usuario_id}`;
      (grouped[id] ||= []).push({
        lat: r.latitud,
        lng: r.longitud,
        ts: new Date(r.timestamp || Date.now()).getTime(),
        meta: {
          display: r.tecnico || r.brigada || `ID ${r.usuario_id}`,
          brigada: r.brigada,
          zona: r.zona,
          contrata: r.contrata
        }
      });
    }
    res.json({ ok: true, data: grouped });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /api/conectados
app.get("/api/conectados", (req, res) => {
  const now = Date.now();
  const activos = [];
  for (const [id, p] of lastPos.entries()) {
    if (now - (p.ts || 0) < 60000)
      activos.push({
        id,
        lat: p.lat,
        lng: p.lng,
        meta: {
          display: p.display,
          brigada: p.brigada,
          zona: p.zona,
          contrata: p.contrata,
          cargo: p.cargo
        }
      });
  }
  res.json({ ok: true, data: activos });
});

// Arranque
server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});
