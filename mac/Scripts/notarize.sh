#!/bin/bash
# ============================================
# Notarize phase: submit the signed .app to Apple notary service
# and staple the ticket. Requires MEETNOTES_NOTARY_PROFILE (the
# keychain profile name created via `xcrun notarytool store-credentials`).
# Skips with a friendly message if unset — dev builds don't need this.
# ============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="MeetNotesMac"
APP_DIR="$PROJ_DIR/$APP_NAME.app"
PROFILE="${MEETNOTES_NOTARY_PROFILE:-}"

if [ -z "$PROFILE" ]; then
  echo -e "${YELLOW}[notarize]${NC} MEETNOTES_NOTARY_PROFILE unset — skipping notarization (dev build)."
  exit 0
fi

if [ ! -d "$APP_DIR" ]; then
  echo -e "${RED}[notarize] missing $APP_DIR — run Scripts/build.sh first${NC}"
  exit 1
fi

ZIP="$PROJ_DIR/${APP_NAME}-notarize.zip"
echo -e "${BLUE}[notarize]${NC} zipping bundle for submission..."
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP_DIR" "$ZIP"

echo -e "${BLUE}[notarize]${NC} submitting to Apple notary (profile: $PROFILE)..."
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait

echo -e "${BLUE}[notarize]${NC} stapling ticket..."
xcrun stapler staple "$APP_DIR"

rm -f "$ZIP"
echo -e "${GREEN}[notarize]${NC} ok"
