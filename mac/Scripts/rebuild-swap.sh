#!/bin/bash
# ============================================
# Detached swap helper: waits for the app process to exit, keeps ONE
# rollback slot (<target>.bak), installs the staged bundle, relaunches.
# Spawned by FeatureRebuildService right before NSApp.terminate; must
# not die with its parent (the service starts it via nohup/setsid).
# Usage: rebuild-swap.sh <staged_app> <target_app> <pid>
# ============================================
set -uo pipefail
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
  mv "$TARGET" "$TARGET.bak"
  echo "[swap] previous app kept at $TARGET.bak"
fi
mv "$STAGED" "$TARGET"
echo "[swap] installed; relaunching"
open "$TARGET"
