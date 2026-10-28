#!/usr/bin/env bash
# graph-kit bump: push graph-kit's main, move the three graph-kit pins to its
# HEAD, rebuild the System page bundle and verify. Run through make:
#
#   make graphkit-bump DRY_RUN=1                 print every step, change nothing
#   make graphkit-bump                           bump the pins, stage them, do not commit
#   make graphkit-bump COMMIT=1                  …and commit the bump
#   make graphkit-bump TAG=1.7.0 YES=1 COMMIT=1  also tag graph-kit 1.7.0 and push the tag
#
# Environment:
#   COMMIT=1      commit the staged bump (message: chore(graph-kit): bump pins …)
#   COAUTHOR=…    the Co-Authored-By trailer value, "Name <email>" (default: Claude Sonnet 5.5)
#   SKIP_BUILD=1  do not run `make build-mac` (the build is then not verified by this run)
#
# Preconditions (checked before anything is pushed or written):
#   - llm-ide tree: no changes to tracked files other than the ones this script
#     edits (mac/Package.swift, mac/Package.resolved, the gitlink, the os-view bundle)
#   - graph-kit worktree clean, on main, and its HEAD is origin/main or ahead of it
#     (the push is a fast-forward)
#   - with TAG: X.Y.Z plain semver above every existing tag, no local tag of that
#     name, a `## [X.Y.Z]` heading in graph-kit's CHANGELOG.md at HEAD, and YES=1
#     (pushing a tag runs graph-kit's release workflow, which can publish outside
#     this repo)
#
# Rerunning is the recovery path. If a run fails after graph-kit was pushed, rerun
# `make graphkit-bump`: the pins are already at graph-kit's HEAD, so the run skips
# the moves but still verifies the pins, the staging, the bundle and the build
# before it says "nothing to bump".
#
# The tag is created only after the bump has verified (build + pin check), so a
# failed build never leaves a published release behind. DRY_RUN never fetches or
# pushes; it only reads, so its output is what a real run would do.
# Bash 3.2 compatible (the macOS default): no arrays, no mapfile.
set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel)"
GK="$ROOT/mac/LocalPackages/graph-kit"
SUB_REL="mac/LocalPackages/graph-kit"
BUNDLE_REL="mac/Sources/LlmIdeMac/Resources/os-view"
DRY_RUN="${DRY_RUN:-}"
COMMIT="${COMMIT:-}"
TAG="${TAG:-}"
YES="${YES:-}"
SKIP_BUILD="${SKIP_BUILD:-}"
COAUTHOR="${COAUTHOR:-Claude Sonnet 5.5 <noreply@anthropic.com>}"
TRAILER="Co-Authored-By: $COAUTHOR"
GK_ON_REMOTE=""   # set to the graph-kit sha once origin/main is known to hold it

say() { printf 'graphkit-bump: %s\n' "$*"; }
die() { printf 'graphkit-bump: FAIL: %s\n' "$*" >&2; exit 1; }

# Any unexpected failure lands here, so the operator knows where things stand.
on_err() {
  local status=$?
  printf 'graphkit-bump: FAILED (exit %s) — see the last step above.\n' "$status" >&2
  if [ -n "$GK_ON_REMOTE" ]; then
    printf 'graphkit-bump: graph-kit was pushed at %s; re-run `make graphkit-bump` to finish.\n' "$GK_ON_REMOTE" >&2
    printf '              The rerun skips the pin moves and verifies the rest before it stops.\n' >&2
  else
    printf 'graphkit-bump: nothing was pushed; fix the cause above and re-run `make graphkit-bump`.\n' >&2
  fi
  exit "$status"
}
trap on_err ERR

# run CMD… — executes, or only prints in dry-run.
run() {
  if [ -n "$DRY_RUN" ]; then
    printf 'graphkit-bump: [dry-run] %s\n' "$*"
  else
    printf 'graphkit-bump: + %s\n' "$*"
    "$@"
  fi
}

if [ -n "$DRY_RUN" ]; then say "DRY RUN — nothing will be pushed, written or committed"; fi

# ---- preconditions ----------------------------------------------------------
[ -f "$GK/Package.swift" ] || die "$SUB_REL is not checked out (git submodule update --init $SUB_REL)"

if [ -n "$TAG" ]; then
  printf '%s' "$TAG" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "TAG must be plain X.Y.Z, got '$TAG'"
  git -C "$GK" rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
    && die "graph-kit already has a local tag $TAG; pick the next version"
fi

# llm-ide: tracked changes only; untracked files (.build*/) are ignored.
allowed_re='^(mac/Package\.swift|mac/Package\.resolved|mac/LocalPackages/graph-kit|mac/Sources/LlmIdeMac/Resources/os-view/)'
dirty="$(git -C "$ROOT" diff --name-only HEAD | grep -Ev "$allowed_re" || true)"
[ -z "$dirty" ] || die "llm-ide has uncommitted changes outside the files this script edits:
$dirty
  commit or stash them first"

# graph-kit: clean, on main.
gk_branch="$(git -C "$GK" rev-parse --abbrev-ref HEAD)"
[ "$gk_branch" = "main" ] || die "graph-kit is on '$gk_branch', not main"
gk_dirty="$(git -C "$GK" status --porcelain --untracked-files=no)"
[ -z "$gk_dirty" ] || die "graph-kit worktree has uncommitted changes; commit or stash them in $SUB_REL first"

NEW="$(git -C "$GK" rev-parse HEAD)"
SUBJECT="$(git -C "$GK" log -1 --format=%s "$NEW")"
SHORT="$(git -C "$GK" rev-parse --short=7 "$NEW")"

# Remote main (read-only query; no fetch). The push is a fast-forward iff the
# remote tip is an ancestor of HEAD.
REMOTE_MAIN="$(git -C "$GK" ls-remote origin refs/heads/main | cut -f1)"
[ -n "$REMOTE_MAIN" ] || die "could not read origin/main of graph-kit (network?)"
if [ "$REMOTE_MAIN" != "$NEW" ]; then
  git -C "$GK" cat-file -e "$REMOTE_MAIN^{commit}" 2>/dev/null \
    || die "origin/main ($REMOTE_MAIN) is not in the local graph-kit checkout; run: git -C $SUB_REL fetch origin"
  git -C "$GK" merge-base --is-ancestor "$REMOTE_MAIN" "$NEW" \
    || die "graph-kit local main has diverged from origin/main (or is behind it); reconcile it before bumping"
fi

OLD="$(grep -Eo 'graph-kit\.git", *revision: *"[0-9a-f]{40}"' "$ROOT/mac/Package.swift" | grep -Eo '[0-9a-f]{40}' || true)"
[ -n "$OLD" ] || die "no graph-kit revision pin found in mac/Package.swift"

if [ -n "$TAG" ]; then
  latest="$( { git -C "$GK" tag -l; git -C "$GK" ls-remote --tags origin | cut -f2 | sed 's#refs/tags/##; s/\^{}$//'; } \
    | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | uniq | tail -1)"
  [ -n "$latest" ] || latest="0.0.0"
  top="$(printf '%s\n%s\n' "$latest" "$TAG" | sort -V | tail -1)"
  if [ "$top" != "$TAG" ] || [ "$TAG" = "$latest" ]; then
    die "TAG $TAG must be greater than the latest graph-kit tag $latest"
  fi
  git -C "$GK" show "$NEW:CHANGELOG.md" | grep -Eq "^## \[${TAG//./\\.}\]" \
    || die "graph-kit CHANGELOG.md at $SHORT has no '## [$TAG]' heading; add the release notes first"
  if [ -z "$YES" ] && [ -z "$DRY_RUN" ]; then
    die "TAG=$TAG pushes a tag that triggers graph-kit's release workflow; rerun with YES=1 to confirm"
  fi
fi

say "llm-ide pins: $OLD -> $NEW ($SHORT: $SUBJECT)"
[ -n "$TAG" ] && say "release tag: $TAG (graph-kit $NEW)"

# A rerun after a failed bump finds the pins already moved. It still verifies
# every step below; it never says "nothing to bump" on faith.
RESUME=""
if [ "$OLD" = "$NEW" ] && [ -z "$TAG" ]; then
  RESUME=1
  say "llm-ide already pins $SHORT: resuming the bump to verify each step (a rerun after a failure lands here)"
fi

# ---- (a) push graph-kit --------------------------------------------------------
if [ "$REMOTE_MAIN" = "$NEW" ]; then
  say "(a) origin/main already at $SHORT; no push needed"
  GK_ON_REMOTE="$NEW"
else
  say "(a) push graph-kit main"
  run git -C "$GK" push origin main
  GK_ON_REMOTE="$NEW"
fi

# ---- (c) move the pins ---------------------------------------------------------
if [ -n "$RESUME" ]; then
  say "(c) pins already at $SHORT; checking they agree (re-resolve only when they do not)"
  if [ -n "$DRY_RUN" ]; then
    printf 'graphkit-bump: [dry-run] node scripts/graphkit-pin-check.mjs (swift package resolve graph-kit only if it fails)\n'
  elif ! node "$ROOT/scripts/graphkit-pin-check.mjs" >/dev/null 2>&1; then
    say "pins disagree; re-resolving graph-kit"
    run swift package --package-path "$ROOT/mac" resolve graph-kit
  fi
else
  say "(c) move the pins to $SHORT"
  if [ -n "$TAG" ]; then
    run node "$ROOT/scripts/graphkit-pin-check.mjs" --set-pin "$NEW" --tag "$TAG"
  else
    run node "$ROOT/scripts/graphkit-pin-check.mjs" --set-pin "$NEW"
  fi
  run swift package --package-path "$ROOT/mac" resolve graph-kit
fi

# ---- staging: the gitlink and the pin files must be staged to match the worktree
if [ -n "$RESUME" ] && [ -z "$DRY_RUN" ]; then
  idx_gitlink="$(git -C "$ROOT" ls-files -s -- "$SUB_REL" | awk '{print $2}')"
  if [ "$idx_gitlink" != "$NEW" ]; then
    say "gitlink in the index is ${idx_gitlink:-missing}, not $SHORT; staging it"
    run git -C "$ROOT" add "$SUB_REL"
  fi
  if ! git -C "$ROOT" diff --quiet -- mac/Package.swift mac/Package.resolved; then
    say "pin files differ from the index; staging them"
    run git -C "$ROOT" add mac/Package.swift mac/Package.resolved
  fi
else
  run git -C "$ROOT" add "$SUB_REL"
  run git -C "$ROOT" add mac/Package.swift mac/Package.resolved
fi

# ---- (d) rebuild and check the System page bundle --------------------------------
if [ -n "$RESUME" ]; then
  say "(d) check the System page bundle (rebuild with make os-view only when stale)"
  if [ -n "$DRY_RUN" ]; then
    printf 'graphkit-bump: [dry-run] make os-view-check (make os-view first if it reports stale)\n'
  elif make -C "$ROOT" os-view-check; then
    say "bundle is current"
  else
    say "bundle is stale; rebuilding"
    run make -C "$ROOT" os-view
    run make -C "$ROOT" os-view-check
  fi
else
  say "(d) rebuild the System page bundle (make os-view) and check it"
  run make -C "$ROOT" os-view
  run make -C "$ROOT" os-view-check
fi
run git -C "$ROOT" add "$BUNDLE_REL"

# ---- (e) build and verify -----------------------------------------------------
if [ -n "$SKIP_BUILD" ]; then
  say "(e) SKIP_BUILD=1: not building the app; this run does not verify the build"
else
  say "(e) build the app and verify the pins"
  run make -C "$ROOT" build-mac
fi
if [ -n "$DRY_RUN" ]; then
  printf 'graphkit-bump: [dry-run] make -C %s graphkit-pin-check ONLINE=1\n' "$ROOT"
else
  make -C "$ROOT" graphkit-pin-check ONLINE=1
fi
if [ -n "$RESUME" ]; then
  say "nothing to bump: llm-ide already pins $SHORT, and the pins, staging, bundle and build were verified above"
fi

# ---- (e2) release tag, after verification ---------------------------------------
if [ -n "$TAG" ]; then
  say "(e2) tag graph-kit $TAG and push the tag"
  run git -C "$GK" tag -a "$TAG" -m "graph-kit $TAG" "$NEW"
  run git -C "$GK" push origin "refs/tags/$TAG"
fi

# ---- (f) summary and commit ---------------------------------------------------
MSG="chore(graph-kit): bump pins to $SHORT — $SUBJECT"
say "(f) suggested commit message:"
printf '    %s\n\n    %s\n' "$MSG" "$TRAILER"
if [ -n "$COMMIT" ]; then
  if [ -n "$DRY_RUN" ]; then
    printf 'graphkit-bump: [dry-run] git commit -m <message above> (only if something is staged)\n'
  elif git -C "$ROOT" diff --cached --quiet; then
    say "nothing staged, so nothing to commit"
  else
    git -C "$ROOT" commit -q -m "$MSG" -m "$TRAILER"
    say "committed: $(git -C "$ROOT" log -1 --format='%h %s')"
  fi
else
  if [ -n "$DRY_RUN" ]; then
    say "would stage the bump, not commit it (COMMIT=1 commits)"
  else
    say "staged, not committed. Review with: git -C $ROOT diff --cached --stat"
  fi
fi
say "done${DRY_RUN:+ (dry run)}"
