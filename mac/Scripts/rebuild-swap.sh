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
LOG="${TARGET%.app}.rebuild.log"
exec >>"$LOG" 2>&1
echo "[swap] $(date) waiting for pid $PID"
for _ in $(seq 1 120); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "[swap] pid $PID still alive after 120s — aborting, nothing touched"
  exit 1
fi
[ -d "$STAGED" ] || { echo "[swap] staged bundle missing: $STAGED"; exit 1; }
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET.bak"
  mv "$TARGET" "$TARGET.bak" || {
    echo "[swap] ERROR: failed to back up $TARGET to $TARGET.bak — aborting, staged app NOT installed"
    exit 1
  }
  echo "[swap] previous app kept at $TARGET.bak"
fi
mv "$STAGED" "$TARGET" || {
  echo "[swap] ERROR: failed to move staged app into $TARGET — target may now be absent (previous kept at $TARGET.bak if it existed); staged bundle remains at $STAGED"
  exit 1
}
echo "[swap] installed; relaunching"
open "$TARGET"
