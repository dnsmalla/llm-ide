#!/bin/bash
# Runs the iPhone app's own unit tests (ios_app/MyAppTests) on the first available iPhone Simulator.
# Skips with a message when no simulator runtime is installed (CI without Xcode simulators).
set -euo pipefail
cd "$(dirname "$0")/../ios_app"

device="$(env -u DEVELOPER_DIR xcrun simctl list devices available | grep -m1 iPhone | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' || true)"
if [ -z "$device" ]; then
  echo "No iPhone Simulator runtime installed; skipping the app tests"
  exit 0
fi

# The Makefile exports a macOS SDKROOT for the Swift package builds; an iOS build must not inherit it.
env -u SDKROOT xcodebuild -project MyApp.xcodeproj -scheme MyApp \
  -destination "id=$device" CODE_SIGNING_ALLOWED=NO test
