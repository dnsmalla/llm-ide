#!/bin/bash
# ============================================================================
# Generate Sparkle appcast.xml entry for the just-built DMG.
#
# Inputs (env vars; release.sh sets these):
#   MEETNOTES_SU_DOWNLOAD_URL_BASE  base URL where DMGs are hosted
#                                   e.g. https://updates.meetnotes.app/releases
#                                   final URL = $base/$DMG_NAME
#   MEETNOTES_SU_PRIVATE_KEY_FILE   path to the EdDSA private key generated
#                                   by Sparkle's `generate_keys` tool.
#                                   Default: ~/.meetnotes/sparkle_ed25519
#
# Outputs:
#   - Prints a single <item>...</item> block to stdout (you splice this
#     into your hosted appcast.xml; we don't write the whole file
#     because the historical entries belong in the canonical version).
#   - Exit non-zero on signing or hashing failure.
#
# Operator workflow:
#   ./Scripts/release.sh
#   ./Scripts/appcast.sh > /tmp/new-item.xml
#   # splice /tmp/new-item.xml into the hosted appcast.xml, commit,
#   # deploy. Sparkle clients see the new version on their next check.
# ============================================================================
set -euo pipefail

RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(cat "$PROJ_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')
if [ -z "$VERSION" ]; then
  echo -e "${RED}[appcast] mac/VERSION missing or empty${NC}" >&2
  exit 1
fi

DMG_NAME="MeetNotesMac_v${VERSION}.dmg"
DMG_PATH="$PROJ_DIR/$DMG_NAME"
if [ ! -f "$DMG_PATH" ]; then
  echo -e "${RED}[appcast] DMG not found at $DMG_PATH — run release.sh first${NC}" >&2
  exit 1
fi

BASE_URL="${MEETNOTES_SU_DOWNLOAD_URL_BASE:-https://example.invalid/releases}"
if [ "$BASE_URL" = "https://example.invalid/releases" ]; then
  echo -e "${BLUE}[appcast]${NC} WARN: MEETNOTES_SU_DOWNLOAD_URL_BASE unset — using placeholder host" >&2
fi
DOWNLOAD_URL="${BASE_URL%/}/$DMG_NAME"

# EdDSA signature via Sparkle's sign_update tool. The Sparkle SPM
# artefact ships it inside the binary target; we have to fish it out.
SIGN_TOOL=$(find "$PROJ_DIR/.build/artifacts" -name 'sign_update' -type f -perm -u+x 2>/dev/null | head -1)
if [ -z "$SIGN_TOOL" ]; then
  echo -e "${RED}[appcast] Sparkle sign_update tool not found in .build/artifacts. Run 'swift package resolve' first.${NC}" >&2
  exit 1
fi

PRIVATE_KEY_FILE="${MEETNOTES_SU_PRIVATE_KEY_FILE:-$HOME/.meetnotes/sparkle_ed25519}"
if [ ! -f "$PRIVATE_KEY_FILE" ]; then
  echo -e "${RED}[appcast] Sparkle private key not found at $PRIVATE_KEY_FILE${NC}" >&2
  echo -e "${RED}[appcast] Generate one (one-time): \"\$SIGN_TOOL\" --generate-keys (see docs/how-to/release-with-auto-update.md)${NC}" >&2
  exit 1
fi

# sign_update with --ed-key-file emits a SUSignedString that goes into
# the sparkle:edSignature attribute. Newer Sparkle outputs the
# attribute line directly; we capture stdout verbatim.
SIG_LINE=$("$SIGN_TOOL" --ed-key-file "$PRIVATE_KEY_FILE" "$DMG_PATH")

DMG_SIZE=$(stat -f '%z' "$DMG_PATH" 2>/dev/null || stat -c '%s' "$DMG_PATH")
PUB_DATE=$(date -u "+%a, %d %b %Y %H:%M:%S +0000")

cat <<XML
    <item>
      <title>Version $VERSION</title>
      <link>$DOWNLOAD_URL</link>
      <sparkle:version>$VERSION</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <description>
        <![CDATA[
          See <a href="https://github.com/grid-devs/notes-extension/blob/main/CHANGELOG.md">CHANGELOG.md</a> for the full list of changes.
        ]]>
      </description>
      <pubDate>$PUB_DATE</pubDate>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure
        url="$DOWNLOAD_URL"
        length="$DMG_SIZE"
        type="application/octet-stream"
        $SIG_LINE
      />
    </item>
XML
