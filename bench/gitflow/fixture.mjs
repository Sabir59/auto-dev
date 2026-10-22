// A disposable repository shaped like the MATW workflow, for the Git workflow worker's tests:
// an "origin" (bare) and a clone whose origin/* branches the worker reads, with the cases from
// the branch-sync assessment. Nothing outside the given folder is touched.
//   import { buildFixture } from "./fixture.mjs"; const fx = buildFixture(dir);
//
// dev-main (vs sabir-dev):
//   PR #101 bau/donate-button  Sameem  S1 "DON-12 add donate button", S2 "DON-12 style the donate button"
//   PR #102 innovax/cart-rename Ali    I1 "Rename total() to sum()" (lib.js, cart.js)
//   PR #103 bau/cart-banner     Sameem S3 "Show a cart banner" (cart.js: needs I1's change → conflicts without it)
//   direct                      Sabir  S4 "DON-15 fix app title"   → reverted by Ali (R1)
//   direct                      Sameem S5 "Tweak the footer"       (an equivalent copy is already on sabir-dev)
//   direct                      Dev Bot U1 "Update dependencies"   (nobody configured)
//   direct                      "Sameem" from a personal email N1 "Adjust spacing" (name only: uncertain)
// uat-main / sabir-uat → preprod-main:
//   PR #201 bau/receipt (cut from preprod-main)  Sabir "DON-20 send a receipt email": merged into uat-main and sabir-uat
//   PR #202 bau/from-dev (cut from dev-main, so it carries I1 and others): merged into sabir-uat only
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const PEOPLE = {
  sameem: { name: "Sameem", email: "sameem@matw.test" }, sabir: { name: "Sabir", email: "sabir@matw.test" },
  ali: { name: "Ali", email: "ali@innovax.test" }, prodOnly: { name: "Prod Hotfixer", email: "hotfix@prod.test" }, bot: { name: "Dev Bot", email: "bot@ci.test" }, sameemPersonal: { name: "Sameem", email: "sameem.k@gmail.test" },
};

export function buildFixture(dir) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const origin = join(dir, "origin.git"), work = join(dir, "repo");
  let t = Date.parse("2026-09-01T09:00:00Z");
  const env = (p) => { t += 3600e3; const d = new Date(t).toISOString(); return { ...process.env, GIT_AUTHOR_NAME: p.name, GIT_AUTHOR_EMAIL: p.email, GIT_COMMITTER_NAME: p.name, GIT_COMMITTER_EMAIL: p.email, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }; };
  const g = (args, p = PEOPLE.sabir) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "init.defaultBranch=preprod-main", ...args], { cwd: work, env: env(p), encoding: "utf8" }).trim();
  const file = (f, text) => { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), text); };
  const edit = (f, from, to) => writeFileSync(join(work, f), readFileSync(join(work, f), "utf8").replace(from, to));
  const commit = (p, msg) => { g(["add", "-A"], p); g(["commit", "-q", "-m", msg], p); return g(["rev-parse", "HEAD"]); };
  const pr = (into, n, branch, p) => { g(["checkout", "-q", into]); g(["merge", "-q", "--no-ff", branch, "-m", `Merge pull request #${n} from MATWProject-org/${branch}`, "-m", `PR ${n}`], p); return g(["rev-parse", "HEAD"]); };

  execFileSync("git", ["init", "-q", "--bare", "-b", "preprod-main", origin]);
  mkdirSync(work); g(["init", "-q", "-b", "preprod-main"]);
  file("src/app.js", "export const title = 'Donate';\nexport const theme = 'light';\n");
  file("src/lib.js", "export function total(items) { return items.length; }\n");
  file("src/cart.js", "import { total } from './lib';\nexport const count = (c) => total(c.items);\n");
  file("src/footer.js", "export const footer = 'MATW';\n");
  file("package.json", '{ "name": "site", "version": "1.0.0" }\n');
  const base = commit(PEOPLE.sabir, "Initial site");
  for (const b of ["dev-main", "uat-main", "sabir-dev", "sabir-uat"]) g(["branch", b]);
  const s = {};
  // dev-main
  g(["checkout", "-q", "-b", "bau/donate-button", "dev-main"]);
  file("src/donate.js", "export const donate = () => 'donate';\n"); s.S1 = commit(PEOPLE.sameem, "DON-12 add donate button");
  file("src/donate.css", ".donate { color: green; }\n"); s.S2 = commit(PEOPLE.sameem, "DON-12 style the donate button");
  s.PR101 = pr("dev-main", 101, "bau/donate-button", PEOPLE.sabir);
  g(["checkout", "-q", "-b", "innovax/cart-rename", "dev-main"]);
  file("src/lib.js", "export function sum(items) { return items.length; }\n"); file("src/cart.js", "import { sum } from './lib';\nexport const count = (c) => sum(c.items);\n");
  s.I1 = commit(PEOPLE.ali, "Rename total() to sum()"); s.PR102 = pr("dev-main", 102, "innovax/cart-rename", PEOPLE.ali);
  g(["checkout", "-q", "-b", "bau/cart-banner", "dev-main"]);
  edit("src/cart.js", "export const count = (c) => sum(c.items);", "export const count = (c) => sum(c.items);\nexport const banner = (c) => `${sum(c.items)} items`;");
  s.S3 = commit(PEOPLE.sameem, "Show a cart banner"); s.PR103 = pr("dev-main", 103, "bau/cart-banner", PEOPLE.sabir);
  g(["checkout", "-q", "dev-main"]);
  edit("src/app.js", "'Donate'", "'Donate now'"); s.S4 = commit(PEOPLE.sabir, "DON-15 fix app title");
  g(["revert", "--no-edit", s.S4], PEOPLE.ali); s.R1 = g(["rev-parse", "HEAD"]);
  edit("src/footer.js", "'MATW'", "'MATW Project'"); s.S5 = commit(PEOPLE.sameem, "Tweak the footer");
  edit("package.json", "1.0.0", "1.0.1"); s.U1 = commit(PEOPLE.bot, "Update dependencies");
  edit("src/app.js", "'light'", "'airy'"); s.N1 = commit(PEOPLE.sameemPersonal, "Adjust spacing");
  // sabir-dev already has a copy of S5 (cherry-picked without -x: a different commit, the same patch)
  g(["checkout", "-q", "sabir-dev"]); g(["cherry-pick", s.S5], PEOPLE.sabir); s.S5copy = g(["rev-parse", "HEAD"]);
  // uat-main and sabir-uat
  g(["checkout", "-q", "-b", "bau/receipt", "preprod-main"]);
  file("src/receipt.js", "export const receipt = () => 'sent';\n"); s.RC = commit(PEOPLE.sabir, "DON-20 send a receipt email");
  s.PR201uat = pr("uat-main", 201, "bau/receipt", PEOPLE.sabir); s.PR201 = pr("sabir-uat", 201, "bau/receipt", PEOPLE.sabir);
  g(["checkout", "-q", "-b", "bau/from-dev", "dev-main"]);
  file("src/thanks.js", "export const thanks = () => 'thanks';\n"); s.FD = commit(PEOPLE.sabir, "DON-21 thank-you page");
  s.PR202 = pr("sabir-uat", 202, "bau/from-dev", PEOPLE.sabir);
  // prod-main (off-limits): a hotfix by someone who appears nowhere else, so "never read" is testable.
  g(["checkout", "-q", "-b", "prod-main", "preprod-main"]); file("src/hotfix.js", "export const hotfix = 1;\n"); s.PROD = commit(PEOPLE.prodOnly, "Production hotfix");
  g(["checkout", "-q", "preprod-main"]);
  g(["remote", "add", "origin", origin]); g(["push", "-q", "origin", "--all"]); g(["fetch", "-q", "origin"]);
  return { dir, origin, repo: work, base, shas: s };
}

// The MATW-like configuration for this fixture (what a person would enter in Setup).
export const fixtureConfig = (workspace) => ({
  workspace, refs: "remote",
  teams: [{ name: "BAU", ours: true, branchPatterns: ["bau/*", "sabir-*"] }, { name: "Innovax", ours: false, branchPatterns: ["innovax/*"] }],
  people: [{ name: "Sameem", team: "bau", github: "sameem-matw", emails: [PEOPLE.sameem.email] }, { name: "Sabir", team: "bau", github: "Sabir59", emails: [PEOPLE.sabir.email] }, { name: "Ali", team: "innovax", github: "ali-innovax", emails: [PEOPLE.ali.email] }],
  mappings: [{ source: "dev-main", destination: "sabir-dev", kind: "sync", strategy: "selective" }, { source: "uat-main", destination: "sabir-uat", kind: "sync", strategy: "selective" }, { source: "sabir-uat", destination: "preprod-main", kind: "promote", strategy: "feature" }],
  proposals: true,
});
