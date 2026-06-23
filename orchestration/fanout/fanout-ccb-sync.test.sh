#!/usr/bin/env bash
# fanout-ccb-sync.test.sh — use a stub ccb to test version drift + grafting + stamp (never touches real ccb)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/fanout-ccb-sync.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

# stub ccb: version → fake version + Install path; others(kill) → no-op
cat > "$TMP/ccb" <<EOF
#!/usr/bin/env bash
case "\$1" in
  version) echo "ccb (Claude Code Bridge) v9.9.9 abc 2026-01-01"; echo "Install path: $TMP/install";;
  *) exit 0;;
esac
EOF
chmod +x "$TMP/ccb"
export FANOUT_CCB="$TMP/ccb" FANOUT_STATE="$TMP/state" CCB_INSTALL="$TMP/install"
unset CCB_WORK CCB_CLAUDE 2>/dev/null || true

mkdir -p "$TMP/install/lib/provider_profiles"
touch "$TMP/install/lib/provider_profiles/api_shortcuts.py"

echo "fanout-ccb-sync tests"

out="$(bash "$S" check)"
ok "check reports version drift (none → v9.9.9)" 'echo "$out" | grep -q "version drift"'
ok "check: grafting api_shortcuts.py present" 'echo "$out" | grep -q "grafting api_shortcuts.py present"'

bash "$S" adapt >/dev/null 2>&1
ok "dry-run does not write stamp" '[ ! -f "$FANOUT_STATE/ccb-version" ]'

bash "$S" adapt --apply >/dev/null 2>&1
ok "apply writes stamp=current version" 'grep -q "v9.9.9" "$FANOUT_STATE/ccb-version" 2>/dev/null'

out2="$(bash "$S" check)"
ok "after apply check shows no drift" 'echo "$out2" | grep -q "no drift"'

rm "$TMP/install/lib/provider_profiles/api_shortcuts.py"
out3="$(bash "$S" check)"
ok "missing grafting is detected" 'echo "$out3" | grep -q "api_shortcuts.py is gone"'

# adapt with CCB_WORK + clean config → run --config-only validation (stub ccb, never touches real ccbd)
touch "$TMP/install/lib/provider_profiles/api_shortcuts.py"   # restore grafting
mkdir -p "$TMP/work/.ccb"
printf '[agents.cc-deepseek]\nmodel = "deepseek-v4-pro"\n' > "$TMP/work/.ccb/ccb.config"
out4="$(CCB_WORK="$TMP/work" bash "$S" adapt --apply 2>&1)"
ok "adapt with CCB_WORK runs config validation" 'echo "$out4" | grep -q "config validation"'
ok "adapt with CCB_WORK still records stamp" 'grep -q "v9.9.9" "$FANOUT_STATE/ccb-version"'

bash "$S" nope >/dev/null 2>&1; ok "unknown subcommand → nonzero" '[ "$?" -ne 0 ]'

tdone
