#!/usr/bin/env bash
# fanout-allocate.test.sh — static bench backward compat + adaptive (bench prior + real-world posterior) mix
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$HERE/fanout-allocate.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# hermetic: isolate the real stats file so backward-compat asserts test "cold start" (empty stats = bench order)
export FANOUT_ALLOCATION_STATS="$TMP/stats.tsv"
export FANOUT_ALLOCATION_LEDGER="$TMP/ledger.tsv"
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-allocate tests"

# ── backward compat (cold start == old static behavior) ──
ok "code → minimax first (cold start=bench)" '[ "$(bash "$A" code)" = "minimax,doubao,glm" ]'
ok "logic --top → kimi" '[ "$(bash "$A" logic --top)" = "kimi" ]'
ok "sql includes doubao" 'bash "$A" sql | grep -q doubao'
ok "review → coder" '[ "$(bash "$A" review --top)" = "coder" ]'
ok "list outputs multiple lines" '[ "$(bash "$A" list | grep -c .)" -ge 8 ]'
out="$(bash "$A" bogusXYZ 2>/dev/null)"; ok "unknown type falls back to mimo (stdout)" '[ "$out" = "mimo" ]'
bash "$A" bogusXYZ 2>&1 1>/dev/null | grep -q "falling back to fallback"; ok "unknown type stderr hint" '[ "$?" -eq 0 ]'
bash "$A" >/dev/null 2>&1; ok "no args → nonzero" '[ "$?" -ne 0 ]'

# ── adaptive: real-world posterior changes ordering ──
bash "$A" reset >/dev/null 2>&1
# doubao win streak + minimax loss streak → doubao overrides bench top pick
for i in 1 2 3 4; do bash "$A" record code doubao ok >/dev/null; bash "$A" record code minimax fail >/dev/null; done
ok "doubao wins+minimax losses → code --top becomes doubao" '[ "$(bash "$A" code --top)" = "doubao" ]'
ok "exploration floor: minimax still ranked after 4 losses (not starved)" 'bash "$A" code | grep -q minimax'

# reset single type → back to cold start
bash "$A" reset code >/dev/null
ok "reset code → back to bench cold-start order" '[ "$(bash "$A" code)" = "minimax,doubao,glm" ]'

# agent not listed in bench surfaces into ranking via real-world results
bash "$A" reset >/dev/null
for i in 1 2 3 4 5; do bash "$A" record code claude ok >/dev/null; done
ok "claude not listed in bench enters code ranking via real-world" 'bash "$A" code | grep -q claude'

# stats subcommand: print each agent's score/samples
bash "$A" reset >/dev/null
bash "$A" record code doubao ok >/dev/null
out="$(bash "$A" stats code)"
ok "stats includes score header" 'case "$out" in *score*) true;; *) false;; esac'
ok "stats includes doubao row" 'case "$out" in *doubao*) true;; *) false;; esac'

# record result normalization + illegal value
bash "$A" reset >/dev/null
bash "$A" record logic kimi needsfix >/dev/null
ok "record 'needsfix' normalizes to fail (f=1)" 'case "$(bash "$A" stats logic)" in *0/1*) true;; *) false;; esac'
bash "$A" record logic kimi 1 >/dev/null
ok "record '1' normalizes to ok (s=1)" 'case "$(bash "$A" stats logic)" in *1/1*) true;; *) false;; esac'
bash "$A" record code doubao bogus >/dev/null 2>&1; ok "illegal result → nonzero" '[ "$?" -ne 0 ]'
bash "$A" record code >/dev/null 2>&1; ok "record missing args → nonzero" '[ "$?" -ne 0 ]'
# self-review finding: warn when recording a type not in bench table (still records, only stderr orphan hint)
bash "$A" record noSuchType someagent ok 2>&1 1>/dev/null | grep -q "not in bench table"; ok "record unknown type → stderr orphan warning" '[ "$?" -eq 0 ]'
bash "$A" record codeXYZ a ok >/dev/null 2>&1; ok "record unknown type still exit 0 (non-fatal)" '[ "$?" -eq 0 ]'

# cold-start determinism: multiple calls same result (empty stats)
bash "$A" reset >/dev/null
ok "cold start reproducible (two calls same output)" '[ "$(bash "$A" docs)" = "$(bash "$A" docs)" ]'

# ── feed: batch-feed posterior (data flywheel) ──
bash "$A" reset >/dev/null
# explicit tuples (use names that don't collide with bench substrings; cc- prefix normalized off)
bash "$A" feed code:cc-zeta:ok code:cc-zeta:ok logic:cc-omega:fail >/dev/null
ok "feed tuples: zeta s=2 (cc- normalized)" 'case "$(bash "$A" stats code)" in *"zeta"*"2/0"*) true;; *) false;; esac'
ok "feed tuples: omega f=1" 'case "$(bash "$A" stats logic)" in *"omega"*"0/1"*) true;; *) false;; esac'
ok "feed illegal tuple → nonzero" 'bash "$A" feed badtuple >/dev/null 2>&1; [ "$?" -ne 0 ]'

# normalize closes flywheel: cc-doubao experience feeds into bench's doubao (same key), cc-doubao doesn't appear in ranking
bash "$A" reset >/dev/null
bash "$A" feed code:cc-doubao:ok >/dev/null
ok "cc-doubao normalizes to bench's doubao (has 1/0)" 'case "$(bash "$A" stats code)" in *"doubao"*"1/0"*) true;; *) false;; esac'
ok "ranking doesn't show un-normalized cc-doubao" '! bash "$A" code | grep -q "cc-doubao"'

# ledger mode: ledger written by dispatch → feed --from-ledger
bash "$A" reset >/dev/null
printf 'code\tcc-doubao\nsql\tcc-glm\ncode\tcc-zeta\n' > "$FANOUT_ALLOCATION_LEDGER"
bash "$A" feed --from-ledger --result ok --fail cc-zeta >/dev/null
ok "ledger feed: doubao defaults ok" 'case "$(bash "$A" stats code)" in *"doubao"*"1/0"*) true;; *) false;; esac'
ok "ledger feed: cc-zeta overridden to fail by --fail" 'case "$(bash "$A" stats code)" in *"zeta"*"0/1"*) true;; *) false;; esac'
ok "ledger feed: sql/glm ok" 'case "$(bash "$A" stats sql)" in *"glm"*"1/0"*) true;; *) false;; esac'
ok "ledger feed clears ledger by default" '[ ! -s "$FANOUT_ALLOCATION_LEDGER" ]'
# --keep retains ledger
printf 'code\tcc-zeta\n' > "$FANOUT_ALLOCATION_LEDGER"
bash "$A" feed --from-ledger --result ok --keep >/dev/null
ok "feed --keep retains ledger" '[ -s "$FANOUT_ALLOCATION_LEDGER" ]'
# --from-ledger missing --result → nonzero
bash "$A" feed --from-ledger >/dev/null 2>&1; ok "--from-ledger missing --result → nonzero" '[ "$?" -ne 0 ]'

# ── Thompson Sampling (--sample) —— platform-independent properties (awk rand sequence differs across platforms, don't assert exact order) ──
bash "$A" reset >/dev/null
ok "default (no --sample) still mean bench order" '[ "$(bash "$A" code)" = "minimax,doubao,glm" ]'
o1="$(FANOUT_ALLOCATE_SEED=5 bash "$A" code --sample)"; o2="$(FANOUT_ALLOCATE_SEED=5 bash "$A" code --sample)"
ok "TS same seed reproducible" '[ "$o1" = "$o2" ]'
ok "TS output still valid ranked (includes 3 bench agents)" 'case ",$o1," in *,minimax,*) [ "$(echo "$o1" | tr "," "\n" | grep -c .)" -ge 3 ];; *) false;; esac'
# TS explores: top-1 across 20 seeds not all identical (greedy would be all identical = 1 kind)
distinct="$(for s in $(seq 1 20); do FANOUT_ALLOCATE_SEED=$s bash "$A" code --sample --top; done | sort -u | grep -c .)"
ok "TS explores: top-1 across 20 seeds ≥2 kinds (not greedy lock-in)" '[ "$distinct" -ge 2 ]'

# ── decay (discount forgetting, non-stationary bandit) ──
bash "$A" reset >/dev/null
for i in 1 2 3 4; do bash "$A" record code doubao ok >/dev/null; done   # 4/0
bash "$A" decay --gamma 0.5 >/dev/null
ok "decay ×0.5: 4/0 → 2/0" 'case "$(bash "$A" stats code)" in *"doubao"*"2/0"*) true;; *) false;; esac'
bash "$A" decay --gamma 1.5 >/dev/null 2>&1; ok "decay gamma≥1 → nonzero" '[ "$?" -ne 0 ]'
bash "$A" decay --gamma 0 >/dev/null 2>&1; ok "decay gamma=0 → nonzero" '[ "$?" -ne 0 ]'
# --type decays only one type
bash "$A" reset >/dev/null
bash "$A" record code doubao ok >/dev/null; bash "$A" record code doubao ok >/dev/null   # code 2/0
bash "$A" record sql glm ok >/dev/null;     bash "$A" record sql glm ok >/dev/null        # sql 2/0
bash "$A" decay --gamma 0.5 --type code >/dev/null
ok "decay --type code: code 2→1" 'case "$(bash "$A" stats code)" in *"doubao"*"1/0"*) true;; *) false;; esac'
ok "decay --type code: sql unchanged 2/0" 'case "$(bash "$A" stats sql)" in *"glm"*"2/0"*) true;; *) false;; esac'

tdone
