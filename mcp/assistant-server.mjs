#!/usr/bin/env node
// A worker's assistant: the owner's way to understand and change the worker in conversation. Three tools:
//   worker_inspect       the worker's configuration as it is now: identity, instructions, knowledge,
//                        skills, references, hard limits, integrations, tools, repositories, what's
//                        connected, pending changes, and what can't be changed here;
//   worker_change        a structured change. Low-risk parts are applied at once as a new version the
//                        owner can undo; removals and anything about access wait for the owner's approval;
//   worker_add_document  keep a file the owner attached in this conversation with the worker.
// There is no tool that approves a change, deletes the worker, or touches credentials or accounts. The
// console answers only for this run, with this run's token (ASSIST_URL, ASSIST_TOKEN), and only about
// the worker this conversation belongs to. See worker-ui/worker-change.mjs.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL_ = process.env.ASSIST_URL, TOKEN = process.env.ASSIST_TOKEN || "";
if (!URL_) { console.error("assistant-server: ASSIST_URL is required"); process.exit(1); }
const ask = async (path, body) => {
  const r = await fetch(URL_ + path, { method: body ? "POST" : "GET", headers: { "x-aiw-assist": TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({ error: `the console answered ${r.status}` }));
  if (!r.ok) throw new Error(j.errors?.length ? `${j.error}\n- ${j.errors.join("\n- ")}` : j.error || `the console answered ${r.status}`);
  return j;
};
const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }] });
const wrap = (fn) => async (a) => { try { return text(await fn(a || {})); } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; } };

const server = new McpServer({ name: "assistant", version: "1.0.0" });
server.registerTool("worker_inspect", {
  description: "The worker's configuration as it is now, with ids and where each part came from: identity (name, specialization, mission, objectives), instructions (steps, general knowledge, what to do when something is missing), hard limits, knowledge entries, skills, references and documents, its integrations and what they add, its tools, repository access, which accounts are connected on this console, learnings, pending changes, and what can't be changed here. Call it before answering about the worker or changing it, and again after a change.",
}, wrap(() => ask("/inspect")));

const items = (shape) => z.object({ add: z.array(shape).optional(), update: z.array(shape.partial().extend({ id: z.string() })).optional(), remove: z.array(z.string()).optional().describe("ids to remove (needs the owner's approval)") });
server.registerTool("worker_change", {
  description: [
    "Change the worker. Give only the parts that change. Based on the version worker_inspect returned (baseVersion).",
    "Applied at once, as a new version the owner can undo: identity text, instructions (each field given in full: keep what shouldn't change), adding or updating knowledge entries, skills and references, adding hard limits.",
    "Waits for the owner's approval on the worker's page: removing a hard limit, a knowledge entry, a skill or a reference; removing more than half of the steps or knowledge; anything under access (core tools, repository access, integrations).",
    "Never put a password, key or token in a change: it's refused. Accounts are connected by the owner on their pages.",
  ].join(" "),
  inputSchema: {
    baseVersion: z.number().int().describe("The version worker_inspect returned"),
    summary: z.string().describe("What this change does, in one sentence, for the owner"),
    change: z.object({
      identity: z.object({ name: z.string().optional(), specialization: z.string().optional(), mission: z.string().optional(), outcomes: z.array(z.string()).optional() }).optional(),
      instructions: z.object({ workflow: z.array(z.string()).optional().describe("All its steps, in order"), knowledge: z.string().optional().describe("Its general knowledge text, in full"), onMissing: z.string().optional() }).optional(),
      limits: z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional().describe("Exact text of limits to remove (needs approval)") }).optional(),
      knowledge: items(z.object({ title: z.string(), text: z.string() })).optional(),
      skills: items(z.object({ name: z.string(), description: z.string().describe("When to use it"), instructions: z.string().describe("The procedure, step by step") })).optional(),
      references: items(z.object({ kind: z.enum(["link", "repository", "note"]), title: z.string(), value: z.string().describe("The URL, owner/name of the repository, or the note"), branch: z.string().optional(), note: z.string().optional() })).optional(),
      access: z.object({ core: z.array(z.string()).optional().describe("All core tools it should have"), repos: z.array(z.object({ repo: z.string().describe("A registered repository id"), level: z.enum(["read", "write", "commit", "push"]) })).optional().describe("All repository access it should have"),
        integrations: z.array(z.object({ id: z.string(), version: z.string(), config: z.record(z.string(), z.any()).optional() })).optional().describe("All its integrations, pinned") }).optional().describe("Always waits for the owner's approval"),
    }),
  },
}, wrap((a) => ask("/change", a)));

server.registerTool("worker_add_document", {
  description: "Keep a file the owner attached in this conversation with the worker, as a reference document: each of the worker's later tasks gets a read-only copy. Applied at once, as a new version the owner can undo. Use the attachment's file name as this conversation shows it.",
  inputSchema: { baseVersion: z.number().int(), attachment: z.string().describe("The attached file's name"), title: z.string().describe("What the document is"), note: z.string().optional().describe("When the worker should read it") },
}, wrap((a) => ask("/document", a)));

await server.connect(new StdioServerTransport());
