#!/usr/bin/env bash
# fuguectl-template.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$HERE/fuguectl-template.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FUGUE_ENGINE_CLI="$TMP/fugue-engine"
export FUGUE_TEMPLATE_CALLS="$TMP/template-calls.txt"
# shellcheck source=/dev/null
. "$HERE/fuguectl-testlib.sh"

cat > "$FUGUE_ENGINE_CLI" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

fs.appendFileSync(process.env.FUGUE_TEMPLATE_CALLS, `${process.argv.slice(2).join(' ')}\n`);

const [root, name, ...args] = process.argv.slice(2);
if (root !== 'template') {
  console.error('expected template');
  process.exit(9);
}

const die = (message) => {
  console.error(message);
  process.exit(1);
};

let dir = '';
const vars = {};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--dir') {
    dir = args[i + 1] ?? '';
    i += 1;
  } else if (arg === '--set') {
    const raw = args[i + 1] ?? '';
    i += 1;
    const eq = raw.indexOf('=');
    if (eq <= 0) die(`--set format should be KEY=VALUE, got '${raw}'`);
    vars[raw.slice(0, eq)] = raw.slice(eq + 1);
  } else {
    die(`unknown arg '${arg}'`);
  }
}

if (!name) die('missing template name');
const file = path.join(dir, `${name}.md`);
if (!fs.existsSync(file)) die(`no template '${name}'`);

let content = fs.readFileSync(file, 'utf8');
for (const [key, value] of Object.entries(vars)) {
  content = content.split(`{{${key}}}`).join(value);
}
process.stdout.write(`${content.replace(/\n?$/u, '')}\n`);
EOF

echo "fuguectl-template tests"

out="$(bash "$T" impl --set ROLE=backend --set SCOPE=write-parser --set FILES=src/p.py)"
ok "impl template renders with substituted values" 'echo "$out" | grep -q "Your role: backend" && echo "$out" | grep -q "write-parser" && echo "$out" | grep -q "src/p.py"'
ok "set placeholders are replaced" '! echo "$out" | grep -q "{{ROLE}}"'

# unset placeholders are kept
out2="$(bash "$T" impl --set ROLE=x)"
ok "unset {{SCOPE}} is kept" 'echo "$out2" | grep -q "{{SCOPE}}"'

# review / analysis templates exist
ok "review template renders" 'bash "$T" review --set REVIEWER=Codex --set DIFF_RANGE=main...HEAD --set DIFF=x | grep -q "VERDICT: ACCEPTED"'
ok "analysis template renders" 'bash "$T" analysis --set ROLE=reviewer | grep -q "must use the Write tool"'

# errors
bash "$T" >/dev/null 2>&1; ok "no name → non-0" '[ "$?" -ne 0 ]'
bash "$T" nope >/dev/null 2>&1; ok "unknown template → non-0" '[ "$?" -ne 0 ]'
bash "$T" impl --set BADFORMAT >/dev/null 2>&1; ok "--set without = → non-0" '[ "$?" -ne 0 ]'
ok "shell delegates to engine CLI" 'grep -q "^template impl --dir .* --set ROLE=backend --set SCOPE=write-parser --set FILES=src/p.py$" "$FUGUE_TEMPLATE_CALLS"'

tdone
