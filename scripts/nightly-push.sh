#!/usr/bin/env bash
# Nightly push: code all day, push at night.
# Runs lint + markdownlint, takes a git bundle backup, then `git push origin main`
# (the pre-push hook runs the full build/test gate). Never uses --no-verify.
#
# Usage:   scripts/nightly-push.sh            # real run
#          scripts/nightly-push.sh --dry-run  # checks only, no push
# Install: scripts/nightly-push.sh --help
set -u

REPO="${LLMIDE_REPO:-$HOME/llm-ide}"
LOG_DIR="${LLMIDE_NIGHTLY_LOG_DIR:-$HOME/Library/Logs/llm-ide}"
BACKUP_DIR="${LLMIDE_NIGHTLY_BACKUP_DIR:-$HOME/Library/Application Support/llm-ide/push-backups}"
KEEP_BACKUPS=7
DRY=0

case "${1:-}" in
  --dry-run) DRY=1 ;;
  --help|-h)
    cat <<EOF
Install (one command each):
  mkdir -p "$LOG_DIR"
  cp "$REPO/scripts/com.llmide.nightly-push.plist" ~/Library/LaunchAgents/
  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.llmide.nightly-push.plist
Remove:
  launchctl bootout gui/\$(id -u)/com.llmide.nightly-push
Wake the Mac at 01:55 (yours to run, needs sudo):
  sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
EOF
    exit 0 ;;
esac

mkdir -p "$LOG_DIR" "$BACKUP_DIR"
LOG="$LOG_DIR/nightly-push-$(date +%Y%m%d-%H%M%S).log"
exec >>"$LOG" 2>&1

notify() { # title, message
  osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}
fail() {
  echo "FAILED: $*"
  notify "LLM-IDE nightly push" "Failed: $* (see $LOG)"
  exit 1
}

echo "== nightly push $(date) dry=$DRY =="
cd "$REPO" || fail "repo not found at $REPO"

# Refuse while agents/editors are working: the tree must be quiet.
if pgrep -f "claude" >/dev/null 2>&1 && [ "${LLMIDE_NIGHTLY_ALLOW_CLAUDE:-0}" != "1" ]; then
  echo "A claude process is running; skipping tonight (set LLMIDE_NIGHTLY_ALLOW_CLAUDE=1 to override)."
  notify "LLM-IDE nightly push" "Skipped: claude is running"
  exit 0
fi
if pgrep -f "git (push|commit|rebase|merge)" >/dev/null 2>&1; then
  echo "A git operation is in progress; skipping."; exit 0
fi

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || fail "not on main (on $branch)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree has uncommitted tracked changes; refusing to push over them."
  git status --short --untracked-files=no
  notify "LLM-IDE nightly push" "Skipped: uncommitted changes"
  exit 0
fi

git fetch origin main || fail "git fetch failed (network?)"
ahead=$(git rev-list --count origin/main..main)
behind=$(git rev-list --count main..origin/main)
echo "ahead=$ahead behind=$behind"
[ "$behind" -eq 0 ] || fail "main is behind origin/main by $behind commits; resolve by hand"
if [ "$ahead" -eq 0 ]; then echo "Nothing to push."; exit 0; fi

# Backup of the unpushed commits before anything else.
BUNDLE="$BACKUP_DIR/unpushed-$(date +%Y%m%d-%H%M%S).bundle"
git bundle create "$BUNDLE" origin/main..main || fail "bundle backup failed"
ls -1t "$BACKUP_DIR"/unpushed-*.bundle 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do rm -f "$f"; done
echo "backup: $BUNDLE"

echo "-- make lint"
make lint || fail "make lint"
echo "-- markdownlint"
npx markdownlint-cli2 'docs/**/*.md' '!docs/superpowers/**' || fail "markdownlint"

if [ "$DRY" -eq 1 ]; then
  echo "Dry run OK: $ahead commits would be pushed."
  notify "LLM-IDE nightly push" "Dry run OK ($ahead commits)"
  exit 0
fi

echo "-- git push origin main (pre-push gate runs)"
if caffeinate -dims git push origin main; then
  echo "PUSHED $ahead commits"
  notify "LLM-IDE nightly push" "Pushed $ahead commits"
else
  fail "git push (gate or remote rejected)"
fi
