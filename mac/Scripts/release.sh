#!/bin/bash
# ============================================
# Release pipeline: build → sign → notarize → dmg.
# Stops on any failure (set -e).
# Requires MEETNOTES_SIGN_IDENTITY and MEETNOTES_NOTARY_PROFILE
# for a fully notarized build; dev defaults produce an ad-hoc
# signed, un-notarized DMG.
# ============================================
set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
NC='\033[0m'

RED='\033[0;31m'
YELLOW='\033[0;33m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Fail closed: a *release* must be signed with a real Developer ID and
# notarized. Without both, the pipeline would otherwise emit an ad-hoc
# signed, un-notarized DMG — a dev artifact that Gatekeeper will reject and
# that must never be handed out as a release. Allow that dev path ONLY when
# the operator explicitly opts in with MEETNOTES_ALLOW_DEV_RELEASE=1.
IDENTITY="${MEETNOTES_SIGN_IDENTITY:--}"
NOTARY="${MEETNOTES_NOTARY_PROFILE:-}"
ALLOW_DEV="${MEETNOTES_ALLOW_DEV_RELEASE:-0}"

if [ "$IDENTITY" = "-" ] || [ -z "$NOTARY" ]; then
  if [ "$ALLOW_DEV" != "1" ]; then
    echo -e "${RED}[release] refusing to build a release without signing + notarization.${NC}"
    echo -e "${RED}          set MEETNOTES_SIGN_IDENTITY (Developer ID) and MEETNOTES_NOTARY_PROFILE,${NC}"
    echo -e "${RED}          or set MEETNOTES_ALLOW_DEV_RELEASE=1 to produce an UNSIGNED dev build.${NC}"
    exit 1
  fi
  echo -e "${YELLOW}[release] WARNING: producing a DEV artifact (ad-hoc signed / not notarized).${NC}"
  echo -e "${YELLOW}          Gatekeeper will block this on other machines. Do NOT distribute.${NC}"
fi

echo -e "${BLUE}[release]${NC} build → sign → notarize → dmg"

"$SCRIPT_DIR/build.sh"
"$SCRIPT_DIR/sign.sh"
"$SCRIPT_DIR/notarize.sh"
"$SCRIPT_DIR/dmg.sh"

echo -e "${GREEN}[release]${NC} done"
