// Starts the bridge when nothing is listening, and reads its status. Used by the MCP adapter
// (mcp/server.mjs), on the first Figma call that finds no bridge, and by the console's Figma
// requirement check, so nobody has to start `node bridge/server.js` by hand.
//
// What it will never do: start a second bridge over something that's listening (another program on
// the port is reported, not replaced), restart a bridge a plugin is connected to, or run anywhere
// but this computer's loopback. The plugin itself can't be started from here: Figma only runs a
// plugin when a person runs it in the editor (there's no API for it). A plugin that is already
// running reconnects by itself (plugin/ui.html retries every few seconds).
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// The protocol this bridge/server.js speaks (see its /status). A bridge without it is an older copy
// still running from before an update.
export const BRIDGE_PROTOCOL = 2;
export const LOG_FILE = join(HERE, "bridge.log");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// The bridge's status, or why there isn't one: { reachable, isBridge, outdated, status, error }.
export async function bridgeStatus(base, { timeout = 2000 } = {}) {
  let r;
  try { r = await fetch(new URL("/status", base), { signal: AbortSignal.timeout(timeout) }); }
  catch (e) { return { reachable: false, isBridge: false, outdated: false, status: null, error: e.cause?.code || e.message }; }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j || typeof j.pluginConnected !== "boolean") return { reachable: true, isBridge: false, outdated: false, status: null, error: `port answers, but not as the Figma bridge (HTTP ${r.status})` };
  return { reachable: true, isBridge: true, outdated: (j.protocol || 1) < BRIDGE_PROTOCOL, status: j, error: null };
}

// Makes sure a current bridge is listening at base. Returns { ok, started, restarted, status } or
// { ok: false, code, error, nextStep }.
export async function ensureBridge(base, { wait = 8000 } = {}) {
  const url = new URL(base);
  if (!LOOPBACK.has(url.hostname)) return { ok: false, code: "BRIDGE_UNAVAILABLE", error: `The bridge address ${url.origin} isn't on this computer, so it isn't started from here.`, nextStep: "Start the bridge on that machine." };
  const port = Number(url.port) || 80;
  let s = await bridgeStatus(base);
  if (s.isBridge && !s.outdated) return { ok: true, started: false, restarted: false, status: s.status };
  if (s.reachable && !s.isBridge) return { ok: false, code: "PORT_IN_USE", error: `Port ${port} is in use by another program (${s.error}).`, nextStep: `Free port ${port}, or set FIGMA_BRIDGE_PORT to another port for the bridge, the console and the plugin.` };
  let restarted = false;
  if (s.outdated) {
    // An older bridge from before an update. Replaced only while no plugin depends on it.
    if (s.status.pluginConnected) return { ok: true, started: false, restarted: false, status: s.status, outdated: true };
    try { await fetch(new URL("/shutdown", base), { method: "POST", signal: AbortSignal.timeout(3000) }); } catch {}
    for (let t = Date.now() + 5000; Date.now() < t && (await bridgeStatus(base, { timeout: 500 })).reachable;) await sleep(150);
    restarted = true;
  }
  if (!existsSync(join(HERE, "node_modules", "ws"))) return { ok: false, code: "MISSING_DEPENDENCY", error: "The bridge's dependency (ws) isn't installed.", nextStep: "Run npm install in the bridge folder once." };
  let exited = null;
  const start = () => {
    let fd;
    exited = null;
    try {
      fd = openSync(LOG_FILE, "a");
      const child = spawn(process.execPath, [join(HERE, "server.js")], { cwd: HERE, env: { ...process.env, FIGMA_BRIDGE_PORT: String(port) }, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
      child.once("exit", (code) => { exited = code; });
      child.once("error", (e) => { exited = e.message; });
      child.unref();
      return null;
    } catch (e) { return { ok: false, code: "BRIDGE_START_FAILED", error: `The bridge couldn't be started: ${e.message}`, nextStep: `Start it yourself: node bridge/server.js (its log: ${LOG_FILE}).` }; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  };
  const failed = start();
  if (failed) return failed;
  // Another caller may have started one at the same moment: then this one exits (port in use) and
  // that one answers, which is just as good. A replaced bridge can still hold one of its two
  // loopback ports for a moment after it stops answering: then the new one exits with 3 (port in
  // use) and is started once more.
  let retried = false;
  for (const t = Date.now() + wait; Date.now() < t;) {
    s = await bridgeStatus(base, { timeout: 500 });
    if (s.isBridge && !s.outdated) return { ok: true, started: true, restarted, status: s.status };
    if (exited === 3 && restarted && !retried && !s.reachable) { retried = true; await sleep(400); const f = start(); if (f) return f; continue; }
    if (exited !== null && !s.reachable) break;
    await sleep(200);
  }
  return { ok: false, code: "BRIDGE_START_FAILED", error: `The bridge didn't come up on port ${port}${exited !== null ? ` (it exited: ${exited})` : ""}.`, nextStep: `See ${LOG_FILE}, or start it yourself: node bridge/server.js.` };
}

// Waits until a plugin is connected (for fileKey: one in that file). Returns the last status.
export async function waitForPlugin(base, { fileKey = null, timeout = 12000 } = {}) {
  let s;
  for (const t = Date.now() + timeout; ;) {
    s = await bridgeStatus(base, { timeout: 1000 });
    const sessions = s.status?.sessions || [];
    if (s.isBridge && (fileKey ? sessions.some((x) => x.fileKey === fileKey) : s.status.pluginConnected)) return s;
    if (Date.now() >= t) return s;
    await sleep(300);
  }
}
