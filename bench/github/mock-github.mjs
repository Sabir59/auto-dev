// A local stand-in for the parts of the GitHub REST API the console uses (/user, /user/repos,
// /repos/:owner/:name), for tests. Each token is an identity that sees its own repositories only.
// It proves the console's requests, error handling and access rules; it proves nothing about
// GitHub itself. POST /__mock sets state: { rateLimited, revoked: [fullName], set: { fullName: {...} } }.
import http from "node:http";

export const TOKENS = {
  alice: "github_pat_" + "A".repeat(40),
  bob: "github_pat_" + "B".repeat(40),
  classic: "ghp_" + "C".repeat(36),
};
export function startMock(port, repos) {
  // repos: [{ owner: "alice", name, private, defaultBranch, url }]; the classic token is also alice.
  const who = { [TOKENS.alice]: "alice", [TOKENS.bob]: "bob", [TOKENS.classic]: "alice" };
  const state = { rateLimited: false, revoked: new Set(), delayMs: 0 };
  const list = repos.map((r, i) => ({ id: 1000 + i, ...r }));
  const shape = (r, login) => ({ id: r.id, full_name: `${r.owner}/${r.name}`, name: r.name, owner: { login: r.owner }, private: !!r.private, default_branch: r.defaultBranch || "main",
    clone_url: r.url, html_url: `https://github.example/${r.owner}/${r.name}`, archived: false, permissions: { pull: true, push: r.owner === login, admin: r.owner === login } });
  const server = http.createServer(async (req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__mock" && req.method === "POST") {
      let b = ""; for await (const c of req) b += c; const j = JSON.parse(b || "{}");
      if ("rateLimited" in j) state.rateLimited = !!j.rateLimited;
      if ("delayMs" in j) state.delayMs = j.delayMs;
      if (j.revoked) state.revoked = new Set(j.revoked);
      for (const [full, v] of Object.entries(j.set || {})) Object.assign(list.find((r) => `${r.owner}/${r.name}` === full), v);
      return send(200, { ok: true });
    }
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1], login = who[token];
    if (!login) return send(401, { message: "Bad credentials" });
    if (state.rateLimited) return send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) });
    const scopes = token === TOKENS.classic ? { "x-oauth-scopes": "repo, read:org" } : {};
    const visible = list.filter((r) => (r.owner === login || !r.private) && (r.owner === login) && !state.revoked.has(`${r.owner}/${r.name}`));
    if (u.pathname === "/user") return send(200, { login, name: login[0].toUpperCase() + login.slice(1) }, { "x-ratelimit-remaining": "4999", ...scopes });
    if (u.pathname === "/user/repos") return send(200, Number(u.searchParams.get("page") || 1) === 1 ? visible.map((r) => shape(r, login)) : [], { "x-ratelimit-remaining": "4998" });
    const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) { const r = visible.find((x) => x.owner === m[1] && x.name === m[2]); return r ? send(200, shape(r, login)) : send(404, { message: "Not Found" }); }
    send(404, { message: "Not Found" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ close: () => server.close(), url: `http://127.0.0.1:${port}` })));
}
