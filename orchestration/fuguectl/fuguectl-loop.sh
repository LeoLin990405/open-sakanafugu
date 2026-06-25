#!/usr/bin/env bash
# fuguectl-loop.sh — thin shell bridge to the TypeScript review-fix loop state machine.
#
#   init  [--max N] [--task F] [--best-sha SHA] [--best-n N]
#   record <round> --gate pass|fail --verdict ACCEPTED|NEEDSFIX --findings N
#          [--ask-user K] [--sha SHA] [--same-class] [--note "..."]
#   decide|next
#   status
#   env: FUGUE_CACHE, FUGUE_ENGINE_CLI
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fuguectl-lib.sh"

case "${1:-}" in
  ''|-h|--help) sed -n '2,9p' "$0";;
  *) fx_run_engine loop --cache "$(fx_cache_root)" "$@";;
esac
