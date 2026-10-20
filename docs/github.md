# GitHub: one connection, registered repositories, per-worker access (2026-10-17)

> Project overview: `docs/PROJECT_HANDOFF.md`. This note covers how the console manages GitHub repositories centrally and how a worker gets, and is limited to, a repository.

## 1. How it fits together
The chain is: **GitHub connection → repository registry → workspace assignment → worker access → the run**.

- **Connection** (`worker-ui/github.mjs`, `worker-ui/github-app.mjs`)
  - One connection for the whole platform, made one of two ways (§1a): **Connect with GitHub** (the console's GitHub App) or **a pasted token**.
  - It's used by the console only: to verify the connection, discover the repositories it can see, and read their metadata.
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

## 1a. Connect with GitHub (2026-10-20)

### Which mechanism, and why
| | GitHub App (chosen) | OAuth App | Fine-grained token (kept) |
|---|---|---|---|
| Who chooses the repositories | the person, on GitHub's install page ("Only select repositories") | nobody: scopes are account-wide | the person, when creating the token |
| Narrowest permission for this job | **Metadata: read** (no code, no push) | `repo` (full read/write to every private repository): far too broad | Metadata: read |
| Pasting a secret | no: sign-in on github.com | no | yes |
| Expiry and revocation | user token expires (8 h), refreshed; revoked on Disconnect | long-lived | as set by the person |

**Decision: a GitHub App, with the person authorizing it in their browser.**
- The OAuth App would need `repo`, which is wrong for a console that only lists and checks repositories.
- The pasted fine-grained token stays as the alternative: it needs no app registration.

### The flow (GitHub's web flow for GitHub Apps, with a loopback redirect)
1. **Start.** On the GitHub page, Connect with GitHub calls `POST /github/app/start` (same-origin only, like every change).
2. **Prepare.** The console makes:
   - a one-time **state** (256 random bits; ten minutes; in memory);
   - a **PKCE** verifier.

   It returns GitHub's authorize URL, which carries the client id, the redirect `http://<this console's host:port>/github/callback`, the state and the S256 challenge.
3. **Authorize.** The tab goes to github.com. The person signs in there (the console never sees a password) and authorizes the app.
4. **Callback.** GitHub sends the browser to `/github/callback?code&state`. The console:
   - checks the state: known, unused (one-time even on failure), unexpired, and started by this same console address;
   - exchanges the code server-to-server, with the client secret and the PKCE verifier in the request body, never a URL;
   - checks the token with `GET /user` and stores it.

   Then it redirects to `/?github=<outcome>`, never echoing the code or GitHub's raw error. The page shows the outcome once and removes it from the address.
5. **Discovery.** Discovery uses `/user/installations` and their repositories: exactly what the person chose for the app, intersected with what they can see.
   - Registering one still gives no worker any access (§2).
   - "Choose repositories on GitHub" opens the app's installation page to change the selection.

### Where things are kept
- **The user token and refresh token:** `~/.github-connector/credentials.json` (mode 600, outside the repo and every workspace), the same file as a pasted token, with `method: "app"`.
  - An expiring token is refreshed before use.
  - A refused refresh says "Connect with GitHub again".
  - Disconnect deletes it and revokes it at GitHub.
- **The app's client id, secret and slug:** `~/.github-connector/app.json`, or `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` / `GITHUB_APP_SLUG`.
  - They're read by the console only; the page sees whether it's set up and the app's public install link.
  - On Windows these files are protected by the user profile's permissions only. This matches the existing token's storage, and isn't an OS credential vault.
- **What's never stored or logged:** the code and the state. A rejected request is logged without its query string.

### Git and workers are unchanged
- Clone, commit and push still use the person's own Git sign-in. The app's token isn't given to Git and has no Contents permission.
- Worker access is still per registered repository, per worker.

### What you set up once (not done for you)
1. **Register a GitHub App** (github.com → Settings → Developer settings → GitHub Apps → New; for an organisation, in the organisation's settings):
   - **Callback URLs:** `http://127.0.0.1/github/callback` and `http://localhost/github/callback`. Both, because the console uses whichever address you opened it on. GitHub lets a loopback callback use any port, so 8799 and a second developer's port both work.
   - **Expire user authorization tokens:** on.
   - **Request user authorization (OAuth) during installation:** off. With it on, GitHub returns from the install page with a code but without this console's state, and the console (rightly) refuses it.
   - **Setup URL (optional):** `http://127.0.0.1:8799/github/callback`, with "Redirect on update" on. You come back from GitHub's repository selection to "GitHub updated the app's repositories". This is one fixed port; other developers simply return to their console themselves.
   - **Webhook:** off (Active unchecked).
   - **Repository permissions:** Metadata: Read-only, and nothing else.
   - **Where can it be installed:** "Only on this account" (your organisation's account).
2. **Generate a client secret** on the app's page.
3. **On each developer's computer**, create `~/.github-connector/app.json`:
   `{ "clientId": "Iv1.…", "clientSecret": "…", "slug": "<the app's URL name>" }`
   Keep it out of the repo; it's a secret.
4. **Install the app** on the account or organisation and choose the repositories (or use "Choose repositories on GitHub" after connecting).
5. **Restart the console**, then GitHub page → Connect with GitHub.

### Multiple developers
- One app per organisation is enough. Each developer:
  - puts its client id and secret in their own `app.json`;
  - signs in as themselves;
  - sees only the repositories the installation includes that they can access.
- Each console's callback is its own loopback address, so nothing is exposed to the network and no public callback service is needed.
- The client secret is shared across the team's machines. That's acceptable here because it can't access anything without a person authorizing, but rotate it if a machine is lost.

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
- `bash bench/workspace-ui/run-suite.sh github-app` (13 checks, mock github.com and API, real browser):
  - not set up;
  - connect and come back;
  - no secret in the page, API answers, log or any URL;
  - discovery only of the installation's repositories, with no worker access from registering;
  - forged, replayed, expired and cross-console states refused;
  - a cancelled sign-in and a bad code;
  - an installation change;
  - refresh, and a refused refresh;
  - disconnect revokes;
  - the token way beside it.
- The mock enforces GitHub's documented rules. It proves the console's side, not GitHub's: the real flow needs the app from §1a, and **has not been run against github.com**.
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
