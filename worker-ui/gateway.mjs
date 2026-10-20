#!/usr/bin/env node
// The hosted platform's control plane: the one public entry point of AI Worker as a website.
//
//   browser ──HTTPS (TLS at the load balancer)──► gateway (this file, AIW_PORT)
//     sign-in, sessions, Origin checks ──► the person's own console (worker-ui/server.mjs, AIW_HOSTED=1,
//                                          127.0.0.1:<port>, its own OS uid and data dir)
//                                            └─► workers (claude CLI) ──► model gateway (this file,
//                                                127.0.0.1:AIW_MODEL_PORT) ──► Anthropic API (the key is here only)
//
// It adds no product logic: Workers, Teams, Workspaces, runs, Git and adapters are the console's,
// unchanged. What it owns:
//  - who you are: invite-only accounts (users.mjs), scrypt passwords, server-side sessions in an
//    HttpOnly cookie, sign-out, idle and absolute expiry;
//  - which console you reach: exactly one, yours, started on demand as your own uid
//    (AIW_ISOLATION=uid) with a data dir only that uid can open; an id from another person's console
//    doesn't exist in yours;
//  - CSRF: every state-changing request must carry this site's exact Origin (and same-origin fetch
//    metadata); the console then applies its own guard (custom header, JSON body);
//  - the model credential: workers authenticate to the model gateway with a per-console token; the
//    gateway forwards to the provider with the real key, streaming, with per-person concurrency
//    limits and timeouts, and never logs bodies or keys;
//  - the GitHub App's client secret: consoles ask the broker here to exchange, refresh or revoke.
// docs/HOSTED_ARCHITECTURE.md, docs/CLOUD_DEPLOYMENT.md.
import http from "node:http";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chownSync, chmodSync, openSync, accessSync, constants as FS, statSync } from "node:fs";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { openUsers } from "./users.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const ENV = env.AIW_ENV || "production"; // production | development | test
const PROD = ENV === "production";
const PUBLIC_ORIGIN = String(env.AIW_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const PORT = Number(env.AIW_PORT) || 8080, BIND = env.AIW_BIND || "0.0.0.0";
const MODEL_PORT = Number(env.AIW_MODEL_PORT) || 8090;
const CONSOLE_PORT_BASE = Number(env.AIW_CONSOLE_PORT_BASE) || 9100;
const DATA = resolve(env.AIW_DATA || "");
const ISOLATION = env.AIW_ISOLATION || (process.platform === "linux" ? "uid" : "none");
const UID_BASE = Number(env.AIW_UID_BASE) || 20000;
const UPSTREAM = String(env.ANTHROPIC_UPSTREAM_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const API_KEY = env.ANTHROPIC_API_KEY || "";
const MODEL_MAX_CONCURRENT = Number(env.AIW_MODEL_MAX_CONCURRENT) || 4;
const MODEL_DAILY_REQUESTS = Number(env.AIW_MODEL_DAILY_REQUESTS) || 0; // 0: no daily cap
const MODEL_IDLE_MS = Number(env.AIW_MODEL_IDLE_MS) || 10 * 60 * 1000;
const MODEL_HEADERS_MS = Number(env.AIW_MODEL_HEADERS_MS) || 120 * 1000;
const SESSION_IDLE_MS = (Number(env.AIW_SESSION_IDLE_HOURS) || 12) * 3600e3;
const SESSION_MAX_MS = (Number(env.AIW_SESSION_MAX_DAYS) || 7) * 86400e3;
const NPROC = Number(env.AIW_NPROC_LIMIT) || 2048, FSIZE = Number(env.AIW_FSIZE_LIMIT) || 4 * 1024 ** 3;
const GH = { clientId: env.GITHUB_APP_CLIENT_ID || "", clientSecret: env.GITHUB_APP_CLIENT_SECRET || "", slug: env.GITHUB_APP_SLUG || "",
  web: String(env.GITHUB_WEB_BASE || "https://github.com").replace(/\/+$/, ""), api: String(env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "") };
const HTTPS = PUBLIC_ORIGIN.startsWith("https://");
const COOKIE = HTTPS ? "__Host-aiw_session" : "aiw_session";

// ---- logging: one JSON line per event; never a body, a query string, a cookie or a key ----
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

// ---- configuration: refuse to start rather than run half-configured ----
function configProblems() {
  const p = [];
  if (!/^https?:\/\/[^/]+$/.test(PUBLIC_ORIGIN)) p.push("AIW_PUBLIC_ORIGIN must be the site's origin, e.g. https://aiworker.example.com");
  if (PROD && !HTTPS) p.push("AIW_PUBLIC_ORIGIN must be https in production");
  if (!env.AIW_DATA) p.push("AIW_DATA must name the persistent data directory");
  if (!API_KEY) p.push("ANTHROPIC_API_KEY is required (the model provider's key; kept by the gateway only)");
  let up; try { up = new URL(UPSTREAM); } catch { p.push("ANTHROPIC_UPSTREAM_URL isn't a URL"); }
  if (up && PROD && (up.protocol !== "https:" || /^(127\.|localhost$|\[::1\]$)/.test(up.hostname))) p.push("ANTHROPIC_UPSTREAM_URL must be an https provider address in production (a test upstream is only allowed with AIW_ENV=test)");
  if (!["uid", "none"].includes(ISOLATION)) p.push("AIW_ISOLATION must be uid or none");
  if (ISOLATION === "uid" && process.platform !== "linux") p.push("AIW_ISOLATION=uid needs Linux");
  if (ISOLATION === "uid" && process.getuid?.() !== 0) p.push("AIW_ISOLATION=uid needs the gateway to start as root (it starts each person's console as their own uid)");
  if (PROD && ISOLATION !== "uid") p.push("production requires AIW_ISOLATION=uid: without it every person's runs share one OS user");
  if (!claudeBin()) p.push("the Claude Code CLI wasn't found (install @anthropic-ai/claude-code, or set CLAUDE_BIN)");
  if (!spawnSync("git", ["--version"]).stdout?.length) p.push("git isn't installed");
  return p;
}
function claudeBin() {
  if (env.CLAUDE_BIN) return existsSync(env.CLAUDE_BIN) ? env.CLAUDE_BIN : null;
  for (const dir of [...(env.PATH || "").split(delimiter), "/usr/lib/node_modules/.bin", "/usr/local/lib/node_modules/.bin"]) {
    for (const rel of ["claude.exe", "claude"].flatMap((n) => [["node_modules", "@anthropic-ai", "claude-code", "bin", n], ["..", "lib", "node_modules", "@anthropic-ai", "claude-code", "bin", n]])) {
      const p = join(dir, ...rel); if (dir && existsSync(p)) return resolve(p);
    }
  }
  return null;
}
const SETPRIV = ["/usr/bin/setpriv", "/bin/setpriv"].find(existsSync) || null;
const PRLIMIT = ["/usr/bin/prlimit", "/bin/prlimit"].find(existsSync) || null;

// ---- stores (control dir: root-only when isolated) ----
const CONTROL = join(DATA, "control");
const USERS_DIR = join(DATA, "users"), LOGS = join(DATA, "logs");
function prepareDirs() {
  for (const d of [CONTROL, USERS_DIR, LOGS]) mkdirSync(d, { recursive: true, mode: 0o700 });
  if (ISOLATION === "uid") { chmodSync(CONTROL, 0o700); chmodSync(LOGS, 0o700); chmodSync(USERS_DIR, 0o711); chmodSync(DATA, 0o711); } // users/ can be traversed, not listed
}
let users;
const SESS_FILE = () => join(CONTROL, "sessions.json");
let sessions = new Map(); // sha256(token) -> { userId, created, seen }
const loadSessions = () => { try { sessions = new Map(Object.entries(JSON.parse(readFileSync(SESS_FILE(), "utf8")))); } catch { sessions = new Map(); } };
let saveTimer = null;
const saveSessions = (now = false) => {
  const write = () => { saveTimer = null; writeFileSync(SESS_FILE() + ".tmp", JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 }); renameSync(SESS_FILE() + ".tmp", SESS_FILE()); };
  if (now) { clearTimeout(saveTimer); return write(); }
  saveTimer ||= setTimeout(write, 2000);
};
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const cookieOf = (req) => { for (const part of String(req.headers.cookie || "").split(/;\s*/)) { const i = part.indexOf("="); if (part.slice(0, i) === COOKIE) return part.slice(i + 1); } return null; };
const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${HTTPS ? "; Secure" : ""}; Max-Age=${maxAge}`;
// The signed-in person for this request, or null. An expired, unknown, disabled or superseded
// (password changed) session is removed.
function sessionUser(req) {
  const tok = cookieOf(req); if (!tok || !/^[\w-]{40,}$/.test(tok)) return null;
  const key = sha(tok), s = sessions.get(key); if (!s) return null;
  const now = Date.now(), u = users.byId(s.userId);
  if (!u || u.disabled || now - s.created > SESSION_MAX_MS || now - s.seen > SESSION_IDLE_MS || (u.sessionsBefore && Date.parse(u.sessionsBefore) > s.created)) { sessions.delete(key); saveSessions(); return null; }
  if (now - s.seen > Math.min(60000, SESSION_IDLE_MS / 4)) { s.seen = now; saveSessions(); }
  return { ...u, sessionKey: key };
}

// ---- sign-in rate limit: per address and per account, 10 failures in 15 minutes ----
const failures = new Map();
const tooMany = (k) => { const f = failures.get(k); return !!f && Date.now() - f.first < 15 * 60e3 && f.n >= 10; };
const fail = (k) => { const f = failures.get(k); if (!f || Date.now() - f.first > 15 * 60e3) failures.set(k, { first: Date.now(), n: 1 }); else f.n++; };
const clientIp = (req) => (env.AIW_TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";

// ---- per-person consoles ----
// Each person: <AIW_DATA>/users/<id>/ (mode 700, owned by their uid): home, data (the console's data
// dir: runs, workspaces, workers, Teams), claude (Claude Code's config dir: sessions), github, figma,
// builder (their own integration credentials), tmp. Nothing of theirs is in another person's reach.
const consoles = new Map(); // userId -> { proc, port, secret, modelKey, brokerKey, ready, exited }
const byModelKey = new Map(), byBrokerKey = new Map(); // sha(token) -> userId
function homeOf(u) { return join(USERS_DIR, u.id); }
function prepareHome(u) {
  const home = homeOf(u);
  const dirs = [home, ...["data", "claude", "github", "figma", "builder", "tmp"].map((d) => join(home, d))];
  for (const d of dirs) mkdirSync(d, { recursive: true, mode: 0o700 });
  if (ISOLATION === "uid") for (const d of dirs.reverse()) { chownSync(d, u.uid, u.uid); chmodSync(d, 0o700); }
  return home;
}
function consoleEnv(u, c, home) {
  const keep = ["PATH", "LANG", "TZ", "PLAYWRIGHT_BROWSERS_PATH", "NODE_EXTRA_CA_CERTS", "GITHUB_STATE_TTL_MS",
    ...(process.platform === "win32" ? ["SystemRoot", "windir", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "SystemDrive", "TEMP", "TMP"] : [])];
  const e = Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  return { ...e, HOME: home, USERPROFILE: home, TMPDIR: join(home, "tmp"), LANG: env.LANG || "C.UTF-8",
    AIW_HOSTED: "1", AIW_INTERNAL_SECRET: c.secret, AIW_PUBLIC_ORIGIN: PUBLIC_ORIGIN, AIW_USER_NAME: u.name, AIW_USER_EMAIL: u.email,
    WORKER_CONSOLE_PORT: String(c.port), WORKER_CONSOLE_DATA: join(home, "data"), WORKER_CONSOLE_CLAUDE_CONFIG_DIR: join(home, "claude"),
    GITHUB_CONNECTOR_DIR: join(home, "github"), FIGMA_READER_DIR: join(home, "figma"), BUILDER_ADAPTER_DIR: join(home, "builder"),
    MODEL_PROVIDER: "anthropic-gateway", ANTHROPIC_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, ANTHROPIC_AUTH_TOKEN: c.modelKey,
    AIW_TOKEN_BROKER: `http://127.0.0.1:${MODEL_PORT}`, AIW_BROKER_TOKEN: c.brokerKey,
    ...(GH.clientId ? { GITHUB_APP_CLIENT_ID: GH.clientId, GITHUB_APP_SLUG: GH.slug } : {}),
    ...(env.GITHUB_WEB_BASE ? { GITHUB_WEB_BASE: GH.web } : {}), ...(env.GITHUB_API_BASE ? { GITHUB_API_BASE: GH.api } : {}),
    CLAUDE_BIN: claudeBin() };
}
async function ensureConsole(u) {
  let c = consoles.get(u.id);
  if (c && !c.exited) return c.ready;
  const token = () => randomBytes(32).toString("base64url");
  c = { port: CONSOLE_PORT_BASE + u.seq, secret: token(), modelKey: token(), brokerKey: token(), exited: false, user: u };
  consoles.set(u.id, c); byModelKey.set(sha(c.modelKey), u.id); byBrokerKey.set(sha(c.brokerKey), u.id);
  const home = prepareHome(u), server = join(HERE, "server.mjs");
  // Isolated: limits set first (as root), then the uid is switched with no way back up (no_new_privs).
  let cmd = process.execPath, args = [server], opts = {};
  if (ISOLATION === "uid") {
    const priv = SETPRIV ? [SETPRIV, `--reuid=${u.uid}`, `--regid=${u.uid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--", process.execPath, server] : [process.execPath, server];
    const lim = PRLIMIT ? [PRLIMIT, `--nproc=${NPROC}`, "--nofile=8192", "--core=0", `--fsize=${FSIZE}`, "--"] : [];
    [cmd, ...args] = [...lim, ...priv];
    if (!SETPRIV) opts = { uid: u.uid, gid: u.uid };
  }
  const out = openSync(join(LOGS, `${u.id}.console.log`), "a", 0o600);
  c.proc = spawn(cmd, args, { cwd: home, env: consoleEnv(u, c, home), stdio: ["ignore", out, out], ...opts });
  c.proc.on("exit", (code, sig) => { c.exited = true; byModelKey.delete(sha(c.modelKey)); byBrokerKey.delete(sha(c.brokerKey)); log(code === 0 ? "info" : "warn", "console exited", { user: u.id, code, sig }); });
  c.ready = (async () => {
    for (let i = 0; i < 100; i++) {
      if (c.exited) throw new Error("console exited");
      try { const r = await internalRequest(c, "GET", "/__health"); if (r.status === 200) { log("info", "console ready", { user: u.id, port: c.port }); return c; } } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("console didn't start");
  })();
  c.ready.catch(() => { try { c.proc.kill(); } catch {} });
  return c.ready;
}
function internalRequest(c, method, path) {
  return new Promise((ok, no) => {
    const r = http.request({ host: "127.0.0.1", port: c.port, method, path, headers: { host: `127.0.0.1:${c.port}`, "x-aiw-internal": c.secret }, timeout: 3000 }, (res) => { res.resume(); res.on("end", () => ok({ status: res.statusCode })); });
    r.on("error", no); r.on("timeout", () => r.destroy(new Error("timeout"))); r.end();
  });
}

// ---- proxy to the person's console ----
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "cookie", "authorization", "origin"]);
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function securityHeaders(h, html) {
  h["x-frame-options"] = "DENY"; h["referrer-policy"] = "same-origin"; h["x-content-type-options"] ||= "nosniff";
  if (html && !h["content-security-policy"]) h["content-security-policy"] = CSP;
  if (HTTPS) h["strict-transport-security"] = "max-age=31536000";
  return h;
}
async function proxy(req, res, u, target) {
  let c; try { c = await ensureConsole(u); }
  catch { return sendJson(res, 503, { error: "Your workspace server couldn't start. Try again in a moment; if it keeps failing, contact the administrator." }); }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-aiw-") && !k.startsWith("x-forwarded-")) headers[k] = v;
  headers.host = `127.0.0.1:${c.port}`; headers["x-aiw-internal"] = c.secret;
  if (!["GET", "HEAD"].includes(req.method)) headers.origin = `http://127.0.0.1:${c.port}`; // the public Origin was checked above
  const up = http.request({ host: "127.0.0.1", port: c.port, method: req.method, path: target, headers }, (r) => {
    const h = { ...r.headers }; delete h.connection; delete h["keep-alive"];
    if (String(h["content-type"] || "").startsWith("text/event-stream")) { h["x-accel-buffering"] = "no"; h["cache-control"] = "no-cache"; }
    if (!h["cache-control"] && String(h["content-type"] || "").includes("json")) h["cache-control"] = "no-store";
    res.writeHead(r.statusCode, securityHeaders(h, String(h["content-type"] || "").startsWith("text/html")));
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) sendJson(res, 502, { error: "Your workspace server isn't answering. Try again in a moment." }); else res.destroy(); });
  req.on("aborted", () => up.destroy());
  res.on("close", () => up.destroy());
  req.pipe(up);
}

// ---- small helpers ----
const sendJson = (res, status, obj, extra = {}) => { res.writeHead(status, securityHeaders({ "content-type": "application/json", "cache-control": "no-store", ...extra }, false)); res.end(JSON.stringify(obj)); };
const readBody = (req, max = 64 * 1024) => new Promise((ok, no) => { let b = "", n = 0; req.on("data", (d) => { n += d.length; if (n > max) { no(new Error("too large")); req.destroy(); } else b += d; }); req.on("end", () => ok(b)); req.on("error", no); });
// State changes need this site's exact Origin and, when the browser says, a same-origin request.
function originProblem(req) {
  if (req.method === "OPTIONS") return "preflight is never approved";
  if (req.headers.origin !== PUBLIC_ORIGIN) return "Origin is not this site";
  const site = req.headers["sec-fetch-site"]; if (site && site !== "same-origin") return "not a same-origin request";
  return null;
}
const LOGIN_PAGE = () => readFileSync(join(HERE, "login.html"));

// ---- public site ----
async function site(req, res) {
  // Only origin-form request targets; the path the checks below see is the one forwarded.
  if (!String(req.url).startsWith("/") || String(req.url).startsWith("//")) { res.writeHead(400); return res.end(); }
  const url = new URL(req.url, PUBLIC_ORIGIN), path = url.pathname, t0 = Date.now();
  res.on("finish", () => { if (!path.startsWith("/events")) log("info", "request", { method: req.method, path, status: res.statusCode, ms: Date.now() - t0, user: res.locals?.user }); });
  res.locals = {};
  if (path === "/healthz") return sendJson(res, 200, { ok: true });
  if (path === "/readyz") return readiness(res);
  if (path === "/login" && req.method === "GET") { res.writeHead(200, securityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, true)); return res.end(LOGIN_PAGE()); }
  if (path === "/login" && req.method === "POST") return login(req, res);
  if (path === "/logout" && req.method === "POST") {
    if (originProblem(req)) return sendJson(res, 403, { error: "Rejected." });
    const u = sessionUser(req); if (u) { sessions.delete(u.sessionKey); saveSessions(true); }
    return sendJson(res, 200, { ok: true }, { "set-cookie": cookieHeader("", 0) });
  }
  if (path === "/favicon.ico") { res.writeHead(204); return res.end(); }
  // The page's static images (the sign-in page needs them before anyone is signed in).
  const asset = /^\/assets\/([\w.-]+\.(png|svg))$/.exec(path);
  if (asset && req.method === "GET" && existsSync(join(HERE, "assets", asset[1]))) { res.writeHead(200, securityHeaders({ "content-type": asset[2] === "png" ? "image/png" : "image/svg+xml", "cache-control": "public, max-age=3600" }, false)); return res.end(readFileSync(join(HERE, "assets", asset[1]))); }
  const u = sessionUser(req);
  if (!u) {
    if (req.method === "GET" && (path === "/" || String(req.headers.accept || "").includes("text/html"))) { res.writeHead(303, { location: "/login" }); return res.end(); }
    return sendJson(res, 401, { error: "Sign in first.", signIn: "/login" });
  }
  res.locals.user = u.id;
  if (path === "/auth/me") return sendJson(res, 200, { user: { email: u.email, name: u.name } });
  // The console's local-development routes aren't part of the hosted site.
  if (path.startsWith("/__") || path === "/pick-folder" || path === "/console") return sendJson(res, 404, { error: "Not found." });
  if (!["GET", "HEAD"].includes(req.method)) { const why = originProblem(req); if (why) { log("warn", "rejected", { path, why, user: u.id }); return sendJson(res, 403, { error: `Rejected: ${why}` }); } }
  return proxy(req, res, u, path + url.search);
}
async function login(req, res) {
  if (originProblem(req)) return sendJson(res, 403, { error: "Rejected." });
  let b; try { const raw = await readBody(req); b = String(req.headers["content-type"] || "").includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw)); } catch { return sendJson(res, 400, { error: "Bad request." }); }
  const email = String(b.email || "").trim().toLowerCase(), ip = clientIp(req);
  if (tooMany(`ip:${ip}`) || tooMany(`acct:${email}`)) return sendJson(res, 429, { error: "Too many attempts. Wait 15 minutes and try again." }, { "retry-after": "900" });
  const u = users.verify(email, String(b.password || ""));
  if (!u) { fail(`ip:${ip}`); fail(`acct:${email}`); log("warn", "sign-in failed", { ip }); return sendJson(res, 401, { error: "Email or password is incorrect." }); }
  failures.delete(`acct:${email}`);
  const tok = randomBytes(32).toString("base64url"), now = Date.now();
  sessions.set(sha(tok), { userId: u.id, created: now, seen: now }); saveSessions(true);
  log("info", "signed in", { user: u.id });
  ensureConsole(u).catch(() => {}); // start their console while the page loads
  return sendJson(res, 200, { ok: true, user: { email: u.email, name: u.name } }, { "set-cookie": cookieHeader(tok, Math.floor(SESSION_MAX_MS / 1000)) });
}
let claudeVersion = null;
function readiness(res) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  try { accessSync(CONTROL, FS.W_OK); add("data directory writable", true); } catch { add("data directory writable", false); }
  add("model provider key configured", !!API_KEY);
  add("model upstream", true, new URL(UPSTREAM).host + (UPSTREAM === "https://api.anthropic.com" ? "" : " (not the default provider address)"));
  add("Claude Code CLI", !!claudeVersion, claudeVersion || "not runnable");
  add("isolation", ISOLATION === "uid" ? process.getuid?.() === 0 : !PROD, ISOLATION === "uid" ? `per-person uid${SETPRIV ? ", no_new_privs" : ""}${PRLIMIT ? ", process limits" : ""}` : "none (development only)");
  add("GitHub App", true, GH.clientId && GH.clientSecret ? "configured" : "not configured (Connect with GitHub is unavailable)");
  const ok = checks.every((c) => c.ok);
  return sendJson(res, ok ? 200 : 503, { ok, env: ENV, checks });
}

// ---- model gateway (loopback only) ----
const active = new Map(), daily = new Map();
const apiError = (res, status, type, message, extra = {}) => sendJson(res, status, { type: "error", error: { type, message } }, extra);
const bearer = (req) => /^Bearer ([\w-]{32,})$/.exec(String(req.headers.authorization || ""))?.[1] || null;
async function modelGateway(req, res) {
  const url = new URL(req.url, "http://x"), t0 = Date.now();
  if (url.pathname === "/api/hello") { res.writeHead(200); return res.end(); } // the runtime's connection warm-up
  if (url.pathname === "/github/token" || url.pathname === "/github/revoke") return broker(req, res, url.pathname);
  const key = bearer(req), userId = key && byModelKey.get(sha(key));
  if (!userId) return apiError(res, 401, "authentication_error", "This console's model token isn't valid.");
  const route = req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens") || (req.method === "GET" && url.pathname === "/v1/models");
  if (!route) return apiError(res, 404, "not_found_error", "Not available through the platform's model gateway.");
  const day = new Date().toISOString().slice(0, 10), dk = `${userId}:${day}`;
  if (MODEL_DAILY_REQUESTS && (daily.get(dk) || 0) >= MODEL_DAILY_REQUESTS) return apiError(res, 429, "rate_limit_error", "This account has used today's model requests on the platform.", { "retry-after": "3600", "x-should-retry": "false" });
  if ((active.get(userId) || 0) >= MODEL_MAX_CONCURRENT) return apiError(res, 429, "rate_limit_error", "Too many model requests at once for this account.", { "retry-after": "5" });
  active.set(userId, (active.get(userId) || 0) + 1); if (url.pathname === "/v1/messages") daily.set(dk, (daily.get(dk) || 0) + 1);
  let released = false; const release = () => { if (!released) { released = true; active.set(userId, active.get(userId) - 1); } };
  // Forward anthropic-* and the body unchanged (Claude Code's gateway contract); the person's token
  // is replaced by the provider key.
  const headers = { "x-api-key": API_KEY, "content-type": req.headers["content-type"] || "application/json", accept: req.headers.accept || "application/json" };
  for (const [k, v] of Object.entries(req.headers)) if (k.startsWith("anthropic-")) headers[k] = v;
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  const target = new URL(UPSTREAM + url.pathname + url.search), lib = target.protocol === "https:" ? https : http;
  let idle, finished = false;
  const up = lib.request(target, { method: req.method, headers }, (r) => {
    clearTimeout(headersTimer);
    const h = {};
    for (const k of ["content-type", "retry-after", "x-should-retry", "request-id"]) if (r.headers[k]) h[k] = r.headers[k];
    for (const [k, v] of Object.entries(r.headers)) if (k.startsWith("anthropic-ratelimit-")) h[k] = v;
    res.writeHead(r.statusCode, h);
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => { up.destroy(new Error("idle")); res.destroy(); }, MODEL_IDLE_MS); };
    bump(); r.on("data", (d) => { bump(); res.write(d); });
    r.on("end", () => { finished = true; clearTimeout(idle); res.end(); release(); log(r.statusCode < 400 ? "info" : "warn", "model request", { user: userId, path: url.pathname, status: r.statusCode, ms: Date.now() - t0 }); });
    r.on("error", () => { clearTimeout(idle); res.destroy(); release(); });
  });
  const headersTimer = setTimeout(() => up.destroy(new Error("timeout")), MODEL_HEADERS_MS);
  up.on("error", (e) => {
    clearTimeout(headersTimer); clearTimeout(idle); release();
    log("warn", "model upstream error", { user: userId, path: url.pathname, why: e.message === "timeout" ? "timeout" : e.message === "idle" ? "idle" : "network" });
    if (!res.headersSent) apiError(res, e.message === "timeout" ? 504 : 502, "api_error", e.message === "timeout" ? "The model provider didn't answer in time." : "The model provider couldn't be reached.", { "x-should-retry": "true" });
    else res.destroy();
  });
  res.on("close", () => { if (!finished) { up.destroy(); release(); } });
  req.pipe(up);
}
// The GitHub App's secret stays here. Consoles send the code exchange, refresh and revoke requests;
// the broker checks whose console it is, that a code exchange returns to this site, and adds the
// client id and secret. GitHub's answer goes back as it is (the console handles errors).
async function broker(req, res, path) {
  const key = bearer(req), userId = key && byBrokerKey.get(sha(key));
  if (!userId || req.method !== "POST") return sendJson(res, 401, { error: "unauthorized" });
  if (!GH.clientId || !GH.clientSecret) return sendJson(res, 400, { error: "not_configured" });
  let p; try { p = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "bad_request" }); }
  try {
    if (path === "/github/revoke") {
      const r = await fetch(`${GH.api}/applications/${encodeURIComponent(GH.clientId)}/token`, { method: "DELETE", headers: { authorization: `Basic ${Buffer.from(`${GH.clientId}:${GH.clientSecret}`).toString("base64")}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "ai-worker-gateway" }, body: JSON.stringify({ access_token: String(p.access_token || "") }), signal: AbortSignal.timeout(10000) });
      res.writeHead(r.status); return res.end();
    }
    const params = p.grant_type === "refresh_token" ? { grant_type: "refresh_token", refresh_token: String(p.refresh_token || "") }
      : { code: String(p.code || ""), redirect_uri: String(p.redirect_uri || ""), code_verifier: String(p.code_verifier || "") };
    if (params.redirect_uri !== undefined && p.grant_type !== "refresh_token" && params.redirect_uri !== `${PUBLIC_ORIGIN}/github/callback`) return sendJson(res, 400, { error: "redirect_uri_mismatch" });
    const r = await fetch(`${GH.web}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "ai-worker-gateway" }, body: JSON.stringify({ client_id: GH.clientId, client_secret: GH.clientSecret, ...params }), signal: AbortSignal.timeout(15000) });
    log("info", "github token request", { user: userId, kind: p.grant_type === "refresh_token" ? "refresh" : "exchange", status: r.status });
    return sendJson(res, r.status, await r.json().catch(() => ({ error: "bad_response" })));
  } catch { return sendJson(res, 502, { error: "network" }); }
}

// ---- start ----
const problems = configProblems();
if (problems.length) { console.error(`AI Worker gateway can't start:\n- ${problems.join("\n- ")}`); process.exit(1); }
prepareDirs();
users = openUsers(DATA, { uidBase: UID_BASE });
loadSessions();
claudeVersion = (spawnSync(claudeBin(), ["--version"], { encoding: "utf8", timeout: 30000 }).stdout || "").trim() || null;
const publicServer = http.createServer((req, res) => site(req, res).catch((e) => { log("error", "unhandled", { why: e.message }); if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong." }); }));
publicServer.requestTimeout = 0; // the event stream stays open; idle sockets are closed by headersTimeout/keepAlive
const modelServer = http.createServer((req, res) => modelGateway(req, res).catch(() => { if (!res.headersSent) apiError(res, 500, "api_error", "Gateway error."); }));
modelServer.requestTimeout = 0;
modelServer.listen(MODEL_PORT, "127.0.0.1", () => {
  publicServer.listen(PORT, BIND, () => log("info", "gateway started", { env: ENV, origin: PUBLIC_ORIGIN, port: PORT, modelPort: MODEL_PORT, isolation: ISOLATION, upstream: new URL(UPSTREAM).host, claude: claudeVersion }));
});
// Graceful shutdown: stop taking requests, let each console stop its live runs (they're recorded as
// interrupted), then exit.
let stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true; log("info", "shutting down", { sig });
  publicServer.close(); saveSessions(true);
  const live = [...consoles.values()].filter((c) => !c.exited);
  for (const c of live) try { c.proc.kill("SIGTERM"); } catch {}
  const deadline = Date.now() + 10000;
  while (live.some((c) => !c.exited) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const c of live) if (!c.exited) try { c.proc.kill("SIGKILL"); } catch {}
  modelServer.close(); process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
