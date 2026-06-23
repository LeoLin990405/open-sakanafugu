#!/usr/bin/env bash
# fanout-summary.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/fanout-summary.sh"; C="$HERE/fanout-cache.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FANOUT_CACHE="$TMP/cache"
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-summary tests"
echo r > "$TMP/a.md"

bash "$C" init 1 t1:cc-deepseek t2:cc-glm >/dev/null
bash "$C" put 1 t1 "$TMP/a.md" >/dev/null
bash "$C" fail 1 t2 "timeout" >/dev/null

out="$(bash "$S" 1)"
ok "summary has Round 1 title" 'echo "$out" | grep -q "Round 1 summary"'
ok "summary has counts done=1 fail=1" 'echo "$out" | grep -q "done=1 fail=1"'
ok "summary lists task detail" 'echo "$out" | grep -q "t1" && echo "$out" | grep -q "cc-glm"'

# --task write
TASKF="$TMP/task.md"; printf '## Log\n' > "$TASKF"
bash "$S" 1 --task "$TASKF" >/dev/null 2>&1
ok "--task writes summary into file" 'grep -q "Round 1 summary" "$TASKF"'

# round not init → non-0
bash "$S" 9 >/dev/null 2>&1; ok "round not init → non-0" '[ "$?" -ne 0 ]'

tdone
