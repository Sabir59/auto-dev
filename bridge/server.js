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

// FIGMA_BRIDGE_PORT exists so the dev-control daemon (worker-ui/devctl.mjs) and its tests can run
// an isolated bridge instance without touching the real one on 8787.
const PORT = Number(process.env.FIGMA_BRIDGE_PORT) || 8787;
const REQUEST_TIMEOUT_MS = 30000;
// Commands that legitimately take longer: an image is downloaded by the plugin's UI and then
// decoded by Figma; an export renders the node. Each timer starts when that command is sent (the
// MCP server sends a batch's steps one at a time), so a slow one never eats into the next one's.
const TIMEOUT_MS_BY_TYPE = { IMPORT_IMAGE: 120000, EXPORT_NODE: 90000 };
// Commands that timed out, kept briefly: when the plugin's answer arrives after all, the log says so
// (the change DID happen in Figma), instead of a bare "no pending request".
const timedOut = new Map();
const EXPORTS_DIR = path.join(__dirname, "..", "exports");
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

let pluginSocket = null;
const pending = new Map(); // id -> { resolve, reject, timer }

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Who may talk to the bridge. Its callers are local programs (the MCP server, the console, tests),
// which send no Origin header, and the plugin's UI, which connects over WebSocket from Figma's
// sandboxed iframe (Origin "null", or a figma.com origin). A web page the person happens to have
// open sends its own Origin: its commands, and its WebSocket (which would replace the plugin's), are
// refused. The Host must be this loopback port, so a DNS-rebinding name can't reach it either.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const WS_ORIGINS = new Set(["null", "https://www.figma.com", "https://figma.com"]);
// The bridge's own origin is what the dev-control daemon sends with /shutdown; no web page can have
// it, because the bridge serves no pages.
const SELF = new Set([...HOSTS].map((h) => `http://${h}`));
function refusal(req, { ws = false } = {}) {
  if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) return "Host is not this bridge";
  const origin = req.headers.origin;
  if (ws) return origin === undefined || WS_ORIGINS.has(origin) ? null : `WebSocket origin ${origin} is not the Figma plugin`;
  if (req.method !== "GET" && origin !== undefined && !SELF.has(origin)) return `requests from web pages (Origin ${origin}) are refused`;
  return null;
}

const server = http.createServer((req, res) => {
  const why = refusal(req);
  if (why) {
    log("REFUSED", req.method, req.url, "-", why);
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `Refused: ${why}` }));
    return;
  }
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

      const limit = TIMEOUT_MS_BY_TYPE[command.type] || REQUEST_TIMEOUT_MS;
      const resultPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          timedOut.set(id, { type: command.type, at: Date.now() });
          if (timedOut.size > 200) timedOut.delete(timedOut.keys().next().value);
          reject(new Error(`Timed out after ${limit / 1000}s waiting for the plugin's response to ${command.type}. The plugin may still finish it, so check the node before sending it again.`));
        }, limit);
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

  // Graceful self-stop for the dashboard's Figma Bridge dev-control toggle (worker-ui/devctl.mjs).
  // Responds first so the caller sees success, then exits once the response has flushed.
  if (req.method === "POST" && req.url === "/shutdown") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => process.exit(0), 150);
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }) => { const why = refusal(req, { ws: true }); if (why) log("REFUSED WebSocket -", why); return !why; } });

wss.on("connection", (socket, req) => {
  log("plugin connected", `(origin ${req.headers.origin === undefined ? "none" : req.headers.origin})`);
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
      const late = timedOut.get(msg.id);
      if (late) { timedOut.delete(msg.id); log(`LATE reply for ${late.type} ${msg.id}: ${msg.ok ? "it DID complete in Figma" : "it failed"}, ${Math.round((Date.now() - late.at) / 1000)}s after the bridge gave up`); }
      else log("no pending request for id", msg.id);
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

// Loopback only, never the LAN. Both loopbacks, because "localhost" can resolve to either:
// Figma's plugin UI connects over ::1. One server can't listen on two addresses, so a second
// one on 127.0.0.1 hands its requests and WebSocket upgrades to the first.
server.listen(PORT, "::1", () => {
  log(`Bridge listening: HTTP+WS on http://localhost:${PORT} (WS path /ws), loopback only`);
});
const v4 = http.createServer();
v4.on("request", (req, res) => server.emit("request", req, res));
v4.on("upgrade", (req, socket, head) => server.emit("upgrade", req, socket, head));
v4.listen(PORT, "127.0.0.1");
