#!/usr/bin/env bash
# Delegates to the canonical root-level script.
# Usage: npm run sync:skills   (from extension/)
set -euo pipefail
exec bash "$(cd "$(dirname "$0")/../.." && pwd)/scripts/sync-skills.sh" "$@"
