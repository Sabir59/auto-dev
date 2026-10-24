// The platform's one GitHub connection: a token the person gives once, used by the console (never
// by workers) to verify the connection, discover the repositories it can see and read their
// metadata. It is never sent to the browser, a worker, a log or an error message.
//
// The token lives outside the repo and outside every workspace, in
// ~/.github-connector/credentials.json (GITHUB_CONNECTOR_DIR overrides the folder, for tests). On
// Windows the file is protected only by the user profile's own permissions (mode bits aren't
// enforced there).
//
// Git itself (clone, fetch, push) keeps using the person's own Git sign-in (Git Credential Manager
// or SSH), exactly as before. This token is not handed to Git.
//
// Two ways to connect, one credential file:
//  - "Connect with GitHub" (github-app.mjs): the console's GitHub App, authorized in the browser;
//    the person picks the repositories on GitHub. Stored: { method: "app", token (ghu_…),
//    refreshToken, expiresAt, refreshExpiresAt }. An expiring token is refreshed here, before use.
//  - A pasted token: { method: "token", token }. Least privilege: a fine-grained personal access
//    token limited to the chosen repositories, with "Metadata: read" (enough for discovery and
//    verification). Classic tokens work too; their scopes are reported so a broad one is visible.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// One spelling per repository, to compare a checkout's remote with the registered one: credentials
// stripped, SSH and HTTPS forms made equal, no ".git", case-insensitive (GitHub names are). Local
// paths and file:// URLs (test remotes) compare as resolved paths.
export function canonRemote(u) {
  u = String(u || "").trim().replace(/^(\w+:\/\/)[^@/]+@/, "$1");
  if (!u) return "";
  const ssh = /^git@([^:]+):(.+)$/.exec(u) || /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(u);
  if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
  u = u.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (/^https?:\/\//i.test(u)) { try { const x = new URL(u); return `https://${x.host}${x.pathname}`.toLowerCase(); } catch { return u.toLowerCase(); } }
  let p = u; if (/^file:/i.test(u)) { try { p = fileURLToPath(u); } catch { return u.toLowerCase(); } }
  return "file:" + resolve(p).replace(/\\/g, "/").replace(/\.git$/i, "").toLowerCase();
}

export const CRED_DIR = process.env.GITHUB_CONNECTOR_DIR || join(homedir(), ".github-connector");
const CRED_FILE = join(CRED_DIR, "credentials.json");
const API = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
const TOKEN = /^(github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})$/;
export const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export class GitHubError extends Error {
  constructor(message, { status = 0, kind = "error" } = {}) { super(message); this.status = status; this.kind = kind; }
}

export const hasToken = () => existsSync(CRED_FILE);
const readCred = () => { try { const c = JSON.parse(readFileSync(CRED_FILE, "utf8")); return c?.token ? { method: c.method || "token", ...c } : null; } catch { return null; } };
export const connectionMethod = () => readCred()?.method || null;
// The app's token expires (GitHub default: 8 hours); it's refreshed with its refresh token through
// the refresher the console installs (github-app.mjs's, which holds the client secret).
let refresher = null;
export const setRefresher = (fn) => { refresher = fn; };
async function currentToken() {
  const c = readCred(); if (!c) return null;
  if (c.method !== "app" || !c.expiresAt || c.expiresAt - 60000 > Date.now()) return c.token;
  if (!c.refreshToken || !refresher || (c.refreshExpiresAt && c.refreshExpiresAt <= Date.now())) throw new GitHubError("GitHub's sign-in for the console has expired. Connect with GitHub again.", { kind: "auth" });
  const next = await refresher(c.refreshToken); // a refused refresh says "connect again"
  saveCredentials(next);
  return next.token;
}
// For a hosted console's own git network commands (git-credential.mjs), never for a worker.
export const gitToken = () => currentToken();
export function saveCredentials(c) {
  if (!c?.token || !TOKEN.test(c.token)) throw new GitHubError("GitHub returned something that isn't a token.", { kind: "exchange" });
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(CRED_FILE + ".tmp", JSON.stringify({ method: c.method || "token", token: c.token, ...(c.refreshToken ? { refreshToken: c.refreshToken } : {}), ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}), ...(c.refreshExpiresAt ? { refreshExpiresAt: c.refreshExpiresAt } : {}), savedAt: new Date().toISOString() }), { mode: 0o600 });
  renameSync(CRED_FILE + ".tmp", CRED_FILE);
}
export function checkToken(t) {
  t = String(t || "").trim();
  if (!TOKEN.test(t)) throw new GitHubError("That doesn't look like a GitHub token. Paste a fine-grained token (github_pat_…) or a classic one (ghp_…).", { kind: "input" });
  return t;
}
export const saveToken = (t) => saveCredentials({ method: "token", token: checkToken(t) });
// Deletes the stored credential; returns it, so the console can also revoke an app token at GitHub.
export const clearToken = () => { const c = readCred(); rmSync(CRED_FILE, { force: true }); return c; };

// One GitHub API request. Errors say what to do, never what the token is.
async function gh(path, token, { method = "GET", body: payload } = {}) {
  token ||= await currentToken();
  if (!token) throw new GitHubError("GitHub isn't connected. Connect on the GitHub page.", { kind: "auth" });
  let res;
  try {
    res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ai-workspace-console", ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new GitHubError(`Couldn't reach GitHub (${e.name === "TimeoutError" ? "timed out" : "network error"}).`, { kind: "network" }); }
  const body = await res.json().catch(() => null);
  if (res.ok) return { body, headers: res.headers };
  const msg = String(body?.message || "").slice(0, 200);
  if (res.status === 401) throw new GitHubError(token.startsWith("ghu_") ? "GitHub no longer accepts the console's sign-in (revoked or expired). Connect with GitHub again." : "GitHub rejected the token (expired, revoked or mistyped). Replace it on the GitHub page.", { status: 401, kind: "auth" });
  if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(msg))) {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    throw new GitHubError(`GitHub's rate limit is used up${reset ? ` until ${new Date(reset).toLocaleTimeString()}` : ""}. Try again then.`, { status: res.status, kind: "rate" });
  }
  if (res.status === 403) throw new GitHubError(`The token doesn't have permission for this${msg ? ` (${msg})` : ""}. Give it access to the repository (fine-grained token: Repository access + Metadata: read).`, { status: 403, kind: "permission" });
  if (res.status === 404) throw new GitHubError("Not found, or this token can't see it. Check the name, and that the token has access to the repository.", { status: 404, kind: "notfound" });
  throw new GitHubError(`GitHub answered ${res.status}${msg ? `: ${msg}` : ""}.`, { status: res.status, kind: "error" });
}

const tokenKind = (t) => (t.startsWith("ghu_") ? "GitHub App" : t.startsWith("github_pat_") ? "fine-grained" : t.startsWith("ghp_") ? "classic" : "other");
// Who the token belongs to, and how broad it is (classic tokens report their scopes).
export async function verify(token) {
  token ||= await currentToken();
  const { body, headers } = await gh("/user", token);
  const scopes = headers.get("x-oauth-scopes");
  return { login: body.login, name: body.name || null, tokenKind: tokenKind(token), scopes: scopes == null ? null : scopes.split(",").map((s) => s.trim()).filter(Boolean),
    rateRemaining: Number(headers.get("x-ratelimit-remaining")) || null, verifiedAt: new Date().toISOString() };
}

const shape = (r) => ({ githubId: r.id, fullName: r.full_name, owner: r.owner?.login, name: r.name, private: !!r.private, defaultBranch: r.default_branch || null,
  url: r.clone_url, htmlUrl: r.html_url, archived: !!r.archived, access: r.permissions ? (r.permissions.push ? "write" : r.permissions.pull ? "read" : "none") : null });
// The repositories the connection can see (at most 300). Connected with the app: exactly the
// repositories the person chose for its installations on GitHub (and can access themselves).
export async function discover() {
  const out = [];
  if (connectionMethod() === "app") {
    const { body } = await gh("/user/installations?per_page=100");
    for (const inst of body?.installations || []) {
      for (let page = 1; page <= 3; page++) {
        const r = (await gh(`/user/installations/${encodeURIComponent(inst.id)}/repositories?per_page=100&page=${page}`)).body;
        const list = Array.isArray(r?.repositories) ? r.repositories : [];
        out.push(...list.map(shape));
        if (list.length < 100) break;
      }
    }
    return [...new Map(out.map((r) => [r.fullName.toLowerCase(), r])).values()];
  }
  for (let page = 1; page <= 3; page++) {
    const { body } = await gh(`/user/repos?per_page=100&page=${page}&sort=updated`);
    if (!Array.isArray(body)) break;
    out.push(...body.map(shape));
    if (body.length < 100) break;
  }
  return out;
}
// Opens a pull request (head → base). The Git workflow worker's only way into a shared branch: it
// never pushes to one. GitHub's own branch protection and reviews then apply.
export async function createPullRequest(fullName, { head, base, title, body }) {
  if (!FULL_NAME.test(String(fullName || ""))) throw new GitHubError("Give the repository as owner/name.", { kind: "input" });
  const { body: pr } = await gh(`/repos/${fullName}/pulls`, null, { method: "POST", body: { head, base, title, body } });
  return { number: pr.number, url: pr.html_url, state: pr.state };
}
// The CI state of a commit on GitHub: its check runs (Actions and apps) and its commit statuses,
// summarised as passing / failing / pending / none. Read-only.
export async function ciStatus(fullName, ref) {
  if (!FULL_NAME.test(String(fullName || ""))) throw new GitHubError("Give the repository as owner/name.", { kind: "input" });
  const r = encodeURIComponent(ref);
  const [runs, status] = await Promise.all([gh(`/repos/${fullName}/commits/${r}/check-runs?per_page=100`), gh(`/repos/${fullName}/commits/${r}/status`)]);
  const checks = [...(runs.body?.check_runs || []).map((c) => ({ name: c.name, state: c.status === "completed" ? c.conclusion || "neutral" : c.status, url: c.html_url || null })),
    ...(status.body?.statuses || []).map((s) => ({ name: s.context, state: s.state, url: s.target_url || null }))];
  const failing = checks.some((c) => ["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure"].includes(c.state));
  const pending = checks.some((c) => ["queued", "in_progress", "pending", "requested", "waiting"].includes(c.state));
  return { state: !checks.length ? "none" : failing ? "failing" : pending ? "pending" : "passing", checks };
}
export async function repoInfo(fullName) {
  if (!FULL_NAME.test(String(fullName || ""))) throw new GitHubError("Give the repository as owner/name.", { kind: "input" });
  return shape((await gh(`/repos/${fullName}`)).body);
}
