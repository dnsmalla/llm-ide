#!/bin/bash
# ============================================
# Sign phase: codesign the .app bundle.
# Reads LLMIDE_SIGN_IDENTITY (default: the local dev identity recorded in
# .sign-identity, or "-" for ad-hoc if neither is set).
#
# Signs INSIDE-OUT (nested code first, outer bundle last) rather than with
# --deep. Two reasons, both of which bit us:
#   1. Apple deprecated --deep for signing; it is not a supported way to sign
#      a bundle for distribution and notarization can reject its output.
#   2. --deep applies the OUTER app's --entitlements to every nested binary.
#      That is how Sparkle's Updater.app and its two XPC services ended up
#      carrying com.apple.security.device.microphone and
#      disable-library-validation — entitlements an updater has no business
#      holding. Only the app itself gets the entitlements file here; nested
#      code is signed with the hardened runtime and nothing else.
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

# A secure timestamp is REQUIRED for notarization. Ad-hoc signatures cannot
# carry one (and the timestamp server round-trip would make every local build
# need the network), so only real identities get --timestamp.
if [ "$IDENTITY" = "-" ]; then
  TIMESTAMP_FLAG="--timestamp=none"
  echo -e "${BLUE}[sign]${NC} ad-hoc signing — every rebuild will re-prompt for keychain access;"
  echo -e "${BLUE}[sign]${NC} run Scripts/make-dev-cert.sh once to fix this for local dev builds."
  echo -e "${BLUE}[sign]${NC} NOTE: no secure timestamp — this build cannot be notarized."
else
  TIMESTAMP_FLAG="--timestamp"
  echo -e "${BLUE}[sign]${NC} signing with identity: $IDENTITY"
fi

# Nested code: hardened runtime, NO entitlements.
sign_nested() {
  echo -e "${BLUE}[sign]${NC}   ${1#"$APP_DIR"/}"
  codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP_FLAG" "$1"
}

FRAMEWORKS="$APP_DIR/Contents/Frameworks"

if [ -d "$FRAMEWORKS" ]; then
  # 1. Nested bundles (XPC services, helper .apps), deepest first so an inner
  #    bundle is sealed before the bundle that contains it.
  #    -type d skips the symlinked aliases at a framework's root
  #    (Sparkle.framework/Updater.app -> Versions/B/Updater.app), which must
  #    NOT be signed separately.
  while IFS= read -r nested; do
    [ -n "$nested" ] && sign_nested "$nested"
  done < <(find "$FRAMEWORKS" -type d \( -name "*.xpc" -o -name "*.app" \) \
             -print0 | xargs -0 -n1 echo | awk '{ print length"\t"$0 }' \
             | sort -rn | cut -f2-)

  # 2. Loose Mach-O helpers sitting in a framework version root (Sparkle's
  #    `Autoupdate`). The framework's own binary is sealed by step 3, but a
  #    sibling executable needs its own signature first.
  while IFS= read -r helper; do
    [ -z "$helper" ] && continue
    fw_dir="$(dirname "$(dirname "$helper")")"           # .../Sparkle.framework/Versions
    fw_name="$(basename "$(dirname "$fw_dir")" .framework)"
    [ "$(basename "$helper")" = "$fw_name" ] && continue  # the framework binary itself
    file "$helper" | grep -q "Mach-O" && sign_nested "$helper"
  done < <(find "$FRAMEWORKS" -path "*.framework/Versions/*" -type f -perm -u+x -maxdepth 4)

  # 3. The frameworks themselves. Sign the real version directory, not the
  #    Versions/Current symlink.
  while IFS= read -r version_dir; do
    [ -n "$version_dir" ] && sign_nested "$version_dir"
  done < <(find "$FRAMEWORKS" -type d -path "*.framework/Versions/*" -depth 3 \
             ! -name Current)

  # Flat (unversioned) frameworks, if any ever appear.
  while IFS= read -r flat_fw; do
    [ -n "$flat_fw" ] && [ ! -d "$flat_fw/Versions" ] && sign_nested "$flat_fw"
  done < <(find "$FRAMEWORKS" -maxdepth 1 -type d -name "*.framework")
fi

# 4. Finally the app itself — the only thing that gets the entitlements.
echo -e "${BLUE}[sign]${NC}   $(basename "$APP_DIR") (with entitlements)"
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP_FLAG" \
  --entitlements "$PROJ_DIR/$APP_NAME.entitlements" "$APP_DIR"

# --deep IS correct for verification (it walks nested code); it is only
# signing with --deep that is deprecated.
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

echo -e "${GREEN}[sign]${NC} ok"
