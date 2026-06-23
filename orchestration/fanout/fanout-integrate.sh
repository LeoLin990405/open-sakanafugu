#!/usr/bin/env bash
# fanout-integrate.sh — Phase 3 integrate: cherry-pick each agent worktree's changes back to main branch
#
# Replaces the SKILL.md naked shell that "breaks the whole loop on conflict": a conflict is isolated to a single agent
# (cherry-pick --abort keeps main clean), the other agents keep integrating, and a summary table is given at the end.
# Model = git worktree (worktree shares the object store with the main repo, so the main repo can pick a worktree branch's SHA).
#
#   --work <repo>          main repo (cherry-pick target; must be a git repo)
#   --agents "a b c"       agents to integrate (worktree names), space-separated
#   --ws-parent <dir>      worktree parent dir (relative to work or absolute; default .ccb/workspaces)
#   --onconflict abort|skip  conflict handling: abort=give up that agent, keep main clean(default) / skip=leave conflict for human
#   --ownership <file>     out-of-bounds detection list (borrowed from Lynn: enforced on the orchestrator side, do not trust worker self-discipline). TSV per line:
#                          agent<TAB>owned-globs<TAB>forbidden-globs (comma-separated; owned empty/`*`=unrestricted)
#                          worker changed a file outside owned / matching forbidden → mark violation, do not integrate
#   --task <file>          append the summary into the TASK file (optional)
#   --dry                  only print who would be integrated, do not touch git
#
# Each agent: out-of-bounds check → worktree has uncommitted changes → add+commit(as the agent) → main repo cherry-pick.
# Exit codes: 0 = all picked/no-change / 1 = conflict or out-of-bounds(isolated, listed in report) / 2 = usage error
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"

work=""; agents=""; ws_parent=".ccb/workspaces"; onconflict="abort"; ownership=""; task=""; dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --work)       work="${2:-}"; shift 2;;
    --agents)     agents="${2:-}"; shift 2;;
    --ws-parent)  ws_parent="${2:-}"; shift 2;;
    --onconflict) onconflict="${2:-}"; shift 2;;
    --ownership)  ownership="${2:-}"; shift 2;;
    --task)       task="${2:-}"; shift 2;;
    --dry)        dry=1; shift;;
    *) die "unknown argument '$1'";;
  esac
done
[ -n "$work" ] || die "need --work <repo>"
[ -d "$work/.git" ] || git -C "$work" rev-parse --git-dir >/dev/null 2>&1 || die "--work is not a git repo: $work"
[ -n "$agents" ] || die "need --agents \"a b c\""
case "$onconflict" in abort|skip) ;; *) die "--onconflict must be abort|skip";; esac
[ -z "$ownership" ] || [ -f "$ownership" ] || die "--ownership file not found: $ownership"

# worktree absolute path (ws_parent absolute → use directly, else relative to work)
wt_path(){ case "$ws_parent" in /*) printf '%s/%s' "$ws_parent" "$1";; *) printf '%s/%s/%s' "$work" "$ws_parent" "$1";; esac; }

# out-of-bounds detection (borrowed from Lynn: enforce ownership/forbidden on the orchestrator side, do not trust worker self-discipline)
_match_any(){  # whether file matches any glob in the comma list
  local f="$1" globs="$2" g; local IFS=','
  for g in $globs; do
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254  # $g is a glob pattern, intentionally unquoted (glob matching is wanted)
    case "$f" in $g) return 0;; esac
  done
  return 1
}
own_line(){ [ -n "$ownership" ] && awk -F'\t' -v a="$1" '$1==a{print $2"\t"$3; exit}' "$ownership"; }
# output out-of-bounds files (empty=not out-of-bounds or not in list=unrestricted)
check_violation(){
  local ag="$1" changed="$2" line owned forbidden f bad=""
  line="$(own_line "$ag")"; [ -n "$line" ] || { printf ''; return 0; }
  owned="$(printf '%s' "$line" | cut -f1)"; forbidden="$(printf '%s' "$line" | cut -f2)"
  for f in $changed; do
    [ -n "$f" ] || continue
    if [ -n "$forbidden" ] && _match_any "$f" "$forbidden"; then bad="$bad $f"; continue; fi
    case "$owned" in ''|'*') ;; *) _match_any "$f" "$owned" || bad="$bad $f";; esac
  done
  printf '%s' "${bad# }"
}

picked=(); nochange=(); conflict=(); violation=(); missing=()
report=()

for ag in $agents; do
  wt="$(wt_path "$ag")"
  if [ ! -d "$wt" ]; then missing+=("$ag"); report+=("  ?  missing   $ag  ($wt does not exist)"); continue; fi
  # whether the worktree has changes
  if [ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    nochange+=("$ag"); report+=("  —  no-change $ag"); continue
  fi
  files="$(git -C "$wt" status --porcelain | sed 's/^...//' | tr '\n' ' ')"
  # out-of-bounds detection: before cherry-pick, compare diff for changes outside owned / matching forbidden, isolate(do not integrate) if out-of-bounds
  bad="$(check_violation "$ag" "$files")"
  if [ -n "$bad" ]; then
    violation+=("$ag"); report+=("  ⚠  violation $ag  → out-of-bounds changes: $bad (owned/forbidden check failed; not integrated, human adjudication)"); continue
  fi
  if [ "$dry" -eq 1 ]; then report+=("  ▸  would-pick $ag  ($files)"); picked+=("$ag"); continue; fi

  git -C "$wt" add -A
  git -C "$wt" -c user.email=ccb@local -c user.name="$ag" commit -q -m "$ag: $files" || {
    nochange+=("$ag"); report+=("  —  no-change $ag (empty commit)"); continue; }
  sha="$(git -C "$wt" rev-parse HEAD)"

  # cherry-pick creates a new commit → needs a committer identity; pass it explicitly, do not rely on global git config
  # (environments without a global identity like CI/brand-new user would otherwise fail, misclassified as conflict)
  if git -C "$work" -c user.email=ccb@local -c user.name=fanout-integrate cherry-pick "$sha" >/dev/null 2>&1; then
    picked+=("$ag"); report+=("  ✓  picked    $ag  ${sha:0:7}  ($files)")
  else
    if [ "$onconflict" = abort ]; then
      git -C "$work" cherry-pick --abort >/dev/null 2>&1
      conflict+=("$ag"); report+=("  ✗  conflict  $ag  → aborted, main stays clean; needs manual cherry-pick/rebase $sha")
    else
      conflict+=("$ag"); report+=("  ✗  conflict  $ag  → conflict left in working tree(skip mode), after resolving git cherry-pick --continue")
    fi
  fi
done

# summary
hdr="── integrate (work=$work) ──"
sum="$(printf '%s | %s | %s | %s | %s' \
  "${#picked[@]} picked" "${#nochange[@]} no-change" "${#conflict[@]} conflict" "${#violation[@]} violation" "${#missing[@]} missing")"
{ echo "$hdr"; printf '%s\n' "${report[@]}"; echo "$sum"; }

if [ -n "$task" ] && [ -f "$task" ]; then
  { echo ""; echo "### Integrate — $sum"; printf '%s\n' "${report[@]}"; } >> "$task"
  echo "→ written to $task" >&2
fi

# conflict or out-of-bounds → non-0 (both isolated, need human adjudication)
[ "${#conflict[@]}" -eq 0 ] && [ "${#violation[@]}" -eq 0 ]
