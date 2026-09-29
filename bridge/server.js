// Tiny local bridge server.
//
//   AI/backend --HTTP POST /command--> [this server] --WebSocket--> Figma plugin UI
//
// One plugin connection at a time (v0.1). Correlates request/response by id
// and resolves the pending HTTP request when the matching reply arrives.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = 8787;
const REQUEST_TIMEOUT_MS = 30000;
const EXPORTS_DIR = path.join(__dirname, "..", "exports");
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

let pluginSocket = null;
const pending = new Map(); // id -> { resolve, reject, timer }

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/command") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
        return;
      }

      if (!pluginSocket) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "No Figma plugin connected. Open the file and run the plugin." }));
        return;
      }

      const id = crypto.randomUUID();
      const command = { id, type: payload.type, params: payload.params || {} };

      const resultPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Timed out waiting for plugin response"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
      });

      log("-> plugin:", command.type, id);
      pluginSocket.send(JSON.stringify(command));

      try {
        const result = await resultPromise;

        // Any command whose result carries a base64 payload (currently
        // just EXPORT_NODE, but the bridge doesn't need to know that by
        // name) gets written to disk instead of dumped as a huge blob over
        // HTTP. Extension follows the requested format (PNG/JPG/SVG/PDF).
        // This is transport concern (large binary handling), not a Figma
        // capability, so it stays keyed off shape, not command type.
        if (result.ok && result.result && typeof result.result.base64 === "string") {
          const ext = (result.result.format || "png").toLowerCase();
          const fileName = `${(payload.params && payload.params.id) || command.id}.${ext}`.replace(/[:]/g, "_");
          const filePath = path.join(EXPORTS_DIR, fileName);
          fs.writeFileSync(filePath, Buffer.from(result.result.base64, "base64"));
          result.result = { path: filePath, width: result.result.width, height: result.result.height };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pluginConnected: !!pluginSocket }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  log("plugin connected");
  pluginSocket = socket;

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      log("bad json from plugin:", raw.toString());
      return;
    }

    if (msg.type === "__hello__") {
      log("hello from plugin:", msg.role);
      return;
    }

    const entry = pending.get(msg.id);
    if (!entry) {
      log("no pending request for id", msg.id);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg);
  });

  socket.on("close", () => {
    log("plugin disconnected");
    if (pluginSocket === socket) pluginSocket = null;
  });
});

server.listen(PORT, () => {
  log(`Bridge listening: HTTP+WS on http://localhost:${PORT} (WS path /ws)`);
});
