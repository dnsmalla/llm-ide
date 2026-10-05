#!/usr/bin/env bash
# Verify an SDK Adoption worktree: every edit the adopt agent may make lives
# under extension/, which `make regression` does not test, so run the
# extension suite first, then the regression gate.
set -euo pipefail
here="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"
if [ "$here" = "$main" ]; then
  echo "sdk-adopt-verify: refusing to run in the main checkout" >&2
  exit 2
fi
SELF_HEAL_PREPARE_ONLY=1 bash "$here/mac/Scripts/self-heal-verify.sh"
(cd "$here/extension" && npm test)
cd "$here"
exec make regression
