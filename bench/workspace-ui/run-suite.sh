#!/usr/bin/env bash
# Runs one Workspace UI suite against its own fresh test console: port 8797, a new data dir, an
# empty Figma Reader dir. Your own console (8799) and its data are not touched.
#   bash bench/workspace-ui/run-suite.sh <suite>
#   suite: workflow | manage | sync | attach | versions | mentions | workers | designer | teams | devctl | builder | builder-real (real Builder + real worker; SITE=) | remediation | github-app | create
# Windows + Git Bash (uses cygpath and mklink). Fixtures live under $FIXROOT (default %TEMP%\wsui,
# kept short because the Teams suite clones MATW, whose paths are long); fixtures.mjs builds them
# on first use. The real worker runs, so most suites take minutes and use your Claude subscription.
# Prints PASS/FAIL lines; the full evidence is in bench/workspace-ui/<suite>-results.json.
set -u
suite=${1:?suite}
R="$(cd "$(dirname "$0")/../.." && pwd)"
FIXROOT="${FIXROOT:-$(cygpath -u "${TEMP:-/tmp}")/wsui}"
mkdir -p "$FIXROOT"
[ -d "$FIXROOT/canary/ws/.git" ] || node "$R/bench/workspace-ui/fixtures.mjs" "$(cygpath -w "$FIXROOT")"
D="$FIXROOT/data-$suite-$(date +%s)"; mkdir -p "$D"
cd "$R"

if [ "$suite" = devctl ]; then
  # This suite tests starting/stopping the console and bridge themselves, so it manages its own
  # test console (8797) and a dedicated test bridge port (8788) through devctl — it does not use
  # the generic pre-started console below, and nothing it starts needs cleaning up by $CPID.
  if curl -s -o /dev/null http://127.0.0.1:8797/; then echo "port 8797 is in use: stop that process first"; exit 1; fi
  node bench/workspace-ui/devctl-test.mjs 8797 8788 "$(cygpath -w "$D")" 2>&1 | grep -E "^(PASS|FAIL)|passed" | cut -c1-160
  exit $?
fi

if curl -s -o /dev/null http://127.0.0.1:8797/; then echo "port 8797 is in use: stop that process first"; exit 1; fi
# Every test console gets its own empty Builder credentials folder, so no suite can pick up real
# Builder keys; the builder suite also points the console's Builder checks at its local mock.
# builder-real is the exception: it uses the person's real Builder credentials (~/.builder-adapter,
# a space they marked "test") against real Builder, and a site that renders that space (SITE).
if [ "$suite" = builder ] || [ "$suite" = create ]; then export BUILDER_ADMIN_BASE=http://127.0.0.1:8789 BUILDER_CONTENT_BASE=http://127.0.0.1:8789 BUILDER_WRITE_BASE=http://127.0.0.1:8789; fi
BDIR="$(cygpath -w "$D/builder")"; [ "$suite" = builder-real ] && BDIR="$(cygpath -w "$HOME/.builder-adapter")"
# Likewise an empty GitHub credentials folder per test console; the github suite also points the
# console at its local mock GitHub API.
export GITHUB_CONNECTOR_DIR="$(cygpath -w "$D-github")"
if [ "$suite" = github ]; then export GITHUB_API_BASE=http://127.0.0.1:8785; fi
# github-app: github.com's sign-in and the API are both the mock; a short state lifetime for the expiry test.
if [ "$suite" = github-app ]; then export GITHUB_API_BASE=http://127.0.0.1:8785 GITHUB_WEB_BASE=http://127.0.0.1:8785 GITHUB_STATE_TTL_MS=4000; fi
BUILDER_ADAPTER_DIR="$BDIR" FIGMA_READER_DIR="$(cygpath -w "$D/figma-reader")" WORKER_CONSOLE_PORT=8797 WORKER_CONSOLE_DATA="$(cygpath -w "$D")" node worker-ui/server.mjs > "$D/console.log" 2>&1 &
CPID=$!
curl -s -o /dev/null --retry 10 --retry-connrefused http://127.0.0.1:8797/
rm -rf "$FIXROOT/work/notes"
export CANARY="$(cygpath -w "$FIXROOT/canary/ws")" WORK="$(cygpath -w "$FIXROOT/work")" DATA="$(cygpath -w "$D")" FIX="$(cygpath -w "$FIXROOT/att")" FIGDIR="$(cygpath -w "$D/figma-reader")" BUILDER_DIR="$(cygpath -w "$D/builder")"
case $suite in
  workflow) node bench/workspace-ui/workflow-test.mjs 8797 "$(cygpath -w "$D/shots")" ;;
  manage) node bench/workspace-ui/manage-test.mjs 8797 ;;
  sync) node bench/workspace-ui/sync-test.mjs 8797 ;;
  attach) node bench/workspace-ui/attach-test.mjs 8797 ;;
  versions) SCRATCH="$(cygpath -w "$FIXROOT/vt")" node bench/workspace-ui/versions-test.mjs 8797 ;;
  mentions) MFIX="$(cygpath -w "$FIXROOT/mfix")" node bench/workspace-ui/mentions-test.mjs 8797 ;;
  workers) node bench/workspace-ui/workers-test.mjs 8797 ;;
  designer) node bench/workspace-ui/designer-worker-test.mjs 8797 ;;
  teams) TFIX="$(cygpath -w "$FIXROOT/tf")" node bench/workspace-ui/teams-test.mjs 8797 ;;
  builder) node bench/workspace-ui/builder-access-test.mjs 8797 ;;
  create) node bench/workspace-ui/create-test.mjs 8797 ;;
  account) node bench/workspace-ui/account-test.mjs 8797 ;;
  model) node bench/workspace-ui/model-test.mjs 8797 ;;
  context) node bench/workspace-ui/context-test.mjs 8797 ;;
  github) GHDIR="$GITHUB_CONNECTOR_DIR" node bench/workspace-ui/github-test.mjs 8797 ;;
  boundaries) node bench/workspace-ui/boundaries-test.mjs 8797 ;;
  autofresh) node bench/workspace-ui/autofresh-test.mjs 8797 ;;
  remediation) node bench/workspace-ui/remediation-test.mjs 8797 ;;
  github-app) GHDIR="$GITHUB_CONNECTOR_DIR" node bench/workspace-ui/github-app-test.mjs 8797 ;;
  builder-real) BUILDER_ADAPTER_DIR="$BDIR" SITE="${SITE:-http://localhost:3000}" node bench/workspace-ui/builder-worker-test.mjs 8797 ;;
  *) echo "unknown suite: $suite" ;;
esac 2>&1 | grep -E "^(PASS|FAIL)|passed" | cut -c1-160
kill $CPID 2>/dev/null; wait $CPID 2>/dev/null
rm -rf "$FIXROOT/work/notes"
