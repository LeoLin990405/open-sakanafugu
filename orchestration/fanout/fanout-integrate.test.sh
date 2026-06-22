#!/usr/bin/env bash
# fanout-integrate.test.sh — Phase 3 整合自测 (真 git worktree: happy / no-change / 冲突隔离 / missing / dry)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INT="$HERE/fanout-integrate.sh"
GIT="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c init.defaultBranch=main"

pass=0; fail=0
ok(){ if eval "$2"; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }

echo "fanout-integrate tests"

# ── 公共脚手架: 建主 repo + 4 个 agent worktree ──
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
W="$TMP/work"; mkdir -p "$W"
$GIT -C "$W" init -q
# 真实约定: ccb worktree 在 .ccb/workspaces/ (主 repo 工作树内) → 必须 gitignore .ccb/,
# 否则主 repo `git add -A` 会把 worktree 吸成嵌入仓库, 污染 status。
printf 'base\n' > "$W/shared.txt"; printf '.ccb/\n' > "$W/.gitignore"
$GIT -C "$W" add -A; $GIT -C "$W" commit -qm init
$GIT -C "$W" branch -M main 2>/dev/null || true

mkwt(){ $GIT -C "$W" worktree add -q -b "br-$1" "$W/.ccb/workspaces/$1" main; }
# 所有 worktree 都从原始 base 建 (base=base) → conflict/conflict2 的 base 会与"已前进的 main"分叉
mkwt cc-deepseek; mkwt cc-glm; mkwt cc-idle; mkwt cc-conflict; mkwt cc-conflict2; mkwt cc-late

# deepseek 改 a.py+shared, glm 改 b.py (不同文件), idle 不改, conflict/conflict2 改 shared(撞), late 加 late.py
echo "print('a')" > "$W/.ccb/workspaces/cc-deepseek/a.py"
echo "print('b')" > "$W/.ccb/workspaces/cc-glm/b.py"
echo "DEEPSEEK-wins" > "$W/.ccb/workspaces/cc-deepseek/shared.txt"   # 也动 shared → 与 conflict 撞
echo "CONFLICT-wins" > "$W/.ccb/workspaces/cc-conflict/shared.txt"
echo "OTHER-wins"    > "$W/.ccb/workspaces/cc-conflict2/shared.txt"
echo "print('late')" > "$W/.ccb/workspaces/cc-late/late.py"

# ── dry: 不动 git ──
HEAD0="$($GIT -C "$W" rev-parse HEAD)"
out="$(bash "$INT" --work "$W" --agents "cc-deepseek cc-glm" --dry)"
ok "dry 输出 would-pick" 'case "$out" in *would-pick*) true;; *) false;; esac'
ok "dry 不产生新 commit" '[ "$($GIT -C "$W" rev-parse HEAD)" = "$HEAD0" ]'

# ── 正常整合: deepseek + glm (不同文件) 都 picked ──
out="$(bash "$INT" --work "$W" --agents "cc-deepseek cc-glm cc-idle")"; rc=$?
ok "无冲突 → exit 0" '[ "$rc" -eq 0 ]'
ok "a.py 已到 main" '[ -f "$W/a.py" ]'
ok "b.py 已到 main" '[ -f "$W/b.py" ]'
ok "deepseek 改的 shared.txt 已到 main" 'grep -q DEEPSEEK-wins "$W/shared.txt"'
ok "idle 无改动 → no-change" 'case "$out" in *"no-change cc-idle"*) true;; *) false;; esac'
ok "报告含 2 picked" 'case "$out" in *"2 picked"*) true;; *) false;; esac'

# ── 冲突隔离: cc-conflict 改的 shared.txt 与 main 现状(DEEPSEEK-wins)冲突 ──
MAIN_BEFORE="$($GIT -C "$W" rev-parse HEAD)"
out="$(bash "$INT" --work "$W" --agents "cc-conflict")"; rc=$?
ok "有冲突 → exit 1" '[ "$rc" -eq 1 ]'
ok "冲突报告标 conflict" 'case "$out" in *"conflict  cc-conflict"*) true;; *) false;; esac'
ok "冲突 abort → main 保持干净 (HEAD 未变)" '[ "$($GIT -C "$W" rev-parse HEAD)" = "$MAIN_BEFORE" ]'
ok "冲突 abort → 无残留 merge 状态" '[ -z "$($GIT -C "$W" status --porcelain)" ]'

# ── 冲突不阻断其余 agent: conflict2(撞 main) + late(干净) 一起整合 → late 仍 picked ──
out="$(bash "$INT" --work "$W" --agents "cc-conflict2 cc-late")"; rc=$?
ok "冲突存在但 late 仍被整合 (late.py 到 main)" '[ -f "$W/late.py" ]'
ok "混合结果报告 1 picked · ... · 1 conflict" 'case "$out" in *"1 picked"*"1 conflict"*) true;; *) false;; esac'

# ── missing agent ──
out="$(bash "$INT" --work "$W" --agents "cc-ghost" 2>&1)"
ok "不存在的 worktree → missing" 'case "$out" in *"missing   cc-ghost"*) true;; *) false;; esac'

# ── TASK 文件追加 ──
TF="$TMP/task.md"; echo "# task" > "$TF"
mkwt cc-tasklog; echo x > "$W/.ccb/workspaces/cc-tasklog/t.txt"
bash "$INT" --work "$W" --agents "cc-tasklog" --task "$TF" >/dev/null 2>&1
ok "整合汇总写入 TASK 文件" 'grep -q "### Integrate" "$TF"'

# ── 越界检测 (--ownership; 借 Lynn 编排器侧强制) ──
mkwt cc-owner;  echo 1 > "$W/.ccb/workspaces/cc-owner/owned1.py"
mkwt cc-stray;  echo 1 > "$W/.ccb/workspaces/cc-stray/owned2.py"; echo 1 > "$W/.ccb/workspaces/cc-stray/sneaky.py"
mkwt cc-forbid; echo k > "$W/.ccb/workspaces/cc-forbid/secret.env"
OWN="$TMP/ownership.tsv"
printf 'cc-owner\towned1.py\t\ncc-stray\towned2.py\t\ncc-forbid\t*\t*.env\n' > "$OWN"

out="$(bash "$INT" --work "$W" --agents "cc-owner" --ownership "$OWN")"; rc=$?
ok "ownership: 守规 agent 正常整合" '[ "$rc" -eq 0 ] && [ -f "$W/owned1.py" ]'

out="$(bash "$INT" --work "$W" --agents "cc-stray" --ownership "$OWN")"; rc=$?
ok "ownership: 越界 agent → exit 非0" '[ "$rc" -ne 0 ]'
ok "ownership: 报告标 violation + 越界文件" 'case "$out" in *"violation cc-stray"*sneaky.py*) true;; *) false;; esac'
ok "ownership: 越界 → sneaky.py 没到 main" '[ ! -f "$W/sneaky.py" ]'
ok "ownership: 越界 → owned2.py 也没整合 (整笔扣下)" '[ ! -f "$W/owned2.py" ]'

out="$(bash "$INT" --work "$W" --agents "cc-forbid" --ownership "$OWN")"
ok "ownership: forbidden glob(*.env) 命中 → violation" 'case "$out" in *"violation cc-forbid"*secret.env*) true;; *) false;; esac'

# 违规不阻断守规者: stray(仍越界) + clean2(不在清单=不限) 一起
mkwt cc-clean2; echo 1 > "$W/.ccb/workspaces/cc-clean2/owned3.py"
out="$(bash "$INT" --work "$W" --agents "cc-stray cc-clean2" --ownership "$OWN")"
ok "违规不阻断: cc-clean2 仍整合" '[ -f "$W/owned3.py" ]'
ok "混合汇总含 1 violation" 'case "$out" in *"1 violation"*) true;; *) false;; esac'

# 不在 ownership 清单 = 不限 (向后兼容)
mkwt cc-free; echo 1 > "$W/.ccb/workspaces/cc-free/anything.py"
out="$(bash "$INT" --work "$W" --agents "cc-free" --ownership "$OWN")"; rc=$?
ok "不在 ownership 清单 → 不限, 正常整合" '[ "$rc" -eq 0 ] && [ -f "$W/anything.py" ]'

bash "$INT" --work "$W" --agents x --ownership /no/such/file >/dev/null 2>&1; ok "ownership 文件不存在 → 非0" '[ "$?" -ne 0 ]'

# ── 用法错 ──
bash "$INT" --agents "x" >/dev/null 2>&1; ok "缺 --work → 非0" '[ "$?" -ne 0 ]'
bash "$INT" --work "$W" >/dev/null 2>&1; ok "缺 --agents → 非0" '[ "$?" -ne 0 ]'
bash "$INT" --work "$W" --agents x --onconflict bogus >/dev/null 2>&1; ok "非法 onconflict → 非0" '[ "$?" -ne 0 ]'

echo "fanout-integrate: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
