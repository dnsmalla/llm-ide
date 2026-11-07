#!/usr/bin/env bash
# Self-Heal verify (docs/superpowers/plans/2026-11-07-self-heal-b-fix-loop.md), ported from the Mac's
# mac/Scripts/self-heal-verify.sh. The desktop host runs the SOURCE CHECKOUT's copy (never the worktree's) inside a
# Self-Heal worktree: borrow the checkout's dependencies, then run the regression gate. The host reverts the fix
# agent's edits to scripts/**, **/*.sh, Makefile and package.json files before this runs.
set -euo pipefail
here="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"
if [ "$here" = "$main" ]; then
  echo "self-heal-verify: refusing to run in the main checkout" >&2
  exit 2
fi
# node_modules: symlinked from the checkout (a proposal's diff excludes them).
borrow() {
  local rel="$1"
  if [ -d "$here/$rel" ] && [ -n "$(ls -A "$here/$rel" 2>/dev/null)" ]; then return 0; fi
  [ -e "$main/$rel" ] || return 0
  rm -rf "${here:?}/$rel"
  ln -s "$main/$rel" "$here/$rel"
}
# Submodules: copied without .git; a symlinked or gitdir-carrying submodule makes `git status` fail.
copy() {
  local rel="$1"
  [ -d "$main/$rel" ] || return 0
  if [ -L "$here/$rel" ]; then rm -f "${here:?}/$rel"; fi
  mkdir -p "$here/$rel"
  rsync -a --delete --exclude .git --exclude .build "$main/$rel/" "$here/$rel/"
}
borrow extension/node_modules
borrow desktop/node_modules
borrow web/node_modules
borrow ui/kit/node_modules
copy .skills
copy graph-kit
[ "${SELF_HEAL_PREPARE_ONLY:-}" = 1 ] && exit 0
cd "$here"
# The extension unit tests too: make regression alone never runs them (reviewer ruling, plan B).
make test
exec make regression
