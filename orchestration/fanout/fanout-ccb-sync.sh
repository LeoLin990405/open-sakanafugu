#!/usr/bin/env bash
# fanout-ccb-sync.sh — re-adapt after a ccb update (analogous to backends/bin/cc-sync for claude-code)
#
# Adaptations to do after a ccb upgrade (turning known pitfalls into automatic checks):
#   1. is the grafting dependency (api_shortcuts.py) still there —— claude+url grafting relies entirely on it
#   2. ccbd must restart —— `ccb update` does not restart a running daemon, old code keeps running (known pitfall)
#   3. re-run preflight (ccb.config still sound under the new version + no-Gemini)
#   4. record the new version, for next comparison
#
#   check            print current/last ccb version + whether drifted + grafting soundness
#   adapt [--apply]  if drifted, adapt: verify grafting → (--apply actually kills ccbd) → preflight → record version
#                    without --apply = dry-run (report only, does not touch ccbd / does not write stamp)
#   env: FANOUT_CCB(default ccb) / CCB_WORK / CCB_CLAUDE / FANOUT_STATE(default ~/.config/fanout) / CCB_INSTALL(override install path)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCB="${FANOUT_CCB:-ccb}"
STATE="${FANOUT_STATE:-$HOME/.config/fanout}"
STAMP="$STATE/ccb-version"

ccb_ver(){ "$CCB" version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
ccb_install(){
  if [ -n "${CCB_INSTALL:-}" ]; then printf '%s' "$CCB_INSTALL"; return; fi
  local p; p="$("$CCB" version 2>/dev/null | sed -n 's/.*Install path:[[:space:]]*//p' | head -1)"
  [ -n "$p" ] && printf '%s' "$p" || printf '%s' "$HOME/.local/share/codex-dual"
}
grafting_ok(){ local ins; ins="$(ccb_install)"; [ -n "$ins" ] && [ -f "$ins/lib/provider_profiles/api_shortcuts.py" ]; }

cmd_check(){
  local cur last; cur="$(ccb_ver)"; last="$(cat "$STAMP" 2>/dev/null || echo '(none)')"
  echo "ccb current: ${cur:-unknown}   last recorded: $last"
  [ -n "$cur" ] || { echo "  ⚠ cannot get ccb version (ccb not installed?)"; return 0; }
  if [ "$cur" != "$last" ]; then echo "  → version drift ($last → $cur): run 'fanout ccb-sync adapt --apply' to adapt"
  else echo "  ✓ no drift"; fi
  if grafting_ok; then echo "  ✓ grafting api_shortcuts.py present ($(ccb_install))"
  else echo "  ✗ grafting api_shortcuts.py is gone — claude+url grafting may break, check the new ccb version manually"; fi
}

cmd_adapt(){
  local apply=0; [ "${1:-}" = "--apply" ] && apply=1
  local cur last; cur="$(ccb_ver)"; last="$(cat "$STAMP" 2>/dev/null || echo '')"
  [ -n "$cur" ] || die "cannot get ccb version"
  if [ "$apply" -eq 1 ]; then echo "── ccb adapt (${last:-none} → $cur) ──"; else echo "── ccb adapt (${last:-none} → $cur) [dry-run] ──"; fi

  # 1) grafting dependency
  if grafting_ok; then echo "  ✓ grafting api_shortcuts.py present"
  else echo "  ✗ grafting dependency lost — new ccb may have changed provider_profiles, grafting scheme needs manual adaptation"; fi

  # 2) ccbd restart (ccb update does not restart a running daemon → old code)
  local proj
  for proj in "${CCB_WORK:-}" "${CCB_CLAUDE:-}"; do
    [ -n "$proj" ] || continue
    if [ "$apply" -eq 1 ]; then
      (cd "$proj" 2>/dev/null && "$CCB" kill >/dev/null 2>&1) && \
        echo "  ✓ kill ccbd @ $proj — next 'cd $proj && ccb' starts the daemon and loads new code (claude-only uses env CLAUDE_START_CMD=claude)"
    else
      echo "  [dry] need to restart ccbd @ $proj (ccb update does not auto-restart, old code keeps running)"
    fi
  done
  [ -z "${CCB_WORK:-}${CCB_CLAUDE:-}" ] && echo "  ⚠ CCB_WORK/CCB_CLAUDE unset — skip ccbd restart (set them and re-run)"

  # 3) config validation (--config-only: does not depend on ccbd being alive, since we may have just killed it above)
  if [ "$apply" -eq 1 ] && [ -n "${CCB_WORK:-}" ] && [ -f "$CCB_WORK/.ccb/ccb.config" ]; then
    echo "  config validation (no-Gemini + sound):"
    bash "$HERE/fanout-preflight.sh" --config-only "$CCB_WORK/.ccb/ccb.config" 2>&1 | sed 's/^/    /' || true
  fi

  # 4) record version
  if [ "$apply" -eq 1 ]; then mkdir -p "$STATE"; printf '%s\n' "$cur" > "$STAMP"; echo "  ✓ recorded $cur → $STAMP"
  else echo "  [dry] stamp not written; add --apply to commit"; fi
}

sub="${1:-}"; shift || true
case "$sub" in
  check) cmd_check "$@";;
  adapt) cmd_adapt "$@";;
  ''|-h|--help) sed -n '2,14p' "$0";;
  *) die "unknown subcommand '$sub' (check|adapt)";;
esac
