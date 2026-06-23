#!/usr/bin/env bash
# fanout-cache.sh — fan-out result cache + fan-in barrier
#
# Logic contract: Claude Desktop(planner) issues N tasks this round, must collect N back (all cached)
#   before entering the next round. Each agent result lands in cache first, integrator reads only from cache.
#
# Cache layout (${FANOUT_CACHE:-<repo>/.fanout-cache}/round-<N>/):
#   manifest.tsv        immutable after init: each line "task_id<TAB>agent" = the N tasks declared this round
#   <task_id>.result    agent artifact landed by put (atomic)
#   <task_id>.status    "done" | "fail" (marker, concurrency-safe: each task touches only its own file)
#   <task_id>.reason    fail reason (optional)
#
# Subcommands:
#   init    <round> <task_id:agent> [...]   declare N tasks this round (reset that round)
#   put     <round> <task_id> <file>        store a task result + mark done (task must be in manifest)
#   fail    <round> <task_id> [reason]      mark a task failed (also counts as "returned")
#   status  <round>                         print done/fail/pending counts
#   barrier <round> [--wait [secs]] [--require-success]
#                                           exit 0 only when all N terminal; else exit 1
#   collect <round>                         output result paths of done tasks (for integrator)
#   list    <round>                         detail
#   resume  <round>                         print unreturned task_id<TAB>agent (after interrupt re-dispatch only these)
#
# Exit codes: 0 success / 1 barrier unmet or failed / 2 usage error
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"

CACHE_ROOT="$(fx_cache_root)"

rdir() { printf '%s/round-%s' "$CACHE_ROOT" "$1"; }

_manifest() { cat "$(rdir "$1")/manifest.tsv" 2>/dev/null; }
_ids()      { _manifest "$1" | cut -f1; }
_total()    { _manifest "$1" | grep -c . ; }
_terminal() { # count of terminal(done|fail) tasks
  local r="$1" n=0 id d; d="$(rdir "$1")"
  while IFS= read -r id; do [ -n "$id" ] && [ -f "$d/$id.status" ] && n=$((n+1)); done < <(_ids "$r")
  echo "$n"
}

cmd_init() {
  local round="$1"; shift || true
  [ -n "${round:-}" ] && [ "$#" -gt 0 ] || die "usage: init <round> <task_id:agent> [...]"
  local d; d="$(rdir "$round")"
  rm -rf "$d"; mkdir -p "$d"
  : > "$d/manifest.tsv"
  date +%s > "$d/.started"   # timing baseline
  local pair id agent
  for pair in "$@"; do
    id="${pair%%:*}"; agent="${pair#*:}"
    [ -n "$id" ] && [ "$id" != "$pair" ] || die "task format should be task_id:agent, got '$pair'"
    printf '%s\t%s\n' "$id" "$agent" >> "$d/manifest.tsv"
  done
  echo "✓ round-$round declared $# tasks: $*"
}

cmd_put() {
  local round="$1" id="$2" file="$3"
  [ -n "${round:-}" ] && [ -n "${id:-}" ] && [ -n "${file:-}" ] || die "usage: put <round> <task_id> <file>"
  local d; d="$(rdir "$round")"
  [ -f "$d/manifest.tsv" ] || die "round-$round not init"
  _ids "$round" | grep -qxF "$id" || die "task '$id' not in manifest (only tasks declared this round accepted)"
  [ -f "$file" ] || die "result file does not exist: $file"
  cp "$file" "$d/.$id.result.tmp" && mv -f "$d/.$id.result.tmp" "$d/$id.result"
  printf 'done\n' > "$d/$id.status"; date +%s > "$d/$id.at"
  echo "✓ cached $id ($(wc -c <"$d/$id.result" | tr -d ' ') bytes) [$(_terminal "$round")/$(_total "$round")]"
}

cmd_fail() {
  local round="$1" id="$2"; shift 2 || true
  [ -n "${round:-}" ] && [ -n "${id:-}" ] || die "usage: fail <round> <task_id> [reason]"
  local d; d="$(rdir "$round")"
  [ -f "$d/manifest.tsv" ] || die "round-$round not init"
  _ids "$round" | grep -qxF "$id" || die "task '$id' not in manifest"
  printf 'fail\n' > "$d/$id.status"; date +%s > "$d/$id.at"
  [ "$#" -gt 0 ] && printf '%s\n' "$*" > "$d/$id.reason"
  echo "✗ failed $id: ${*:-(no reason)} [$(_terminal "$round")/$(_total "$round")]"
}

cmd_status() {
  local round="$1"; [ -n "${round:-}" ] || die "usage: status <round>"
  local d; d="$(rdir "$round")"; [ -f "$d/manifest.tsv" ] || die "round-$round not init"
  local total nd fail id
  total="$(_total "$round")"; nd=0; fail=0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    case "$(cat "$d/$id.status" 2>/dev/null)" in
      done) nd=$((nd+1));; fail) fail=$((fail+1));;
    esac
  done < <(_ids "$round")
  echo "round-$round: total=$total done=$nd fail=$fail pending=$((total-nd-fail))"
}

cmd_barrier() {
  local round="$1"; shift || true
  [ -n "${round:-}" ] || die "usage: barrier <round> [--wait [secs]] [--require-success]"
  local wait=0 timeout=300 require_success=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --wait) wait=1; case "${2:-}" in ''|--*) ;; *) timeout="$2"; shift;; esac;;
      --require-success) require_success=1;;
      *) die "unknown arg $1";;
    esac; shift
  done
  local d; d="$(rdir "$round")"; [ -f "$d/manifest.tsv" ] || die "round-$round not init"

  local total elapsed=0
  total="$(_total "$round")"
  [ "$total" -gt 0 ] || die "round-$round manifest is empty"
  while :; do
    local term; term="$(_terminal "$round")"
    if [ "$term" -ge "$total" ]; then
      if [ "$require_success" -eq 1 ]; then
        local nfail; nfail="$(grep -rl '^fail' "$d"/*.status 2>/dev/null | wc -l | tr -d ' ')"
        if [ "$nfail" -gt 0 ]; then
          echo "✗ barrier round-$round: $total/$total returned, but $nfail failed (--require-success)"; return 1
        fi
      fi
      echo "✓ barrier round-$round: $total/$total all returned → may enter next round"; return 0
    fi
    if [ "$wait" -eq 0 ]; then
      echo "✗ barrier round-$round: only $term/$total returned, unmet → not allowed into next round"; cmd_status "$round" >&2; return 1
    fi
    [ "$elapsed" -ge "$timeout" ] && { echo "✗ barrier round-$round: waited ${timeout}s timeout, $term/$total" >&2; return 1; }
    sleep 3; elapsed=$((elapsed+3))
  done
}

cmd_collect() {
  local round="$1"; [ -n "${round:-}" ] || die "usage: collect <round>"
  local d id; d="$(rdir "$round")"; [ -f "$d/manifest.tsv" ] || die "round-$round not init"
  while IFS= read -r id; do
    [ -n "$id" ] && [ -f "$d/$id.result" ] && printf '%s\n' "$d/$id.result"
  done < <(_ids "$round")
}

cmd_list() {
  local round="$1"; [ -n "${round:-}" ] || die "usage: list <round>"
  local d id agent st; d="$(rdir "$round")"; [ -f "$d/manifest.tsv" ] || die "round-$round not init"
  while IFS=$'\t' read -r id agent; do
    [ -n "$id" ] || continue
    st="$(cat "$d/$id.status" 2>/dev/null || echo pending)"
    printf '  %-22s %-14s %s\n' "$id" "$agent" "$st"
  done < "$d/manifest.tsv"
}

# resume: print non-terminal(unreturned) task_id<TAB>agent —— after interrupt re-dispatch only these, not rerun all
cmd_resume() {
  local round="$1"; [ -n "${round:-}" ] || die "usage: resume <round>"
  local d id agent; d="$(rdir "$round")"; [ -f "$d/manifest.tsv" ] || die "round-$round not init"
  while IFS=$'\t' read -r id agent; do
    [ -n "$id" ] || continue
    [ -f "$d/$id.status" ] || printf '%s\t%s\n' "$id" "$agent"
  done < "$d/manifest.tsv"
}

sub="${1:-}"; shift || true
case "$sub" in
  init)    cmd_init    "$@";;
  put)     cmd_put     "$@";;
  fail)    cmd_fail    "$@";;
  status)  cmd_status  "$@";;
  barrier) cmd_barrier "$@";;
  collect) cmd_collect "$@";;
  list)    cmd_list    "$@";;
  resume)  cmd_resume  "$@";;
  ''|-h|--help) sed -n '2,34p' "$0";;
  *) die "unknown subcommand '$sub' (init|put|fail|status|barrier|collect|list|resume)";;
esac
