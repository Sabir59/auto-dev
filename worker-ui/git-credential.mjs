#!/usr/bin/env node
// Git credential helper for a hosted console's own git network commands (clone, push, ls-remote).
// The console runs git with `-c credential.helper= -c credential.helper=!node <this file>` and the
// person's GitHub token in AIW_GIT_TOKEN, for that one git process only. Nothing is stored: the
// helper only answers "get", only over https, and only for the host the console expects
// (AIW_GIT_HOST, github.com by default), so a remote rewritten to another host never receives it.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (process.argv[2] !== "get") return;
  const q = Object.fromEntries(input.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const host = (process.env.AIW_GIT_HOST || "github.com").toLowerCase(), token = process.env.AIW_GIT_TOKEN || "";
  if (!token || q.protocol !== "https" || String(q.host || "").toLowerCase() !== host) return;
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
});
