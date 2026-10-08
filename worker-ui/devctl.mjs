#!/usr/bin/env node
// Local dev-server control daemon. The ONLY thing it does is start/stop/probe the two real dev
// processes (the Worker Console and the Figma bridge) for the dashboard's ON/OFF switches.
//
//   node worker-ui/devctl.mjs   ->  http://localhost:8796
//
// Why this exists: the Worker Console (worker-ui/server.mjs) IS the process serving the
// dashboard page. Nothing else in this repo stays running once it stops, so nothing could answer
// a "start it again" request after it's down. This is a second, tiny, always-on process whose
// only job is process lifecycle — it doesn't touch the worker runtime, the Figma adapter, the
// bridge protocol or any execution path. An already-open dashboard tab keeps working after the
// Worker Console stops (its HTML/JS are already loaded); it just talks to this daemon instead.
//
// How "running" is decided: always by probing the real port (an HTTP request with a short
// timeout), never by trusting a cached PID. That's what makes "already running, started outside
// the dashboard" and "it crashed" both show up correctly.
//
// How "stop" works: an HTTP POST to the target's OWN graceful-shutdown route (added to
// server.mjs and bridge/server.js specifically for this), never an OS-level kill by PID. That's
// what makes stop safe regardless of who started the process, and keeps this daemon from ever
// touching an unrelated Node or Claude process. The one exception: if THIS daemon spawned the
// child itself and the graceful route doesn't bring it down, it kills that exact tracked
// ChildProcess object as a last resort.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

// Same env vars the target processes themselves already read, so this daemon always manages
// whichever instance is actually configured — including an isolated one under test.
const WORKER_PORT = Number(process.env.WORKER_CONSOLE_PORT) || 8799;
const BRIDGE_PORT = Number(process.env.FIGMA_BRIDGE_PORT) || 8787;
const DEVCTL_PORT = Number(process.env.WORKER_CONSOLE_DEVCTL_PORT) || 8796;

const LOGS = join(HERE, "devctl-logs");
mkdirSync(LOGS, { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

const TARGETS = {
  worker: {
    label: "Worker Server",
    port: WORKER_PORT,
    probe: () => `http://127.0.0.1:${WORKER_PORT}/`,
    shutdown: () => `http://127.0.0.1:${WORKER_PORT}/__control/shutdown`,
    log: join(LOGS, "worker.log"),
    spawn(fd) {
      return spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], {
        cwd: REPO,
        env: { ...process.env, WORKER_CONSOLE_PORT: String(WORKER_PORT) },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    },
  },
  bridge: {
    label: "Figma Bridge",
    port: BRIDGE_PORT,
    probe: () => `http://127.0.0.1:${BRIDGE_PORT}/status`,
    shutdown: () => `http://127.0.0.1:${BRIDGE_PORT}/shutdown`,
    log: join(LOGS, "bridge.log"),
    spawn(fd) {
      return spawn(process.execPath, [join(REPO, "bridge", "server.js")], {
        cwd: join(REPO, "bridge"),
        env: { ...process.env, FIGMA_BRIDGE_PORT: String(BRIDGE_PORT) },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    },
  },
};
const state = Object.fromEntries(Object.keys(TARGETS).map((k) => [k, { child: null, startedBy: null, lastError: null, pending: null }]));

async function probe(key) {
  try {
    const r = await fetch(TARGETS[key].probe(), { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function statusOne(key) {
  const t = TARGETS[key], s = state[key];
  const running = await probe(key);
  if (!running) s.startedBy = null;
  return { label: t.label, port: t.port, running, startedBy: running ? s.startedBy || "external" : null, pending: s.pending, lastError: s.lastError };
}
async function statusAll() {
  const out = {};
  for (const k of Object.keys(TARGETS)) out[k] = await statusOne(k);
  return out;
}

async function startTarget(key) {
  const t = TARGETS[key], s = state[key];
  s.lastError = null;
  if (await probe(key)) { s.startedBy = s.startedBy || "external"; return { ok: true, note: "already running" }; }
  s.pending = "starting";
  let fd;
  try {
    fd = openSync(t.log, "a");
    const child = t.spawn(fd);
    s.child = child;
    s.startedBy = "devctl";
    child.unref();
    child.once("exit", (code, signal) => {
      try { closeSync(fd); } catch {}
      if (state[key].child === child) {
        state[key].child = null;
        if (code !== 0 && code !== null) state[key].lastError = `exited with code ${code}${signal ? ` (${signal})` : ""}`;
      }
    });
    child.once("error", (e) => { state[key].lastError = e.message; });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await probe(key)) { s.pending = null; return { ok: true }; }
      await sleep(250);
    }
    s.pending = null;
    let tail = ""; try { tail = readFileSync(t.log, "utf8").slice(-500).trim(); } catch {}
    s.lastError = s.lastError ? `${s.lastError}${tail ? ` — last output: ${tail}` : ""}` : `did not come up within 8s on port ${t.port}${tail ? ` — last output: ${tail}` : ""}`;
    return { ok: false, error: s.lastError };
  } catch (e) {
    s.pending = null; s.lastError = e.message;
    return { ok: false, error: e.message };
  }
}

async function stopTarget(key) {
  const t = TARGETS[key], s = state[key];
  s.lastError = null;
  if (!(await probe(key))) { s.startedBy = null; s.child = null; return { ok: true, note: "already stopped" }; }
  s.pending = "stopping";
  let shutdownOk = false, shutdownError = null;
  try {
    const r = await fetch(t.shutdown(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-console": "1", origin: `http://127.0.0.1:${t.port}` },
      signal: AbortSignal.timeout(3000),
    });
    shutdownOk = r.ok;
    if (!r.ok) shutdownError = `its shutdown endpoint returned ${r.status}`;
  } catch (e) { shutdownError = `could not reach its shutdown endpoint: ${e.message}`; }
  if (shutdownOk) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (!(await probe(key))) { s.pending = null; s.startedBy = null; s.child = null; return { ok: true }; } await sleep(250); }
    shutdownError = "it accepted the shutdown request but did not actually stop";
  }
  // Last resort, only for a process this exact daemon instance spawned and still holds a handle to.
  if (s.child) {
    try { s.child.kill(); } catch {}
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { if (!(await probe(key))) { s.pending = null; s.startedBy = null; s.child = null; return { ok: true, note: "force-stopped" }; } await sleep(250); }
  }
  s.pending = null;
  s.lastError = shutdownError + (s.child ? "" : " — it may be running outside devctl's control; stop it manually.");
  return { ok: false, error: s.lastError };
}

// CORS: this daemon is a different origin from the dashboard it serves (different port), so a
// browser fetch from the dashboard is genuinely cross-origin and needs an explicit allow —
// unlike server.mjs's own guard, which exists to reject cross-origin entirely. Only the
// dashboard's own origin(s) are allowed; everything else gets no CORS headers at all.
const ALLOWED_ORIGINS = new Set([`http://localhost:${WORKER_PORT}`, `http://127.0.0.1:${WORKER_PORT}`]);
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-worker-console");
    res.setHeader("Vary", "Origin");
  }
}

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `localhost:${DEVCTL_PORT}` && host !== `127.0.0.1:${DEVCTL_PORT}`) { res.writeHead(403); return res.end("wrong host"); }
  if (req.method !== "GET") {
    if (req.headers["x-worker-console"] !== "1") { res.writeHead(403); return res.end("missing X-Worker-Console header"); }
    if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) { res.writeHead(403); return res.end("origin not allowed"); }
  }
  const url = new URL(req.url, `http://localhost:${DEVCTL_PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/status" && req.method === "GET") return json(res, 200, await statusAll());
    if (parts.length === 2 && TARGETS[parts[0]] && (parts[1] === "start" || parts[1] === "stop") && req.method === "POST") {
      const r = parts[1] === "start" ? await startTarget(parts[0]) : await stopTarget(parts[0]);
      return json(res, r.ok ? 200 : 500, r);
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { json(res, 500, { ok: false, error: e.message }); }
}).listen(DEVCTL_PORT, "127.0.0.1", () => {
  console.log(`Dev server control on http://localhost:${DEVCTL_PORT} — managing Worker Server (port ${WORKER_PORT}) and Figma Bridge (port ${BRIDGE_PORT})`);
});
