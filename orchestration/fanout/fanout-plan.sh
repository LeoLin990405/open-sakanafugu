#!/usr/bin/env bash
# fanout-plan.sh — multi-model planning panel: send "decompose goal" to N planning models at once, each Writes its plan,
#                  then the planner(Claude) synthesizes. This is the design panel pattern.
#   fanout-plan.sh "<goal>" [--models m1,m2,..] [--out <dir>]
#   default models = cc-deepseek,cc-kimi,coder   (cross-family, different perspectives)
#   default out    = <cache_root>/plans
#   env: FANOUT_CCB(stub for tests) / FANOUT_CACHE
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

goal="${1:-}"; shift || true
[ -n "$goal" ] || die "usage: \"<goal>\" [--models m1,m2,..] [--out <dir>]"
models="cc-deepseek,cc-kimi,coder"
CACHE_ROOT="$(fx_cache_root)"
out="$CACHE_ROOT/plans"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --models) models="${2:-}"; shift 2;;
    --out) out="${2:-}"; shift 2;;
    *) die "unknown arg '$1'";;
  esac
done
mkdir -p "$out"

echo "── planning panel: goal decomposition → ${models//,/ } ──"
IFS=',' read -ra MS <<< "$models"
files=()
for m in "${MS[@]}"; do
  [ -n "$m" ] || continue
  of="$out/$m.plan.md"; files+=("$of")
  bash "$HERE/fanout-dispatch.sh" "$m" --template plan \
    --set MODEL="$m" --set GOAL="$goal" --set OUTFILE="$of" >/dev/null 2>&1 \
    && echo "  → dispatched to $m, plan will be written to $of" \
    || echo "  ✗ $m dispatch failed"
done
echo ""
echo "collect: after each model finishes writing, the planner reads these plans and synthesizes the final plan:"
for f in "${files[@]}"; do echo "  $f"; done
