#!/usr/bin/env bash
# fanout-summary.sh — round observability: cache-status summary table (optionally written into the TASK file)
#   fanout-summary.sh <round> [--task <file>]
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/fanout-cache.sh"

round="${1:-}"; shift || true
[ -n "$round" ] || die "usage: <round> [--task <file>]"
task=""
while [ "$#" -gt 0 ]; do case "$1" in --task) task="${2:-}"; shift 2;; *) die "unknown arg '$1'";; esac; done

st="$(bash "$CACHE" status "$round")" || die "round-$round not init"
# timing (cache writes .started on init, <id>.at on put/fail)
CACHE_ROOT="$(fx_cache_root)"
d="$CACHE_ROOT/round-$round"; elapsed="?"
[ -f "$d/.started" ] && elapsed="$(( $(date +%s) - $(cat "$d/.started") ))s"
summary="$( { echo "### Round $round summary — $st — elapsed $elapsed"; bash "$CACHE" list "$round"; } )"
printf '%s\n' "$summary"

if [ -n "$task" ]; then
  [ -f "$task" ] || die "no TASK file $task"
  printf '\n%s\n' "$summary" >> "$task"
  echo "→ written to $task" >&2
fi
