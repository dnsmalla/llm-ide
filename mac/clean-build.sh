#!/bin/bash
# ============================================
# Quick clean build helper
# Deletes all caches and rebuilds from scratch
# Safe to run — kills the app first, cleans caches, then rebuilds
# ============================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🧹 Starting clean build..."
echo ""

"$SCRIPT_DIR/Scripts/build.sh" --clean-all

echo ""
echo "✅ Clean build complete!"
echo ""
echo "To do a full dev build with signing and DMG:"
echo "  ./mac/build_app.sh --clean-all"
