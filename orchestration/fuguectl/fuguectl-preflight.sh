#!/usr/bin/env bash
# fuguectl-preflight.sh — thin shell bridge to the TypeScript preflight command.
# pre-run go/no-go gate for parallel dispatch (turns hard rules into code)
#
# One-shot verification before dispatch: dependency CLIs / provider mounted / provider config sound + **no-Gemini guard** / cache tools.
# Hard failure → exit 1 (NO-GO); warn only → exit 0 (GO).
#
#   usage: fuguectl-preflight.sh [provider config path]
#   env:  FUGUE_CC_WORK = provider project root (used to ping daemon + locate .fugue-cc/provider.config)
#         FUGUE_ENGINE_CLI overrides the built engine CLI path
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fuguectl-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUGUE_CC="${FUGUE_CC_BIN:-fugue-cc}"
WORK_ROOT="${FUGUE_CC_WORK:-}"

case "${1:-}" in
  -h|--help) sed -n '2,9p' "$0"; exit 0;;
esac

args=(preflight --bin "$FUGUE_CC" --cache-script "$HERE/fuguectl-cache.sh")
[ -n "$WORK_ROOT" ] && args+=(--work "$WORK_ROOT")
fx_run_engine "${args[@]}" "$@"
