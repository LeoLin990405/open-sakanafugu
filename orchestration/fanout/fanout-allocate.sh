#!/usr/bin/env bash
# fanout-allocate.sh — task type → recommended model (bench prior + real-world experience Bayesian mix)
#
# Static bench table (allocation.tsv) acts as Beta prior; real-world record success/fail does posterior update.
# **Cold start (no record) = exactly equals bench order**; only after many runs does it drift by real-world win rate ([[model_task_allocation_bench]]).
# Beta-Bernoulli: each agent prior p0 set by bench rank (top high, lower-ranked low, unlisted low baseline 0.15),
# pseudo-count KAPPA controls "how many real samples to override bench" (default 4 → drift starts after a few runs). Laplace smoothing (+1/+1)
# ensures no agent is permanently starved by one failure (exploration floor). Borrows TRINITY's learned coordination, but needs no training.
#
#   <task-type> [--top] [--sample]         ranked models (--top = top pick only; --sample = Thompson Sampling exploration)
#   list                                   print full static bench table (excludes real-world)
#   record <task-type> <agent> <ok|fail>   record one real-world result (win/loss) → feed posterior
#   feed   type:agent:result [...]         batch record (feed many at once) — convenient inlet for the data flywheel
#   feed   --from-ledger --result ok|fail [--fail a,b] [--ok a,b] [--keep]
#          read (type,agent) from round ledger written by dispatch --task-type, default result for whole round,
#          override individual agents with --fail/--ok; clear ledger after recording (--keep retains). Auto-feeds verdict back into routing.
#   stats  <task-type>                     view each agent's score / samples (s/f) / prior for this type
#   reset  [<task-type>]                   clear real-world stats (all or single type)
#   decay  [--gamma G] [--type T]          discount forgetting: s,f ×G(<1, default 0.5); use after model upgrade (non-stationary bandit)
#   env: FANOUT_ALLOCATION(bench table) FANOUT_ALLOCATION_STATS(stats file) FANOUT_ALLOCATION_LEDGER(ledger)
#        FANOUT_ALLOCATE_KAPPA(prior strength, default 4) FANOUT_ALLOCATE_SEED(TS sampling seed, for tests) FANOUT_STATE
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TBL="${FANOUT_ALLOCATION:-$HERE/allocation.tsv}"
STATS="${FANOUT_ALLOCATION_STATS:-${FANOUT_STATE:-$HOME/.config/fanout}/allocation-stats.tsv}"
LEDGER="${FANOUT_ALLOCATION_LEDGER:-${FANOUT_STATE:-$HOME/.config/fanout}/alloc-ledger.tsv}"
KAPPA="${FANOUT_ALLOCATE_KAPPA:-4}"
UNLISTED_PRIOR=0.15
[ -f "$TBL" ] || die "no allocation table $TBL"

bench_list(){ grep -vE '^[[:space:]]*#' "$TBL" | awk -F'\t' -v k="$1" '$1==k{print $2; f=1} END{exit !f}'; }

# Scoring core: given task + bench string, read STATS, compute each agent's Beta(A,B) score, output "score<TAB>rank<TAB>agent".
# sample=0 → posterior mean A/(A+B) (greedy, default, deterministic cold start); sample=1 → Thompson Sampling:
#   sample from Beta(A,B) then sort (Gaussian approx), few samples → high variance → chance of exploration, won't lock in early winner prematurely.
#   theory: Agrawal & Goyal 2012 (Beta-Bernoulli TS near-optimal regret); Russo et al. 2018 tutorial.
_score_rows(){
  local task="$1" models="$2" sample="${3:-0}" statsfile="$STATS"
  [ -f "$statsfile" ] || statsfile=/dev/null   # query produces no side effects
  awk -F'\t' -v task="$task" -v blist="$models" -v kappa="$KAPPA" -v up="$UNLISTED_PRIOR" \
      -v sample="$sample" -v seed="${FANOUT_ALLOCATE_SEED:-}" '
    function bsample(A,B,   mean,var,sd,z,v){   # Gaussian-approx Thompson sampling of Beta(A,B)
      mean=A/(A+B); var=A*B/((A+B)*(A+B)*(A+B+1)); sd=sqrt(var)
      z=sqrt(-2*log(rand()+1e-12))*cos(6.2831853*rand())   # Box-Muller standard normal
      v=mean+z*sd; if(v<0)v=0; if(v>1)v=1; return v
    }
    BEGIN{
      if(seed!="") srand(seed); else srand()
      m=split(blist, arr, ",")
      for(i=1;i<=m;i++){ ag=arr[i]; gsub(/^[ \t]+|[ \t]+$/,"",ag)
        listed[ag]=1; prior[ag]=(m-(i-1))/(m+1); order[ag]=i }
    }
    $1==task { s[$2]=$3+0; f[$2]=$4+0; seen[$2]=1 }
    END{
      for(ag in listed) cand[ag]=1
      for(ag in seen)   cand[ag]=1
      for(ag in cand){
        p0 = (ag in listed) ? prior[ag] : up
        a0 = kappa*p0 + 1; b0 = kappa*(1-p0) + 1
        ss = (ag in s) ? s[ag] : 0; ff = (ag in f) ? f[ag] : 0
        A = a0+ss; B = b0+ff
        score = (sample=="1") ? bsample(A,B) : A/(A+B)
        ord = (ag in order) ? order[ag] : 9999
        printf "%.6f\t%d\t%s\n", score, ord, ag
      }
    }' "$statsfile" | sort -t"$(printf '\t')" -k1,1nr -k2,2n -k3,3
}

cmd_rank(){
  local task="$1" top="$2" sample="${3:-0}" models
  if models="$(bench_list "$task")"; then :; else
    models="$(bench_list fallback)" || die "table has no fallback either"
    echo "fanout-allocate: unknown task type '$task' → falling back to fallback ($models)" >&2
    task="fallback"
  fi
  local ranked; ranked="$(_score_rows "$task" "$models" "$sample" | cut -f3)"
  if [ "$top" -eq 1 ]; then printf '%s\n' "$ranked" | head -1
  else printf '%s\n' "$ranked" | grep -v '^$' | tr '\n' ',' | sed 's/,$//'; echo; fi
}

cmd_stats(){
  local task="${1:-}"; [ -n "$task" ] || die "usage: stats <task-type>"
  local models; models="$(bench_list "$task")" || { models="$(bench_list fallback)"; task="fallback"; }
  echo "── allocate stats: $task (kappa=$KAPPA) ──"
  printf '  %-12s %-8s %-6s %s\n' agent score "s/f" prior
  local statsfile="$STATS"; [ -f "$statsfile" ] || statsfile=/dev/null
  # recompute with s/f/prior detail
  local models_q="$models"
  awk -F'\t' -v task="$task" -v blist="$models_q" -v kappa="$KAPPA" -v up="$UNLISTED_PRIOR" '
    BEGIN{ m=split(blist,arr,",")
      for(i=1;i<=m;i++){ ag=arr[i]; gsub(/^[ \t]+|[ \t]+$/,"",ag); listed[ag]=1; prior[ag]=(m-(i-1))/(m+1); order[ag]=i } }
    $1==task { s[$2]=$3+0; f[$2]=$4+0; seen[$2]=1 }
    END{
      for(ag in listed) cand[ag]=1; for(ag in seen) cand[ag]=1
      for(ag in cand){
        p0=(ag in listed)?prior[ag]:up; a0=kappa*p0+1; b0=kappa*(1-p0)+1
        ss=(ag in s)?s[ag]:0; ff=(ag in f)?f[ag]:0; score=(a0+ss)/(a0+b0+ss+ff)
        ord=(ag in order)?order[ag]:9999
        printf "%.6f\t%d\t%s\t%g\t%g\t%.2f\n", score, ord, ag, ss, ff, p0
      }
    }' "$statsfile" | sort -t"$(printf '\t')" -k1,1nr -k2,2n -k3,3 \
    | while IFS="$(printf '\t')" read -r score ord ag ss ff p0; do
        printf '  %-12s %-8.3f %-6s %s\n' "$ag" "$score" "$ss/$ff" "$p0"
      done
}

cmd_record(){
  local task="${1:-}" agent="${2:-}" res="${3:-}"
  [ -n "$task" ] && [ -n "$agent" ] && [ -n "$res" ] || die "usage: record <task-type> <agent> <ok|fail>"
  # normalize: ccb agent name cc-doubao → bench table bare name doubao, else experience feeds into different key, flywheel doesn't close
  agent="${agent#cc-}"
  case "$(printf '%s' "$res" | tr 'A-Z' 'a-z')" in
    ok|success|pass|1|win)        res=ok;;
    fail|failure|0|loss|needsfix) res=fail;;
    *) die "<result> must be ok|fail (got '$res')";;
  esac
  # self-review finding: recording a task-type not in the bench table makes orphans (allocate query falls back to fallback bucket, can't read this type's stats)
  bench_list "$task" >/dev/null 2>&1 || \
    echo "fanout-allocate: ⚠ '$task' not in bench table (allocation.tsv) — allocate queries fall back to fallback, these records won't be read; to take effect add '$task' to the table" >&2
  mkdir -p "$(dirname "$STATS")"; [ -f "$STATS" ] || : > "$STATS"
  local tmp; tmp="$(mktemp)"
  awk -F'\t' -v OFS='\t' -v t="$task" -v a="$agent" -v r="$res" '
    $1==t && $2==a { if(r=="ok") $3=$3+1; else $4=$4+1; print; done=1; next }
    { print }
    END{ if(!done){ if(r=="ok") print t,a,1,0; else print t,a,0,1 } }' "$STATS" > "$tmp"
  mv -f "$tmp" "$STATS"
  local line; line="$(awk -F'\t' -v t="$task" -v a="$agent" '$1==t&&$2==a{print "s="$3" f="$4}' "$STATS")"
  echo "✓ record $task/$agent $res → $line"
}

cmd_reset(){
  local task="${1:-}"
  [ -f "$STATS" ] || { echo "(no stats to clear)"; return 0; }
  if [ -z "$task" ]; then rm -f "$STATS"; echo "✓ cleared all real-world stats"; return 0; fi
  local tmp; tmp="$(mktemp)"
  awk -F'\t' -v t="$task" '$1!=t' "$STATS" > "$tmp"; mv -f "$tmp" "$STATS"
  echo "✓ cleared real-world stats for '$task'"
}

# decay: discount forgetting — s,f ×gamma(<1), lets posterior forget stale stats. Use after model upgrade (non-stationary bandit).
# theory: Garivier & Moulines 2011 (switching bandits); Raj & Kalyani 2017 (discounted TS).
cmd_decay(){
  local gamma=0.5 task=""
  while [ "$#" -gt 0 ]; do case "$1" in
    --gamma) gamma="${2:-}"; shift 2;; --type) task="${2:-}"; shift 2;; *) die "unknown arg '$1'";; esac
  done
  awk -v g="$gamma" 'BEGIN{exit !(g>0 && g<1)}' || die "--gamma must be in (0,1), got '$gamma'"
  [ -f "$STATS" ] || { echo "(no stats to decay)"; return 0; }
  local tmp; tmp="$(mktemp)"
  awk -F'\t' -v OFS='\t' -v g="$gamma" -v t="$task" '
    { if(t=="" || $1==t){ $3=$3*g; $4=$4*g } print }' "$STATS" > "$tmp"
  mv -f "$tmp" "$STATS"
  echo "✓ decay: s/f for ${task:-all} ×$gamma (discount-forget stale stats; run after model upgrade)"
}

_in_list(){ local x="$1"; shift; local e; for e in "$@"; do [ "$e" = "$x" ] && return 0; done; return 1; }

# feed: batch-feed posterior (data flywheel). Two modes: explicit tuples or --from-ledger
cmd_feed(){
  local from_ledger=0 result="" ledger="$LEDGER" keep=0
  local fails=() oks=() tuples=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --from-ledger) from_ledger=1; shift;;
      --result) result="${2:-}"; shift 2;;
      --fail) IFS=',' read -r -a fails <<< "${2:-}"; shift 2;;
      --ok)   IFS=',' read -r -a oks  <<< "${2:-}"; shift 2;;
      --ledger) ledger="${2:-}"; shift 2;;
      --keep) keep=1; shift;;
      -*) die "unknown arg '$1'";;
      *) tuples+=("$1"); shift;;
    esac
  done
  local n=0 t a r
  if [ "$from_ledger" -eq 1 ]; then
    [ -f "$ledger" ] || die "no ledger: $ledger (dispatch --task-type writes it)"
    case "$result" in ok|fail) ;; *) die "--from-ledger needs --result ok|fail (whole-round default; override individuals with --fail/--ok)";; esac
    while IFS=$'\t' read -r t a; do
      [ -n "$t" ] && [ -n "$a" ] || continue
      r="$result"
      _in_list "$a" ${fails[@]+"${fails[@]}"} && r=fail
      _in_list "$a" ${oks[@]+"${oks[@]}"}     && r=ok
      cmd_record "$t" "$a" "$r" >/dev/null && n=$((n+1))
    done < "$ledger"
    [ "$keep" -eq 1 ] || : > "$ledger"
    echo "✓ feed: recorded $n from ledger (default=$result fail=[${fails[*]:-}] ok=[${oks[*]:-}]); ledger $([ "$keep" -eq 1 ] && echo retained || echo cleared)"
  else
    [ "${#tuples[@]}" -ge 1 ] || die "usage: feed type:agent:result [...] | feed --from-ledger --result ok|fail [--fail a,b]"
    local tup
    for tup in "${tuples[@]}"; do
      IFS=':' read -r t a r <<< "$tup"
      [ -n "$t" ] && [ -n "$a" ] && [ -n "$r" ] || die "tuple format type:agent:result, got '$tup'"
      cmd_record "$t" "$a" "$r" >/dev/null && n=$((n+1))
    done
    echo "✓ feed: recorded $n"
  fi
}

sub="${1:-}"
case "$sub" in
  list)
    grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$TBL" | awk -F'\t' '{printf "  %-14s %s\n",$1,$2}'; exit 0;;
  record) shift; cmd_record "$@";;
  feed)   shift; cmd_feed   "$@";;
  stats)  shift; cmd_stats  "$@";;
  reset)  shift; cmd_reset  "$@";;
  decay)  shift; cmd_decay  "$@";;
  -h|--help) sed -n '2,26p' "$0";;
  '') die "usage: <task-type> [--top] [--sample] | list | record | feed | stats | reset | decay";;
  *)
    ttype="$sub"; shift   # $1 is task-type
    top=0; sample=0
    while [ "$#" -gt 0 ]; do case "$1" in
      --top) top=1;; --sample) sample=1;; *) die "unknown arg '$1'";; esac; shift; done
    cmd_rank "$ttype" "$top" "$sample";;
esac
