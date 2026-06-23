#!/usr/bin/env bash
# fanout-run.sh — cross-phase run status facade (axi-inspired: structured, machine-parsable read-only view)
#
# fanout's TASK / cache(barrier) / loop state is normally scattered across places, kept in the operator's head.
# This tool introduces a lightweight 'current run' context (.fanout-cache/run.meta records active TASK + round),
# aggregating cross-phase state into **one JSON object** —— so a fan-out run can be structurally queried/resumed/driven
# (borrowing no-mistakes' axi idea, but without changing fanout's 'operator is orchestrator' model, just a read-only facade).
#
#   set --task <file> [--round N]   declare/update current run (active TASK + round, round defaults to 1)
#   round <N>                       update round only (bump per round)
#   status [--human]                aggregate status → default JSON (machine face); --human = one-line human summary
#   next                            print next-action hint only (one line)
#   clear                           clear current run context
#
# Exit codes: 0 ok / 1 no active run(for status/next) / 2 usage error
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_ROOT="$(fx_cache_root)"
RUN="$CACHE_ROOT/run.meta"
CACHE_SH="$HERE/fanout-cache.sh"
LOOP_SH="$HERE/fanout-loop.sh"
LOOP_DIR="$CACHE_ROOT/loop"
esc(){ printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
rget(){ sed -n "s/^$1=//p" "$RUN" 2>/dev/null | head -1; }

cmd_set(){
  local task="" round=1
  while [ "$#" -gt 0 ]; do case "$1" in
    --task)  task="${2:-}"; shift 2;;
    --round) round="${2:-}"; shift 2;;
    *) die "unknown arg '$1'";; esac
  done
  [ -n "$task" ] || die "usage: set --task <file> [--round N]"
  [ -f "$task" ] || die "no TASK file: $task"
  [ "$round" -ge 1 ] 2>/dev/null || die "--round must be ≥1"
  mkdir -p "$CACHE_ROOT"
  { printf 'task=%s\n' "$task"; printf 'round=%s\n' "$round"; } > "$RUN"
  echo "✓ active run: task=$task round=$round"
}

cmd_round(){
  local n="${1:-}"; [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null || die "usage: round <N≥1>"
  [ -f "$RUN" ] || die "no active run (first fanout run set --task ...)"
  local t; t="$(rget task)"
  { printf 'task=%s\n' "$t"; printf 'round=%s\n' "$n"; } > "$RUN"
  echo "✓ round → $n"
}

# aggregate → set globals: TASK_STATUS / C_* (cache) / L_* (loop) / NEXT
_gather(){
  [ -f "$RUN" ] || return 1
  TASK="$(rget task)"; ROUND="$(rget round)"; ROUND="${ROUND:-1}"
  TASK_STATUS="$(sed -n 's/^Status:[[:space:]]*//p' "$TASK" 2>/dev/null | head -1)"

  # cache(barrier) state — parse stable output of fanout-cache status
  C_INIT=false; C_TOTAL=0; C_DONE=0; C_FAIL=0; C_PEND=0; C_BARRIER=null
  local cs; cs="$(bash "$CACHE_SH" status "$ROUND" 2>/dev/null)"
  if [ -n "$cs" ]; then
    C_INIT=true
    C_TOTAL="$(printf '%s' "$cs" | sed -n 's/.*total=\([0-9]*\).*/\1/p')"
    C_DONE="$(printf '%s' "$cs"  | sed -n 's/.*done=\([0-9]*\).*/\1/p')"
    C_FAIL="$(printf '%s' "$cs"  | sed -n 's/.*fail=\([0-9]*\).*/\1/p')"
    C_PEND="$(printf '%s' "$cs"  | sed -n 's/.*pending=\([0-9]*\).*/\1/p')"
    [ "${C_PEND:-1}" -eq 0 ] 2>/dev/null && C_BARRIER='"passed"' || C_BARRIER='"open"'
  fi

  # loop state — read meta directly + decide gets decision token
  L_INIT=false; L_MAX=null; L_ROUNDS=0; L_BEST_N=null; L_BEST_SHA=null; L_DEC=null
  if [ -f "$LOOP_DIR/meta" ]; then
    L_INIT=true
    L_MAX="$(sed -n 's/^max_rounds=//p' "$LOOP_DIR/meta" | head -1)"; L_MAX="${L_MAX:-null}"
    L_BEST_N="$(sed -n 's/^best_n=//p' "$LOOP_DIR/meta" | head -1)"; L_BEST_N="${L_BEST_N:-null}"
    local bs; bs="$(sed -n 's/^best_sha=//p' "$LOOP_DIR/meta" | head -1)"
    [ -n "$bs" ] && L_BEST_SHA="\"$(esc "$bs")\""
    [ -f "$LOOP_DIR/rounds.tsv" ] && L_ROUNDS="$(grep -c . "$LOOP_DIR/rounds.tsv" 2>/dev/null || echo 0)"
    local d; d="$(bash "$LOOP_SH" decide 2>/dev/null | head -1)"
    [ -n "$d" ] && L_DEC="\"$d\""
  fi

  # next-action hint
  if [ "$C_INIT" = true ] && [ "${C_PEND:-0}" -gt 0 ] 2>/dev/null; then
    NEXT="cache barrier: waiting on $C_DONE+$C_FAIL/$C_TOTAL returned (still need $C_PEND) — do not enter Integrate"
  elif [ "$L_DEC" != null ]; then
    NEXT="loop: ${L_DEC//\"/} — see fanout loop decide"
  elif [ "$C_INIT" = true ]; then
    NEXT="cache barrier passed ($C_TOTAL/$C_TOTAL) — may Integrate"
  else
    NEXT="run declared; no cache/loop state yet — start round / dispatch"
  fi
}

cmd_status(){
  local human=0; [ "${1:-}" = "--human" ] && human=1
  _gather || die "no active run (first fanout run set --task ...)"
  if [ "$human" -eq 1 ]; then
    echo "-- run: $(basename "$TASK") | round $ROUND | ${TASK_STATUS:-?} --"
    echo "  cache:  init=$C_INIT total=$C_TOTAL done=$C_DONE fail=$C_FAIL pending=$C_PEND barrier=${C_BARRIER//\"/}"
    echo "  loop:   init=$L_INIT max=$L_MAX rounds=$L_ROUNDS best_n=$L_BEST_N decision=${L_DEC//\"/}"
    echo "  next:   $NEXT"
    return 0
  fi
  cat <<JSON
{
  "task": "$(esc "$TASK")",
  "task_status": $( [ -n "$TASK_STATUS" ] && printf '"%s"' "$(esc "$TASK_STATUS")" || printf null ),
  "round": $ROUND,
  "cache": { "initialized": $C_INIT, "total": $C_TOTAL, "done": $C_DONE, "fail": $C_FAIL, "pending": $C_PEND, "barrier": $C_BARRIER },
  "loop": { "initialized": $L_INIT, "max": $L_MAX, "rounds": $L_ROUNDS, "best_n": $L_BEST_N, "best_sha": $L_BEST_SHA, "decision": $L_DEC },
  "next": "$(esc "$NEXT")"
}
JSON
}

cmd_next(){ _gather || die "no active run (first fanout run set --task ...)"; echo "$NEXT"; }

cmd_clear(){ rm -f "$RUN" && echo "✓ cleared current run context"; }

sub="${1:-}"; shift || true
case "$sub" in
  set)    cmd_set    "$@";;
  round)  cmd_round  "$@";;
  status) cmd_status "$@";;
  next)   cmd_next   "$@";;
  clear)  cmd_clear  "$@";;
  ''|-h|--help) sed -n '2,20p' "$0";;
  *) die "unknown subcommand '$sub' (set|round|status|next|clear)";;
esac
