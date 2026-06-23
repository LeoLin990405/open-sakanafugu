#!/usr/bin/env bash
# fanout-experience.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E="$HERE/fanout-experience.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FANOUT_EXPERIENCE="$TMP/exp"
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-experience tests"

# add via stdin
echo "use defensive copy(intervals[0][:]) to avoid mutating the input interval" | bash "$E" add code "defensive-copy-trick" >/dev/null
ok "add stored" '[ -f "$FANOUT_EXPERIENCE/code/defensive-copy-trick.md" ]'
ok "record has body" 'grep -q "defensive copy" "$FANOUT_EXPERIENCE/code/defensive-copy-trick.md"'
ok "record has frontmatter" 'grep -q "^workspace: code" "$FANOUT_EXPERIENCE/code/defensive-copy-trick.md"'

# redaction: body has plaintext key → reject (build fake key at runtime, no literal sk- in the file, avoids scan-secrets false positive)
FAKEKEY="sk-$(printf 'a%.0s' $(seq 25))"
echo "use this key $FAKEKEY" | bash "$E" add code "bad-experience" >/dev/null 2>&1
ok "has key → reject(non-0)" '[ "$?" -ne 0 ]'
ok "bad experience not stored" '[ ! -f "$FANOUT_EXPERIENCE/code/bad-experience.md" ]'

# list (capture to avoid SIGPIPE)
ok "list has title" 'o=$(bash "$E" list code); grep -q defensive-copy <<<"$o"'

# recall
out="$(bash "$E" recall code)"
ok "recall emits body" 'echo "$out" | grep -q "defensive copy"'
ok "recall has [experience] marker" 'echo "$out" | grep -q "\[experience\]"'
ok "recall drops frontmatter(no created:)" '! echo "$out" | grep -q "^created:"'

# empty ws → empty output, exit 0
ok "recall empty ws → empty" '[ -z "$(bash "$E" recall nonexistent)" ]'

# query filter
echo "qwen3 SQL last 30 days uses DATE_SUB(CURDATE(),INTERVAL 30 DAY)" | bash "$E" add sql "sql-date-window" >/dev/null
ok "recall --query hits" 'o=$(bash "$E" recall sql --query DATE_SUB); grep -q DATE_SUB <<<"$o"'

# show
ok "show prints record" 'o=$(bash "$E" show code defensive-copy-trick); grep -q "title: defensive-copy-trick" <<<"$o"'

# integration: workspace context injects this ws's experience (FANOUT_EXPERIENCE already exported)
ctx="$(bash "$HERE/fanout-workspace.sh" context code)"
ok "workspace context injects experience" 'echo "$ctx" | grep -q "defensive copy"'

tdone
