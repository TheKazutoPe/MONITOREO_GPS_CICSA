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

// ---- Supabase (clave service role en Render) ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- Middlewares ----
app.use(express.json());
app.use(
  express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true })
);

// ---- HTTP server + WebSocket (/ws) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Últimas posiciones en RAM para snapshot y lista de conectados
// Map<idWS, {lat,lng,acc,spd,ts, display, brigada, zona, contrata, cargo}>
const lastPos = new Map();

function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ WS conectado: ${ip}`);

  // Enviar snapshot inicial con meta
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

  ws.on("message", (raw) => {
    // En este proyecto el cliente no envía POS por WS; se usa /api/posicion.
    // Si quisieras aceptar POS por WS, podrías parsearlo aquí.
  });

  ws.on("close", () => console.log("❌ WS desconectado"));
});

// Limpieza de clientes caídos
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(interval));

// --------------------------------------
// API: login, guardar posición, consultas
// --------------------------------------

// /api/login -> valida contra usuarios_brigadas
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
    const { clave: _omit, ...safe } = data; // no devolver clave
    res.json({ ok: true, usuario: safe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// /api/posicion -> guarda en DB y hace broadcast con id único por usuario
app.post("/api/posicion", async (req, res) => {
  try {
    const { usuario_id, tecnico, brigada, contrata, zona, cargo, lat, lng, acc, spd } = req.body;

    // 1) Inserta en Supabase
    const row = {
      usuario_id, tecnico, brigada, contrata, zona, cargo,
      latitud: lat, longitud: lng
    };
    if (typeof acc === "number") row.acc = acc;
    if (typeof spd === "number") row.spd = spd;

    const { error } = await supabase.from("ubicaciones_brigadas").insert(row);
    if (error) throw error;

    // 2) ID único estable por usuario
    const wid = `u${usuario_id}`;                 // <- clave única para WS/mapa
    const display = tecnico || brigada || `ID ${usuario_id}`;

    // 3) Actualiza snapshot y broadcast
    const ts = Date.now();
    lastPos.set(wid, { lat, lng, acc, spd, ts, display, brigada, zona, contrata, cargo });

    const payload = JSON.stringify({
      type: "point",
      data: {
        id: wid, lat, lng, ts,
        meta: { display, brigada, zona, contrata, cargo }
      }
    });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));

    res.json({ ok: true });
  } catch (e) {
    console.error("Error guardando ubicación:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /api/ubicaciones -> últimas posiciones (para listados puntuales)
app.get("/api/ubicaciones", async (req, res) => {
  try {
    const { zona, contrata, cargo, brigada } = req.query;
    let q = supabase
      .from("ubicaciones_brigadas")
      .select("*")
      .order("timestamp", { ascending: false })
      .limit(500);

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

// /api/recorridos -> histórico por ventana de tiempo para dibujar polylines
// GET /api/recorridos?minutes=180&zona=&contrata=&brigada=
app.get("/api/recorridos", async (req, res) => {
  try {
    const minutes = Math.max(5, Math.min(24 * 60, parseInt(req.query.minutes || "180", 10)));
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    let q = supabase
      .from("ubicaciones_brigadas")
      .select("usuario_id,tecnico,brigada,latitud,longitud,timestamp,contrata,zona")
      .gte("timestamp", since)
      .order("timestamp", { ascending: true });

    if (req.query.zona)     q = q.eq("zona", req.query.zona);
    if (req.query.contrata) q = q.eq("contrata", req.query.contrata);
    if (req.query.brigada)  q = q.eq("brigada", req.query.brigada);

    const { data, error } = await q;
    if (error) throw error;

    const grouped = {};
    for (const r of data) {
      const id = `u${r.usuario_id}`;
      (grouped[id] ||= []).push({
        lat: r.latitud,
        lng: r.longitud,
        ts:  new Date(r.timestamp).getTime(),
        meta: {
          display: r.brigada || r.tecnico || `ID ${r.usuario_id}`,
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

// /api/conectados -> últimos 60s desde snapshot
app.get("/api/conectados", (req, res) => {
  const out = [];
  const now = Date.now();
  for (const [id, p] of lastPos.entries()) {
    if ((now - (p.ts || 0)) < 60_000) {
      out.push({ id, ts: p.ts, lat: p.lat, lng: p.lng, meta: {
        display: p.display, brigada: p.brigada, zona: p.zona, contrata: p.contrata, cargo: p.cargo
      }});
    }
  }
  res.json({ ok: true, data: out });
});

// Arranque
server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});
