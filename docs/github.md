# GitHub: one connection, registered repositories, per-worker access (2026-10-17)

> Project overview: `docs/PROJECT_HANDOFF.md`. This note covers how the console manages GitHub repositories centrally and how a worker gets, and is limited to, a repository.

## 1. How it fits together
The chain is: **GitHub connection → repository registry → workspace assignment → worker access → the run**.

- **Connection** (`worker-ui/github.mjs`)
  - One token for the whole platform, used by the console only: to verify the connection, discover the repositories the token can see, and read their metadata.
  - It's stored outside the repo and outside every workspace, in `~/.github-connector/credentials.json` (`GITHUB_CONNECTOR_DIR` overrides the folder).
  - It never goes to the page, a worker, a log, an error or `github.json`.
  - Git itself (clone, push) keeps using the person's own Git sign-in (Git Credential Manager or SSH), exactly as the Versions view always has. The token isn't given to Git.
- **Registry** (`<data>/github.json`, gitignored)
  - Each registered repository has:
    - an id: `gh-<GitHub's numeric id>`, so a rename on GitHub keeps the id;
    - owner/name, the clone URL and the web URL;
    - the default branch, whether it's private or archived;
    - the token's own access to it;
    - its status (`ok`, `inaccessible` or `error`) and when it was last checked.
  - The file also records the connection's login, token kind and, for classic tokens, its scopes.
- **Assignment** (a workspace's record in `workspaces.json`)
  - At most one repository per workspace, because a workspace is one folder: the repository's checkout.
  - Assigning is refused unless the folder is a Git checkout whose `origin` is the registered repository (compared with credentials stripped, SSH and HTTPS treated as equal, and case-insensitive).
  - The assignment also sets:
    - the General worker's access;
    - whether shell commands stay on;
    - whether workers may commit to the default branch.
- **Worker access** (a worker definition's `repos: [{ repo, level }]`): none unless granted, per repository.

## 2. What each access level gives a worker
The levels are cumulative.

| Level | The worker gets |
|---|---|
| Read | `repo_status`, `repo_log`, `repo_diff`. **File edits are off.** |
| Write | Also edits files (the runtime's Write and Edit tools, if the worker has the files.write capability). |
| Commit | Also `repo_create_branch` and `repo_commit`. |
| Push | Also `repo_push`. |

**How a worker's effective level is set:**
- It starts from what the worker's definition grants for this repository. The General worker gets the assignment's level instead (default: Write, which keeps the earlier workflow where the person commits and pushes in the Versions view).
- An Inspect workspace caps it at Read.
- A resumed run never gets more than the level it started with.
- An edit to the worker applies at its next start, including a resume.

**What's enforced in an assigned workspace** (by the console and the runtime, not by instructions):
- **A worker with no access can't start a run there.** It reads its workspace's files, so there's nothing to hide behind.
- **Git only goes through the `repo_*` tools.** These come from `mcp/repo-server.mjs`, which registers only the tools of the run's level, so a read-only worker has no commit tool to call. Every call:
  - works on the run's checkout only (no tool takes a repository or folder);
  - first checks that `origin` is still the registered repository, and refuses if not;
  - passes arguments to git as an array (no shell);
  - validates paths and branch names.
- **No destructive operations:** nothing forces, resets, rebases, deletes branches or discards changes. A rejected push says so and isn't forced.
- **Protected branches:** workers don't commit or push to the default branch (unless the assignment allows it) or to a Team-protected branch. They create a work branch instead.
- **Verified results:** a push reads the remote branch back and reports whether it matches. A commit returns the real hash, which is linked to the run.
- **Lock-down:**
  - shell commands are off, because `node` can run git behind the console (unless the assignment turns them on: then Git limits don't cover what the worker does through node, and the UI says so);
  - `.git` and `.claude` can't be written;
  - project settings and hooks are ignored (`--restricted`).
- **Start-time checks:** a run doesn't start when the folder's origin no longer matches, and neither does the person's Push.

## 3. Using it (the GitHub page, sidebar → GitHub)
1. **Connect.** Paste a token. Least privilege is a fine-grained personal access token limited to the chosen repositories, with **Metadata: read**. Only a token that works is saved. Verify and Disconnect (with confirmation) are on the same page.
2. **Register.** Use "Find my repositories" (everything the token can see) or type owner/name. Duplicates are refused.
3. **Assign.** Open a repository and assign it to a workspace whose folder is its checkout, or "Clone as workspace" into a folder (Git sign-in, Work mode).
4. **Give workers access.** In a worker's definition, under Repositories, pick a level per repository.

**Removing a registration:**
- It's refused while the repository is assigned to a workspace.
- Afterwards only the entry and the workers' grants to it go. Folders, changes, commits and runs are untouched.

**Unassigning** returns the workspace to an ordinary one, which is an explicit action by the person.

**API (same-origin only, like every other console route):**
- `GET /github`
- `POST/DELETE /github/connection`, `POST /github/connection/verify`
- `GET /github/discover`
- `POST /github/repos`, `POST /github/repos/:id/refresh`, `POST /github/repos/:id/clone`, `DELETE /github/repos/:id`
- `PUT/DELETE /workspaces/:id/repo`

**Errors:**
- a rejected token is reported as 401, a rate limit as 429 (with the reset time), and a repository the token can't see as 404;
- other GitHub failures are reported as 502;
- none of them includes the token.

## 4. Limits (known)
- **One repository per workspace.** This follows the one-folder workspace model.
- **No isolated worktrees.** Only one worker runs at a time, so runs don't overwrite each other, and the person's uncommitted changes stay in the checkout. A worker's `repo_create_branch` takes them along.
- **The token isn't used by Git.** Push access is whatever the person's own Git sign-in has. The registry's "this token" access is only what the token can do.
- **A worker with shell (`node`, `curl`) in *any* workspace can reach the console's local API**, which only checks headers a local program can forge. Keep shell off for workers you don't trust. This applies to every console route, not only these. The browser tool and WebFetch can't reach it (`docs/second-developer.md`).
- **No pull requests, pull, merge or branch switching from the UI.** Workers switch branches only by creating one.
- **On Windows the credentials file is protected only by the user profile's permissions.**
- **Access changes apply at the worker's next start.** A worker process already running keeps the tools it started with.

## 5. Tests
- **`node bench/github/repo-tools-test.mjs`: 7/7.** The repo tools for real, on a local checkout with a bare "GitHub" remote. Covers:
  - the tools each level has;
  - commit refused on the default branch, and a real commit on a work branch;
  - a push read back from the remote, and a rejected push not forced;
  - the default branch allowed only when configured, and Team-protected branches;
  - a mismatched origin refused;
  - forged paths and branch names refused.
- **`bash bench/workspace-ui/run-suite.sh github`: 17/17.** The console, the page, a mock GitHub API (`bench/github/mock-github.mjs`, no real credentials) and local repositories. Covers:
  - connect, with the error cases;
  - the token never leaving;
  - discovery limited to what the identity can see, with its loading state;
  - registering, duplicates and invisible repositories;
  - refresh and revocation;
  - rate limits;
  - assignment, including a mismatched origin and forged ids;
  - a worker with no access refused;
  - Read and Commit levels, checked against the tools the runtime actually reports (two short Haiku runs);
  - the worker's commit linked to its run;
  - an access change applying at the next start;
  - a mismatched origin refused for runs and for the person's push;
  - the existing Versions features;
  - removal leaving files untouched;
  - the page's empty, error, detail and disconnect states.
- **Regression after this change:** versions 14/14, workers 12/12, teams 19/19.
