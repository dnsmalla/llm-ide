#!/bin/bash
# ============================================
# Backward-compat shim for the old monolithic build script.
# The build is now split across Scripts/build.sh, sign.sh, notarize.sh,
# and dmg.sh — each phase is standalone-runnable. For a full notarized
# release, run Scripts/release.sh instead. This shim covers the dev
# path: build → sign → dmg (skipping notarize).
# ============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/LlmIdeMac.app"

echo -e "${BLUE}[build_app]${NC} dev pipeline: build → sign → dmg"

"$SCRIPT_DIR/Scripts/build.sh"
"$SCRIPT_DIR/Scripts/sign.sh"
"$SCRIPT_DIR/Scripts/dmg.sh"

echo -e "${GREEN}[build_app]${NC} all phases complete"
open "$APP_DIR"
