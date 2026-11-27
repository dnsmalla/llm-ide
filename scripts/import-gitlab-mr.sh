#!/usr/bin/env bash
# Import a GitLab merge request into GitHub as a pull request, re-creating each
# MR commit so the export (scripts/export-gitlab.sh) reproduces the SAME SHAs.
#
# Usage:
#   scripts/import-gitlab-mr.sh <MR-number> [--dry-run] [--force] [--allow-sensitive]
#
#   --dry-run          build the local branch and verify it, but do not push / open a PR
#   --force            overwrite an existing local feature/gitlab-mr-<N> that differs
#   --allow-sensitive  import MRs that touch CI, hooks, build or export machinery
#
# Env:
#   LLMIDE_GITLAB_URL     GitLab remote URL (default: the llm-ide-app project)
#   LLMIDE_GITHUB_REMOTE  name of the GitHub remote (default: origin)
#
# Merge the resulting PR with "Create a merge commit" (never squash or rebase).
# Squash/rebase make GitHub write new commits, so the export would produce
# commits with different SHAs than the MR's. GitLab then never sees the MR head
# become part of main and would leave the MR open.
#
# Why exactness matters: GitLab main is written only by the one-way export.
# GitLab marks an MR merged when its head is reachable from main. That holds
# only if the exported commits are byte-identical (same author, dates, message,
# tree, parents) to the MR commits. Export keeps authorship, dates and message
# bytes and only rewrites parents/trees, so we rebuild each commit on top of the
# GitHub counterpart of the MR base with the same metadata and the same
# (path-mapped) diff, then prove it by running the real export on the result.
# Nothing is checked out; the working tree and index of this checkout are never
# touched, only one branch ref is created.
set -euo pipefail

GITLAB_URL=${LLMIDE_GITLAB_URL:-git@gitlab.com:grid-devs/personal/dinesh/llm-ide-app.git}
REMOTE=${LLMIDE_GITHUB_REMOTE:-origin}
GITLAB_PROJECT=grid-devs/personal/dinesh/llm-ide-app
GITHUB_REPO=dnsmalla/llm-ide
PATHS_FILE=scripts/gitlab-export-paths.txt

# Anything derived from MR data or the remote URL may carry terminal escapes or
# credentials, so every message goes through these two filters.
redact() { sed -E 's#://[^/@ ]*@#://***@#g'; }
clean() { LC_ALL=C tr -d '\000-\037\177'; }
say_clean() { printf '%s' "$*" | clean | redact; }
die() { printf 'error: %s\n' "$(say_clean "$*")" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$(say_clean "$*")" >&2; }
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

N=""
DRY_RUN=0
FORCE=0
ALLOW_SENSITIVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --allow-sensitive) ALLOW_SENSITIVE=1 ;;
    -h|--help) usage ;;
    *[!0-9]*|"") die "unexpected argument: $arg" ;;
    *) [ -z "$N" ] || usage; N=$arg ;;
  esac
done
[ -n "$N" ] || usage

TOP=$(git rev-parse --show-toplevel) || die "not inside a git repository"
cd "$TOP"

MR_REF="refs/gitlab-mr/$N"
GL_MAIN="refs/gitlab/main"
GH_MAIN="refs/remotes/$REMOTE/main"
BRANCH="feature/gitlab-mr-$N"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/import-gitlab-mr.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ---- 1. fetch ---------------------------------------------------------------
# Leading '+' on the MR ref: after the author rebases, the MR head is not a
# descendant of the previous one and a plain fetch would be rejected.
echo "Fetching MR !$N from GitLab and main from $REMOTE ..."
{ git fetch --quiet --no-tags "$GITLAB_URL" \
    "+refs/merge-requests/$N/head:$MR_REF" "+refs/heads/main:$GL_MAIN" 2>&1 | redact >&2; } \
  || die "could not fetch MR !$N from GitLab"
git fetch --quiet --no-tags "$REMOTE" "+refs/heads/main:$GH_MAIN" \
  || die "could not fetch main from $REMOTE"

# ---- 2. commits to import ---------------------------------------------------
E=$(git merge-base "$MR_REF" "$GL_MAIN") || die "MR has no common ancestor with GitLab main"
MR_HEAD=$(git rev-parse "$MR_REF")
COMMITS=$(git rev-list --reverse "$E..$MR_REF")
[ -n "$COMMITS" ] || die "MR !$N has no commits beyond GitLab main"
[ -z "$(git rev-list --merges "$E..$MR_REF")" ] \
  || die "MR !$N contains merge commits; ask the author to rebase onto GitLab main"
FIRST=$(echo "$COMMITS" | head -n 1)
[ "$(git rev-parse "$FIRST^")" = "$E" ] || die "MR history is not a linear chain on its base"

# Reads a raw commit's message (everything after the first blank line) byte-exact.
raw_message() { git cat-file commit "$1" | perl -0777 -pe 's/\A.*?\n\n//s'; }

# commit-tree cannot reproduce encoding/gpgsig/mergetag headers, so only the
# four plain headers are allowed. Dumped to a file first: a pipe into `sed q`
# would SIGPIPE on big messages and silently skip the check under pipefail.
for commit in $COMMITS; do
  git cat-file commit "$commit" > "$WORK/hdr"
  awk '/^$/ { exit } !/^(tree|parent|author|committer) / { bad = 1 } END { exit bad }' "$WORK/hdr" \
    || die "commit $commit has an extra header (gpgsig/encoding/...); it cannot be reproduced"
done

# ---- 3. map the MR base E to its GitHub commit G ----------------------------
# Export rewrites only parents/trees, so author email, both dates and the
# message identify the counterpart; hashes cannot be compared directly.
E_AE=$(git show -s --format=%ae "$E")
E_AD=$(git show -s --date=raw --format=%ad "$E")
E_CD=$(git show -s --date=raw --format=%cd "$E")
raw_message "$E" > "$WORK/e.msg"
MATCHES=()
while read -r sha; do
  [ -n "$sha" ] || continue
  raw_message "$sha" > "$WORK/cand.msg"
  if cmp -s "$WORK/e.msg" "$WORK/cand.msg"; then MATCHES+=("$sha"); fi
done < <(git log --date=raw --format='%H %ae %ad %cd' "$GH_MAIN" \
  | awk -v ae="$E_AE" -v ad="$E_AD" -v cd="$E_CD" \
      '$2 == ae && ($3 " " $4) == ad && ($5 " " $6) == cd { print $1 }')
[ "${#MATCHES[@]}" -eq 1 ] \
  || die "MR base not found on GitHub (${#MATCHES[@]} matches for ${E:0:12}) - ask the author to rebase on GitLab main"
G=${MATCHES[0]}
echo "MR base ${E:0:12} (GitLab) == ${G:0:12} (GitHub)"

# ---- 4. scope check ---------------------------------------------------------
# Read the path list from GitHub main: that is the list the export will use.
PREFIXES=()
EXACTS=()
REN_SRC=""
REN_DST=""
while IFS= read -r line; do
  case "$line" in ''|\#*|[[:space:]]*) continue ;; esac
  case "$line" in
    *'==>'*) REN_SRC=${line%%==>*}; REN_DST=${line##*==>} ;;
    */) PREFIXES+=("$line") ;;
    *) EXACTS+=("$line") ;;
  esac
done < <(git show "$GH_MAIN:$PATHS_FILE")

# GitLab path -> GitHub path (README.md lives under .gitlab/ on GitHub).
to_github_path() {
  if [ -n "$REN_DST" ] && [ "$1" = "$REN_DST" ]; then echo "$REN_SRC"; else echo "$1"; fi
}

is_exported() {
  local gl_path=$1 gh_path prefix exact
  # The rename source never exists on GitLab, so it is out of scope there.
  [ -z "$REN_SRC" ] || [ "$gl_path" != "$REN_SRC" ] || return 1
  gh_path=$(to_github_path "$gl_path")
  for prefix in ${PREFIXES[@]+"${PREFIXES[@]}"}; do
    case "$gh_path" in "$prefix"*) return 0 ;; esac
  done
  for exact in ${EXACTS[@]+"${EXACTS[@]}"}; do
    [ "$gh_path" != "$exact" ] || return 0
  done
  return 1
}

# Machinery that runs with repo privileges (CI, hooks, build, the export and
# this importer itself) needs a human decision, not a silent import.
is_sensitive() {
  case "$1" in
    graph-kit|.github/*|scripts/export-gitlab.sh|scripts/gitlab-export-paths.txt) return 0 ;;
    scripts/import-gitlab-mr.sh|.gitattributes|.gitmodules|Makefile|setup.sh) return 0 ;;
    .githooks/*|*/.githooks/*) return 0 ;;
    # A nested .gitattributes can hide a file's diff in the PR (-diff, linguist-generated);
    # package.json carries npm lifecycle scripts; deploy/hub and nightly-push run as services.
    */.gitattributes|package.json|*/package.json|deploy/hub/*) return 0 ;;
    scripts/nightly-push.sh|scripts/com.llmide.nightly-push.plist) return 0 ;;
  esac
  return 1
}

# Union over EVERY commit, not the net diff: a file added in one commit and
# deleted in the next still lands in GitHub history, invisible in the PR diff.
ALL_PATHS="$WORK/paths"
: > "$ALL_PATHS"
for commit in $COMMITS; do
  git diff-tree -r --no-renames --name-only -z "$commit^" "$commit" >> "$ALL_PATHS"
done
sort -zu "$ALL_PATHS" > "$ALL_PATHS.u"
CHANGED=()
while IFS= read -r -d '' changed; do CHANGED+=("$changed"); done < "$ALL_PATHS.u"
[ "${#CHANGED[@]}" -gt 0 ] || die "MR !$N changes no files"

SENSITIVE=()
for changed in "${CHANGED[@]}"; do
  [ "$changed" != ".gitmodules" ] \
    || die "MR touches .gitmodules; GitLab's copy is trimmed, so it cannot be re-created exactly"
  is_exported "$changed" \
    || die "MR touches '$changed', which is outside the exported path set ($PATHS_FILE)"
  if is_sensitive "$changed"; then SENSITIVE+=("$changed"); fi
done
if [ "${#SENSITIVE[@]}" -gt 0 ]; then
  if [ "$ALLOW_SENSITIVE" = 0 ]; then
    printf 'error: MR touches sensitive paths (CI/hooks/build/export machinery); review them, then pass --allow-sensitive:\n' >&2
    for changed in "${SENSITIVE[@]}"; do printf '  %s\n' "$(say_clean "$changed")" >&2; done
    exit 1
  fi
  warn "!!! --allow-sensitive: this import changes sensitive paths !!!"
  for changed in "${SENSITIVE[@]}"; do warn "  sensitive: $changed"; done
fi

# ---- 5. rebuild commits on top of G -----------------------------------------
# Rewrites only header lines for exactly README.md so hunk content is untouched.
map_patch() {
  if [ -n "$REN_DST" ]; then
    SRC=$REN_SRC DST=$REN_DST perl -pe '
      BEGIN { $s = $ENV{SRC}; $d = $ENV{DST}; }
      if (/^diff --git /) { s{^diff --git a/\Q$d\E b/}{diff --git a/$s b/}; s{ b/\Q$d\E$}{ b/$s}; }
      s{^--- a/\Q$d\E$}{--- a/$s}; s{^\+\+\+ b/\Q$d\E$}{+++ b/$s};
      s{^((?:rename|copy) (?:from|to)) \Q$d\E$}{$1 $s};'
  else
    cat
  fi
}

export GIT_INDEX_FILE="$WORK/index"
PARENT=$G
NEW_COMMITS=()
for commit in $COMMITS; do
  git read-tree "$PARENT"
  # Every knob is explicit so user config (diff.submodule=log, color.ui,
  # textconv/ext-diff via .gitattributes, diff prefixes) cannot alter the patch.
  git -c diff.noprefix=false -c diff.mnemonicPrefix=false -c color.ui=never \
    diff-tree -p --binary --full-index --no-renames --no-color --no-textconv --no-ext-diff \
    --submodule=short --src-prefix=a/ --dst-prefix=b/ "$commit^" "$commit" | map_patch > "$WORK/patch"
  if [ -s "$WORK/patch" ]; then
    git apply --cached --binary --whitespace=nowarn < "$WORK/patch" \
      || die "could not apply ${commit:0:12} on top of ${PARENT:0:12}"
  fi
  tree=$(git write-tree)
  raw_message "$commit" > "$WORK/msg"
  new=$(
    GIT_AUTHOR_NAME=$(git show -s --format=%an "$commit") \
    GIT_AUTHOR_EMAIL=$(git show -s --format=%ae "$commit") \
    GIT_AUTHOR_DATE=$(git show -s --date=raw --format=%ad "$commit") \
    GIT_COMMITTER_NAME=$(git show -s --format=%cn "$commit") \
    GIT_COMMITTER_EMAIL=$(git show -s --format=%ce "$commit") \
    GIT_COMMITTER_DATE=$(git show -s --date=raw --format=%cd "$commit") \
    git commit-tree "$tree" -p "$PARENT" -F "$WORK/msg"
  ) || die "could not re-create commit ${commit:0:12} (unusual author/committer ident?)"
  NEW_COMMITS+=("$new")
  echo "  ${commit:0:12} -> ${new:0:12}  $(say_clean "$(git show -s --format=%s "$commit")")"
  PARENT=$new
done
unset GIT_INDEX_FILE
NEW_HEAD=$PARENT

# ---- 6. verify --------------------------------------------------------------
# Same blob (and mode) at every path any commit touched; ls-tree entries also
# cover gitlinks.
entry() { git ls-tree "$1" -- "$2" | awk -F'\t' '{ print $1 }'; }
for changed in "${CHANGED[@]}"; do
  want=$(entry "$MR_REF" "$changed")
  have=$(entry "$NEW_HEAD" "$(to_github_path "$changed")")
  [ "$want" = "$have" ] \
    || die "verification failed for '$changed': MR has [$want], rebuilt has [$have]"
done
echo "Verified ${#CHANGED[@]} touched path(s) match the MR head."

# ---- 6b. authoritative check: run the real export ---------------------------
# Catches everything the checks above cannot predict (odd author names,
# encodings, filter-repo quirks): the MR head must appear in the exported
# history of the rebuilt branch, or the MR would never be marked merged.
command -v git-filter-repo >/dev/null \
  || die "git-filter-repo not found (needed to prove the export reproduces the MR): pip install git-filter-repo==2.45.0"
SIM="$WORK/export-src.git"
git init -q --bare "$SIM"
git rev-parse --path-format=absolute --git-path objects > "$SIM/objects/info/alternates"
git --git-dir="$SIM" update-ref refs/heads/main "$NEW_HEAD"
# Use the export script and path list from GitHub main, the same ones CI runs, never the
# working tree: an uncommitted local edit would otherwise make a correct MR fail here.
mkdir -p "$WORK/exporter"
git show "$GH_MAIN:scripts/export-gitlab.sh" > "$WORK/exporter/export-gitlab.sh"
git show "$GH_MAIN:$PATHS_FILE" > "$WORK/exporter/gitlab-export-paths.txt"
chmod +x "$WORK/exporter/export-gitlab.sh"
if ! EXPORT_SOURCE=$SIM EXPORT_BRANCH=main "$WORK/exporter/export-gitlab.sh" "$WORK/export" > "$WORK/export.log" 2>&1; then
  die "export simulation failed: $(tail -n 3 "$WORK/export.log")"
fi
git -C "$WORK/export" merge-base --is-ancestor "$MR_HEAD" HEAD 2>/dev/null \
  || die "export of the rebuilt branch does not reproduce MR head ${MR_HEAD:0:12} (odd author/encoding?); not creating a branch"
echo "Export simulation reproduces MR head ${MR_HEAD:0:12}."

# ---- 7. branch --------------------------------------------------------------
current=$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)
if [ -n "$current" ] && [ "$current" != "$NEW_HEAD" ]; then
  [ "$FORCE" = 1 ] || die "local branch $BRANCH exists at ${current:0:12}; use --force to overwrite"
  # Moving a branch under a worktree would desync that worktree's HEAD/index.
  if git worktree list --porcelain | grep -qx "branch refs/heads/$BRANCH"; then
    die "branch $BRANCH is checked out in a worktree; refusing to move it"
  fi
fi
# Compare-and-swap: empty old value means "must not exist".
git update-ref "refs/heads/$BRANCH" "$NEW_HEAD" "$current"

echo
echo "Branch $BRANCH -> ${NEW_HEAD:0:12} (${#NEW_COMMITS[@]} commit(s))"
echo "Authors:"
git log --format='  %an <%ae>' "$G..$NEW_HEAD" | sort -u | LC_ALL=C tr -d '\000-\010\013-\037\177'
echo "Files:"
for changed in "${CHANGED[@]}"; do printf '  %s\n' "$(say_clean "$changed")"; done

[ "$DRY_RUN" = 0 ] || { echo "Dry run: not pushing."; exit 0; }

# ---- 8. push, PR, MR note ---------------------------------------------------
MR_URL="https://gitlab.com/$GITLAB_PROJECT/-/merge_requests/$N"
MERGE_NOTE="Merge with **Create a merge commit** (not squash/rebase) so GitLab marks the MR merged."
# Lease on the value we saw, so a re-import after a rebase updates the branch
# but never clobbers something someone else pushed meanwhile.
old_remote=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk '{ print $1 }')
git push --force-with-lease="refs/heads/$BRANCH:$old_remote" "$REMOTE" "$BRANCH"

COMPARE_URL="https://github.com/$GITHUB_REPO/compare/main...$BRANCH?expand=1"
PR_URL=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  TITLE=""
  if command -v glab >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 \
     && glab auth status --hostname gitlab.com >/dev/null 2>&1; then
    TITLE=$(glab mr view "$N" -R "$GITLAB_PROJECT" -F json 2>/dev/null | jq -r '.title // empty' || true)
  fi
  [ -n "$TITLE" ] || TITLE=$(git show -s --format=%s "$FIRST")
  TITLE=$(printf '%s' "$TITLE" | clean)
  if PR_URL=$(gh pr create --base main --head "$BRANCH" --title "$TITLE" \
        --body "Imported from GitLab MR !$N ($MR_URL). $MERGE_NOTE"); then
    echo "PR: $PR_URL"
  else
    warn "gh pr create failed (a PR may already exist); open it manually: $COMPARE_URL"
  fi
else
  echo "Open the PR: $COMPARE_URL"
fi
echo "$MERGE_NOTE"

if command -v glab >/dev/null 2>&1 && glab auth status --hostname gitlab.com >/dev/null 2>&1; then
  glab mr note "$N" -R "$GITLAB_PROJECT" \
    -m "Imported to GitHub as ${PR_URL:-branch $BRANCH}; it will show as merged here once accepted." \
    >/dev/null 2>&1 || warn "could not post the GitLab MR note"
fi
