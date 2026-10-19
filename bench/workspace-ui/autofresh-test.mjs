// Automatic context control, end to end, with the real runtime (Haiku) and no one watching:
//  - every worker runs with the runtime's autoCompactWindow (it compacts itself mid-turn);
//  - a message to a conversation that has grown past the limit goes to a fresh session with a
//    handoff instead, by itself, and facts survive;
//  - a message sent to the old run's id is routed to the newest run; a fresh session doesn't loop;
//  - if the worker process dies during the handoff, the work still continues from the task state.
// The limit is set low (20k) so this happens in a couple of cheap turns.
//   via bench/workspace-ui/run-suite.sh autofresh
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, { DATA, WORK } = process.env;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (c, m) => { if (!c) throw new Error(m); };
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 260)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); } };
const meta = async (id) => (await call("GET", `/runs/${id}`)).body;
const events = (id) => readFileSync(join(DATA, "runs", `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lastReply = (id) => [...events(id)].reverse().find((e) => e.type === "reply")?.summary || "";
async function settle(id) { for (let i = 0; i < 200; i++) { const m = await meta(id); if (!["starting", "running"].includes(m.status)) return m; await new Promise((r) => setTimeout(r, 1500)); } throw new Error("run didn't settle"); }
async function continuedFrom(id) { for (let i = 0; i < 200; i++) { const m = await meta(id); if (m.continuedIn) return m.continuedIn; await new Promise((r) => setTimeout(r, 1500)); } throw new Error("no continuation"); }

writeFileSync(join(DATA, "console-settings.json"), JSON.stringify({ contextWarnTokens: 20000 }));
writeFileSync(join(WORK, "big-notes.txt"), Array.from({ length: 900 }, (_, i) => `Note ${i}: inventory of trail equipment, batch ${i * 7}, checked and stored in the north shed.`).join("\n"));
const ws = (await call("POST", "/workspaces", { name: "Autofresh", path: WORK, mode: "work" })).body;
const grow = async (word) => { const r = (await call("POST", "/runs", { prompt: `Read the file big-notes.txt in full. Then remember this: the project codename is ${word}. Reply with OK.`, workspace: ws.id, model: "haiku" })).body; must(r?.id, JSON.stringify(r)); await settle(r.id); return r.id; };
let A, B;

await step("every worker runs with the runtime's own auto-compaction window", async () => {
  A = await grow("HERON");
  const cmd = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8" });
  const mine = cmd.split(/\r?\n/).find((l) => l.includes(DATA.replace(/\//g, "\\")) || l.includes(DATA));
  must(mine && /autoCompactWindow\\?":\s*250000/.test(mine), (mine || "no worker process found").slice(0, 400));
  const t = (await meta(A)).telemetry;
  return { autoCompactWindow: 250000, contextFirst: t.context.first, contextNow: t.context.last };
});
await step("past the limit, the next message goes to a fresh session with a handoff, by itself; the fact survives", async () => {
  const r = (await call("POST", `/runs/${A}/message`, { text: "What is the project codename? Reply with just the word." })).body;
  must(r.autoFresh && r.autoFresh.contextWas >= 20000, JSON.stringify(r).slice(0, 300));
  B = await continuedFrom(A);
  const m = await settle(B), first = events(B).find((e) => e.type === "user")?.summary || "";
  const oldGotIt = events(A).some((e) => e.type === "user" && /codename\?/.test(e.summary));
  const reply = lastReply(B);
  must(/## Next\n.*What is the project codename/s.test(first) && /HERON/.test(reply) && !oldGotIt && m.continuedFrom === A && events(A).some((e) => e.type === "continued" && /"auto":true/.test(e.detail)), JSON.stringify({ first: first.slice(-300), reply, oldGotIt }));
  return { contextWas: r.autoFresh.contextWas, limit: r.autoFresh.limit, newRun: B, reply: reply.slice(0, 60), newFirstContext: m.telemetry?.context?.first };
});
await step("a message to the old run's id is routed to the newest run, and a fresh session doesn't loop", async () => {
  const r = (await call("POST", `/runs/${A}/message`, { text: "Reply with the single word AGAIN." })).body;
  const m = await settle(B);
  must(r.redirectedFrom === A && r.id === B && !r.autoFresh && !m.continuedIn && /AGAIN/.test(lastReply(B)), JSON.stringify({ r: { id: r.id, redirectedFrom: r.redirectedFrom, autoFresh: r.autoFresh }, continuedIn: m.continuedIn }));
  await call("POST", `/runs/${B}/end`);
  return { routedTo: r.id, autoFreshAgain: false };
});
await step("if the worker dies during the handoff, the work still continues from the task state", async () => {
  for (let i = 0; i < 60 && (await call("GET", "/runs")).body.active; i++) await new Promise((x) => setTimeout(x, 500));
  const C = await grow("OSPREY");
  const r = (await call("POST", `/runs/${C}/message`, { text: "What is the project codename? Reply with just the word." })).body;
  must(r.autoFresh, "no auto fresh session");
  await new Promise((x) => setTimeout(x, 1500));
  await call("POST", `/runs/${C}/stop`);
  const D = await continuedFrom(C);
  const m = await settle(D), first = events(D).find((e) => e.type === "user")?.summary || "";
  must(m.continuedFrom === C && /## Next\n.*codename/s.test(first) && /Original objective[\s\S]*OSPREY/.test(first), first.slice(0, 400));
  await call("POST", `/runs/${D}/end`);
  return { newRun: D, handoffFrom: "task state (the worker's own summary was cut off)", objectiveCarried: true };
});
writeFileSync(join(HERE, "autofresh-results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
