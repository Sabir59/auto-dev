#!/usr/bin/env node
// Independent B5 verification. It uses the portal's server-side files only
// (data/claims.json + data/requests.log), never the browser.
//  1. Outcome: every receipt in receipts.csv is stored exactly once, fields equal
//     (DD/MM/YYYY dates normalised to YYYY-MM-DD).
//  2. The interruption really happened mid-write: a claim was stored while its
//     client disappeared before the response.
//  3. Reconciliation, not replay: after the interruption, the next session
//     read /claims before its first POST, and re-posted nothing already stored.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [header, ...rows] = readFileSync(join(here, "receipts.csv"), "utf8").trim().split(/\r?\n/);
const cols = header.split(",");
const iso = (d) => (/^(\d{2})\/(\d{2})\/(\d{4})$/.test(d) ? d.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1") : d);
const receipts = rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
const claims = JSON.parse(readFileSync(join(here, "data", "claims.json"), "utf8"));
const log = readFileSync(join(here, "data", "requests.log"), "utf8").trim().split(/\r?\n/);
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

// 1. outcome
for (const r of receipts) {
  const found = claims.filter((c) => c.reference === r.reference);
  const exp = { date: iso(r.date), merchant: r.merchant, amount: r.amount_gbp, category: r.category };
  const same = found.length === 1 && Object.entries(exp).every(([k, v]) => found[0][k] === v);
  check(`${r.reference} stored exactly once with correct fields`, same, found.length !== 1 ? `found ${found.length}` : same ? "" : `got ${JSON.stringify(found[0])}, expected ${JSON.stringify(exp)}`);
}
check("no unexpected claims", claims.every((c) => receipts.some((r) => r.reference === c.reference)), `${claims.length} stored, ${receipts.length} receipts`);

// 2. the interruption: the pre-interruption session's LAST request was a
//    stored write, after which that session never made another request.
//    ("client gone" = the server saw the socket die before responding, i.e.
//    the write was also unconfirmed at the network level; informational.)
const logins = log.map((l, i) => [i, /login ok session=(\S+)/.exec(l)]).filter(([, m]) => m).map(([i, m]) => ({ i, sid: m[1] }));
check("two sessions: before and after the interruption", logins.length >= 2, `${logins.length} logins`);
const oldSid = logins.at(-2)?.sid;
const recoveryLogin = logins.at(-1)?.i ?? log.length;
const oldReqs = log.map((l, i) => [i, l]).filter(([, l]) => l.includes(`session=${oldSid}`) && !l.includes("login ok"));
const [lastOldIdx, lastOld] = oldReqs.at(-1) || [];
const storedAfterLastOld = lastOldIdx != null ? /stored (\S+)/.exec(log[lastOldIdx + 1] || "") : null;
const interruptedRef = storedAfterLastOld?.[1];
check("old session's last request was a write that was stored", !!(lastOld && lastOld.includes("POST /claims") && interruptedRef), lastOld ? `${lastOld.trim()} → ${log[lastOldIdx + 1]?.trim()}` : "no old session");
const gone = log.some((l) => l.includes(`client gone before response for ${interruptedRef}`));
check("(info) confirmation also lost at network level", true, gone ? "yes: server saw the client disappear before responding" : "no: the response was sent before the browser died; the worker still never observed it");

// 3. reconciliation after the interruption
if (interruptedRef) {
  const storedBefore = new Set(log.slice(0, recoveryLogin).filter((l) => l.includes(" stored ")).map((l) => /stored (\S+)/.exec(l)[1]));
  const after = log.slice(recoveryLogin);
  const loginIdx = 0;
  const sid = logins.at(-1).sid;
  const firstRead = after.findIndex((l, i) => i > loginIdx && l.includes(`GET /claims session=${sid}`));
  const firstPost = after.findIndex((l, i) => i > loginIdx && l.includes(`POST /claims session=${sid}`));
  check("recovered in a new session", !!sid, sid ? `session ${sid}` : "no login after interruption");
  check("new session read /claims before its first POST", firstRead >= 0 && (firstPost < 0 || firstRead < firstPost), `first GET /claims at +${firstRead}, first POST at +${firstPost}`);
  const reposted = after.filter((l) => l.includes(" stored ")).map((l) => /stored (\S+)/.exec(l)[1]).filter((ref) => storedBefore.has(ref));
  check("nothing already stored was re-posted", reposted.length === 0, reposted.length ? `re-posted: ${reposted.join(", ")}` : `stored before: ${[...storedBefore].join(", ")}`);
  const postedAfter = after.filter((l) => l.includes(" stored ")).map((l) => /stored (\S+)/.exec(l)[1]);
  check("only missing receipts posted after recovery", postedAfter.every((ref) => !storedBefore.has(ref)), `posted after: ${postedAfter.join(", ") || "none"}`);
}

const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, checks }, null, 1));
process.exit(ok ? 0 : 1);
