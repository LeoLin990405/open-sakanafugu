#!/usr/bin/env bash
# fanout-doctor.sh — environment recon + workflow advisor
#
# On any machine, detect: which Agent/CLIs are installed, which provider APIs are configured (var name only, never reads value),
# and recommend how to set up this fan-out workflow accordingly. Never prints any secret value.
#
#   usage: scripts/fanout-doctor.sh         # human-readable report
#         scripts/fanout-doctor.sh --quiet # conclusion line only
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"

QUIET=0; [ "${1:-}" = "--quiet" ] && QUIET=1
say()  { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }   # QUIET-aware override of lib say()
g="$FX_OK"; x="$FX_NO"

# ── whether a key is configured (var name present in live env or common rc files; never reads value) ──
RCFILES=(
  "$HOME/.config/cc-model-secrets.env" "$HOME/.zshrc" "$HOME/.zprofile"
  "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"
)
key_configured() { # any arg(candidate var name) being configured counts as yes
  local v
  for v in "$@"; do
    [ -n "$(eval "printf '%s' \"\${$v:-}\"")" ] && return 0
    local f
    for f in "${RCFILES[@]}"; do
      [ -f "$f" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?$v=" "$f" && return 0
    done
  done
  return 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# ── provider spec: launcher | key_env(multiple candidates allowed) | best task ──
# row format: provider<TAB>launcher<TAB>key1[,key2]<TAB>best-task
PROVIDERS="$(cat <<'EOF'
deepseek	cc-deepseek	DEEPSEEK_API_KEY	reasoning / complex algorithms
glm	cc-glm	GLM_API_KEY,ZAI_API_KEY	Chinese docs / reasoning
kimi	cc-kimi	KIMI_API_KEY	long context (>50K)
qwen	cc-qwen	DASHSCOPE_API_KEY	SQL / Alibaba ecosystem
doubao	cc-doubao	ARK_API_KEY	general coding / Volcano ecosystem
minimax	cc-minimax	MINIMAX_API_KEY	math / general frontier
mimo	cc-mimo	MIMO_API_KEY	general / fallback
stepfun	cc-stepfun	STEPFUN_API_KEY	math / logic (thinking)
longcat	cc-longcat	LONGCAT_API_KEY	general
EOF
)"

say "╔══════════════════════════════════════════════╗"
say "║  fan-out workflow — environment recon + advisor ║"
say "╚══════════════════════════════════════════════╝"

# ── 1) core role CLIs ──
say ""; say "── core role CLIs ──"
declare -A ROLE
for spec in "claude:Planner/Executor (Claude Code)" "codex:Reviewer (independent frontier)" \
            "ccb:Dispatch bridge (multi-window fan-out)" "agy:Frontend (Antigravity)" \
            "opencode:alternate implementer/reviewer" "node:dep" "git:dep" "tmux:dep (ccb panes)"; do
  c="${spec%%:*}"; desc="${spec#*:}"
  if has "$c"; then ROLE[$c]=1; say "  $g $(printf '%-9s' "$c") $desc"
  else ROLE[$c]=0; say "  $x $(printf '%-9s' "$c") $desc"; fi
done

# ── 2) implementation backends (cc-* launcher + API key) ──
say ""; say "── implementation backends (launcher + API key) ──"
impl_ready=0; impl_nokey=0; impl_noinst=0
READY_LIST=""
while IFS=$'\t' read -r prov launcher keys task; do
  [ -n "$prov" ] || continue
  inst=$x; keyst=$x; state=""
  has "$launcher" && inst=$g
  IFS=',' read -ra kcands <<< "$keys"
  if key_configured "${kcands[@]}"; then keyst=$g; fi
  if [ "$inst" = "$g" ] && [ "$keyst" = "$g" ]; then
    state="ready"; impl_ready=$((impl_ready+1)); READY_LIST="$READY_LIST $launcher"
  elif [ "$inst" = "$g" ]; then
    state="missing key(${keys//,/ or })"; impl_nokey=$((impl_nokey+1))
  elif [ "$keyst" = "$g" ]; then
    state="missing launcher(install.sh)"; impl_noinst=$((impl_noinst+1))
  else state="not configured"; fi
  say "  launcher:$inst key:$keyst  $(printf '%-12s' "$launcher")  $(printf '%-16s' "$task")  $state"
done <<< "$PROVIDERS"

# ── 3) API config summary ──
say ""; say "── summary ──"
ncli=0; for c in claude codex ccb agy opencode; do [ "${ROLE[$c]:-0}" = 1 ] && ncli=$((ncli+1)); done
say "  Agent/CLI ready: $ncli (out of planner/reviewer/dispatch/frontend/alt)"
say "  implementation backends ready: $impl_ready / 9   (missing key $impl_nokey, missing launcher $impl_noinst)"

# ── 4) recommended workflow ──
say ""; say "── recommended workflow ──"
recs=""
add() { recs="$recs\n  • $1"; }

if [ "${ROLE[ccb]:-0}" = 1 ] && [ "$impl_ready" -ge 2 ] && [ "${ROLE[codex]:-0}" = 1 ]; then
  add "✅ full fan-out: ccb multi-window fan-out → $impl_ready backends implement in parallel(each its own worktree) → Codex reviews → Phase 5 bounded loop. Results go through fanout-cache + fan-in barrier(send N receive N)."
elif [ "$impl_ready" -ge 1 ] && [ "${ROLE[ccb]:-0}" = 0 ]; then
  add "⚙️ single-machine lite: no ccb → dispatch sequentially via the /cn:* plugin(no automatic review loop). Install ccb to unlock full fan-out."
elif [ "$impl_ready" -ge 1 ]; then
  add "⚙️ half setup: $impl_ready backend(s) available, fan out manually as needed."
else
  add "❌ no ready implementation backend yet: first ./backends/install.sh to install launchers, and configure API keys in ~/.config/cc-model-secrets.env."
fi

if [ "${ROLE[codex]:-0}" = 0 ]; then
  add "⚠️ no Codex(reviewer): review path degraded. Generation ≠ review still needs cross-vendor — use a strong Chinese-model backend(deepseek/minimax) as reviewer, **do not use Gemini**."
fi
if [ "${ROLE[agy]:-0}" = 1 ]; then
  add "🎨 agy available: give frontend/UI subtasks to Antigravity(manual or agy --print). Frontend only, does not enter the review loop / not a reviewer(backend=Gemini)."
else
  add "🎨 no agy: frontend goes through a manual IDE or some backend as fallback."
fi
if [ "${ROLE[claude]:-0}" = 0 ]; then
  add "⚠️ no claude(Claude Code): this workflow's executor/integration layer is missing, install @anthropic-ai/claude-code first."
fi
say "$(printf "$recs")"

# ── 5) best task allocation (ready backends) ──
if [ -n "$READY_LIST" ]; then
  say ""; say "── suggested task allocation for ready backends ──"
  while IFS=$'\t' read -r prov launcher keys task; do
    [ -n "$prov" ] || continue
    case " $READY_LIST " in *" $launcher "*) say "  $(printf '%-12s' "$launcher") → $task";; esac
  done <<< "$PROVIDERS"
  say "  (for measured optimal allocation see skill memory model-task-allocation benchmark)"
fi

if [ "$QUIET" -eq 1 ]; then
  echo "agents=$ncli backends_ready=$impl_ready/9 ccb=${ROLE[ccb]:-0} codex=${ROLE[codex]:-0} agy=${ROLE[agy]:-0}"
fi
