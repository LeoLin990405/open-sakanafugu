#!/usr/bin/env bash
# fanout-fleet.test.sh — test up --dry(command/strip) + status(stub) + down; never really starts the fleet
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
F="$HERE/fanout-fleet.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/work/.ccb" "$TMP/claude/.ccb"
export CCB_WORK="$TMP/work" CCB_CLAUDE="$TMP/claude"
export CLAUDE_CODE_TEST_X=1   # simulate OAuth env that would leak to child cc-*
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"

# not-ready stub (ping no output)
notready(){ printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/ccb"; chmod +x "$TMP/ccb"; }
# ready stub (ping ccbd → mount_state: mounted)
ready(){ printf '#!/usr/bin/env bash\ncase "$1 $2" in "ping ccbd") printf "mount_state: mounted\\nhealth: alive\\n";; esac\nexit 0\n' > "$TMP/ccb"; chmod +x "$TMP/ccb"; }
# unmounted stub (ccbd alive but not mounted → dispatch fails; old grep would falsely report ready, regression test)
unmounted(){ printf '#!/usr/bin/env bash\ncase "$1 $2" in "ping ccbd") printf "mount_state: unmounted\\nhealth: unmounted\\n";; esac\nexit 0\n' > "$TMP/ccb"; chmod +x "$TMP/ccb"; }
export FANOUT_CCB="$TMP/ccb"

echo "fanout-fleet tests"

notready
out="$(bash "$F" up --dry)"
ok "up --dry strips CLAUDE_CODE_*(incl TEST_X)" 'echo "$out" | grep -q -- "-u CLAUDE_CODE_TEST_X"'
ok "up --dry includes ccb -s start" 'echo "$out" | grep -q "ccb -s"'
ok "up --dry covers both projects" 'echo "$out" | grep -q work && echo "$out" | grep -q claude'
ok "claude pool carries CLAUDE_START_CMD prefix" 'echo "$out" | grep claude | grep -q "CLAUDE_START_CMD=claude"'
ok "work pool has no claude prefix" '! (echo "$out" | grep "/work " | grep -q "CLAUDE_START_CMD")'

# pty.fork fallback dry
outp="$(bash "$F" up --pty --dry)"
ok "up --pty --dry uses fleet-launch.py" 'echo "$outp" | grep -q fleet-launch.py'
ok "up --pty --dry includes ccb -s" 'echo "$outp" | grep -q "ccb -s"'

# fleet-launch.py real mechanism(harmless command): strip CLAUDE_CODE_* + run inside project + detach
if command -v python3 >/dev/null 2>&1; then
  # pty.fork-dependent checks: skip (not fail) when the host is out of pty devices — environmental, not a code defect.
  if python3 -c $'import pty,os,sys\ntry:\n p,_=pty.fork()\nexcept OSError:\n sys.exit(1)\nif p==0: os._exit(0)\nos.waitpid(p,0)' 2>/dev/null; then
    rm -f "$TMP/work/launch.out"
    python3 "$HERE/fleet-launch.py" "$TMP/work" sh -c 'env > launch.out'
    sleep 1
    ok "fleet-launch runs inside project(cwd proof)" '[ -f "$TMP/work/launch.out" ]'
    ok "fleet-launch strips CLAUDE_CODE_*" '[ -f "$TMP/work/launch.out" ] && ! grep -q CLAUDE_CODE_TEST_X "$TMP/work/launch.out"'
    # status-pipe contract: caller sees exit 0 once the worker actually launched
    python3 "$HERE/fleet-launch.py" "$TMP/work" sh -c true; ok "fleet-launch returns 0 on successful launch" '[ "$?" -eq 0 ]'
  else
    skip "fleet-launch runs inside project(cwd proof)" "out of ptys"
    skip "fleet-launch strips CLAUDE_CODE_*" "out of ptys"
    skip "fleet-launch returns 0 on successful launch" "out of ptys"
  fi
  python3 "$HERE/fleet-launch.py" >/dev/null 2>&1; ok "fleet-launch no args → nonzero" '[ "$?" -ne 0 ]'
fi

ok "status(not-ready) reports down" 'o=$(bash "$F" status 2>&1); grep -q down <<<"$o"'

ready
ok "status(ready stub=mounted) reports ready" 'o=$(bash "$F" status 2>&1); grep -q ready <<<"$o"'

# regression: ccbd alive but unmounted must report down(not falsely ready), else dispatch stuck in empty queue
unmounted
ok "status(unmounted: alive but not mounted) reports down not ready" 'o=$(bash "$F" status 2>&1); grep -q down <<<"$o" && ! grep -q "✓ ready" <<<"$o"'
# regression: ccb ping returns desired_state: running even when stopped(config intent ≠ actual mount), not ready
printf '#!/usr/bin/env bash\necho "desired_state: running"\n' > "$TMP/ccb"; chmod +x "$TMP/ccb"
ok "status(desired_state:running config intent ≠ mount) reports down" 'o=$(bash "$F" status 2>&1); grep -q down <<<"$o"'

bash "$F" down >/dev/null 2>&1; ok "down does not error" '[ "$?" -eq 0 ]'
bash "$F" bogus >/dev/null 2>&1; ok "unknown subcommand → nonzero" '[ "$?" -ne 0 ]'

tdone
