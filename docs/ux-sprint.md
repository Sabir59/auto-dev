# UX and product validation sprint (from 2026-10-22)

The product-experience record for the 8-day sprint: the audit, the journey we're proving, what changed, the evidence, and what's still open. Platform design stays in `worker-platform.md` (creating a worker from a request: §13) and `team-platform.md`. The earlier 29-finding remediation is `ux-remediation.md`.

**Markers:** VERIFIED (by code or a test run), INFERRED, UNKNOWN.

## 0. Correction: the worker-creation journey (2026-10-22, afternoon)

The first version of this sprint got the main journey wrong, and the owner corrected it.

- **Intended:** the customer describes the work they want done (Shopify, Google Sheets, WordPress, Next.js, Builder.io, or a mix). The product learns their stack, asks only the questions that work needs, and composes a worker for that job.
- **Built first** (`d413e6b`): a catalogue of five worker templates (Frontend, QA, Research, UI/UX Design, Builder.io Content Editor), each with fixed settings.
- **Why it was wrong:**
  - it made people translate their job into our job titles;
  - anything outside the five (Shopify, Sheets, WordPress, combinations) had nowhere to go;
  - settings followed the title, not the request.
- **Kept:** the worker definition and runtime, enforcement, the guide's explanation of the three pieces, "Before you start", per-message results, "Review the changes", the Versions race fix and the safe-write fix.
- **Replaced:** the `template` blocks, `/templates`, the per-template setup page, and the catalogue in the guide and behind New worker. Now: describe → tools and systems (recognised, editable) → only their questions → review → create → first task (`worker-platform.md` §13).

## 1. Baseline (2026-10-22)

- **Code:** branch `main`, HEAD `0433144` plus uncommitted Figma Executor work. That work was verified and committed first as `324ebd7` (lifecycle 17/17 twice, console wiring 2/2, local boundaries 8/8, devctl 16/16).
- **Blocker (VERIFIED; resolved the same day, when the owner signed in again):** the local Claude Code sign-in had expired ("OAuth session expired and could not be refreshed"). No real worker can run locally, so the suites that start one fail at the first message: workers, remediation, manage step 6, versions steps 2–5 and 14, boundaries, teams, attach, mentions, workflow, context, model. **They need re-running after the owner signs in again** (`claude` → `/login`).
- **What still runs:** the hosted path drives the real Claude Code CLI and real tools with a scripted fake model (`bench/hosted/fake-anthropic.mjs`). The journey test below uses it. It proves the product's side of each step, not what a real model does.

## 2. Audit: what a first-time person met (screenshots in the session; after-shots in `bench/hosted/shots/journey-*.png`)

| # | What they saw | Why it hurt | Change | Status |
|---|---|---|---|---|
| A1 | Landed on "General worker" in **Executor**: this product's own repository, its Git history in the sidebar. Nothing said what the product is or how Worker, Team and Workspace relate. | No idea what to do or why it's different from a chatbot. | Getting-started guide on the new-task screen while no worker exists: one-line purpose, the three pieces, and "What would you like your AI worker to do?" with examples. | **Fixed** (VERIFIED: create and journey tests) |
| A2 | Only "General". The four real specialist definitions (`workers/*.json`) were reachable only through `doctor --seed-workers`. | The product's main idea, specialists, was invisible. | ~~A catalogue of templates~~ (wrong: §0). **New worker** asks what the worker should do, recognises the tools and systems involved, and composes the worker. | **Fixed** (corrected) |
| A3 | "New worker" was one long form with every capability by tool id (`Bash(node:*)`, `figma-executor`…) and every integration, for every worker. | Overwhelming; a frontend person saw Builder publishing, a Builder person saw shell. | Only the questions of the integrations the request involves (Builder.io: space, models, publishing; a code repository: stack, conventions, editing, scripts, browser). Integrations without a connector (Shopify, Sheets, WordPress…) are answered honestly, with what can be done today. The review shows what it can do in the chosen workspace, its requirements, and what isn't possible. The full definition stays one link away. | **Fixed** (corrected); `worker-platform.md` §13 |
| A4 | Before starting, requirement states were tiny dots with tooltips; nothing said what the worker may change. | Missing access was found out by failing. | "Before you start": where it works in plain words (Inspect / Work / Scratch, and a mismatch like "it needs a project folder" with the fix), each requirement with what to do, and a first task (the request itself, then a safe look around). | **Fixed** |
| A5 | A finished message showed "Worked 12s · 9 actions", the reply, and inline DONE/VERIFICATION tags; a NEEDS was a red line. | "What happened, what failed, what now?" took reading the whole reply and Activity. | Each message that did something ends with a result: outcome, the console's facts (files written, failed tool calls), what the worker reported (labelled as its own words), what it needs, and real next steps. | **Fixed** (VERIFIED: journey) |
| A6 | Changes were in the sidebar's "Changes & versions"; nothing linked a result to them. | Review is where trust is earned. | "Review the changes" on the latest result (Git workspaces, when files were written). Also fixed a race that replaced an opened file's diff with the file list. | **Fixed** |
| A7 | On a phone the composer's worker, workspace and model chips overlapped. | Unusable on mobile. | They wrap. | **Fixed** (seen in a screenshot only) |
| A8 | Ten open sidebar sections for a new person (Files, Favourites, Integrations, Local services…). | Noise before the first task. | Proposal: fold Files, Favourites and Local services until first used. | **Open** |
| A9 | Three names: "AI Workspace" (local header), "AI Worker" (hosted), "AI Workforce" (how the owner describes it). | A product that doesn't name itself consistently looks unfinished. | Needs the owner's decision; the new copy avoids naming the product. | **Open: owner decision** |
| A10 | A fresh local install still selects Executor (this repository) by default. | A customer's first workspace isn't ours. | Proposal: on a fresh data dir, select Scratch and let the guide's step 1 add the project. (Hosted already hides Executor.) | **Open** |
| A11 | New team is the full form (workers, resources, knowledge, rules, requirements, prompts) at once. | Same problem as A3, smaller audience. | Proposal: a short "create" (name, workspace, members), then the rest on the Team page. | **Open** |
| A12 | Activity's "Context & usage" card is large and technical, and stays visible for a new person. | Competes with the steps. | Proposal: fold it until the conversation passes half the warning point. | **Open** |

## 3. The journey we're proving

**Discover → Configure → Connect → Delegate → Observe → Review → continue**, for one person (a frontend developer with a Git project), in the product:

1. **Discover:** the guide: what this is, the three pieces, and "What would you like your AI worker to do?".
2. **Describe and configure:** their own words ("add a loading state to the checkout button in my React app's repository") → Code repository recognised → its questions only (stack recognised as React) → review → Create.
3. **Connect:** the project folder in Work mode; the review and new-task screens say what that allows and what's missing.
4. **Delegate:** their request is the first task, with the worker and workspace named in the composer.
5. **Observe:** Activity: each tool call with success or failure and its time, the worker's notes, needs and failures.
6. **Review:** the result, then "Review the changes" (the diff, which conversation made it, the commit box).
7. **Continue:** reply, a new task, or resolve what it needs.

**Test:** `node bench/hosted/journey-test.mjs`: real gateway, console, Claude Code CLI, tools and Git; scripted model. 7/7 (2026-10-22).

## 4. What other products do (time-boxed, 2026-10-22)

- **Zapier Agents:** start from a template, connect each app it needs (a real connection status), then a Configure screen, then test. We kept the order (requirements with real status before the first task) but not the template start: our journey starts from the person's own description.
- **Qoder Quest:** an optional spec/plan the person reviews before execution; during it, a to-do list and a Changed Files panel. **Not done:** a plan review before execution (§6).
- **Cursor:** agent changes reviewed in a Review panel or as a diff. Its forum shows the trust cost when changes land without review. Ours: commit and push are the person's actions, and the result links to the diff.

Sources: docs.qoder.com/user-guide/quest; help.zapier.com (Zapier Agents templates); forum.cursor.com threads on agent review (March 2026).

## 5. Security checks for this sprint

- **Answers can't widen access** (VERIFIED, `create` suite):
  - capabilities are computed on the server; any sent by the page are ignored;
  - unknown integrations, questions and choices are refused;
  - an Inspect workspace cuts edits and scripts, in the preview and in the run (its runtime snapshot);
  - Builder requirements say "Not connected" without keys and "Production space: writes refused" with production keys;
  - nothing is created from a request with no connector, or while a required follow-up is unanswered.
- **Unchanged:** `workerRuntime`, the profiles, deny rules, adapters and Git guards. The page only renders what the console returns.
- **A created worker runs through the existing runtime** (VERIFIED: a real run, `create` step 10).
- **Not re-run this session:** the adversarial suites (boundaries, teams' escape attempt, Inspect E1). The code paths they cover weren't changed.

## 6. Next, in order

1. **Re-run the remaining real-worker suites** (§1) and one real task on a MATW clone, starting from the guide with the person's own description.
2. **Put it in front of 2–3 prospective users** with the script below. Watch, don't explain; note where they stop.
3. **A10** (Scratch by default on a fresh install), **A8** (fold the sidebar), **A9** (a name).
4. **Real connectors where users ask for them** (Shopify Admin API, Google Sheets), each with its own adapter and tests before the registry marks it connected.
5. **A plan review before execution** (Qoder-style), only if users ask "what will it do?" before trusting it.
6. **A11 / A12.**

## 7. Demo script (10 minutes, a prospective user driving)

1. Open the console. Ask them to read the first screen and say what the product does. Note their words.
2. "Get a worker to add a loading state to a button in your React project." Let them describe it in their own words, answer its questions and create it. Then try their real stack (Shopify, Sheets…) and ask whether the "not possible today" answer is clear.
3. They add their folder (Work). Ask: "What can this worker change? What can't it do?" The answer should be on screen.
4. They pick the example task or type their own, send it, and watch Activity. Ask: "What is it doing right now?"
5. At the result: "What did it do? What did it check? What failed?" Then Review the changes, and ask whether they'd commit it.
6. Ask for a follow-up that needs something it can't do (e.g. check it in a running site). Ask: "What does it need from you?"

**Record:** time to the first result, where they hesitated, and any wrong answer to the questions above. Commercial validation is that evidence, not the build.
