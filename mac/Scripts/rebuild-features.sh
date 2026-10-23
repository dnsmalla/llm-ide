#!/bin/bash
# ============================================
# Feature-selected rebuild into a staging directory. Safe to run while
# the app is running: nothing outside --stage-dir is touched. Staging is
# the ONLY mode this script has — the swap into place is always
# rebuild-swap.sh's job (spawned by the app itself on success), never this
# script's.
# Usage: rebuild-features.sh --features <csv> --stage-dir <dir>
# ============================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FEATURES="" ; STAGE_DIR="" ; FEATURES_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --features) FEATURES="${2-}"; FEATURES_GIVEN=1; shift 2 ;;
    --stage-dir) STAGE_DIR="$2"; shift 2 ;;
    *) echo "[rebuild] unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ "$FEATURES_GIVEN" = 1 ] && [ -n "$STAGE_DIR" ] || { echo "[rebuild] --features and --stage-dir required" >&2; exit 2; }
# An EMPTY set is a real selection (every feature switched off in Settings),
# not a missing argument: it means the minimum build. It must not reach
# build.sh/Package.swift as "" — build.sh treats an empty LLMIDE_FEATURES as
# unset (no --manifest-cache none, Info.plist records "all"). Spell it the way
# `make build-mac-min` does: agent_chat is never compile-excludable, so this
# excludes every excludable feature.
if [ -z "$FEATURES" ]; then
  FEATURES="agent_chat"
fi
mkdir -p "$STAGE_DIR"
APP_DIR="$STAGE_DIR/LlmIdeMac.app"
echo "[rebuild] staging build (features: $FEATURES) into $APP_DIR"
# Own SwiftPM scratch dir: never contend with (or strip) a developer's `.build`.
# build.sh strips the staged executable and writes its dSYM BESIDE the bundle,
# at $STAGE_DIR/LlmIdeMac.app.dSYM. rebuild-swap.sh moves only the .app, so the
# dSYM never reaches the install location; it stays here, matching the
# installed binary, until the next rebuild wipes the stage dir
# (FeatureRebuildService.startRebuild).
LLMIDE_SCRATCH_PATH=".build-app-rebuild" LLMIDE_FEATURES="$FEATURES" LLMIDE_APP_DIR="$APP_DIR" LLMIDE_SKIP_KILL=1 "$SCRIPT_DIR/build.sh"
echo "[rebuild] signing staged bundle"
LLMIDE_APP_DIR="$APP_DIR" "$SCRIPT_DIR/sign.sh"
echo "[rebuild] staged OK: $APP_DIR (debug symbols: $APP_DIR.dSYM)"
exit 0
