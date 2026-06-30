#!/usr/bin/env bash
# Case A — FuguNano orchestration run (the thing under test).
# Drives the full pipeline: Dispatch(5 parallel, file-level split) → Barrier →
# Integrate(--ownership) → deterministic Gate → Review(codex, gen!=review) → Loop.
#
# Prereqs: `./setup.sh` done; FUGUE_CC_WORK set to the tqdm provider project; fleet up.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${FUGUNANO_ROOT:-$(git rev-parse --show-toplevel)}"
FO="orchestration/fuguectl/fuguectl"
CACHE="orchestration/fuguectl/fuguectl-cache"
WORK="${FUGUE_CC_WORK:?set FUGUE_CC_WORK to the tqdm provider project (run benchmarks/case-a-presets/setup.sh there)}"
PYTHON="${PYTHON:-$(command -v python3 || command -v python)}"
PROMPTS="$HERE/prompts"
ROUND=1

# Phase 0/1 — TASK + fleet readiness
F="$("$FO" task new "tqdm presets (Case A)" P1)"
"$FO" fleet status >/dev/null || "$FO" fleet up
"$FO" preflight --harness fugue-cc

# Phase 2 — round 1: 5 parallel, one file per agent
"$CACHE" init "$ROUND" t1:cc-deepseek t2:cc-mimo t3:cc-kimi t4:cc-glm t5:cc-stepfun
"$FO" dispatch cc-deepseek --harness fugue-cc --prompt-file "$PROMPTS/t1-presets.md" --task "$F" --out "$HERE/work/t1.out" &
"$FO" dispatch cc-mimo     --harness fugue-cc --prompt-file "$PROMPTS/t2-cli.md"     --task "$F" --out "$HERE/work/t2.out" &
"$FO" dispatch cc-kimi     --harness fugue-cc --prompt-file "$PROMPTS/t3-tests.md"   --task "$F" --out "$HERE/work/t3.out" &
"$FO" dispatch cc-glm      --harness fugue-cc --prompt-file "$PROMPTS/t4-docs.md"    --task "$F" --out "$HERE/work/t4.out" &
"$FO" dispatch cc-stepfun  --harness fugue-cc --prompt-file "$PROMPTS/t5-utils.md"   --task "$F" --out "$HERE/work/t5.out" &
wait
# record each return into the cache (success/fail still counts as "returned")
for t in t1 t2 t3 t4 t5; do
  if [ -s "$HERE/work/$t.out" ]; then "$CACHE" put  "$ROUND" "$t" "$HERE/work/$t.out"; \
                                else "$CACHE" fail "$ROUND" "$t" "empty output"; fi
done
"$CACHE" barrier "$ROUND" --wait 600          # join gate: dispatched 5 => 5 back

# Phase 3 — integrate with file-level ownership (violators held back, not blindly merged)
"$FO" integrate --work "$WORK" \
  --agents "cc-deepseek cc-mimo cc-kimi cc-glm cc-stepfun" \
  --ownership "$HERE/ownership.tsv" --task "$F"
( cd "$WORK" && "$PYTHON" -m pip install -e . >/dev/null 2>&1; "$HERE/gate.sh" "$WORK" )

# Phase 4 — independent review (codex, different family from the implementers)
cd "$WORK"; DIFF="$(git --no-pager diff "$(git rev-parse HEAD^5)"..HEAD 2>/dev/null || git --no-pager diff HEAD~5..HEAD)"
printf '%s\n' "$DIFF" > "$HERE/work/integrated.diff"
cat > "$HERE/work/review-prompt.md" <<EOF
Your role: independent reviewer, the final quality gate.
Review this integrated diff for the tqdm "presets" feature:
$(cat "$HERE/work/integrated.diff")
Focus: correctness vs CONTRACT.md, security (path traversal, JSON injection), test coverage,
regression risk, code quality. If clean, output "VERDICT: ACCEPTED". Else "VERDICT: NEEDS FIX"
plus a numbered finding list (file:line). Be concise.
EOF
"$FO" dispatch gpt-5.5 --harness codex --codex-clean --timeout-ms 600000 \
  --prompt-file "$HERE/work/review-prompt.md" --out "$HERE/work/verdict.txt" --require-output --task "$F"
"$FO" review packet "$HERE/work/verdict.txt" --json > "$HERE/work/review-packet.json"

# Phase 5 — FULLY-AUTOMATIC bounded review-fix loop (gate → review → record/decide → auto-fix)
cd "$WORK"
"$FO" loop init --max 3 --best-sha "$(git rev-parse HEAD)" --task "$F"
best_sha="$(git rev-parse HEAD)"; round=0
while [ "$round" -lt 3 ]; do
  round=$((round + 1))
  # 1) deterministic gate FIRST (don't spend the reviewer on red)
  GATE_OUT="$("$HERE/gate.sh" "$WORK" 2>&1)"; [ $? = 0 ] && GATE=pass || GATE=fail
  # 2) reviewer only if gate is green; review this round's incremental diff
  if [ "$GATE" = pass ]; then
    DIFF="$(git --no-pager diff "$best_sha"..HEAD)"
    cat > "$HERE/work/round-${round}-review.md" <<EOF
Independent review of this round's diff for the tqdm presets feature.
Contract: $(cat "$HERE/CONTRACT.md")
Diff:
$DIFF
First line exactly "VERDICT: ACCEPTED" or "VERDICT: NEEDS FIX", then numbered findings (file:line). Concise.
EOF
    "$FO" dispatch gpt-5.5 --harness codex --codex-clean --timeout-ms 600000 \
      --prompt-file "$HERE/work/round-${round}-review.md" --out "$HERE/work/round-${round}-verdict.txt" --require-output --task "$F"
    V="$(grep -m1 -iE 'VERDICT:' "$HERE/work/round-${round}-verdict.txt" | tr '[:lower:]' '[:upper:]')"
    N="$(grep -cE '^[[:space:]]*[0-9]+\.' "$HERE/work/round-${round}-verdict.txt" 2>/dev/null || echo 0)"
  else
    V="VERDICT: NEEDS FIX"; N=1
  fi
  # 3) record + ask the state machine
  VERDICT_TOKEN="NEEDSFIX"; [ "${V/ACCEPTED/}" != "$V" ] && VERDICT_TOKEN="ACCEPTED"
  # loop record takes no --task (only loop init does); and no `|| true` — a failed
  # record must surface, not be masked into a later "no round recorded yet".
  "$FO" loop record "$round" --gate "$GATE" --verdict "$VERDICT_TOKEN" --findings "$N" --ask-user 0 \
    --sha "$(git rev-parse HEAD)"
  case "$("$FO" loop decide 2>/dev/null | head -1)" in
    DONE|ESCALATE_MAX|ESCALATE_NONCONV) break ;;
  esac
  # 4) snapshot; keep-best (revert if this round regressed below best)
  git add -A && git -c user.email=fugu@local -c user.name=fugu commit -q -m "round $round" || true
  # 5) auto-fix: dispatch a fixer (different family from the codex reviewer)
  cat > "$HERE/work/round-${round}-fix.md" <<EOF
Fix the failing items for the tqdm presets feature. Edit only in-scope files; do not rewrite from scratch.
Contract: $(cat "$HERE/CONTRACT.md")
Gate log:
$GATE_OUT
Review verdict:
$(cat "$HERE/work/round-${round}-verdict.txt" 2>/dev/null)
Apply minimum edits to pass the gate and reach VERDICT: ACCEPTED. Then print DONE.
EOF
  "$FO" dispatch cc-mimo --harness fugue-cc --prompt-file "$HERE/work/round-${round}-fix.md" --task "$F"
  "$FO" loop status >> "$F" || true
done
echo "==> orchestration done; final gate:"; "$HERE/gate.sh" "$WORK"
