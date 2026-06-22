#!/usr/bin/env bash
# fanout-integrate.sh — Phase 3 整合: 把各 agent worktree 的改动 cherry-pick 回主分支
#
# 取代 SKILL.md 里"遇冲突就 break 整个循环"的裸 shell: 冲突被隔离到单个 agent
# (cherry-pick --abort 保持 main 干净), 其余 agent 继续整合, 最后给一张汇总表。
# 模型 = git worktree (worktree 与主 repo 共享对象库, 主 repo 能 pick worktree 分支的 SHA)。
#
#   --work <repo>          主 repo (cherry-pick 落点; 须 git 仓库)
#   --agents "a b c"       要整合的 agent (worktree 名), 空格分隔
#   --ws-parent <dir>      worktree 父目录 (相对 work 或绝对; 默认 .ccb/workspaces)
#   --onconflict abort|skip  冲突处理: abort=放弃该 agent 保持 main 干净(默认) / skip=留冲突待人解
#   --ownership <file>     越界检测清单 (借 Lynn: 编排器侧强制, 不信 worker 自觉)。TSV 每行:
#                          agent<TAB>owned-globs<TAB>forbidden-globs (逗号分隔; owned 空/`*`=不限)
#                          worker 改了 owned 之外 / 命中 forbidden 的文件 → 标 violation, 不整合
#   --task <file>          把汇总追加进 TASK 文件 (可选)
#   --dry                  只打印将整合谁, 不动 git
#
# 每个 agent: 越界校验 → worktree 有未提交改动 → add+commit(以 agent 身份) → 主 repo cherry-pick。
# 退出码: 0 = 全 picked/no-change / 1 = 有冲突或越界(已隔离, 列在报告里) / 2 = 用法错
set -uo pipefail
die(){ echo "fanout-integrate: $*" >&2; exit 2; }

work=""; agents=""; ws_parent=".ccb/workspaces"; onconflict="abort"; ownership=""; task=""; dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --work)       work="${2:-}"; shift 2;;
    --agents)     agents="${2:-}"; shift 2;;
    --ws-parent)  ws_parent="${2:-}"; shift 2;;
    --onconflict) onconflict="${2:-}"; shift 2;;
    --ownership)  ownership="${2:-}"; shift 2;;
    --task)       task="${2:-}"; shift 2;;
    --dry)        dry=1; shift;;
    *) die "未知参数 '$1'";;
  esac
done
[ -n "$work" ] || die "需 --work <repo>"
[ -d "$work/.git" ] || git -C "$work" rev-parse --git-dir >/dev/null 2>&1 || die "--work 不是 git 仓库: $work"
[ -n "$agents" ] || die "需 --agents \"a b c\""
case "$onconflict" in abort|skip) ;; *) die "--onconflict 须 abort|skip";; esac
[ -z "$ownership" ] || [ -f "$ownership" ] || die "--ownership 文件不存在: $ownership"

# worktree 绝对路径 (ws_parent 绝对则直用, 否则相对 work)
wt_path(){ case "$ws_parent" in /*) printf '%s/%s' "$ws_parent" "$1";; *) printf '%s/%s/%s' "$work" "$ws_parent" "$1";; esac; }

# 越界检测 (借 Lynn: 编排器侧强制 ownership/forbidden, 不信 worker 自觉)
_match_any(){  # file 是否匹配逗号 glob 列表里任一
  local f="$1" globs="$2" g; local IFS=','
  for g in $globs; do
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254  # $g 是 glob 模式, 故意不引号(就是要 glob 匹配)
    case "$f" in $g) return 0;; esac
  done
  return 1
}
own_line(){ [ -n "$ownership" ] && awk -F'\t' -v a="$1" '$1==a{print $2"\t"$3; exit}' "$ownership"; }
# 输出越界文件 (空=未越界或不在清单=不限)
check_violation(){
  local ag="$1" changed="$2" line owned forbidden f bad=""
  line="$(own_line "$ag")"; [ -n "$line" ] || { printf ''; return 0; }
  owned="$(printf '%s' "$line" | cut -f1)"; forbidden="$(printf '%s' "$line" | cut -f2)"
  for f in $changed; do
    [ -n "$f" ] || continue
    if [ -n "$forbidden" ] && _match_any "$f" "$forbidden"; then bad="$bad $f"; continue; fi
    case "$owned" in ''|'*') ;; *) _match_any "$f" "$owned" || bad="$bad $f";; esac
  done
  printf '%s' "${bad# }"
}

picked=(); nochange=(); conflict=(); violation=(); missing=()
report=()

for ag in $agents; do
  wt="$(wt_path "$ag")"
  if [ ! -d "$wt" ]; then missing+=("$ag"); report+=("  ?  missing   $ag  ($wt 不存在)"); continue; fi
  # worktree 内有无改动
  if [ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    nochange+=("$ag"); report+=("  —  no-change $ag"); continue
  fi
  files="$(git -C "$wt" status --porcelain | sed 's/^...//' | tr '\n' ' ')"
  # 越界检测: cherry-pick 前比对 diff 是否动了 owned 之外 / 命中 forbidden, 越界即隔离(不整合)
  bad="$(check_violation "$ag" "$files")"
  if [ -n "$bad" ]; then
    violation+=("$ag"); report+=("  ⚠  violation $ag  → 越界改动: $bad (owned/forbidden 校验未过; 不整合, 人工裁决)"); continue
  fi
  if [ "$dry" -eq 1 ]; then report+=("  ▸  would-pick $ag  ($files)"); picked+=("$ag"); continue; fi

  git -C "$wt" add -A
  git -C "$wt" -c user.email=ccb@local -c user.name="$ag" commit -q -m "$ag: $files" || {
    nochange+=("$ag"); report+=("  —  no-change $ag (commit 空)"); continue; }
  sha="$(git -C "$wt" rev-parse HEAD)"

  # cherry-pick 要建新 commit → 需 committer 身份; 显式带上, 别依赖全局 git config
  # (无全局 identity 的环境如 CI/全新用户 否则会失败, 被误判成 conflict)
  if git -C "$work" -c user.email=ccb@local -c user.name=fanout-integrate cherry-pick "$sha" >/dev/null 2>&1; then
    picked+=("$ag"); report+=("  ✓  picked    $ag  ${sha:0:7}  ($files)")
  else
    if [ "$onconflict" = abort ]; then
      git -C "$work" cherry-pick --abort >/dev/null 2>&1
      conflict+=("$ag"); report+=("  ✗  conflict  $ag  → 已 abort, main 保持干净; 需人工 cherry-pick/rebase $sha")
    else
      conflict+=("$ag"); report+=("  ✗  conflict  $ag  → 冲突留在工作区(skip 模式), 解决后 git cherry-pick --continue")
    fi
  fi
done

# 汇总
hdr="── integrate (work=$work) ──"
sum="$(printf '%s · %s · %s · %s · %s' \
  "${#picked[@]} picked" "${#nochange[@]} no-change" "${#conflict[@]} conflict" "${#violation[@]} violation" "${#missing[@]} missing")"
{ echo "$hdr"; printf '%s\n' "${report[@]}"; echo "$sum"; }

if [ -n "$task" ] && [ -f "$task" ]; then
  { echo ""; echo "### Integrate — $sum"; printf '%s\n' "${report[@]}"; } >> "$task"
  echo "→ 已写入 $task" >&2
fi

# 冲突或越界 → 非0 (都已隔离, 需人工裁决)
[ "${#conflict[@]}" -eq 0 ] && [ "${#violation[@]}" -eq 0 ]
