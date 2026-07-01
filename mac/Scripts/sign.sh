#!/bin/bash
# ============================================
# Sign phase: codesign the .app bundle.
# Reads LLMIDE_SIGN_IDENTITY (default "-" for ad-hoc dev).
# ============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="LlmIdeMac"
APP_DIR="$PROJ_DIR/$APP_NAME.app"
IDENTITY="${LLMIDE_SIGN_IDENTITY:--}"

if [ ! -d "$APP_DIR" ]; then
  echo -e "${RED}[sign] missing $APP_DIR — run Scripts/build.sh first${NC}"
  exit 1
fi

if [ "$IDENTITY" = "-" ]; then
  echo -e "${BLUE}[sign]${NC} ad-hoc signing (set LLMIDE_SIGN_IDENTITY for Developer ID)..."
else
  echo -e "${BLUE}[sign]${NC} signing with identity: $IDENTITY"
fi

codesign -s "$IDENTITY" --force --deep --options runtime \
  --entitlements "$PROJ_DIR/LlmIdeMac.entitlements" "$APP_DIR"

echo -e "${GREEN}[sign]${NC} ok"
