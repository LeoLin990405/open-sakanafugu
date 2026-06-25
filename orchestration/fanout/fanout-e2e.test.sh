#!/usr/bin/env bash
# fanout-e2e.test.sh — end-to-end integration: allocate → init → dispatch(stub) → put → barrier
#                      → resume → put again → barrier passes → summary → collect
# Proves the tools compose into a full lifecycle (without touching real ccb).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
F="$HERE/fanout"; FG="$HERE/fuguectl"; C="$HERE/fanout-cache.sh"; D="$HERE/fanout-dispatch.sh"; S="$HERE/fanout-summary.sh"; AL="$HERE/fanout-allocate.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FANOUT_CACHE="$TMP/cache"
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

# stub ccb (used by dispatch)
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/ccb"; chmod +x "$TMP/ccb"; export FANOUT_CCB="$TMP/ccb"
echo p > "$TMP/p.md"; echo r > "$TMP/r.md"

echo "fanout-e2e tests"

# 1) top-level help stays within the comment block
help_out="$(bash "$F" help)"
ok "help lists subcommands" 'echo "$help_out" | grep -q "fanout doctor"'
ok "help does not leak script body" '! echo "$help_out" | grep -q "set -uo pipefail"'
fuguectl_help_out="$(bash "$FG" help)"
ok "fuguectl alias lists subcommands" 'echo "$fuguectl_help_out" | grep -q "fuguectl doctor"'
fuguectl_ws_out="$(bash "$FG" workspace list)"
ok "fuguectl alias dispatches commands" 'grep -q "^  code" <<<"$fuguectl_ws_out"'

# 2) bench allocation decides the model
ok "allocate code → minimax" '[ "$(bash "$AL" code --top)" = "minimax" ]'

# 3) init this round's 3 tasks
bash "$C" init 1 t1:cc-minimax t2:cc-kimi t3:cc-glm >/dev/null
ok "init declares 3 tasks" '[ "$(wc -l <"$FANOUT_CACHE/round-1/manifest.tsv")" -eq 3 ]'

# 4) dispatch (stub ccb doesn't error)
bash "$D" cc-minimax --prompt-file "$TMP/p.md" >/dev/null 2>&1
ok "dispatch succeeds via stub" '[ "$?" -eq 0 ]'

# 5) put 2/3, barrier should block
bash "$C" put 1 t1 "$TMP/r.md" >/dev/null
bash "$C" put 1 t2 "$TMP/r.md" >/dev/null
bash "$C" barrier 1 >/dev/null 2>&1; ok "barrier 2/3 blocks" '[ "$?" -ne 0 ]'

# 6) resume lists only the un-returned t3
res="$(bash "$C" resume 1)"
ok "resume lists un-returned t3" 'echo "$res" | grep -q "^t3"'
ok "resume excludes returned t1/t2" '! echo "$res" | grep -qE "^t1|^t2"'

# 7) fill t3, barrier passes
bash "$C" put 1 t3 "$TMP/r.md" >/dev/null
bash "$C" barrier 1 >/dev/null 2>&1; ok "barrier 3/3 passes" '[ "$?" -eq 0 ]'
ok "resume is now empty" '[ -z "$(bash "$C" resume 1)" ]'

# 8) summary: elapsed + done=3
out="$(bash "$S" 1)"
ok "summary has elapsed" 'echo "$out" | grep -q "elapsed"'
ok "summary done=3" 'echo "$out" | grep -q "done=3"'

# 9) collect 3 results
ok "collect emits 3 results" '[ "$(bash "$C" collect 1 | grep -c .)" -eq 3 ]'

tdone
