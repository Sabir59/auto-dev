// Each person's own AI provider account, for the hosted gateway (gateway.mjs). AI Workforce supplies
// no model access of its own: every person connects their own provider account and pays for their own
// usage. Anthropic's terms for products that host Claude Code require exactly that ("Each end user
// must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P
// inference provider credential"; docs/HOSTED_RUNTIME_AUDIT.md §2).
//
// This module is the only place that knows how a provider authenticates. The gateway's model
// endpoint asks it, at each request, for the calling person's credential; consoles and workers never
// receive one (their runtime talks to the gateway with a per-console token).
//
// Providers (auth: how the person proves the account is theirs):
//   anthropic-api   api-key        the person's own Anthropic API key (Claude Console). Built.
//   (later)         subscription   a Claude plan, signed in through Anthropic's own flow by the
//                                  unmodified CLI, its login kept in the person's own config dir.
//                                  The platform never collects, stores or proxies it, so it isn't a
//                                  credential this store holds. Not built: see docs/CLOUD_DEPLOYMENT.md.
//   (later)         cloud          Amazon Bedrock, Google Vertex AI, Microsoft Foundry.
//
// Storage: <AIW_DATA>/control/credentials/<person id>.json (root, 0600, inside the root-only control
// dir), encrypted with AES-256-GCM under AIW_SECRETS_KEY, with the person id and the provider as
// associated data: a file copied to another person, or altered, doesn't decrypt. The secrets key lives
// in the host's env file, not on the data volume, so the volume or a backup alone holds no usable
// credential. Losing the secrets key loses only the stored credentials (people connect again).
// Nothing here returns, logs or puts a credential in an error message.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, statSync, accessSync, constants as FS } from "node:fs";
import { join } from "node:path";

const trimSlash = (s) => String(s).replace(/\/+$/, "");
const upstreamOf = (env) => trimSlash(env.ANTHROPIC_UPSTREAM_URL || "https://api.anthropic.com");

export const PROVIDERS = {
  "anthropic-api": {
    label: "Anthropic API (your own key)",
    auth: "api-key",
    // Claude Code's wire protocol is Anthropic's Messages API; this provider passes it on unchanged.
    upstream: upstreamOf,
    authHeaders: (secret) => ({ "x-api-key": secret.apiKey }),
    // What the person submits, checked for shape only (the provider decides whether it's valid).
    read(input) {
      const apiKey = String(input?.apiKey || "").trim();
      if (!/^[\x21-\x7e]{20,300}$/.test(apiKey)) throw new CredentialError(400, "That doesn't look like an API key. Paste the whole key from the Claude Console (API keys).");
      return { apiKey };
    },
    // Asked of the provider before anything is stored: a key it rejects is never kept.
    async check(secret, env) {
      let r;
      try { r = await fetch(`${upstreamOf(env)}/v1/models?limit=1`, { headers: { "x-api-key": secret.apiKey, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15000) }); }
      catch { throw new CredentialError(502, "Couldn't reach Anthropic to check the key. Nothing was saved; try again in a moment."); }
      if (r.status === 401 || r.status === 403) throw new CredentialError(400, "Anthropic rejected this key (revoked, disabled or mistyped). Nothing was saved.");
      if (!r.ok) throw new CredentialError(502, `Anthropic couldn't check the key right now (status ${r.status}). Nothing was saved; try again in a moment.`);
    },
    // Configuration this provider needs from the gateway's environment.
    configProblems(env, { prod }) {
      let u; try { u = new URL(upstreamOf(env)); } catch { return ["ANTHROPIC_UPSTREAM_URL isn't a URL"]; }
      if (prod && (u.protocol !== "https:" || /^(127\.|localhost$|\[::1\]$)/.test(u.hostname))) return ["ANTHROPIC_UPSTREAM_URL must be an https provider address in production (a test upstream is only allowed with AIW_ENV=test)"];
      return [];
    },
    describe: (env) => new URL(upstreamOf(env)).host,
  },
};

export class CredentialError extends Error { constructor(status, message) { super(message); this.status = status; } }

// AIW_SECRETS_KEY: 32 random bytes, base64 (openssl rand -base64 32). null when missing or malformed.
export function parseSecretsKey(value) {
  const s = String(value || "").trim();
  if (!/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(s)) return null;
  const k = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return k.length === 32 ? k : null;
}

export function configProblems(env, { prod }) {
  const p = [];
  if (env.ANTHROPIC_API_KEY) p.push("ANTHROPIC_API_KEY is set, but the platform holds no central provider key: each person connects their own AI provider account. Remove it from the environment.");
  if (!parseSecretsKey(env.AIW_SECRETS_KEY)) p.push("AIW_SECRETS_KEY is required: 32 random bytes, base64 (openssl rand -base64 32). It encrypts each person's stored provider credential; keep it in the host's env file, not on the data volume.");
  for (const pr of Object.values(PROVIDERS)) p.push(...pr.configProblems(env, { prod }));
  return p;
}

// The store. dir: root-only; uid/gid: who owns its files (root when isolated).
export function openCredentials(dir, secretsKey, { env = process.env, log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const keyId = createHash("sha256").update(secretsKey).digest("hex").slice(0, 12);
  const fileOf = (userId) => { if (!/^[\w-]{1,80}$/.test(userId)) throw new Error("bad person id"); return join(dir, `${userId}.json`); };
  const aad = (userId, provider) => Buffer.from(`aiw-credential:v1:${userId}:${provider}`);
  // Only a credential that decrypted is cached (until it's changed here). "None" and "unusable" are
  // read again each time, so a file restored by the operator, or a passing read error, isn't stuck.
  const cache = new Map(); // userId -> { provider, secret, meta }
  const warned = new Map(); // userId -> the file version already reported unusable (one log line each)
  const gen = new Map(); // userId -> changes so far: a key check that a later change overtook isn't saved
  const encrypt = (userId, provider, plain, iv = randomBytes(12)) => {
    const c = createCipheriv("aes-256-gcm", secretsKey, iv, { authTagLength: 16 }); c.setAAD(aad(userId, provider));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  };
  const decrypt = (userId, provider, rec) => {
    const iv = Buffer.from(String(rec.iv), "base64"), tag = Buffer.from(String(rec.tag), "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("bad iv or tag");
    const d = createDecipheriv("aes-256-gcm", secretsKey, iv, { authTagLength: 16 });
    d.setAAD(aad(userId, provider)); d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(String(rec.ct), "base64")), d.final()]).toString("utf8");
  };

  function load(userId) {
    if (cache.has(userId)) return cache.get(userId);
    const f = fileOf(userId);
    let raw, version;
    try { raw = readFileSync(f, "utf8"); version = statSync(f).mtimeMs; } catch (e) {
      if (e.code === "ENOENT") return null;
      return unusable(userId, "?", "This account's saved provider credential can't be read right now. Try again in a moment.");
    }
    try {
      const rec = JSON.parse(raw);
      if (!PROVIDERS[rec.provider]) return unusable(userId, version, "This account's saved provider isn't one this platform has any more. Connect your provider again.");
      if (rec.keyId !== keyId) return unusable(userId, version, "This account's saved provider credential was stored with another secrets key. Connect your provider again.");
      const entry = { provider: rec.provider, secret: JSON.parse(decrypt(userId, rec.provider, rec)), meta: { addedAt: rec.addedAt, checkedAt: rec.checkedAt } };
      cache.set(userId, entry); warned.delete(userId);
      return entry;
    } catch { return unusable(userId, version, "This account's saved provider credential can't be read. Connect your provider again."); }
  }
  function unusable(userId, version, problem) {
    if (warned.get(userId) !== version) { warned.set(userId, version); log("warn", "stored provider credential unusable", { user: userId }); }
    return { problem };
  }
  // tmp + fsync + rename: after a crash the file is the old one or the new one, never half of one.
  function writeAtomic(f, text) {
    const fd = openSync(f + ".tmp", "w", 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(f + ".tmp", f);
  }

  return {
    // For the model endpoint: { provider, secret } or null. Never leaves the gateway.
    resolve(userId) { const e = load(userId); return e && !e.problem ? { provider: e.provider, secret: e.secret } : null; },
    // For the person (and their console): never a secret.
    status(userId) {
      const e = load(userId);
      if (!e || e.problem) return { connected: false, ...(e?.problem ? { problem: e.problem } : {}), message: e?.problem || "No AI provider is connected to your account. AI Workforce doesn't supply model access: connect your own provider account (an Anthropic API key) in Account settings to run workers." };
      const p = PROVIDERS[e.provider];
      return { connected: true, provider: e.provider, label: p.label, auth: p.auth, ...e.meta };
    },
    async connect(userId, provider, input) {
      const p = PROVIDERS[provider];
      if (!p) throw new CredentialError(400, `Unknown provider. Available: ${Object.keys(PROVIDERS).join(", ")}.`);
      const secret = p.read(input);
      const g = (gen.get(userId) || 0) + 1; gen.set(userId, g);
      await p.check(secret, env);
      // A disconnect (or another connect) while the provider was checking wins: this key isn't saved.
      if (gen.get(userId) !== g) throw new CredentialError(409, "Your provider was changed while this key was being checked. Nothing was saved.");
      const now = new Date().toISOString();
      writeAtomic(fileOf(userId), JSON.stringify({ v: 1, provider, keyId, ...encrypt(userId, provider, JSON.stringify(secret)), addedAt: now, checkedAt: now }));
      cache.delete(userId);
      return this.status(userId);
    },
    disconnect(userId) { gen.set(userId, (gen.get(userId) || 0) + 1); rmSync(fileOf(userId), { force: true }); cache.delete(userId); return this.status(userId); },
    available: () => Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, auth: p.auth })),
    // For /readyz: the folder is writable and the secrets key encrypts and decrypts (no person's data used).
    selfTest() {
      try {
        accessSync(dir, FS.W_OK);
        const probe = randomBytes(16).toString("hex");
        if (decrypt("selftest", "selftest", encrypt("selftest", "selftest", probe)) !== probe) return { ok: false, why: "encryption check failed" };
        return { ok: true };
      } catch (e) { return { ok: false, why: e.code === "EACCES" || e.code === "EROFS" ? "not writable" : "encryption check failed" }; }
    },
  };
}
