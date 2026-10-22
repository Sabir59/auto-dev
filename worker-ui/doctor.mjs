#!/usr/bin/env node
// Checks that this computer can run the AI Workspace, for a developer setting it up on their own
// machine (docs/second-developer.md). It reads and reports; it changes nothing, except with
// --seed-workers, which adds the shared worker definitions (workers/*.json) to the running console
// when none of that name exists yet. It never prints a token: the Claude login is read through
// `claude auth status`, and the GitHub token file is only checked for existence.
//   node worker-ui/doctor.mjs [--seed-workers]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = Number(process.env.WORKER_CONSOLE_PORT) || 8799, BRIDGE = Number(process.env.FIGMA_BRIDGE_PORT) || 8787, DEVCTL = Number(process.env.WORKER_CONSOLE_DEVCTL_PORT) || 8796;
const rows = [];
const add = (need, name, ok, detail, fix) => rows.push({ need, name, ok, detail, fix });
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, windowsHide: true, ...opts });
const mask = (e) => String(e || "").replace(/^(.)[^@]*@/, "$1***@");

// Tools
const major = Number(process.versions.node.split(".")[0]);
add("required", "Node.js 20 or newer", major >= 20, `v${process.versions.node}`, "Install Node.js 20+ (nodejs.org).");
const gitV = run("git", ["--version"]);
add("required", "Git", gitV.status === 0, gitV.stdout?.trim() || "not found", "Install Git (git-scm.com).");
const who = (k) => run("git", ["config", "--get", k]).stdout?.trim();
add("required", "Git identity (for commits)", !!(who("user.name") && who("user.email")), who("user.name") ? `${who("user.name")} <${mask(who("user.email"))}>` : "not set", 'git config --global user.name "Your Name" and git config --global user.email you@example.com');

// Dependencies
for (const [dir, mod] of [["mcp", "@modelcontextprotocol/sdk"], ["bridge", "ws"], ["browser-adapter", "playwright"]]) {
  add(dir === "browser-adapter" ? "optional" : "required", `npm packages in ${dir}/`, existsSync(join(REPO, dir, "node_modules", ...mod.split("/"))), mod, `cd ${dir} && npm install`);
}
if (existsSync(join(REPO, "browser-adapter", "node_modules", "playwright"))) {
  try {
    const { chromium } = await import(pathToFileURL(join(REPO, "browser-adapter", "node_modules", "playwright", "index.mjs")).href);
    const exe = chromium.executablePath();
    add("optional", "Browser for the browser tool (Chromium)", existsSync(exe), existsSync(exe) ? "installed" : "missing", "cd browser-adapter && npx playwright install chromium");
  } catch (e) { add("optional", "Browser for the browser tool (Chromium)", false, e.message.slice(0, 80), "cd browser-adapter && npx playwright install chromium"); }
}

// The Claude runtime, found the way the console finds it, and its login (the console uses ~/.claude).
function claudeCommand() {
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false };
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    if (dir && existsSync(exe)) return { cmd: exe, shell: false };
  }
  return { cmd: "claude", shell: true };
}
const claude = claudeCommand(), env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))), CLAUDE_CONFIG_DIR: process.env.WORKER_CONSOLE_CLAUDE_CONFIG_DIR || join(homedir(), ".claude") };
const ver = run(claude.cmd, ["--version"], { shell: claude.shell, env });
add("required", "Claude Code (the worker runtime)", ver.status === 0, ver.status === 0 ? ver.stdout.trim() : "not found", "npm install -g @anthropic-ai/claude-code");
if (ver.status === 0) {
  const st = run(claude.cmd, ["auth", "status", "--json"], { shell: claude.shell, env });
  let a = null; try { a = JSON.parse(st.stdout); } catch {}
  add("required", "Claude login (your own account)", !!a?.loggedIn, a?.loggedIn ? `${mask(a.email)} · ${a.subscriptionType || a.authMethod || ""}` : "not signed in", "Run: claude   (then /login), once, in a terminal");
}

// Running services (loopback only; nothing here listens on the network).
const probe = async (url, opts) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(2500), ...opts }); return { status: r.status, text: await r.text() }; } catch { return null; } };
const c = await probe(`http://127.0.0.1:${CONSOLE}/`);
add("required", `Worker console on http://localhost:${CONSOLE}`, !!c && /AI Workspace/.test(c.text), c ? (/AI Workspace/.test(c.text) ? "running" : "port used by something else") : "not running", "node worker-ui/server.mjs   (or node worker-ui/devctl.mjs for the dashboard switches)");
const b = await probe(`http://127.0.0.1:${BRIDGE}/status`);
let bj = null; try { bj = JSON.parse(b?.text || ""); } catch {}
// Not running is fine: the Figma tools start the bridge on their first call (bridge/launcher.mjs).
add("optional", `Figma bridge on localhost:${BRIDGE}`, !!bj || !b, bj ? `running${(bj.protocol || 1) < 2 ? " (an older version: restart it to update)" : ""}` : b ? "port used by something else" : "not running (starts by itself on the first Figma call)", b && !bj ? `free port ${BRIDGE}` : "cd bridge && npm start, if you want it up before any Figma call");
add("optional", "Figma plugin connected to the bridge", !!bj?.pluginConnected, bj?.pluginConnected ? `connected${bj.sessions?.length ? `: ${bj.sessions.map((x) => x.fileName).join(", ")}` : ""}` : "not connected", "Figma desktop: Plugins > Development > Import plugin from manifest (plugin/manifest.json) once; then open your file and run it (a person has to: Figma has no API for it)");
const d = await probe(`http://127.0.0.1:${DEVCTL}/`);
add("optional", `Dashboard switches helper on localhost:${DEVCTL}`, !!d, d ? "running" : "not running", "node worker-ui/devctl.mjs");

// GitHub: the console's connection (token file present?) and Git's own sign-in, which push uses.
const ghFile = join(process.env.GITHUB_CONNECTOR_DIR || join(homedir(), ".github-connector"), "credentials.json");
add("optional", "GitHub connection (console)", existsSync(ghFile), existsSync(ghFile) ? "token saved (not shown)" : "not connected", "In the console: GitHub (sidebar) > paste a fine-grained token");

// --seed-workers: the shared definitions in workers/, added to this console if missing.
if (process.argv.includes("--seed-workers")) {
  if (!c) add("required", "Seed workers", false, "console not running", "Start the console first");
  else {
    const H = { origin: `http://127.0.0.1:${CONSOLE}`, "x-worker-console": "1", "content-type": "application/json" };
    const have = new Set(((await (await fetch(`http://127.0.0.1:${CONSOLE}/workers`, { headers: H })).json()).workers || []).map((w) => w.name));
    const added = [];
    for (const f of readdirSync(join(REPO, "workers")).filter((x) => x.endsWith(".json"))) {
      const w = JSON.parse(readFileSync(join(REPO, "workers", f), "utf8"));
      if (have.has(w.name)) continue;
      const r = await fetch(`http://127.0.0.1:${CONSOLE}/workers`, { method: "POST", headers: H, body: JSON.stringify(w) });
      if (r.ok) added.push(w.name); else add("required", `Seed ${w.name}`, false, (await r.json()).error, "");
    }
    add("optional", "Shared worker definitions", true, added.length ? `added: ${added.join(", ")}` : "all present", "");
  }
}

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? "OK  " : r.need === "required" ? "FIX " : "--  "} ${r.name.padEnd(w)}  ${r.detail}${r.ok || !r.fix ? "" : `\n      -> ${r.fix}`}`);
const missing = rows.filter((r) => !r.ok && r.need === "required");
console.log(missing.length ? `\n${missing.length} required item(s) to fix.` : "\nReady. Open http://localhost:" + CONSOLE);
process.exitCode = missing.length ? 1 : 0;
