# Git workflow worker (MVP, 2026-10-22)

A worker for synchronising and promoting changes between branches when several teams share them. Two examples, the first configuration (MATW):
- `dev-main → sabir-dev` and `uat-main → sabir-uat` keep BAU's lanes in step;
- `sabir-uat → preprod-main` promotes approved work.

The findings behind it are in the branch-sync assessment (2026-10-22): copies, reverts and cross-team dependencies.

## How it fits the platform
- **Created like any worker.** Describe the work ("keep sabir-dev in sync with dev-main … promote to preprod-main"), and the creation flow recognises **Git branch sync and promotion** (`worker-ui/integrations.mjs`). It asks:
  - your team and the other teams;
  - the branch relationships (prefilled for the sabir-* lanes);
  - whether it may prepare proposal branches.
- **The worker gets one capability, `gitflow.read`.** These are read-only Git tools (`mcp/gitflow-server.mjs`):
  - `gitflow_overview`, `gitflow_commits`, `gitflow_commit`, `gitflow_preview`;
  - `gitflow_save_note`, for its explanations.

  It has no shell, no file editing, and no tool that creates a branch, merges or pushes.
- **Its page** opens from "Open the Git workflow" on the worker's new task:
  1. **Setup:** the repository (a workspace that is a Git checkout), teams with pull-request branch patterns, people and their commit identities, branch relationships and their default strategy, rules, ownership overrides, ticket patterns, shared branches, and whether proposal branches are allowed.
  2. **Commits:** what each destination is missing, filterable by developer and grouped into tasks only on evidence (one pull request, or a ticket reference). Each commit shows:
     - its kind (PR merge, revert, cherry-picked, duplicate);
     - whether the destination already has it, as the same commit or an equivalent copy;
     - ownership with its confidence and evidence;
     - its files, diff and raw `git show` output;
     - the worker's explanation, labelled as its own words.
  3. **Preview & plan:** choose a strategy (with its trade-offs) and generate a plan simulated with Git. It lists:
     - what will apply and what's already there;
     - what's blocked or excluded, and why;
     - predicted conflicts, possible dependencies (earlier changes to the same files, other teams flagged) and hazards;
     - build and tests ("not run": none is configured);
     - an approval button.
  4. **History:** the audit trail: configuration changes, previews, refusals, executions and the worker's notes.

## What decides what (deterministic vs AI)
- **Git** (`worker-ui/gitflow.mjs`), never the model: the commits, ancestry, patch equivalence (`git patch-id --stable`), PR association (from merge commits), revert detection, merge and cherry-pick simulation (`git merge-tree --write-tree`, with `--merge-base` for a cherry-pick), conflicts, and the plan.
- **Ownership** comes from configured evidence:
  - an override = confirmed;
  - a PR branch pattern plus an author email = confirmed;
  - one of them = likely;
  - an author name only, or disagreeing evidence = uncertain;
  - nothing = unknown.

  A Git author alone is never "confirmed".
- **The worker (AI)** explains what changes do, suggests related commits (shown as a suggestion, not evidence), and explains plans and risks. Ask it from the Commits page ("Ask the worker to explain").

## Strategies
| Strategy | What it does | When it's right | What blocks it |
|---|---|---|---|
| Apply selected changes | applies chosen commits one by one onto the destination, as copies that record the original (`cherry picked from`) | the destination must stay independent of the source | merges, other teams' or uncertain changes (by rules), changes reverted later (by rules), predicted conflicts, other teams' possible dependencies |
| Merge, keeping history | merges the source into the destination | everything the source carries is eligible | any other-team or uncertain commit it would carry |
| Promote feature branches | merges the PRs' reviewed feature branches into the destination | branches cut from the destination (or older) | a feature branch carrying other teams' work (e.g. cut from `dev-main`), conflicts |

Rules can relax "other teams", "uncertain owner", "unknown owner" and "reverted" from *blocks* to *needs your confirmation*. Merge commits and predicted conflicts always block.

### Ownership rules (2026-10-24)
- **Three separate rules:**
  - **Unknown owner:** no rule matches the author, e.g. a bot or someone not in People.
  - **Uncertain owner:** a name only, or evidence that disagrees.
  - **Other teams' changes:** confirmed or likely evidence for another team.
- **Unknown has its own setting, on by default.** A configuration saved before it existed keeps blocking unknown owners, whatever its "uncertain" says. Relaxing "uncertain" never lets an unknown author through.
- **Blocks name the rule** that made them.

### Another team's change to the same file (D1, 2026-10-24)
A selected change may touch a file that an earlier, unselected change from another team also changed.
- **It needs your explicit confirmation,** not a block, only when all of these hold:
  - Git applies the selected change cleanly without it;
  - nothing else blocks the selected change;
  - the other change is confirmed or likely another team's.

  The other change is never included.
- **Everything else still blocks:**
  - a predicted conflict;
  - an other change whose owner is unknown or uncertain (fix its attribution first);
  - selecting the other team's change itself;
  - merges, reverted changes and the ownership rules.
- **What you confirm is a list of points, each with an id.** Creating the branch needs exactly that plan's list. A missing, partial, extra or other plan's confirmation is refused and audited. The execution's audit entry records the confirmed points and the approver.

### Confirmations, plans and settings
- **What a plan id covers:** the relationship, strategy, selection, both tips, every change's outcome, the points to confirm, and a fingerprint of the settings that decide ownership and rules.
- **A settings change invalidates plans:** after one, an older plan is refused as stale.
- **Each settings save is audited:** what changed (`from → to`, the rules included) and who changed it.
- **Who is recorded:** this clone's Git identity locally (`Name <email>`), the signed-in person when hosted.

## Branch rules (2026-10-23)
- **Off-limits** (default `prod-main`): never read and never written.
  - It's excluded from every fetch into the private copy, and removed if it was copied earlier.
  - It's never listed, suggested or used for authors.
  - It's refused as a source or destination, and the worker's tools refuse it too.
- **Shared** (default `dev-main`, `uat-main`, `preprod-main`): never pushed or written. A change reaches a shared branch only through a pull request:
  1. An approved plan becomes a new `gitflow/…` branch.
  2. With a second approval, only that new branch is pushed.
  3. A pull request into the destination is opened: through the API when GitHub is connected, otherwise as GitHub's link to open it.

  It's merged on GitHub, where its own branch protection and reviews apply.
- **Lanes** such as `sabir-dev` get the same treatment: everything goes through a pull request, never a direct push.
- A configuration saved earlier (with `prod-main`, `main` and `master` in "shared") is read under these rules automatically.

## Safety
- **Analysis and simulations run in a private bare copy** (`<data>/gitflow/<worker>/scratch`). It borrows the repository's objects and copies its branch refs, so the repository is only read.
- **Execution** needs proposal branches allowed in Setup and your approval.
  - The plan is recomputed first, and refused if the branches moved (a stale plan), if it's blocked, or if a review wasn't confirmed.
  - The result becomes a **new** branch, `gitflow/<destination>-<time>`, in the repository.
  - Before and after, it checks that no existing branch or remote-tracking ref changed.
  - It never pushes, never rewrites history, and never writes a shared branch.
- **Every** preview, refusal, execution, push, settings change, fetch and note is in `<data>/gitflow/<worker>/audit.jsonl`. Plans are stored by their id in `plans/`.
- **One writer at a time.** Updating the private copy, fetching, creating the branch and pushing it run one at a time per worker:
  - in the console, requests queue;
  - across processes (the console and the worker's own tools), a lock file `<data>/gitflow/<worker>/repo.lock` is held;
  - a lock left by a process that died, or one older than 15 minutes, is taken over.
- **The pull request's description** names who approved the branch and who approved the push. It lists what was applied, what was confirmed, and what isn't in the pull request and why. Calling it again after GitHub refused the pull request pushes nothing new and tries again.

## Try it
1. `node worker-ui/server.mjs` (restart it if it was running), then open http://localhost:8799.
2. Add a workspace for a **separate clone** of the repository (Inspect is enough). For MATW, `git clone` your checkout somewhere, then `git fetch` in it.
3. **New worker** → "Keep sabir-dev in sync with dev-main and sabir-uat with uat-main, and promote our UAT changes to preprod-main".
   - Answer *Your team* (BAU) and *Other teams* (Innovax).
   - Choose the clone as where it works.
   - Create.
4. On its new task, choose **Open the Git workflow** → **Setup**:
   - add people (name, team, commit emails);
   - add your PR branch patterns (e.g. `bau/*`, `sabir-*`);
   - save.
5. **Commits:**
   - choose a relationship and a developer;
   - open commits;
   - select a task or changes;
   - **Preview a plan**.
6. To try execution, use the fixture repository rather than MATW. In Setup, allow proposal branches, then approve a Ready plan. The new branch is in the clone; nothing is pushed.

**Tests:** `bash bench/workspace-ui/run-suite.sh gitflow`:
- a disposable fixture (`bench/gitflow/fixture.mjs`);
- one real worker run;
- a read-only pass over the real MATW repository that checks no ref there moves.

## What the page does (2026-10-24)
- **Creating a branch runs as a job.** The page shows its four steps as they happen (recompute, check, create, verify), and Cancel works until the branch is being created.
- **Export patch** downloads a ready plan as one patch per change (), or one diff for a merge. Nothing is written.
- **When GitHub refuses a pull request**, the branch stays pushed and *Try opening it again* retries without pushing anything new.
- **The Git graph & identity tab** shows the source's pending changes with their outcome, the destination's own commits, the merge base, and who wrote what.

## The page, as designed (2026-10-25)
The page follows Figma "Git Sync v2 · Screens" (file `duF0rXIX8dmXRFILdgvZA0`).
- **Included is a diff studio.** It lists each change and opens the first one by itself:
  - its files;
  - each diff with old and new line numbers, as Unified or Split;
  - the raw `git show`.

  The Changes inspector uses the same studio.
- **Excluded filters by reason, with counts.** "Why?" opens the change's evidence, and unknown or uncertain owners get "Assign team".
- **Dependencies & conflicts:** each card opens the diffs it is about, read-only.
- **Git graph & identity is drawn:**
  - the source lane, with each change coloured by its outcome;
  - the destination's own commits from the merge base;
  - for a plan that can be used, the proposal branch it would create;
  - a "Plan only / All commits" switch, and a legend.

  The lists are kept below the drawing.
- **Settings rules** are each *Block* or *Needs confirmation*. The rule for another team's change to the same file, and the rule for merges and conflicts, are fixed, and the page says so. There is still no override that lets another team's change in (D2).
- **Creating a branch** shows its steps with times, beside a card that explains Cancel. The confirmation dialog has a **Fetch now**: it fetches, then asks again only if the plan still holds.
- **The result** lists the new commits, each with the original it copies. A pull request shows beside its checks.
- **The page takes the console's right column.** Activity becomes a drawer while the page is open.

## Opening a worker in its own tab
- Every worker in the sidebar has an **open in a new tab** button, and so does the Git workflow's bar.
- The tab opens on that worker (and on its Git workflow, from the bar) at full width. Navigation and Activity become drawers there, and **Exit full view** brings the sidebars back.
- The address is `/?worker=<id>&view=gitflow&ws=<workspace>&full=1`.
- Opening a tab doesn't change the worker or workspace that the console's other tabs remember.

## A read-only or test console
These settings are environment variables of `node worker-ui/server.mjs`:
- **`GITFLOW_READ_ONLY=1`:**
  - every route that could write to a repository or a remote is refused with 403: creating a branch (directly or as a job), job controls, pushing or opening a pull request, deleting a branch, and fetching;
  - reading, analysing, previewing, exporting a patch and saving settings still work;
  - the page shows **Read-only console** on every screen and turns the write buttons off, with the reason.
- **`GITFLOW_ENV_LABEL="…"`:** names a test environment on every screen, for example a disposable fixture repository.
- **Tests:**
  - `node bench/workspace-ui/gitflow-safety-test.mjs` starts its own two consoles (a read-only one and a normal one) on fixtures;
  - the page journey is in `run-suite.sh gitflow`.

## Limits of this MVP
- **Pull requests** come from merge-commit messages and squash subjects. GitHub's API (PR authors, labels, team membership) isn't used yet.
- **Dependencies** are file-overlap heuristics: a hint, not proof. A change can depend on another without touching the same file, and that isn't detected. Conflicts are Git's prediction.
- **No build or test command** is run; plans say so.
- **Runs are on demand only:** no schedule or webhooks.
- **Resolving conflicts** is out of scope: a conflict blocks the plan. The page shows the conflicting part of each file (up to 3 files) as Git would leave it; you can leave the change out, or wait.
- **CI results** are read from GitHub (check runs and commit statuses) only when GitHub is connected and origin is on GitHub; otherwise they're on the pull request.
- **Cancelling** works until the branch is being created. Pushing isn't cancelled once started, because it changes origin.
- **Deleting a proposal branch** removes it from the clone only: a pushed copy stays on origin, for you to delete on GitHub. It's refused if the branch moved or is checked out.
- **Not built (decision D2):** including another team's change in your lane, even with a recorded override.
