#!/bin/bash
# ============================================
# Feature-selected rebuild into a staging directory. Safe to run while
# the app is running: nothing outside --stage-dir is touched. The swap
# into place is rebuild-swap.sh's job (spawned by the app on success).
# Usage: rebuild-features.sh --features <csv> --stage-dir <dir> [--stage-only]
# ============================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FEATURES="" ; STAGE_DIR="" ; STAGE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --features) FEATURES="$2"; shift 2 ;;
    --stage-dir) STAGE_DIR="$2"; shift 2 ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    *) echo "[rebuild] unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$FEATURES" ] && [ -n "$STAGE_DIR" ] || { echo "[rebuild] --features and --stage-dir required" >&2; exit 2; }
mkdir -p "$STAGE_DIR"
APP_DIR="$STAGE_DIR/LlmIdeMac.app"
echo "[rebuild] staging build (features: $FEATURES) into $APP_DIR"
LLMIDE_FEATURES="$FEATURES" LLMIDE_APP_DIR="$APP_DIR" LLMIDE_SKIP_KILL=1 "$SCRIPT_DIR/build.sh"
echo "[rebuild] signing staged bundle"
LLMIDE_APP_DIR="$APP_DIR" "$SCRIPT_DIR/sign.sh"
echo "[rebuild] staged OK: $APP_DIR"
# --stage-only stops here; the app spawns rebuild-swap.sh itself.
exit 0
