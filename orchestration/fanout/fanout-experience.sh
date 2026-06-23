#!/usr/bin/env bash
# fanout-experience.sh — Experience memory (inspired by Zleap-Agent)
# Completed task → extract reusable method → **redact** → bucket by workspace → inject into context for future similar tasks.
# (Zleap's three-part memory has Experience: reusable method, redacted, filed by workspace. This repo implements it as files, not a DB.)
#   add  <ws> "<title>" [--from <file>]   store one experience (body from --from or stdin; rejected if redaction fails)
#   list [<ws>]                           list experiences
#   recall <ws> [--query kw] [--limit N]  fetch experiences relevant to this ws (default limit 3, for context injection)
#   show <ws> <slug>                      print one
#   env: FANOUT_EXPERIENCE (default ${FANOUT_STATE:-~/.config/fanout}/experience)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
STORE="${FANOUT_EXPERIENCE:-${FANOUT_STATE:-$HOME/.config/fanout}/experience}"
# redaction fingerprint (same as scan-secrets): plaintext keys not allowed into the experience store
SECRET_RE='sk-[A-Za-z0-9_-]{20,}|tp-[a-z0-9]{30,}|[0-9a-f]{32}\.[A-Za-z0-9]{16}'
slugify(){ printf '%s' "$1" | tr ' /' '--' | tr -d '"'\''`'; }   # drop quotes/backticks, space/slash→-

cmd_add(){
  local ws="${1:-}" title="${2:-}"; shift 2 2>/dev/null || true
  [ -n "$ws" ] && [ -n "$title" ] || die "usage: add <ws> \"<title>\" [--from <file>]"
  local src=""
  while [ "$#" -gt 0 ]; do case "$1" in --from) src="${2:-}"; shift 2;; *) die "unknown arg '$1'";; esac; done
  local body
  if [ -n "$src" ]; then [ -f "$src" ] || die "no --from file $src"; body="$(cat "$src")"
  else body="$(cat)"; fi   # stdin
  [ -n "$body" ] || die "experience body is empty"
  # redaction gate
  if printf '%s' "$body" | grep -qE "$SECRET_RE"; then die "body contains suspected key, refused (redact first)"; fi
  local d="$STORE/$ws"; mkdir -p "$d"
  local slug f; slug="$(slugify "$title")"; f="$d/$slug.md"
  {
    echo "---"; echo "workspace: $ws"; echo "title: $title"; echo "created: $(date +%s)"; echo "---"
    printf '%s\n' "$body"
  } > "$f"
  echo "✓ experience stored: $f"
}

cmd_list(){
  local ws="${1:-}"
  local base="$STORE"; [ -n "$ws" ] && base="$STORE/$ws"
  [ -d "$base" ] || { echo "(no experiences yet)"; return 0; }
  local f
  find "$base" -name '*.md' 2>/dev/null | sort | while read -r f; do
    printf '  %-12s %s\n' "$(basename "$(dirname "$f")")" "$(sed -n 's/^title: //p' "$f" | head -1)"
  done
}

cmd_recall(){
  local ws="${1:-}"; shift || true
  [ -n "$ws" ] || die "usage: recall <ws> [--query kw] [--limit N]"
  local query="" limit=3
  while [ "$#" -gt 0 ]; do
    case "$1" in --query) query="${2:-}"; shift 2;; --limit) limit="${2:-3}"; shift 2;; *) die "unknown arg '$1'";; esac
  done
  local d="$STORE/$ws"; [ -d "$d" ] || return 0   # no experience = empty output
  # candidates: all of this ws, by mtime new→old; if query, filter by content first
  local files=() f
  while IFS= read -r f; do files+=("$f"); done < <(
    if [ -n "$query" ]; then grep -rlF "$query" "$d" 2>/dev/null; else find "$d" -name '*.md' 2>/dev/null; fi \
      | while read -r x; do printf '%s\t%s\n' "$(sed -n 's/^created: //p' "$x" | head -1)" "$x"; done \
      | sort -rn | cut -f2-)
  local n=0
  for f in ${files[@]+"${files[@]}"}; do
    [ "$n" -ge "$limit" ] && break
    printf '[experience] %s\n' "$(sed -n 's/^title: //p' "$f" | head -1)"
    sed '1,/^---$/d; /^---$/d' "$f" 2>/dev/null | sed '/^workspace:/d;/^title:/d;/^created:/d'
    echo ""
    n=$((n+1))
  done
}

cmd_show(){
  local ws="${1:-}" slug="${2:-}"; [ -n "$ws" ] && [ -n "$slug" ] || die "usage: show <ws> <slug>"
  local f="$STORE/$ws/$slug.md"; [ -f "$f" ] || die "no experience $ws/$slug"
  cat "$f"
}

sub="${1:-}"; shift || true
case "$sub" in
  add)    cmd_add    "$@";;
  list)   cmd_list   "$@";;
  recall) cmd_recall "$@";;
  show)   cmd_show   "$@";;
  ''|-h|--help) sed -n '2,13p' "$0";;
  *) die "unknown subcommand '$sub' (add|list|recall|show)";;
esac
