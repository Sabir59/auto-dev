# Cloud deployment (hosted pilot)

How to run AI Worker as a website for a few trusted people. The design is in `docs/HOSTED_ARCHITECTURE.md`. **Nothing has been deployed yet.** §9 lists what isn't verified and what blocks launch.

## 1. What you deploy
- **One container** (`deploy/Dockerfile`), running the gateway. It starts one console per signed-in person inside the same container.
- **A persistent volume at `/data`** (accounts, sessions, every person's runs, workspaces and credentials).
- **TLS in front:** a load balancer or a reverse proxy (Caddy, nginx) that forwards to the container's port 8080.

**Recommended pilot host:** one Linux VM (2–4 vCPU, 8 GB RAM, 50 GB SSD for 5–10 people) with Docker, an encrypted persistent disk, and Caddy for TLS.
- A managed container service works only if it lets the container run as root with `SETUID`/`SETGID`/`CHOWN`/`KILL` capabilities and gives it a persistent POSIX volume. Many serverless container platforms don't.
- Several hosts aren't supported yet (consoles live inside the gateway's container).

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
docker build -f deploy/Dockerfile -t ai-worker:pilot .
docker volume create aiw-data
docker run -d --name ai-worker --restart unless-stopped \
  --env-file /etc/ai-worker.env \
  -v aiw-data:/data -p 127.0.0.1:8080:8080 \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_ADMIN \
  ai-worker:pilot
```

- **Startup failure:** a missing or unsafe setting makes the gateway exit with a list of problems (`docker logs ai-worker`).
- **Accounts:** add each person with `docker exec ai-worker node /app/worker-ui/users.mjs add person@example.com --name "Person"`. It prints a password once; send it to them privately.
  - `passwd`, `disable`, `enable` and `list` are the other commands. `disable` and `passwd` end the person's sessions at once.
- **Health:**
  - `GET /healthz`: the process answers (the image's HEALTHCHECK);
  - `GET /readyz`: data dir writable, provider key set, Claude Code CLI runnable, isolation active, GitHub App configured. 503 if a required one fails. It reports no secret.
- **Graceful shutdown:** `docker stop` (SIGTERM, 10 s) → the gateway stops taking requests and each console records live runs as `interrupted`, then stops its workers. People continue a run by sending a message after the restart.
  - Give `docker stop -t 30` if many people are active.
- **Logs:** JSON lines on stdout (`docker logs`): requests (method, path without query, status, ms, person id), sign-ins, model requests (person, path, status, ms), console starts and exits.
  - Never bodies, cookies, query strings, tokens or keys.
  - Per-console logs are in `/data/logs/`.

## 8. Deployment sequence
1. Create the VM, an encrypted data disk and a DNS name; install Docker and Caddy (`reverse_proxy 127.0.0.1:8080`).
2. Create the Anthropic API key (Console, with a spend limit) and register the GitHub App (§4).
3. Write `/etc/ai-worker.env` (mode 600): `AIW_PUBLIC_ORIGIN`, `ANTHROPIC_API_KEY`, `GITHUB_APP_*`, `AIW_TRUST_PROXY=1`, `AIW_EGRESS_FIREWALL=1`.
4. Build and run the container (§7). Check `GET /readyz` → 200.
5. **Verify the egress firewall from inside:**
   - `docker exec ai-worker setpriv --reuid=20001 --regid=20001 --clear-groups node -e "fetch('http://169.254.169.254/').then(()=>console.log('REACHABLE')).catch(e=>console.log('blocked', e.cause?.code))"` must print `blocked`;
   - the same for `https://api.github.com` must succeed.
6. Add yourself as the first account. Run the live checks (§9 "Live verification"): a real model run, Connect with GitHub, a clone, a commit, your push, a Figma link read, a browser task.
7. Add the pilot users.

## 9. Status: what's verified, what isn't, what blocks launch

### Verified (automated; results in `bench/hosted/`)
- `hosted-test.mjs`, **Linux (Ubuntu 24.04 on WSL2), as root, per-person uids:** 26/26 (`hosted-results-linux.json`).
  - It also passed **with the egress firewall active** (`EGRESS=1`, `hosted-results-linux-egress.json`: 25/25, the run before the Scratch step was added).
- `hosted-test.mjs`, **Windows** (isolation none): 24/24, with the 2 Linux-only steps skipped (`hosted-results-win32.json`).
- `hosted-ui-test.mjs`, **Windows**: the website in a real browser, 7/7 (`hosted-ui-results.json`).
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
- The container image build and a deployment. The Dockerfile hasn't been built here (no Docker in the build environment).

### Launch blockers
1. **The egress firewall** (§6) must be installed and verified on the real host (§8 step 5). The script was verified on a Linux kernel here, not on the target host or inside the image.
2. **The live checks** in §8 step 6 must pass with the real key, app and domain.
3. **The image must be built and `/readyz` must be 200** on the target host.

### Known limitations (accepted for the pilot, documented)
- **Shell commands** (`node`, `curl`) aren't available to workers hosted, so workers can't run builds or tests.
- **Figma editing** (the plugin) needs the person's Figma desktop app: not available hosted. Reading Figma links is.
- **Builder.io** has no website flow to add keys.
- **One live worker per person;** one host.
- **The gateway runs as root** in its container (to switch uids). Splitting out a minimal privileged spawner is the next hardening step.
- **No disk quotas** per person; the daily model-request cap resets on restart.
