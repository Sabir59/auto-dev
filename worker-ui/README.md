# Worker UI — minimal local view of the AI worker

```
User → Worker UI (this folder) → AI worker (headless Claude Code) → MCP / built-in tools → Figma, Browser, Files, Web
```

Run `node worker-ui/server.mjs`, open http://localhost:8799, enter a goal, and click **Start worker**.

## What it is, and isn't
- **The worker is unchanged.** It's the same Claude Code agent loop that ran B1–B6, started headless in this repo (`claude -p --output-format stream-json`) with this repo's `.mcp.json`. The UI does no reasoning, runs no tools and does no orchestration. It starts the process with the goal (on stdin), reads the worker's own event stream, and shows it.
- **Nothing else changed:** `plugin/`, `bridge/`, `mcp/`, `browser-adapter/`, `.mcp.json` and `worker/` are untouched.

## Where the events come from
| Event | Source |
|---|---|
| `start` | the stream's `system/init` (includes MCP server status) |
| `tool` (+ `env`) | each `tool_use` block; `env` comes from the tool name: `figma-executor` → Figma, `browser-executor` → Browser, file tools → Files, shell → Shell, web tools → Web. `ToolSearch` (schema loading) is hidden as plumbing. |
| `result` / `failure` | each `tool_result`; `is_error` → `failure` |
| `artifact` | a `Write`/`Edit` tool call, or a tagged `ARTIFACT:` line |
| `plan` `observation` `decision` `recovery` `verification` `done` | the worker's visible narration, one line per tag. `worker-instructions.md` (appended to its system prompt) asks it to prefix report lines with these tags. Untagged narration becomes `note`. Hidden reasoning isn't exposed. |
| `completed` | the stream's final `result` (turns, seconds, cost, final text) |

Contract: one JSON object per line, `{ ts, type, env?, tool?, summary, detail? }`, stored in `runs/<id>.jsonl` (the raw stream is in `runs/<id>.raw.jsonl`). The page subscribes over Server-Sent Events (`/events?run=<id>`), which replays the file and then streams live, so any past run can be reopened from the **Run** menu.

## First proof run (`runs/2026-09-30T08-55-02-185Z.jsonl`)
The B4 goal, started from the UI by typing into it, run by a fresh worker session with no memory of B4, and watched live:
- **Plan** → browser login → **Decision** (`standard_user`; the other accounts exist to show bugs) → catalogue → cart → **Verification** (the cart holds exactly the 3 planned items) → checkout → finish.
- **Real failures, not staged:** the UI's permission scope allows only `node`/`curl` in the shell, so the worker's `mkdir`/`cp` were blocked 4 times. The worker named the layer ("a permission layer blocked…"), recovered by writing the report with the file tool, and **reported the one thing it couldn't do** (copying the screenshots into the deliverable).
- **Result:** the same order as B4 (Backpack + Bike Light + Bolt T-Shirt, $55.97 + $4.48 = $60.45, Onesie excluded as an infant garment), with its own arithmetic check. Deliverable: `deliverables/b4-ui-run/REPORT.md`. 30 actions, about 2.5 min.
- **Integrity visible in the UI:** the goal told it not to read the previous answer, and the timeline shows no read of `docs/benchmarks.md` or `deliverables/b4-saucedemo-order/`.

## Known limitations
- **Semantic events depend on the tagging convention, and the worker only partly followed it.** It tagged the plan, one decision, one verification and DONE, but wrote its main decision (excluding the Onesie) and its arithmetic proof as untagged text at the end. Those show in the timeline as notes, not in "Findings & decisions". So "why did the next action happen?" is only as good as the worker's tagging.
- **Permission scope is fixed** in `server.mjs` (`ALLOWED`): no `mkdir`/`cp` in the shell (it caused this run's failures), and no approval prompts in headless mode. Blocked calls fail visibly, but nobody can approve them live.
- **One run at a time**, local only, no auth. By design, it's a research view.
- The UI trusts the worker's `DONE:` claim only as a claim. The status reads "Done (worker's claim)" until the process actually exits.
- The B5 limitation still applies: a silent browser relaunch shows up as a plausible-looking result.
