#!/usr/bin/env bash
# fanout-fleet.sh — start/inspect/stop ccb fleet (fixes "stuck queue, no worker")
#
# Solves two core problems:
#   1. **Strip CLAUDE_CODE_***: parent session's OAuth/session env leaks to child cc-* → fake 401.
#      Before up starts ccb, unset all CLAUDE_CODE_*, so each agent uses only its own provider key.
#   2. **headless tmux**: ccb's agent pane must live inside tmux; no tmux server means no worker.
#      up starts ccb -s inside a detached tmux session.
#
#   status [proj...]        whether each project's ccbd is ready (must check before preflight/dispatch)
#   up [--dry] [proj...]    strip CLAUDE_CODE_* + start ccb -s in detached tmux, self-verify after
#   down [proj...]          ccb kill
#   env: CCB_WORK(default ~/Projects/ccb-test) / CCB_CLAUDE(default ~/Projects/ccb-claude-only)
#        CCB_CLAUDE_PREFIX(claude pool start prefix, default "CLAUDE_START_CMD=claude ") / FANOUT_CCB(test stub)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCB="${FANOUT_CCB:-ccb}"
WORK="${CCB_WORK:-$HOME/Projects/ccb-test}"
CLAUDE_PROJ="${CCB_CLAUDE:-$HOME/Projects/ccb-claude-only}"
CLAUDE_PREFIX="${CCB_CLAUDE_PREFIX:-CLAUDE_START_CMD=claude }"

# Which start prefix this project uses (claude pool needs CLAUDE_START_CMD)
prefix_for(){ [ "$1" = "$CLAUDE_PROJ" ] && printf '%s' "$CLAUDE_PREFIX" || printf ''; }

# Build env -u strip args for CLAUDE_CODE_*
strip_args(){
  local v
  for v in $(compgen -v 2>/dev/null | grep '^CLAUDE_CODE' | sort -u); do printf -- '-u %s ' "$v"; done
}

# ready ⟺ mount_state: mounted (actually mounted). If ccbd is alive but unmounted, dispatch fails "ccbd is unmounted".
# Must not grep health/alive/running: 'health: unmounted' would false-match; and ccb ping returns
# 'desired_state: running' even when stopped (config intent ≠ actual state) → both falsely report ready, dispatch stuck in empty queue (doctoreel pitfall).
is_ready(){ (cd "$1" 2>/dev/null && "$CCB" ping ccbd 2>/dev/null | grep -qE '^mount_state:[[:space:]]*mounted'); }

cmd_status(){
  local projs=("$@"); [ "$#" -eq 0 ] && projs=("$WORK" "$CLAUDE_PROJ")
  local ready=0 p
  for p in "${projs[@]}"; do
    if [ ! -d "$p/.ccb" ]; then printf '  —  %s (no .ccb)\n' "$p"; continue; fi
    if is_ready "$p"; then printf '  ✓ ready   %s\n' "$p"; ready=$((ready+1))
    else printf '  ✗ down    %s  → fanout fleet up\n' "$p"; fi
  done
  [ "$ready" -gt 0 ]
}

# up: default detached tmux; --pty uses pty.fork fallback (when detached tmux fails); --dry only prints
cmd_up(){
  local dry=0 pty=0; local projs=()
  while [ "$#" -gt 0 ]; do case "$1" in --dry) dry=1;; --pty) pty=1;; *) projs+=("$1");; esac; shift; done
  [ "${#projs[@]}" -eq 0 ] && projs=("$WORK" "$CLAUDE_PROJ")
  local u; u="$(strip_args)"
  local p pre
  for p in "${projs[@]}"; do
    [ -d "$p/.ccb" ] || { echo "  ✗ $p no .ccb, skip"; continue; }
    if is_ready "$p"; then echo "  ✓ already running: $p"; continue; fi
    pre="$(prefix_for "$p")"
    if [ "$pty" -eq 1 ]; then
      # pty.fork: python strips CLAUDE_CODE_* internally; here just assemble target command
      local pycmd
      if [ -n "$pre" ]; then pycmd=(python3 "$HERE/fleet-launch.py" "$p" env "${pre% }" "$CCB" -s)
      else pycmd=(python3 "$HERE/fleet-launch.py" "$p" "$CCB" -s); fi
      if [ "$dry" -eq 1 ]; then echo "  [dry-pty] ${pycmd[*]}"; continue; fi
      command -v python3 >/dev/null 2>&1 || die "no python3"
      "${pycmd[@]}" && echo "  ▸ pty.fork started: $p" || echo "  ✗ pty.fork start failed: $p"
    else
      local sess cmd; sess="ccb-$(basename "$p")"; cmd="env ${u}${pre}$CCB -s"
      if [ "$dry" -eq 1 ]; then echo "  [dry] tmux new-session -d -s $sess -c $p \"$cmd\""; continue; fi
      command -v tmux >/dev/null 2>&1 || die "no tmux"
      tmux new-session -d -s "$sess" -c "$p" "$cmd" 2>/dev/null \
        && echo "  ▸ detached tmux '$sess' started: $p" || echo "  ✗ tmux start failed: $p"
    fi
  done
  [ "$dry" -eq 1 ] && return 0
  echo "  —— self-verify after a few seconds ——"; sleep 5
  cmd_status "${projs[@]}" || {
    echo "  ⚠ still not ready."
    [ "$pty" -eq 0 ] && echo "    detached tmux did not attach → try pty.fork fallback: fanout fleet up --pty"
    echo "    or do it manually in a real terminal:"
    for p in "${projs[@]}"; do [ -d "$p/.ccb" ] && echo "      cd $p && $(prefix_for "$p")$CCB -s"; done
  }
}

cmd_down(){
  local projs=("$@"); [ "$#" -eq 0 ] && projs=("$WORK" "$CLAUDE_PROJ")
  local p
  for p in "${projs[@]}"; do
    [ -d "$p/.ccb" ] || continue
    (cd "$p" && "$CCB" kill >/dev/null 2>&1) && echo "  ✓ killed: $p" || echo "  — not running: $p"
  done
}

sub="${1:-}"; shift || true
case "$sub" in
  status) cmd_status "$@";;
  up)     cmd_up "$@";;
  down)   cmd_down "$@";;
  ''|-h|--help) sed -n '2,15p' "$0";;
  *) die "unknown subcommand '$sub' (status|up|down)";;
esac
