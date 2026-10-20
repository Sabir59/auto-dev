// "Connect with GitHub": the console's GitHub App, authorized by the person in their own browser
// (docs/github.md §2). The other way to connect, a pasted fine-grained token, stays in github.mjs.
//
// The flow is GitHub's web application flow for GitHub Apps, with a loopback redirect:
//   1. the page asks the console to start (POST /github/app/start, same-origin only);
//   2. the console makes a one-time state (CSRF) and a PKCE verifier, keeps both in memory for
//      ten minutes, and returns GitHub's authorize URL (client id, redirect, state, challenge);
//   3. the person signs in on github.com (the console never sees a password) and authorizes the app;
//   4. GitHub redirects the browser to http://127.0.0.1:<port>/github/callback?code&state;
//   5. the console checks the state (known, unused, unexpired, this console), exchanges the code
//      server-to-server (client secret + PKCE verifier) and keeps the user token next to the PAT.
// GitHub accepts any port on a loopback redirect, so each developer's console works on its own port.
//
// Which repositories the console can see is chosen on GitHub, per installation of the app ("Only
// select repositories"). The app asks for Metadata: read only; it can't read code or push. Git
// itself keeps using the person's own Git sign-in. Workers get nothing from this connection: their
// access is still per registered repository, per worker (docs/github.md §1).
//
// The app's client id and secret are this computer's configuration, never the repo's or the page's:
// ~/.github-connector/app.json ({ "clientId", "clientSecret", "slug" }), next to credentials.json,
// or GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET / GITHUB_APP_SLUG.
//
// Hosted (AIW_TOKEN_BROKER set by the gateway): a person's console knows the app's public client id
// and slug only. The token requests that need the client secret (code exchange, refresh, revoke)
// go to the gateway's broker, which adds the secret; the secret never reaches a person's console.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRED_DIR, GitHubError } from "./github.mjs";

const WEB = (process.env.GITHUB_WEB_BASE || "https://github.com").replace(/\/+$/, "");
const API = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
export const APP_FILE = join(CRED_DIR, "app.json");
const STATE_TTL = Number(process.env.GITHUB_STATE_TTL_MS) || 10 * 60 * 1000;
const BROKER = (process.env.AIW_TOKEN_BROKER || "").replace(/\/+$/, ""), BROKER_TOKEN = process.env.AIW_BROKER_TOKEN || "";
const SETUP = "Connect with GitHub isn't set up on this computer: it needs the GitHub App's client ID and secret. See docs/github.md (Connect with GitHub), or connect with a token instead.";

export function appConfig() {
  let f = {}; try { f = JSON.parse(readFileSync(APP_FILE, "utf8")); } catch {}
  const clientId = String(process.env.GITHUB_APP_CLIENT_ID || f.clientId || "").trim(), clientSecret = String(process.env.GITHUB_APP_CLIENT_SECRET || f.clientSecret || "").trim();
  const slug = String(process.env.GITHUB_APP_SLUG || f.slug || "").trim();
  if (!clientId || (!clientSecret && !BROKER)) return null;
  return { clientId, clientSecret: BROKER ? null : clientSecret, slug: /^[a-z0-9-]{1,100}$/i.test(slug) ? slug : null };
}
// What the page may know: whether it's set up, the app's public name and where to choose repositories. Never the secret.
export function appSummary() {
  const c = appConfig();
  return { configured: !!c, slug: c?.slug || null, configFile: BROKER ? null : APP_FILE, installUrl: c?.slug ? `${WEB}/apps/${c.slug}/installations/new` : null };
}

// One-time states: state -> { verifier, redirectUri, at }. In memory only: a console restart
// simply invalidates sign-ins in progress.
const pending = new Map();
const b64url = (buf) => Buffer.from(buf).toString("base64url");
function prune() { for (const [s, p] of pending) if (Date.now() - p.at > STATE_TTL) pending.delete(s); while (pending.size > 20) pending.delete(pending.keys().next().value); }
export function startAuth(redirectUri) {
  const c = appConfig(); if (!c) throw new GitHubError(SETUP, { kind: "setup" });
  prune();
  const state = b64url(randomBytes(32)), verifier = b64url(randomBytes(48)), challenge = b64url(createHash("sha256").update(verifier).digest());
  pending.set(state, { verifier, redirectUri, at: Date.now() });
  const u = new URL(`${WEB}/login/oauth/authorize`);
  u.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", allow_signup: "false" }).toString();
  return { url: u.href };
}
// The state is used up by its first callback, whether or not the rest succeeds (no replays).
export function takeState(state) {
  const s = typeof state === "string" ? state : "";
  let found = null;
  for (const [k, p] of pending) { const a = Buffer.from(k), b = Buffer.from(s); if (a.length === b.length && timingSafeEqual(a, b)) { found = [k, p]; break; } }
  if (!found) throw new GitHubError("This sign-in link isn't one this console started, or it was already used. Start again from the GitHub page.", { kind: "state" });
  pending.delete(found[0]);
  if (Date.now() - found[1].at > STATE_TTL) throw new GitHubError("This sign-in took longer than 10 minutes and expired. Start again from the GitHub page.", { kind: "expired" });
  return found[1];
}

// Token requests go server-to-server, with the client secret in the body (never in a URL).
async function tokenRequest(params) {
  const c = appConfig(); if (!c) throw new GitHubError(SETUP, { kind: "setup" });
  let res;
  if (BROKER) {
    try { res = await fetch(`${BROKER}/github/token`, { method: "POST", headers: { authorization: `Bearer ${BROKER_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw new GitHubError(`Couldn't reach GitHub (${e.name === "TimeoutError" ? "timed out" : "network error"}).`, { kind: "network" }); }
    return tokenResult(await res.json().catch(() => ({})), res);
  }
  try {
    res = await fetch(`${WEB}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "ai-workspace-console" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, ...params }), signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new GitHubError(`Couldn't reach GitHub (${e.name === "TimeoutError" ? "timed out" : "network error"}).`, { kind: "network" }); }
  return tokenResult(await res.json().catch(() => ({})), res);
}
function tokenResult(j, res) {
  if (!res.ok || j.error || !j.access_token) {
    const code = String(j.error || res.status).replace(/[^\w.-]/g, "").slice(0, 60);
    throw new GitHubError(code === "bad_refresh_token" ? "GitHub's sign-in for the console has expired. Connect with GitHub again." : `GitHub didn't complete the sign-in (${code}). Start again from the GitHub page.`, { kind: code === "bad_refresh_token" ? "auth" : "exchange" });
  }
  const now = Date.now();
  return { method: "app", token: j.access_token, refreshToken: j.refresh_token || null, expiresAt: j.expires_in ? now + j.expires_in * 1000 : null, refreshExpiresAt: j.refresh_token_expires_in ? now + j.refresh_token_expires_in * 1000 : null };
}
export const exchangeCode = (code, p) => tokenRequest({ code: String(code || ""), redirect_uri: p.redirectUri, code_verifier: p.verifier });
export const refreshToken = (refresh) => tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
// Disconnecting also revokes the token at GitHub (best effort: the local copy is deleted regardless).
export async function revoke(token) {
  const c = appConfig(); if (!c || !token) return false;
  if (BROKER) {
    try { const r = await fetch(`${BROKER}/github/revoke`, { method: "POST", headers: { authorization: `Bearer ${BROKER_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(10000) }); return r.status === 204; }
    catch { return false; }
  }
  try {
    const r = await fetch(`${API}/applications/${encodeURIComponent(c.clientId)}/token`, { method: "DELETE", headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "ai-workspace-console" },
      body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(10000) });
    return r.status === 204;
  } catch { return false; }
}
