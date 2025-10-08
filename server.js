// server.js
// Ejecuta: npm start   (package.json debe tener "start": "node server.js")
// Requiere: npm i express ws

const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

// Estáticos (public/)
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h",
  etag: true,
}));

const server = http.createServer(app);

// ---- WebSocket en ruta /ws ----
const wss = new WebSocketServer({ server, path: "/ws" });

// Últimas posiciones por id
const lastPos = new Map();

// util: validación simple
function asPos(msg) {
  if (!msg || msg.type !== "pos") return null;
  const { id, lat, lng, acc, spd, ts } = msg;
  if (typeof id !== "string") return null;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    type: "pos",
    id,
    lat,
    lng,
    acc: typeof acc === "number" ? acc : undefined,
    spd: typeof spd === "number" ? spd : undefined,
    ts: typeof ts === "number" ? ts : Date.now(),
  };
}

// Heartbeat
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ WS conectado: ${ip}`);

  // Enviar snapshot inicial a este cliente
  if (lastPos.size) {
    ws.send(JSON.stringify({
      type: "snapshot",
      data: Object.fromEntries(lastPos),
    }));
  }

  ws.on("message", (data) => {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }

    const pos = asPos(parsed);
    if (!pos) return;

    // Guardar última posición
    lastPos.set(pos.id, { lat: pos.lat, lng: pos.lng, acc: pos.acc, spd: pos.spd, ts: pos.ts });

    // Broadcast a todos
    const payload = JSON.stringify({ type: "point", data: pos });
    wss.clients.forEach(c => c.readyState === 1 && c.send(payload));
  });

  ws.on("close", () => console.log("❌ WS desconectado"));
});

// Intervalo de ping para limpiar clientes caídos
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`🚀 HTTP en http://localhost:${PORT}`);
  console.log(`🔌 WS   en ws://localhost:${PORT}/ws`);
});
