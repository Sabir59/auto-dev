#!/usr/bin/env node
// Pilot accounts for the hosted platform (gateway.mjs). Invite-only: an operator adds each person on
// the server; there's no sign-up page. Passwords are stored as scrypt hashes, never in clear.
// Each person gets a stable numeric OS user id (uid): their console and every worker it starts run
// as that uid, in a data dir only that uid can open (docs/HOSTED_ARCHITECTURE.md §4).
//
//   <AIW_DATA>/control/users.json  [{ id, email, name, hash, uid, seq, disabled, createdAt, updatedAt }]
//
// CLI (on the server, as the gateway's user; AIW_DATA must point at the data volume):
//   node worker-ui/users.mjs add <email> [--name "Full Name"]   prints a generated password once
//   node worker-ui/users.mjs passwd <email>                      a new generated password
//   node worker-ui/users.mjs disable|enable <email>              disabling also ends their sessions
//   node worker-ui/users.mjs list
// --password-stdin reads the password from stdin instead of generating one (at least 12 characters).
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export function hashPassword(pw) {
  const salt = randomBytes(16), h = scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${h.toString("base64")}`;
}
export function checkPassword(pw, stored) {
  const [kind, N, r, p, salt, h] = String(stored || "").split("$");
  if (kind !== "scrypt") return false;
  const want = Buffer.from(h, "base64");
  const got = scryptSync(String(pw), Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}
// For an unknown email the same work is done against this, so the answer takes as long either way.
const DUMMY = hashPassword(randomBytes(16).toString("hex"));

export function openUsers(dataDir, { uidBase = 20000 } = {}) {
  const dir = join(resolve(dataDir), "control"), file = join(dir, "users.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
  const write = (list) => { writeFileSync(file + ".tmp", JSON.stringify(list, null, 1), { mode: 0o600 }); renameSync(file + ".tmp", file); };
  const norm = (e) => String(e || "").trim().toLowerCase();
  // sessionsBefore: a password change ends every session started before it.
  const pub = (u) => u && { id: u.id, email: u.email, name: u.name, uid: u.uid, seq: u.seq, disabled: !!u.disabled, sessionsBefore: u.sessionsBefore || null };
  return {
    file,
    list: () => read().map(pub),
    byId: (id) => pub(read().find((u) => u.id === id)),
    add({ email, name, password }) {
      email = norm(email);
      if (!EMAIL.test(email)) throw new Error("That isn't an email address.");
      if (String(password || "").length < 12) throw new Error("The password must be at least 12 characters.");
      const list = read();
      if (list.some((u) => u.email === email)) throw new Error(`${email} already has an account.`);
      const seq = list.reduce((m, u) => Math.max(m, u.seq), 0) + 1, now = new Date().toISOString();
      const u = { id: `u-${randomUUID().slice(0, 12)}`, email, name: String(name || email.split("@")[0]).trim().slice(0, 80), hash: hashPassword(password), uid: uidBase + seq, seq, disabled: false, createdAt: now, updatedAt: now };
      write([...list, u]); return pub(u);
    },
    update(email, fn) {
      const list = read(), u = list.find((x) => x.email === norm(email));
      if (!u) throw new Error(`No account for ${norm(email)}.`);
      fn(u); u.updatedAt = new Date().toISOString(); write(list); return pub(u);
    },
    // The account for this email and password, or null. Disabled accounts never sign in.
    verify(email, password) {
      const u = read().find((x) => x.email === norm(email));
      const ok = checkPassword(password, u ? u.hash : DUMMY);
      return u && ok && !u.disabled ? pub(u) : null;
    },
  };
}

// ---- CLI ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, email, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const data = process.env.AIW_DATA;
  if (!data) { console.error("Set AIW_DATA to the platform's data directory."); process.exit(2); }
  const users = openUsers(data, { uidBase: Number(process.env.AIW_UID_BASE) || 20000 });
  const password = async () => {
    if (!rest.includes("--password-stdin")) return randomBytes(15).toString("base64url");
    let s = ""; for await (const c of process.stdin) s += c; return s.replace(/\r?\n$/, "");
  };
  try {
    if (cmd === "add") { const pw = await password(); const u = users.add({ email, name: opt("--name"), password: pw }); console.log(JSON.stringify(u)); if (!rest.includes("--password-stdin")) console.log(`Password (shown once): ${pw}`); }
    else if (cmd === "passwd") { const pw = await password(); if (pw.length < 12) throw new Error("The password must be at least 12 characters."); users.update(email, (u) => { u.hash = hashPassword(pw); u.sessionsBefore = new Date().toISOString(); }); if (!rest.includes("--password-stdin")) console.log(`New password (shown once): ${pw}`); else console.log("Password changed."); }
    else if (cmd === "disable" || cmd === "enable") console.log(JSON.stringify(users.update(email, (u) => { u.disabled = cmd === "disable"; })));
    else if (cmd === "list") for (const u of users.list()) console.log(`${u.disabled ? "disabled " : ""}${u.email}  ${u.name}  uid ${u.uid}  ${u.id}`);
    else { console.error("Usage: users.mjs add|passwd|disable|enable <email> [--name \"…\"] [--password-stdin] | list"); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
