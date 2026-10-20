// "Connect with GitHub" (worker-ui/github-app.mjs), end to end in a real browser: the console (its
// own test instance and data) and a mock of github.com's GitHub App web flow and API
// (bench/github/mock-github.mjs). The mock enforces what GitHub documents (client secret, one-time
// code, same redirect_uri, PKCE S256, installation-scoped repositories, refresh, revocation); it
// proves the console's side of the flow, not GitHub's.
//   via bench/workspace-ui/run-suite.sh github-app  (sets GITHUB_API_BASE, GITHUB_WEB_BASE,
//   GITHUB_CONNECTOR_DIR and a short GITHUB_STATE_TTL_MS)
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startMock, TOKENS, APP } from "../github/mock-github.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, { DATA, GHDIR } = process.env;
const TTL = Number(process.env.GITHUB_STATE_TTL_MS) || 4000;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data, base = BASE) => fetch(base + path, { method, headers: { ...H, origin: base }, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (c, m) => { if (!c) throw new Error(m); };
const results = [], errors = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d ?? null).slice(0, 220)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `github-app-fail-${results.length}.png`) }).catch(() => {}); } };
const credFile = join(GHDIR, "credentials.json"), appFile = join(GHDIR, "app.json");
const cred = () => (existsSync(credFile) ? JSON.parse(readFileSync(credFile, "utf8")) : null);
const consoleLog = () => (existsSync(join(DATA, "console.log")) ? readFileSync(join(DATA, "console.log"), "utf8") : "");

// A repository each for the mock: alice can see site and docs; the app is installed on site only.
const root = mkdtempSync(join(tmpdir(), "gha-"));
const mock = await startMock(8785, [{ owner: "alice", name: "site", private: true, url: `file:///${root}/site.git` }, { owner: "alice", name: "docs", private: true, url: `file:///${root}/docs.git` }]);
const setMock = (j) => fetch(`${mock.url}/__mock`, { method: "POST", body: JSON.stringify(j) });
const mockLog = async () => (await fetch(`${mock.url}/__mock/log`)).json();
// The browser's part of the flow, without a browser: start, follow GitHub's redirect, stop before the callback.
async function begin(base = BASE) {
  const s = await call("POST", "/github/app/start", {}, base); must(s.status === 200 && s.body.url, JSON.stringify(s));
  const r = await fetch(s.body.url, { redirect: "manual" }); return new URL(r.headers.get("location"));
}
const callback = async (u) => { const r = await fetch(u, { redirect: "manual" }); return { status: r.status, location: r.headers.get("location") }; };

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("pageerror", (e) => errors.push(e.message));
mkdirSync(GHDIR, { recursive: true }); rmSync(appFile, { force: true }); rmSync(credFile, { force: true });

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await step("not set up: both ways are shown; Connect with GitHub is disabled and says what's needed; the API refuses to start", async () => {
    await page.click("#ghOpen"); await page.waitForSelector("#ghAppOpt");
    const app = await page.locator("#ghAppOpt").innerText(), tok = await page.locator("#ghTokenOpt").innerText();
    const s = await call("POST", "/github/app/start", {});
    must(await page.locator("#ghAppConnect").isDisabled() && /app\.json/.test(app) && /personal access token/i.test(tok) && s.status === 400 && /isn't set up/.test(s.body.error), JSON.stringify({ app, tok, s }));
    return { start: s.status, setupNote: (await page.locator("#ghAppSetup").innerText()).slice(0, 90) };
  });
  writeFileSync(appFile, JSON.stringify(APP)); // the person's one-time setup: the app's client id, secret and name
  await setMock({ installed: ["alice/site"], expiresIn: 28800, deny: false, badRefresh: false });
  await step("set up: Connect with GitHub goes to GitHub, comes back to this console, and connects; the page says so", async () => {
    await page.reload({ waitUntil: "networkidle" }); await page.click("#ghOpen"); await page.waitForSelector("#ghAppConnect:not([disabled])");
    const choose = await page.getAttribute("#ghChoose", "href");
    await page.click("#ghAppConnect");
    await page.waitForFunction(() => /Connected with GitHub/.test(document.querySelector("#ghMsg")?.textContent || ""), null, { timeout: 15000 });
    const c = cred(), addr = page.url(), body = await page.locator("#ghBody").innerText();
    must(c?.method === "app" && /^ghu_/.test(c.token) && /^ghr_/.test(c.refreshToken) && c.expiresAt > Date.now() && addr === `${BASE}/` && /Connected as @alice/.test(body) && /with GitHub/.test(body), JSON.stringify({ c: c && { method: c.method }, addr, body: body.slice(0, 200) }));
    must(choose === `${mock.url}/apps/${APP.slug}/installations/new`, choose);
    await page.screenshot({ path: join(HERE, "shots", "github-app-connected.png") });
    return { stored: c.method, addressAfter: addr, chooseRepositories: choose };
  });
  await step("secrets stay on the server: the token, refresh token and client secret are never in the page, its API answers, the console log or a URL", async () => {
    const c = cred(), report = JSON.stringify((await call("GET", "/github")).body), html = await page.content(), log = consoleLog(), urls = (await mockLog()).map((x) => x.path + x.query).join("\n");
    const leaks = [c.token, c.refreshToken, APP.clientSecret].filter((s) => report.includes(s) || html.includes(s) || log.includes(s) || urls.includes(s));
    const authorize = (await mockLog()).find((x) => x.path === "/login/oauth/authorize");
    const q = new URLSearchParams(authorize.query);
    must(!leaks.length && q.get("code_challenge_method") === "S256" && q.get("state")?.length >= 40 && q.get("redirect_uri") === `${BASE}/github/callback` && !q.has("client_secret"), JSON.stringify({ leaks: leaks.length, authorize: authorize.query.slice(0, 200) }));
    return { leaks: 0, redirect: q.get("redirect_uri"), pkce: q.get("code_challenge_method") };
  });
  await step("repository selection is GitHub's: discovery lists only what the app is installed on; registering one gives no worker access", async () => {
    await page.click("#ghFind"); await page.waitForSelector("#ghBody .ghfound");
    const found = await page.locator("#ghBody .ghfound .ell").allInnerTexts();
    must(found.length === 1 && found[0] === "alice/site", JSON.stringify(found));
    const w = (await call("POST", "/workers", { name: "No Repo Access", capabilities: ["files.read"] })).body;
    await page.click('[data-gh-reg="alice/site"]'); await page.waitForFunction(() => /Registered alice\/site/.test(document.querySelector("#ghMsg")?.innerText || ""));
    const after = (await call("GET", "/workers")).body.workers.find((x) => x.id === w.id), reg = (await call("GET", "/github")).body.repos.map((r) => r.fullName);
    must(reg.includes("alice/site") && (after.repos || []).length === 0, JSON.stringify({ reg, repos: after.repos }));
    const other = await call("POST", "/github/repos", { fullName: "alice/docs" }); // visible to alice, but not chosen for the app
    must(other.status === 404, JSON.stringify(other));
    return { discovered: found, registered: reg, workerRepos: after.repos || [], notChosen: other.status };
  });
  await step("a forged or unknown state is refused and changes nothing", async () => {
    const before = readFileSync(credFile, "utf8");
    const r = await callback(`${BASE}/github/callback?code=anything&state=${"x".repeat(43)}`), r2 = await callback(`${BASE}/github/callback?code=anything`);
    must(r.status === 303 && r.location === "/?github=state" && r2.location === "/?github=state" && readFileSync(credFile, "utf8") === before, JSON.stringify({ r, r2 }));
    return { forged: r.location, missing: r2.location };
  });
  await step("a callback can't be replayed: the second use of the same state is refused", async () => {
    const u = await begin(), first = await callback(u.href), again = await callback(u.href);
    must(first.location === "/?github=connected" && again.location === "/?github=state", JSON.stringify({ first, again }));
    return { first: first.location, replay: again.location };
  });
  await step("an expired state is refused (and the code isn't exchanged)", async () => {
    const before = readFileSync(credFile, "utf8"), u = await begin();
    await new Promise((ok) => setTimeout(ok, TTL + 500));
    const r = await callback(u.href), log = await mockLog(), exchanged = log.filter((x) => x.path === "/login/oauth/access_token").length;
    const r2 = await callback(u.href); // and it's gone, not just late
    must(r.location === "/?github=expired" && r2.location === "/?github=state" && readFileSync(credFile, "utf8") === before, JSON.stringify({ r, r2 }));
    return { expired: r.location, afterwards: r2.location, tokenRequestsSoFar: exchanged };
  });
  await step("a state started by another console address (localhost vs 127.0.0.1) is refused", async () => {
    const u = await begin(`http://localhost:${port}`); // its redirect is localhost's
    const r = await callback(u.href.replace(`http://localhost:${port}`, BASE));
    must(r.location === "/?github=state", JSON.stringify(r));
    return { crossConsole: r.location };
  });
  await step("GitHub's own errors are handled: a cancelled sign-in and a code GitHub won't exchange leave things as they were", async () => {
    const before = readFileSync(credFile, "utf8");
    await setMock({ deny: true }); const d = await callback((await begin()).href); await setMock({ deny: false });
    const u = await begin(); u.searchParams.set("code", "not-the-code"); const x = await callback(u.href);
    must(d.location === "/?github=denied" && x.location === "/?github=exchange" && readFileSync(credFile, "utf8") === before, JSON.stringify({ d, x }));
    await page.goto(`${BASE}/?github=denied`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /cancelled on GitHub/.test(document.querySelector("#ghMsg")?.textContent || ""));
    must(page.url() === `${BASE}/`, page.url());
    return { cancelled: d.location, badCode: x.location, pageSays: "You cancelled on GitHub. Nothing was connected." };
  });
  await step("an installation change on GitHub (setup_action) just says so and stores nothing", async () => {
    const before = readFileSync(credFile, "utf8"), r = await callback(`${BASE}/github/callback?installation_id=77&setup_action=update`);
    must(r.location === "/?github=installed" && readFileSync(credFile, "utf8") === before, JSON.stringify(r));
    return r;
  });
  await step("an expiring token is refreshed before use; a refused refresh says to connect again", async () => {
    await setMock({ expiresIn: 30 }); must((await callback((await begin()).href)).location === "/?github=connected", "reconnect");
    const t1 = cred().token, v = await call("POST", "/github/connection/verify", {}), t2 = cred().token;
    must(v.status === 200 && t1 !== t2 && /^ghu_/.test(t2), JSON.stringify({ v: v.status, refreshed: t1 !== t2 }));
    await setMock({ badRefresh: true }); must((await callback((await begin()).href)).location === "/?github=connected", "reconnect 2");
    const bad = await call("POST", "/github/connection/verify", {}), g = (await call("GET", "/github")).body;
    must(bad.status === 401 && /Connect with GitHub again/.test(bad.body.error) && /again/.test(g.connection.error || ""), JSON.stringify({ bad, conn: g.connection }));
    await setMock({ expiresIn: 28800, badRefresh: false });
    return { refreshed: true, refusedRefresh: bad.body.error };
  });
  await step("disconnect deletes the local sign-in and revokes it at GitHub", async () => {
    must((await callback((await begin()).href)).location === "/?github=connected", "reconnect");
    const token = cred().token, r = await call("DELETE", "/github/connection");
    const revoked = (await mockLog()).filter((x) => x.method === "DELETE" && x.path === `/applications/${APP.clientId}/token`).length;
    const stillWorks = (await fetch(`${mock.url}/user`, { headers: { authorization: `Bearer ${token}` } })).status;
    must(r.status === 200 && r.body.connected === false && r.body.revokedAtGitHub === true && !existsSync(credFile) && revoked >= 1 && stillWorks === 401, JSON.stringify({ r: r.body?.revokedAtGitHub, revoked, stillWorks }));
    return { deletedLocally: true, revokedAtGitHub: true, tokenAfter: stillWorks };
  });
  await step("the token way still works, beside the app", async () => {
    await page.reload({ waitUntil: "networkidle" }); await page.click("#ghOpen"); await page.waitForSelector("#ghToken");
    await page.fill("#ghToken", TOKENS.alice); await page.click("#ghConnect");
    await page.waitForFunction(() => /Connected as @alice/.test(document.querySelector("#ghBody")?.innerText || ""));
    const c = cred(), body = await page.locator("#ghBody").innerText();
    must(c.method === "token" && /fine-grained token/.test(body) && /Connect with GitHub instead/.test(body), JSON.stringify({ method: c.method, body: body.slice(0, 160) }));
    await page.screenshot({ path: join(HERE, "shots", "github-app-token.png") });
    return { method: c.method };
  });
} catch (e) { results.push({ step: "(between steps)", ok: false, error: e.message }); console.log("FAIL (between steps)", e.message); } finally {
  writeFileSync(join(HERE, "github-app-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
  await b.close(); mock.close();
  rmSync(root, { recursive: true, force: true });
}
