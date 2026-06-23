#!/usr/bin/env bash
# fanout-template.sh — render a prompt template (templates/<name>.md), literal-replace {{KEY}}
#   usage: fanout-template.sh <name> [--set KEY=VALUE ...]
#   {{KEY}} not --set is left verbatim (for Claude to fill)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPLDIR="$HERE/templates"

name="${1:-}"; shift || true
[ -n "$name" ] || die "usage: <name> [--set KEY=VALUE ...]  (available: $(ls "$TPLDIR" 2>/dev/null | sed 's/\.md$//' | tr '\n' ' '))"
f="$TPLDIR/$name.md"
[ -f "$f" ] || die "no template '$name' (in $TPLDIR)"

content="$(cat "$f")"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --set)
      kv="${2:-}"; [ -n "$kv" ] || die "--set missing KEY=VALUE"; shift 2
      key="${kv%%=*}"; val="${kv#*=}"
      [ "$key" != "$kv" ] || die "--set format should be KEY=VALUE, got '$kv'"
      content="${content//"{{$key}}"/$val}"   # bash literal replace (quotes make pattern literal)
      ;;
    *) die "unknown arg '$1'";;
  esac
done
printf '%s\n' "$content"
