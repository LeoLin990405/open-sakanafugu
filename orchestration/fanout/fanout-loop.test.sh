#!/usr/bin/env bash
# fanout-loop.test.sh — fanout-loop.sh state machine self-test (exit-state decision + keep-best)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP="$HERE/fanout-loop.sh"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FANOUT_CACHE="$TMP/cache"
cd "$TMP" || exit 1

# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"
# decide first-line token; standalone function to avoid pipefail eating the exit code
tok(){ bash "$LOOP" decide 2>/dev/null | head -1; }
ec(){ bash "$LOOP" decide >/dev/null 2>&1; echo $?; }

echo "fanout-loop tests"

# not init → record/decide error
bash "$LOOP" decide >/dev/null 2>&1; ok "not init decide → non-0" '[ "$?" -ne 0 ]'
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 1 >/dev/null 2>&1; ok "not init record → non-0" '[ "$?" -ne 0 ]'

# init
bash "$LOOP" init --max 3 --best-sha sha0 >/dev/null
ok "init writes meta max=3" 'grep -q "max_rounds=3" "$FANOUT_CACHE/loop/meta"'
ok "init best_n=-1 (unset)" 'grep -q "best_n=-1" "$FANOUT_CACHE/loop/meta"'
bash "$LOOP" decide >/dev/null 2>&1; ok "after init no round → decide non-0" '[ "$?" -ne 0 ]'

# round1 NEEDS FIX, findings=3 → CONTINUE (not at cap, single round cannot tell divergence)
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 3 --sha sha1 >/dev/null
ok "round1 NEEDSFIX → CONTINUE" '[ "$(tok)" = CONTINUE ]'
ok "CONTINUE exit=10" '[ "$(ec)" -eq 10 ]'
# keep-best: first record → best_n=3, best_sha=sha1
ok "first record updates best_n=3" 'grep -q "best_n=3" "$FANOUT_CACHE/loop/meta"'
ok "first record updates best_sha=sha1" 'grep -q "best_sha=sha1" "$FANOUT_CACHE/loop/meta"'

# round2 findings=2 (decreased) → keep-best updates, and not diverged → CONTINUE
bash "$LOOP" record 2 --gate pass --verdict NEEDSFIX --findings 2 --sha sha2 >/dev/null
ok "round2 findings decreased → best updates n=2" 'grep -q "best_n=2" "$FANOUT_CACHE/loop/meta"'
ok "round2 findings decreased → CONTINUE" '[ "$(tok)" = CONTINUE ]'

# round3 reaches max=3 still NEEDS FIX → ESCALATE_MAX
bash "$LOOP" record 3 --gate fail --verdict NEEDSFIX --findings 2 --sha sha3 >/dev/null
ok "round3 reaches max → ESCALATE_MAX" '[ "$(tok)" = ESCALATE_MAX ]'
ok "ESCALATE_MAX exit=20" '[ "$(ec)" -eq 20 ]'
# keep-best: findings 2 not smaller than best 2 → does not update best_sha (still sha2)
ok "no improvement → best_sha stays sha2" 'grep -q "best_sha=sha2" "$FANOUT_CACHE/loop/meta"'

# non-convergence: two consecutive rounds findings not decreasing (3 → 3)
bash "$LOOP" init --max 5 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 3 >/dev/null
bash "$LOOP" record 2 --gate pass --verdict NEEDSFIX --findings 3 >/dev/null
ok "findings not decreasing two rounds → ESCALATE_NONCONV" '[ "$(tok)" = ESCALATE_NONCONV ]'

# non-convergence: explicit --same-class (even if findings decreased)
bash "$LOOP" init --max 5 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 5 >/dev/null
bash "$LOOP" record 2 --gate pass --verdict NEEDSFIX --findings 2 --same-class >/dev/null
ok "explicit same-class → ESCALATE_NONCONV" '[ "$(tok)" = ESCALATE_NONCONV ]'

# first ACCEPTED → CONFIRM (needs second confirmation)
bash "$LOOP" init --max 5 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 1 >/dev/null
bash "$LOOP" record 2 --gate pass --verdict ACCEPTED --findings 0 >/dev/null
ok "first ACCEPTED → CONFIRM" '[ "$(tok)" = CONFIRM ]'
ok "CONFIRM exit=10" '[ "$(ec)" -eq 10 ]'

# second ACCEPTED → DONE (second independent confirmation)
bash "$LOOP" record 3 --gate pass --verdict ACCEPTED --findings 0 >/dev/null
ok "second ACCEPTED → DONE" '[ "$(tok)" = DONE ]'
ok "DONE exit=0" '[ "$(ec)" -eq 0 ]'

# verdict case/alias normalize
bash "$LOOP" init --max 3 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict "needs fix" --findings 1 >/dev/null 2>&1
ok "verdict 'needs fix' normalized to NEEDSFIX" '[ "$(cut -f3 "$FANOUT_CACHE/loop/rounds.tsv" | tail -1)" = NEEDSFIX ]'

# invalid arguments
bash "$LOOP" record 1 --gate bogus --verdict ACCEPTED --findings 0 >/dev/null 2>&1; ok "invalid gate → non-0" '[ "$?" -ne 0 ]'
bash "$LOOP" record 1 --gate pass --verdict ACCEPTED --findings -1 >/dev/null 2>&1; ok "negative findings → non-0" '[ "$?" -ne 0 ]'

# status has rounds header (command substitution capture, avoiding pipefail+grep -q SIGPIPE)
ok "status has round header" 'case "$(bash "$LOOP" status)" in *round*) true;; *) false;; esac'

# ── auto-fix / ask-user finding split (borrowed from no-mistakes) ──
# this round has intent-touching finding → ASK_USER (exit 11), do not let Claude auto-patch
bash "$LOOP" init --max 5 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 3 --ask-user 1 >/dev/null
ok "has ask-user finding → ASK_USER" '[ "$(tok)" = ASK_USER ]'
ok "ASK_USER exit=11" '[ "$(ec)" -eq 11 ]'
# all mechanical (ask-user 0) → still CONTINUE (backward compatible)
bash "$LOOP" init --max 5 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 3 --ask-user 0 >/dev/null
ok "ask-user=0(all mechanical) → CONTINUE" '[ "$(tok)" = CONTINUE ]'
# priority: at cap still NEEDS FIX even with ask-user → ESCALATE_MAX overrides ASK_USER
bash "$LOOP" init --max 1 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 2 --ask-user 1 >/dev/null
ok "at cap + ask-user → ESCALATE_MAX(overrides ASK_USER)" '[ "$(tok)" = ESCALATE_MAX ]'
# priority: non-convergence + ask-user → ESCALATE_NONCONV overrides ASK_USER
bash "$LOOP" init --max 5 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 3 >/dev/null
bash "$LOOP" record 2 --gate pass --verdict NEEDSFIX --findings 3 --ask-user 1 >/dev/null
ok "non-convergence + ask-user → ESCALATE_NONCONV(overrides)" '[ "$(tok)" = ESCALATE_NONCONV ]'
# ACCEPTED with ask-user has no effect (findings 0 ask 0)
# validate: --ask-user > --findings → non-0
bash "$LOOP" init --max 5 >/dev/null
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 1 --ask-user 2 >/dev/null 2>&1; ok "ask-user > findings → non-0" '[ "$?" -ne 0 ]'
bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 2 --ask-user -1 >/dev/null 2>&1; ok "negative ask-user → non-0" '[ "$?" -ne 0 ]'
# status has ask-user column
bash "$LOOP" init --max 3 >/dev/null; bash "$LOOP" record 1 --gate pass --verdict NEEDSFIX --findings 2 --ask-user 1 >/dev/null
ok "status has ask-user column" 'case "$(bash "$LOOP" status)" in *ask-user*) true;; *) false;; esac'

tdone
