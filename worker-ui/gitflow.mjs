// The Git workflow engine: everything a branch-synchronisation worker needs to know or do with Git,
// done with Git itself, never decided by a model. Used by the console (worker-ui/server.mjs, the
// "Git workflow" page) and by the worker's read-only tools (mcp/gitflow-server.mjs).
//
// What it does: lists the commits a destination is missing, classifies them (pull-request merge,
// revert, cherry-picked copy, direct), attributes each to a team from configured evidence (never
// from a Git author alone), checks whether a change is already in the destination (the same commit,
// or an equivalent copy by patch id), finds reverts and possible dependencies, and simulates a plan
// (selective application, a merge that keeps ancestry, or merging a feature branch) with
// `git merge-tree`, so conflicts are predicted without touching any branch.
//
// Where it works: a private bare repository per worker (<dir>/scratch) that borrows the configured
// repository's objects (alternates) and copies its branch refs. Analysis and simulations write only
// there. The configured repository is written once, and only by execute(): after the person's
// approval, a NEW branch gitflow/<destination>-<time> is fetched into it. No existing branch is ever
// updated, nothing is pushed, nothing is rewritten.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// ---- git ----
const ENV_DROP = /^(GIT_|REPO_)/;
export function git(cwd, args, { input, allowFail = false, env = {}, timeout = 60000 } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false", ...args], {
      cwd, windowsHide: true,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_DROP.test(k))), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C", ...env } });
    const out = [], err = []; let timedOut = false;
    const t = setTimeout(() => { timedOut = true; p.kill(); }, timeout);
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => err.push(d));
    p.on("error", (e) => { clearTimeout(t); fail(new Error(`Couldn't run git: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(t);
      const so = Buffer.concat(out).toString("utf8"), se = Buffer.concat(err).toString("utf8").trim();
      if (code === 0 || allowFail) ok({ code, out: so, err: se }); else fail(new Error(timedOut ? "git timed out" : se || `git exited with ${code}`));
    });
    p.stdin.end(input);
  });
}
const out = async (cwd, args, o) => (await git(cwd, args, o)).out;
const SHA = /^[0-9a-f]{7,40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,120}$/;

// ---- configuration ----
export const STRATEGIES = {
  selective: { label: "Apply selected changes", short: "Selective", about: "Applies the chosen commits one by one onto the destination, as new commits that record the original (cherry-picked from …). Use it when the destination has to stay independent of the source. Each copy has a new identity: a later merge of the original history meets the copy again, which merges cleanly only while both stay identical. Reverts and follow-up edits made on the source later are not carried over." },
  ancestry: { label: "Merge, keeping history", short: "Merge", about: "Merges the source branch into the destination. The destination gets the original commits, so later merges recognise them, and nothing is duplicated. It brings everything the source has that the destination doesn't, so it's only safe when all of it is eligible." },
  feature: { label: "Promote feature branches", short: "Feature branches", about: "Merges the reviewed feature branches behind the selected pull requests into the destination. The same commits reach each environment, so later merges recognise them. Safe only when a feature branch was cut from the destination (or an older branch), not from a shared branch that carries other teams' unreleased work." },
};
export const DEFAULT_SHARED = ["dev-main", "uat-main", "preprod-main", "prod-main", "main", "master"];
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const list = (v, n = 20, len = 120) => (Array.isArray(v) ? v : String(v || "").split(/[,\n]/)).map((x) => clip(x, len)).filter(Boolean).slice(0, n);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "x";

// "dev-main → sabir-dev; uat-main → sabir-uat; sabir-uat → preprod-main" (→, ->, => or "to").
export function parseMappings(text) {
  const pairs = String(text || "").split(/[;\n]/).map((s) => s.split(/\s*(?:→|->|=>|\bto\b)\s*/).map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]);
  const dests = new Set(pairs.map((p) => p[1]));
  // A pair whose source is itself a destination (an isolated lane) promotes; the others synchronise.
  return pairs.map(([source, destination]) => ({ source, destination, kind: dests.has(source) ? "promote" : "sync" }));
}

export function normalizeConfig(b = {}, prev = {}) {
  const teams = (Array.isArray(b.teams) ? b.teams : prev.teams || []).slice(0, 10).map((t) => ({ id: slug(t.id || t.name), name: clip(t.name, 60), ours: !!t.ours, branchPatterns: list(t.branchPatterns, 20, 80), labels: list(t.labels, 20, 60) })).filter((t) => t.name);
  if (teams.length && !teams.some((t) => t.ours)) teams[0].ours = true;
  if (teams.filter((t) => t.ours).length > 1) throw new Error("Only one team can be yours.");
  const ids = new Set(teams.map((t) => t.id));
  const people = (Array.isArray(b.people) ? b.people : prev.people || []).slice(0, 200).map((p) => ({ id: slug(p.id || p.name || p.github), name: clip(p.name, 80), team: ids.has(p.team) ? p.team : "",
    github: clip(p.github, 60).replace(/^@/, ""), emails: list(p.emails, 10, 120).map((e) => e.toLowerCase()), names: list(p.names, 10, 80) })).filter((p) => p.name || p.github);
  const mappings = (Array.isArray(b.mappings) ? b.mappings : prev.mappings || []).slice(0, 20).map((m) => {
    if (!BRANCH.test(m.source || "") || !BRANCH.test(m.destination || "")) throw new Error(`"${m.source} → ${m.destination}" isn't a valid branch pair.`);
    if (m.source === m.destination) throw new Error(`"${m.source}" can't be its own destination.`);
    return { id: slug(`${m.source}-to-${m.destination}`), source: m.source, destination: m.destination, kind: m.kind === "promote" ? "promote" : "sync", strategy: STRATEGIES[m.strategy] ? m.strategy : m.kind === "promote" ? "feature" : "selective" };
  });
  const ex = { ...{ otherTeams: true, uncertain: true, reverted: true, merges: true }, ...(prev.exclude || {}), ...(b.exclude || {}) };
  const overrides = (Array.isArray(b.overrides) ? b.overrides : prev.overrides || []).slice(0, 200).map((o) => {
    const ref = clip(o.ref, 40).replace(/^#?(\d+)$/, "#$1");
    if (!SHA.test(ref) && !/^#\d+$/.test(ref)) throw new Error(`Override "${o.ref}": use a commit id or a pull request number (#123).`);
    if (!ids.has(o.team)) throw new Error(`Override "${o.ref}": choose one of the teams.`);
    return { ref, team: o.team, note: clip(o.note, 200) };
  });
  const tickets = list(b.tickets ?? prev.tickets ?? ["[A-Z][A-Z0-9]+-\\d+"], 5, 60).filter((r) => { try { new RegExp(r); return true; } catch { throw new Error(`Ticket pattern "${r}" isn't a valid pattern.`); } });
  return {
    workspace: clip(b.workspace ?? prev.workspace, 80), refs: (b.refs ?? prev.refs) === "local" ? "local" : "remote",
    teams, people, mappings, overrides, tickets,
    exclude: { otherTeams: !!ex.otherTeams, uncertain: !!ex.uncertain, reverted: !!ex.reverted, merges: !!ex.merges },
    shared: list(b.shared ?? prev.shared ?? DEFAULT_SHARED, 30, 120),
    proposals: !!(b.proposals ?? prev.proposals), updatedAt: new Date().toISOString(),
  };
}
// A first configuration from the worker's creation answers.
export function initialConfig({ team, others, mappings, proposals, workspace }) {
  const teams = [{ name: clip(team, 60) || "My team", ours: true, branchPatterns: [] }, ...list(others, 5, 60).map((name) => ({ name, ours: false }))];
  return normalizeConfig({ teams, people: [], mappings: parseMappings(mappings), proposals, workspace });
}

// ---- the private repository ----
export class GitFlow {
  constructor({ root, dir, config }) { this.root = root; this.dir = dir; this.config = config; this.scratch = join(dir, "scratch"); }
  get ourTeam() { return this.config.teams.find((t) => t.ours) || null; }
  ref(branch) { return this.config.refs === "remote" ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`; }
  // Brings the private repository up to date with the configured one: reads it, writes only here.
  async sync() {
    if (!existsSync(join(this.root, ".git")) && !existsSync(join(this.root, "HEAD"))) throw new Error("The workspace isn't a Git repository.");
    let objects = (await out(this.root, ["rev-parse", "--git-common-dir"])).trim();
    objects = join(isAbsolute(objects) ? objects : resolve(this.root, objects), "objects");
    if (!existsSync(join(this.scratch, "HEAD"))) { mkdirSync(this.scratch, { recursive: true }); await out(this.scratch, ["init", "-q", "--bare"]); }
    mkdirSync(join(this.scratch, "objects", "info"), { recursive: true });
    writeFileSync(join(this.scratch, "objects", "info", "alternates"), objects.replace(/\\/g, "/") + "\n");
    await out(this.scratch, ["fetch", "-q", "--prune", "--no-tags", "--no-write-fetch-head", this.root, "+refs/heads/*:refs/heads/*", "+refs/remotes/*:refs/remotes/*"], { timeout: 180000 });
    this.synced = true;
  }
  run(args, o) { return out(this.scratch, args, o); }
  async tip(branch) {
    const r = await git(this.scratch, ["rev-parse", "--verify", "-q", `${this.ref(branch)}^{commit}`], { allowFail: true });
    if (r.code) throw new Error(`Branch "${branch}" isn't in the repository${this.config.refs === "remote" ? " as origin/" + branch + " (as last fetched)" : ""}.`);
    return r.out.trim();
  }

  // Commits with their metadata and changed files. `range` is git rev-list syntax.
  async commits(range, { limit = 400, firstParent = false } = {}) {
    const raw = await this.run(["log", `--max-count=${limit}`, ...(firstParent ? ["--first-parent"] : []), "--name-only", "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1f", ...range, "--"], { timeout: 120000 });
    return raw.split("\x1e").filter((r) => r.trim()).map((r) => {
      const f = r.split("\x1f");
      return { sha: f[0], parents: f[1].split(" ").filter(Boolean), author: { name: f[2], email: f[3].toLowerCase() }, committer: { name: f[4], email: f[5].toLowerCase() },
        date: f[6], subject: f[7], body: f[8], files: (f[9] || "").split("\n").map((x) => x.trim()).filter(Boolean) };
    });
  }
  // Stable patch ids (equal for the same change, whatever its commit id).
  async patchIds(range, limit = 1000) {
    const shas = (await this.run(["rev-list", "--no-merges", `--max-count=${limit}`, ...range])).split("\n").filter(Boolean);
    if (!shas.length) return new Map();
    const diffs = await this.run(["diff-tree", "-p", "--stdin"], { input: shas.join("\n") + "\n", timeout: 180000 });
    const ids = await this.run(["patch-id", "--stable"], { input: diffs, timeout: 180000 });
    const m = new Map(); for (const line of ids.split("\n")) { const [pid, sha] = line.trim().split(" "); if (pid && sha) m.set(sha, pid); }
    return m;
  }
  // Which pull request brought each commit into `branch`: a first-parent "Merge pull request #N from
  // owner/branch" merge whose second side contains it, or a squashed "Title (#N)" commit.
  async pullRequests(range, limit = 300) {
    const merges = await this.commits([...range], { limit, firstParent: true });
    const byCommit = new Map(), prs = [];
    for (const m of merges) {
      const pr = /^Merge pull request #(\d+) from ([^\s]+)/.exec(m.subject), squash = /\(#(\d+)\)\s*$/.exec(m.subject);
      if (pr && m.parents.length > 1) {
        const head = m.parents[1], branch = pr[2].replace(/^[^/]+\//, "");
        const inner = (await this.run(["rev-list", `${m.parents[0]}..${head}`])).split("\n").filter(Boolean);
        const p = { number: +pr[1], branch, merge: m.sha, head, title: m.body.split("\n")[0] || "", commits: inner };
        prs.push(p); for (const c of inner) if (!byCommit.has(c)) byCommit.set(c, p); byCommit.set(m.sha, p);
      } else if (squash) { const p = { number: +squash[1], branch: "", merge: m.sha, head: m.sha, title: m.subject, commits: [m.sha], squashed: true }; prs.push(p); byCommit.set(m.sha, p); }
    }
    return { byCommit, prs };
  }

  // Who a change belongs to, from configured evidence. A Git author alone is never "confirmed".
  attribute(c, pr) {
    const ev = [], cfg = this.config, teamOf = (id) => cfg.teams.find((t) => t.id === id);
    const person = cfg.people.find((p) => p.emails.includes(c.author.email)) || cfg.people.find((p) => p.names.some((n) => n.toLowerCase() === c.author.name.toLowerCase()) || (p.name && p.name.toLowerCase() === c.author.name.toLowerCase()));
    const ov = cfg.overrides.find((o) => (o.ref.startsWith("#") ? pr && `#${pr.number}` === o.ref : c.sha.startsWith(o.ref)));
    if (ov) ev.push({ kind: "override", team: ov.team, strength: 3, text: `Explicit override${ov.note ? `: ${ov.note}` : ""} (${ov.ref})` });
    const glob = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    if (pr?.branch) for (const t of cfg.teams) if (t.branchPatterns.some((p) => glob(p).test(pr.branch))) ev.push({ kind: "pr-branch", team: t.id, strength: 2, text: `Pull request #${pr.number} came from ${pr.branch}, which matches ${t.name}'s branch pattern` });
    const byEmail = cfg.people.find((p) => p.emails.includes(c.author.email));
    if (byEmail?.team) ev.push({ kind: "author-email", team: byEmail.team, strength: 2, text: `Author email ${c.author.email} is ${byEmail.name || byEmail.github}'s (${teamOf(byEmail.team)?.name})` });
    else { const byName = cfg.people.find((p) => p.team && (p.names.some((n) => n.toLowerCase() === c.author.name.toLowerCase()) || p.name.toLowerCase() === c.author.name.toLowerCase())); if (byName) ev.push({ kind: "author-name", team: byName.team, strength: 1, text: `Author name "${c.author.name}" matches ${byName.name} (${teamOf(byName.team)?.name}); names aren't unique, so this is weak` }); }
    const byCommitter = c.committer.email !== c.author.email && cfg.people.find((p) => p.emails.includes(c.committer.email));
    if (byCommitter?.team) ev.push({ kind: "committer", team: byCommitter.team, strength: 1, text: `Committed by ${byCommitter.name || c.committer.email} (${teamOf(byCommitter.team)?.name}); a committer can apply someone else's change` });
    if (ov) return { team: ov.team, confidence: "confirmed", person: person?.id || null, evidence: ev };
    const teams = [...new Set(ev.map((e) => e.team))];
    if (!ev.length) return { team: null, confidence: "unknown", person: null, evidence: [{ kind: "none", strength: 0, text: `No rule matches ${c.author.name} <${c.author.email}>: add them to a team, or add an override` }] };
    if (teams.length > 1) return { team: null, confidence: "uncertain", person: person?.id || null, evidence: [...ev, { kind: "conflict", strength: 0, text: `The evidence disagrees: ${teams.map((t) => teamOf(t)?.name).join(" vs ")}` }] };
    const strong = new Set(ev.filter((e) => e.strength >= 2).map((e) => e.kind));
    return { team: teams[0], confidence: strong.size >= 2 ? "confirmed" : strong.size === 1 ? "likely" : "uncertain", person: person?.id || null, evidence: ev };
  }

  // Everything about a mapping's pending changes: what the source has that the destination doesn't.
  async analyse(mapping, { scope = "pending", limit = 300 } = {}) {
    if (!this.synced) await this.sync();
    const src = await this.tip(mapping.source), dst = await this.tip(mapping.destination);
    const pending = await this.commits([`${dst}..${src}`], { limit });
    const recent = scope === "recent" ? await this.commits([src], { limit }) : [];
    const { byCommit, prs } = await this.pullRequests([`${dst}..${src}`]);
    const pending_pid = await this.patchIds([`${dst}..${src}`]), dest_pid = await this.patchIds([`${src}..${dst}`]);
    const destByPid = new Map(); for (const [sha, pid] of dest_pid) if (!destByPid.has(pid)) destByPid.set(pid, sha);
    const srcByPid = new Map(); for (const [sha, pid] of pending_pid) (srcByPid.get(pid) || srcByPid.set(pid, []).get(pid)).push(sha);
    const all = scope === "recent" ? recent : pending, pendingSet = new Set(pending.map((c) => c.sha));
    const reverts = new Map(); // reverted sha → the revert commit
    for (const c of [...pending, ...(await this.commits([`${src}..${dst}`], { limit: 300 }))]) { const m = /This reverts commit ([0-9a-f]{7,40})/.exec(c.body); if (m) reverts.set(m[1], c); }
    const notes = this.notes();
    const tick = this.config.tickets.map((r) => new RegExp(`\\b(${r})\\b`, "g"));
    const rows = all.map((c) => {
      const pr = byCommit.get(c.sha) || null, pid = pending_pid.get(c.sha);
      const kinds = [];
      if (c.parents.length > 1) kinds.push(pr && pr.merge === c.sha ? "pr-merge" : "merge");
      const rev = /This reverts commit ([0-9a-f]{7,40})/.exec(c.body); if (rev) kinds.push("revert");
      const picked = /\(cherry picked from commit ([0-9a-f]{7,40})\)/.exec(c.body); if (picked) kinds.push("cherry-pick");
      const copyInDest = pid && destByPid.get(pid), dupes = pid ? (srcByPid.get(pid) || []).filter((s) => s !== c.sha) : [];
      if (dupes.length) kinds.push("duplicate");
      if (!kinds.length) kinds.push("direct");
      const presence = !pendingSet.has(c.sha) ? { state: "same", text: "In the destination (the same commit)" }
        : copyInDest ? { state: "copy", sha: copyInDest, text: `An equivalent change is already in the destination (${copyInDest.slice(0, 9)}, same patch, different commit)` }
        : { state: "missing", text: "Not in the destination" };
      const revertedBy = [...reverts.entries()].find(([s]) => c.sha.startsWith(s))?.[1] || null;
      const tickets = [...new Set(tick.flatMap((r) => [...`${c.subject}\n${c.body}`.matchAll(r)].map((m) => m[1])))];
      return { sha: c.sha, short: c.sha.slice(0, 9), subject: c.subject, author: c.author, committer: c.committer, date: c.date, parents: c.parents, files: c.files, kinds,
        pr: pr ? { number: pr.number, branch: pr.branch, merge: pr.merge, squashed: !!pr.squashed } : null, tickets,
        reverts: rev ? rev[1] : null, revertedBy: revertedBy ? { sha: revertedBy.sha, short: revertedBy.sha.slice(0, 9), subject: revertedBy.subject } : null,
        pickedFrom: picked ? picked[1] : null, duplicates: dupes, presence, attribution: this.attribute(c, pr), note: notes[c.sha] || null };
    });
    // Tasks: grouped only on evidence. A pull request, then a ticket reference; anything else alone.
    const tasks = [], seen = new Set();
    for (const p of prs) { const shas = rows.filter((r) => r.pr?.number === p.number).map((r) => r.sha); if (shas.length) { tasks.push({ id: `pr-${p.number}`, kind: "pr", title: `#${p.number}${p.branch ? ` · ${p.branch}` : ""}${p.title ? ` · ${p.title}` : ""}`, evidence: p.squashed ? "Squashed pull request (number in the commit subject)" : "Merged as one pull request (its merge commit's second parent)", shas }); shas.forEach((s) => seen.add(s)); } }
    const byTicket = new Map(); for (const r of rows) if (!seen.has(r.sha)) for (const t of r.tickets) (byTicket.get(t) || byTicket.set(t, []).get(t)).push(r.sha);
    for (const [t, shas] of byTicket) { const left = shas.filter((s) => !seen.has(s)); if (left.length) { tasks.push({ id: `ticket-${t}`, kind: "ticket", title: t, evidence: `The same reference (${t}) in the commit messages`, shas: left }); left.forEach((s) => seen.add(s)); } }
    for (const r of rows) if (!seen.has(r.sha)) tasks.push({ id: `c-${r.short}`, kind: "single", title: r.subject, evidence: "No pull request or ticket links it to other commits", shas: [r.sha], suggested: r.note?.related?.length ? r.note.related : undefined });
    return { mapping, source: { branch: mapping.source, tip: src }, destination: { branch: mapping.destination, tip: dst }, scope, pendingCount: pending.length, truncated: all.length >= limit, commits: rows, tasks, prs: prs.map(({ commits, ...p }) => ({ ...p, size: commits.length })) };
  }

  async commit(sha) {
    if (!SHA.test(sha)) throw new Error("Not a commit id.");
    if (!this.synced) await this.sync();
    const [c] = await this.commits([sha], { limit: 1 });
    if (!c) throw new Error("No such commit.");
    const asMerge = c.parents.length > 1 ? ["--diff-merges=first-parent"] : []; // a merge: what it brought into its branch
    const stat = await this.run(["show", "--format=", "--numstat", ...asMerge, sha]);
    let diff = await this.run(["show", "--format=", "-p", ...asMerge, sha], { timeout: 60000 });
    const raw = await this.run(["show", "-s", "--format=fuller", sha]);
    const cut = diff.length > 200000; if (cut) diff = diff.slice(0, 200000);
    return { ...c, raw, numstat: stat.split("\n").filter(Boolean).map((l) => { const [a, d, p] = l.split("\t"); return { path: p, added: a, deleted: d }; }), diff, diffCut: cut, note: this.notes()[c.sha] || null };
  }

  // ---- plans ----
  // A plan for applying `select` (commit ids, or pull request numbers for the feature strategy) from
  // the mapping's source to its destination, simulated in the private repository. Deterministic: the
  // same inputs and branch tips give the same plan id.
  async preview(mapping, { strategy, select = [], identity = null } = {}) {
    if (!STRATEGIES[strategy]) throw new Error("Choose a strategy.");
    const a = await this.analyse(mapping, { scope: "pending", limit: 1000 });
    const ours = this.ourTeam?.id, ex = this.config.exclude, bySha = new Map(a.commits.map((c) => [c.sha, c]));
    const teamName = (id) => this.config.teams.find((t) => t.id === id)?.name || "no team";
    const items = [], blockers = [], reviews = [], hazards = [], deps = [];
    const ownership = (c) => {
      const at = c.attribution, why = [];
      if (at.confidence === "unknown" || at.confidence === "uncertain") why.push(`Ownership is ${at.confidence}`);
      else if (at.team !== ours) why.push(`Belongs to ${teamName(at.team)} (${at.confidence})`);
      return why;
    };
    const sel = new Set(select.map(String));
    let order = [], prsChosen = [];
    if (strategy === "feature") {
      prsChosen = a.prs.filter((p) => sel.has(String(p.number)) || sel.has(`#${p.number}`));
      if (!prsChosen.length) throw new Error("Choose at least one pull request to promote.");
    } else if (strategy === "ancestry") order = a.commits.slice().reverse();
    else {
      for (const s of sel) if (!SHA.test(s) || ![...bySha.keys()].some((k) => k.startsWith(s))) throw new Error(`${s} isn't one of the changes waiting for ${mapping.destination}.`);
      order = a.commits.slice().reverse().filter((c) => [...sel].some((s) => c.sha.startsWith(s)));
      if (!order.length) throw new Error("Select at least one change.");
    }
    const dst = a.destination.tip;
    // Selective: each change checked, then simulated on top of the previous result (cherry-pick
    // semantics: merge-tree with the commit's parent as the base).
    let cur = dst, applied = 0;
    if (strategy === "selective") {
      const chosen = new Set(order.map((c) => c.sha));
      for (const c of order) {
        const it = { sha: c.sha, short: c.short, subject: c.subject, attribution: c.attribution, kinds: c.kinds, status: "apply", reasons: [] };
        items.push(it);
        if (c.parents.length > 1) { it.status = "excluded"; it.reasons.push("A merge commit: select the commits it brought in, or promote its feature branch"); continue; }
        if (c.presence.state !== "missing") { it.status = "present"; it.reasons.push(c.presence.text); continue; }
        // Your exclusion rules decide whether a doubtful change blocks the plan or only needs review.
        const own = ownership(c);
        if (own.length) {
          const strict = c.attribution.team && c.attribution.team !== ours && ["confirmed", "likely"].includes(c.attribution.confidence) ? ex.otherTeams : ex.uncertain;
          if (strict) { it.status = "blocked"; it.reasons.push(...own, "Excluded by your rules: correct the attribution (people, branch patterns or an override) or deselect it"); blockers.push(`${c.short}: ${own.join("; ")}`); }
          else { it.reasons.push(...own, "Your rules allow it: review it before approving"); reviews.push(`${c.short}: ${own.join("; ")}`); }
        }
        if (c.revertedBy && !chosen.has(c.revertedBy.sha)) {
          const why = `Reverted later by ${c.revertedBy.short} ("${c.revertedBy.subject}"): applying it would bring back reverted code`;
          hazards.push({ kind: "revert", sha: c.sha, text: `${c.short} was reverted by ${c.revertedBy.short}` });
          if (ex.reverted) { it.status = "blocked"; it.reasons.push(why); blockers.push(`${c.short}: reverted later`); } else { it.reasons.push(why); reviews.push(`${c.short}: reverted later`); }
        }
        if (c.duplicates.length) hazards.push({ kind: "duplicate", sha: c.sha, text: `${c.short} has an equivalent copy in the source (${c.duplicates.map((d) => d.slice(0, 9)).join(", ")}): only one should be applied` });
        // Possible dependencies: earlier pending changes, not selected and not in the destination, that touch the same files.
        const earlier = a.commits.filter((o) => !chosen.has(o.sha) && o.parents.length === 1 && o.presence.state === "missing" && new Date(o.date) <= new Date(c.date) && o.files.some((f) => c.files.includes(f)));
        for (const o of earlier) { const other = o.attribution.team !== ours; deps.push({ sha: c.sha, short: c.short, on: o.sha, onShort: o.short, onSubject: o.subject, team: teamName(o.attribution.team), crossTeam: other, files: o.files.filter((f) => c.files.includes(f)) }); }
        if (it.status !== "apply") continue;
        const sim = await git(this.scratch, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${c.parents[0]}`, cur, c.sha], { allowFail: true });
        const [tree, ...rest] = sim.out.trim().split("\n");
        if (sim.code === 1) { it.status = "conflict"; it.conflicts = rest.filter(Boolean); it.reasons.push(`Conflicts in ${it.conflicts.join(", ")} when applied onto ${mapping.destination}${applied ? " (after the changes above)" : ""}`); blockers.push(`${c.short}: predicted conflict`); continue; }
        if (sim.code !== 0) throw new Error(`Couldn't simulate ${c.short}: ${sim.err}`);
        cur = (await this.run(["commit-tree", tree, "-p", cur, "-F", "-"], { input: `${c.subject}\n\n${c.body ? c.body.trim() + "\n\n" : ""}(cherry picked from commit ${c.sha})\n`, env: commitEnv(c, identity) })).trim();
        applied++;
      }
      for (const d of deps) (d.crossTeam ? blockers : reviews).push(`${d.short} may depend on ${d.onShort} (${d.team}, not selected): both change ${d.files.join(", ")}`);
    } else {
      // Ancestry and feature: what the merge would bring, and whether all of it is eligible.
      const heads = strategy === "ancestry" ? [{ head: a.source.tip, label: mapping.source }] : prsChosen.map((p) => ({ head: p.head, label: `#${p.number} ${p.branch}`, pr: p }));
      for (const h of heads) {
        const brings = await this.commits([`${cur}..${h.head}`], { limit: 1000 });
        for (const c of brings.reverse()) {
          const known = bySha.get(c.sha); const at = known?.attribution || this.attribute(c, null);
          const it = { sha: c.sha, short: c.sha.slice(0, 9), subject: c.subject, attribution: at, kinds: known?.kinds || (c.parents.length > 1 ? ["merge"] : ["direct"]), status: "apply", reasons: [`Brought by merging ${h.label}`], via: h.label };
          if (c.parents.length === 1) {
            const own = ownership({ attribution: at });
            const strict = at.team && at.team !== ours && ["confirmed", "likely"].includes(at.confidence) ? ex.otherTeams : ex.uncertain;
            if (own.length && strict) { it.status = "blocked"; it.reasons.push(...own, "A merge can't leave it out: everything the branch carries comes along"); blockers.push(`${it.short}: ${own.join("; ")} (carried by ${h.label})`); }
            else if (own.length) { it.reasons.push(...own, "Your rules allow it: review it before approving"); reviews.push(`${it.short}: ${own.join("; ")} (carried by ${h.label})`); }
          }
          if (known?.revertedBy) hazards.push({ kind: "revert", sha: c.sha, text: `${it.short} is reverted by ${known.revertedBy.short}; a merge keeps both, so the result follows the source` });
          items.push(it);
        }
        const sim = await git(this.scratch, ["merge-tree", "--write-tree", "--name-only", "--no-messages", cur, h.head], { allowFail: true });
        const [tree, ...rest] = sim.out.trim().split("\n");
        if (sim.code === 1) { const files = rest.filter(Boolean); items.push({ sha: h.head, short: h.head.slice(0, 9), subject: `Merge ${h.label}`, status: "conflict", conflicts: files, reasons: [`Merging ${h.label} into ${mapping.destination} conflicts in ${files.join(", ")}`], kinds: ["merge"] }); blockers.push(`Merging ${h.label}: predicted conflict in ${files.join(", ")}`); continue; }
        if (sim.code !== 0) throw new Error(`Couldn't simulate the merge: ${sim.err}`);
        if (!brings.length) continue;
        cur = (await this.run(["commit-tree", tree, "-p", cur, "-p", h.head, "-F", "-"], { input: `Merge ${h.label} into ${mapping.destination}\n`, env: commitEnv(null, identity) })).trim();
        applied++;
      }
    }
    const shared = this.config.shared.includes(mapping.destination);
    const status = blockers.length ? "blocked" : !applied ? "nothing" : reviews.length ? "review" : "ready";
    const files = applied ? (await this.run(["diff", "--name-only", dst, cur])).split("\n").filter(Boolean) : [];
    const digest = createHash("sha256").update(JSON.stringify({ m: mapping.id, s: strategy, sel: [...sel].sort(), src: a.source.tip, dst, items: items.map((i) => [i.sha, i.status]) })).digest("hex").slice(0, 16);
    const plan = { id: digest, at: new Date().toISOString(), mapping, strategy, strategyAbout: STRATEGIES[strategy].about, select: [...sel],
      source: a.source, destination: { ...a.destination, shared }, status, items, blockers, reviews, hazards, dependencies: deps,
      result: applied ? { commit: cur, applied, files } : null,
      build: { status: "not-run", text: "No build or test command is configured: this plan is checked by Git only. A clean merge can still break the build." },
      execution: shared ? `${mapping.destination} is a shared branch: nothing is ever written to it. If you approve, a new branch is created from it with this result, for you to push and open a pull request.` : `If you approve, a new branch is created with this result, for you to review, push and merge into ${mapping.destination}. ${mapping.destination} itself isn't changed.` };
    this.savePlan(plan); this.audit({ action: "preview", plan: plan.id, mapping: mapping.id, strategy, select: plan.select, status, applied, blockers: blockers.length });
    return plan;
  }

  // Runs an approved plan: recomputed now, and refused unless it's still the same plan (same branch
  // tips and decisions), ready (or reviewed), and allowed. The result becomes a NEW branch in the
  // configured repository; nothing else is written there.
  async execute(planId, { approvedBy, acknowledge = false, identity }) {
    if (!this.config.proposals) throw new Error("This worker is set to preview only: allow it to create proposal branches in its setup first.");
    const saved = this.loadPlan(planId);
    if (!saved) throw new Error("No such plan: generate a preview first.");
    if (!identity?.name || !identity?.email) throw new Error("Git has no user.name/user.email for this repository: set them, then try again.");
    const mapping = this.config.mappings.find((m) => m.id === saved.mapping.id);
    if (!mapping) throw new Error("The plan's branch relationship no longer exists.");
    const plan = await this.preview(mapping, { strategy: saved.strategy, select: saved.select, identity });
    if (plan.id !== saved.id) { this.audit({ action: "refused", plan: planId, why: "stale" }); throw new Error("The branches changed since this plan was made (or its decisions did): look at the new preview and approve that one."); }
    if (plan.status === "blocked") { this.audit({ action: "refused", plan: planId, why: "blocked" }); throw new Error(`Blocked: ${plan.blockers.join("; ")}`); }
    if (plan.status === "nothing") throw new Error("Nothing to apply.");
    if (plan.status === "review" && !acknowledge) throw new Error(`Confirm you've reviewed: ${plan.reviews.join("; ")}`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const branch = `gitflow/${mapping.destination.replace(/[^A-Za-z0-9._-]+/g, "-")}-${stamp}`;
    if (this.config.shared.includes(branch) || (await git(this.root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).code === 0) throw new Error(`${branch} already exists.`);
    const before = await this.refs();
    await this.run(["update-ref", `refs/gitflow/out/${stamp}`, plan.result.commit]);
    await out(this.root, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", this.scratch, `refs/gitflow/out/${stamp}:refs/heads/${branch}`]);
    const after = await this.refs();
    const changed = [...before].filter(([r, s]) => after.get(r) !== s).map(([r]) => r);
    const entry = { action: "execute", plan: plan.id, mapping: mapping.id, strategy: plan.strategy, branch, commit: plan.result.commit, applied: plan.result.applied, approvedBy, acknowledged: plan.status === "review",
      changedExisting: changed, recovery: `Nothing that existed was changed. To discard: git branch -D ${branch}. To use it: review it, push it yourself and open a pull request into ${mapping.destination}.` };
    this.audit(entry);
    if (changed.length) throw new Error(`Unexpected: existing branches changed (${changed.join(", ")}). Stop and check the repository.`);
    return { ...entry, plan };
  }
  async refs() { const r = await out(this.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"]); return new Map(r.split("\n").filter(Boolean).map((l) => l.split(" "))); }

  // ---- records: plans, audit trail, the worker's notes ----
  savePlan(p) { mkdirSync(join(this.dir, "plans"), { recursive: true }); writeFileSync(join(this.dir, "plans", `${p.id}.json`), JSON.stringify(p, null, 1)); }
  loadPlan(id) { if (!/^[0-9a-f]{16}$/.test(id)) return null; const f = join(this.dir, "plans", `${id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; }
  audit(e) { mkdirSync(this.dir, { recursive: true }); appendFileSync(join(this.dir, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"); }
  auditLog(n = 200) { const f = join(this.dir, "audit.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l)).reverse() : []; }
  notes() { const f = join(this.dir, "notes.json"); try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { return {}; } }
  saveNote(sha, { summary, related = [], task = "", run = null }) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Use the full commit id.");
    const n = this.notes();
    n[sha] = { summary: clip(summary, 1200), related: list(related, 20, 40).filter((s) => SHA.test(s)), task: clip(task, 120), by: "worker", run, at: new Date().toISOString() };
    mkdirSync(this.dir, { recursive: true }); writeFileSync(join(this.dir, "notes.json.tmp"), JSON.stringify(n, null, 1)); renameSync(join(this.dir, "notes.json.tmp"), join(this.dir, "notes.json"));
    this.audit({ action: "note", sha, by: "worker", run });
    return n[sha];
  }
}
// Simulated and executed commits keep the original author; the committer is the person running it.
function commitEnv(c, identity) {
  const id = identity || { name: "Git workflow preview", email: "preview@gitflow.invalid" };
  const date = "2000-01-01T00:00:00Z"; // fixed: a simulated commit's id depends only on its content
  return { GIT_AUTHOR_NAME: c?.author.name || id.name, GIT_AUTHOR_EMAIL: c?.author.email || id.email, GIT_AUTHOR_DATE: c?.date || date,
    GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email, GIT_COMMITTER_DATE: identity ? new Date().toISOString() : date };
}
export const newId = () => randomUUID();
