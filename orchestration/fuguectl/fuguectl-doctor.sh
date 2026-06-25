#!/usr/bin/env bash
# fuguectl-doctor.sh — thin shell bridge to the TypeScript environment doctor
#
# On any machine, detect: which Agent/CLIs are installed, which provider APIs are configured (var name only, never reads value),
# and recommend how to set up this parallel dispatch workflow accordingly. Never prints any secret value.
#
#   usage: scripts/fuguectl-doctor.sh         # human-readable report
#         scripts/fuguectl-doctor.sh --quiet # conclusion line only
#   env: FUGUE_ENGINE_CLI overrides the built engine CLI path
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fuguectl-lib.sh"

fx_run_engine doctor "$@"
