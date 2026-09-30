# Worker Console — local chat front-end for the AI worker

```
User → Worker Console (this folder) → existing Claude Code worker (headless) → existing MCP + built-in tools → Figma / Browser / Files / Web
```

Run `node worker-ui/server.mjs`, then open http://localhost:8799. The terminal is only needed to start the server.

## What it is, and isn't
The console is a **control surface and observer**. It never plans, never calls Figma or the browser, and duplicates no MCP logic. Every action on screen is the worker's own, taken from the worker's own output stream. Nothing under `plugin/`, `bridge/`, `mcp/`, `browser-adapter/`, `.mcp.json` or `worker/` changed.

## How it works
- **Start:** `claude -p --input-format stream-json --output-format stream-json` in this repo, with `--mcp-config .mcp.json --strict-mcp-config`, the reporting convention in `worker-instructions.md`, and a fixed tool scope (`ALLOWED` in `server.mjs`). The real `claude.exe` is launched directly (no shell), so Stop kills the worker itself.
- **Messages:** each chat message is written to the worker's stdin as a stream-json `user` line.
- **Follow-ups** (status `waiting`) go to the **same process**: same context, same MCP servers, same browser page and logins.
- **Resume** (status `stopped` / `finished` / `failed` / `interrupted`) starts a **new process** with `--resume <session_id>`. The conversation context is kept. Tool processes are new, so browser pages and logins are gone; Figma and files are unaffected. The UI says this before you send.
- **Stop** kills the process. **End run** closes stdin, and the worker exits cleanly. **Restart** starts a new run with the same first message.
- **Events:** the worker's stream becomes `{ts, type, env?, tool?, summary, detail?}` lines in `runs/<id>.jsonl` (raw stream in `.raw.jsonl`), streamed to the page over SSE. `user`/`reply` are the conversation; `tool`/`result`/`failure`/`status` are operational; tagged lines (`PLAN:` … `DONE:`) become findings.
- **History:** `runs/<id>.meta.json` holds the prompt, status, session id, environments used, artifacts, failures, the DONE claim and cost.
- **Prompts:** `prompts.json` (save, favourite, edit, delete). A click only fills the input; nothing runs until you press Send or ▶.

Statuses: `idle`, `starting`, `running`, `waiting` (turn done, awaiting a follow-up), `finished`, `stopped`, `failed`, `interrupted` (the server restarted under a live run; resumable).

## First proof (2026-09-30), done entirely in the console through the browser
1. **Saved the prompt before sending.** It was stored, and no run started (`active: null`).
2. **Run `09-57-47`:** the expense-portal report task.
   - The worker used Browser, Shell and Files, and hit 3 real shell-permission blocks (redirection, variable expansion, a PowerShell expression).
   - It tagged them itself as "tool layer, not the portal", recovered, and cross-checked the total two ways (£185.24).
   - It wrote `deliverables/console-proof/claims-report.md`, and said it couldn't prove the list was complete (an unopened `?page=2`).
3. **Follow-up in the same run:** "open that ?page=2 result…".
   - It stayed in the same process (1 process start, 0 resumes), and the browser was still logged in (no re-login), so the MCP session carried over.
   - The worker showed `page` is ignored (byte-identical responses) and updated the report.
   - **End run** → `finished` (exit 0).
4. **Run `10-02-27` started from the saved prompt (▶).** Then **Stop** mid-run: the worker PID was gone, with no leftover worker, MCP or browser processes.
5. **Resume & send on the stopped run:** a second process on the same session. Asked without tools, the worker accurately stated the task and exactly how far it had got ("opened the sign-in page… haven't logged in… or changed that file"), which matches the event log.

Found and fixed by using it:
- the layout overflowed (long unbroken lines widened the grid column);
- native dialogs are dismissed by automated browsers (replaced with inline controls);
- stale client metadata disabled Resume;
- worker scratch files were counted as artifacts (only repo files count now).

## Limitations
- **Semantic events rely on the tagging convention.** It was followed well in these runs, less so in the first B4 run. Untagged reasoning shows as chat text, not as findings.
- **Fixed tool scope, and no live approval.** A blocked shell command fails visibly (it happened in every run here), but you can't approve it from the console.
- **Enter-to-send** is implemented but wasn't exercised by the automated proof: the browser tools have no key press. It was clicked instead.
- **A follow-up can't interrupt a busy turn.** Wait for `waiting`, or Stop.
- **Resume can't restore a browser session.** Only the conversation is restored; the worker has to log in again.
- One run at a time, local only, no auth. That's by design for now.
