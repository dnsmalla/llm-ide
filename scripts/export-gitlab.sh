#!/usr/bin/env bash
# Export a partial copy of this repo (paths in scripts/gitlab-export-paths.txt,
# with their history) for the GitLab mirror. GitHub is the source of truth; the
# mirror is one-way.
#
# The rewrite is deterministic for a given input + path list + git-filter-repo
# version, so each run only appends commits and a plain push fast-forwards.
#
# Usage:
#   scripts/export-gitlab.sh <out-dir> [--push <remote-url>] [--force]
#
# Env:
#   EXPORT_SOURCE  repo to export from (default: this checkout)
#   EXPORT_BRANCH  branch to export (default: main)
set -euo pipefail

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# Only graph-kit's gitlink survives the path filter, so every .gitmodules
# version keeps only graph-kit's section. Otherwise setup.sh tries to init
# `.skills` (pathspec error under set -e) and the private test-repo URL leaks.
# Done as a blob callback so it stays in history and deterministic.
# NOTE: the callback never sees file names; any exported file starting with
# "[submodule " would be filtered too (only .gitmodules does today).
read -r -d '' GITMODULES_CALLBACK <<'PY' || true
import re
if blob.data.startswith(b"[submodule "):
    sections = re.split(rb"(?m)^(?=\[submodule )", blob.data)
    blob.data = b"".join(
        s for s in sections
        if re.search(rb"(?m)^\s*path\s*=\s*graph-kit\s*$", s))
PY

[ $# -ge 1 ] || usage
OUT=$1; shift
PUSH_URL=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH_URL=${2:?--push needs a URL}; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) usage ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${EXPORT_SOURCE:-$(cd "$HERE/.." && pwd)}
BRANCH=${EXPORT_BRANCH:-main}
PATHS="$HERE/gitlab-export-paths.txt"

command -v git-filter-repo >/dev/null || {
  echo "git-filter-repo not found: pip install git-filter-repo==2.45.0" >&2; exit 1; }

# filter-repo rewrites in place, so always work on a fresh clone, never $SRC.
rm -rf "$OUT"
git clone --quiet --no-local --single-branch --no-tags --branch "$BRANCH" "$SRC" "$OUT"
grep -vE '^\s*(#|$)' "$PATHS" > "$OUT/.git/export-paths"
git -C "$OUT" filter-repo --force --quiet --paths-from-file .git/export-paths \
  --blob-callback "$GITMODULES_CALLBACK"

echo "exported $(git -C "$OUT" rev-list --count HEAD) commits, tip $(git -C "$OUT" rev-parse --short HEAD)"

if [ -n "$PUSH_URL" ]; then
  args=(push "$PUSH_URL" "HEAD:refs/heads/$BRANCH")
  [ "$FORCE" = 1 ] && args+=(--force)
  git -C "$OUT" "${args[@]}"
fi
