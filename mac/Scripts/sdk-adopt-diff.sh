#!/usr/bin/env bash
# SDK Adoption loop, Diff stage: borrow the main checkout's dependencies (the
# installed SDK lives there), sync the SDK pin, and list unclassified surface.
# Exit 0 = batch written, 3 = nothing to adopt, other = error.
set -euo pipefail
here="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"
if [ "$here" = "$main" ]; then
  echo "sdk-adopt-diff: refusing to run in the main checkout" >&2
  exit 2
fi
SELF_HEAL_PREPARE_ONLY=1 bash "$here/mac/Scripts/self-heal-verify.sh"
cd "$here/extension"
exec node scripts/sdk-surface.mjs diff --batch "$here/.sdk-adopt/BATCH.md" --main "$main"
