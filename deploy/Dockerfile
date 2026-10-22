# AI Worker, hosted pilot image: the gateway (control plane) and everything a person's console and
# workers need. Build from the repository root:
#   docker build -f deploy/Dockerfile -t ai-worker:pilot .
# Run: docs/CLOUD_DEPLOYMENT.md (it needs root inside the container to start each person's console as
# their own uid, a persistent /data volume, and the environment listed there).
FROM node:22-bookworm-slim

# git: workspaces and repositories. util-linux: setpriv/prlimit (the per-person uid switch and limits).
# tini: PID 1 that reaps orphaned worker processes. iptables: the optional egress firewall (§6).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates util-linux tini iptables \
 && (command -v setpriv || apt-get install -y --no-install-recommends setpriv) \
 && rm -rf /var/lib/apt/lists/*

# The worker runtime: the Claude Code CLI, pinned to the version the platform was tested with.
ARG CLAUDE_CODE_VERSION=2.1.283
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

WORKDIR /app
COPY mcp/package.json mcp/package-lock.json mcp/
COPY browser-adapter/package.json browser-adapter/package-lock.json browser-adapter/
RUN cd mcp && npm ci --omit=dev && cd ../browser-adapter && npm ci --omit=dev && npm cache clean --force
# Chromium and its system libraries, for the browser adapter.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN cd browser-adapter && npx --no-install playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY worker-ui/ worker-ui/
COPY mcp/*.mjs mcp/
COPY browser-adapter/server.mjs browser-adapter/
COPY figma-reader/ figma-reader/
COPY builder-adapter/ builder-adapter/
COPY deploy/entrypoint.sh deploy/egress-firewall.sh deploy/
# The platform's code is read-only and readable by every person's uid; nothing of a person's lives here.
# .dockerignore keeps local state out of the build context; this fails the build if any ever slips in.
RUN for p in worker-ui/runs worker-ui/scratch worker-ui/scratch-runs worker-ui/workers worker-ui/teams worker-ui/devctl-logs \
      worker-ui/workers.json worker-ui/teams.json worker-ui/workspaces.json worker-ui/github.json worker-ui/prompts.json worker-ui/instructions.effective.md; do \
      if [ -e "$p" ]; then echo "local state in the build context: $p (check .dockerignore)"; exit 1; fi; done \
 && chown -R root:root /app && chmod -R a+rX,go-w /app && chmod 755 deploy/*.sh

ENV AIW_ENV=production AIW_DATA=/data AIW_PORT=8080 AIW_ISOLATION=uid NODE_ENV=production
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
