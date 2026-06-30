#!/usr/bin/env bash
# Solve ONE SWE-bench instance with one solver, then eval it.
#
#   solve-instance.sh <instance_id> <solver>   # solver = orchestrated | single
#
# Prereq: fetch_dataset.sh done; the instance's repo cloned into work/repos/<repo>
# with its deps installed (set TEST_CMD per repo if not the default pytest).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${FUGUNANO_ROOT:-$(git rev-parse --show-toplevel)}"
FO="orchestration/fuguectl/fuguectl"
CODEX="${CODEX:-/Applications/Codex.app/Contents/Resources/codex}"
CLAUDE="${CLAUDE:-claude}"
DS="$HERE/work/dataset.jsonl"
INSTANCE="${1:?instance_id}"; SOLVER="${2:?orchestrated|single}"
PYTHON="${PYTHON:-$(command -v python3 || command -v python)}"

# resolve the repo dir for this instance
REPO_NAME="$("$PYTHON" - "$DS" "$INSTANCE" <<'PY'
import json,sys
for line in open(sys.argv[1]):
    r=json.loads(line)
    if r["instance_id"]==sys.argv[2]: print(r["repo"]); break
PY
)"
REPO="$HERE/work/repos/$REPO_NAME"
[ -d "$REPO/.git" ] || { echo "clone $REPO_NAME into $REPO first (with deps installed)"; exit 1; }

# prepare: base commit + test_patch — must succeed, else the gold tests were never
# applied and any verdict below would be silently wrong.
"$PYTHON" "$HERE/prepare_instance.py" "$DS" "$INSTANCE" "$REPO" >/dev/null \
  || { echo "FAILED: $INSTANCE (prepare_instance: gold test_patch did not apply)"; exit 1; }

# build the solve prompt from the problem statement
"$PYTHON" - "$DS" "$INSTANCE" "$HERE/work/solve-$INSTANCE.md" <<'PY'
import json,sys
rec=None
for line in open(sys.argv[1]):
    r=json.loads(line)
    if r["instance_id"]==sys.argv[2]: rec=r; break
open(sys.argv[3],"w").write(
"You are fixing a real bug in the repo at the current directory.\n\n"
"instance: "+rec["instance_id"]+"\n\n"
"## Problem statement\n"+rec["problem_statement"]+"\n\n"
"Edit the actual source files (use Read/Edit/Write) to fix the issue. Do NOT "
"modify tests. When done, print one line: DONE: <list of files you changed>.\n")
PY

# solver produces the patch by editing files in $REPO
if [ "$SOLVER" = orchestrated ]; then
  # plan → dispatch (file-level split derived from the statement) → integrate → codex review → loop
  F="$("$FO" task new "swebench $INSTANCE (orch)" P1)"
  "$FO" dispatch gpt-5.5 --harness codex --codex-clean --timeout-ms 600000 \
    --prompt-file "$HERE/work/solve-$INSTANCE.md" --task "$F"   # writer (swap for a fleet split as needed)
  "$FO" integrate --work "$REPO" --agents "gpt-5.5" --task "$F" >/dev/null 2>&1 || true
  # independent review + fix loop (codex writer => use claude as reviewer for gen!=review)
  DIFF="$(cd "$REPO" && git --no-pager diff)"
  printf 'Independent review of this fix:\n%s\nFirst line VERDICT: ACCEPTED/NEEDS FIX + findings.\n' "$DIFF" \
    > "$HERE/work/rev-$INSTANCE.md"
  "$CLAUDE" -p "$(cat "$HERE/work/rev-$INSTANCE.md")" --permission-mode acceptEdits --output-format text \
    > "$HERE/work/verdict-$INSTANCE.txt" 2>/dev/null || true
else
  # single: one writer, one pass, no review/loop
  ( cd "$REPO" && "$CODEX" exec "$(cat "$HERE/work/solve-$INSTANCE.md")" -C "$REPO" \
      --skip-git-repo-check -s workspace-write -o "$HERE/work/single-$INSTANCE.out" >/dev/null 2>&1 )
fi

# capture the produced patch (excluding tests, which the test_patch owns)
( cd "$REPO" && git --no-pager diff -- ':!**/test*' ':!**/tests/*' ) > "$HERE/work/cand-$INSTANCE-$SOLVER.patch"

# eval: FAIL_TO_PASS must pass, PASS_TO_PASS sample must not regress
"$PYTHON" "$HERE/eval_instance.py" "$DS" "$INSTANCE" "$REPO" \
  && echo "RESOLVED: $INSTANCE ($SOLVER)" || echo "FAILED: $INSTANCE ($SOLVER)"
