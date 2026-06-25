#!/usr/bin/env bash
# fuguectl-doctor.test.sh — shell shim tests for the TypeScript doctor
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$HERE/fuguectl-doctor.sh"
FG="$HERE/fuguectl"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FUGUE_ENGINE_CLI="$TMP/fugue-engine"
export FUGUE_DOCTOR_CALLS="$TMP/doctor-calls.txt"
# shellcheck source=/dev/null
. "$HERE/fuguectl-testlib.sh"

cat > "$FUGUE_ENGINE_CLI" <<'EOF'
const fs = require('node:fs');

fs.appendFileSync(process.env.FUGUE_DOCTOR_CALLS, `${process.argv.slice(2).join(' ')}\n`);

const [root, ...args] = process.argv.slice(2);
if (root !== 'doctor') {
  console.error('expected doctor');
  process.exit(9);
}

if (args.includes('--quiet')) {
  process.stdout.write('agents=3 backends_ready=2/9 fugue-cc=1 codex=1 agy=0\n');
} else {
  process.stdout.write('roles:\n  ✓ codex\nbackends:\n  ✓ cc-deepseek (ready)\n\nrecommended:\n  • full fleet workflow\n');
}
EOF

echo "fuguectl-doctor tests"

out="$(bash "$D")"
ok "doctor reports roles" 'echo "$out" | grep -q "^roles:"'
ok "doctor reports recommendation" 'echo "$out" | grep -q "recommended:"'

quiet="$(bash "$D" --quiet)"
ok "quiet summary survives" 'echo "$quiet" | grep -q "^agents=3 backends_ready=2/9"'

top="$(bash "$FG" doctor --quiet)"
ok "top-level doctor entrypoint works" 'echo "$top" | grep -q "fugue-cc=1"'
ok "shell delegates to engine CLI" 'grep -q "^doctor --quiet$" "$FUGUE_DOCTOR_CALLS"'

tdone
