#!/usr/bin/env bash
# Verify a Self-Heal worktree: borrow the main checkout's dependencies, then run the regression gate.
set -euo pipefail
here="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"
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
# Copied without .git: a symlinked or gitdir-carrying submodule makes `git status` fail, blinding the scope guard.
copy() {
  local rel="$1"
  [ -d "$main/$rel" ] || return 0
  if [ -L "$here/$rel" ]; then rm -f "${here:?}/$rel"; fi
  mkdir -p "$here/$rel"
  rm -rf "${here:?}/$rel/.git"
  rsync -a --delete --exclude .git --exclude .build "$main/$rel/" "$here/$rel/"
}
borrow extension/node_modules
copy .skills
copy mac/LocalPackages/graph-kit
[ "${SELF_HEAL_PREPARE_ONLY:-}" = 1 ] && exit 0
cd "$here"
exec make regression
