#!/usr/bin/env bash
# fanout-testlib.sh — shared harness for the fanout *.test.sh suites.
#
# SOURCED near the top of each suite (after HERE is set):
#     # shellcheck source=/dev/null
#     . "$(dirname "${BASH_SOURCE[0]}")/fanout-testlib.sh"
#
# Provides pass/fail counters, ok(), and tdone() — replacing the identical
# boilerplate that was copy-pasted into all 18 suites. Output is byte-identical
# to the former per-suite code so the selftest driver parses it unchanged.

# shellcheck disable=SC2034  # pass/fail are used by the sourcing test suite
pass=0; fail=0

# suite name for the summary line (e.g. fanout-dispatch), from the sourcing file.
T_PROG="${BASH_SOURCE[1]:-${0:-fanout-test}}"; T_PROG="${T_PROG##*/}"; T_PROG="${T_PROG%.test.sh}"

# ok <label> <command-string>: eval the command; tick pass/fail; print ✓/✗.
ok() { if eval "$2"; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }

# skip <label> [reason]: prerequisite unavailable — record nothing (not a failure).
skip() { echo "  ⊘ $1${2:+ — skipped: $2}"; }

# tdone: print "<suite>: N passed, M failed" and return success iff no failures.
tdone() { echo "$T_PROG: $pass passed, $fail failed"; [ "$fail" -eq 0 ]; }
