// Before/after measurement on a real design task: the same brief, the same worker (Senior UI/UX
// Design Engineer) and model, run once with the earlier Figma tools and instructions
// (WORKER_FIGMA_LEGACY=1) and once with batches, compact reads and the efficiency rules. Numbers
// come from the console's telemetry, which is the runtime's own usage plus measured tool counts.
// Each run builds on a temporary page (created, not switched to) that is deleted afterwards.
//   node bench/figma-executor/measure-design-task.mjs <legacy|new> [task] [port]
// task: pricing (the default; results legacy.json/new.json), faq or guides (results <task>-<variant>.json).
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const [variant = "new", task = "pricing", port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, d) => fetch(BASE + p, { method: m, headers: H, body: d ? JSON.stringify(d) : undefined }).then((r) => r.json());
const DATA = join(tmpdir(), "wsui", `measure-${task}-${variant}-${Date.now()}`); mkdirSync(DATA, { recursive: true });
const OUT = join(HERE, "measure"); mkdirSync(OUT, { recursive: true });
const PAGE = `zz-measure-${task}-${variant}`, NAME = task === "pricing" ? variant : `${task}-${variant}`;
const TASKS = {
  pricing: `Design a pricing section for a guided hiking-tour company's website, 1200 px wide: a heading and a subheading, then three plan cards side by side (plan name, price per person, a one-line description, four included features, and a button), with the middle card visibly marked as the recommended plan. Use auto layout throughout and a consistent spacing scale. When it's built, export the section, look at it, and fix anything that looks wrong. Finish with a DONE: line.`,
  faq: `Design an FAQ section for a guided hiking-tour company's website, 1200 px wide: a heading and a short intro, then six questions in an accordion list (the first one expanded with its answer, the other five collapsed, each with a plus or chevron icon), and beside or below the list a contact card ("Still have questions?", one line of text and a button). Use auto layout throughout and a consistent spacing scale. When it's built, export the section, look at it, and fix anything that looks wrong. Finish with a DONE: line.`,
  guides: `Design a "Meet our guides" section for a guided hiking-tour company's website, 1200 px wide: a heading and a subheading, then six guide cards in two rows of three (a circular photo placeholder, name, role, years of experience, and two specialty tags), and below the grid a call-to-action banner with one line of text and a button. Use auto layout throughout and a consistent spacing scale. When it's built, export the section, look at it, and fix anything that looks wrong. Finish with a DONE: line.`,
};
if (!TASKS[task]) throw new Error(`unknown task ${task}: ${Object.keys(TASKS).join(", ")}`);
const BRIEF = `${TASKS[task]}

Work only on a new page named ${PAGE}: create it with figma_create_page and put your frames on it by using its id as parentId. Don't switch pages, and don't touch anything else in this file.`;

const console_ = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env: { ...process.env, WORKER_CONSOLE_PORT: port, WORKER_CONSOLE_DATA: DATA, ...(variant === "legacy" ? { WORKER_FIGMA_LEGACY: "1" } : {}) }, stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
try {
  const w = await call("POST", "/workers", JSON.parse(readFileSync(join(REPO, "workers", "senior-uiux-design-engineer.json"), "utf8")));
  const t0 = Date.now();
  const run = await call("POST", "/runs", { prompt: BRIEF, workspace: "scratch", worker: w.id });
  if (!run.id) throw new Error(JSON.stringify(run));
  let m;
  for (;;) { m = await call("GET", `/runs/${run.id}`); if (!["starting", "running"].includes(m.status)) break; if (Date.now() - t0 > 40 * 60000) { await call("POST", `/runs/${run.id}/stop`); break; } await new Promise((r) => setTimeout(r, 5000)); }
  const secs = Math.round((Date.now() - t0) / 1000);
  await call("POST", `/runs/${run.id}/end`);
  // Export what was built (independently of the worker) and remove the temporary page.
  const mcp = new Client({ name: "measure", version: "1" });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], env: { ...process.env } }));
  const j = async (name, args = {}) => JSON.parse((await mcp.callTool({ name, arguments: args })).content[0].text);
  const pages = await j("figma_list_pages"), list = Array.isArray(pages) ? pages : pages.pages || [];
  const page = list.find((p) => p.name === PAGE);
  let image = null;
  if (page) {
    const top = (await j("figma_get_document_state", { pageId: page.id })).nodes || [];
    const main = [...top].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    if (main) { const e = await j("figma_export_node", { id: main.id, format: "PNG", scale: 1 }); const p = e.path || e.file || e.filePath; if (p && existsSync(p)) { image = join(OUT, `${NAME}.png`); copyFileSync(p, image); } }
    await j("figma_delete_node", { id: page.id });
  }
  await mcp.close();
  const t = m.telemetry || {};
  // Failures, counted from the runtime's own stream: tool calls that returned an error, and batch ops that failed.
  const rawLog = readFileSync(join(DATA, "runs", `${run.id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const toolResults = rawLog.filter((x) => x.type === "user").flatMap((x) => (Array.isArray(x.message?.content) ? x.message.content : []).filter((c) => c.type === "tool_result"));
  const resultText = (c) => (typeof c.content === "string" ? c.content : (c.content || []).map((p) => p.text || "").join(""));
  const failures = { toolErrors: toolResults.filter((c) => c.is_error).length, batchOpsFailed: toolResults.map((c) => { try { return JSON.parse(resultText(c)).failed || 0; } catch { return 0; } }).reduce((a, b) => a + b, 0) };
  const result = { task, variant, when: new Date().toISOString(), status: m.status, seconds: secs, model: m.modelUsed, done: m.done || null, costUsdListEstimate: Math.round((m.costUsd || 0) * 100) / 100,
    modelRequests: t.modelRequests, turns: t.turns, context: t.context, tokens: t.tokens, tools: { total: t.tools?.total, figma: t.tools?.figma, docStateReads: t.tools?.docStateReads, docStateChars: t.tools?.docStateChars, batches: t.tools?.batches, batchOps: t.tools?.batchOps, visualChecks: t.tools?.visualChecks, byTool: t.tools?.byTool },
    failures, pageFound: !!page, image, run: run.id, data: DATA };
  writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ ...result, tools: { ...result.tools, byTool: undefined } }, null, 1));
} finally { console_.kill(); }
