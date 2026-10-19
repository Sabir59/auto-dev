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
// Least privilege: a fine-grained personal access token limited to the chosen repositories, with
// "Metadata: read" (enough for discovery and verification). Classic tokens work too; their scopes
// are reported so a broad one is visible.
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
const readToken = () => { try { return JSON.parse(readFileSync(CRED_FILE, "utf8")).token || null; } catch { return null; } };
export function checkToken(t) {
  t = String(t || "").trim();
  if (!TOKEN.test(t)) throw new GitHubError("That doesn't look like a GitHub token. Paste a fine-grained token (github_pat_…) or a classic one (ghp_…).", { kind: "input" });
  return t;
}
export function saveToken(t) {
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(CRED_FILE + ".tmp", JSON.stringify({ token: checkToken(t), savedAt: new Date().toISOString() }), { mode: 0o600 });
  renameSync(CRED_FILE + ".tmp", CRED_FILE);
}
export const clearToken = () => rmSync(CRED_FILE, { force: true });

// One GitHub API request. Errors say what to do, never what the token is.
async function gh(path, token = readToken()) {
  if (!token) throw new GitHubError("GitHub isn't connected. Add a token on the GitHub page.", { kind: "auth" });
  let res;
  try {
    res = await fetch(API + path, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ai-workspace-console" }, signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new GitHubError(`Couldn't reach GitHub (${e.name === "TimeoutError" ? "timed out" : "network error"}).`, { kind: "network" }); }
  const body = await res.json().catch(() => null);
  if (res.ok) return { body, headers: res.headers };
  const msg = String(body?.message || "").slice(0, 200);
  if (res.status === 401) throw new GitHubError("GitHub rejected the token (expired, revoked or mistyped). Replace it on the GitHub page.", { status: 401, kind: "auth" });
  if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(msg))) {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    throw new GitHubError(`GitHub's rate limit is used up${reset ? ` until ${new Date(reset).toLocaleTimeString()}` : ""}. Try again then.`, { status: res.status, kind: "rate" });
  }
  if (res.status === 403) throw new GitHubError(`The token doesn't have permission for this${msg ? ` (${msg})` : ""}. Give it access to the repository (fine-grained token: Repository access + Metadata: read).`, { status: 403, kind: "permission" });
  if (res.status === 404) throw new GitHubError("Not found, or this token can't see it. Check the name, and that the token has access to the repository.", { status: 404, kind: "notfound" });
  throw new GitHubError(`GitHub answered ${res.status}${msg ? `: ${msg}` : ""}.`, { status: res.status, kind: "error" });
}

const tokenKind = (t) => (t.startsWith("github_pat_") ? "fine-grained" : t.startsWith("ghp_") ? "classic" : "other");
// Who the token belongs to, and how broad it is (classic tokens report their scopes).
export async function verify(token = readToken()) {
  const { body, headers } = await gh("/user", token);
  const scopes = headers.get("x-oauth-scopes");
  return { login: body.login, name: body.name || null, tokenKind: tokenKind(token), scopes: scopes == null ? null : scopes.split(",").map((s) => s.trim()).filter(Boolean),
    rateRemaining: Number(headers.get("x-ratelimit-remaining")) || null, verifiedAt: new Date().toISOString() };
}

const shape = (r) => ({ githubId: r.id, fullName: r.full_name, owner: r.owner?.login, name: r.name, private: !!r.private, defaultBranch: r.default_branch || null,
  url: r.clone_url, htmlUrl: r.html_url, archived: !!r.archived, access: r.permissions ? (r.permissions.push ? "write" : r.permissions.pull ? "read" : "none") : null });
// The repositories this token can see (at most 300, most recently updated first).
export async function discover() {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const { body } = await gh(`/user/repos?per_page=100&page=${page}&sort=updated`);
    if (!Array.isArray(body)) break;
    out.push(...body.map(shape));
    if (body.length < 100) break;
  }
  return out;
}
export async function repoInfo(fullName) {
  if (!FULL_NAME.test(String(fullName || ""))) throw new GitHubError("Give the repository as owner/name.", { kind: "input" });
  return shape((await gh(`/repos/${fullName}`)).body);
}
