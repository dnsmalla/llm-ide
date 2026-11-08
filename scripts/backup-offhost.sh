#!/usr/bin/env bash
# Nightly off-host copy of the newest backup PAIR (data-<stamp>.db + data-<stamp>.agent.db) to the sync host's
# backups/ folder, keeping the newest LLMIDE_OFFHOST_KEEP stamps there. Run from cron as the llmide service user:
# the SSH key and known_hosts are that user's; this file holds no secrets. See deploy/vps/README.md.
set -euo pipefail

: "${LLMIDE_BACKUP_DIR:=/var/lib/llmide/backups}"
: "${LLMIDE_OFFHOST_HOST:?set LLMIDE_OFFHOST_HOST to the sync host}"
: "${LLMIDE_OFFHOST_USER:=llmide}"
: "${LLMIDE_OFFHOST_PATH:=backups}"
: "${LLMIDE_OFFHOST_KEEP:=7}"

[ -d "$LLMIDE_BACKUP_DIR" ] || { echo "backup-offhost: no backup directory $LLMIDE_BACKUP_DIR" >&2; exit 1; }

# Newest stamp by name (the filename carries the unix second; mtimes change when copies move).
newest="$(ls -1 "$LLMIDE_BACKUP_DIR"/data-*.db 2>/dev/null | grep -v '\.agent\.db$' | sed -e 's/.*data-//' -e 's/\.db$//' | sort -n | tail -1 || true)"
[ -n "$newest" ] || { echo "backup-offhost: no data-<stamp>.db in $LLMIDE_BACKUP_DIR" >&2; exit 1; }

remote="$LLMIDE_OFFHOST_USER@$LLMIDE_OFFHOST_HOST"
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
scp_opts=(-q -p -o BatchMode=yes -o StrictHostKeyChecking=yes)

ssh "${ssh_opts[@]}" "$remote" "mkdir -p $(printf '%q' "$LLMIDE_OFFHOST_PATH")"

files=("$LLMIDE_BACKUP_DIR/data-$newest.db")
[ -f "$LLMIDE_BACKUP_DIR/data-$newest.agent.db" ] && files+=("$LLMIDE_BACKUP_DIR/data-$newest.agent.db")
scp "${scp_opts[@]}" "${files[@]}" "$remote:$LLMIDE_OFFHOST_PATH/"

# Keep the newest N stamps there (the pair is deleted together).
keep=$(( LLMIDE_OFFHOST_KEEP > 0 ? LLMIDE_OFFHOST_KEEP : 1 ))
ssh "${ssh_opts[@]}" "$remote" "cd $(printf '%q' "$LLMIDE_OFFHOST_PATH") && ls -1 data-*.db 2>/dev/null \
  | sed -e 's/^data-//' -e 's/\.agent\.db$//' -e 's/\.db$//' | sort -nu | head -n -$keep \
  | while read -r s; do rm -f \"data-\$s.db\" \"data-\$s.agent.db\"; done"

echo "backup-offhost: data-$newest copied to $remote:$LLMIDE_OFFHOST_PATH"
