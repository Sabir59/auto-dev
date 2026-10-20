# Cloud deployment (hosted pilot)

How to run AI Worker as a website for a few trusted people. The design is in `docs/HOSTED_ARCHITECTURE.md`. **Nothing has been deployed yet** (2026-10-21): the image is built and tested locally; the recommended host is a Linux VM (§1a). §9 lists what isn't verified and what blocks launch.

## 1. What you deploy
- **One container** (`deploy/Dockerfile`), running the gateway. It starts one console per signed-in person inside the same container.
- **A persistent volume at `/data`** (accounts, sessions, every person's runs, workspaces and credentials).
- **TLS in front:** a load balancer or a reverse proxy (Caddy, nginx) that forwards to the container's port 8080.

**Recommended pilot host:** one Linux VM (2–4 vCPU, 8 GB RAM, 50 GB SSD for 5–10 people) with Docker, an encrypted persistent disk, and Caddy for TLS. Use `deploy/docker-compose.yml` and `deploy/Caddyfile`.
- A managed container service works only if it lets the container run as root with `SETUID`/`SETGID`/`CHOWN`/`KILL` capabilities, gives it a persistent POSIX volume and allows `NET_ADMIN` for the egress firewall. Many serverless container platforms don't.
- Several hosts aren't supported yet (consoles live inside the gateway's container).

### 1a. Railway: evaluated, not suitable as configured (2026-10-21)
| Requirement | Railway | Evidence |
|---|---|---|
| Persistent `/data` | One volume per service, mounted as root | Railway docs, Volumes reference |
| Root in the container (to start consoles as person uids) | Yes, `RAILWAY_RUN_UID=0` runs the container as root | Railway docs, Volumes reference |
| `SETUID`/`SETGID`/`CHOWN` for `setpriv` | Not documented; untested without an account | — |
| **`NET_ADMIN` for the egress firewall** | **Not available.** No `--cap-add` and no privileged mode | Railway staff, Central Station: "This would not be possible on Railway" (2024-03-29, on `--cap-add NET_ADMIN`); "You simply can't do such things on Railway.. Yet." (2025-08-16, on privileged mode) |
| Health check | `/readyz` is checked during each deploy only (traffic switches on 200; not monitored afterwards) | Railway docs, Healthchecks |
| Restart | "On Failure", up to 10 restarts by default | Railway docs, Restart policy |
| Secrets | Service variables | Railway docs |

**Conclusion:** without `NET_ADMIN`, `AIW_EGRESS_FIREWALL=1` can't run. A worker could reach the platform's internal network or a metadata service through WebFetch. CLOUD_DEPLOYMENT §9 lists the firewall as a launch blocker, and this design doesn't drop it to fit a host. **Use a Linux VM.** Revisit Railway only if it adds capabilities, or if the egress control moves outside the container (a provider-level egress policy).

## 2. Configuration (environment variables)

### Required
| Variable | Value |
|---|---|
| `AIW_PUBLIC_ORIGIN` | `https://<your domain>`: the exact origin people open. Used for the Origin check, cookies and the GitHub callback |
| `ANTHROPIC_API_KEY` | The platform's Anthropic API key (Claude Console, under Commercial Terms). Read only by the gateway |
| `AIW_DATA` | `/data` (the image's default) |

### Set by the image (change only for a reason)
| Variable | Default | Meaning |
|---|---|---|
| `AIW_ENV` | `production` | `production` refuses http origins, missing isolation and non-https model upstreams |
| `AIW_PORT` / `AIW_BIND` | `8080` / `0.0.0.0` | public listener (behind TLS) |
| `AIW_ISOLATION` | `uid` | each person's console runs as their own uid. `none` is for development only, and refused in production |
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/ms-playwright` | Chromium for the browser adapter |

### Optional
| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG` | unset | Connect with GitHub (§4). Unset: people can only paste a token |
| `AIW_MODEL_PORT` | `8090` | the loopback model endpoint (and GitHub broker) |
| `AIW_CONSOLE_PORT_BASE` | `9100` | consoles listen on 127.0.0.1 at base + person number |
| `AIW_UID_BASE` | `20000` | person n runs as uid base + n |
| `AIW_MODEL_MAX_CONCURRENT` | `4` | model requests at once per person |
| `AIW_MODEL_DAILY_REQUESTS` | `0` (no cap) | model requests per person per day (in memory: resets on restart) |
| `AIW_SESSION_IDLE_HOURS` / `AIW_SESSION_MAX_DAYS` | `12` / `7` | session expiry |
| `AIW_TRUST_PROXY` | unset | `1`: take the client address from `X-Forwarded-For` (for sign-in rate limits) |
| `AIW_EGRESS_FIREWALL` | `0` | `1`: install §6's rules at start (needs `NET_ADMIN`) |
| `AIW_NPROC_LIMIT`, `AIW_FSIZE_LIMIT` | `2048`, 4 GiB | per-person process and file-size limits |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Don't set in production: only `AIW_ENV=test` accepts a non-https upstream (the test suite's fake provider) |

**Never put secrets in the image or the repository.** Pass them from the host's secret store (`--env-file` with mode 600, or the platform's secrets).

## 3. Model provider
- **Provider:** an Anthropic API key from the Claude Console, under Anthropic's Commercial Terms.
- **Why not the subscription:** a claude.ai login may not back a product offered to others (`HOSTED_RUNTIME_AUDIT.md` §2), so the hosted consoles refuse it.
- **Where the key goes:** only into the gateway's environment. Workers reach the model through the gateway's loopback endpoint with a per-console token.
- **Model and effort:** the CLI's defaults, or the person's choice per run in the page. Set a monthly spend limit on the Console account.
- **Bedrock or Vertex instead** (later): the CLI supports them; the gateway's upstream would need that provider's endpoint and signing.

## 4. GitHub App (Connect with GitHub)
Register **one** GitHub App for the platform (github.com → Settings → Developer settings → GitHub Apps → New; for an organisation, in its settings):
- **Callback URL:** `https://<your domain>/github/callback`. Turn on **Expire user authorization tokens**. Leave **Request user authorization (OAuth) during installation** off.
- **Setup URL (optional):** `https://<your domain>/github/callback`, with "Redirect on update".
- **Webhook:** off.
- **Repository permissions:** **Contents: Read and write** (clone and the person's push), **Metadata: Read-only**. Nothing else.
- **Where it can be installed:** "Any account" if pilot users install it on their own accounts or organisations; otherwise only yours.
- **Client secret:** generate one and give `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_SLUG` to the gateway. The secret stays in the gateway; consoles use its broker.

Each person then: GitHub page → Connect with GitHub → authorize → "Choose repositories on GitHub" (install the app on the repositories they want) → Find my repositories → Register → Clone as workspace.

## 5. Storage
- **`/data/control/`** (root, 700): `users.json` (accounts, scrypt hashes) and `sessions.json` (session hashes).
- **`/data/users/<id>/`** (the person's uid, 700): `data/` (runs, workspaces, workers, Teams, Scratch), `claude/` (sessions, for resume), `github/` (their GitHub token), `figma/` (their Figma token), `builder/`, `tmp/`.
- **`/data/logs/`** (root, 700): `<id>.console.log`, each console's own log.

**Requirements:** a POSIX filesystem that keeps uids and modes (ext4/xfs on a block volume; not SMB, and not NFS with root squash). **Encrypt the volume at rest.**

**Backups:** snapshot the volume daily. A restore brings back accounts, sessions, runs and every person's tokens, so treat backups as secret.

## 6. Network
- **Inbound:** only the TLS proxy → container port 8080. Ports 8090 and 9100+ are loopback inside the container and must not be published.
- **Outbound, from the gateway:**
  - `api.anthropic.com:443`;
  - `github.com` and `api.github.com:443` (OAuth, broker).
- **Outbound, from the person uids:**
  - `github.com:443` (git clone and push);
  - `api.figma.com:443`;
  - the web (WebFetch, WebSearch, the browser);
  - the gateway's loopback model port.
- **Egress firewall (required before launch):** the person uids must not reach the cloud metadata service (169.254.169.254), the VPC's private ranges, or the container's loopback services other than the model port.
  - `deploy/egress-firewall.sh` installs these rules (iptables owner match on the person uid range). Run the container with `--cap-add NET_ADMIN` and `AIW_EGRESS_FIREWALL=1`, or apply the equivalent rules on the host for the container's network namespace.
  - DNS to the resolvers in `/etc/resolv.conf` stays allowed (port 53 only), so a VPC or Docker resolver on a private address keeps working. `AIW_DNS_SERVER` adds another.
  - Also block metadata at the cloud level where possible: AWS IMDSv2 with hop limit 1, or the equivalent.

## 7. Start, health, shutdown, logs

```sh
# on the VM, in a clone of the repository
sudo docker compose -f deploy/docker-compose.yml up -d --build
sudo docker compose -f deploy/docker-compose.yml logs -f      # the gateway's JSON log
```

What `deploy/docker-compose.yml` sets:
- secrets from `/etc/ai-worker.env`;
- `AIW_TRUST_PROXY=1`, `AIW_EGRESS_FIREWALL=1`;
- port `127.0.0.1:8080` only (Caddy is the public side);
- the named volume `aiw-data` at `/data`;
- `cap_drop: ALL` plus CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL, NET_ADMIN;
- `no-new-privileges`;
- a 30 s stop grace period;
- `restart: unless-stopped`;
- rotated logs.

**Build context:** the image is built from an allowlist (`.dockerignore`), and the build fails if local state (run history, workers, Teams, prompts) reaches it.

- **Startup failure:** a missing or unsafe setting makes the gateway exit with a list of problems (`docker logs ai-worker`).
- **Accounts:** add each person with `docker exec ai-worker node /app/worker-ui/users.mjs add person@example.com --name "Person"`. It prints a password once; send it to them privately.
  - `passwd`, `disable`, `enable` and `list` are the other commands. `disable` and `passwd` end the person's sessions at once.
- **Health:**
  - `GET /healthz`: the process answers (the image's HEALTHCHECK);
  - `GET /readyz`: data dir writable, provider key set, Claude Code CLI runnable, isolation active, GitHub App configured. 503 if a required one fails. It reports no secret.
- **Graceful shutdown:** `docker compose stop` (SIGTERM through tini, 30 s grace) → the gateway stops taking requests and each console records live runs as `interrupted`, then stops its workers. People continue a run by sending a message after the restart.
- **Logs:** JSON lines on stdout (`docker logs`): requests (method, path without query, status, ms, person id), sign-ins, model requests (person, path, status, ms), console starts and exits.
  - Never bodies, cookies, query strings, tokens or keys.
  - Per-console logs are in `/data/logs/`.

## 8. Deployment sequence
1. **Create the VM.**
   - Ubuntu 24.04 LTS, 2–4 vCPU, 8 GB RAM, 50 GB encrypted disk, your SSH key; any provider works.
   - Open ports 22 (your IP only), 80 and 443.
   - Point a DNS A record (e.g. `aiworker.<your domain>`) at it.
2. **Install Docker and Caddy:** `sudo apt-get install -y docker.io docker-compose-v2 caddy git`.
3. **Get the code:** clone the repository on the VM (a deploy key or the GitHub CLI; the repository is private).
4. **Write `/etc/ai-worker.env`** (`sudo install -m 600 /dev/null /etc/ai-worker.env`, then edit):
   - `AIW_PUBLIC_ORIGIN=https://aiworker.<your domain>`
   - `ANTHROPIC_API_KEY=…`
   - `GITHUB_APP_CLIENT_ID=…`, `GITHUB_APP_CLIENT_SECRET=…`, `GITHUB_APP_SLUG=…`
5. **Set up TLS:** copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, set `AIW_DOMAIN=aiworker.<your domain>` in `/etc/default/caddy` (or write the name into the file), then `sudo systemctl restart caddy`.
6. **Start:** `sudo docker compose -f deploy/docker-compose.yml up -d --build` (§7). Then `curl -s https://aiworker.<your domain>/readyz` must answer 200 with every check `ok`.
7. **Verify the egress firewall from inside:**
   - `sudo docker compose -f deploy/docker-compose.yml exec ai-worker setpriv --reuid=20001 --regid=20001 --clear-groups node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(5000)}).then(()=>console.log('REACHABLE')).catch(()=>console.log('blocked'))"` must print `blocked`;
   - the same for `https://api.github.com` must print `REACHABLE`.
   - `bench/hosted/image-test.sh` runs these and the other container checks if you copy it to the VM.
8. **Add yourself as the first account** (`… exec ai-worker node /app/worker-ui/users.mjs add you@example.com --name "You"`).
9. **Run the live checks** (§9 "Live verification"): a real model run, Connect with GitHub, a clone, a commit, your push, a Figma link read, a browser task, two accounts.
10. **Add the pilot users.**

**Updating:** `git pull`, then `sudo docker compose -f deploy/docker-compose.yml up -d --build`. Live runs are recorded as interrupted and continue with the next message. The volume, accounts and sessions are kept.

## 9. Status: what's verified, what isn't, what blocks launch

### Verified (automated; results in `bench/hosted/`)
- `hosted-test.mjs`, **Linux (Ubuntu 24.04 on WSL2), as root, per-person uids:** 26/26 (`hosted-results-linux.json`).
  - It also passed **with the egress firewall active** (`EGRESS=1`, `hosted-results-linux-egress.json`: 25/25, the run before the Scratch step was added).
- `hosted-test.mjs`, **Windows** (isolation none): 24/24, with the 2 Linux-only steps skipped (`hosted-results-win32.json`).
- `hosted-ui-test.mjs`, **Windows**: the website in a real browser, 7/7 (`hosted-ui-results.json`).
- **The deployment image** (`ai-worker:pilot`, built with Docker 29 on Ubuntu 24.04, 2026-10-21), run with the production capability set, `no-new-privileges` and the firewall on:
  - `image-test.sh` 16/16: no local state in the image, production start, firewall installed, `/readyz` 200 with no secret, `__Host-` Secure cookie, both people on their own uid consoles with no capabilities, no cross-person reads, metadata and the gateway port refused to a person uid, the internet reachable, graceful stop (exit 0), session kept across a restart;
  - `hosted-test.mjs` inside the image 26/26 (`hosted-results-linux-egress-image.json`).
- `egress-test.sh`, **Linux:** as a person uid, the model port and the public internet are reachable; another loopback service, a private address and 169.254.169.254 are refused at once; root is unaffected.
- **What these exercised:** the real gateway, the real consoles, the real Claude Code CLI 2.1.283, real tools and real Chromium, with a **fake model provider** and a mock github.com. The Figma connection check went to the live Figma API.

### Local regression (2026-10-20)
- **Passed without a model:**
  - `github-app` 13/13;
  - `github` 16/17 (the one failure is its real-worker step);
  - `repo-tools-test` 7/7;
  - browser adapter D1–D3 (verdicts unchanged, no canary leaks).
- **Blocked:** the suites that need a real worker (remediation, workers, teams, workflow, boundaries, …). This machine's Claude Code sign-in had expired (`claude auth status`: not logged in), so every worker turn failed with "OAuth session expired". **Re-run them after signing in again.**

### Live verification: NOT done (no credentials in the build environment)
- A run against the real Anthropic API.
- Connect with GitHub against github.com, clone and push to a real GitHub repository.
- Reading a real Figma file with a real token (the connection page *was* checked against the live Figma API, with a token Figma rejected).
- A deployment to a real host (none is set up yet; see §1a for why not Railway).

### Launch blockers
1. **The egress firewall** (§6) must be verified on the real host (§8 step 7). It was verified inside the image here, on a WSL2 kernel, not yet on the target VM's kernel or provider network.
2. **The live checks** in §8 step 9 must pass with the real key, app and domain.
3. **`/readyz` must be 200 on the target host** behind TLS.

### Known limitations (accepted for the pilot, documented)
- **Shell commands** (`node`, `curl`) aren't available to workers hosted, so workers can't run builds or tests.
- **Figma editing** (the plugin) needs the person's Figma desktop app: not available hosted. Reading Figma links is.
- **Builder.io** has no website flow to add keys.
- **One live worker per person;** one host.
- **The gateway runs as root** in its container (to switch uids). Splitting out a minimal privileged spawner is the next hardening step.
- **No disk quotas** per person; the daily model-request cap resets on restart.
