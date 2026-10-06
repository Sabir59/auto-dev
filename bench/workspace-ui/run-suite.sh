#!/usr/bin/env bash
# Runs one Workspace UI suite against its own fresh test console: port 8797, a new data dir, an
# empty Figma Reader dir. Your own console (8799) and its data are not touched.
#   bash bench/workspace-ui/run-suite.sh <suite>
#   suite: workflow | manage | sync | attach | versions | mentions | workers | designer | teams
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
if curl -s -o /dev/null http://127.0.0.1:8797/; then echo "port 8797 is in use: stop that process first"; exit 1; fi
FIGMA_READER_DIR="$(cygpath -w "$D/figma-reader")" WORKER_CONSOLE_PORT=8797 WORKER_CONSOLE_DATA="$(cygpath -w "$D")" node worker-ui/server.mjs > "$D/console.log" 2>&1 &
CPID=$!
curl -s -o /dev/null --retry 10 --retry-connrefused http://127.0.0.1:8797/
rm -rf "$FIXROOT/work/notes"
export CANARY="$(cygpath -w "$FIXROOT/canary/ws")" WORK="$(cygpath -w "$FIXROOT/work")" DATA="$(cygpath -w "$D")" FIX="$(cygpath -w "$FIXROOT/att")" FIGDIR="$(cygpath -w "$D/figma-reader")"
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
  *) echo "unknown suite: $suite" ;;
esac 2>&1 | grep -E "^(PASS|FAIL)|passed" | cut -c1-160
kill $CPID 2>/dev/null; wait $CPID 2>/dev/null
rm -rf "$FIXROOT/work/notes"
