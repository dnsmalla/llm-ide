#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/mac"

echo "Building MeetNotesMac…"
if ! swift build 2>&1 | grep -v "^warning:"; then
  echo "❌ Build failed." >&2
  exit 1
fi

BINARY=".build/debug/MeetNotesMac"
if [ ! -f "$BINARY" ]; then
  echo "❌ Binary not found at $BINARY" >&2
  exit 1
fi

# Stop any running instance
pkill -f "MeetNotesMac" 2>/dev/null || true
sleep 0.3

APP_DIR="${TMPDIR:-/tmp}/MeetNotesMac.app"
mkdir -p "$APP_DIR/Contents/MacOS"
cp "$BINARY" "$APP_DIR/Contents/MacOS/MeetNotesMac"

# The binary links @rpath/Sparkle.framework and carries an @loader_path rpath,
# so the framework must sit next to the executable. Copy whichever build
# variant exists (path is arch-prefixed under newer SwiftPM layouts).
SPARKLE=""
for cand in ".build/debug/Sparkle.framework" \
            ".build/arm64-apple-macosx/debug/Sparkle.framework" \
            ".build/x86_64-apple-macosx/debug/Sparkle.framework"; do
  [ -d "$cand" ] && SPARKLE="$cand" && break
done
if [ -n "$SPARKLE" ]; then
  rm -rf "$APP_DIR/Contents/MacOS/Sparkle.framework"
  cp -R "$SPARKLE" "$APP_DIR/Contents/MacOS/Sparkle.framework"
else
  echo "⚠️  Sparkle.framework not found in .build — app may fail to launch." >&2
fi

cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>MeetNotesMac</string>
    <key>CFBundleIdentifier</key><string>com.meetnotes.macapp</string>
    <key>CFBundleName</key><string>MeetNotesMac</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

echo "✅ Launching MeetNotesMac…"
open "$APP_DIR"
