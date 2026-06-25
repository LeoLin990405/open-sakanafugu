#!/usr/bin/env bash
# check-shell.sh — launcher/script syntax + static checks (shared by local / CI / pre-commit)
#   1) bash -n syntax check (always runs)
#   2) shellcheck static check (runs only if installed, via .shellcheckrc; guaranteed present in CI)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

# Collect all bash scripts: launchers (no extension, identified by shebang) + *.sh
mapfile -t SCRIPTS < <(
  { ls backends/bin/*-code backends/bin/cc-models backends/bin/cc-sync orchestration/fanout/fanout orchestration/fanout/fuguectl 2>/dev/null
    find backends scripts orchestration -name '*.sh' 2>/dev/null
  } | sort -u
)

fail=0

echo "── bash -n syntax (${#SCRIPTS[@]} scripts) ──"
for f in "${SCRIPTS[@]}"; do
  if bash -n "$f" 2>/dev/null; then :; else echo "  ✗ syntax: $f"; fail=1; fi
done
[ "$fail" -eq 0 ] && echo "  ✓ all pass"

if command -v shellcheck >/dev/null 2>&1; then
  echo "── shellcheck -S warning (via .shellcheckrc) ──"
  if shellcheck -S warning "${SCRIPTS[@]}"; then
    echo "  ✓ 0 warnings"
  else
    echo "  ✗ shellcheck has findings"; fail=1
  fi
else
  echo "── shellcheck not installed, skipping (CI will run it) ──"
fi

exit "$fail"
