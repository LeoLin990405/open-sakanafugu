#!/usr/bin/env bash
# fanout-task.test.sh — self-test for fanout-task.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$HERE/fanout-task.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export TASKS="$TMP/tasks"

# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-task tests"

F="$(bash "$T" new "test task title" P0)"
ok "new returns path and file exists" '[ -f "$F" ]'
ok "new filename like TASK-<date>-NNN.md" 'echo "$F" | grep -qE "TASK-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}\.md$"'
ok "Status: IN_PROGRESS" 'grep -q "^Status: IN_PROGRESS" "$F"'
ok "Priority written P0" 'grep -q "^Priority: P0" "$F"'
ok "title goes into title line" 'grep -q "test task title" "$F"'
ok "has Log section" 'grep -q "^## Log" "$F"'

# second new should increment the number (no overwrite)
F2="$(bash "$T" new "second" )"
ok "second new different file" '[ "$F" != "$F2" ]'

bash "$T" log "$F" "first log entry" >/dev/null
ok "log appends to file" 'grep -q "first log entry" "$F"'
ok "log has timestamp" 'grep -qE "^- \[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}\] first log entry" "$F"'

bash "$T" "done" "$F" >/dev/null
ok "done → Status: DONE" 'grep -q "^Status: DONE" "$F"'
ok "done wrote Completed time" 'grep -qE "^Completed: [0-9]{4}-" "$F"'
ok "done no longer IN_PROGRESS" '! grep -q "^Status: IN_PROGRESS" "$F"'

# misuse
bash "$T" new >/dev/null 2>&1; ok "new without title → non-0 exit" '[ "$?" -ne 0 ]'
bash "$T" log /no/such/file x >/dev/null 2>&1; ok "log nonexistent file → non-0" '[ "$?" -ne 0 ]'

tdone
