#!/usr/bin/env bash
# fanout-goal.sh — goal mode: declarative goal spec + deterministic acceptance gate
#
# Wraps loop v2 + bench allocation + cache in one declarative goal. spec is key: value lines:
#   outcome:  one-line goal
#   gate:     one runnable objective acceptance command (e.g. pytest -q && npm run build)
#   rubric:   focus areas for Codex subjective review
#   rounds:   loop round cap
#   allocate: auto | manual
#
#   template          print spec template
#   show  <spec>      parse and display spec fields
#   check <spec>      run gate command: met = exit 0, else 1 (Phase 5 loop objective acceptance gate)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
field(){ sed -n "s/^$1:[[:space:]]*//p" "$2" | head -1; }

cmd_template(){
  cat <<'EOF'
# fanout goal spec — `fanout goal check <thisfile>` runs gate to decide if goal is met
outcome: <one-line goal>
gate: <one runnable acceptance command, e.g. pytest -q && npm run build>
rubric: correctness / security / no regression
rounds: 3
allocate: auto
EOF
}

cmd_show(){
  local f="${1:-}"; [ -n "$f" ] && [ -f "$f" ] || die "no spec file: ${f:-(empty)}"
  printf 'outcome:  %s\n' "$(field outcome "$f")"
  printf 'gate:     %s\n' "$(field gate "$f")"
  printf 'rubric:   %s\n' "$(field rubric "$f")"
  printf 'rounds:   %s\n' "$(field rounds "$f")"
  printf 'allocate: %s\n' "$(field allocate "$f")"
}

cmd_check(){
  local f="${1:-}"; [ -n "$f" ] && [ -f "$f" ] || die "no spec file: ${f:-(empty)}"
  local gate; gate="$(field gate "$f")"
  [ -n "$gate" ] || die "spec has no gate line"
  echo "── goal gate: $gate ──"
  if bash -c "$gate"; then echo "✓ goal met (gate passed)"; exit 0
  else echo "✗ goal not met (gate failed) → enter Phase 5 loop to fix"; exit 1; fi
}

sub="${1:-}"; shift || true
case "$sub" in
  template) cmd_template;;
  show)     cmd_show  "$@";;
  check)    cmd_check "$@";;
  ''|-h|--help) sed -n '2,18p' "$0";;
  *) die "unknown subcommand '$sub' (template|show|check)";;
esac
