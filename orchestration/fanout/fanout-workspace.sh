#!/usr/bin/env bash
# fanout-workspace.sh — Workspace context isolation (inspired by Zleap-Agent)
# Core: don't feed a (small) model the whole context — per "station", give only what that task should see.
# Context = System Prompt + Workspace Prompt + Tools + Memory + History
#   list                        list workspaces
#   show  <name>                print workspace raw fields
#   model <name>                resolve model (models: @bench:<type> goes through allocation)
#   context <name> [--task T]   assemble and print layered context (prompt prefix fed to this station's agent)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WSDIR="${FANOUT_WORKSPACES:-$HERE/workspaces}"
wsfile(){ printf '%s/%s.workspace' "$WSDIR" "$1"; }
field(){ sed -n "s/^$1:[[:space:]]*//p" "$2" | head -1; }

resolve_models(){  # @bench:<type> → through allocation; otherwise verbatim
  case "$1" in
    @bench:*) bash "$HERE/fanout-allocate.sh" "${1#@bench:}" 2>/dev/null;;
    *) printf '%s' "$1";;
  esac
}

cmd_list(){
  local f n
  for f in "$WSDIR"/*.workspace; do
    [ -e "$f" ] || continue
    n="$(basename "$f" .workspace)"
    printf '  %-10s %s\n' "$n" "$(field prompt "$f" | cut -c1-44)"
  done
}

cmd_show(){ local f; f="$(wsfile "${1:-}")"; [ -f "$f" ] || die "no workspace '${1:-}' (see list)"; cat "$f"; }

cmd_model(){ local f; f="$(wsfile "${1:-}")"; [ -f "$f" ] || die "no workspace '${1:-}'"; resolve_models "$(field models "$f")"; }

cmd_context(){
  local name="${1:-}"; shift || true
  local f; f="$(wsfile "$name")"; [ -f "$f" ] || die "no workspace '$name' (see list)"
  local task=""
  while [ "$#" -gt 0 ]; do case "$1" in --task) task="${2:-}"; shift 2;; *) die "unknown arg '$1'";; esac; done
  local models; models="$(resolve_models "$(field models "$f")")"

  echo "## Context — workspace: $name"
  echo ""
  echo "### System Prompt"
  [ -f "$WSDIR/_system.md" ] && cat "$WSDIR/_system.md"
  echo ""
  echo "### Workspace Prompt"
  field prompt "$f"
  echo ""
  echo "### Tools"
  printf '%s  (only this station enabled, the rest not exposed)\n' "$(field tools "$f" | tr ',' ' ')"
  local sk; sk="$(field skills "$f")"
  [ -n "$sk" ] && printf 'skills: %s\n' "$sk"
  echo ""
  echo "### Memory"
  printf 'scope: %s  (only memory relevant to this scope, not the full archive)\n' "$(field memory "$f")"
  # Experience memory: inject reusable methods accumulated for this station (inspired by Zleap)
  local exp; exp="$(bash "$HERE/fanout-experience.sh" recall "$name" --limit 3 2>/dev/null || true)"
  [ -n "$exp" ] && { echo ""; printf '%s\n' "$exp"; }
  echo ""
  echo "### History"
  echo "last few conversation rounds + key execution trace (not the full transcript)"
  [ -n "$task" ] && { echo ""; echo "### Task"; printf '%s\n' "$task"; }
  [ -n "$models" ] && { echo ""; printf '> suggested model(bench): %s\n' "$models"; }
}

sub="${1:-}"; shift || true
case "$sub" in
  list)    cmd_list;;
  show)    cmd_show    "$@";;
  model)   cmd_model   "$@";;
  context) cmd_context "$@";;
  ''|-h|--help) sed -n '2,12p' "$0";;
  *) die "unknown subcommand '$sub' (list|show|model|context)";;
esac
