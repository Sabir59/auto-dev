#!/usr/bin/env node
// A worker's way to propose a change to its own definition. Two tools:
//   evolve_read_self  what the worker's owner wrote for it (steps, knowledge, hard limits…), its
//                     version, its tools, and its open proposals;
//   evolve_propose    a proposal: which of those fields change and how, why, what it uses, what's
//                     missing, and the checks a trial run must pass.
// There is no tool that approves, activates, edits or deletes anything: the console stores the
// proposal, and only the person can try it, approve it (a new version of the worker) or reject it.
// The console answers only for this run, with this run's token (EVOLVE_URL, EVOLVE_TOKEN), and only
// about this run's own worker. See worker-ui/evolve.mjs and docs/worker-evolution.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL_ = process.env.EVOLVE_URL, TOKEN = process.env.EVOLVE_TOKEN || "";
if (!URL_) { console.error("evolve-server: EVOLVE_URL is required"); process.exit(1); }
const ask = async (path, body) => {
  const r = await fetch(URL_ + path, { method: body ? "POST" : "GET", headers: { "x-aiw-evolve": TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({ error: `the console answered ${r.status}` }));
  if (!r.ok) throw new Error(j.errors?.length ? `${j.error}\n- ${j.errors.join("\n- ")}` : j.error || `the console answered ${r.status}`);
  return j;
};
const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }] });
const wrap = (fn) => async (a) => { try { return text(await fn(a || {})); } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; } };

const server = new McpServer({ name: "evolve", version: "1.0.0" });
server.registerTool("evolve_read_self", {
  description: "Your own definition as your owner wrote it (steps, knowledge, hard limits, what to do when something is missing, outcomes), its version, the tools you have, what each integration gives you, and your open proposals. Read it before proposing a change: a proposal is made against this version.",
}, wrap(() => ask("/self")));

const check = z.discriminatedUnion("type", [
  z.object({ type: z.literal("builder_entry"), model: z.string().describe("Builder model name"),
    name: z.string().optional().describe("Regular expression the entry's name must match"), url: z.string().optional().describe("Exact url path, e.g. /landing-b"),
    expect: z.object({ count: z.number().int().optional().describe("Exactly this many matching entries changed during the trial"), published: z.enum(["draft", "published", "archived"]).optional(),
      fields: z.record(z.string(), z.union([z.string(), z.object({ absent: z.literal(true) })])).optional().describe("Data fields: a regular expression each, or { absent: true }") }).optional() }),
  z.object({ type: z.literal("tool_called"), tool: z.string().describe("Tool name, e.g. builder_create_draft"), min: z.number().int().optional() }),
]);
server.registerTool("evolve_propose", {
  description: [
    "Propose a lasting change to your own definition, for your future work: when the person teaches you a convention, a procedure or a rule that should apply to every later task. (A passing preference or fact goes in a REMEMBER: line instead.)",
    "You can change only: workflow (your steps), knowledge, limitations (your hard limits), onMissing, and outcomes. Give each changed field in full (its new value), built from what evolve_read_self returned; keep what should stay. Write it generally (placeholders, not this task's specific values).",
    "You can't change your tools, integrations, requirements or access. Only claim what your tools can actually do: list the tools a procedure relies on in uses (your capability ids), and anything it would need that you don't have (an account, a connector, an API the tools don't support) in needs. Never write a procedure for something your tools can't do.",
    "Add checks that a trial run of the changed worker must pass, and the trialPrompt for that run: the console runs it and grades the checks against what actually happened. Nothing changes until the person approves it; say that to the person, and don't claim the change is active or verified.",
  ].join(" "),
  inputSchema: {
    baseVersion: z.number().int().describe("The version evolve_read_self returned"),
    title: z.string().describe("What you'll be able to do, in a few words"),
    reason: z.string().describe("Why: what the person asked for, and what's missing in your definition today"),
    expected: z.string().optional().describe("The behaviour expected after the change"),
    acceptance: z.array(z.string()).optional().describe("How the person can tell it works"),
    changes: z.object({ workflow: z.array(z.string()).optional(), knowledge: z.string().optional(), limitations: z.array(z.string()).optional(), onMissing: z.string().optional(), outcomes: z.array(z.string()).optional() }).describe("Only the fields that change, each with its full new value"),
    uses: z.array(z.string()).optional().describe("Your capability ids the procedure relies on, e.g. builder.write.draft"),
    needs: z.array(z.object({ what: z.string(), why: z.string() })).optional().describe("What's missing for any part you can't do with your tools (an account, a connector, an API)"),
    checks: z.array(check).optional(),
    trialPrompt: z.string().optional().describe("The task a trial run of the changed worker should do, so the checks can be graded"),
  },
}, wrap((a) => ask("/propose", a)));

await server.connect(new StdioServerTransport());
