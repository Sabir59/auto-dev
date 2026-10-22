// LIVE and READ-ONLY: the Executor's lifecycle against the real Figma desktop app. Needs Figma open
// with the AI Executor plugin running in some file. Sends only reads (status, file info, document
// state, node read-back); it never changes the document. It does restart the bridge on 8787 once
// (step 5), which is what proves recovery: the plugin reconnects by itself.
//   node bench/figma-executor/live-lifecycle-test.mjs
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeStatus } from "../../bridge/launcher.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const BASE = "http://localhost:8787";
const must = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 260)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); } };
const connect = async (env = {}) => {
  const c = new Client({ name: "live-lifecycle", version: "1" });
  // no FIGMA_BRIDGE_URL: the default local bridge, with autostart, exactly as a worker gets it
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FIGMA_")));
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], env: { ...base, ...env } }));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const text = r.content?.[0]?.text || ""; let json = null; try { json = JSON.parse(text); } catch {} return { isError: !!r.isError, text, json }; };
  return { c, call, close: () => c.close() };
};

const mcp = await connect();
let file = null, node = null;
await step("1. status: READY, with the real file the plugin is running in", async () => {
  const st = await mcp.call("figma_executor_status");
  must(st.json?.state === "READY" && st.json.plugin.sessions.length >= 1 && st.json.bridge.protocol === 2, st.text);
  file = st.json.plugin.sessions[0];
  must(file.fileKey && file.fileName, `the plugin didn't report its file: ${JSON.stringify(file)}`);
  return { state: st.json.state, file: { name: file.fileName, key: file.fileKey }, bridgePid: st.json.bridge.pid };
});
await step("2. figma_use_file with the file's link pins the run to it; file info confirms the same file", async () => {
  const use = await mcp.call("figma_use_file", { url: `https://www.figma.com/design/${file.fileKey}/x` });
  const info = await mcp.call("figma_get_file_info");
  must(use.json?.state === "READY" && !info.isError && info.json.fileKey === file.fileKey, use.text + info.text);
  return { pinned: use.json.fileScope.fileKey, open: info.json.fileName };
});
await step("3. read-back verification on a real node: right values verify, a wrong one is reported", async () => {
  const doc = await mcp.call("figma_get_document_state");
  node = doc.json?.nodes?.find((n) => typeof n.width === "number");
  must(node, `no top-level node with a size on the current page: ${doc.text.slice(0, 200)}`);
  const good = await mcp.call("figma_verify_nodes", { checks: [{ id: node.id, expect: { name: node.name, type: node.type, width: node.width, height: node.height } }] });
  const bad = await mcp.call("figma_verify_nodes", { checks: [{ id: node.id, expect: { name: `${node.name} (not this)` } }] });
  must(good.json?.verified === true && bad.json?.verified === false && bad.json.results[0].mismatches[0].actual === node.name, good.text + bad.text);
  return { node: { id: node.id, name: node.name, type: node.type }, good: true, wrongNameCaught: true };
});
await step("4. scope: a run locked to another file is refused before anything reaches Figma; read-only has no edit tools", async () => {
  const other = await connect({ FIGMA_EXPECTED_FILE_KEY: "NotTheOpenFile00000000" });
  const w = await other.call("figma_get_document_state");
  await other.close();
  const ro = await connect({ FIGMA_EXECUTOR_PROFILE: "read" });
  const names = (await ro.c.listTools()).tools.map((t) => t.name);
  const info = await ro.call("figma_get_file_info");
  await ro.close();
  must(w.isError && /^FILE_NOT_OPEN:/.test(w.text), w.text);
  must(!names.some((n) => /create|modify|delete|batch|import|export|switch|rename|detach|combine|bind|set_/.test(n)) && !info.isError, JSON.stringify(names));
  return { otherFile: w.text.slice(0, 100), readOnlyTools: names.length };
});
await step("5. recovery: the bridge stops; the next call starts a new one and the real plugin reconnects by itself", async () => {
  const before = (await bridgeStatus(BASE)).status.pid;
  await fetch(`${BASE}/shutdown`, { method: "POST" });
  for (let i = 0; i < 40 && (await bridgeStatus(BASE, { timeout: 300 })).reachable; i++) await sleep(150);
  must(!(await bridgeStatus(BASE, { timeout: 300 })).reachable, "the bridge didn't stop");
  const t = Date.now(), r = await mcp.call("figma_get_file_info");
  const after = (await bridgeStatus(BASE)).status;
  must(!r.isError && r.json.fileKey === file.fileKey && after.pid !== before, r.text);
  return { oldPid: before, newPid: after.pid, msUntilAnswered: Date.now() - t, answeredBy: r.json.fileName };
});
await mcp.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
writeFileSync(join(HERE, "live-lifecycle-results.json"), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, note: "Live Figma desktop app, reads only; the document was not changed.", results }, null, 1));
process.exit(passed === results.length ? 0 : 1);
