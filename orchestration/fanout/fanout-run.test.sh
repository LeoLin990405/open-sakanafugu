#!/usr/bin/env bash
# fanout-run.test.sh — run status facade: set/round/clear + aggregate JSON(cache+loop) + JSON validity
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="$HERE/fanout-run.sh"; CACHE="$HERE/fanout-cache.sh"; LOOP="$HERE/fanout-loop.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FANOUT_CACHE="$TMP/cache"
cd "$TMP" || exit 1
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"
js(){ bash "$R" status; }   # JSON

echo "fanout-run tests"

# no active run → status non-0
bash "$R" status >/dev/null 2>&1; ok "no active run → status non-0" '[ "$?" -ne 0 ]'
# set: no file → non-0
bash "$R" set --task /no/such/file >/dev/null 2>&1; ok "set no TASK file → non-0" '[ "$?" -ne 0 ]'

# create TASK + set
printf '# TASK-test\nStatus: IN_PROGRESS\n' > "$TMP/TASK.md"
bash "$R" set --task "$TMP/TASK.md" --round 2 >/dev/null
ok "set writes run.meta" '[ -f "$FANOUT_CACHE/run.meta" ]'
ok "status JSON has round 2" 'js | grep -q "\"round\": 2"'
ok "status JSON has task_status IN_PROGRESS" 'js | grep -q "IN_PROGRESS"'
ok "initialized=false when no cache/loop" 'js | grep -q "\"initialized\": false"'

# JSON must be valid (hard requirement for machine face)
ok "status output is valid JSON" 'js | python3 -c "import sys,json; json.load(sys.stdin)"'

# start cache round 2: declare 2 tasks, put 1 → pending=1, barrier open
echo r1 > "$TMP/a.md"
bash "$CACHE" init 2 t1:cc-deepseek t2:cc-glm >/dev/null
bash "$CACHE" put 2 t1 "$TMP/a.md" >/dev/null
ok "cache reflects: total=2" 'js | grep -q "\"total\": 2"'
ok "cache reflects: pending=1" 'js | grep -q "\"pending\": 1"'
ok "cache reflects: barrier open" 'js | grep -q "\"barrier\": \"open\""'
ok "next hints waiting on barrier" 'bash "$R" next | grep -q barrier'
ok "JSON still valid(incl cache)" 'js | python3 -c "import sys,json; json.load(sys.stdin)"'

# all collected → barrier passed
bash "$CACHE" fail 2 t2 "x" >/dev/null
ok "all returned → barrier passed" 'js | grep -q "\"barrier\": \"passed\""'

# loop: init + record NEEDSFIX → decision CONTINUE into JSON
bash "$LOOP" init --max 3 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 2 >/dev/null
ok "loop reflects: initialized true" 'js | grep -q "\"initialized\": true"'
ok "loop reflects: decision CONTINUE" 'js | grep -q "\"decision\": \"CONTINUE\""'
ok "JSON still valid(incl loop)" 'js | python3 -c "import sys,json; d=json.load(sys.stdin); assert d[\"loop\"][\"decision\"]==\"CONTINUE\""'

# --human summary
ok "--human has run/cache/loop/next" 'o="$(bash "$R" status --human)"; case "$o" in *run:*cache:*loop:*next:*) true;; *) false;; esac'

# round command updates
bash "$R" round 3 >/dev/null
ok "round 3 → JSON round 3" 'js | grep -q "\"round\": 3"'

# clear
bash "$R" clear >/dev/null
ok "no run.meta after clear" '[ ! -f "$FANOUT_CACHE/run.meta" ]'
bash "$R" next >/dev/null 2>&1; ok "next non-0 after clear" '[ "$?" -ne 0 ]'

# unknown subcommand
bash "$R" bogus >/dev/null 2>&1; ok "unknown subcommand → non-0" '[ "$?" -ne 0 ]'

tdone
