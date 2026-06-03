#!/bin/bash
# ============================================
# DMG phase: produce a UDZO-compressed .dmg installer.
# ============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="MeetNotesMac"
APP_DIR="$PROJ_DIR/$APP_NAME.app"
# Pulled from mac/VERSION; build.sh writes the same value into the
# .app's Info.plist, so the DMG filename matches the bundle version.
VERSION=$(cat "$PROJ_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')
if [ -z "$VERSION" ]; then
  echo -e "${RED}[dmg] mac/VERSION missing or empty${NC}" >&2
  exit 1
fi
DMG_NAME="${APP_NAME}_v${VERSION}.dmg"

if [ ! -d "$APP_DIR" ]; then
  echo -e "${RED}[dmg] missing $APP_DIR — run Scripts/build.sh first${NC}"
  exit 1
fi

echo -e "${BLUE}[dmg]${NC} packaging $DMG_NAME..."
rm -f "$PROJ_DIR/$DMG_NAME"
DMG_TEMP="$PROJ_DIR/dmg_temp"
rm -rf "$DMG_TEMP"
mkdir -p "$DMG_TEMP"
cp -R "$APP_DIR" "$DMG_TEMP/"
ln -sf /Applications "$DMG_TEMP/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_TEMP" -ov -format UDZO "$PROJ_DIR/$DMG_NAME" > /dev/null
rm -rf "$DMG_TEMP"

echo -e "${GREEN}[dmg]${NC} ok — $DMG_NAME"
