#!/usr/bin/env bash
# fanout-preflight.test.sh — test --config-only mode (no-Gemini guard + config soundness, no ccb dependency)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P="$HERE/fanout-preflight.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-preflight tests"

# clean config → GO
cat > "$TMP/clean.config" <<'EOF'
[agents.cc-deepseek]
url = "https://api.deepseek.com/anthropic"
model = "deepseek-v4-pro"
[agents.coder]
model = "gpt-5.5"
EOF
bash "$P" --config-only "$TMP/clean.config" >/dev/null 2>&1
ok "clean config → GO(exit 0)" '[ "$?" -eq 0 ]'

# model contains gemini → no-Gemini guard NO-GO
cat > "$TMP/gemini.config" <<'EOF'
[agents.cc-x]
model = "gemini-3.5-flash"
EOF
bash "$P" --config-only "$TMP/gemini.config" >/dev/null 2>&1
ok "model=gemini → NO-GO(exit 1)" '[ "$?" -ne 0 ]'

# url contains antigravity → NO-GO
cat > "$TMP/agy.config" <<'EOF'
[agents.cc-y]
url = "https://antigravity.google/api"
model = "x"
EOF
bash "$P" --config-only "$TMP/agy.config" >/dev/null 2>&1
ok "url=antigravity → NO-GO" '[ "$?" -ne 0 ]'

# gemini appearing in a comment should not false-kill (only model=/url= values are checked)
cat > "$TMP/comment.config" <<'EOF'
# do not use gemini / antigravity
[agents.cc-z]
model = "glm-5.2"
EOF
bash "$P" --config-only "$TMP/comment.config" >/dev/null 2>&1
ok "comment mentioning gemini not false-killed → GO" '[ "$?" -eq 0 ]'

# empty model value → NO-GO
cat > "$TMP/empty.config" <<'EOF'
[agents.cc-w]
model = ""
EOF
bash "$P" --config-only "$TMP/empty.config" >/dev/null 2>&1
ok "empty model value → NO-GO" '[ "$?" -ne 0 ]'

# .ccb/ gitignore guard (relies on git only; isolate-test with a temp repo + clean config)
GW="$TMP/ccbwork"; mkdir -p "$GW"
git -C "$GW" init -q 2>/dev/null
out_ign="$(CCB_WORK="$GW" bash "$P" --config-only "$TMP/clean.config" 2>&1)"
ok ".ccb/ not gitignored → warn hint" 'case "$out_ign" in *"not gitignored"*) true;; *) false;; esac'
printf '.ccb/\n' > "$GW/.gitignore"
out_ok="$(CCB_WORK="$GW" bash "$P" --config-only "$TMP/clean.config" 2>&1)"
ok ".ccb/ gitignored → ok" 'case "$out_ok" in *"gitignored"*) true;; *) false;; esac'
CCB_WORK="$GW" bash "$P" --config-only "$TMP/clean.config" >/dev/null 2>&1
ok ".ccb gitignore check is warn level, does not block GO" '[ "$?" -eq 0 ]'

tdone
