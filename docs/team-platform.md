# Teams (2026-10-06)

> Project overview and current status: `docs/PROJECT_HANDOFF.md` (canonical). This file is the Team design.

A Team is shared context and scope for several workers: who's in it, what they share, and what is enforced for them. It's built on the existing worker platform (`docs/worker-platform.md`), and it adds nothing to the runtime itself:
- no second runtime;
- no second file system;
- no credential store.

## 1. Where Team fits

```
Platform / security       worker-instructions.md, profile flags, request guard
      ↓
Workspace                 folder + profile (Inspect | Work); enforced policies that hold there
      ↓
Team context              identity, members, instructions, knowledge, resources, requirements
      ↓
Worker context            identity, mission, workflow, capabilities, limits, memory
      ↓
Person's message          (with @ mentions and attachments, as before)
```

A Team run is a normal worker run, started by `newRun()` with a `teamId`. The same `spawnWorker()` starts the same `claude.exe`. The Team changes three things:
- **The workspace:** the Team's workspace is forced. A run that asks for another one is refused.
- **The context file:** `runs/<id>.worker.md` gets a Workspace section and a Team section, before the worker's own definition.
- **The tools and their scope:** see §4.

**Effective access = worker capabilities ∩ workspace profile ∩ Team scope ∩ platform.** A Team can only take things away.

## 2. Data model

`teams.json` lives in the console's data dir and is gitignored. It holds definitions only, never credentials.

```js
{ id, name, description,
  workers: [workerId],                       // membership; each worker keeps its own definition and memory
  workspace: workspaceId | null,             // the Team's workspace (null = "No folder")
  figma: { url, fileKey, branchKey?, name } | null,
  knowledge: [
    { id, type: "workspace_file", workspaceId, path, note },          // a reference: read fresh by the worker
    { id, type: "upload", name, kind, size, sha, file, note } ],       // stored with the Team
  policies: [{ type: "protect_branch", branch }],                     // ENFORCED: only types the platform enforces
  instructions: [text],                                               // INSTRUCTION: given, not enforced
  requirements: [{ resource, access, need }],                         // the worker requirement model
  prompts: [{ id, title, text }],                                     // Team prompts (Favourites stay global)
  version, createdAt, updatedAt }
```

Each Team also has files under `teams/<id>/`:
- `knowledge/<sha16>-<name>`: uploaded documents, stored by content.
- `history/v<N>.json`: every saved version.

**Validation on save:**
- Workers must exist.
- The workspace must resolve.
- The Figma link must be a figma.com file URL.
- Workspace-file knowledge must be in the Team's own workspace. It goes through the same checks as @ mentions: no absolute, drive, UNC or `..` paths, no link out, no folder, and the file must exist.
- Uploads go through the attachment checks: the type is read from the bytes, sizes are capped per type, and there are at most 20.
- A policy type the platform can't enforce is refused, with "add it as an instruction instead".

## 3. Runtime composition

At run start (`newRun`), the console:
- checks requirements: the worker's own, plus the Team's (marked "Team"). A missing one doesn't block the run. The worker is told and stops with `NEEDS:`, as for workers.
- copies the Team's uploads to `runs/<id>.team/`. The worker can read them there (`--add-dir`) but not write them (a deny rule).
- writes the context: platform instructions, `## Workspace` (enforced policies), `# Team: <name> (version N)` (instructions, knowledge references, resources), then `# You are: <worker>`.
- snapshots the run in `runs/<id>.worker.json`: the worker definition, the whole Team definition at that version, the scope and the requirement statuses. `meta.team = { id, name, version }`.
- emits `team`, `worker`, `requirements` and `policy` events, which show as Activity cards.

**Versions:** saving a Team bumps its version. New runs use the latest version. A run that's continued later, even after a resume, keeps its own context file and snapshot.

**Knowledge freshness:** workspace-file knowledge is a reference, so a continued run reads the file's current content. The reference itself is from its version.

**Enforcement is worked out again at every start or resume** (`runScope`): the workspace's policies now, plus the ones the run started under. A resume never runs with less enforcement than the workspace has now.

## 4. What is enforced, and how

### Never modify a branch (`protect_branch`)

**Scope:** it holds in every workspace inside the Team's Git repository, not only in the Team's own workspace.

| Layer | What happens | Below the model? |
|---|---|---|
| Console Git | `POST /git/commit` refuses while the branch is checked out. `POST /git/push` refuses when the branch or its upstream target is protected. The Versions view says why. | yes (server) |
| Worker tools | No shell. `node` or `curl` could run `git`, or write `.git` directly. | yes: the `--tools` list. It's also checked against what the worker reports at init, and the run is stopped if it differs. |
| Worker files | Deny rules on `.git/**` and `.claude/**`. | yes: runtime permission deny ("denied by your permission settings") |
| Repo settings | `--restricted`, so the repo's `.claude` settings and hooks don't run. Tested: a SessionStart hook ran without it and didn't with it. | yes |
| Protected branch checked out | No Write or Edit either, so the run can't change files on that branch. | yes: the `--tools` list |

### Figma resource lock

**Figma Executor:**
- In a Team's run with a Figma resource, `mcp/server.mjs` gets `FIGMA_EXPECTED_FILE_KEY`.
- Every command except PING and GET_FILE_INFO first asks the plugin which file is open. The plugin reports `figma.fileKey`, which was tested on this setup.
- The command is refused if the open file isn't the Team's file.

**Figma Reader:** gets `FIGMA_READER_ALLOWED_KEYS` and refuses links to other files before anything else.

**Neither grants access.** Without a Figma authorization, the Reader still says it's missing, and the worker writes `NEEDS:`.

### Not enforced, and labelled INSTRUCTION in the UI

Conventions like "Follow DDFOA" or "Use the BFF pattern" are given to every Team worker as instructions. The platform can't verify code style, so it doesn't claim to.

## 5. UI

- **Sidebar:** a **Teams** section. Selecting a Team opens its page and makes it the context for new chats. The composer shows "Team · worker" with a way to leave the Team. Choosing General, a non-member worker or another workspace also leaves it.
- **Team page:**
  - a summary of the saved state;
  - the whole definition, editable: workers (with Chat), resources, knowledge (WORKSPACE FILE vs UPLOADED), rules (ENFORCED vs INSTRUCTION), requirements with live status, Team prompts (Use), and versions with the runs that used each one.
- **Sidebar "<Team> prompts":** shows the Team's prompts only while that Team is active. Favourites stay global.
- **Versions view:** shows the protection instead of a commit box on a protected branch.

## 6. Limits that remain

- **Shell commands in other workspaces.** A worker with the shell capability in a Work workspace outside the Team's repository runs `node` with your user rights. It could run `git` in any repository on this computer. A branch policy covers:
  - runs in the Team's repository;
  - the console's own Git actions.

  It can't cover another workspace's shell. That would need OS-level isolation for commands (a separate user or a sandbox). The real backstop for pushes is the remote's own branch protection (for example, GitHub's).
- **Branch switched outside the console mid-run.** "Protected branch checked out" is checked when a run starts or resumes. If the person switches to the protected branch outside the console in the middle of a run, that run keeps Write and Edit until it restarts. Commits are still refused.
- **No shell under a branch policy.** In a protected repository, workers can't run commands such as tests or builds. Running them safely needs a command runner that can't reach Git. That isn't built.
- **Credentials.** They're per integration on this computer, not per Team. Requirements check them; they don't grant them.
- **Pasted text.** Team knowledge from uploaded documents is read on demand. Large text pasted as an instruction goes into every run's context.
