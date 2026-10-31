#!/usr/bin/env bash
# The ONE source of CFBundleVersion (Sparkle's comparison key) for local AND CI
# releases: the commit count of HEAD (`git rev-list --count HEAD`), which only
# ever grows on main. Prints the number on stdout; diagnostics go to stderr.
#
#   LLMIDE_BUILD_NUMBER   optional explicit override. It must be a positive
#                         integer AND >= the commit count, otherwise a later
#                         build could be ordered before an earlier one: refused.
#   LLMIDE_BUILD_NUMBER_REPO   repo to count in (default: this script's repo;
#                         the test points it at a throwaway repo).
#
# A shallow clone has a truncated count, so without an override this FAILS
# (CI checks out with fetch-depth: 0). With an override on a shallow clone the
# value is accepted with a warning, since it cannot be compared.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${LLMIDE_BUILD_NUMBER_REPO:-$HERE/..}"
OVERRIDE="${LLMIDE_BUILD_NUMBER:-}"

die() { echo "[build-number] $*" >&2; exit 1; }

if [ -n "$OVERRIDE" ]; then
  case "$OVERRIDE" in
    *[!0-9]*|0*|'') die "LLMIDE_BUILD_NUMBER must be a positive integer without leading zeros (got '$OVERRIDE')" ;;
  esac
fi

COUNT=""
SHALLOW="false"
if COUNT=$(git -C "$REPO" rev-list --count HEAD 2>/dev/null) && [ -n "$COUNT" ]; then
  SHALLOW=$(git -C "$REPO" rev-parse --is-shallow-repository 2>/dev/null || echo false)
else
  COUNT=""
fi

if [ -z "$COUNT" ] || [ "$SHALLOW" = "true" ]; then
  [ -n "$OVERRIDE" ] || die "cannot derive a build number: git history is ${COUNT:+shallow}${COUNT:-unavailable}. Fetch full history (git fetch --unshallow / fetch-depth: 0) or set LLMIDE_BUILD_NUMBER."
  echo "[build-number] WARN: history ${COUNT:+shallow}${COUNT:-unavailable}; accepting LLMIDE_BUILD_NUMBER=$OVERRIDE unverified" >&2
  echo "$OVERRIDE"
  exit 0
fi

if [ -n "$OVERRIDE" ]; then
  [ "$OVERRIDE" -ge "$COUNT" ] || die "LLMIDE_BUILD_NUMBER=$OVERRIDE is below the commit count ($COUNT): Sparkle would order this build before earlier ones"
  echo "$OVERRIDE"
else
  echo "$COUNT"
fi
