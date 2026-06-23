#!/usr/bin/env bash
# fanout-dispatch.test.sh — test dispatch with FANOUT_CCB stub (don't touch real ccb)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$HERE/fanout-dispatch.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

# stub ccb: record argv + stdin to file
cat > "$TMP/ccb" <<EOF
#!/usr/bin/env bash
echo "ARGV: \$*" > "$TMP/called"
cat >> "$TMP/called"
EOF
chmod +x "$TMP/ccb"
export FANOUT_CCB="$TMP/ccb"
export FANOUT_ALLOCATION_LEDGER="$TMP/ledger.tsv"

echo "fanout-dispatch tests"

# template dispatch: stub should be called, agent + prompt correct
bash "$D" cc-deepseek --template impl --set ROLE=BACKEND-ROLE --set SCOPE=SCOPE-MARK --set FILES=a.py >/dev/null 2>&1
ok "ccb invoked" '[ -f "$TMP/called" ]'
ok "argv has agent + --compact + ask" 'grep -q "ARGV: ask cc-deepseek --compact" "$TMP/called"'
ok "prompt(rendered) passed via stdin" 'grep -q "BACKEND-ROLE" "$TMP/called" && grep -q "SCOPE-MARK" "$TMP/called"'

# --prompt-file
echo "custom prompt content" > "$TMP/p.md"
bash "$D" cc-glm --prompt-file "$TMP/p.md" >/dev/null 2>&1
ok "prompt-file content via stdin" 'grep -q "custom prompt content" "$TMP/called"'

# --task log
TASKF="$TMP/task.md"; printf '## Execution log\n' > "$TASKF"
bash "$D" cc-kimi --prompt-file "$TMP/p.md" --task "$TASKF" >/dev/null 2>&1
ok "--task appends dispatch log" 'grep -q "dispatch → cc-kimi" "$TASKF"'

# --harness codex (stub codex; target=model)
printf '#!/usr/bin/env bash\necho "ARGV: $*" > "%s"\n' "$TMP/codex.called" > "$TMP/codex"
chmod +x "$TMP/codex"; export FANOUT_CODEX="$TMP/codex"
bash "$D" gpt-5.5 --harness codex --prompt-file "$TMP/p.md" >/dev/null 2>&1
ok "codex harness → codex exec --model <model>" 'grep -q "ARGV: exec --model gpt-5.5" "$TMP/codex.called"'
ok "codex harness: prompt passed as arg" 'grep -q "custom prompt content" "$TMP/codex.called"'

# --harness opencode (stub opencode; target=provider/model)
printf '#!/usr/bin/env bash\necho "ARGV: $*" > "%s"\n' "$TMP/oc.called" > "$TMP/opencode"
chmod +x "$TMP/opencode"; export FANOUT_OPENCODE="$TMP/opencode"
bash "$D" doubao/doubao-code --harness opencode --prompt-file "$TMP/p.md" >/dev/null 2>&1
ok "opencode harness → opencode run -m <provider/model>" 'grep -q "ARGV: run -m doubao/doubao-code" "$TMP/oc.called"'

# --skills inject skill context into prompt
SK="$TMP/skills"; mkdir -p "$SK/inj-tool"
printf -- '---\nname: inj-tool\ndescription: INJECTED-SKILL-DESC for testing\n---\nbody\n' > "$SK/inj-tool/SKILL.md"
export FANOUT_SKILLS_ROOT="$SK" FANOUT_SKILLS_CATALOG="$TMP/skcat.tsv" FANOUT_SKILLS_NO_PLUGINS=1
bash "$D" cc-x --prompt-file "$TMP/p.md" --skills "inj-tool" >/dev/null 2>&1
ok "--skills injects skill desc into prompt(via stdin)" 'grep -q "INJECTED-SKILL-DESC" "$TMP/called"'
ok "--skills body still present after inject" 'grep -q "custom prompt content" "$TMP/called"'

# --task-type writes alloc ledger (data flywheel capture)
rm -f "$FANOUT_ALLOCATION_LEDGER"
bash "$D" cc-doubao --prompt-file "$TMP/p.md" --task-type code >/dev/null 2>&1
ok "--task-type appends (type,agent) into ledger" 'grep -qF "$(printf "code\tcc-doubao")" "$FANOUT_ALLOCATION_LEDGER"'
bash "$D" cc-glm --prompt-file "$TMP/p.md" >/dev/null 2>&1
ok "no --task-type does not write ledger (line count unchanged)" '[ "$(grep -c . "$FANOUT_ALLOCATION_LEDGER")" -eq 1 ]'

# unknown harness
bash "$D" x --harness bogus --prompt-file "$TMP/p.md" >/dev/null 2>&1; ok "unknown harness → non-0" '[ "$?" -ne 0 ]'

# bad usage
bash "$D" >/dev/null 2>&1; ok "no agent → non-0" '[ "$?" -ne 0 ]'
bash "$D" cc-x >/dev/null 2>&1; ok "no prompt source → non-0" '[ "$?" -ne 0 ]'

tdone
