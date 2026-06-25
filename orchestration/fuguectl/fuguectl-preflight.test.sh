#!/usr/bin/env bash
# fuguectl-preflight.test.sh — test --config-only mode (no-Gemini guard + config soundness, no fugue-cc dependency)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P="$HERE/fuguectl-preflight.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FUGUE_ENGINE_CLI="$TMP/fugue-engine"
export FUGUE_PREFLIGHT_CALLS="$TMP/preflight-calls.txt"

# shellcheck source=/dev/null
. "$HERE/fuguectl-testlib.sh"

cat > "$FUGUE_ENGINE_CLI" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

fs.appendFileSync(process.env.FUGUE_PREFLIGHT_CALLS, `${process.argv.slice(2).join(' ')}\n`);

const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const positional = args.filter((arg, index) => {
  if (arg.startsWith('--')) return false;
  const prev = args[index - 1] || '';
  return !prev.startsWith('--') || prev === '--config-only' || prev === '--probe';
});
const root = positional[0];
const cfg = positional[1] || '';
if (root !== 'preflight') {
  console.error('expected preflight');
  process.exit(2);
}

let failed = false;
let warned = false;
const lines = ['── parallel dispatch preflight ──'];
const ok = (message) => lines.push(`  ✓ ${message}`);
const warn = (message) => { warned = true; lines.push(`  ⚠ ${message}`); };
const fail = (message) => { failed = true; lines.push(`  ✗ ${message}`); };

if (cfg && fs.existsSync(cfg)) {
  const text = fs.readFileSync(cfg, 'utf8');
  if (/^[^#]*(model|url)\s*=.*(gemini|antigravity)/imu.test(text)) {
    fail('provider config model/url contains gemini/antigravity — violates the no-Gemini hard rule');
  } else ok('no-Gemini guard passed');
  const modelCount = text.split(/\r?\n/u).filter((line) => /^\s*model\s*=/u.test(line)).length;
  if (modelCount > 0) ok(`provider config: ${modelCount} agent(s) configured a model`);
  else warn('provider config has no model line?');
  if (/^\s*model\s*=\s*"?"?\s*$/imu.test(text)) fail('provider config has an empty model value');
} else {
  warn('provider config not located — skip config checks (pass a path or set FUGUE_CC_WORK)');
}

const work = opt('--work');
if (work) {
  const gitignore = path.join(work, '.gitignore');
  if (fs.existsSync(gitignore) && fs.readFileSync(gitignore, 'utf8').includes('.fugue-cc/')) {
    ok(".fugue-cc/ gitignored (integrate won't be polluted by worktree)");
  } else {
    warn(`.fugue-cc/ not gitignored — on integrate the main repo git may absorb the worktree(embedded repo); fix: echo '.fugue-cc/' >> ${work}/.gitignore`);
  }
}

lines.push('', failed ? '✗ preflight NO-GO  (1 hard failure(s))' : `✓ preflight GO  (warn=${warned ? '1' : '0'})`);
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(failed ? 1 : 0);
EOF

echo "fuguectl-preflight tests"

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

# .fugue-cc/ gitignore guard (relies on git only; isolate-test with a temp repo + clean config)
GW="$TMP/provider-work"; mkdir -p "$GW"
git -C "$GW" init -q 2>/dev/null
out_ign="$(FUGUE_CC_WORK="$GW" bash "$P" --config-only "$TMP/clean.config" 2>&1)"
ok ".fugue-cc/ not gitignored → warn hint" 'case "$out_ign" in *"not gitignored"*) true;; *) false;; esac'
printf '.fugue-cc/\n' > "$GW/.gitignore"
out_ok="$(FUGUE_CC_WORK="$GW" bash "$P" --config-only "$TMP/clean.config" 2>&1)"
ok ".fugue-cc/ gitignored → ok" 'case "$out_ok" in *"gitignored"*) true;; *) false;; esac'
FUGUE_CC_WORK="$GW" bash "$P" --config-only "$TMP/clean.config" >/dev/null 2>&1
ok ".fugue-cc gitignore check is warn level, does not block GO" '[ "$?" -eq 0 ]'
ok "shell delegates to engine CLI" 'grep -q "^preflight --bin .* --cache-script .* --config-only " "$FUGUE_PREFLIGHT_CALLS"'

tdone
