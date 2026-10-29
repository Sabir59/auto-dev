// The real Claude Code runtime with its model calls going to a scripted stand-in (stub-model.mjs),
// for tests: the console starts it exactly as it starts the real binary (CLAUDE_BIN=<node>,
// CLAUDE_BIN_ARGS=["<this file>"]), with every argument it would pass. Only the model endpoint
// changes; tools, permission rules, hooks and MCP servers are the runtime's own.
//   STUB_REAL_CLAUDE  the real binary (claude.exe)
//   STUB_MODEL_URL    the stand-in model's address
// Use it only with a console whose Claude config dir is a test folder (WORKER_CONSOLE_CLAUDE_CONFIG_DIR).
import { spawn } from "node:child_process";
const real = process.env.STUB_REAL_CLAUDE, url = process.env.STUB_MODEL_URL;
if (!real || !url) { process.stderr.write("stub-claude: STUB_REAL_CLAUDE and STUB_MODEL_URL are required\n"); process.exit(2); }
const child = spawn(real, process.argv.slice(2), { stdio: "inherit", windowsHide: true,
  env: { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "stub-key-not-a-secret", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
const stop = () => { try { child.kill(); } catch {} };
process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("exit", stop);
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
