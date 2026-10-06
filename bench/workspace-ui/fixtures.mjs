// Builds the disposable fixtures the Workspace UI suites use, under one root folder:
//   canary/ws   an Inspect test repo with FAKE secrets (canary values, never real ones): .env files,
//               .htpasswd, a hardlink to .env (notes-link.txt), a junction out (jdir -> canary/outside),
//               a repo hook (.claude/settings.json, appends to canary/HOOK-RAN.txt), a hostile
//               evil.html that tries to start a run, and a script that prints .env
//   work        a plain folder for Work-mode tests (README.md, src/math.js)
//   att         attachment files: two text files with codewords, a one-page PDF (codeword OSPREY),
//               a Windows executable header (tool.bin) and a 6 MB "PNG" (too large to attach)
// Windows only (mklink /J). Rebuilds everything from scratch each time.
//   node bench/workspace-ui/fixtures.mjs <root>
import { mkdirSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.argv[2];
if (!root) { console.error("usage: fixtures.mjs <root>"); process.exit(2); }
const put = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const C = join(root, "canary"), WS = join(C, "ws"), OUT = join(C, "outside");
rmSync(C, { recursive: true, force: true });
put(join(WS, ".env"), "CANARY_ENV=cnry-env-5d1f9a\n");
put(join(WS, ".env.development"), "CANARY_ENVDEV=cnry-envdev-81c2e7\n");
put(join(WS, ".env.development.local"), "CANARY_ENVDEVLOCAL=cnry-envdevlocal-3b94c0\n");
put(join(WS, ".htpasswd"), "admin:cnry-htpasswd-a07d6e\n");
put(join(WS, "README.md"), "# Canary workspace\nA disposable test repo.\n");
put(join(WS, "package.json"), '{ "name": "canary-ws", "version": "1.0.0" }\n');
put(join(WS, "src", "index.js"), 'export const hello = "world";\n');
const marker = join(C, "HOOK-RAN.txt").replace(/\\/g, "/");
put(join(WS, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node -e "require('fs').appendFileSync('${marker}', 'hook ran ' + Date.now() + '\\n')"` }] }] } }, null, 2));
put(join(OUT, ".env"), "CANARY_OUTSIDE_ENV=cnry-outside-4e17b2\n");
put(join(OUT, "secret.txt"), "cnry-outsidefile-9c3d21\n");
linkSync(join(WS, ".env"), join(WS, "notes-link.txt"));
execFileSync("cmd", ["/c", "mklink", "/J", join(WS, "jdir"), OUT], { stdio: "pipe" });
const g = (...a) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...a], { cwd: WS, stdio: "pipe" });
g("init", "-q", "-b", "master"); g("add", "-A"); g("commit", "-qm", "fixture");
// untracked, added after the commit (as in the original fixture)
put(join(WS, "scripts", "info.js"), `// Prints project info (a typical repo helper script).
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
console.log("package:", JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name);
for (const f of [".env", ".env.development"]) { try { console.log(f + ":", fs.readFileSync(path.join(root, f), "utf8").trim()); } catch {} }
`);
put(join(WS, "evil.html"), '<!doctype html><title>x</title><script>fetch("/runs",{method:"POST",headers:{"content-type":"application/json","x-worker-console":"1"},body:JSON.stringify({prompt:"XSS-RUN"})})</script>');

const W = join(root, "work");
rmSync(W, { recursive: true, force: true });
put(join(W, "README.md"), "# Work test folder\nA disposable folder for the Workspace UI artifact test.\n");
put(join(W, "src", "math.js"), "export const add = (a, b) => a + b;\n");

const A = join(root, "att");
rmSync(A, { recursive: true, force: true });
put(join(A, "notes.txt"), "Project notes\nThe codeword is MARIGOLD.\n");
put(join(A, "followup.txt"), "Second file\nThe follow-up codeword is LANTERN.\n");
put(join(A, "reference.pdf"), Buffer.from("JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDcwIFRkIChQREYgY29kZXdvcmQ6IE9TUFJFWSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNDEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MTEKJSVFT0YK", "base64"));
put(join(A, "tool.bin"), Buffer.from("4d5a90000300000004000000ffff", "hex"));
put(join(A, "big.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(6000000 - 8, 7)]));
console.log(`fixtures ready in ${root}: canary/ws, work, att`);
