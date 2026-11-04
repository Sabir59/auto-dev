// A person's integration credentials on disk (GitHub, Figma, Builder): encrypted at rest whenever the
// process has the person's credential key, plain JSON otherwise (a local, single-person console, as
// before).
//
// Hosted, the gateway derives each person's key from AIW_SECRETS_KEY and the person's id (HKDF) and
// gives it only to that person's console, in memory (AIW_CREDENTIAL_KEY). The console never passes
// it to a worker (workerEnv drops AIW_*). A run's tool servers that read a credential (the Figma
// reader, Builder) ask their own console for it at start (loadKeyFromConsole: the run's token, the
// console's loopback port, live runs only), so it's never written into a run's MCP config file. The
// key is never on the data volume or in a backup, so neither holds a usable credential.
//
// A plain file found while a key is set (written before encryption existed) is encrypted on first read.
// File: { "v": 1, "enc": "aes-256-gcm", "iv", "tag", "ct" }, with the credential's kind ("github",
// "figma", "builder") as associated data, so one kind's file can't be passed off as another's.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const parseKey = (v) => { const k = Buffer.from(String(v || ""), "base64"); return k.length === 32 ? k : null; };
let KEY = parseKey(process.env.AIW_CREDENTIAL_KEY);
export const hasKey = () => !!KEY;

// A tool server started by a run: ask its own console for the person's key (null locally: no key).
export async function loadKeyFromConsole(env = process.env) {
  if (KEY || !env.AIW_AUTHZ_URL) return hasKey();
  try {
    const r = await fetch(`${env.AIW_AUTHZ_URL}/credential-key?server=${encodeURIComponent(env.AIW_AUTHZ_SERVER || "")}`, { headers: { "x-aiw-authz": env.AIW_AUTHZ_TOKEN || "" }, signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json().catch(() => null) : null;
    if (j?.key) KEY = parseKey(j.key);
  } catch {}
  return hasKey();
}

const aad = (kind) => Buffer.from(`aiw-secret-file:v1:${kind}`);
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file + ".tmp", "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(file + ".tmp", file);
}

export function writeSecretJson(file, kind, obj) {
  if (!KEY) return writeAtomic(file, JSON.stringify(obj, null, 1));
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
  c.setAAD(aad(kind));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  writeAtomic(file, JSON.stringify({ v: 1, enc: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }));
}

// The credential, or a thrown error (fs's ENOENT when there's none; a SecretFileError when it can't
// be read). Never returns or throws the contents of an encrypted file it couldn't open.
export class SecretFileError extends Error {}
export function readSecretJson(file, kind) {
  const rec = JSON.parse(readFileSync(file, "utf8"));
  if (rec?.enc !== "aes-256-gcm") {
    if (KEY) { try { writeSecretJson(file, kind, rec); } catch {} } // encrypt a plain one on first read
    return rec;
  }
  if (!KEY) throw new SecretFileError("This credential is encrypted and this process doesn't have the key to read it.");
  try {
    const iv = Buffer.from(String(rec.iv), "base64"), tag = Buffer.from(String(rec.tag), "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("bad iv or tag");
    const d = createDecipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
    d.setAAD(aad(kind)); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(Buffer.from(String(rec.ct), "base64")), d.final()]).toString("utf8"));
  } catch { throw new SecretFileError("This credential can't be read (it was stored with another key, or it's damaged). Connect again."); }
}
