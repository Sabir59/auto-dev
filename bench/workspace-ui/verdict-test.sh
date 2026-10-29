#!/usr/bin/env bash
# The suite runner's verdict (verdict.sh) can't call a crashed or empty suite a pass.
#   bash bench/workspace-ui/verdict-test.sh
set -u
. "$(dirname "$0")/verdict.sh"
T="$(mktemp -d)"; ok=0; bad=0
check() { # name, exit code the suite had, log text, expected verdict word, expected return
  local name=$1 code=$2 text=$3 want=$4 wantrc=$5 out rc
  printf '%b' "$text" > "$T/log"; suite=$name
  out=$(verdict "$code" "$T/log"); rc=$?
  if echo "$out" | grep -q "^SUITE $name: $want" && [ "$rc" = "$wantrc" ]; then echo "PASS $name -> $want (exit $rc)"; ok=$((ok+1));
  else echo "FAIL $name: wanted $want/$wantrc, got exit $rc: $(echo "$out" | grep '^SUITE')"; bad=$((bad+1)); fi
}
check crashed 1 "file:///x/teams-test.mjs:46\nError: Command failed: git rev-parse\nfatal: not a git repository\n" FAIL 1
check crashed-after-passes 1 "PASS one\nTypeError: boom\n" FAIL 1
check empty 0 "" FAIL 1
check no-results 0 "starting...\ndone\n" FAIL 1
check failed-step-exit-0 0 "PASS one\nFAIL two boom\n1/2 passed\n" FAIL 1
check failed-step-exit-1 1 "PASS one\nFAIL two\n" FAIL 1
check blocked 3 "BLOCKED no fixture\n" BLOCKED 3
check not-run 99 "unknown suite: x\n" "NOT RUN" 2
check passed 0 "PASS one\nPASS two\n2/2 passed\n" PASS 0
rm -rf "$T"
echo "$ok/$((ok+bad)) passed"
[ "$bad" = 0 ]
