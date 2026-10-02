#!/usr/bin/env node
// One-time Figma authorization with OAuth (the production route): a person who can view the
// designs approves our app once in the browser; the Reader then keeps working from Figma URLs,
// refreshing the token itself. The app is registered by us at figma.com/developers/apps with the
// redirect URL http://localhost:<port>/callback.
//
//   node figma-reader/oauth.mjs --client-id <id> --client-secret <secret> [--port 3007] [--scopes "file_content:read file_metadata:read"]
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { saveCredentials, CRED_FILE } from "./reader.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const clientId = opt("client-id", process.env.FIGMA_CLIENT_ID), clientSecret = opt("client-secret", process.env.FIGMA_CLIENT_SECRET);
const port = Number(opt("port", 3007)), scopes = opt("scopes", "file_content:read file_metadata:read current_user:read");
if (!clientId || !clientSecret) { console.error("Usage: node figma-reader/oauth.mjs --client-id <id> --client-secret <secret> [--port 3007]"); process.exit(2); }
const redirect = `http://localhost:${port}/callback`;
const state = randomBytes(16).toString("hex");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authUrl = `https://www.figma.com/oauth?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, scope: scopes, state, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })}`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== "/callback") { res.writeHead(404); return res.end(); }
  const done = (code, msg) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(msg); };
  if (u.searchParams.get("state") !== state) return done(400, "State mismatch: this response isn't from the authorization we started.");
  if (u.searchParams.get("error")) { done(400, `Figma said: ${u.searchParams.get("error")}`); console.error("Authorization refused:", u.searchParams.get("error")); return server.close(); }
  try {
    const r = await fetch("https://api.figma.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64") },
      body: new URLSearchParams({ redirect_uri: redirect, code: u.searchParams.get("code"), grant_type: "authorization_code", code_verifier: verifier }),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    saveCredentials({ type: "oauth", access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 0) * 1000, client_id: clientId, client_secret: clientSecret, user_id: j.user_id_string || j.user_id, scopes });
    const me = await (await fetch("https://api.figma.com/v1/me", { headers: { authorization: `Bearer ${j.access_token}` } })).json().catch(() => ({}));
    done(200, `Connected to Figma as ${me.handle || me.email || "your account"}. You can close this tab.`);
    console.log(JSON.stringify({ ok: true, user: me.handle, email: me.email, expiresInSeconds: j.expires_in, hasRefreshToken: !!j.refresh_token, saved: CRED_FILE }, null, 1));
  } catch (e) { done(500, `Token exchange failed: ${e.message}`); console.error("Token exchange failed:", e.message); }
  server.close();
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Opening Figma to authorize (scopes: ${scopes}).\nIf no browser opens, visit:\n${authUrl}`);
  spawn("cmd", ["/c", "start", "", authUrl.replace(/&/g, "^&")], { stdio: "ignore", detached: true }).unref();
});
