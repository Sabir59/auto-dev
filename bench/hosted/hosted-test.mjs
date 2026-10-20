// Hosted platform suite: the real gateway (worker-ui/gateway.mjs), real per-person consoles, the
// real Claude Code CLI and real tools. Only the model is replaced, by the FAKE provider in
// fake-anthropic.mjs (scripted tool calls), and github.com by bench/github/mock-github.mjs.
// It proves the platform's side of hosted execution; it does not prove a live model, live GitHub or
// live Figma (see CLOUD_DEPLOYMENT.md "Live verification").
//
//   Linux, as root (the per-person uid boundary is tested):  node bench/hosted/hosted-test.mjs
//   Windows (AIW_ISOLATION=none; OS-boundary and graceful-restart steps are skipped):  same command
// Needs: the claude CLI (CLAUDE_BIN or on PATH), git, and npm installs in mcp/ and browser-adapter/.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, chownSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { startMock, APP } from "../github/mock-github.mjs";
import { resolveProvider } from "../../worker-ui/provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(HERE, "../..");
const LINUX = process.platform === "linux", ROOT = LINUX && process.getuid() === 0, ISOLATION = ROOT ? "uid" : "none";
const BASE = Number(process.env.HOSTED_TEST_PORT_BASE) || 8770; // another range when other suites hold these
const P = { site: BASE, fake: BASE + 1, model: BASE + 2, consoles: BASE + 3, gh: BASE + 15 };
const O = `http://127.0.0.1:${P.site}`;
const KEY = "sk-ant-test-" + randomBytes(20).toString("hex"); // a TEST key: the fake provider accepts only it
const DATA = mkdtempSync(join(LINUX ? "/var/tmp" : tmpdir(), "aiw-hosted-"));
if (ROOT) spawnSync("chmod", ["711", DATA]);
const results = [], gwOut = [];
const step = async (name, fn, { skip } = {}) => {
  if (skip) { results.push({ step: name, skipped: skip }); console.log("SKIP", name, "—", skip); return; }
  try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d ?? null).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures: fake provider, mock GitHub, a bare "GitHub" remote ----
const fake = await startFakeAnthropic(P.fake, { apiKey: KEY });
const script = (name, steps) => fetch(`http://127.0.0.1:${P.fake}/__script`, { method: "POST", body: JSON.stringify({ name, steps }) });
const remote = join(DATA, "remotes", "site.git"), seed = join(DATA, "remotes", "seed");
mkdirSync(seed, { recursive: true });
// (safe.directory: this test, as root, reads checkouts owned by the person uids)
const g = (cwd, ...a) => { const r = spawnSync("git", ["-c", "safe.directory=*", ...a], { cwd, encoding: "utf8" }); if (r.status) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout; };
g(DATA, "init", "-q", "--bare", "-b", "main", remote);
g(seed, "init", "-q", "-b", "main"); writeFileSync(join(seed, "README.md"), "# site\n");
g(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "add", "."); g(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-qm", "initial");
g(seed, "push", "-q", remote, "main");
const mock = await startMock(P.gh, [{ owner: "alice", name: "site", private: true, defaultBranch: "main", url: remote }]);
const ghMock = (state) => fetch(`http://127.0.0.1:${P.gh}/__mock`, { method: "POST", body: JSON.stringify(state) });
await ghMock({ installed: ["alice/site"] });

// ---- accounts (the operator's CLI) ----
const usersCli = (...a) => spawnSync(process.execPath, [join(REPO, "worker-ui", "users.mjs"), ...a], { env: { ...process.env, AIW_DATA: DATA }, encoding: "utf8", input: a.includes("--password-stdin") ? "correct-horse-battery-1\n" : undefined });
const alice = JSON.parse(usersCli("add", "alice@pilot.test", "--name", "Alice", "--password-stdin").stdout);
const bob = JSON.parse(usersCli("add", "bob@pilot.test", "--name", "Bob", "--password-stdin").stdout);
if (ROOT) spawnSync("chown", ["-R", `${alice.uid}:${alice.uid}`, join(DATA, "remotes")]); // alice's console pushes there

// ---- the gateway ----
const gwEnv = (extra = {}) => ({ PATH: process.env.PATH, ...(process.platform === "win32" ? Object.fromEntries(["SystemRoot", "windir", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "SystemDrive", "TEMP", "TMP", "USERPROFILE"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) : {}),
  ...(process.env.CLAUDE_BIN ? { CLAUDE_BIN: process.env.CLAUDE_BIN } : {}), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
  AIW_ENV: "test", AIW_DATA: DATA, AIW_PUBLIC_ORIGIN: O, AIW_PORT: String(P.site), AIW_BIND: "127.0.0.1", AIW_MODEL_PORT: String(P.model), AIW_CONSOLE_PORT_BASE: String(P.consoles), AIW_ISOLATION: ISOLATION,
  ANTHROPIC_API_KEY: KEY, ANTHROPIC_UPSTREAM_URL: `http://127.0.0.1:${P.fake}`,
  GITHUB_APP_CLIENT_ID: APP.clientId, GITHUB_APP_CLIENT_SECRET: APP.clientSecret, GITHUB_APP_SLUG: APP.slug, GITHUB_WEB_BASE: `http://127.0.0.1:${P.gh}`, GITHUB_API_BASE: `http://127.0.0.1:${P.gh}`, ...extra });
let gw;
async function startGateway() {
  gw = spawn(process.execPath, [join(REPO, "worker-ui", "gateway.mjs")], { env: gwEnv(), stdio: ["ignore", "pipe", "pipe"] });
  gw.stdout.on("data", (d) => gwOut.push(String(d))); gw.stderr.on("data", (d) => gwOut.push(String(d)));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(O + "/healthz")).ok) return; } catch {} await sleep(200); }
  throw new Error("gateway didn't start: " + gwOut.join("").slice(-500));
}
async function stopGateway() {
  const done = new Promise((r) => gw.on("exit", r));
  // Windows has no graceful signal: the whole tree (gateway, consoles, workers) is ended at once.
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(gw.pid), "/T", "/F"]); else gw.kill("SIGTERM");
  await Promise.race([done, sleep(15000)]);
}
// A browser-like client: one cookie jar, this site's Origin on changes.
function client() {
  const c = { cookie: "", setCookie: null };
  c.req = async (method, path, body, { origin = O, headers = {} } = {}) => {
    const h = { "content-type": "application/json", "x-worker-console": "1", ...(c.cookie ? { cookie: c.cookie } : {}) };
    if (origin && !["GET", "HEAD"].includes(method)) { h.origin = origin; h["sec-fetch-site"] = "same-origin"; }
    Object.assign(h, headers);
    const r = await fetch(O + path, { method, redirect: "manual", headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { c.setCookie = sc; c.cookie = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0]; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  // A new task, as the page starts one: the person's open conversation (one live worker each) is closed first.
  c.run = async (body) => {
    const { active } = (await c.req("GET", "/runs")).json;
    if (active) { await c.req("POST", `/runs/${active}/end`, {}); for (let i = 0; i < 60 && (await c.req("GET", "/runs")).json.active; i++) await sleep(250); }
    return c.req("POST", "/runs", body);
  };
  c.login = (email) => c.req("POST", "/login", { email, password: "correct-horse-battery-1" });
  return c;
}
const A = client(), B = client();
const runUntil = async (who, id, pred, ms = 90000) => {
  const t0 = Date.now(); let m;
  while (Date.now() - t0 < ms) { m = (await who.req("GET", `/runs/${id}`)).json; if (m && pred(m)) return m; await sleep(500); }
  throw new Error(`run ${id} didn't reach the expected state: ${JSON.stringify(m)?.slice(0, 300)}`);
};
const events = (who, id) => {
  // The run's log, as the page reads it (SSE replays the whole log first).
  return new Promise(async (ok) => {
    const ctl = new AbortController(), r = await fetch(`${O}/events?run=${id}`, { headers: { cookie: who.cookie }, signal: ctl.signal });
    let s = ""; const reader = r.body.getReader(), dec = new TextDecoder();
    const stop = setTimeout(() => ctl.abort(), 1200);
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; s += dec.decode(value); } } catch {}
    clearTimeout(stop);
    ok(s.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))));
  });
};
const home = (u) => join(DATA, "users", u.id);
const allFiles = (dir) => { const out = []; const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out; };

// EGRESS=1 (Linux, root): the whole suite with deploy/egress-firewall.sh active for the person uids.
// The mock github.com is on loopback here, so its port is allowed too (on a server it's the internet).
const EGRESS = ROOT && process.env.EGRESS === "1";
const unfirewall = () => { for (const ipt of ["iptables", "ip6tables"]) { spawnSync(ipt, ["-D", "OUTPUT", "-m", "owner", "--uid-owner", "20001-29999", "-j", "AIW_EGRESS"]); spawnSync(ipt, ["-F", "AIW_EGRESS"]); spawnSync(ipt, ["-X", "AIW_EGRESS"]); } };
if (EGRESS) {
  const fw = spawnSync("sh", [join(REPO, "deploy", "egress-firewall.sh")], { env: { ...process.env, AIW_UID_BASE: "20000", AIW_MODEL_PORT: String(P.model) }, encoding: "utf8" });
  if (fw.status) throw new Error("firewall: " + fw.stderr);
  spawnSync("iptables", ["-I", "AIW_EGRESS", "2", "-d", "127.0.0.1", "-p", "tcp", "--dport", String(P.gh), "-j", "RETURN"]);
  process.on("exit", unfirewall);
}
await startGateway();

// ---------------- configuration and provider ----------------
await step("config: a production gateway refuses to start without https, an API key, isolation and a real provider address", async () => {
  const r = spawnSync(process.execPath, [join(REPO, "worker-ui", "gateway.mjs")], { env: gwEnv({ AIW_ENV: "production", ANTHROPIC_API_KEY: "", AIW_ISOLATION: "none", AIW_PORT: "8769" }), encoding: "utf8", timeout: 20000 });
  assert(r.status === 1, `exit ${r.status}`);
  for (const want of ["https in production", "ANTHROPIC_API_KEY is required", "requires AIW_ISOLATION=uid"]) assert(r.stderr.includes(want), `missing "${want}" in: ${r.stderr}`);
  const t = spawnSync(process.execPath, [join(REPO, "worker-ui", "gateway.mjs")], { env: gwEnv({ AIW_ENV: "production", AIW_PUBLIC_ORIGIN: "https://aiworker.example", AIW_PORT: "8769" }), encoding: "utf8", timeout: 20000 });
  assert(t.status === 1 && t.stderr.includes("ANTHROPIC_UPSTREAM_URL must be an https provider address"), "a test upstream was accepted in production: " + t.stderr);
  assert(!r.stderr.includes(KEY) && !t.stderr.includes(KEY), "the key was printed");
  return { exit: r.status, problems: r.stderr.split("\n").filter((l) => l.startsWith("- ")).length };
});
await step("provider: hosted consoles refuse the subscription and the in-env API key; the gateway provider needs its token; no silent fallback", async () => {
  const err = (e, o) => { try { resolveProvider(e, o); return null; } catch (x) { return x.message; } };
  assert(/may not back a hosted product/.test(err({ MODEL_PROVIDER: "claude-subscription" }, { hosted: true })), "subscription accepted hosted");
  assert(/API key would be in every worker/.test(err({ MODEL_PROVIDER: "anthropic-api", ANTHROPIC_API_KEY: "x" }, { hosted: true })), "anthropic-api accepted hosted");
  assert(/needs ANTHROPIC_BASE_URL/.test(err({}, { hosted: true })), "hosted default without a gateway accepted");
  assert(/loopback/.test(err({ ANTHROPIC_BASE_URL: "https://evil.example", ANTHROPIC_AUTH_TOKEN: "t".repeat(40) }, { hosted: true })), "a remote gateway was accepted");
  assert(/unknown/.test(err({ MODEL_PROVIDER: "fake" }, {})), "an unknown provider was accepted");
  const ok = resolveProvider({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "t".repeat(40) }, { hosted: true });
  const env = ok.runtimeEnv();
  assert(!("ANTHROPIC_API_KEY" in env) && env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1", "gateway env wrong");
  return { hostedDefault: ok.id, local: resolveProvider({}, {}).id };
});

// ---------------- authentication ----------------
await step("auth: signed out, the site is the sign-in page and the API refuses (nothing reaches a console)", async () => {
  const anon = client();
  const root = await anon.req("GET", "/", undefined, { headers: { accept: "text/html" } });
  assert(root.status === 303 && root.headers.get("location") === "/login", `GET / → ${root.status}`);
  const page = await anon.req("GET", "/login");
  assert(page.status === 200 && /Sign in/.test(page.text) && page.headers.get("content-security-policy"), "no sign-in page");
  const runs = await anon.req("GET", "/runs"), post = await anon.req("POST", "/runs", { prompt: "x" });
  assert(runs.status === 401 && post.status === 401, `runs ${runs.status}, post ${post.status}`);
  assert(!existsSync(join(home(alice), "data", "runs")), "a console was started for a signed-out request");
  return { root: root.status, runs: runs.status, post: post.status };
});
await step("auth: a wrong password is refused with a generic answer; sign-in needs this site's Origin; the session cookie is HttpOnly and SameSite", async () => {
  const bad = await A.req("POST", "/login", { email: "alice@pilot.test", password: "wrong-password-000" });
  assert(bad.status === 401 && bad.json.error === "Email or password is incorrect.", `bad → ${bad.status}`);
  const unknown = await A.req("POST", "/login", { email: "nobody@pilot.test", password: "wrong-password-000" });
  assert(unknown.status === 401 && unknown.json.error === bad.json.error, "unknown account answered differently");
  const evil = await A.req("POST", "/login", { email: "alice@pilot.test", password: "correct-horse-battery-1" }, { origin: "https://evil.example" });
  assert(evil.status === 403 && !evil.headers.get("set-cookie"), `cross-site sign-in → ${evil.status}`);
  const ok = await A.login("alice@pilot.test");
  assert(ok.status === 200, `sign-in → ${ok.status}`);
  assert(/HttpOnly/.test(A.setCookie) && /SameSite=Lax/.test(A.setCookie) && /Path=\//.test(A.setCookie), A.setCookie);
  const me = await A.req("GET", "/auth/me");
  assert(me.json?.user?.email === "alice@pilot.test", "not signed in");
  assert((await B.login("bob@pilot.test")).status === 200, "bob can't sign in");
  return { cookie: A.setCookie.replace(/=[^;]+/, "=…") };
});
await step("csrf: a signed-in request from another origin, or with no Origin, changes nothing", async () => {
  const before = (await A.req("GET", "/workspaces")).json.length;
  const evil = await A.req("POST", "/workspaces", { name: "Evil", mode: "work" }, { origin: "https://evil.example" });
  const none = await A.req("POST", "/workspaces", { name: "Evil", mode: "work" }, { origin: null });
  const cross = await A.req("POST", "/workspaces", { name: "Evil", mode: "work" }, { headers: { "sec-fetch-site": "cross-site" } });
  const after = (await A.req("GET", "/workspaces")).json.length;
  assert(evil.status === 403 && none.status === 403 && cross.status === 403 && before === after, `evil ${evil.status}, none ${none.status}, cross ${cross.status}, ${before}→${after}`);
  return { evil: evil.status, none: none.status, crossSite: cross.status };
});
await step("routing: the console's local-only routes stay unreachable through path tricks", async () => {
  const raw = (path) => new Promise((ok) => { const r = http.request({ host: "127.0.0.1", port: P.site, method: "POST", path, headers: { cookie: A.cookie, origin: O, "content-type": "application/json", "x-worker-console": "1" } }, (res) => { res.resume(); ok(res.statusCode); }); r.on("error", () => ok(0)); r.end("{}"); });
  const codes = { protocolRelative: await raw("//__control/shutdown"), dotSegments: await raw("/x/../__control/shutdown"), encoded: await raw("/%5f%5fcontrol/shutdown"), plain: await raw("/__control/shutdown") };
  assert(codes.protocolRelative === 400 && codes.dotSegments === 404 && codes.plain === 404 && codes.encoded === 404, JSON.stringify(codes));
  assert((await A.req("GET", "/auth/me")).status === 200, "the console went down");
  return codes;
});
await step("auth: a forged session cookie is refused", async () => {
  const f = client(); f.cookie = `aiw_session=${randomBytes(32).toString("base64url")}`;
  const r = await f.req("GET", "/runs");
  assert(r.status === 401, `forged → ${r.status}`);
  return { status: r.status };
});

// ---------------- the console boundary and the model gateway ----------------
await step("isolation: a person's console answers only the gateway (no secret, no answer)", async () => {
  const port = P.consoles + alice.seq;
  const r = await fetch(`http://127.0.0.1:${port}/runs`, { headers: { host: `127.0.0.1:${port}` } });
  const bad = await fetch(`http://127.0.0.1:${port}/runs`, { headers: { host: `127.0.0.1:${port}`, "x-aiw-internal": "x".repeat(43) } });
  assert(r.status === 403 && bad.status === 403, `no secret → ${r.status}, wrong → ${bad.status}`);
  return { noSecret: r.status, wrongSecret: bad.status };
});
await step("model gateway: refuses requests without a console's token; the public site doesn't serve it", async () => {
  const m = (h) => fetch(`http://127.0.0.1:${P.model}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: "{}" });
  const none = await m({}), forged = await m({ authorization: `Bearer ${randomBytes(32).toString("base64url")}` }), key = await m({ "x-api-key": KEY });
  assert(none.status === 401 && forged.status === 401 && key.status === 401, `none ${none.status}, forged ${forged.status}, provider key ${key.status}`);
  const pub = await A.req("POST", "/v1/messages", {});
  assert(pub.status === 404, `public /v1/messages → ${pub.status}`);
  assert(!fake.log.length, "something reached the provider");
  return { none: none.status, forged: forged.status, publicSite: pub.status };
});

// ---------------- workspaces and a real run ----------------
let wsA, wsB;
await step("hosted workspace: a new one is a folder of the person's own; a path from the page is ignored; Executor, folder browsing and the platform's files don't exist", async () => {
  const r = await A.req("POST", "/workspaces", { name: "Site", mode: "work", path: LINUX ? "/etc" : "C:\\Windows" });
  assert(r.status === 200, JSON.stringify(r.json));
  wsA = r.json;
  assert(resolve(wsA.root).startsWith(resolve(home(alice), "data", "workspaces")), `root ${wsA.root}`);
  const list = (await A.req("GET", "/workspaces")).json.map((w) => w.id);
  assert(!list.includes("console"), "Executor is listed");
  const pick = await A.req("POST", "/pick-folder", {}), file = await A.req("GET", "/file?path=README.md"), ctl = await A.req("POST", "/__control/shutdown", {});
  assert(pick.status === 404 && file.status === 404 && ctl.status === 404, `pick ${pick.status}, file ${file.status}, shutdown ${ctl.status}`);
  wsB = (await B.req("POST", "/workspaces", { name: "Bob site", mode: "work" })).json;
  return { root: wsA.root.replace(DATA, "<data>"), list };
});
let runA;
await step("a real run: the CLI works through the gateway; a write stays in the workspace; reading outside it, shell, and a cloud-metadata fetch are refused below the model", async () => {
  writeFileSync(join(home(bob), "data", "bob-secret.txt"), "BOB-CANARY-7731\n");
  await script("basic", [
    { tool: { name: "Write", input: { file_path: join(wsA.root, "hello.txt"), content: "hello from the worker\n" } } },
    { tool: { name: "Read", input: { file_path: join(home(bob), "data", "bob-secret.txt") } } },
    { tool: { name: "Read", input: { file_path: join(DATA, "control", "users.json") } } },
    { tool: { name: "Bash", input: { command: "node -e \"console.log(process.env)\"" } } },
    { tool: { name: "WebFetch", input: { url: "http://169.254.169.254/latest/meta-data/", prompt: "show it" } } },
    { text: "DONE: wrote hello.txt" }]);
  const r = await A.run({ prompt: "Write the file. FAKE-SCRIPT:basic", workspace: wsA.id });
  assert(r.status === 200, JSON.stringify(r.json)); runA = r.json.id;
  const m = await runUntil(A, runA, (x) => x.status === "waiting");
  const ev = await events(A, runA);
  const fails = ev.filter((e) => e.type === "failure").map((e) => e.summary);
  assert(readFileSync(join(wsA.root, "hello.txt"), "utf8") === "hello from the worker\n", "file not written");
  assert(ev.some((e) => e.type === "artifact" && e.summary === "hello.txt"), "no artifact event");
  assert(fails.length >= 4, `expected 4 refusals, got ${fails.length}: ${fails.join(" | ")}`);
  assert(fails.some((f) => /bob-secret/.test(f) && /outside|denied|permission/i.test(f)), "bob's file wasn't refused");
  assert(fails.some((f) => /users\.json/.test(f)), "control file not refused");
  assert(fails.some((f) => /No such tool available: Bash/.test(f)), "shell not refused");
  assert(fails.some((f) => /WebFetch|169\.254|denied|permission/i.test(f) && !/Bash/.test(f)), "metadata fetch not refused");
  assert(!JSON.stringify(ev).includes("BOB-CANARY"), "bob's canary reached alice's run");
  assert(m.outcome === "done", `outcome ${m.outcome}`);
  return { outcome: m.outcome, refusals: fails.map((f) => f.slice(0, 90)) };
});
await step("the provider key stays in the gateway: the provider saw it, nothing else did (activity, run records, API answers, logs)", async () => {
  assert(fake.log.length && fake.log.every((e) => e.keyOk && !e.authorization), "a request reached the provider without the key, or with the console's token");
  const files = [...allFiles(home(alice)), ...allFiles(home(bob)), ...allFiles(join(DATA, "logs"))];
  const leaks = files.filter((f) => { try { return readFileSync(f, "utf8").includes(KEY); } catch { return false; } });
  assert(!leaks.length, `key found in ${leaks.join(", ")}`);
  const answers = [await A.req("GET", "/runs"), await A.req("GET", `/runs/${runA}`), await A.req("GET", "/account"), await A.req("GET", "/platform"), await A.req("GET", "/workers")];
  assert(!answers.some((a) => a.text.includes(KEY)), "key in an API answer");
  assert(!gwOut.join("").includes(KEY), "key in the gateway log");
  let procs = null;
  if (LINUX) { // the console and the worker processes, as the kernel sees them
    procs = [];
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      let envs; try { envs = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { continue; }
      if (!envs.includes(`AIW_USER_EMAIL=alice@pilot.test`) && !envs.includes(`ANTHROPIC_BASE_URL=http://127.0.0.1:${P.model}`)) continue;
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const role = argv.some((a) => a.endsWith("server.mjs") && a.includes("worker-ui")) ? "console" : /claude(\.exe)?$/.test(argv[0]) ? "worker" : "adapter";
      procs.push({ role, apiKey: envs.includes(KEY), clientSecret: envs.includes(APP.clientSecret), internalSecret: /AIW_INTERNAL_SECRET=/.test(envs) });
    }
    assert(procs.length >= 2, "didn't find the console and worker processes");
    assert(!procs.some((p) => p.apiKey || p.clientSecret), `a secret is in a process environment: ${JSON.stringify(procs)}`);
    assert(procs.some((p) => p.role === "worker") && !procs.some((p) => p.internalSecret && p.role !== "console"), `a worker or adapter has the console's internal secret: ${JSON.stringify(procs)}`);
  }
  return { providerRequests: fake.log.length, filesScanned: files.length, processes: procs };
});
await step("worker context: a defined worker in a Team gets the platform rules, Workspace, Team and its own definition; what the hosted platform lacks is named, not loaded", async () => {
  const w = await A.req("POST", "/workers", { name: "Hosted engineer", mission: "MISSION-MARK-41", capabilities: ["files.read", "files.write", "shell", "figma.plugin.edit", "web"], requirements: [{ resource: "figma", access: "edit", need: "required" }] });
  assert(w.status === 200, JSON.stringify(w.json));
  const t = await A.req("POST", "/teams", { name: "Pilot", workers: [w.json.id], workspace: wsA.id, instructions: ["TEAM-RULE-MARK-77"] });
  assert(t.status === 200, JSON.stringify(t.json));
  await script("ctx", [{ text: "NEEDS: figma edit: open the file in the Figma desktop app (not available on the platform)" }]);
  const n0 = fake.log.length;
  const r = await A.run({ prompt: "Check. FAKE-SCRIPT:ctx", team: t.json.id, worker: w.json.id });
  assert(r.status === 200, JSON.stringify(r.json));
  const m = await runUntil(A, r.json.id, (x) => x.status === "waiting");
  const req = fake.log.slice(n0).find((e) => e.script === "ctx");
  assert(req, "no model request for the run");
  for (const mark of ["MISSION-MARK-41", "TEAM-RULE-MARK-77", "# Team: Pilot", "## Workspace", "Not available in the hosted product", "NEEDS:"]) assert(req.system.includes(mark), `context lacks ${mark}`);
  assert(!req.tools.includes("Bash") && !req.tools.some((x) => x.includes("figma-executor")), `tools offered: ${req.tools.join(",")}`);
  const ev = await events(A, r.json.id);
  const reqEv = ev.find((e) => e.type === "requirements");
  assert(reqEv && /Not available in the hosted product/.test(JSON.stringify(reqEv)), "requirement status not reported");
  assert(m.outcome === "needs" && ev.some((e) => e.type === "needs"), `outcome ${m.outcome}`);
  return { outcome: m.outcome, tools: req.tools };
});
await step("Scratch (the default with no workspace): the conversation gets its own folder under the person's data; the worker writes there; it's listed only through the conversation", async () => {
  await script("scratch", [{ tool: { name: "Glob", input: { pattern: "*" } } }, { text: "waiting for the real script" }]);
  const r = await A.run({ prompt: "Scratch work. FAKE-SCRIPT:scratch" });
  assert(r.status === 200 && r.json.workspace.id === "scratch", JSON.stringify(r.json).slice(0, 200));
  const root = r.json.workspace.root;
  assert(resolve(root).startsWith(resolve(home(alice), "data", "scratch-runs")), `scratch folder ${root}`);
  await script("scratch", [{ tool: { name: "Glob", input: { pattern: "*" } } }, { tool: { name: "Write", input: { file_path: join(root, "draft.md"), content: "scratch draft\n" } } }, { text: "DONE: drafted" }]);
  await runUntil(A, r.json.id, (x) => x.status === "waiting");
  assert(readFileSync(join(root, "draft.md"), "utf8") === "scratch draft\n", "scratch file not written");
  const viaRun = await A.req("GET", `/tree?run=${r.json.id}`), viaWs = await A.req("GET", "/tree?workspace=scratch");
  assert(viaRun.json.some((e) => e.name === "draft.md") && Array.isArray(viaWs.json) && !viaWs.json.length, `run tree ${JSON.stringify(viaRun.json)}, scratch tree ${JSON.stringify(viaWs.json)}`);
  return { folder: root.replace(DATA, "<data>") };
});
await step("cancellation: Stop ends a run that's waiting on the model; the provider stream is closed", async () => {
  await script("slow", [{ delayMs: 60000, then: { text: "too late" } }]);
  const r = await A.run({ prompt: "Wait. FAKE-SCRIPT:slow", workspace: wsA.id });
  await runUntil(A, r.json.id, (x) => x.status === "running");
  for (let i = 0; i < 60 && !fake.log.some((e) => e.script === "slow"); i++) await sleep(250);
  const t0 = Date.now(), s = await A.req("POST", `/runs/${r.json.id}/stop`, {});
  assert(s.status === 200, JSON.stringify(s.json));
  const m = await runUntil(A, r.json.id, (x) => x.status === "stopped", 20000);
  for (let i = 0; i < 40 && !fake.log.find((e) => e.script === "slow")?.clientClosed; i++) await sleep(250);
  assert(fake.log.find((e) => e.script === "slow")?.clientClosed, "the provider stream stayed open");
  return { status: m.status, ms: Date.now() - t0 };
});
await step("provider failure: an error from the provider ends the turn as an error, shown in the activity", async () => {
  await script("boom", [{ error: { status: 500, type: "api_error", message: "fake provider failure", headers: { "x-should-retry": "false" } } }]);
  const r = await A.run({ prompt: "Fail. FAKE-SCRIPT:boom", workspace: wsA.id });
  const m = await runUntil(A, r.json.id, (x) => x.status === "waiting" || x.status === "failed", 120000);
  const ev = await events(A, r.json.id);
  assert(m.outcome === "error" || m.status === "failed", `status ${m.status}, outcome ${m.outcome}`);
  assert(ev.some((e) => /error/i.test(e.summary || "") && ["completed", "reply", "failure", "status"].includes(e.type)), "no error shown");
  return { status: m.status, outcome: m.outcome, lastError: m.lastError };
});
await step("rate limit: a provider 429 reaches the run as an error, not a hang", async () => {
  await script("limited", [{ error: { status: 429, type: "rate_limit_error", message: "fake rate limit", headers: { "retry-after": "120" } } }]);
  const t0 = Date.now(), r = await A.run({ prompt: "Limited. FAKE-SCRIPT:limited", workspace: wsA.id });
  const m = await runUntil(A, r.json.id, (x) => x.status === "waiting" || x.status === "failed", 120000);
  assert(m.outcome === "error" || m.status === "failed", `status ${m.status}, outcome ${m.outcome}`);
  return { status: m.status, outcome: m.outcome, seconds: Math.round((Date.now() - t0) / 1000) };
});
let runB;
await step("two people at once: concurrent runs each write only their own workspace; neither can open the other's runs, events or files by id", async () => {
  await script("mineA", [{ tool: { name: "Write", input: { file_path: join(wsA.root, "mine.txt"), content: "alice\n" } } }, { text: "DONE: a" }]);
  await script("mineB", [{ tool: { name: "Write", input: { file_path: join(wsB.root, "mine.txt"), content: "bob\n" } } }, { tool: { name: "Write", input: { file_path: join(wsA.root, "from-bob.txt"), content: "bob was here\n" } } }, { text: "DONE: b" }]);
  const [ra, rb] = await Promise.all([A.run({ prompt: "A. FAKE-SCRIPT:mineA", workspace: wsA.id }), B.run({ prompt: "B. FAKE-SCRIPT:mineB", workspace: wsB.id })]);
  runB = rb.json.id;
  await Promise.all([runUntil(A, ra.json.id, (x) => x.status === "waiting"), runUntil(B, runB, (x) => x.status === "waiting")]);
  assert(readFileSync(join(wsA.root, "mine.txt"), "utf8") === "alice\n" && readFileSync(join(wsB.root, "mine.txt"), "utf8") === "bob\n", "files crossed");
  assert(!existsSync(join(wsA.root, "from-bob.txt")), "bob's worker wrote into alice's workspace");
  const probes = { run: (await A.req("GET", `/runs/${runB}`)).status, events: (await fetch(`${O}/events?run=${runB}`, { headers: { cookie: A.cookie } })).status,
    file: (await A.req("GET", `/file?run=${runB}&path=mine.txt`)).status, message: (await A.req("POST", `/runs/${runB}/message`, { text: "hi" })).status };
  assert(Object.values(probes).every((s) => s === 404), JSON.stringify(probes));
  assert(!(await A.req("GET", "/runs")).json.runs.some((x) => x.id === runB), "bob's run is listed for alice");
  return probes;
});
await step("OS boundary (Linux): each person's folder is theirs alone (mode 700, own uid); their console and workers run as that uid; another uid can't read it", async () => {
  const st = (p) => { const s = statSync(p); return { uid: s.uid, mode: (s.mode & 0o777).toString(8) }; };
  const a = st(home(alice)), b = st(home(bob));
  assert(a.uid === alice.uid && b.uid === bob.uid && a.mode === "700" && b.mode === "700", JSON.stringify({ a, b }));
  const cat = spawnSync("setpriv", [`--reuid=${alice.uid}`, `--regid=${alice.uid}`, "--clear-groups", "cat", join(home(bob), "data", "bob-secret.txt")], { encoding: "utf8" });
  assert(cat.status !== 0 && /Permission denied/.test(cat.stderr), `alice's uid read bob's file: ${cat.stdout}${cat.stderr}`);
  const ctl = spawnSync("setpriv", [`--reuid=${alice.uid}`, `--regid=${alice.uid}`, "--clear-groups", "cat", join(DATA, "control", "users.json")], { encoding: "utf8" });
  assert(ctl.status !== 0, "a person's uid read the account store");
  const owners = new Set();
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let envs; try { envs = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { continue; }
    if (envs.includes(`WORKER_CONSOLE_DATA=${join(home(alice), "data")}`) || envs.includes(`CLAUDE_CONFIG_DIR=${join(home(alice), "claude")}`)) owners.add(statSync(`/proc/${pid}`).uid);
  }
  assert(owners.size === 1 && owners.has(alice.uid), `alice's processes run as ${[...owners]}`);
  return { alice: a, bob: b, crossRead: cat.stderr.trim().slice(0, 80), processUids: [...owners] };
}, { skip: ROOT ? null : "needs Linux and root (AIW_ISOLATION=uid); this run uses AIW_ISOLATION=none" });

// ---------------- GitHub and Git ----------------
let repoWs;
await step("Connect with GitHub: GitHub's consent returns to the public site; the code exchange goes through the gateway's broker (the console never holds the client secret)", async () => {
  const s = await A.req("POST", "/github/app/start", {});
  assert(s.status === 200, JSON.stringify(s.json));
  const auth = new URL(s.json.url);
  assert(auth.searchParams.get("redirect_uri") === `${O}/github/callback` && auth.searchParams.get("code_challenge_method") === "S256", auth.href);
  const consent = await fetch(auth.href, { redirect: "manual" }); // the mock "github.com" consents
  const back = new URL(consent.headers.get("location"));
  assert(back.origin === O && back.pathname === "/github/callback", back.href);
  const cb = await A.req("GET", back.pathname + back.search);
  assert(cb.status === 303 && cb.headers.get("location") === "/?github=connected", `${cb.status} ${cb.headers.get("location")}`);
  const gh = (await A.req("GET", "/github")).json;
  assert(gh.connected && gh.method === "app" && gh.connection.login === "alice", JSON.stringify(gh).slice(0, 300));
  const replay = await A.req("GET", back.pathname + back.search);
  assert(replay.headers.get("location") === "/?github=state", "a replayed callback was accepted");
  const brokerless = await fetch(`http://127.0.0.1:${P.model}/github/token`, { method: "POST", body: "{}" });
  assert(brokerless.status === 401, `broker without a token → ${brokerless.status}`);
  assert(!JSON.stringify(gh).includes(APP.clientSecret), "secret on the page");
  return { connectedAs: gh.connection.login, replay: replay.headers.get("location") };
});
await step("repository workspace: cloned into the person's own folder with the connection; workers get at most commit (the person pushes); the push goes to the registered remote; protected branches are refused", async () => {
  const reg = await A.req("POST", "/github/repos", { fullName: "alice/site" });
  assert(reg.status === 200, JSON.stringify(reg.json));
  const cl = await A.req("POST", `/github/repos/${reg.json.id}/clone`, { name: "Site repo", general: "push", parent: LINUX ? "/tmp" : "C:\\Windows\\Temp" });
  assert(cl.status === 200, JSON.stringify(cl.json));
  repoWs = cl.json;
  assert(resolve(repoWs.root).startsWith(resolve(home(alice), "data", "workspaces")), `clone at ${repoWs.root}`);
  const w = await A.req("POST", "/workers", { name: "Committer", capabilities: ["files.read", "files.write"], repos: [{ repo: reg.json.id, level: "push" }] });
  await script("commit", [
    { tool: { name: "mcp__repo__repo_create_branch", input: { name: "work/hosted" } } },
    { tool: { name: "Write", input: { file_path: join(repoWs.root, "change.md"), content: "a hosted change\n" } } },
    { tool: { name: "mcp__repo__repo_commit", input: { message: "Add a hosted change" } } },
    { tool: { name: "mcp__repo__repo_push", input: {} } },
    { text: "DONE: committed on work/hosted" }]);
  const n0 = fake.log.length;
  const r = await A.run({ prompt: "Commit. FAKE-SCRIPT:commit", workspace: repoWs.id, worker: w.json.id });
  assert(r.status === 200, JSON.stringify(r.json));
  await runUntil(A, r.json.id, (x) => x.status === "waiting");
  const offered = fake.log.slice(n0).find((e) => e.script === "commit")?.tools || [];
  assert(offered.includes("mcp__repo__repo_commit") && !offered.includes("mcp__repo__repo_push"), `repo tools offered: ${offered.filter((t) => t.includes("repo")).join(",")}`);
  const log = g(repoWs.root, "log", "-1", "--format=%an <%ae>|%s");
  assert(log.trim() === "Alice <alice@pilot.test>|Add a hosted change", `commit: ${log}`);
  assert(!g(remote, "branch", "--list", "work/hosted").trim(), "the worker pushed");
  const push = await A.req("POST", "/git/push", { workspace: repoWs.id });
  assert(push.status === 200 && push.json.ok, JSON.stringify(push.json));
  assert(g(remote, "rev-parse", "work/hosted").trim() === g(repoWs.root, "rev-parse", "HEAD").trim(), "the remote doesn't have the commit");
  const team = await A.req("POST", "/teams", { name: "Guarded", workers: [w.json.id], workspace: repoWs.id, policies: [{ type: "protect_branch", branch: "work/hosted" }] });
  assert(team.status === 200, JSON.stringify(team.json));
  writeFileSync(join(repoWs.root, "more.md"), "more\n");
  const commit = await A.req("POST", "/git/commit", { workspace: repoWs.id, message: "more" }), push2 = await A.req("POST", "/git/push", { workspace: repoWs.id });
  assert(commit.status === 400 && /protected/.test(commit.json.error) && push2.status === 400 && /protected/.test(push2.json.error), `commit ${commit.status} ${commit.json?.error}; push ${push2.status} ${push2.json?.error}`);
  const diff = await A.req("GET", `/git/version?workspace=${repoWs.id}&rev=WORKTREE`);
  assert(diff.json.files.some((f) => f.path === "more.md"), "worktree changes not shown");
  return { commit: log.trim(), pushed: push.json.summary, protectedRefusal: commit.json.error.slice(0, 80) };
});

// ---------------- adapters ----------------
await step("browser (hosted): refuses this server, private networks, cloud metadata and files outside the workspace, before anything loads", async () => {
  await script("browse", [
    { tool: { name: "mcp__browser-executor__browser_navigate", input: { url: `${O}/runs` } } },
    { tool: { name: "mcp__browser-executor__browser_navigate", input: { url: "http://169.254.169.254/latest/meta-data/" } } },
    { tool: { name: "mcp__browser-executor__browser_navigate", input: { url: "http://10.1.2.3/" } } },
    { tool: { name: "mcp__browser-executor__browser_navigate", input: { url: `http://localhost.:${P.model}/v1/messages` } } },
    { tool: { name: "mcp__browser-executor__browser_navigate", input: { url: LINUX ? "file:///etc/passwd" : "file:///C:/Windows/win.ini" } } },
    { tool: { name: "mcp__browser-executor__browser_navigate", input: { url: "https://example.com/" } } },
    { tool: { name: "mcp__browser-executor__browser_screenshot", input: {} } },
    { text: "DONE: tried" }]);
  const r = await A.run({ prompt: "Browse. FAKE-SCRIPT:browse", workspace: wsA.id });
  await runUntil(A, r.json.id, (x) => x.status === "waiting", 180000);
  const ev = await events(A, r.json.id);
  const navs = ev.filter((e) => ["browser_navigate", "browser_screenshot"].includes(e.tool) && (e.type === "failure" || e.type === "result")).map((e) => ({ type: e.type, summary: e.summary.slice(0, 110) }));
  assert(navs.length === 7 && navs.slice(0, 5).every((n) => n.type === "failure" && /Refused/.test(n.summary)), JSON.stringify(navs));
  // A public page loads in the run's own browser, and its screenshot lands in the person's own folder.
  assert(navs[5].type === "result" && /Example Domain/.test(navs[5].summary), `public page: ${JSON.stringify(navs[5])}`);
  const shots = allFiles(join(home(alice), "data", "browser-exports"));
  assert(navs[6].type === "result" && shots.some((f) => f.endsWith(".png")), `screenshot: ${JSON.stringify(navs[6])}; files ${shots.length}`);
  return { refused: navs.slice(0, 5).map((n) => n.summary.slice(0, 60)), publicPage: navs[5].summary.slice(0, 60), screenshots: shots.length };
});
await step("Figma: a token is checked with Figma before it's kept (live Figma API); nothing is stored when it's refused", async () => {
  const shape = await A.req("POST", "/figma/connection", { token: "not-a-token" });
  assert(shape.status === 400, `shape → ${shape.status}`);
  const r = await A.req("POST", "/figma/connection", { token: "figd_" + randomBytes(24).toString("hex") });
  assert((r.status === 400 && /Figma rejected the token/.test(r.json.error)) || (r.status === 502 && /reach Figma/.test(r.json.error)), `fake token → ${r.status} ${r.text}`);
  assert(!existsSync(join(home(alice), "figma", "credentials.json")), "a refused token was stored");
  const st = (await A.req("GET", "/figma")).json;
  assert(st.connected === false, JSON.stringify(st));
  return { refused: r.json.error, liveFigma: r.status === 400 ? "answered (token rejected)" : "unreachable from this machine" };
});

// ---------------- sessions, restart, recovery ----------------
await step("restart: a run live during a shutdown is recorded as interrupted; sessions, runs and workspaces survive; a message continues the run", async () => {
  await script("long", [{ delayMs: 120000, then: { text: "late" } }]);
  const r = await A.run({ prompt: "Long. FAKE-SCRIPT:long", workspace: wsA.id });
  await runUntil(A, r.json.id, (x) => x.status === "running");
  for (let i = 0; i < 60 && !fake.log.some((e) => e.script === "long"); i++) await sleep(250);
  await stopGateway();
  // bob's session idles past the limit while the platform is down
  const sf = join(DATA, "control", "sessions.json"), ss = JSON.parse(readFileSync(sf, "utf8"));
  for (const v of Object.values(ss)) if (v.userId === bob.id) v.seen = Date.now() - 13 * 3600e3;
  writeFileSync(sf, JSON.stringify(ss));
  await startGateway();
  const m = (await A.req("GET", `/runs/${r.json.id}`)).json;
  assert(m && m.status === "interrupted", `after restart: ${JSON.stringify(m)?.slice(0, 200)}`);
  const ev = await events(A, r.json.id);
  assert(ev.some((e) => e.type === "status" && e.summary === "interrupted"), "the log doesn't say interrupted");
  assert((await A.req("GET", "/workspaces")).json.some((w) => w.id === wsA.id), "workspace lost");
  assert((await A.req("GET", `/runs/${runA}`)).json.outcome === "done", "earlier run lost");
  assert((await B.req("GET", "/runs")).status === 401, "an idle-expired session was accepted");
  await script("long", [{ text: "Continuing after the restart." }]);
  const cont = await A.req("POST", `/runs/${r.json.id}/message`, { text: "Continue. FAKE-SCRIPT:long" });
  assert(cont.status === 200, JSON.stringify(cont.json));
  const c = await runUntil(A, r.json.id, (x) => x.status === "waiting");
  return { afterRestart: m.status, continued: c.status };
}, { skip: LINUX ? null : "graceful signals are POSIX: on Windows a stop is a hard kill" });
await step("sign-out ends the session on the server; a password change ends existing sessions", async () => {
  const old = A.cookie;
  const out = await A.req("POST", "/logout", {});
  assert(out.status === 200 && /Max-Age=0/.test(A.setCookie), "no sign-out");
  const reuse = client(); reuse.cookie = old;
  assert((await reuse.req("GET", "/runs")).status === 401, "the old cookie still works");
  const B2 = client(); assert((await B2.login("bob@pilot.test")).status === 200, "bob can't sign in again");
  assert((await B2.req("GET", "/runs")).status === 200, "bob's new session doesn't work");
  const pw = usersCli("passwd", "bob@pilot.test", "--password-stdin");
  assert(pw.status === 0, pw.stderr);
  assert((await B2.req("GET", "/runs")).status === 401, "a session survived the password change");
  return { signedOut: true, afterPasswordChange: 401 };
});
await step("sign-in rate limit: repeated failures are refused for 15 minutes", async () => {
  const c = client(); let last;
  for (let i = 0; i < 11; i++) last = await c.req("POST", "/login", { email: "carol@pilot.test", password: "nope-nope-nope-1" });
  assert(last.status === 429, `after 11 failures → ${last.status}`);
  return { status: last.status };
});

await stopGateway();
await fake.close(); mock.close?.();
const passed = results.filter((r) => r.ok).length, failed = results.filter((r) => r.ok === false).length, skipped = results.filter((r) => r.skipped).length;
writeFileSync(join(HERE, `hosted-results-${process.platform}${EGRESS ? "-egress" : ""}.json`), JSON.stringify({ when: new Date().toISOString(), platform: process.platform, isolation: ISOLATION, egressFirewall: EGRESS, node: process.version, results }, null, 1));
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped (${process.platform}, isolation ${ISOLATION})`);
if (process.env.KEEP_DATA !== "1") rmSync(DATA, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
