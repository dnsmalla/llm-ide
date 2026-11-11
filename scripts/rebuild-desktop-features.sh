#!/usr/bin/env bash
# In-app Apply & Rebuild: build this app from its source checkout with only the selected features compiled in,
# then wait for the running app to quit, swap the installed .app (one rollback slot) and reopen it.
#
#   scripts/rebuild-desktop-features.sh <app-pid> <comma-features> <source-root>
#
# Called by the host command `feature_rebuild` (Settings > Build), detached in its own process group so quitting
# the app does not kill the build. The live app is not touched until the new bundle passed verify + smoke; the
# build uses a separate CARGO_TARGET_DIR and is copied out with LLMIDE_BUILD_OUT.
set -euo pipefail

PID="${1:?usage: rebuild-desktop-features.sh <app-pid> <features> <source-root>}"
FEATURES="${2:?usage: rebuild-desktop-features.sh <app-pid> <features> <source-root>}"
ROOT="${3:?usage: rebuild-desktop-features.sh <app-pid> <features> <source-root>}"

[ -d "$ROOT/desktop" ] || { echo "not an LLM-IDE source checkout: $ROOT" >&2; exit 2; }
case "$FEATURES" in
  *[!a-z0-9_,]*) echo "invalid feature list: $FEATURES" >&2; exit 2 ;;
esac
[[ "$FEATURES" == *, ]] && { echo "invalid feature list: $FEATURES" >&2; exit 2; }

# An app launched from Finder has a minimal PATH (/usr/bin:/bin): give the build the usual toolchains.
for d in "$HOME"/.rustup/toolchains/stable-*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"

LOG_DIR="${LLMIDE_REBUILD_LOG_DIR:-$HOME/Library/Logs/LLM-IDE}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/rebuild.log"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/llmide-rebuild-XXXXXX")"
APP="$ROOT/desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app"
CACHE="${LLMIDE_REBUILD_TARGET_DIR:-$HOME/Library/Caches/LLM-IDE/rebuild-target}"

finish() {
  local code=$?
  echo "=== rebuild exit $code at $(date) ===" >>"$LOG"
  rm -rf "$STAGE"
}
trap finish EXIT

{
  echo
  echo "=== rebuild $(date) features=$FEATURES app-pid=$PID ==="
  CARGO_TARGET_DIR="$CACHE" LLMIDE_BUILD_FEATURES="$FEATURES" LLMIDE_BUILD_OUT="$STAGE" \
    "$ROOT/scripts/build-desktop-mac.sh" 2>&1
} >>"$LOG" 2>&1

NEW="$STAGE/LLM-IDE.app"
[ -d "$NEW" ] || { echo "the build finished without a staged app" >&2; exit 1; }

# The app stayed usable during the build; restart it now (SIGTERM, a short grace, then KILL) and swap.
# The Build card warned that unsaved work is lost at this point.
kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
kill -KILL "$PID" 2>/dev/null || true
# The app's Node core is a separate process. A SIGKILL of the app can orphan it, and a new app then
# finds :3456 busy and spawns on :3457 while the old backend keeps serving the old code. Stop the
# bundled core explicitly before swapping the bundle, then wait for the port to be released.
CORE="$APP/Contents/Resources/core/node"
pkill -TERM -f "$CORE" 2>/dev/null || true
for _ in $(seq 1 20); do pgrep -f "$CORE" >/dev/null || break; sleep 0.25; done
pkill -KILL -f "$CORE" 2>/dev/null || true
sleep 1

rm -rf "$APP.bak"
if [ -d "$APP" ]; then mv "$APP" "$APP.bak"; fi
ditto "$NEW" "$APP"
open "$APP"
echo "=== installed $(date); rollback: $APP.bak ===" >>"$LOG"
