// Tiny local bridge server.
//
//   AI/backend --HTTP POST /command--> [this server] --WebSocket--> Figma plugin UI
//
// Each running plugin is a session, bound to the one file it was run in (a plugin instance can't
// change files). A command goes to the session of the file it names ({fileKey}); without one, to the
// only open file, and it's refused while several files have the plugin running. Correlates
// request/response by id and resolves the pending HTTP request when the matching reply arrives.
// Errors carry a machine-readable code, so callers can tell "no plugin" from "wrong file" from
// "timed out".

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// FIGMA_BRIDGE_PORT exists so the dev-control daemon (worker-ui/devctl.mjs) and its tests can run
// an isolated bridge instance without touching the real one on 8787.
const PORT = Number(process.env.FIGMA_BRIDGE_PORT) || 8787;
// What callers check (bridge/launcher.mjs): 2 = sessions per file, error codes, heartbeat.
const PROTOCOL = 2;
const STARTED_AT = Date.now();
const REQUEST_TIMEOUT_MS = 30000;
// Commands that legitimately take longer: an image is downloaded by the plugin's UI and then
// decoded by Figma; an export renders the node. Each timer starts when that command is sent (the
// MCP server sends a batch's steps one at a time), so a slow one never eats into the next one's.
const TIMEOUT_MS_BY_TYPE = { IMPORT_IMAGE: 120000, EXPORT_NODE: 90000 };
// A plugin whose iframe Figma tore down may never send a close frame: one that misses a heartbeat
// (a WebSocket ping, which the browser answers by itself) is dropped.
const HEARTBEAT_MS = Number(process.env.FIGMA_BRIDGE_HEARTBEAT_MS) || 15000;
// Commands that timed out, kept briefly: when the plugin's answer arrives after all, the log says so
// (the change DID happen in Figma), instead of a bare "no pending request".
const timedOut = new Map();
const EXPORTS_DIR = path.join(__dirname, "..", "exports");
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

const sessions = new Map(); // socket -> { id, socket, connectedAt, lastSeen, alive, file, info }
const pending = new Map(); // id -> { resolve, reject, timer, socket, type }
let lastDisconnect = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const fail = (res, status, code, error, extra = {}) => send(res, status, { ok: false, code, error, ...extra });
const describe = (s) => ({ session: s.id, fileName: s.file?.fileName ?? null, fileKey: s.file?.fileKey ?? null, editorType: s.file?.editorType ?? null,
  connectedAt: new Date(s.connectedAt).toISOString(), lastSeen: new Date(s.lastSeen).toISOString() });
const pickFile = (f) => ({ fileName: f.fileName ?? null, fileKey: f.fileKey || null, editorType: f.editorType ?? null, rootId: f.rootId ?? null });

// Sends a command to one plugin session; resolves with its reply ({id, ok, result|error}).
function dispatch(socket, type, params) {
  const id = crypto.randomUUID();
  const limit = TIMEOUT_MS_BY_TYPE[type] || REQUEST_TIMEOUT_MS;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      timedOut.set(id, { type, at: Date.now() });
      if (timedOut.size > 200) timedOut.delete(timedOut.keys().next().value);
      reject(Object.assign(new Error(`Timed out after ${limit / 1000}s waiting for the plugin's response to ${type}. The plugin may still finish it, so check the node before sending it again.`), { code: "TIMEOUT" }));
    }, limit);
    pending.set(id, { resolve, reject, timer, socket, type });
  });
  log("-> plugin:", type, id);
  socket.send(JSON.stringify({ id, type, params: params || {} }));
  return promise;
}

// Which file a session is in: from the plugin's hello, or else asked once (so older plugin code
// works too). A session's file never changes, so it's learnt once.
function learnFile(socket) {
  const s = sessions.get(socket);
  if (!s || s.file) return Promise.resolve();
  if (s.info) return s.info;
  const asked = dispatch(socket, "GET_FILE_INFO", {})
    .then((r) => { if (r.ok && r.result && !s.file) { s.file = pickFile(r.result); log(`session ${s.id} is "${s.file.fileName}" (${s.file.fileKey || "no key"})`); } })
    .catch((e) => log(`session ${s.id}: file info unavailable: ${e.message}`));
  // A client that doesn't answer it holds nothing up for long: its file stays unknown.
  s.info = Promise.race([asked, new Promise((ok) => setTimeout(ok, 3000).unref())]).finally(() => { s.info = null; });
  return s.info;
}

// The session a command goes to, or why there isn't one.
async function route(fileKey) {
  if (!sessions.size) return { status: 503, code: "PLUGIN_NOT_CONNECTED", error: "No Figma plugin connected. Open the file in the Figma desktop app and run the plugin (Plugins → Development → AI Executor (POC))." };
  // Files only matter when one is named or there's a choice to make.
  if (fileKey || sessions.size > 1) await Promise.all([...sessions.keys()].map(learnFile));
  const all = [...sessions.values()].sort((a, b) => b.connectedAt - a.connectedAt);
  if (!all.length) return { status: 503, code: "PLUGIN_NOT_CONNECTED", error: "The Figma plugin disconnected. Run it again in the Figma desktop app." };
  const openFiles = all.map(describe);
  if (fileKey) {
    const s = all.find((x) => x.file?.fileKey === fileKey);
    if (s) return { session: s };
    return { status: 409, code: "FILE_NOT_OPEN", error: `The plugin isn't running in the file ${fileKey}. Open that file in the Figma desktop app and run the plugin there.`, openFiles };
  }
  // Several sessions in one file (a re-run before the old socket closed): the newest one is it.
  const distinct = new Set(all.map((x) => x.file?.fileKey || `session:${x.id}`));
  if (distinct.size > 1) return { status: 409, code: "AMBIGUOUS_SESSION", error: `The plugin is running in ${distinct.size} files; name the file (fileKey) this command is for.`, openFiles };
  return { session: all[0] };
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
    fail(res, 403, "REFUSED", `Refused: ${why}`);
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
        fail(res, 400, "BAD_REQUEST", "Invalid JSON body");
        return;
      }

      const target = await route(typeof payload.fileKey === "string" && payload.fileKey ? payload.fileKey : null);
      if (!target.session) {
        fail(res, target.status, target.code, target.error, target.openFiles ? { openFiles: target.openFiles } : {});
        return;
      }
      const file = { fileName: target.session.file?.fileName ?? null, fileKey: target.session.file?.fileKey ?? null };

      try {
        const result = await dispatch(target.session.socket, payload.type, payload.params);

        // Any command whose result carries a base64 payload (currently
        // just EXPORT_NODE, but the bridge doesn't need to know that by
        // name) gets written to disk instead of dumped as a huge blob over
        // HTTP. Extension follows the requested format (PNG/JPG/SVG/PDF).
        // This is transport concern (large binary handling), not a Figma
        // capability, so it stays keyed off shape, not command type.
        if (result.ok && result.result && typeof result.result.base64 === "string") {
          const ext = (result.result.format || "png").toLowerCase();
          const fileName = `${(payload.params && payload.params.id) || result.id}.${ext}`.replace(/[:]/g, "_");
          const filePath = path.join(EXPORTS_DIR, fileName);
          fs.writeFileSync(filePath, Buffer.from(result.result.base64, "base64"));
          result.result = { path: filePath, width: result.result.width, height: result.result.height };
        }

        send(res, 200, { ...result, ...(result.ok ? {} : { code: "COMMAND_FAILED" }), file });
      } catch (err) {
        fail(res, err.code === "PLUGIN_DISCONNECTED" ? 502 : 504, err.code || "TIMEOUT", String(err.message || err), { file });
      }
    });
    return;
  }

  // Machine-readable availability: which files have the plugin running, and when one last dropped.
  if (req.method === "GET" && req.url === "/status") {
    const list = [...sessions.values()].sort((a, b) => b.connectedAt - a.connectedAt).map(describe);
    send(res, 200, { bridge: "figma-ai-executor", protocol: PROTOCOL, pid: process.pid, port: PORT, startedAt: new Date(STARTED_AT).toISOString(),
      pluginConnected: list.length > 0, sessions: list, lastDisconnect });
    return;
  }

  // Graceful self-stop for the dashboard's Figma Bridge dev-control toggle (worker-ui/devctl.mjs).
  // Responds first so the caller sees success, then exits once the response has flushed.
  if (req.method === "POST" && req.url === "/shutdown") {
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 150);
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }) => { const why = refusal(req, { ws: true }); if (why) log("REFUSED WebSocket -", why); return !why; } });

wss.on("connection", (socket, req) => {
  const s = { id: crypto.randomUUID().slice(0, 8), socket, connectedAt: Date.now(), lastSeen: Date.now(), alive: true, file: null, info: null };
  sessions.set(socket, s);
  log("plugin connected", s.id, `(origin ${req.headers.origin === undefined ? "none" : req.headers.origin})`);
  socket.on("pong", () => { s.alive = true; s.lastSeen = Date.now(); });

  socket.on("message", (raw) => {
    s.alive = true;
    s.lastSeen = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      log("bad json from plugin:", raw.toString());
      return;
    }

    if (msg.type === "__hello__") {
      if (msg.file && typeof msg.file === "object" && !s.file) s.file = pickFile(msg.file);
      log("hello from plugin:", msg.role, s.file ? `"${s.file.fileName}" (${s.file.fileKey || "no key"})` : "");
      if (!s.file) learnFile(socket); // older plugin code: ask, so /status can name the file
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
    if (!sessions.delete(socket)) return;
    lastDisconnect = { at: new Date().toISOString(), fileName: s.file?.fileName ?? null, fileKey: s.file?.fileKey ?? null };
    log("plugin disconnected", s.id);
    // Commands this plugin was running fail now, not at their timeout. Whether Figma applied them
    // is unknown, and the error says so.
    for (const [id, entry] of pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(Object.assign(new Error(`The Figma plugin disconnected while running ${entry.type}. Figma may or may not have applied it: check the node before sending it again.`), { code: "PLUGIN_DISCONNECTED" }));
    }
  });
});

setInterval(() => {
  for (const [socket, s] of sessions) {
    if (!s.alive) { log("plugin missed a heartbeat:", s.id); socket.terminate(); continue; }
    s.alive = false;
    try { socket.ping(); } catch {}
  }
}, HEARTBEAT_MS).unref();

// Loopback only, never the LAN. Both loopbacks, because "localhost" can resolve to either:
// Figma's plugin UI connects over ::1. One server can't listen on two addresses, so a second
// one on 127.0.0.1 hands its requests and WebSocket upgrades to the first.
// A port that's taken means another bridge (or another program) is there: exit, don't fight it.
const cantListen = (e) => { log(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use (another bridge is probably running); exiting.` : `Can't listen: ${e.message}`); process.exit(3); };
server.on("error", cantListen);
server.listen(PORT, "::1", () => {
  log(`Bridge listening: HTTP+WS on http://localhost:${PORT} (WS path /ws), loopback only, protocol ${PROTOCOL}`);
});
const v4 = http.createServer();
v4.on("error", cantListen);
v4.on("request", (req, res) => server.emit("request", req, res));
v4.on("upgrade", (req, socket, head) => server.emit("upgrade", req, socket, head));
v4.listen(PORT, "127.0.0.1");
