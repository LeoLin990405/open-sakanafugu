#!/usr/bin/env bash
# fuguectl-fleet.sh — thin shell bridge to the TypeScript fugue-cc fleet lifecycle command.
#
#   status [proj...]        whether each project's provider daemon is ready
#   up [--dry] [--pty] [proj...]  strip CLAUDE_CODE_* + start provider in tmux or pty fallback
#   down [proj...]          stop provider daemon
#   env: FUGUE_CC_WORK / FUGUE_CC_CLAUDE / FUGUE_CC_CLAUDE_PREFIX / FUGUE_CC_BIN / FUGUE_ENGINE_CLI
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fuguectl-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  ''|-h|--help) sed -n '2,7p' "$0";;
  *) FUGUE_FLEET_LAUNCHER="${FUGUE_FLEET_LAUNCHER:-$HERE/fleet-launch.py}" fx_run_engine fleet "$@";;
esac
