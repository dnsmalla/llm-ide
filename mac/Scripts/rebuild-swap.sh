#!/bin/bash
# ============================================
# Detached swap helper: waits for the app process to exit, keeps ONE
# rollback slot (<target>.bak), installs the staged bundle, relaunches.
# Spawned by FeatureRebuildService right before NSApp.terminate; must
# not die with its parent (the service starts it via nohup/setsid).
# Usage: rebuild-swap.sh <staged_app> <target_app> <pid>
# ============================================
set -euo pipefail

# Guard against a malformed invocation BEFORE `set -u` would kill the script
# invisibly. This runs detached (nohup/setsid) and the real log isn't opened
# until after $TARGET is parsed below, so a died-too-early failure could
# otherwise vanish with no trace; write to stderr AND a fallback log.
if [ $# -ne 3 ]; then
  FALLBACK_LOG="${TMPDIR:-/tmp}/llmide-rebuild-swap-error.log"
  MSG="[swap] $(date) usage error: expected 3 args (staged_app target_app pid), got $#: $*"
  echo "$MSG" >&2
  echo "Usage: rebuild-swap.sh <staged_app> <target_app> <pid>" >&2
  { echo "$MSG"; echo "Usage: rebuild-swap.sh <staged_app> <target_app> <pid>"; } >>"$FALLBACK_LOG" 2>/dev/null || true
  exit 2
fi

STAGED="$1"; TARGET="$2"; PID="$3"

# Breadcrumb read by FeatureRebuildService.init on the app's NEXT launch —
# the relaunched app has no other way to learn a previous install attempt
# failed. Lives beside the staged bundle (the staging dir), not beside the
# log, so it survives the log-target fallback below.
ERROR_FILE="$(dirname "$STAGED")/last-swap-error.txt"

abort() {
  echo "$1" >&2
  echo "$1" >"$ERROR_FILE" 2>/dev/null || true
  exit 1
}

LOG="${TARGET%.app}.rebuild.log"
# Same reasoning as the arg-guard fallback above: the target's directory may
# not be writable (permissions, read-only volume, etc.) — fall back to a
# TMPDIR log rather than losing every line silently.
if ! touch "$LOG" 2>/dev/null; then
  LOG="${TMPDIR:-/tmp}/llmide-rebuild-swap.log"
fi
exec >>"$LOG" 2>&1

# Clear any stale breadcrumb from a previous failed run now that a fresh
# attempt is underway — a successful run must not leave old news behind.
rm -f "$ERROR_FILE" 2>/dev/null || true

echo "[swap] $(date) waiting for pid $PID"
for _ in $(seq 1 120); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  abort "[swap] pid $PID still alive after 120s — aborting, nothing touched"
fi
[ -d "$STAGED" ] || abort "[swap] staged bundle missing: $STAGED"
[ -x "$STAGED/Contents/MacOS/LlmIdeMac" ] || abort "[swap] staged bundle has no executable at Contents/MacOS/LlmIdeMac: $STAGED"
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET.bak"
  mv "$TARGET" "$TARGET.bak" || abort "[swap] ERROR: failed to back up $TARGET to $TARGET.bak — aborting, staged app NOT installed"
  echo "[swap] previous app kept at $TARGET.bak"
fi
mv "$STAGED" "$TARGET" || abort "[swap] ERROR: failed to move staged app into $TARGET — target may now be absent (previous kept at $TARGET.bak if it existed); staged bundle remains at $STAGED"
echo "[swap] installed; relaunching"
rm -f "$ERROR_FILE" 2>/dev/null || true
open "$TARGET"
