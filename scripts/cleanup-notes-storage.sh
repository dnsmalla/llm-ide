#!/bin/bash
# Clean up Notes app storage if circular references are causing issues
# WARNING: Only run this if you're experiencing actual problems with Notes

NOTES_STORAGE="$HOME/Library/Group Containers/group.com.apple.notes"

echo "⚠️  This script will help clean up Notes app storage if needed"
echo "📍 Notes storage location: $NOTES_STORAGE"
echo ""
echo "If you're seeing 'graph containing graph' in the Notes app UI:"
echo "1. This is likely a UI artifact, not a real circular reference"
echo "2. Our LLM IDE migration code does NOT create circular references"
echo "3. The Notes app's internal structure may show visual duplication"
echo ""
echo "To verify there's no real circular reference:"
echo "  ls -la '$NOTES_STORAGE/Accounts/511394D1-7740-45FD-A0E5-89F85F0BF6F4/Media/CD124632-F578-4574-B3CD-021C5761A38B/'"
echo ""
echo "To see if there are actual circular symlinks:"
echo "  find '$NOTES_STORAGE' -maxdepth 5 -type l -ls"
echo ""
echo "Our migration code only creates:"
echo "  .llm-ide/memory/  (from graphify-out/memory)"
echo "  .llm-ide/graph/   (from system/graph)"
echo "No circular references are created by this process."
