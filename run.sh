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
