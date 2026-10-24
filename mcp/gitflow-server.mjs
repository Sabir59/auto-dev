#!/usr/bin/env node
// The Git workflow worker's tools. Read-only on Git: the worker reads the configuration, the commits
// a destination is missing (with their evidence), one commit's diff, and a simulated plan, and it
// saves its own explanations (notes, shown on the page as the worker's words). There is no tool that
// creates a branch, merges, pushes or changes the configuration: executing a plan is the person's
// action on the page, after their approval. Everything Git-related is decided by
// worker-ui/gitflow.mjs, not by the model.
//   GITFLOW_ROOT  the repository (the run's workspace)   GITFLOW_DIR  this worker's Git workflow data
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GitFlow, STRATEGIES, normalizeConfig } from "../worker-ui/gitflow.mjs";

const ROOT = process.env.GITFLOW_ROOT, DIR = process.env.GITFLOW_DIR;
if (!ROOT || !DIR) { console.error("gitflow-server: GITFLOW_ROOT and GITFLOW_DIR are required"); process.exit(1); }
const engine = () => {
  const f = join(DIR, "config.json");
  if (!existsSync(f)) throw new Error("This worker has no Git workflow configuration yet: the person sets it up on its Git workflow page.");
  // Through normalizeConfig: today's rules (off-limits branches) apply to a configuration saved earlier.
  return new GitFlow({ root: ROOT, dir: DIR, config: normalizeConfig({}, JSON.parse(readFileSync(f, "utf8"))) });
};
const mappingOf = (gf, id) => { const m = gf.config.mappings.find((x) => x.id === id || `${x.source}->${x.destination}` === id); if (!m) throw new Error(`No branch relationship "${id}". Known: ${gf.config.mappings.map((x) => x.id).join(", ")}`); return m; };
const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.message }] });
const wrap = (fn) => async (a) => { try { return text(await fn(a || {})); } catch (e) { return fail(e); } };

const server = new McpServer({ name: "gitflow", version: "1.0.0" });
server.registerTool("gitflow_overview", { description: "This worker's Git workflow configuration: the teams (which is the person's), the people and their identities, the branch relationships with their strategies, the exclusion rules, and the shared branches that are never written. Read it first." },
  wrap(async () => { const { config: c } = engine(); return { teams: c.teams, people: c.people, mappings: c.mappings, exclude: c.exclude, shared: c.shared, offLimits: c.forbidden, rule: "Shared branches are never pushed or written: changes reach them only by pull request. Off-limits branches are never read or written: don't discuss their contents.", proposals: c.proposals, strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.about])) }; }));
server.registerTool("gitflow_commits", { description: "The changes a destination branch is missing from its source (one branch relationship), newest first, with their kind (pull-request merge, revert, cherry-picked copy, duplicate, direct), pull request, ticket references, whether an equivalent copy is already in the destination, reverts, and ownership (team, confidence and the evidence). Optionally only one person's.", inputSchema: { mapping: z.string().describe("A branch relationship id from gitflow_overview"), person: z.string().optional().describe("A person's id, to list only their commits"), limit: z.number().int().min(1).max(300).optional() } },
  wrap(async ({ mapping, person, limit }) => {
    const gf = engine(), a = await gf.analyse(mappingOf(gf, mapping), { limit: limit || 200 });
    const rows = a.commits.filter((c) => !person || c.attribution.person === person).map((c) => ({ sha: c.sha, subject: c.subject, author: `${c.author.name} <${c.author.email}>`, date: c.date, kinds: c.kinds, pr: c.pr, tickets: c.tickets, files: c.files, presence: c.presence.text, revertedBy: c.revertedBy, reverts: c.reverts, team: c.attribution.team, confidence: c.attribution.confidence, evidence: c.attribution.evidence.map((e) => e.text), note: c.note?.summary || null }));
    return { source: a.source, destination: a.destination, pending: a.pendingCount, tasks: a.tasks.map((t) => ({ title: t.title, evidence: t.evidence, commits: t.shas })), commits: rows };
  }));
server.registerTool("gitflow_commit", { description: "One commit in full: message, author and committer, files with line counts, and its diff (long diffs are cut).", inputSchema: { sha: z.string().regex(/^[0-9a-f]{7,40}$/) } },
  wrap(async ({ sha }) => { const c = await engine().commit(sha); return { sha: c.sha, parents: c.parents, author: c.author, committer: c.committer, date: c.date, subject: c.subject, body: c.body, files: c.numstat, diff: c.diff.slice(0, 40000), diffCut: c.diffCut || c.diff.length > 40000 }; }));
server.registerTool("gitflow_preview", { description: "Simulate a plan without changing any branch: what applying these changes (or merging, or promoting these pull requests) would do, which are blocked and why (ownership, conflicts, reverts, cross-team dependencies), and what needs review. Use it to explain risks; the person decides and approves on the page.", inputSchema: { mapping: z.string(), strategy: z.enum(["selective", "ancestry", "feature"]), select: z.array(z.string()).max(100).optional().describe("Commit ids (selective) or pull request numbers (feature)") } },
  wrap(async ({ mapping, strategy, select }) => { const gf = engine(), p = await gf.preview(mappingOf(gf, mapping), { strategy, select: select || [] }); return { id: p.id, status: p.status, blockers: p.blockers, reviews: p.reviewItems.map((r) => ({ id: r.id, kind: r.kind, text: r.text })), hazards: p.hazards, items: p.items.map((i) => ({ sha: i.sha, subject: i.subject, status: i.status, reasons: i.reasons })), build: p.build }; }));
server.registerTool("gitflow_save_note", { description: "Save your explanation of one commit, shown on the Git workflow page labelled as yours: what the change actually does (2–3 plain sentences, from its diff), optionally a task name, and other commit ids that belong to the same task ONLY when the evidence shows it (same feature, same files and purpose). Never claim a ticket or relationship you can't see.", inputSchema: { sha: z.string().regex(/^[0-9a-f]{40}$/), summary: z.string().min(10).max(1200), task: z.string().max(120).optional(), related: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).max(20).optional() } },
  wrap(async ({ sha, summary, task, related }) => engine().saveNote(sha, { summary, task, related, run: process.env.GITFLOW_RUN || null })));
await server.connect(new StdioServerTransport());
