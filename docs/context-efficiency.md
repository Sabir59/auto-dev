# Context efficiency for long Figma tasks (2026-10-15)

> Project overview: `docs/PROJECT_HANDOFF.md`. This note covers why long design runs got expensive, what changed, and how it was measured.

## 1. Root cause, confirmed in the code and the runtime's own logs

The run analysed is `2026-10-14T11-57-17-097Z`, the Senior UI/UX Design Engineer on Sonnet 5. The diagnostic tool is `bench/figma-executor/analyze-run.mjs`.

Its totals: 13 turns, 3 worker processes, **376 model requests**, and about 790 tool calls, of which 202 were `create_frame`, 195 `create_text`, 145 `modify_node`, 132 `set_auto_layout` and **62 `get_document_state`** (522,607 characters of results).

1. **One growing conversation.**
   - A follow-up goes to the same Claude Code session (`--input-format stream-json`, the same process, or `--resume`).
   - Every request re-sends the whole conversation, served mostly from the prompt cache.
   - The context per request grew from about 25k to about 808k tokens, which is within Sonnet 5's 1M window, so automatic compaction never ran.
   - Tokens read from cache across the run: about 185.5M (runtime-reported). That is most of the volume.
2. **One tool call per element.** Every frame, text and edit was its own model request, so each one re-read the whole conversation.
3. **Full document dumps.**
   - `GET_DOCUMENT_STATE` with an id is a recursive dump of every property, four levels deep.
   - The model, not the platform, chose to call it 62 times; the worker's definition doesn't ask for it.
   - Each result stays in the conversation from then on.
4. **No visibility.** The console had no context telemetry, and no way to compact or start fresh with the task state.
5. **A cost bug.** The console added the runtime's per-process running total of cost on every turn.
   - It showed **$126** for a run whose runtime-reported list-price estimate is **$48.58**.
   - Fixed: only each turn's increase is added now.
   - Earlier runs' stored totals are still inflated; `analyze-run.mjs` recomputes them from the log.

**Billing:** these are list-price estimates from the runtime. On a subscription the cost is plan usage, not per-run billing.

## 2. What changed

### Batched Figma edits (`mcp/server.mjs`, `figma_batch`)
- **What it does:** runs up to 100 edits in one call, in order, through the existing bridge commands. No plugin change was needed.
- **References:** an op can name its node (`ref`), and later ops use `"$ref"` wherever an id goes, so dependent elements can be built in one call.
- **Validated before anything runs:**
  - each op against **that tool's own schema**;
  - batchable tools only: creates, edits, auto layout, delete, instances, variables binding, images;
  - no reads, exports or page switches, and no code;
  - refs must be defined before use and only once;
  - at most 100 ops and 200k characters.

  An invalid batch changes nothing.
- **When an op fails:** the error is reported with its index, ops that depend on it are skipped, and the rest continue (`stopOnError` stops instead).
- **The report:** a compact list of each op's status, the created ids by ref, and the errors. It says explicitly that it is **not visual verification**.
- **Team lock:** a Team's Figma file lock applies to every op.

### Compact, bounded inspection (`figma_get_document_state`)
- **Compact by default:** a node read returns id, name, type, geometry, auto layout, text content and size, and fill colours. `fields` picks property groups (geometry, layout, text, style, component), and `detail: "full"` gives everything.
- **Nothing dropped silently:** the omitted keys are listed.
- **Bounded:** output is capped by `maxChars` (default 15,000). Children below a depth are summarised as `childCount` and `childIds`, and the cut is stated.
- **"Unchanged" instead of a repeat:**
  - It is used only when a fresh read is identical to what the run was last given, so manual edits in Figma are seen.
  - Any edit through these tools resets it, and `fresh: true` forces the full answer.
- **Rollback:** `FIGMA_EXECUTOR_LEGACY=1`, or `WORKER_FIGMA_LEGACY=1` on the console, restores the earlier tools and instructions.

### Telemetry (`worker-ui/server.mjs`, the run's `meta.telemetry`; UI "Context & usage" card)
- **Labelled RUNTIME** (from the runtime's own usage fields):
  - model requests;
  - context per request (input + cache read + cache write);
  - per-turn tokens (cache read, cache write, new input, output; summed per process);
  - the context window.
- **Labelled MEASURED** (counted by the console):
  - tool calls by tool and their durations;
  - Figma calls;
  - document reads and their size in **characters**;
  - batches and their ops;
  - visual checks (exports);
  - compactions and worker processes.
- **Cost of telemetry:** none. It is computed from the stream the worker already produces.
- **Warnings:** they fire when the context per request passes `min(contextWarnTokens, contextWarnFraction × window)`, and when document reads pass `docStateWarnChars`. All three are configurable in `<data>/console-settings.json`; the defaults are 250k tokens, 0.4 and 150k characters.

### Compaction and continuation (verified against Claude Code 2.1.283 headless)
- **Compact:** sends Claude Code's own `/compact`, with instructions to keep the objective, constraints, decisions, Figma ids, done and outstanding work, errors and verification. Verified: the runtime reports a manual `compact_boundary` with before and after sizes, and facts survive.
- **Continue in a fresh session:**
  1. The worker writes a handoff in one turn, under fixed headings. `summary: false` skips this step.
  2. The console ends the old process cleanly.
  3. It starts a new run (same workspace, worker, Team, model and effort) whose first message is the handoff:
     - the task state below;
     - the worker's summary;
     - the next instruction.
  - The old run and its full history stay for audit.
  - Verified: the new session receives the handoff and none of the old raw tool output.
- **Safety:** neither starts while the worker is mid-step (refused). Both are shown in the activity panel and logged.

### Task state (`runs/<id>.state.json`, `GET /runs/<id>/state`)
- **What it holds:** a short ledger built from the stream:
  - the objective (verbatim) and later requests;
  - the Figma file and page;
  - nodes made, with ids;
  - recent batches;
  - milestones (PLAN, DECISION, VERIFICATION and DONE lines);
  - errors (FAILURE and NEEDS lines, and failed tools);
  - visual checks;
  - sessions, compactions, and the run it continues from.
- **How it's stored:** it exists from the start of a run and is saved each turn. It holds references, not a transcript, and is kept apart from the worker's long-term memory.

### Platform rules (`worker-ui/worker-efficiency.md`)
These are added to every worker's instructions, except in legacy mode:
- batch Figma edits;
- inspect compactly and only what's needed;
- don't re-read to confirm an edit;
- verify visually at milestones.

## 3. Tests
- **`bench/figma-executor/batch-test.mjs`: 10/10.** Real MCP server, fake bridge. Covers:
  - dependent ops and their order;
  - partial failure;
  - every refusal, with nothing executed;
  - size bounds;
  - compact, fields, full and bounded reads;
  - "unchanged" reads, reset by edits and by manual Figma changes;
  - the not-visual-verification note;
  - legacy mode.
- **`bench/figma-executor/live-batch-test.mjs`: 11/11.** The real plugin and bridge, on a temporary page that is deleted afterwards.
  - 8 edits ran in one call (760 ms), and the compact read matched.
  - Partial failure, dependency skipping, a retry of only the failed part (nothing duplicated) and `stopOnError` all behaved correctly.
  - "Unchanged" reads were reset by an edit, and by an edit made outside the run straight through the bridge.
  - The export worked, and the person's page was never switched.
  - There is no automatic retry: a worker re-sends a corrected batch. If the bridge times out after Figma has applied an edit, re-sending it would duplicate that edit (single calls have the same risk).
- **`bench/workspace-ui/context-test.mjs`** (real worker on Haiku):
  - the telemetry matches the runtime's stream;
  - the configurable warning fires;
  - real `/compact` works and the decision survives;
  - continuation passes the handoff, with no old raw tool output;
  - compact and continue are refused mid-step;
  - Stop and resume still work;
  - cost is counted once.

## 4. Before and after on the same design task
See section 5; the numbers come from `bench/figma-executor/measure/{legacy,new}.json`.

## 5. Results (2026-10-15, one run each)

**The setup:**
- The same brief: a 1200 px pricing section with three cards, built with auto layout, then exported, checked and fixed.
- The same worker (Senior UI/UX Design Engineer) and model (`claude-sonnet-5`), in a fresh session, on a temporary page.
- The only difference: the "before" run used `WORKER_FIGMA_LEGACY=1` (the earlier tools and instructions).

**Results:** `bench/figma-executor/measure/{legacy,new}.json` and `.png`.

| | Before (legacy tools) | After | Change |
|---|---|---|---|
| Model requests (runtime) | 55 | 18 | 67% less |
| Tool calls (measured) | 201 | 17 | 92% less |
| Figma calls (measured) | 195 | 14 (6 batches, 157 edits) | 93% less |
| Document reads (measured) | 2 (2650 chars) | 0 | n/a |
| Context at the end, per request (runtime) | 157k | 119k | 24% less |
| Tokens read from cache (runtime) | 5.48M | 1.27M | 77% less |
| Tokens written to cache (runtime) | 157k | 112k | 28% less |
| Output tokens (runtime) | 65k | 52k | 20% less |
| List-price estimate (runtime; not billed on a subscription) | $2.38 | $1.23 | 48% less |
| Wall time (measured) | 18 min | 13 min | 29% less |
| Visual checks (exports) | 6 | 3 | both exported, found an issue and fixed it |

**Two more tasks (2026-10-15)** on the same worker and model:
- an FAQ section: six accordion questions and a contact card (`faq-*`);
- a "Meet our guides" grid: six cards and a CTA banner (`guides-*`).

| Task | Model requests | Figma calls | Tokens read from cache | Time | List-price estimate | Tool errors |
|---|---|---|---|---|---|---|
| Pricing (above) | 55 → 18 | 195 → 14 | 5.48M → 1.27M | 18 → 13 min | $2.38 → $1.23 | 1 → 2 (both refused batches, nothing ran) |
| FAQ | 31 → 20 | 82 → 13 (3 batches, 93 edits) | 2.39M → 1.22M | 7.1 → 7.2 min | $1.32 → $1.03 | 0 → 0 |
| Guides | 43 → 14 | 119 → 10 (3 batches, 107 edits) | 2.94M → 0.78M | 7.2 → 6.1 min | $1.43 → $0.92 | 0 → 0 |

- The Guides "before" run finished, but its export and cleanup step failed to start (a Windows `spawn UNKNOWN`). `recover-measure.mjs` wrote its result from the saved run and deleted the temporary page.
- Visual review: only the pricing pair was compared by eye. The FAQ and Guides exports are in `measure/` and haven't been reviewed.

**What the numbers mean:**
- **Sample size:** one run per variant, so run-to-run variation isn't measured. Treat the size of the change as indicative, not exact.
- **Why the savings compound:** the brief is small. In a long session every request re-reads the whole conversation, so fewer requests and smaller results save more and more over time.
- **Visual quality:** comparable. Compare `legacy.png` and `new.png`: both are complete, consistent sections with a highlighted recommended plan, and both runs found and fixed an issue in their own export.
- **What the batch did:** the "after" run made 157 edits in 6 batches and read the document 0 times. The "before" run made 195 single Figma calls.

## 6. Remaining limits
- **Long sessions can still grow.** The warning and the Compact and Continue buttons need a person to click them; nothing compacts or continues automatically. That's by design: a restart must never happen in the middle of a step or lose task state.
- **The handoff summary costs one request** at the old conversation's size. `summary: false` skips it and hands over the task state only.
- **"Unchanged" reads after compaction:** the model may no longer hold the earlier result, so the answer tells it to pass `fresh: true` if it doesn't have it.
- **The task state is built from what the stream shows:** tool results, and PLAN, DECISION, VERIFICATION, DONE, FAILURE and NEEDS lines. Decisions that are never written as such reach a fresh session only through the worker's handoff summary.
- **Past runs' stored costs are still inflated** (the bug in section 1). `analyze-run.mjs` recomputes any run from its log.
