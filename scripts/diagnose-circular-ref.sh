#!/bin/bash
# Diagnostic script to check for circular references in .llm-ide directory structure
# Usage: ./scripts/diagnose-circular-ref.sh <repo-root>

set -euo pipefail

REPO_ROOT="${1:-.}"
LLM_IDE_DIR="$REPO_ROOT/.llm-ide"

echo "🔍 Checking .llm-ide directory structure at: $REPO_ROOT"
echo "======================================================================"
echo ""

if [ ! -d "$LLM_IDE_DIR" ]; then
    echo "❌ .llm-ide directory does not exist at: $LLM_IDE_DIR"
    exit 1
fi

echo "✅ Found .llm-ide directory"
echo ""

# Function to check for circular references using find with max depth
check_circular_ref() {
    local dir="$1"
    local subdir="$2"

    echo "🔍 Checking $subdir/"

    if [ ! -d "$dir" ]; then
        echo "⚠️  $subdir/ directory does not exist"
        echo ""
        return
    fi

    echo "Directory structure (max depth 5):"
    find "$dir" -maxdepth 5 -print 2>/dev/null | head -50 | while read -r path; do
        depth=$(echo "$path" | tr -cd '/' | wc -c)
        indent=$(printf '%*s' "$((depth * 2))" '')
        name=$(basename "$path")
        if [ -d "$path" ]; then
            echo "$indent📁 $name"
        else
            echo "$indent  📄 $name"
        fi
    done

    # Check for symlinks that might create circular references
    echo ""
    echo "Checking for symlinks:"
    find "$dir" -maxdepth 3 -type l -print 2>/dev/null | while read -r link; do
        echo "  🔗 $link -> $(readlink "$link")"
    done

    # Check for directories named same as parent
    echo ""
    echo "Checking for duplicate directory names:"
    find "$dir" -maxdepth 3 -type d -print 2>/dev/null | while read -r d; do
        dirname=$(basename "$d")
        parent=$(dirname "$d")
        if [ -d "$parent/$dirname/$dirname" ]; then
            echo "  🚨 DUPLICATE: $parent/$dirname contains $dirname/"
        fi
    done

    echo ""
}

# Check each subdirectory
for subdir in memory graph cache; do
    check_circular_ref "$LLM_IDE_DIR/$subdir" "$subdir"
done

echo "======================================================================"
echo "✅ Diagnostic complete"
echo ""
echo "If you see duplicate directory names or suspicious symlinks above,"
echo "that may indicate the source of the circular reference."
