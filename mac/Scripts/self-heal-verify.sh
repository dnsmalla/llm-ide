#!/usr/bin/env bash
# Verify a Self-Heal worktree: borrow the main checkout's dependencies, then run the regression gate.
set -euo pipefail
here="$(git rev-parse --show-toplevel)"
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
if [ "$here" = "$main" ]; then
  echo "self-heal-verify: refusing to run in the main checkout" >&2
  exit 2
fi
borrow() {
  local rel="$1"
  if [ -d "$here/$rel" ] && [ -n "$(ls -A "$here/$rel" 2>/dev/null)" ]; then return; fi
  [ -e "$main/$rel" ] || return 0
  rm -rf "${here:?}/$rel"
  ln -s "$main/$rel" "$here/$rel"
}
borrow extension/node_modules
borrow .skills
borrow mac/LocalPackages/graph-kit
cd "$here"
exec make regression
