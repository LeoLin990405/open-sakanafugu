#!/usr/bin/env bash
# fanout-task.sh — TASK file scaffold + log + close-out (replaces hand-copying the TASK template)
#
#   new  "<title>" [P0|P1|P2]     create TASK-<date>-<NNN>.md under $TASKS, print path
#   log  <task-file> "<message>"  append timestamped log to the "Log" section
#   done <task-file>              Status: DONE + Completed time
#   env: TASKS = task directory (default ~/.claude/tasks)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
TASKS="${TASKS:-$HOME/.claude/tasks}"
ts(){  TZ="${FANOUT_TZ:-Asia/Shanghai}" date '+%Y-%m-%d %H:%M'; }
day(){ TZ="${FANOUT_TZ:-Asia/Shanghai}" date '+%Y-%m-%d'; }
sed_inplace(){ # across GNU/BSD sed
  if sed --version >/dev/null 2>&1; then sed -i -E "$1" "$2"; else sed -i '' -E "$1" "$2"; fi
}

cmd_new(){
  local title="${1:-}" prio="${2:-P1}"
  [ -n "$title" ] || die "usage: new <title> [P0|P1|P2]"
  mkdir -p "$TASKS"
  local d n=1 f; d="$(day)"
  while :; do f="$TASKS/TASK-$d-$(printf '%03d' "$n").md"; [ -e "$f" ] || break; n=$((n+1)); done
  {
    echo "# TASK-$d-$(printf '%03d' "$n"): $title"
    echo "Status: IN_PROGRESS"
    echo "Priority: $prio"
    echo "Created: $(ts)"
    echo "Completed: -"
    echo ""
    echo "## Requirements"
    echo "$title"
    echo ""
    echo "## Subtasks"
    echo "- [ ] (task1) — <scope> (Implementer: cc-xxx, file: ...)"
    echo "- [ ] Final Review (Reviewer: coder)"
    echo ""
    echo "## Matrix"
    echo "| Task | Implementer | Reviewer | Fixer |"
    echo "|---|---|---|---|"
    echo "| 1 | cc-xxx | coder | operator Edit patch |"
    echo ""
    echo "## Output files"
    echo "- ..."
    echo ""
    echo "## Log"
  } > "$f"
  echo "$f"
}

cmd_log(){
  local f="${1:-}"; shift || true
  [ -n "$f" ] && [ -f "$f" ] || die "no TASK file: ${f:-(empty)}"
  printf -- '- [%s] %s\n' "$(ts)" "$*" >> "$f"
  echo "logged → $f"
}

cmd_done(){
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] || die "no TASK file: ${f:-(empty)}"
  sed_inplace "s/^Status: .*/Status: DONE/" "$f"
  sed_inplace "s/^Completed: .*/Completed: $(ts)/" "$f"
  echo "DONE → $f"
}

sub="${1:-}"; shift || true
case "$sub" in
  new)  cmd_new  "$@";;
  log)  cmd_log  "$@";;
  done) cmd_done "$@";;
  ''|-h|--help) sed -n '2,9p' "$0";;
  *) die "unknown subcommand '$sub' (new|log|done)";;
esac
