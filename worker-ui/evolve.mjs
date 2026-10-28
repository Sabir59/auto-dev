// Worker evolution: a worker proposes a change to the part of its definition its owner writes; the
// console checks it, can try it in a separate run and grade that run against the proposal's checks;
// only the person activates it, as a new version of the worker. See docs/worker-evolution.md.
//
// What a proposal can change (FIELDS): the worker's own instructions — its steps, knowledge, hard
// limits, what to do when something is missing, and (schema 2) its outcomes. Never its tools, core
// capabilities, integrations or their settings, requirements, repositories, name or mission: those
// decide access, and they stay the person's edits in the worker's editor.
//
// What decides "verified": the console, from evidence it gathered itself — never the worker's words.
// A check is data from a fixed vocabulary, graded here by code against what a trial run actually did
// (its recorded tool calls) and against Builder as Builder reports it (fresh reads by the console).
import { SECRET } from "./workerpack.mjs";

export const FIELDS = ["workflow", "knowledge", "limitations", "onMissing", "outcomes"];
const LIST = { workflow: [30, 600], limitations: [30, 300], outcomes: [10, 200] }, TEXT = { knowledge: 20000, onMissing: 1000 };
// Fields that decide access or identity: named so the refusal says why, not just "unknown".
const ACCESS = { capabilities: "its tools", core: "its core capabilities", integrations: "its integrations and their settings", requirements: "its requirements", extraRequirements: "its requirements",
  repos: "its repository access", name: "its name", mission: "its mission", specialization: "its specialization", schema: "its schema", id: "its id", version: "its version" };
export const MAX_OPEN = 10, MAX_CHECKS = 10, MAX_TRIALS = 12;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, FIELD_RE = /^[A-Za-z0-9_-]{1,60}(\.[A-Za-z0-9_-]{1,60}){0,3}$/, TOOL_RE = /^[\w-]{1,80}$/;
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/)).map((x) => String(x ?? "").trim()).filter(Boolean);
// A check's patterns are written by the worker and run by the console, so a pattern with nested
// repetition (catastrophic backtracking, e.g. (a+)+) is refused, and the text it's tested against is
// capped (SUBJECT).
const NESTED = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;
const regexOk = (p) => { if (NESTED.test(p)) return false; try { new RegExp(p); return true; } catch { return false; } };
const SUBJECT = 4000;

// ---- the change ----
// Each changed field is given in full (its new value). Returns { changes, errors }.
export function normalizeChanges(input, worker) {
  const errors = [], changes = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { changes, errors: ["changes must be an object of the fields to change."] };
  for (const [k, v] of Object.entries(input)) {
    if (!FIELDS.includes(k)) { errors.push(ACCESS[k] ? `${k}: a proposal can't change ${ACCESS[k]}. That decides what the worker may access or who it is; only the person changes it, in the worker's editor.` : `${k}: not a field a proposal can change (it can change: ${FIELDS.join(", ")}).`); continue; }
    if (k === "outcomes" && worker.schema !== 2) { errors.push("outcomes: this worker has no outcomes field (it was made before integrations)."); continue; }
    if (LIST[k]) {
      const [max, len] = LIST[k], items = listOf(v);
      if (items.length > max) errors.push(`${k}: at most ${max} items (got ${items.length}).`);
      const long = items.find((x) => x.length > len); if (long) errors.push(`${k}: each item at most ${len} characters ("${long.slice(0, 60)}…" is ${long.length}).`);
      changes[k] = items;
    } else {
      const t = String(v ?? "").trim();
      if (t.length > TEXT[k]) errors.push(`${k}: at most ${TEXT[k]} characters (got ${t.length}).`);
      changes[k] = t;
    }
  }
  if (!errors.length && !Object.keys(changes).length) errors.push("changes is empty: say which fields change, with their new values.");
  const same = Object.keys(changes).filter((k) => JSON.stringify(changes[k]) === JSON.stringify(worker[k] ?? (LIST[k] ? [] : "")));
  if (!errors.length && same.length === Object.keys(changes).length) errors.push("Nothing changes: every field given is the same as the worker has now.");
  for (const k of same) delete changes[k];
  return { changes, errors };
}
export const applyChanges = (stored, changes) => ({ ...stored, ...changes });
// A stored proposal, checked again whenever it's used (tried, graded or approved): its record is a
// file, so one changed outside the console — changes naming a field a proposal can't change, values
// of the wrong shape, checks the console never accepted — is refused, not trusted. Returns why, or null.
export function storedProblem(p, worker) {
  const c = p?.changes;
  if (!c || typeof c !== "object" || Array.isArray(c) || !Object.keys(c).length) return "its changes aren't a set of fields";
  for (const [k, v] of Object.entries(c)) {
    if (!FIELDS.includes(k) || (k === "outcomes" && worker?.schema !== 2)) return `it changes ${k}, which a proposal can't`;
    const ok = LIST[k] ? Array.isArray(v) && v.length <= LIST[k][0] && v.every((x) => typeof x === "string" && x.length <= LIST[k][1]) : typeof v === "string" && v.length <= TEXT[k];
    if (!ok) return `its ${k} isn't a valid value`;
  }
  const { checks, errors } = normalizeChecks(p.checks);
  if (errors.length || JSON.stringify(checks) !== JSON.stringify(p.checks)) return "its checks aren't the ones the console accepted";
  return null;
}

// ---- what a reviewer should look at twice ----
// A proposal that takes away a hard limit or empties the knowledge is allowed (conventions change),
// but it's named, and approving it needs the person's explicit acknowledgement.
export function warnings(worker, changes) {
  const w = [];
  if (changes.limitations) for (const l of worker.limitations || []) if (!changes.limitations.includes(l)) w.push(`Removes or rewrites a hard limit: "${l}"`);
  if (changes.knowledge !== undefined && (worker.knowledge || "").length > 200 && changes.knowledge.length < (worker.knowledge || "").length / 2) w.push("Removes more than half of the worker's knowledge.");
  if (changes.workflow && (worker.workflow || []).length && changes.workflow.length < (worker.workflow || []).length / 2) w.push("Removes more than half of the worker's steps.");
  return w;
}

// ---- diffs ----
const toLines = (v) => (v == null ? [] : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : typeof v === "string" ? v.split(/\r?\n/) : JSON.stringify(v, null, 1).split("\n"));
// Line diff (longest common subsequence): [{ op: "=" | "-" | "+", text }].
export function lineDiff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4e6) return [...a.map((text) => ({ op: "-", text })), ...b.map((text) => ({ op: "+", text }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push({ op: "=", text: a[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: a[i++] }); else out.push({ op: "+", text: b[j++] }); }
  while (i < n) out.push({ op: "-", text: a[i++] }); while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}
// The fields that differ between two stored definitions, each with its line diff.
const VOLATILE = new Set(["version", "updatedAt", "createdAt"]);
export function diffStored(before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !VOLATILE.has(k));
  return keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => ({ field: k, lines: lineDiff(toLines(before[k]), toLines(after[k])) }));
}

// ---- checks: what a trial run must show ----
// builder_entry: entries of a Builder model, matched by name (a regular expression) or url (exact),
//   created or changed during the trial run; optionally how many, their publication state, and data
//   fields (a regular expression each, or { absent: true }).
// tool_called: the trial run called this tool successfully (at least `min` times).
export function normalizeChecks(list) {
  const errors = [], checks = [];
  if (list == null) return { checks, errors };
  if (!Array.isArray(list)) return { checks, errors: ["checks must be a list."] };
  if (list.length > MAX_CHECKS) errors.push(`At most ${MAX_CHECKS} checks.`);
  list.slice(0, MAX_CHECKS).forEach((c, i) => {
    const at = `checks[${i}]`;
    if (c?.type === "builder_entry") {
      const model = String(c.model || ""), name = c.name == null ? null : String(c.name), url = c.url == null ? null : String(c.url), e = c.expect || {};
      if (!MODEL_RE.test(model)) errors.push(`${at}: model "${model}" isn't a valid Builder model name.`);
      if (!name && !url) errors.push(`${at}: give name (a regular expression) or url, to say which entries it checks.`);
      if (name && (name.length > 200 || !regexOk(name))) errors.push(`${at}: name must be a valid regular expression of at most 200 characters, without nested repetition like (a+)+.`);
      if (url && (url.length > 300 || !url.startsWith("/"))) errors.push(`${at}: url must be a path starting with / (at most 300 characters).`);
      const expect = {};
      if (e.count != null) { if (!Number.isInteger(e.count) || e.count < 0 || e.count > 20) errors.push(`${at}: expect.count must be a whole number from 0 to 20.`); else expect.count = e.count; }
      if (e.published != null) { if (!["draft", "published", "archived"].includes(e.published)) errors.push(`${at}: expect.published must be draft, published or archived.`); else expect.published = e.published; }
      if (e.fields != null) {
        if (typeof e.fields !== "object" || Array.isArray(e.fields) || Object.keys(e.fields).length > 20) errors.push(`${at}: expect.fields must be an object of at most 20 fields.`);
        else { expect.fields = {}; for (const [f, v] of Object.entries(e.fields)) {
          if (!FIELD_RE.test(f)) { errors.push(`${at}: "${f}" isn't a data field path (letters, digits, _ and -, dotted).`); continue; }
          if (v && typeof v === "object" && v.absent === true) expect.fields[f] = { absent: true };
          else if (typeof v === "string" && v.length <= 300 && regexOk(v)) expect.fields[f] = v;
          else errors.push(`${at}: expect.fields.${f} must be a regular expression (at most 300 characters, without nested repetition like (a+)+) or { "absent": true }.`);
        } }
      }
      checks.push({ type: "builder_entry", model, ...(name ? { name } : {}), ...(url ? { url } : {}), expect });
    } else if (c?.type === "tool_called") {
      const tool = String(c.tool || ""), min = c.min == null ? 1 : c.min;
      if (!TOOL_RE.test(tool)) errors.push(`${at}: tool must be a tool name (e.g. builder_create_draft).`);
      if (!Number.isInteger(min) || min < 1 || min > 50) errors.push(`${at}: min must be a whole number from 1 to 50.`);
      checks.push({ type: "tool_called", tool, min });
    } else errors.push(`${at}: type must be builder_entry or tool_called (got ${JSON.stringify(c?.type ?? null)}).`);
  });
  return { checks, errors };
}
export const describeCheck = (c) => c.type === "tool_called" ? `calls ${c.tool}${c.min > 1 ? ` at least ${c.min} times` : ""}`
  : `Builder ${c.model}: entries ${c.name ? `named /${c.name}/` : `at ${c.url}`}, changed during the trial${c.expect.count != null ? `, exactly ${c.expect.count}` : ""}${c.expect.published ? `, ${c.expect.published}` : ""}${c.expect.fields ? `, ${Object.entries(c.expect.fields).map(([f, v]) => (v.absent ? `no ${f}` : `${f} ~ /${v}/`)).join(", ")}` : ""}`;

// ---- the whole proposal ----
// input: what the worker (or a test) submitted; worker: the resolved definition now; capabilities: the
// worker's own (resolved). Returns { proposal fields, errors }.
export function normalizeProposal(input, worker) {
  const errors = [], b = input || {};
  const title = str(b.title, 120); if (!title) errors.push("title: say in a few words what the worker will be able to do.");
  const reason = str(b.reason, 1500); if (!reason) errors.push("reason: say why (what the person asked for, and what's missing today).");
  const expected = str(b.expected, 1500);
  const acceptance = listOf(b.acceptance).slice(0, 10).map((x) => x.slice(0, 300));
  const { changes, errors: ce } = normalizeChanges(b.changes, worker); errors.push(...ce);
  const caps = new Set(worker.capabilities || []), uses = [...new Set(listOf(b.uses))].slice(0, 20);
  for (const u of uses) if (!caps.has(u)) errors.push(`uses: ${u} isn't one of this worker's tools (it has: ${[...caps].join(", ") || "none"}). A proposal can't add tools; list what's missing under needs instead.`);
  const needs = (Array.isArray(b.needs) ? b.needs : []).slice(0, 10).map((n) => ({ what: str(n?.what, 200), why: str(n?.why, 500) })).filter((n) => n.what);
  const { checks, errors: ke } = normalizeChecks(b.checks); errors.push(...ke);
  const trialPrompt = str(b.trialPrompt, 2000);
  if (checks.length && !trialPrompt) errors.push("trialPrompt: give the task a trial run should do so its checks can be graded.");
  // No secrets anywhere in what's kept and shown.
  const all = [title, reason, expected, ...acceptance, ...Object.values(changes).flat(), ...needs.flatMap((n) => [n.what, n.why]), trialPrompt].join("\n");
  if (SECRET.test(all)) errors.push("The proposal contains what looks like a password, key or token. Remove it: secrets never go into a worker's definition.");
  return { proposal: { title, reason, expected, acceptance, changes, uses, needs, checks, trialPrompt }, errors };
}

// ---- grading a trial run ----
// events: the run's event log; since: when the trial run started (ms); builder: { status() →
// { ok, why }, list(model) → entries (summaries), get(model, id) → entry with data }.
const pick = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const tsOf = (e) => Math.max(Number(e.lastUpdated) || 0, Number(e.createdDate) || 0);
export async function grade(checks, { events, since, builder }) {
  const out = [];
  for (const c of checks) {
    if (c.type === "tool_called") {
      // A call counts only when its result came back as a success (a refused or failed call is a
      // "failure" event, server.mjs translate).
      const succeeded = new Set(events.filter((e) => e.type === "result" && e.ref).map((e) => e.ref));
      const n = events.filter((e) => e.type === "tool" && e.tool === c.tool && succeeded.has(e.ref)).length;
      out.push({ check: describeCheck(c), ran: true, ok: n >= c.min, detail: `${c.tool} called ${n} time${n === 1 ? "" : "s"}` });
      continue;
    }
    const st = await builder.status().catch((e) => ({ ok: false, why: e.message }));
    if (!st.ok) { out.push({ check: describeCheck(c), ran: false, ok: false, detail: `Not checked: Builder isn't available to the console (${st.why}).` }); continue; }
    try {
      const re = c.name ? new RegExp(c.name) : null;
      const rows = (await builder.list(c.model)).filter((e) => (re ? re.test(String(e.name || "").slice(0, SUBJECT)) : true) && (c.url ? e.url === c.url : true) && tsOf(e) >= since - 5000);
      const problems = [];
      if (c.expect.count != null ? rows.length !== c.expect.count : rows.length < 1) problems.push(`found ${rows.length} matching entr${rows.length === 1 ? "y" : "ies"} changed during the trial${c.expect.count != null ? `, expected ${c.expect.count}` : ""}`);
      const seen = [];
      for (const r of rows.slice(0, 20)) {
        const e = await builder.get(c.model, r.id);
        const bad = [];
        if (c.expect.published && e?.published !== c.expect.published) bad.push(`published is ${e?.published}, expected ${c.expect.published}`);
        for (const [f, want] of Object.entries(c.expect.fields || {})) {
          const v = pick(e?.data, f);
          if (want.absent) { if (v !== undefined) bad.push(`data.${f} is present (${JSON.stringify(v).slice(0, 80)}), expected absent`); }
          else if (v === undefined || !new RegExp(want).test((typeof v === "string" ? v : JSON.stringify(v)).slice(0, SUBJECT))) bad.push(`data.${f} is ${v === undefined ? "missing" : JSON.stringify(v).slice(0, 80)}, expected /${want}/`);
        }
        seen.push({ id: r.id, name: r.name, published: e?.published, ok: !bad.length, ...(bad.length ? { problems: bad } : {}) });
        problems.push(...bad.map((x) => `${r.name}: ${x}`));
      }
      out.push({ check: describeCheck(c), ran: true, ok: !problems.length, detail: problems.length ? problems.join("; ") : `${rows.length} entr${rows.length === 1 ? "y" : "ies"} as expected`, entries: seen });
    } catch (e) { out.push({ check: describeCheck(c), ran: false, ok: false, detail: `Not checked: ${e.message}` }); }
  }
  return out;
}

// ---- the proposal's state, worked out from what's recorded ----
// status: proposed | approved | rejected — and "stale" for a proposed one whose base isn't the
// worker's version any more. verification: from the candidate trials' grades, never from the text.
//   passed    the latest graded candidate trial ran every check and all passed
//   blocked   what it uses isn't available now (the reason is given), and nothing has passed: a trial
//             without it can't show anything, so its failures aren't reported as the change's
//   failed    the latest graded candidate trial ran its checks and at least one failed
//   untested  no graded trial, or a check couldn't be run (the reason is given)
//   no-checks the proposal has no checks, so the console can't test it
export function stateOf(p, worker) {
  const status = p.status === "proposed" && worker && worker.version !== p.base ? "stale" : p.status;
  const graded = (p.trials || []).filter((t) => !t.baseline && t.grade);
  const last = graded[graded.length - 1];
  const down = (p.dependencies || []).filter((d) => !d.ok);
  let v;
  if (!p.checks.length) v = { status: "no-checks", why: "It has no checks, so the console can't test it." };
  else if (last && last.grade.results.every((r) => r.ran) && last.grade.results.every((r) => r.ok)) v = { status: "passed", why: `All ${last.grade.results.length} checks passed in trial run ${last.run}.`, run: last.run };
  else if (down.length) v = { status: "blocked", why: down.map((d) => `${d.label}: ${d.why}`).join("; ") };
  else if (last && last.grade.results.some((r) => r.ran && !r.ok)) v = { status: "failed", why: last.grade.results.filter((r) => r.ran && !r.ok).map((r) => r.detail).join("; "), run: last.run };
  else if (last) v = { status: "untested", why: last.grade.results.filter((r) => !r.ran).map((r) => r.detail).join("; ") || "Its checks couldn't be run.", run: last.run };
  else v = { status: "untested", why: "No trial run has been graded yet." };
  const base = (p.trials || []).filter((t) => t.baseline && t.grade).pop();
  return { status, verification: v, ...(base ? { baseline: { run: base.run, ok: base.grade.results.every((r) => r.ran && r.ok), ran: base.grade.results.every((r) => r.ran) } } : {}) };
}
