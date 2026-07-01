#!/bin/bash
# ============================================
# Build phase: compile Swift code and assemble the .app bundle.
# Standalone — does not sign, notarize, or package.
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
# Single source of truth: mac/VERSION. Bump there, both build.sh and
# dmg.sh pick it up automatically.
VERSION=$(cat "$PROJ_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')
if [ -z "$VERSION" ]; then
  echo -e "${RED}[build] mac/VERSION missing or empty${NC}" >&2
  exit 1
fi

echo -e "${BLUE}[build]${NC} stopping any running $APP_NAME..."
pkill -9 -f "$APP_NAME" 2>/dev/null || true

echo -e "${BLUE}[build]${NC} cleaning old bundle at $APP_DIR..."
rm -rf "$APP_DIR"

echo -e "${BLUE}[build]${NC} creating bundle skeleton..."
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

if [ -f "$PROJ_DIR/app_logo.png" ]; then
  echo -e "${BLUE}[build]${NC} generating app icon..."
  cp "$PROJ_DIR/app_logo.png" "$APP_DIR/Contents/Resources/AppIcon.png"
  ICONSET="$APP_DIR/Contents/Resources/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 128 256 512; do
    sips -z $sz $sz       "$PROJ_DIR/app_logo.png" --out "$ICONSET/icon_${sz}x${sz}.png" > /dev/null 2>&1
    sips -z $((sz*2)) $((sz*2)) "$PROJ_DIR/app_logo.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" > /dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP_DIR/Contents/Resources/AppIcon.icns" 2>/dev/null || true
  rm -rf "$ICONSET"
fi

echo -e "${BLUE}[build]${NC} writing Info.plist..."

# Sparkle wiring. Two env vars feed the appcast lookup + signature
# verification:
#   LLMIDE_SU_FEED_URL    e.g. https://updates.llmide.app/appcast.xml
#   LLMIDE_SU_PUBLIC_KEY  Base64 EdDSA public key (from generate_keys)
# Both are optional — when unset (typical dev build) Sparkle starts
# but never finds updates and "Check for Updates…" reports "no updates
# available". For a release build, set both before running release.sh.
SU_FEED_URL="${LLMIDE_SU_FEED_URL:-}"
SU_PUBLIC_KEY="${LLMIDE_SU_PUBLIC_KEY:-}"
SPARKLE_KEYS=""
if [ -n "$SU_FEED_URL" ]; then
  SPARKLE_KEYS+="
    <key>SUFeedURL</key>
    <string>$SU_FEED_URL</string>"
fi
if [ -n "$SU_PUBLIC_KEY" ]; then
  SPARKLE_KEYS+="
    <key>SUPublicEDKey</key>
    <string>$SU_PUBLIC_KEY</string>"
fi
# Enable automatic checks by default; user can toggle off in Settings.
SPARKLE_KEYS+="
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUScheduledCheckInterval</key>
    <integer>86400</integer>"

cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>$SPARKLE_KEYS
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.llmide.macapp</string>
    <key>CFBundleName</key>
    <string>LLM IDE</string>
    <key>CFBundleDisplayName</key>
    <string>LLM IDE</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
    <key>LSMultipleInstancesProhibited</key>
    <true/>
    <key>NSSupportsAutomaticTermination</key>
    <false/>
    <key>NSMicrophoneUsageDescription</key>
    <string>LLM IDE uses the microphone only when caption scraping is unavailable, as a fallback transcription source.</string>
    <key>NSScreenCaptureDescription</key>
    <string>LLM IDE can capture audio from a single meeting app (Zoom, Teams, etc.) when its in-app captions are not exposed.</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
        <key>NSExceptionDomains</key>
        <dict>
            <key>localhost</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
                <key>NSIncludesSubdomains</key>
                <true/>
            </dict>
            <key>127.0.0.1</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
            </dict>
        </dict>
    </dict>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>com.llmide.macapp.deeplink</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>llmide</string>
                <string>meetnotes</string>
            </array>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
        </dict>
    </array>
</dict>
</plist>
PLIST

if [ -d "$PROJ_DIR/Sources/LlmIdeMac/Resources" ]; then
  rsync -a "$PROJ_DIR/Sources/LlmIdeMac/Resources/" "$APP_DIR/Contents/Resources/"
fi

cd "$PROJ_DIR"

# Dependency resolution. One dependency (graph-kit) is a PRIVATE repo, so a
# plain `swift build` — which contacts every remote to check for updates —
# fails with "could not read Username for 'https://github.com'" on any machine
# without git credentials, even when the pinned versions are already cached.
#
# So resolve OFFLINE first: `--disable-automatic-resolution` uses only the
# versions in Package.resolved and never re-checks remotes. When the local
# cache already satisfies Package.resolved (the common case — warm `.build/`)
# this needs no network and no credentials. We then build with the same flag
# so the build step can't reach out either.
#
# Only when the cache can't satisfy Package.resolved (fresh checkout, or a
# deliberate dependency bump) do we fall back to a networked resolve — which
# does require credentials for graph-kit. Set LLMIDE_FORCE_RESOLVE=1 to skip
# the offline attempt and always resolve from remotes.
SPM_OFFLINE="--disable-automatic-resolution"
if [ "${LLMIDE_FORCE_RESOLVE:-}" = "1" ]; then
  echo -e "${BLUE}[build]${NC} LLMIDE_FORCE_RESOLVE=1 — resolving dependencies from remotes..."
  swift package resolve
  SPM_OFFLINE=""
elif swift package resolve --disable-automatic-resolution >/dev/null 2>&1; then
  echo -e "${BLUE}[build]${NC} dependencies satisfied from Package.resolved (offline — no remote fetch)"
else
  echo -e "${BLUE}[build]${NC} Package.resolved not fully cached — resolving from remotes (needs network + git credentials for graph-kit)..."
  swift package resolve
  SPM_OFFLINE=""
fi

echo -e "${BLUE}[build]${NC} compiling via swift build (release)..."
if ! swift build -c release --product "$APP_NAME" $SPM_OFFLINE; then
  echo -e "${RED}[build] swift build failed.${NC}" >&2
  echo -e "${RED}[build] If the error mentions 'could not read Username for https://github.com',${NC}" >&2
  echo -e "${RED}[build] the private graph-kit dependency needs to be fetched once with git${NC}" >&2
  echo -e "${RED}[build] credentials. Run 'swift package resolve' with credentials available,${NC}" >&2
  echo -e "${RED}[build] then re-run this script (the warm cache then builds offline).${NC}" >&2
  exit 1
fi

BUILT_BIN="$PROJ_DIR/.build/release/$APP_NAME"
if [ ! -f "$BUILT_BIN" ]; then
  echo -e "${RED}[build] swift build did not produce $BUILT_BIN${NC}"
  exit 1
fi
cp "$BUILT_BIN" "$APP_DIR/Contents/MacOS/$APP_NAME"

# Sparkle ships as a binary framework via SPM. The framework bundle
# isn't automatically vendored into the .app — we have to copy it
# into Contents/Frameworks/ ourselves and fix the executable's
# @rpath so dyld finds it at runtime. Without this the app crashes
# on launch with "Library not loaded: @rpath/Sparkle.framework".
SPARKLE_SRC=$(find "$PROJ_DIR/.build" -path '*/Sparkle.framework' -type d -print -quit)
if [ -n "$SPARKLE_SRC" ] && [ -d "$SPARKLE_SRC" ]; then
  echo -e "${BLUE}[build]${NC} vendoring Sparkle.framework from $SPARKLE_SRC..."
  mkdir -p "$APP_DIR/Contents/Frameworks"
  rm -rf "$APP_DIR/Contents/Frameworks/Sparkle.framework"
  cp -R "$SPARKLE_SRC" "$APP_DIR/Contents/Frameworks/"
  # The dylib install_name compiled into the SPM artefact references
  # the build-tree path. Re-point it at the framework's @rpath inside
  # the bundle so dyld resolves from Contents/Frameworks.
  install_name_tool -add_rpath "@executable_path/../Frameworks" \
    "$APP_DIR/Contents/MacOS/$APP_NAME" 2>/dev/null || true
else
  echo -e "${BLUE}[build]${NC} Sparkle.framework not found in .build — auto-update will be inert."
fi

echo -e "${GREEN}[build]${NC} ok — $APP_DIR"
