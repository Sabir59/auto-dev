// A local stand-in for the parts of the GitHub REST API the console uses (/user, /user/repos,
// /repos/:owner/:name), for tests. Each token is an identity that sees its own repositories only.
// It proves the console's requests, error handling and access rules; it proves nothing about
// GitHub itself. POST /__mock sets state: { rateLimited, revoked: [fullName], set: { fullName: {...} } }.
//
// It also stands in for github.com's GitHub App user authorization (web flow) and the app's
// installation, as GitHub documents them: GET /login/oauth/authorize (the person "consents": it
// redirects to redirect_uri with a code, or error=access_denied), POST /login/oauth/access_token
// (client id + secret, single-use code, same redirect_uri, PKCE S256; and refresh_token grants),
// /user/installations and /user/installations/:id/repositories, and DELETE /applications/:id/token.
// A user token (ghu_…) sees only the repositories the installation includes. More /__mock state:
// { installed: [fullName], expiresIn: seconds, deny: bool, badRefresh: bool }; GET /__mock/log.
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
export const APP = { clientId: "Iv1.testclientid0001", clientSecret: "testsecret_" + "S".repeat(30), slug: "ai-workspace-test" };

export const TOKENS = {
  alice: "github_pat_" + "A".repeat(40),
  bob: "github_pat_" + "B".repeat(40),
  classic: "ghp_" + "C".repeat(36),
};
export function startMock(port, repos) {
  // repos: [{ owner: "alice", name, private, defaultBranch, url }]; the classic token is also alice.
  const who = { [TOKENS.alice]: "alice", [TOKENS.bob]: "bob", [TOKENS.classic]: "alice" };
  const state = { rateLimited: false, revoked: new Set(), delayMs: 0, installed: null, expiresIn: 28800, deny: false, badRefresh: false, log: [] };
  const codes = new Map(), userTokens = new Map(), refreshTokens = new Map(), revokedTokens = new Set();
  const issue = (login) => { const t = "ghu_" + randomBytes(18).toString("hex"), r = "ghr_" + randomBytes(30).toString("hex"); userTokens.set(t, { login, exp: Date.now() + state.expiresIn * 1000 }); refreshTokens.set(r, login); return { access_token: t, token_type: "bearer", scope: "", expires_in: state.expiresIn, refresh_token: r, refresh_token_expires_in: 15811200 }; };
  const readBody = async (rq) => { let b = ""; for await (const c of rq) b += c; return b; };
  const list = repos.map((r, i) => ({ id: 1000 + i, ...r }));
  const shape = (r, login) => ({ id: r.id, full_name: `${r.owner}/${r.name}`, name: r.name, owner: { login: r.owner }, private: !!r.private, default_branch: r.defaultBranch || "main",
    clone_url: r.url, html_url: `https://github.example/${r.owner}/${r.name}`, archived: false, permissions: { pull: true, push: r.owner === login, admin: r.owner === login } });
  const server = http.createServer(async (req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, "http://x");
    state.log.push({ method: req.method, path: u.pathname, query: u.search });
    if (u.pathname === "/__mock/log") return send(200, state.log);
    // github.com: the person authorizes the app (consent is simulated), then the browser is redirected
    if (u.pathname === "/login/oauth/authorize" && req.method === "GET") {
      const q = u.searchParams, to = new URL(q.get("redirect_uri") || "http://invalid/");
      if (q.get("client_id") !== APP.clientId) return send(404, { message: "Not Found" });
      if (state.deny) { to.search = new URLSearchParams({ error: "access_denied", error_description: "The user has denied your application access.", state: q.get("state") || "" }).toString(); }
      else { const code = randomBytes(10).toString("hex"); codes.set(code, { login: "alice", challenge: q.get("code_challenge"), method: q.get("code_challenge_method"), redirectUri: q.get("redirect_uri") }); to.search = new URLSearchParams({ code, state: q.get("state") || "" }).toString(); }
      res.writeHead(302, { location: to.href }); return res.end();
    }
    if (u.pathname === "/login/oauth/access_token" && req.method === "POST") {
      const j = JSON.parse((await readBody(req)) || "{}");
      if (j.client_id !== APP.clientId || j.client_secret !== APP.clientSecret) return send(200, { error: "incorrect_client_credentials" });
      if (j.grant_type === "refresh_token") {
        const login = refreshTokens.get(j.refresh_token); refreshTokens.delete(j.refresh_token);
        if (!login || state.badRefresh) return send(200, { error: "bad_refresh_token" });
        return send(200, issue(login));
      }
      const c = codes.get(j.code); codes.delete(j.code);
      const pkce = c && c.method === "S256" && createHash("sha256").update(String(j.code_verifier || "")).digest("base64url") === c.challenge;
      if (!c || c.redirectUri !== j.redirect_uri || !pkce) return send(200, { error: "bad_verification_code" });
      return send(200, issue(c.login));
    }
    const del = /^\/applications\/([^/]+)\/token$/.exec(u.pathname);
    if (del && req.method === "DELETE") {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString("base64")}`) return send(401, { message: "Requires authentication" });
      const j = JSON.parse((await readBody(req)) || "{}"); revokedTokens.add(j.access_token); userTokens.delete(j.access_token); res.writeHead(204); return res.end();
    }
    if (u.pathname === "/__mock" && req.method === "POST") {
      let b = ""; for await (const c of req) b += c; const j = JSON.parse(b || "{}");
      if ("installed" in j) state.installed = j.installed;
      if ("expiresIn" in j) state.expiresIn = j.expiresIn;
      if ("deny" in j) state.deny = !!j.deny;
      if ("badRefresh" in j) state.badRefresh = !!j.badRefresh;
      if ("rateLimited" in j) state.rateLimited = !!j.rateLimited;
      if ("delayMs" in j) state.delayMs = j.delayMs;
      if (j.revoked) state.revoked = new Set(j.revoked);
      for (const [full, v] of Object.entries(j.set || {})) Object.assign(list.find((r) => `${r.owner}/${r.name}` === full), v);
      return send(200, { ok: true });
    }
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1], ut = userTokens.get(token), login = who[token] || (ut && ut.exp > Date.now() ? ut.login : null);
    if (!login) return send(401, { message: "Bad credentials" });
    if (state.rateLimited) return send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) });
    const scopes = token === TOKENS.classic ? { "x-oauth-scopes": "repo, read:org" } : {};
    // A user token of the app sees only what the installation includes (and what the person can see).
    const visible = list.filter((r) => (r.owner === login || !r.private) && (r.owner === login) && !state.revoked.has(`${r.owner}/${r.name}`) && (!ut || (state.installed || []).includes(`${r.owner}/${r.name}`)));
    if (ut && u.pathname === "/user/installations") return send(200, { total_count: 1, installations: [{ id: 77, account: { login }, repository_selection: "selected", app_slug: APP.slug }] });
    if (ut && u.pathname === "/user/installations/77/repositories") return send(200, Number(u.searchParams.get("page") || 1) === 1 ? { total_count: visible.length, repositories: visible.map((r) => shape(r, login)) } : { total_count: visible.length, repositories: [] });
    if (u.pathname === "/user") return send(200, { login, name: login[0].toUpperCase() + login.slice(1) }, { "x-ratelimit-remaining": "4999", ...scopes });
    if (u.pathname === "/user/repos") return send(200, Number(u.searchParams.get("page") || 1) === 1 ? visible.map((r) => shape(r, login)) : [], { "x-ratelimit-remaining": "4998" });
    const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) { const r = visible.find((x) => x.owner === m[1] && x.name === m[2]); return r ? send(200, shape(r, login)) : send(404, { message: "Not Found" }); }
    send(404, { message: "Not Found" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ close: () => server.close(), url: `http://127.0.0.1:${port}` })));
}
