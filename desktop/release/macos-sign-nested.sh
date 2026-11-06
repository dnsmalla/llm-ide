#!/usr/bin/env bash
# desktop/release/macos-sign-nested.sh <coreDir> <identity|--list>
# Signs every Mach-O file in the staged core (node, *.node prebuilds, any vendored helper) with the Developer ID,
# hardened runtime and a secure timestamp; node also gets node-entitlements.plist. --list only prints them.
set -euo pipefail
core="${1:?core dir}"; identity="${2:?identity or --list}"
ent="$(cd "$(dirname "$0")" && pwd)/node-entitlements.plist"
[ -f "$core/node/node" ] || { echo "no bundled node at $core/node/node (run stage-core.mjs)" >&2; exit 1; }
count=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  count=$((count + 1))
  if [ "$identity" = "--list" ]; then echo "$f"; continue; fi
  if [ "$f" = "$core/node/node" ]; then
    codesign --force --timestamp --options runtime --entitlements "$ent" --sign "$identity" "$f"
  else
    codesign --force --timestamp --options runtime --sign "$identity" "$f"
  fi
  codesign --verify --strict "$f"
done < <(find "$core" -type f -print0)
echo "Mach-O files: $count"
