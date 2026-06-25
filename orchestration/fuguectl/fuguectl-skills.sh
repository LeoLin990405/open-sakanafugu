#!/usr/bin/env bash
# fuguectl-skills.sh — thin shell bridge to the TypeScript skills mother-catalog command.
#
#   index [--refresh]
#   list [--type functional|note|all] [--source user|system|plugin|all]
#   match "<query>" [--type t] [--source s] [--limit N]
#   show <id>
#   inject <id1,id2,...> [--full]
#   validate <id> | --dir <d> [--official]
#   forge --name <id> (--from-experience <ws/slug> | --source <f> | --material)
#   env: FUGUE_SKILLS_ROOT / FUGUE_PLUGINS_ROOT / FUGUE_SKILLS_CATALOG / FUGUE_ENGINE_CLI
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fuguectl-lib.sh"

case "${1:-}" in
  ''|-h|--help) sed -n '2,10p' "$0";;
  *) fx_run_engine skills "$@";;
esac
