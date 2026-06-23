#!/usr/bin/env bash
# fanout-loop.sh — Phase 5 review-fix loop state machine (turns SKILL.md pseudocode into runnable+testable)
#
# Logic contract (loop engineering v2): bounded review-fix, three exit states, never hard-mark DONE.
#   Each round: deterministic gate(build/test/lint) → reviewer VERDICT → keep-best → exit-state decision.
#   Record every round, decide next step, keep-best auto-maintained (worse findings do not update best baseline).
#
# State layout (${FANOUT_CACHE:-<repo>/.fanout-cache}/loop/):
#   meta        key=value: max_rounds / task_file / best_sha / best_n
#   rounds.tsv  one round per line: round<TAB>gate<TAB>verdict<TAB>findings<TAB>same_class<TAB>sha<TAB>note
#
# Subcommands:
#   init  [--max N] [--task F] [--best-sha SHA] [--best-n N]   open loop, record baseline (reset)
#   record <round> --gate pass|fail --verdict ACCEPTED|NEEDSFIX --findings N
#          [--ask-user K] [--sha SHA] [--same-class] [--note "..."]   record one round + auto-maintain keep-best
#          (--ask-user K = of N findings, count that touch intent/need human judgment; rest treated as mechanical auto-fixable)
#   decide                                                      read history to decide exit state (see below), print token+advice
#   next                                                        alias of decide
#   status                                                      print full loop overview + best baseline
#   ''                                                          help
#
# decide output (stdout first line = decision token):
#   DONE              latest ACCEPTED and cumulative ≥2 ACCEPTED (2 independent confirmations) → finish DONE   (exit 0)
#   CONFIRM           latest first ACCEPTED → run 1 more independent confirmation pass               (exit 10)
#   CONTINUE          NEEDS FIX and findings all mechanical → operator Edit-patch + next round     (exit 10)
#   ASK_USER          NEEDS FIX and this round has intent-touching findings → escalate those to human, auto-fix mechanical ones (exit 11)
#   ESCALATE_MAX      round ≥ max still NEEDS FIX → stop, escalate (best diff + remaining issues)   (exit 20)
#   ESCALATE_NONCONV  two consecutive rounds same-class/findings not decreasing → meta-reflect then escalate           (exit 20)
#
# Exit codes: 0=DONE / 10=auto-work(CONTINUE|CONFIRM) / 11=need human judgment(ASK_USER) / 20=escalate(ESCALATE_*) / 2=usage error
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"

CACHE_ROOT="$(fx_cache_root)"
LDIR="$CACHE_ROOT/loop"
META="$LDIR/meta"
ROUNDS="$LDIR/rounds.tsv"

meta_get(){ sed -n "s/^$1=//p" "$META" 2>/dev/null | head -1; }
meta_set(){ # key value — atomic single-line rewrite
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  { grep -v "^$k=" "$META" 2>/dev/null; printf '%s=%s\n' "$k" "$v"; } > "$tmp"
  mv -f "$tmp" "$META"
}
need_init(){ [ -f "$META" ] || die "loop not init (run fanout loop init first)"; }

cmd_init(){
  local max=3 task="" bsha="" bn=-1
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --max)      max="${2:-}"; shift 2;;
      --task)     task="${2:-}"; shift 2;;
      --best-sha) bsha="${2:-}"; shift 2;;
      --best-n)   bn="${2:-}"; shift 2;;
      *) die "unknown argument '$1'";;
    esac
  done
  [ "$max" -ge 1 ] 2>/dev/null || die "--max needs integer ≥1"
  rm -rf "$LDIR"; mkdir -p "$LDIR"
  : > "$ROUNDS"
  { printf 'max_rounds=%s\n' "$max"
    printf 'task_file=%s\n'  "$task"
    printf 'best_sha=%s\n'   "$bsha"
    printf 'best_n=%s\n'     "$bn"; } > "$META"
  echo "✓ loop init: max=$max best_sha=${bsha:-(unset)} best_n=$bn"
}

cmd_record(){
  need_init
  local round="${1:-}"; shift || true
  [ -n "$round" ] && [ "$round" -ge 1 ] 2>/dev/null || die "usage: record <round≥1> --gate .. --verdict .. --findings N"
  local gate="" verdict="" findings="" ask=0 sha="" same=0 note=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --gate)       gate="${2:-}"; shift 2;;
      --verdict)    verdict="${2:-}"; shift 2;;
      --findings)   findings="${2:-}"; shift 2;;
      --ask-user)   ask="${2:-}"; shift 2;;
      --sha)        sha="${2:-}"; shift 2;;
      --same-class) same=1; shift;;
      --note)       note="${2:-}"; shift 2;;
      *) die "unknown argument '$1'";;
    esac
  done
  case "$gate"    in pass|fail) ;; *) die "--gate must be pass|fail";; esac
  # verdict normalize: ACCEPTED / NEEDSFIX
  case "$(printf '%s' "$verdict" | tr 'a-z ' 'A-Z_')" in
    ACCEPTED|ACCEPT)            verdict=ACCEPTED;;
    NEEDSFIX|NEEDS_FIX|NEEDS)   verdict=NEEDSFIX;;
    *) die "--verdict must be ACCEPTED|NEEDSFIX";;
  esac
  [ -n "$findings" ] && [ "$findings" -ge 0 ] 2>/dev/null || die "--findings must be integer ≥0"
  # --ask-user K = of these N findings, count needing human judgment(touch intent); rest treated as mechanical auto-fixable (borrowed from no-mistakes)
  [ "$ask" -ge 0 ] 2>/dev/null || die "--ask-user must be integer ≥0"
  [ "$ask" -le "$findings" ] 2>/dev/null || die "--ask-user($ask) cannot be > --findings($findings)"

  # keep-best: best_n<0 = unset → first record is baseline; smaller findings → update best; else keep old best
  local bn bsha kept="kept"; bn="$(meta_get best_n)"; bsha="$(meta_get best_sha)"
  if [ "$bn" -lt 0 ] 2>/dev/null || [ "$findings" -lt "$bn" ] 2>/dev/null; then
    meta_set best_n "$findings"; [ -n "$sha" ] && meta_set best_sha "$sha"; kept="updated"
  fi

  # column order: round gate verdict findings ask_user same_class sha note
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$round" "$gate" "$verdict" "$findings" "$ask" "$same" "$sha" "$note" >> "$ROUNDS"
  local nbn nbsha; nbn="$(meta_get best_n)"; nbsha="$(meta_get best_sha)"
  echo "✓ round $round: gate=$gate verdict=$verdict findings=$findings ask-user=$ask (best $kept → n=$nbn sha=${nbsha:-—})"
  if [ "$kept" = "kept" ] && [ "$verdict" = NEEDSFIX ] && [ "$findings" -gt "$nbn" ] 2>/dev/null; then
    echo "  ⚠ this round worse than best (findings $findings > best $nbn) → consider git reset --hard ${nbsha:-<best_sha>} (keep-best rollback)"
  fi
}

cmd_decide(){
  need_init
  [ -s "$ROUNDS" ] || die "no round recorded yet"
  local max nrounds; max="$(meta_get max_rounds)"; nrounds="$(grep -c . "$ROUNDS")"
  local last_round last_verdict last_find last_ask last_same prev_find prev_same
  IFS=$'\t' read -r last_round _ last_verdict last_find last_ask last_same _ _ < <(tail -1 "$ROUNDS")
  local acc; acc="$(cut -f3 "$ROUNDS" | grep -c '^ACCEPTED$')"
  local bsha bn; bsha="$(meta_get best_sha)"; bn="$(meta_get best_n)"

  emit(){ echo "$1"; printf 'round %s/%s | last verdict=%s findings=%s | best n=%s sha=%s\n' \
            "$last_round" "$max" "$last_verdict" "$last_find" "$bn" "${bsha:-—}"; echo "→ $2"; }

  if [ "$last_verdict" = ACCEPTED ]; then
    if [ "$acc" -ge 2 ]; then
      emit DONE "second independent confirmation passed → finish: mark TASK DONE+Completed, push/deliver"; exit 0
    fi
    emit CONFIRM "first ACCEPTED → run 1 more independent confirmation review pass (verification is probabilistic); only DONE if still ACCEPTED"; exit 10
  fi

  # last == NEEDSFIX
  if [ "$last_round" -ge "$max" ] 2>/dev/null; then
    emit ESCALATE_MAX "reached cap still NEEDS FIX → stop and escalate: post best diff(sha ${bsha:-—}) + remaining findings + your judgment"; exit 20
  fi
  # non-convergence: explicit same-class, or two consecutive rounds with findings both >0 and not decreasing
  local nonconv=0
  if [ "$last_same" = 1 ]; then nonconv=1
  elif [ "$nrounds" -ge 2 ]; then
    IFS=$'\t' read -r _ _ _ prev_find _ prev_same _ _ < <(tail -2 "$ROUNDS" | head -1)
    [ "$prev_find" -gt 0 ] 2>/dev/null && [ "$last_find" -gt 0 ] 2>/dev/null \
      && [ "$last_find" -ge "$prev_find" ] 2>/dev/null && nonconv=1
  fi
  if [ "$nonconv" -eq 1 ]; then
    emit ESCALATE_NONCONV "two consecutive rounds same-class/not decreasing → first meta-reflect(reviewer too strict? requirement unclear? change implementation? fix→break thrashing?) for a diagnosis, then escalate"; exit 20
  fi
  # finding split(borrowed from no-mistakes): this round has findings needing human judgment(touch intent) → pause and ask human, do not let Claude auto-patch
  if [ "${last_ask:-0}" -gt 0 ] 2>/dev/null; then
    emit ASK_USER "this round $last_ask/$last_find findings touch intent(architecture/semantics/trade-off)→ first escalate these to human for approve/change/skip; the other $((last_find-last_ask)) mechanical ones Claude Edit-patches directly, then run next round"; exit 11
  fi
  emit CONTINUE "this round findings all mechanical → operator Edit-patch(no rollback to implementer for rewrite), commit, run next round $((last_round+1))"; exit 10
}

cmd_status(){
  need_init
  local max task bsha bn; max="$(meta_get max_rounds)"; task="$(meta_get task_file)"
  bsha="$(meta_get best_sha)"; bn="$(meta_get best_n)"
  echo "── fanout loop ── max=$max  best n=$bn sha=${bsha:-—}  task=${task:-—}"
  if [ -s "$ROUNDS" ]; then
    printf '  %-6s %-5s %-9s %-9s %-8s %s\n' round gate verdict findings ask-user note
    local r g v f au s sh n
    while IFS=$'\t' read -r r g v f au s sh n; do
      [ -n "$r" ] || continue
      [ "$s" = 1 ] && n="[same-class] $n"
      printf '  %-6s %-5s %-9s %-9s %-8s %s\n' "$r" "$g" "$v" "$f" "${au:-0}" "$n"
    done < "$ROUNDS"
  else echo "  (no round recorded yet)"; fi
}

sub="${1:-}"; shift || true
case "$sub" in
  init)        cmd_init   "$@";;
  record)      cmd_record "$@";;
  decide|next) cmd_decide "$@";;
  status)      cmd_status "$@";;
  ''|-h|--help) sed -n '2,30p' "$0";;
  *) die "unknown subcommand '$sub' (init|record|decide|next|status)";;
esac
