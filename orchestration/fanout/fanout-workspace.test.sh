#!/usr/bin/env bash
# fanout-workspace.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$HERE/fanout-workspace.sh"
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-workspace tests"

ok "list shows >=6 stations" '[ "$(bash "$W" list | grep -c .)" -ge 6 ]'
ok "list includes code/review/main" 'o=$(bash "$W" list); grep -q code <<<"$o" && grep -q review <<<"$o" && grep -q main <<<"$o"'

ok "show code has models field" 'bash "$W" show code | grep -q "^models:"'

# model: @bench:code → resolved via allocation to minimax,...
ok "model code → bench resolves to minimax" 'bash "$W" model code | grep -q minimax'
ok "model review → coder" '[ "$(bash "$W" model review)" = "coder" ]'

# context: all five layers present (Zleap format)
ctx="$(bash "$W" context code)"
for sec in "System Prompt" "Workspace Prompt" "### Tools" "### Memory" "### History"; do
  ok "context has [$sec]" 'echo "$ctx" | grep -q "$sec"'
done
ok "context carries global no-Gemini rule" 'echo "$ctx" | grep -q "Do not call Gemini"'
ok "context code exposes only this station tools(incl edit)" 'echo "$ctx" | grep -q "edit"'

# --task injection (capture then here-string grep, avoids pipefail+grep -q SIGPIPE)
ok "context --task injects task" 'o=$(bash "$W" context code --task "doX"); grep -q "doX" <<<"$o"'

bash "$W" context nope >/dev/null 2>&1; ok "unknown workspace → non-0" '[ "$?" -ne 0 ]'
o=$(bash "$W" 2>&1); ok "no subcommand → shows help(incl list)" 'grep -q list <<<"$o"'

tdone
