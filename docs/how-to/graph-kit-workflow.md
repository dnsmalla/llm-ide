# Change graph-kit and ship it to the app

graph-kit is a separate repository, `github.com/dnsmalla/graph-kit`. It is the
graph system (GraphCore, GraphKit, the TypeScript CLI, the Rust OS core and the
System page's web package), and the Mac app is only one consumer. The user
decided on 2026-10-28 that it stays separate, so that other consumers can reuse
it. The cost is that a graph-kit change is two commits, one in each repository.
This page is the procedure. The reasoning behind the pins is in
[`docs/kits/graph-kit.md`](../kits/graph-kit.md) §4.

## The three pins

The app is built from one graph-kit commit, and that commit is named in three
places. They must agree.

| Pin | Where | Who sets it |
| --- | --- | --- |
| Submodule gitlink | `mac/LocalPackages/graph-kit` in the llm-ide index | `git add` after the submodule moves. The graph gates, the System page build and the CI checkouts read it. |
| `revision:` | `mac/Package.swift` (`graphKitDependency`) | `make graphkit-bump`. This is what a normal app build resolves. |
| `graph-kit` entry | `mac/Package.resolved` | SwiftPM, during `swift package resolve graph-kit`. |

`make graphkit-pin-check` verifies that the three agree. It runs offline inside
`make regression`. With `ONLINE=1` it also checks that the pinned commit exists
on the graph-kit remote. It asks the remote, not a possibly stale local copy: it
first runs `git fetch origin` in the submodule, then accepts the pin if it is a
branch or tag tip (`git ls-remote`), or if the remote serves that one object
(`git fetch origin <sha>` in the submodule, then the GitHub API). Only a definite
"not on the remote" fails. An unreachable remote, a failed fetch, or a missing
`gh` only prints a warning. The pre-push hook runs the online form when the
gitlink moves, `mac/Package.resolved` changes, or a pushed line of
`mac/Package.swift` names graph-kit. Other `Package.swift` edits skip it. Without that check, a pin to a commit that was never pushed passes
locally and fails on every other machine and in CI.

## Iterate without pushing

1. Edit `mac/LocalPackages/graph-kit`. Run its own gates there, for example
   `swift run -c release graph-layout-lab` and `node scripts/conformance-memory.mjs`.
2. Build the app against the checkout:

   ```bash
   make build-mac-graphkit-local
   ```

   This sets `GRAPHKIT_LOCAL=1`, which makes `mac/Package.swift` depend on the
   checkout by path. The build uses its own scratch path, `mac/.build-graphkit-local`,
   so the pinned build cache is kept. SwiftPM would drop the graph-kit entry from
   `Package.resolved` in this mode, so automatic resolution is disabled for the
   build, and the target fails if the file changed. If it does, restore it with
   `git checkout -- mac/Package.resolved`.
3. When the System page's web code changed, run `make os-view`. The bundle comes
   from `mac/LocalPackages/graph-kit/web` through a Vite alias, so the checkout is
   what gets bundled.

Pins are not touched by any of this, and nothing is pushed.

## Ship a graph-kit change

1. Commit in graph-kit and add the entry under `## [Unreleased]` in its
   `CHANGELOG.md`.
2. Preview the bump. This reads everything and changes nothing:

   ```bash
   make graphkit-bump DRY_RUN=1
   ```

3. Run the bump:

   ```bash
   make graphkit-bump            # bumps and stages the pins and the bundle
   make graphkit-bump COMMIT=1   # also commits: chore(graph-kit): bump pins to <sha> — <subject>
   ```

   In order, it refuses unless llm-ide has no other tracked changes and graph-kit
   is clean, on `main`, and a fast-forward of `origin/main`. Then it:

   - pushes graph-kit `main`;
   - moves the `revision:` pin with `graphkit-pin-check --set-pin`;
   - runs `swift package resolve graph-kit`;
   - stages the gitlink;
   - rebuilds the System page bundle (`make os-view`) and checks it (`os-view-check`);
   - builds the app (`make build-mac`);
   - runs `make graphkit-pin-check ONLINE=1`.

   Rerunning is the recovery path. If a run fails after graph-kit was pushed
   (for example, the build failed), fix the cause and run `make graphkit-bump`
   again. The message on failure says where it stopped. The rerun sees the pins
   already at graph-kit's HEAD, so it skips the moves, but it still checks the
   staged gitlink and pin files, runs `make os-view-check` (and `make os-view`
   only when the bundle is stale), builds the app, and runs the online pin check.
   Only then does it print "nothing to bump". With `SKIP_BUILD=1` the build step
   is skipped, and that run does not verify the build.

   The commit trailer defaults to `Co-Authored-By: Claude Sonnet 5.5
   <noreply@anthropic.com>`. Set `COAUTHOR="Name <email>"` to change it.
4. Run the gates. `make regression` is the pre-push gate and runs the pin check
   offline. The pre-push hook also runs the online check when the pins change.
   Then push llm-ide.

CI checks the same things on both sides. The mac-ci job "graph-kit pin matches
the submodule" compares the gitlink with the `revision:`. The contract-ci job
runs `os-view-check`. graph-kit's own CI runs its unit tests.

## Release a tag

Tags are for external consumers of graph-kit, such as the TypeScript plugin and
other packages. llm-ide does not depend on them. It pins revisions, so each build
resolves the same commit, and a tag cannot move under it.

To cut a release on the bumped commit:

```bash
make graphkit-bump TAG=1.7.0 YES=1 COMMIT=1
```

The bump refuses unless `1.7.0` is plain `X.Y.Z`, greater than the latest tag
(local and remote), not already a local tag, and graph-kit's `CHANGELOG.md` at
HEAD has a `## [1.7.0]` heading. The canonical tag form is plain `X.Y.Z`
(`1.7.0`). Older tags are mixed: some are plain (`1.5.3`, `1.6.0`) and one is
prefixed (`v1.6.2`). The `v` prefix is ignored when the latest tag is found, and
new tags never use it. The tag is pushed as `refs/tags/X.Y.Z`, so a branch with
the same name cannot be pushed by mistake. It needs `YES=1` because pushing a tag starts graph-kit's release
workflow, which can publish outside this repository. The tag is created and
pushed only after the build and the online pin check pass, so a failed build
leaves no release behind. llm-ide's pin line gets a `// graph-kit 1.7.0` note.
The pin itself stays an exact revision.

Check graph-kit's release workflow before you run it with `YES=1`.

## Failures and what they mean

| Message | Meaning | Fix |
| --- | --- | --- |
| `graph-kit pins disagree` | The gitlink, `Package.swift` and `Package.resolved` name different commits. | `make graphkit-bump`, or set them by hand and run `swift package resolve graph-kit`. |
| `does not exist on …graph-kit.git` | The remote does not have the pinned commit. Both the tip check and the per-object fetch said so. | If the commit is local, push graph-kit: `git -C mac/LocalPackages/graph-kit push origin main`. If it should already be on the remote, fetch or check out the submodule: `git submodule update --init mac/LocalPackages/graph-kit`. |
| `could not confirm pinned … on the remote` (warning) | The remote could not be asked about a non-tip commit (offline, submodule not checked out, GitHub API unavailable). It is not a failure. | Re-run with network access, or check out the submodule and run `make graphkit-pin-check ONLINE=1` again. |
| `unreachable, existence check skipped` (warning) | `git ls-remote` could not reach graph-kit. | Re-run when the network is back. The hook never blocks a push on this. |
| `TAG is set but empty` | `make graphkit-bump TAG=` was given with no value. | Pass `TAG=X.Y.Z`, or leave `TAG` out for a plain bump. |
| `--tag needs a value` | `graphkit-pin-check.mjs --set-pin <sha> --tag` was given without a version. | Pass `--tag X.Y.Z`, or drop `--tag`. |
| `graph-kit was pushed at <sha>; re-run make graphkit-bump` | A step after the push failed. graph-kit is already on the remote. | Fix the cause shown above, then run `make graphkit-bump` again. It finishes the bump. |
| `worktree HEAD … differs from the gitlink` (warning) | The submodule checkout is not at the committed commit. | `git submodule update --init mac/LocalPackages/graph-kit`, or `git add` the gitlink. |
| `graph-kit local main has diverged` | graph-kit's local `main` is behind or has diverged from `origin/main`. | Reconcile graph-kit's `main` first. The bump never force-pushes. |
| `build-mac-graphkit-local: mac/Package.resolved changed` | SwiftPM rewrote the resolved file. | `git checkout -- mac/Package.resolved`. |

## Roll the app back to an older graph-kit

Set the pin to an older commit that is on the remote, then resolve and verify
it. No push is needed:

```bash
node scripts/graphkit-pin-check.mjs --set-pin <older-sha>
swift package --package-path mac resolve graph-kit
git -C mac/LocalPackages/graph-kit checkout <older-sha>
git add mac/LocalPackages/graph-kit mac/Package.swift mac/Package.resolved
make graphkit-pin-check ONLINE=1
```

Rebuild the bundle (`make os-view`) if the older commit's web code differs.
Commit the result with a `revert` subject.

## Checks at a glance

| Check | Command | Where it runs |
| --- | --- | --- |
| Pins agree | `make graphkit-pin-check` | `make regression`, first gate after the submodule check |
| Pin exists on the remote | `make graphkit-pin-check ONLINE=1` | pre-push, when the gitlink, `Package.resolved`, or a graph-kit line in `Package.swift` changes; the bump |
| Pin unit tests | `node --test extension/tests/graphkit-pin-check.test.mjs` | `make test` |
| Local override builds | `make build-mac-graphkit-local` | manual |
| Bump dry run | `make graphkit-bump DRY_RUN=1` | manual |
