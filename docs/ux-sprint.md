# UX and product validation sprint (from 2026-10-22)

The product-experience record for the 8-day sprint: the audit, the journey we're proving, what changed, the evidence, and what's still open. Platform design stays in `worker-platform.md` (templates: §13) and `team-platform.md`. The earlier 29-finding remediation is `ux-remediation.md`.

**Markers:** VERIFIED (by code or a test run), INFERRED, UNKNOWN.

## 1. Baseline (2026-10-22)

- **Code:** branch `main`, HEAD `0433144` plus uncommitted Figma Executor work. That work was verified and committed first as `324ebd7` (lifecycle 17/17 twice, console wiring 2/2, local boundaries 8/8, devctl 16/16).
- **Blocker (VERIFIED):** the local Claude Code sign-in has expired ("OAuth session expired and could not be refreshed"). No real worker can run locally, so the suites that start one fail at the first message: workers, remediation, manage step 6, versions steps 2–5 and 14, boundaries, teams, attach, mentions, workflow, context, model. **They need re-running after the owner signs in again** (`claude` → `/login`).
- **What still runs:** the hosted path drives the real Claude Code CLI and real tools with a scripted fake model (`bench/hosted/fake-anthropic.mjs`). The journey test below uses it. It proves the product's side of each step, not what a real model does.

## 2. Audit: what a first-time person met (screenshots in the session; after-shots in `bench/hosted/shots/journey-*.png`)

| # | What they saw | Why it hurt | Change | Status |
|---|---|---|---|---|
| A1 | Landed on "General worker" in **Executor**: this product's own repository, its Git history in the sidebar. Nothing said what the product is or how Worker, Team and Workspace relate. | No idea what to do or why it's different from a chatbot. | Getting-started guide on the new-task screen while no specialist exists: one-line purpose, the three pieces, three steps with real progress, the specialists. | **Fixed** (VERIFIED: templates and journey tests) |
| A2 | Only "General". The four real specialist definitions (`workers/*.json`) were reachable only through `doctor --seed-workers`. | The product's main idea, specialists, was invisible. | **New worker** opens a catalogue of templates, each showing what it uses and whether its requirements are met on this computer. | **Fixed** |
| A3 | "New worker" was one long form with every capability by tool id (`Bash(node:*)`, `figma-executor`…) and every integration, for every worker. | Overwhelming; a frontend person saw Builder publishing, a Builder person saw shell. | A short setup per template: only that worker's settings (a Builder editor: Publishing; a frontend engineer: Run scripts). The console's preview shows what it can do in the selected workspace and its requirements. The full definition stays one click away. | **Fixed**; design in `worker-platform.md` §13 |
| A4 | Before starting, requirement states were tiny dots with tooltips; nothing said what the worker may change. | Missing access was found out by failing. | "Before you start": where it works in plain words (Inspect / Work / Scratch, and a mismatch like "it needs a project folder" with the fix), each requirement with what to do, and the worker's example tasks. | **Fixed** |
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

1. **Discover:** the guide: what this is, the three pieces, the specialists with their real readiness.
2. **Configure:** New worker → Frontend Engineer → two settings (Run scripts, check in a browser) → Add worker.
3. **Connect:** the project folder in Work mode; the setup and new-task screens say what that allows and what's missing.
4. **Delegate:** an example task, or their own, with the worker and workspace named in the composer.
5. **Observe:** Activity: each tool call with success or failure and its time, the worker's notes, needs and failures.
6. **Review:** the result, then "Review the changes" (the diff, which conversation made it, the commit box).
7. **Continue:** reply, a new task, or resolve what it needs.

**Test:** `node bench/hosted/journey-test.mjs`: real gateway, console, Claude Code CLI, tools and Git; scripted model. 7/7 (2026-10-22).

## 4. What other products do (time-boxed, 2026-10-22)

- **Zapier Agents:** start from a template, connect each app it needs (a real connection status), then a Configure screen, then test. We copied the order, not the look: template → setup → requirements with real status → task.
- **Qoder Quest:** an optional spec/plan the person reviews before execution; during it, a to-do list and a Changed Files panel. **Not done:** a plan review before execution (§6).
- **Cursor:** agent changes reviewed in a Review panel or as a diff. Its forum shows the trust cost when changes land without review. Ours: commit and push are the person's actions, and the result links to the diff.

Sources: docs.qoder.com/user-guide/quest; help.zapier.com (Zapier Agents templates); forum.cursor.com threads on agent review (March 2026).

## 5. Security checks for this sprint

- **Template choices can't widen access** (VERIFIED, `templates` suite):
  - unknown settings and choices are refused, and smuggled capabilities are ignored;
  - "May publish" in Inspect is blocked by the console;
  - the requirement stays "Not connected" without keys and "Production space: writes refused" with production keys;
  - the run's Builder adapter profile is read (Inspect), draft or full, decided by the console;
  - Figma "Only look" gets the read-only Executor.
- **Unchanged:** `workerRuntime`, the profiles, deny rules, adapters and Git guards. The page only renders what the console returns.
- **Not re-verified this session** (needs a real worker): the adversarial suites that drive a real worker (boundaries, teams' escape attempt, Inspect E1). The code paths they cover weren't changed.

## 6. Next, in order

1. **Sign in to Claude Code again**, then re-run the real-worker suites (§1) and one real task on a MATW clone with the Frontend Engineer, from the guide.
2. **Put it in front of 2–3 prospective users** with the script below. Watch, don't explain; note where they stop.
3. **A10** (Scratch by default on a fresh install), **A8** (fold the sidebar), **A9** (a name).
4. **A plan review before execution** (Qoder-style), only if users ask "what will it do?" before trusting it.
5. **A11 / A12.**

## 7. Demo script (10 minutes, a prospective user driving)

1. Open the console. Ask them to read the first screen and say what the product does. Note their words.
2. "You have a React project. Get a specialist to add a loading state to a button." Let them find New worker → Frontend Engineer → Add worker.
3. They add their folder (Work). Ask: "What can this worker change? What can't it do?" The answer should be on screen.
4. They pick the example task or type their own, send it, and watch Activity. Ask: "What is it doing right now?"
5. At the result: "What did it do? What did it check? What failed?" Then Review the changes, and ask whether they'd commit it.
6. Ask for a follow-up that needs something it can't do (e.g. check it in a running site). Ask: "What does it need from you?"

**Record:** time to the first result, where they hesitated, and any wrong answer to the questions above. Commercial validation is that evidence, not the build.
