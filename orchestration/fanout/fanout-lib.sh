#!/usr/bin/env bash
# fanout-lib.sh — shared helpers for the fanout tool scripts.
#
# SOURCED, never executed. Each tool sources it right after `set -uo pipefail`:
#     # shellcheck source=/dev/null
#     . "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
#
# Provides: die/warn/say messaging, status symbols, portable mtime, and a small
# on-disk TTL cache layer for slow/idempotent reads (env recon, liveness probes).
# Goal: kill the per-script boilerplate (16 copies of die() etc.) without changing
# any observable behavior. Safe under `set -u`.

# --- program name (for messages) ---------------------------------------------
# Captured at SOURCE time from the sourcing script (BASH_SOURCE[1]) — robust to
# $0 munging (exec -a, symlinks, broken PATH) and needs no external basename.
# Reproduces the former per-script prefix exactly, e.g. "fanout-allocate".
FX_PROG="${BASH_SOURCE[1]:-${0:-fanout}}"; FX_PROG="${FX_PROG##*/}"; FX_PROG="${FX_PROG%.sh}"

# --- messaging ---------------------------------------------------------------
die()  { echo "${FX_PROG}: $*" >&2; exit 2; }   # byte-identical to the old per-script die()
warn() { echo "${FX_PROG}: $*" >&2; }
say()  { printf '%s\n' "$*"; }

# --- status symbols (for human-readable reports) -----------------------------
FX_OK="✓"; FX_NO="—"; FX_BAD="✗"; FX_WARN="⚠"

# --- portable helpers --------------------------------------------------------
# fx_mtime <file> → epoch seconds of last modification. GNU first (Linux fleet),
# then BSD/macOS, then 0. The non-matching variant errors out cleanly (2>/dev/null).
fx_mtime() { stat -c %Y "${1-}" 2>/dev/null || stat -f %m "${1-}" 2>/dev/null || echo 0; }

# --- TTL cache layer ---------------------------------------------------------
# Generic on-disk cache for results that are slow to compute but safe to reuse
# for a short window (doctor recon, fleet/endpoint probes). Freshness = file
# mtime vs ttl seconds. Namespaced under the cache root so it never collides
# with the fan-in result cache (fanout-cache.sh).
fcache_root() { printf '%s' "${FANOUT_CACHE:-${HOME:-${TMPDIR:-/tmp}}/.cache/fanout}/_ttl"; }
# fcache_path <key>: key is sanitized to [A-Za-z0-9_-] (no '.'/'/' → no traversal).
fcache_path() { local k="${1-}"; k="${k//[^A-Za-z0-9_-]/_}"; printf '%s/%s' "$(fcache_root)" "$k"; }
# fcache_get <key> <ttl_seconds>: print cached value and return 0 if still fresh,
# else return 1 (caller recomputes).
fcache_get() {
  local f age now mt
  f="$(fcache_path "${1-}")"
  [ -f "$f" ] || return 1
  now=$(date +%s); mt=$(fx_mtime "$f"); age=$(( now - mt ))
  [ "$age" -le "${2:-60}" ] || return 1
  cat "$f"
}
# fcache_put <key>: store stdin as the value for <key> (atomic: temp file + mv).
fcache_put() {
  local f tmp; f="$(fcache_path "${1-}")"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  tmp="$f.$$.tmp"
  cat > "$tmp" && mv -f "$tmp" "$f"
}
fcache_clear() { rm -rf "$(fcache_root)" 2>/dev/null || true; }

# --- fan-in result cache root ------------------------------------------------
# Shared root for fan-out RESULT artifacts (round-<N>/, loop/, plans, status).
# Repo-local by default so results stay with the project; override via FANOUT_CACHE.
# Distinct from fcache_root() above (machine-global TTL probe cache); the
# cache/loop/plan/run/summary tools previously copy-pasted this exact expression.
fx_cache_root() { printf '%s' "${FANOUT_CACHE:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.fanout-cache}"; }
