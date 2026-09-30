#!/usr/bin/env node
// B5 test environment (NOT part of the worker): a tiny expense portal whose
// state lives on the server, so it survives the browser dying.
//
//   node bench/b5-expense-portal/server.mjs          # start on :8790
//   node bench/b5-expense-portal/server.mjs --reset  # wipe claims + log, then start
//
// Deliberate, disclosed properties:
// - POST /claims persists the claim IMMEDIATELY, then waits 3s before
//   responding (a slow backend), so a client can die after its write landed
//   but before it saw the confirmation.
// - No duplicate protection: submitting the same reference twice stores it twice.
// - Dates must be YYYY-MM-DD (server-side validation, a real application rule).
// - Every request is appended to data/requests.log for after-the-fact verification.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const CLAIMS = join(DATA, "claims.json");
const LOG = join(DATA, "requests.log");
const PORT = 8790;
const USER = "employee", PASS = "demo-pass";
const SLOW_MS = 3000;

mkdirSync(DATA, { recursive: true });
if (process.argv.includes("--reset") || !existsSync(CLAIMS)) {
  writeFileSync(CLAIMS, "[]\n");
  writeFileSync(LOG, "");
}
const sessions = new Set();
const load = () => JSON.parse(readFileSync(CLAIMS, "utf8"));
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:32px;max-width:760px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left}
label{display:block;margin:10px 0 2px}input{padding:6px;width:280px}.error{color:#b00020;font-weight:600}.ok{color:#1b5e20;font-weight:600}</style>
</head><body>${body}</body></html>`;
}
function send(res, status, html, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}
const cookieSession = (req) => (/(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => ok(Object.fromEntries(new URLSearchParams(b)))); });

const loginPage = (err = "") => page("Sign in", `<h1>Expense portal — sign in</h1>${err && `<p class="error" data-test="error">${err}</p>`}
<form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" data-test="username">
<label for="password">Password</label><input id="password" name="password" type="password" data-test="password">
<p><button type="submit" data-test="login">Sign in</button></p></form>`);

const claimsPage = (flash = "") => {
  const rows = load().map((c) => `<tr data-test="claim-row"><td data-test="ref">${esc(c.reference)}</td><td>${esc(c.date)}</td><td>${esc(c.merchant)}</td><td>${esc(c.amount)}</td><td>${esc(c.category)}</td></tr>`).join("");
  return page("My claims", `<h1>My claims</h1>${flash}<p><a href="/claims/new" data-test="new-claim">New claim</a></p>
<table data-test="claims-table"><thead><tr><th>Reference</th><th>Date</th><th>Merchant</th><th>Amount (GBP)</th><th>Category</th></tr></thead><tbody>${rows || `<tr><td colspan="5" data-test="empty">No claims yet</td></tr>`}</tbody></table>`);
};

const newClaimPage = (err = "", v = {}) => page("New claim", `<h1>New claim</h1>${err && `<p class="error" data-test="error">${esc(err)}</p>`}
<form method="post" action="/claims">
${["reference", "date", "merchant", "amount", "category"].map((f) => `<label for="${f}">${f[0].toUpperCase() + f.slice(1)}${f === "date" ? " (YYYY-MM-DD)" : f === "amount" ? " (GBP, e.g. 12.50)" : ""}</label><input id="${f}" name="${f}" data-test="${f}" value="${esc(v[f] || "")}">`).join("\n")}
<p><button type="submit" data-test="submit">Submit claim</button></p></form><p><a href="/claims">Back to claims</a></p>`);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const sid = cookieSession(req);
    const authed = sid && sessions.has(sid);
    log(`${req.method} ${url.pathname} ${authed ? "session=" + sid.slice(0, 8) : "no-session"}`);

    if (url.pathname === "/claims.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(load(), null, 1));
    }
    if (url.pathname === "/login" && req.method === "POST") {
      const b = await readBody(req);
      if (b.username !== USER || b.password !== PASS) return send(res, 401, loginPage("Wrong username or password."));
      const id = randomUUID();
      sessions.add(id);
      log(`  login ok session=${id.slice(0, 8)}`);
      return send(res, 303, "", { location: "/claims", "set-cookie": `sid=${id}; HttpOnly; Path=/` });
    }
    if (!authed) return url.pathname === "/" || url.pathname === "/login" ? send(res, 200, loginPage()) : send(res, 303, "", { location: "/login" });
    if (url.pathname === "/" ) return send(res, 303, "", { location: "/claims" });
    if (url.pathname === "/claims" && req.method === "GET") return send(res, 200, claimsPage());
    if (url.pathname === "/claims/new") return send(res, 200, newClaimPage());
    if (url.pathname === "/claims" && req.method === "POST") {
      const b = await readBody(req);
      const missing = ["reference", "date", "merchant", "amount", "category"].filter((f) => !String(b[f] || "").trim());
      if (missing.length) return send(res, 422, newClaimPage(`Missing: ${missing.join(", ")}`, b));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) { log(`  rejected ${b.reference}: bad date "${b.date}"`); return send(res, 422, newClaimPage(`Date must be YYYY-MM-DD (got "${b.date}")`, b)); }
      if (!/^\d+\.\d{2}$/.test(b.amount)) { log(`  rejected ${b.reference}: bad amount "${b.amount}"`); return send(res, 422, newClaimPage(`Amount must look like 12.50 (got "${b.amount}")`, b)); }
      const claims = load();
      claims.push({ reference: b.reference.trim(), date: b.date, merchant: b.merchant.trim(), amount: b.amount, category: b.category.trim(), receivedAt: new Date().toISOString() });
      writeFileSync(CLAIMS, JSON.stringify(claims, null, 1) + "\n");
      log(`  stored ${b.reference} (now ${claims.length} claims); responding in ${SLOW_MS}ms`);
      setTimeout(() => {
        if (res.destroyed || res.socket?.destroyed) { log(`  client gone before response for ${b.reference}`); return; }
        send(res, 200, claimsPage(`<p class="ok" data-test="flash">Claim ${esc(b.reference)} submitted.</p>`));
      }, SLOW_MS);
      return;
    }
    send(res, 404, page("Not found", "<h1>Not found</h1>"));
  })
  .listen(PORT, () => console.log(`expense portal on http://localhost:${PORT}`));
