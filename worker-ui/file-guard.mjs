// The run's file tools stay inside the folders the run was given. The console puts this in every
// run's --settings as a PreToolUse hook on Read, Glob, Grep, Write and Edit, so the runtime asks it
// before each call, below the model; exit code 2 refuses the call (the reason goes back to the model).
//   node file-guard.mjs <base64url of JSON { roots: [folder, ...] }>
// roots: the run's workspace and its --add-dir folders. Reads may also reach the run's own session
// folder in the runtime's config dir (where it saves a large tool output for the worker to read
// back), never another session's. Paths are resolved as the runtime resolves them (relative to its
// cwd), then to their real location (junctions and symlinks followed, the nearest existing parent
// for a file that doesn't exist yet), so ../ and links inside the workspace can't leave it.
// Fail-closed: anything it can't parse or check is refused.
// Not a boundary for shell commands (node, curl run as the person's OS user) and switched off only
// if the runtime ignores its own settings; the runtime's deny rules (secretDeny in server.mjs) are
// the second layer for credentials. See docs/worker-evolution.md, "Limits".
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename, join } from "node:path";

const refuse = (why) => { process.stderr.write(`Refused: ${why}. This run's file tools can only use its workspace folder.`); process.exit(2); };
process.on("uncaughtException", () => refuse("the request couldn't be checked"));

const win = process.platform === "win32";
const fold = (p) => (win ? p.toLowerCase() : p);
// The real location: the nearest existing parent resolved (links, junctions, 8.3 names), the rest appended.
function real(p) {
  let cur = resolve(p); const rest = [];
  for (;;) {
    try { return join(realpathSync.native(cur), ...rest.reverse()); }
    catch { const up = dirname(cur); if (up === cur) return resolve(p); rest.push(basename(cur)); cur = up; }
  }
}
const inside = (root, p) => { const r = relative(fold(root), fold(p)); return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r)); };
// The part of a glob pattern before its first wildcard segment.
const staticPrefix = (pattern) => { const segs = pattern.split(/[\\/]/), keep = []; for (const s of segs) { if (/[*?[\]{}]/.test(s)) break; keep.push(s); } return keep.join("/") || (pattern.startsWith("/") ? "/" : ""); };
const dots = (s) => /(^|[\\/])\.\.([\\/]|$)/.test(String(s || ""));

let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  let cfg, h;
  try { cfg = JSON.parse(Buffer.from(process.argv[2] || "", "base64url").toString("utf8")); h = JSON.parse(input); } catch { refuse("the request couldn't be checked"); }
  const roots = (cfg.roots || []).filter(Boolean).map(real);
  if (!roots.length) refuse("this run has no folder to use");
  const tool = h.tool_name, t = h.tool_input || {}, cwd = h.cwd || roots[0];
  const reading = ["Read", "Glob", "Grep"].includes(tool);
  // a run's own session folder: <config>/projects/<project>/<session id>/ (tool-results and the like)
  const own = reading && h.transcript_path && h.session_id && /^[\w-]+$/.test(h.session_id) ? [real(join(dirname(h.transcript_path), h.session_id))] : [];
  const targets = [];
  if (tool === "Read" || tool === "Write" || tool === "Edit" || tool === "MultiEdit") targets.push(t.file_path);
  else if (tool === "NotebookEdit") targets.push(t.notebook_path);
  else if (tool === "Glob") {
    if (dots(t.pattern)) refuse("a pattern can't go up a folder (..)");
    targets.push(t.path || cwd);
    if (isAbsolute(String(t.pattern || "")) || /^[A-Za-z]:/.test(String(t.pattern || ""))) targets.push(staticPrefix(String(t.pattern)));
  } else if (tool === "Grep") {
    if (dots(t.glob)) refuse("a pattern can't go up a folder (..)");
    targets.push(t.path || cwd);
    if (isAbsolute(String(t.glob || "")) || /^[A-Za-z]:/.test(String(t.glob || ""))) targets.push(staticPrefix(String(t.glob)));
  } else refuse(`${tool} isn't a file tool this check knows`);
  for (const raw of targets) {
    if (typeof raw !== "string" || !raw.trim()) refuse("no path was given");
    if (/^\\\\[?.]\\/.test(raw)) refuse("device paths can't be used");
    const p = real(resolve(cwd, raw));
    if (![...roots, ...own].some((r) => inside(r, p))) refuse(`${raw} is outside the folders this run can use`);
  }
  process.exit(0);
});
