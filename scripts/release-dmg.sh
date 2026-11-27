#!/usr/bin/env bash
# Build unsigned macOS DMGs (Apple Silicon + Intel) on GitHub Actions and publish them as a GitLab Release.
#
# Usage:
#   scripts/release-dmg.sh <x.y.z> [--notes-file FILE] [--dry-run] [--yes] [--run-id N]
#
#   --dry-run   print every command, do nothing
#   --yes       do not ask when local HEAD differs from GitHub main
#   --run-id N  skip the dispatch and reuse a finished desktop-dmg run (resume after a failed upload)
#
# Prerequisites: `gh` logged in to GitHub (can run workflows on dnsmalla/llm-ide), `glab` logged in to
# gitlab.com (write access to grid-devs/personal/dinesh/llm-ide-app), and `jq`. No token is read or printed.
# The workflow builds the GitHub default branch; the GitLab tag points at GitLab main at release time.
# Re-running after a partial upload is safe: files already in the package registry with the same sha256 are skipped.
#
# The DMGs are UNSIGNED (ad-hoc signed only, no notarization). This is the owner's decision: nothing private
# (certificates, Apple account) is shared with the company. The release notes tell users how to open the app.
set -euo pipefail

GH_REPO="dnsmalla/llm-ide"
GL_PROJECT="grid-devs/personal/dinesh/llm-ide-app"
GL_PROJECT_ENC="grid-devs%2Fpersonal%2Fdinesh%2Fllm-ide-app"
WORKFLOW="desktop-dmg.yml"
PKG="llm-ide"

usage() {
  echo "usage: $0 <x.y.z> [--notes-file FILE] [--dry-run] [--yes] [--run-id N]" >&2
  exit 2
}

VERSION=""
NOTES_FILE=""
DRY=0
YES=0
RUN_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes-file) [ $# -ge 2 ] || usage; NOTES_FILE="$2"; shift ;;
    --run-id) [ $# -ge 2 ] || usage; RUN_ID="$2"; shift ;;
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$VERSION" ] || usage; VERSION="$1" ;;
  esac
  shift
done
[ -n "$VERSION" ] || usage
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be x.y.z, got '$VERSION'" >&2
  exit 2
fi
if [ -n "$RUN_ID" ] && ! [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "error: --run-id must be a number" >&2
  exit 2
fi
if [ -n "$NOTES_FILE" ] && [ ! -f "$NOTES_FILE" ]; then
  echo "error: notes file not found: $NOTES_FILE" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 2; }

TAG="v$VERSION"
FILES="LLM-IDE-$VERSION-arm64.dmg LLM-IDE-$VERSION-x64.dmg"
PKG_API="projects/$GL_PROJECT_ENC/packages/generic/$PKG/$VERSION"
BASE_URL="https://gitlab.com/api/v4/$PKG_API"

# Print the command in dry-run mode, run it otherwise.
run() {
  if [ "$DRY" = 1 ]; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# Run a read-only command, retrying transient failures (network, API hiccups). Prints stdout.
retry() {
  local n=1
  while true; do
    if "$@"; then return 0; fi
    [ "$n" -lt 5 ] || return 1
    n=$((n + 1)); sleep 5
  done
}

# exists_on_gitlab <description> <glab args...>: 0 = exists, 1 = not found; anything else (auth, network) aborts.
exists_on_gitlab() {
  local what="$1" out; shift
  if out="$("$@" 2>&1)"; then return 0; fi
  if printf '%s' "$out" | grep -qiE '404|not found'; then return 1; fi
  echo "error: could not check whether $what exists (auth or network?): $out" >&2
  exit 1
}

# --- 1. Refuse to overwrite an existing release or tag ---
echo "== Checking that $TAG does not exist on GitLab"
if [ "$DRY" = 1 ]; then
  run glab release view "$TAG" -R "$GL_PROJECT"
  run glab api "projects/$GL_PROJECT_ENC/repository/tags/$TAG"
else
  if exists_on_gitlab "release $TAG" glab release view "$TAG" -R "$GL_PROJECT"; then
    echo "error: GitLab release $TAG already exists" >&2; exit 1
  fi
  if exists_on_gitlab "tag $TAG" glab api "projects/$GL_PROJECT_ENC/repository/tags/$TAG"; then
    echo "error: GitLab tag $TAG already exists" >&2; exit 1
  fi
fi

# --- 2. Source check: the build uses GitHub main, not this checkout ---
if [ -z "$RUN_ID" ]; then
  echo "== Comparing local HEAD with GitHub main"
  if [ "$DRY" = 1 ]; then
    run gh api "repos/$GH_REPO/commits/main" --jq .sha
    run git rev-parse HEAD
  else
    GH_MAIN="$(retry gh api "repos/$GH_REPO/commits/main" --jq .sha)"
    LOCAL_HEAD="$(git rev-parse HEAD)"
    # Whole output, no `| head`: under pipefail a SIGPIPE'd git would end the script silently.
    DIRTY="$(git status --porcelain --untracked-files=no)"
    if [ "$GH_MAIN" != "$LOCAL_HEAD" ] || [ -n "$DIRTY" ]; then
      echo "warning: the DMGs will be built from GitHub main $GH_MAIN," >&2
      echo "         but this checkout is at $LOCAL_HEAD${DIRTY:+ (with uncommitted changes)}." >&2
      echo "         Unpushed local commits will NOT be in the DMGs." >&2
      if [ "$YES" != 1 ]; then
        [ -t 0 ] || { echo "error: not a terminal; re-run with --yes to continue" >&2; exit 1; }
        printf 'Continue? [y/N] '
        read -r answer
        case "$answer" in y|Y|yes) ;; *) echo "aborted" >&2; exit 1 ;; esac
      fi
    fi
  fi
fi

# --- 3. Dispatch the build and find our run ---
if [ -n "$RUN_ID" ]; then
  echo "== Reusing run $RUN_ID (no dispatch)"
else
  echo "== Dispatching $WORKFLOW"
  if [ "$DRY" = 1 ]; then
    run gh run list -R "$GH_REPO" --workflow "$WORKFLOW" --event workflow_dispatch --json databaseId
    run gh workflow run "$WORKFLOW" -R "$GH_REPO" -f "version=$VERSION"
    echo "+ (run id parsed from the URL gh prints; fallback: newest run titled 'desktop-dmg $VERSION' not seen before)"
    RUN_ID="<run-id>"
  else
    BEFORE="$(retry gh run list -R "$GH_REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 30 --json databaseId --jq '.[].databaseId')"
    DISPATCH_OUT="$(gh workflow run "$WORKFLOW" -R "$GH_REPO" -f "version=$VERSION" 2>&1)"
    echo "$DISPATCH_OUT"
    RUN_ID="$(printf '%s' "$DISPATCH_OUT" | grep -oE '/actions/runs/[0-9]+' | head -n 1 | grep -oE '[0-9]+' || true)"
    tries=0
    # Fallback for gh versions that print no URL: the workflow's run-name carries the version.
    while [ -z "$RUN_ID" ] && [ "$tries" -lt 30 ]; do
      sleep 4
      CANDIDATES="$(gh run list -R "$GH_REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 30 \
        --json databaseId,displayTitle --jq ".[] | select(.displayTitle == \"desktop-dmg $VERSION\") | .databaseId" 2>/dev/null || true)"
      for id in $CANDIDATES; do
        if ! printf '%s\n' "$BEFORE" | grep -qx "$id"; then RUN_ID="$id"; break; fi
      done
      tries=$((tries + 1))
    done
    [ -n "$RUN_ID" ] || { echo "error: could not find the dispatched run" >&2; exit 1; }
    echo "run id: $RUN_ID"
  fi
fi

# --- 4. Wait, download, verify ---
echo "== Waiting for run $RUN_ID"
run gh run watch "$RUN_ID" -R "$GH_REPO" --exit-status

if [ "$DRY" = 1 ]; then
  WORK="<tmpdir>"
  HEAD_SHA="<github-commit-sha>"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/llm-ide-dmg.XXXXXX")"
  HEAD_SHA="$(retry gh run view "$RUN_ID" -R "$GH_REPO" --json headSha --jq .headSha)"
fi
echo "== Downloading artifacts to $WORK"
run gh run download "$RUN_ID" -R "$GH_REPO" -D "$WORK"

if [ "$DRY" = 1 ]; then
  echo "+ (verify each file with: cd $WORK && shasum -a 256 -c <file>.sha256)"
else
  # Artifacts land in $WORK/llm-ide-dmg-<arch>/; flatten them.
  for f in $FILES; do
    found="$(find "$WORK" -name "$f" -type f | head -n 1)"
    [ -n "$found" ] || { echo "error: $f missing from the run's artifacts" >&2; exit 1; }
    mv "$found" "$WORK/$f"
    mv "$found.sha256" "$WORK/$f.sha256"
    (cd "$WORK" && shasum -a 256 -c "$f.sha256")
  done
fi

# --- 5. Upload to the GitLab generic package registry (skip identical files, verify the rest) ---
# remote_sha <file name>: sha256 GitLab holds for that package file, empty if none.
remote_sha() {
  local pkg_id
  pkg_id="$(retry glab api "projects/$GL_PROJECT_ENC/packages?package_type=generic&package_name=$PKG&package_version=$VERSION" \
    | jq -r --arg p "$PKG" '[.[] | select(.name == $p)] | .[0].id // empty')"  # package_name is a partial match
  [ -n "$pkg_id" ] || return 0
  retry glab api "projects/$GL_PROJECT_ENC/packages/$pkg_id/package_files?per_page=100" \
    | jq -r --arg n "$1" '[.[] | select(.file_name == $n)] | last | .file_sha256 // empty'
}

upload() { # file name
  local name="$1" local_sha remote response got
  if [ "$DRY" = 1 ]; then
    echo "+ (skip if the package already holds $name with the same sha256)"
    run glab api --method PUT -H 'Content-Type: application/octet-stream' "$PKG_API/$name?select=package_file" --input "$WORK/$name"
    echo "+ (compare file_sha256 in the response with the local sha256)"
    return 0
  fi
  local_sha="$(shasum -a 256 "$WORK/$name" | cut -d' ' -f1)"
  remote="$(remote_sha "$name")"
  if [ "$remote" = "$local_sha" ]; then
    echo "skip $name (already uploaded, sha256 matches)"
    return 0
  fi
  response="$(glab api --method PUT -H 'Content-Type: application/octet-stream' "$PKG_API/$name?select=package_file" --input "$WORK/$name")"
  got="$(printf '%s' "$response" | jq -r '.file_sha256 // empty')"
  if [ "$got" != "$local_sha" ]; then
    echo "error: $name upload sha256 mismatch (local $local_sha, GitLab '${got:-none}')" >&2
    exit 1
  fi
  echo "uploaded $name ($local_sha)"
}

echo "== Uploading to the GitLab package registry"
LINKS="["
SEP=""
SUMS=""
for f in $FILES; do
  upload "$f"
  upload "$f.sha256"
  # direct_asset_path gives stable /-/releases/<tag>/downloads/dmg/<file> URLs.
  LINKS="$LINKS$SEP{\"name\":\"$f\",\"url\":\"$BASE_URL/$f\",\"link_type\":\"package\",\"direct_asset_path\":\"/dmg/$f\"},{\"name\":\"$f.sha256\",\"url\":\"$BASE_URL/$f.sha256\",\"link_type\":\"other\",\"direct_asset_path\":\"/dmg/$f.sha256\"}"
  SEP=","
  if [ "$DRY" = 1 ]; then
    SUMS="$SUMS- $f: <sha256>
"
  else
    SUMS="$SUMS- \`$f\`: \`$(cut -d' ' -f1 "$WORK/$f.sha256")\`
"
  fi
done
LINKS="$LINKS]"

# --- 6. Release notes and release ---
NOTES="$WORK/release-notes.md"
if [ "$DRY" = 1 ]; then
  echo "+ (write release notes to $NOTES: install steps, SHA-256 values, built from $HEAD_SHA)"
else
  {
    echo "# LLM-IDE $VERSION"
    echo
    echo "Unsigned macOS build. The DMGs were built from GitHub commit \`$HEAD_SHA\` ($GH_REPO) by run $RUN_ID."
    echo "The GitLab tag \`$TAG\` points at GitLab \`main\` at release time, which may not be the same commit."
    echo
    echo "## Which file"
    echo
    echo "| Your Mac | File |"
    echo "|---|---|"
    echo "| Apple silicon (M1 or later; \`uname -m\` prints \`arm64\`) | \`LLM-IDE-$VERSION-arm64.dmg\` |"
    echo "| Intel (\`uname -m\` prints \`x86_64\`) | \`LLM-IDE-$VERSION-x64.dmg\` |"
    echo
    echo "## Install"
    echo
    echo "1. Open the .dmg and drag **LLM-IDE** onto **Applications**."
    echo "2. The app is not signed or notarized, so macOS blocks the first launch. Either:"
    echo "   - run \`xattr -dr com.apple.quarantine /Applications/LLM-IDE.app\` and open it normally (this also clears the bundled Node), or"
    echo "   - open it once, then go to System Settings > Privacy & Security and click **Open Anyway**."
    echo "3. The Claude CLI must be installed and signed in (\`claude login\`)."
    echo
    echo "## SHA-256"
    echo
    printf '%s' "$SUMS"
    if [ -n "$NOTES_FILE" ]; then
      echo
      echo "## Notes"
      echo
      cat "$NOTES_FILE"
    fi
  } > "$NOTES"
fi

echo "== Creating GitLab release $TAG"
run glab release create "$TAG" --ref main -R "$GL_PROJECT" --name "LLM-IDE $VERSION" \
  --notes-file "$NOTES" --assets-links "$LINKS"

echo "Done: https://gitlab.com/$GL_PROJECT/-/releases/$TAG"
