# Sourced by run-suite.sh (and tested by verdict-test.sh): one verdict for a suite run.
# verdict <exit code> <log file>   (uses $suite for the label)
# The suite's whole output goes to suite.log; the PASS/FAIL lines are printed, then one verdict:
#   PASS     it ran, exited 0, printed at least one PASS and no FAIL            exit 0
#   FAIL     it crashed or exited non-zero, printed a FAIL, or printed no result exit 1 (or its own code)
#   BLOCKED  it couldn't run here (it printed BLOCKED / exited 3), with the reason exit 3
#   NOT RUN  unknown suite                                                     exit 2
# A crash or an empty result is never reported as a pass; the log's tail is shown when it isn't PASS.
verdict() {
  local code=$1 log=$2 pass fail
  grep -E "^(PASS|FAIL|BLOCKED)|passed" "$log" | cut -c1-160
  pass=$(grep -c "^PASS" "$log"); fail=$(grep -c "^FAIL" "$log")
  if [ "$code" = 99 ]; then echo "SUITE $suite: NOT RUN (unknown suite)"; return 2; fi
  if [ "$code" = 3 ] || grep -q "^BLOCKED" "$log"; then echo "SUITE $suite: BLOCKED (exit $code) $(grep -m1 "^BLOCKED" "$log" | cut -c9-300)"; return 3; fi
  if [ "$code" = 0 ] && [ "$pass" -gt 0 ] && [ "$fail" = 0 ]; then echo "SUITE $suite: PASS ($pass passed)"; return 0; fi
  local why="exit $code, $pass passed, $fail failed"; [ "$pass" = 0 ] && [ "$fail" = 0 ] && why="$why: no test result was printed (crash or nothing ran)"
  echo "SUITE $suite: FAIL ($why); last lines of $log:"; tail -n 15 "$log" | cut -c1-300
  [ "$code" = 0 ] && return 1; return "$code"
}
