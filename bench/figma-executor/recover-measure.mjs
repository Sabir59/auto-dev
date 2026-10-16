// Finishes a measurement whose run completed but whose export/cleanup step didn't (the result file
// is written from the console's saved run instead of its live API). Same fields as
// measure-design-task.mjs; the time is taken from the run's own log (start to the first wait).
//   node bench/figma-executor/recover-measure.mjs <variant> <task> <data dir>
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const [variant, task, DATA] = process.argv.slice(2);
const OUT = join(HERE, "measure"), PAGE = `zz-measure-${task}-${variant}`, NAME = task === "pricing" ? variant : `${task}-${variant}`;
const id = readdirSync(join(DATA, "runs")).find((f) => f.endsWith(".meta.json")).replace(".meta.json", "");
const m = JSON.parse(readFileSync(join(DATA, "runs", `${id}.meta.json`), "utf8"));
const events = readFileSync(join(DATA, "runs", `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const t0 = Date.parse(events[0].ts), t1 = Date.parse(events.find((e) => e.type === "status" && e.summary === "waiting").ts);
const rawLog = readFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const toolResults = rawLog.filter((x) => x.type === "user").flatMap((x) => (Array.isArray(x.message?.content) ? x.message.content : []).filter((c) => c.type === "tool_result"));
const resultText = (c) => (typeof c.content === "string" ? c.content : (c.content || []).map((p) => p.text || "").join(""));
const failures = { toolErrors: toolResults.filter((c) => c.is_error).length, batchOpsFailed: toolResults.map((c) => { try { return JSON.parse(resultText(c)).failed || 0; } catch { return 0; } }).reduce((a, b) => a + b, 0) };

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
const result = { task, variant, when: new Date(t1).toISOString(), status: m.status, seconds: Math.round((t1 - t0) / 1000), model: m.modelUsed, done: m.done || null, costUsdListEstimate: Math.round((m.costUsd || 0) * 100) / 100,
  modelRequests: t.modelRequests, turns: t.turns, context: t.context, tokens: t.tokens, tools: { total: t.tools?.total, figma: t.tools?.figma, docStateReads: t.tools?.docStateReads, docStateChars: t.tools?.docStateChars, batches: t.tools?.batches, batchOps: t.tools?.batchOps, visualChecks: t.tools?.visualChecks, byTool: t.tools?.byTool },
  failures, pageFound: !!page, image, run: id, data: DATA, recovered: "the run finished; its export and cleanup step failed to start (spawn UNKNOWN) and were done afterwards by recover-measure.mjs" };
writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, tools: { ...result.tools, byTool: undefined } }, null, 1));
