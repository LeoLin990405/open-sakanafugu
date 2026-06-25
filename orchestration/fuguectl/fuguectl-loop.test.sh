#!/usr/bin/env bash
# fuguectl-loop.test.sh — self-test for the loop shell bridge.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP="$HERE/fuguectl-loop.sh"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FUGUE_CACHE="$TMP/cache"
export FUGUE_ENGINE_CLI="$TMP/fugue-engine"
export FUGUE_LOOP_CALLS="$TMP/loop-calls.txt"

# shellcheck source=/dev/null
. "$HERE/fuguectl-testlib.sh"

cat > "$FUGUE_ENGINE_CLI" <<'EOF'
const fs = require('node:fs');

fs.appendFileSync(process.env.FUGUE_LOOP_CALLS, `${process.argv.slice(2).join(' ')}\n`);
const args = process.argv.slice(2);
if (args[0] !== 'loop') {
  console.error('expected loop root command');
  process.exit(2);
}
const cacheIndex = args.indexOf('--cache');
if (cacheIndex === -1 || !args[cacheIndex + 1]) {
  console.error('missing --cache');
  process.exit(2);
}
process.exit(0);
EOF
chmod +x "$FUGUE_ENGINE_CLI"

echo "fuguectl-loop tests"

bash "$LOOP" init --max 3 --best-sha sha0 >/dev/null
ok "loop shim injects cache root" 'grep -q "^loop --cache $FUGUE_CACHE init --max 3 --best-sha sha0$" "$FUGUE_LOOP_CALLS"'

bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 2 --ask-user 1 >/dev/null
ok "loop shim preserves record flags" 'grep -q "^loop --cache $FUGUE_CACHE record 1 --gate pass --verdict NEEDSFIX --findings 2 --ask-user 1$" "$FUGUE_LOOP_CALLS"'

bash "$LOOP" decide >/dev/null
ok "loop shim forwards decide" 'grep -q "^loop --cache $FUGUE_CACHE decide$" "$FUGUE_LOOP_CALLS"'

help="$(bash "$LOOP" --help)"
ok "help prints loop commands" 'echo "$help" | grep -q "record <round>"'
ok "help does not call engine" '[ "$(grep -c . "$FUGUE_LOOP_CALLS")" -eq 3 ]'

tdone
