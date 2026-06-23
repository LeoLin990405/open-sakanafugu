#!/usr/bin/env bash
# fanout-integrate.test.sh — Phase 3 integrate self-test (real git worktree: happy / no-change / conflict isolation / missing / dry)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INT="$HERE/fanout-integrate.sh"
GIT="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c init.defaultBranch=main"

# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-integrate tests"

# ── shared scaffold: build main repo + 4 agent worktrees ──
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
W="$TMP/work"; mkdir -p "$W"
$GIT -C "$W" init -q
# real convention: ccb worktree lives in .ccb/workspaces/ (inside main repo working tree) → must gitignore .ccb/,
# otherwise the main repo `git add -A` would suck the worktree in as an embedded repo, polluting status.
printf 'base\n' > "$W/shared.txt"; printf '.ccb/\n' > "$W/.gitignore"
$GIT -C "$W" add -A; $GIT -C "$W" commit -qm init
$GIT -C "$W" branch -M main 2>/dev/null || true

mkwt(){ $GIT -C "$W" worktree add -q -b "br-$1" "$W/.ccb/workspaces/$1" main; }
# all worktrees built from the original base (base=base) → conflict/conflict2 base diverges from the "already-advanced main"
mkwt cc-deepseek; mkwt cc-glm; mkwt cc-idle; mkwt cc-conflict; mkwt cc-conflict2; mkwt cc-late

# deepseek changes a.py+shared, glm changes b.py (different files), idle no change, conflict/conflict2 change shared(clash), late adds late.py
echo "print('a')" > "$W/.ccb/workspaces/cc-deepseek/a.py"
echo "print('b')" > "$W/.ccb/workspaces/cc-glm/b.py"
echo "DEEPSEEK-wins" > "$W/.ccb/workspaces/cc-deepseek/shared.txt"   # also touches shared → clashes with conflict
echo "CONFLICT-wins" > "$W/.ccb/workspaces/cc-conflict/shared.txt"
echo "OTHER-wins"    > "$W/.ccb/workspaces/cc-conflict2/shared.txt"
echo "print('late')" > "$W/.ccb/workspaces/cc-late/late.py"

# ── dry: do not touch git ──
HEAD0="$($GIT -C "$W" rev-parse HEAD)"
out="$(bash "$INT" --work "$W" --agents "cc-deepseek cc-glm" --dry)"
ok "dry outputs would-pick" 'case "$out" in *would-pick*) true;; *) false;; esac'
ok "dry produces no new commit" '[ "$($GIT -C "$W" rev-parse HEAD)" = "$HEAD0" ]'

# ── normal integrate: deepseek + glm (different files) both picked ──
out="$(bash "$INT" --work "$W" --agents "cc-deepseek cc-glm cc-idle")"; rc=$?
ok "no conflict → exit 0" '[ "$rc" -eq 0 ]'
ok "a.py reached main" '[ -f "$W/a.py" ]'
ok "b.py reached main" '[ -f "$W/b.py" ]'
ok "deepseek's shared.txt reached main" 'grep -q DEEPSEEK-wins "$W/shared.txt"'
ok "idle no change → no-change" 'case "$out" in *"no-change cc-idle"*) true;; *) false;; esac'
ok "report has 2 picked" 'case "$out" in *"2 picked"*) true;; *) false;; esac'

# ── conflict isolation: cc-conflict's shared.txt conflicts with main current(DEEPSEEK-wins) ──
MAIN_BEFORE="$($GIT -C "$W" rev-parse HEAD)"
out="$(bash "$INT" --work "$W" --agents "cc-conflict")"; rc=$?
ok "has conflict → exit 1" '[ "$rc" -eq 1 ]'
ok "conflict report marks conflict" 'case "$out" in *"conflict  cc-conflict"*) true;; *) false;; esac'
ok "conflict abort → main stays clean (HEAD unchanged)" '[ "$($GIT -C "$W" rev-parse HEAD)" = "$MAIN_BEFORE" ]'
ok "conflict abort → no leftover merge state" '[ -z "$($GIT -C "$W" status --porcelain)" ]'

# ── conflict does not block other agents: conflict2(clashes main) + late(clean) integrated together → late still picked ──
out="$(bash "$INT" --work "$W" --agents "cc-conflict2 cc-late")"; rc=$?
ok "conflict present but late still integrated (late.py to main)" '[ -f "$W/late.py" ]'
ok "mixed result report 1 picked | ... | 1 conflict" 'case "$out" in *"1 picked"*"1 conflict"*) true;; *) false;; esac'

# ── missing agent ──
out="$(bash "$INT" --work "$W" --agents "cc-ghost" 2>&1)"
ok "nonexistent worktree → missing" 'case "$out" in *"missing   cc-ghost"*) true;; *) false;; esac'

# ── TASK file append ──
TF="$TMP/task.md"; echo "# task" > "$TF"
mkwt cc-tasklog; echo x > "$W/.ccb/workspaces/cc-tasklog/t.txt"
bash "$INT" --work "$W" --agents "cc-tasklog" --task "$TF" >/dev/null 2>&1
ok "integrate summary written to TASK file" 'grep -q "### Integrate" "$TF"'

# ── out-of-bounds detection (--ownership; borrowed from Lynn, enforced on orchestrator side) ──
mkwt cc-owner;  echo 1 > "$W/.ccb/workspaces/cc-owner/owned1.py"
mkwt cc-stray;  echo 1 > "$W/.ccb/workspaces/cc-stray/owned2.py"; echo 1 > "$W/.ccb/workspaces/cc-stray/sneaky.py"
mkwt cc-forbid; echo k > "$W/.ccb/workspaces/cc-forbid/secret.env"
OWN="$TMP/ownership.tsv"
printf 'cc-owner\towned1.py\t\ncc-stray\towned2.py\t\ncc-forbid\t*\t*.env\n' > "$OWN"

out="$(bash "$INT" --work "$W" --agents "cc-owner" --ownership "$OWN")"; rc=$?
ok "ownership: compliant agent integrates normally" '[ "$rc" -eq 0 ] && [ -f "$W/owned1.py" ]'

out="$(bash "$INT" --work "$W" --agents "cc-stray" --ownership "$OWN")"; rc=$?
ok "ownership: out-of-bounds agent → exit non-0" '[ "$rc" -ne 0 ]'
ok "ownership: report marks violation + out-of-bounds file" 'case "$out" in *"violation cc-stray"*sneaky.py*) true;; *) false;; esac'
ok "ownership: out-of-bounds → sneaky.py did not reach main" '[ ! -f "$W/sneaky.py" ]'
ok "ownership: out-of-bounds → owned2.py also not integrated (whole batch held back)" '[ ! -f "$W/owned2.py" ]'

out="$(bash "$INT" --work "$W" --agents "cc-forbid" --ownership "$OWN")"
ok "ownership: forbidden glob(*.env) hit → violation" 'case "$out" in *"violation cc-forbid"*secret.env*) true;; *) false;; esac'

# violation does not block the compliant: stray(still out-of-bounds) + clean2(not in list=unrestricted) together
mkwt cc-clean2; echo 1 > "$W/.ccb/workspaces/cc-clean2/owned3.py"
out="$(bash "$INT" --work "$W" --agents "cc-stray cc-clean2" --ownership "$OWN")"
ok "violation does not block: cc-clean2 still integrated" '[ -f "$W/owned3.py" ]'
ok "mixed summary has 1 violation" 'case "$out" in *"1 violation"*) true;; *) false;; esac'

# not in ownership list = unrestricted (backward compatible)
mkwt cc-free; echo 1 > "$W/.ccb/workspaces/cc-free/anything.py"
out="$(bash "$INT" --work "$W" --agents "cc-free" --ownership "$OWN")"; rc=$?
ok "not in ownership list → unrestricted, integrates normally" '[ "$rc" -eq 0 ] && [ -f "$W/anything.py" ]'

bash "$INT" --work "$W" --agents x --ownership /no/such/file >/dev/null 2>&1; ok "ownership file not found → non-0" '[ "$?" -ne 0 ]'

# ── usage errors ──
bash "$INT" --agents "x" >/dev/null 2>&1; ok "missing --work → non-0" '[ "$?" -ne 0 ]'
bash "$INT" --work "$W" >/dev/null 2>&1; ok "missing --agents → non-0" '[ "$?" -ne 0 ]'
bash "$INT" --work "$W" --agents x --onconflict bogus >/dev/null 2>&1; ok "invalid onconflict → non-0" '[ "$?" -ne 0 ]'

tdone
