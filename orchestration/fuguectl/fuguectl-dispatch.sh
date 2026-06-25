#!/usr/bin/env bash
# fuguectl-dispatch.sh — thin shell bridge to the TypeScript harness dispatcher.
#   fuguectl-dispatch.sh <target> [--harness fugue-cc|codex|opencode] [--workspace <ws>] \
#       (--template <name> [--set K=V ...] | --prompt-file <f>) [--task <file>]
#   --task-type T  append (T, agent) into alloc ledger → later `allocate feed --from-ledger`
#   --skills a,b   inject selected skills into that agent context
#   env: FUGUE_CC_BIN / FUGUE_CODEX / FUGUE_OPENCODE / FUGUE_ALLOCATION_LEDGER / FUGUE_ENGINE_CLI
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fuguectl-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPLDIR="${FUGUE_TEMPLATES:-$HERE/templates}"
WSDIR="${FUGUE_WORKSPACES:-$HERE/workspaces}"
ALLOC="${FUGUE_ALLOCATION:-$HERE/allocation.tsv}"
STATS="${FUGUE_ALLOCATION_STATS:-${FUGUE_STATE:-$HOME/.config/fugue}/allocation-stats.tsv}"
EXPERIENCE="${FUGUE_EXPERIENCE:-${FUGUE_STATE:-$HOME/.config/fugue}/experience}"
LEDGER="${FUGUE_ALLOCATION_LEDGER:-${FUGUE_STATE:-$HOME/.config/fugue}/alloc-ledger.tsv}"

case "${1:-}" in
  -h|--help) sed -n '2,8p' "$0";;
  *)
    fx_run_engine dispatch \
      --templates "$TPLDIR" \
      --workspaces "$WSDIR" \
      --allocation "$ALLOC" \
      --stats "$STATS" \
      --experience "$EXPERIENCE" \
      --ledger "$LEDGER" \
      "$@"
    ;;
esac
