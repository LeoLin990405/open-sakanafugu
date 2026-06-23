#!/usr/bin/env bash
# fanout-goal.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G="$HERE/fanout-goal.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

echo "fanout-goal tests"

ok "template has outcome+gate" 'bash "$G" template | grep -q "outcome:" && bash "$G" template | grep -q "gate:"'

printf 'outcome: example\ngate: true\nrubric: no regression\nrounds: 2\n' > "$TMP/g.spec"
bash "$G" check "$TMP/g.spec" >/dev/null 2>&1; ok "gate=true → check met(0)" '[ "$?" -eq 0 ]'

printf 'outcome: bad\ngate: false\n' > "$TMP/bad.spec"
bash "$G" check "$TMP/bad.spec" >/dev/null 2>&1; ok "gate=false → not met(non-0)" '[ "$?" -ne 0 ]'

# Note: capture then grep via here-string, to avoid pipefail + grep -q closing the pipe early causing producer SIGPIPE(141)
ok "show parses outcome=example" 'o=$(bash "$G" show "$TMP/g.spec"); grep -q "outcome:  example" <<<"$o"'
ok "show parses rounds=2" 'o=$(bash "$G" show "$TMP/g.spec"); grep -q "rounds:   2" <<<"$o"'

# gate with && compound command
printf 'outcome: x\ngate: true && true\n' > "$TMP/cmp.spec"
bash "$G" check "$TMP/cmp.spec" >/dev/null 2>&1; ok "compound gate(&&) evaluates correctly" '[ "$?" -eq 0 ]'

printf 'outcome: no gate\n' > "$TMP/nogate.spec"
bash "$G" check "$TMP/nogate.spec" >/dev/null 2>&1; ok "no gate line → non-0" '[ "$?" -ne 0 ]'
bash "$G" check /no/such >/dev/null 2>&1; ok "spec not exist → non-0" '[ "$?" -ne 0 ]'
bash "$G" bogus >/dev/null 2>&1; ok "unknown subcommand → non-0" '[ "$?" -ne 0 ]'

tdone
