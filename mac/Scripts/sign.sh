#!/bin/bash
# ============================================
# Sign phase: codesign the .app bundle.
# Reads LLMIDE_SIGN_IDENTITY (default: the local dev identity recorded in
# .sign-identity, or "-" for ad-hoc if neither is set).
# ============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="LlmIdeMac"
# LLMIDE_APP_DIR mirrors build.sh's override so sign.sh can sign a staged
# bundle in place. Unset = today's default location.
APP_DIR="${LLMIDE_APP_DIR:-$PROJ_DIR/$APP_NAME.app}"
# Ad-hoc signing (identity "-") re-signs with a fresh, content-derived cdhash
# every build; macOS's keychain ACL matches on code-signature identity, so
# every ad-hoc rebuild looks like a new app and re-prompts for keychain
# access. LLMIDE_SIGN_IDENTITY (a real Developer ID, or a local self-signed
# dev cert — see Scripts/make-dev-cert.sh) keeps that identity stable across
# rebuilds, so "Always Allow" actually sticks. .sign-identity is this
# machine's local, gitignored default — an explicit env var still overrides
# it (release.sh's own stricter check reads the env var directly and is
# unaffected by this file: it requires a real Developer ID + notary profile,
# not a local dev cert).
SIGN_IDENTITY_FILE="$SCRIPT_DIR/.sign-identity"
if [ -z "${LLMIDE_SIGN_IDENTITY:-}" ] && [ -f "$SIGN_IDENTITY_FILE" ]; then
  LLMIDE_SIGN_IDENTITY="$(cat "$SIGN_IDENTITY_FILE")"
fi
IDENTITY="${LLMIDE_SIGN_IDENTITY:--}"

if [ ! -d "$APP_DIR" ]; then
  echo -e "${RED}[sign] missing $APP_DIR — run Scripts/build.sh first${NC}"
  exit 1
fi

if [ "$IDENTITY" = "-" ]; then
  echo -e "${BLUE}[sign]${NC} ad-hoc signing — every rebuild will re-prompt for keychain access;"
  echo -e "${BLUE}[sign]${NC} run Scripts/make-dev-cert.sh once to fix this for local dev builds."
else
  echo -e "${BLUE}[sign]${NC} signing with identity: $IDENTITY"
fi

codesign -s "$IDENTITY" --force --deep --options runtime \
  --entitlements "$PROJ_DIR/LlmIdeMac.entitlements" "$APP_DIR"

echo -e "${GREEN}[sign]${NC} ok"
