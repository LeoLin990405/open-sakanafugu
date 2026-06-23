#!/usr/bin/env bash
# fanout-cache.test.sh — self-test for fanout-cache.sh (CI / local)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/fanout-cache.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FANOUT_CACHE="$TMP/cache"
cd "$TMP" || exit 1

# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-cache tests"

# prepare 3 fake artifacts
echo "r1" > a.md; echo "r2" > b.md; echo "r3" > c.md

# init: declare 3 tasks this round
bash "$CACHE" init 1 t1:cc-deepseek t2:cc-glm t3:agy >/dev/null
ok "init writes manifest 3 lines" '[ "$(wc -l <"$FANOUT_CACHE/round-1/manifest.tsv")" -eq 3 ]'

# barrier at 0/3 must fail (not allowed into next round)
bash "$CACHE" barrier 1 >/dev/null 2>&1; ok "barrier 0/3 → non-0 exit" '[ "$?" -ne 0 ]'

# put two
bash "$CACHE" put 1 t1 a.md >/dev/null
bash "$CACHE" put 1 t2 b.md >/dev/null
ok "result lands in cache after put" '[ -f "$FANOUT_CACHE/round-1/t1.result" ]'

# barrier at 2/3 still fails
bash "$CACHE" barrier 1 >/dev/null 2>&1; ok "barrier 2/3 → still non-0 (N!=N)" '[ "$?" -ne 0 ]'

# reject task not in manifest
bash "$CACHE" put 1 t9 c.md >/dev/null 2>&1; ok "put undeclared task t9 → rejected" '[ "$?" -ne 0 ]'

# 3rd uses fail (failure also counts as "returned")
bash "$CACHE" fail 1 t3 "agy timeout" >/dev/null
bash "$CACHE" barrier 1 >/dev/null 2>&1; ok "barrier 3/3 (incl 1 fail) → 0 exit, may proceed to next round" '[ "$?" -eq 0 ]'

# --require-success with a fail must block
bash "$CACHE" barrier 1 --require-success >/dev/null 2>&1; ok "barrier --require-success with fail → non-0" '[ "$?" -ne 0 ]'

# collect emits only done results (t1,t2; t3 is fail with no result)
ok "collect outputs 2 result paths" '[ "$(bash "$CACHE" collect 1 | grep -c .)" -eq 2 ]'

# status counts correct
ok "status done=2 fail=1" 'bash "$CACHE" status 1 | grep -q "done=2 fail=1"'

# all-done round → --require-success passes
bash "$CACHE" init 2 x:cc-mimo >/dev/null
bash "$CACHE" put 2 x a.md >/dev/null
bash "$CACHE" barrier 2 --require-success >/dev/null 2>&1; ok "all-done round --require-success → 0" '[ "$?" -eq 0 ]'

tdone
