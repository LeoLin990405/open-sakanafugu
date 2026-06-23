#!/usr/bin/env bash
# fanout-plan.test.sh — stub ccb to test planning-panel dispatch
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P="$HERE/fanout-plan.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FANOUT_CACHE="$TMP/cache"
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

# stub ccb: record the agent called($2), consume stdin
printf '#!/usr/bin/env bash\necho "$2" >> "%s"\ncat >/dev/null\n' "$TMP/calls" > "$TMP/ccb"
chmod +x "$TMP/ccb"; export FANOUT_CCB="$TMP/ccb"

echo "fanout-plan tests"

out="$(bash "$P" "build a login feature" --models cc-a,cc-b)"
ok "dispatched to 2 specified models" '[ "$(grep -c . "$TMP/calls")" -eq 2 ]'
ok "calls include cc-a and cc-b" 'grep -q cc-a "$TMP/calls" && grep -q cc-b "$TMP/calls"'
ok "output lists plan file paths" 'echo "$out" | grep -q "cc-a.plan.md"'

: > "$TMP/calls"
bash "$P" "default models test" >/dev/null 2>&1
ok "default models = 3 families" '[ "$(grep -c . "$TMP/calls")" -eq 3 ]'

bash "$P" >/dev/null 2>&1; ok "no goal → non-0" '[ "$?" -ne 0 ]'

tdone
