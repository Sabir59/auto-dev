// Proves the dashboard's Worker Server / Figma Bridge ON/OFF switches actually control the real
// processes through worker-ui/devctl.mjs — not just UI state. Unlike the other suites, this one
// owns the whole lifecycle of its test console (it IS the thing being toggled), so it does not
// use run-suite.sh's generic pre-started console; see the `devctl` branch in run-suite.sh.
//   node bench/workspace-ui/devctl-test.mjs <consolePort> <bridgePort> <dataDir>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const [consolePort = "8797", bridgePort = "8788", dataDir = join(HERE, "devctl-data")] = process.argv.slice(2);
const DEVCTL_PORT = "8795"; // fixed, distinct from the real default (8796) so this never collides with a dev's own daemon
mkdirSync(dataDir, { recursive: true });

const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); }
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const reach = async (url, timeoutMs = 2000) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); return r.ok; } catch { return false; } };
const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(200); }
  throw new Error(`timed out waiting for: ${label}`);
};
const devctl = (method, path) => fetch(`http://127.0.0.1:${DEVCTL_PORT}${path}`, { method, headers: { "content-type": "application/json", "x-worker-console": "1" } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const children = []; // every process this test itself spawns directly (not via devctl), for cleanup
function spawnDirect(cmd, args, opts) { const c = spawn(cmd, args, { ...opts, detached: false }); children.push(c); return c; }

let devctlChild;
const errors = [];
let browser, page;

try {
  // ---- bring up the dev-control daemon, isolated from any real one on 8796 ----
  devctlChild = spawn(process.execPath, [join(REPO, "worker-ui", "devctl.mjs")], {
    cwd: REPO,
    env: { ...process.env, WORKER_CONSOLE_PORT: consolePort, FIGMA_BRIDGE_PORT: bridgePort, WORKER_CONSOLE_DEVCTL_PORT: DEVCTL_PORT, WORKER_CONSOLE_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let devctlLog = "";
  devctlChild.stdout.on("data", (d) => (devctlLog += d));
  devctlChild.stderr.on("data", (d) => (devctlLog += d));
  await waitFor(() => reach(`http://127.0.0.1:${DEVCTL_PORT}/status`), 8000, "dev-control daemon up");

  await step("devctl status: both targets start out stopped", async () => {
    const r = await devctl("GET", "/status");
    if (r.body.worker.running !== false || r.body.bridge.running !== false) throw new Error(`expected both stopped, got ${JSON.stringify(r.body)}`);
    return r.body;
  });

  // ---- bring the worker server up (through devctl) so there's a dashboard page to open ----
  await step("devctl starts the worker server directly", async () => {
    const r = await devctl("POST", "/worker/start");
    if (!r.body.ok) throw new Error(JSON.stringify(r.body));
    if (!(await reach(`http://127.0.0.1:${consolePort}/`))) throw new Error("devctl reported success but the port isn't reachable");
    return r.body;
  });

  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${consolePort}/?devctlPort=${DEVCTL_PORT}`, { waitUntil: "networkidle" });

  await step("dashboard: Worker Server switch shows ON for the already-running server", async () => {
    await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "true", null, { timeout: 8000 });
    return { checked: await page.locator("#devWorkerSw").getAttribute("aria-checked") };
  });

  await step("toggle OFF: the Worker Server switch actually stops the process", async () => {
    await page.click("#devWorkerSw");
    await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "false", null, { timeout: 8000 });
    const stillUp = await reach(`http://127.0.0.1:${consolePort}/`, 1500);
    if (stillUp) throw new Error("switch shows OFF but the port is still answering");
    return { reachable: stillUp };
  });

  await step("toggle ON: the same page (still open while the server was down) starts it again", async () => {
    await page.click("#devWorkerSw");
    await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "true", null, { timeout: 10000 });
    const up = await reach(`http://127.0.0.1:${consolePort}/`);
    if (!up) throw new Error("switch shows ON but the port isn't reachable");
    return { reachable: up };
  });

  await step("already-running, started outside devctl: dashboard detects it (worker)", async () => {
    // Stop it via devctl, then start an equivalent process directly, bypassing devctl entirely.
    const stop = await devctl("POST", "/worker/stop");
    if (!stop.body.ok) throw new Error(`setup: could not stop first: ${JSON.stringify(stop.body)}`);
    await waitFor(() => reach(`http://127.0.0.1:${consolePort}/`).then((ok) => !ok), 6000, "worker actually down before external start");
    spawnDirect(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { cwd: REPO, env: { ...process.env, WORKER_CONSOLE_PORT: consolePort, WORKER_CONSOLE_DATA: dataDir } });
    await waitFor(() => reach(`http://127.0.0.1:${consolePort}/`), 8000, "externally-started worker up");
    const st = await devctl("GET", "/status");
    if (!st.body.worker.running) throw new Error("devctl did not detect the externally-started worker");
    if (st.body.worker.startedBy !== "external") throw new Error(`expected startedBy "external", got ${st.body.worker.startedBy}`);
    // The page's own poll (every 4s) should pick this up without a reload.
    await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "true", null, { timeout: 8000 });
    return st.body.worker;
  });

  await step("stop still works gracefully on a process devctl didn't spawn (worker)", async () => {
    await page.click("#devWorkerSw");
    await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "false", null, { timeout: 8000 });
    const stillUp = await reach(`http://127.0.0.1:${consolePort}/`, 1500);
    if (stillUp) throw new Error("external worker still reachable after graceful stop");
    return { reachable: stillUp };
  });

  await step("startup failure: a port already occupied by something else is reported honestly, not as ON", async () => {
    // devctl's own start timeout is 8s, plus up to ~2s for the probe straddling that deadline —
    // measured at ~11.6s end to end for this exact scenario, so the wait here needs real headroom.
    const blocker = spawnDirect(process.execPath, ["-e", `require('http').createServer(()=>{}).listen(${consolePort},'127.0.0.1')`], {});
    try {
      await sleep(600); // let the blocker actually bind before we ask devctl to start into the same port
      await page.click("#devWorkerSw");
      await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "false" && !document.getElementById("devWorkerSw").disabled, null, { timeout: 18000 });
      const title = await page.locator("#devWorkerSw").getAttribute("title");
      if (!title || title === (await page.evaluate(() => document.getElementById("devWorkerSw").dataset.baseTitle))) throw new Error(`expected a real error in the switch's title, got ${JSON.stringify(title)}`);
      return { reportedError: title };
    } finally {
      // Always free the port, even if the assertion above failed, so later steps aren't blocked too.
      try { blocker.kill(); } catch {}
      await waitFor(() => reach(`http://127.0.0.1:${consolePort}/`).then((ok) => !ok), 4000, "blocker port freed").catch(() => {});
    }
  });

  await step("recovery: starting it again after the blocker is gone works normally", async () => {
    await page.click("#devWorkerSw");
    await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "true", null, { timeout: 10000 });
    return { reachable: await reach(`http://127.0.0.1:${consolePort}/`) };
  });

  // ---- Figma bridge: same lifecycle, through its own row in the dashboard ----
  await step("dashboard: Figma Bridge starts out OFF", async () => {
    await page.waitForFunction(() => document.getElementById("devBridgeSw").getAttribute("aria-checked") === "false", null, { timeout: 5000 });
    return { checked: await page.locator("#devBridgeSw").getAttribute("aria-checked"), state: await page.locator("#devBridgeState").innerText() };
  });

  await step("toggle ON: the Figma Bridge switch actually starts the bridge", async () => {
    await page.click("#devBridgeSw");
    await page.waitForFunction(() => document.getElementById("devBridgeSw").getAttribute("aria-checked") === "true", null, { timeout: 8000 });
    const up = await reach(`http://127.0.0.1:${bridgePort}/status`);
    if (!up) throw new Error("switch shows ON but the bridge port isn't reachable");
    return { reachable: up, state: await page.locator("#devBridgeState").innerText() };
  });

  await step("toggle OFF: the Figma Bridge switch actually stops the bridge", async () => {
    await page.click("#devBridgeSw");
    await page.waitForFunction(() => document.getElementById("devBridgeSw").getAttribute("aria-checked") === "false", null, { timeout: 8000 });
    const stillUp = await reach(`http://127.0.0.1:${bridgePort}/status`, 1500);
    if (stillUp) throw new Error("switch shows OFF but the bridge port is still answering");
    return { reachable: stillUp };
  });

  await step("already-running, started outside devctl: dashboard detects it (bridge)", async () => {
    spawnDirect(process.execPath, [join(REPO, "bridge", "server.js")], { cwd: join(REPO, "bridge"), env: { ...process.env, FIGMA_BRIDGE_PORT: bridgePort } });
    await waitFor(() => reach(`http://127.0.0.1:${bridgePort}/status`), 8000, "externally-started bridge up");
    const st = await devctl("GET", "/status");
    if (st.body.bridge.startedBy !== "external") throw new Error(`expected startedBy "external", got ${st.body.bridge.startedBy}`);
    await page.waitForFunction(() => document.getElementById("devBridgeSw").getAttribute("aria-checked") === "true", null, { timeout: 8000 });
    return st.body.bridge;
  });

  await step("stop still works gracefully on a bridge devctl didn't spawn", async () => {
    await page.click("#devBridgeSw");
    await page.waitForFunction(() => document.getElementById("devBridgeSw").getAttribute("aria-checked") === "false", null, { timeout: 8000 });
    const stillUp = await reach(`http://127.0.0.1:${bridgePort}/status`, 1500);
    if (stillUp) throw new Error("external bridge still reachable after graceful stop");
    return { reachable: stillUp };
  });

  await step("both operate independently: starting one leaves the other's state untouched", async () => {
    const before = await devctl("GET", "/status");
    if (before.body.worker.running !== true || before.body.bridge.running !== false) throw new Error(`unexpected starting point: ${JSON.stringify(before.body)}`);
    await page.click("#devBridgeSw");
    await page.waitForFunction(() => document.getElementById("devBridgeSw").getAttribute("aria-checked") === "true", null, { timeout: 8000 });
    const bothUp = await devctl("GET", "/status");
    if (!bothUp.body.worker.running || !bothUp.body.bridge.running) throw new Error(`expected both running: ${JSON.stringify(bothUp.body)}`);
    await page.click("#devWorkerSw");
    await page.waitForFunction(() => document.getElementById("devWorkerSw").getAttribute("aria-checked") === "false", null, { timeout: 8000 });
    await sleep(500);
    const after = await devctl("GET", "/status");
    if (after.body.worker.running) throw new Error("worker still shows running after its own OFF");
    if (!after.body.bridge.running) throw new Error("bridge was turned off as a side effect of stopping the worker");
    return after.body;
  });
} finally {
  // ---- cleanup: stop anything devctl is tracking, then everything this test spawned directly ----
  try { await devctl("POST", "/worker/stop"); } catch {}
  try { await devctl("POST", "/bridge/stop"); } catch {}
  for (const c of children) { try { c.kill(); } catch {} }
  if (devctlChild) { try { devctlChild.kill(); } catch {} }
  if (browser) await browser.close().catch(() => {});
}

writeFileSync(join(HERE, "devctl-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
if (results.some((r) => !r.ok) || errors.length) process.exitCode = 1;
