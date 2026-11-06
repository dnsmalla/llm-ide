# Change graph-kit and ship it to llm-ide

graph-kit is a separate repository, `github.com/dnsmalla/graph-kit`. It is the
graph system (GraphCore, GraphKit, the TypeScript CLI, the Rust OS core and the
System page's web package), and llm-ide is only one consumer. The user
decided on 2026-10-28 that it stays separate, so that other consumers can reuse
it. The cost is that a graph-kit change is two commits, one in each repository.
This page is the procedure. The reasoning behind the pins is in
[`docs/kits/graph-kit.md`](../kits/graph-kit.md) §4.

## The pin

llm-ide uses one graph-kit commit: the submodule gitlink of `graph-kit/` in the
llm-ide index. The desktop build (a Vite alias to `graph-kit/web`), the core
staging (`graph-kit/bin/graph-kit.js`), the vendored layout WASM, the graph gates
and the CI checkouts all read that checkout. (The Swift Mac app's
`Package.swift`/`Package.resolved` pins were removed with the Mac app.)

`make graphkit-pin-check` verifies that the gitlink exists and warns when the
checkout is at another commit. It runs offline inside `make regression`. With
`ONLINE=1` it also checks that the pinned commit exists on the graph-kit remote.
It asks the remote, not a possibly stale local copy: it first runs
`git fetch origin` in the submodule, then accepts the pin if it is a branch or
tag tip (`git ls-remote`), or if the remote serves that one object
(`git fetch origin <sha>` in the submodule, then the GitHub API). Only a definite
"not on the remote" fails. An unreachable remote, a failed fetch, or a missing
`gh` only prints a warning. The pre-push hook runs the online form when the
gitlink moves. Without that check, a pin to a commit that was never pushed
passes locally and fails on every other machine and in CI.

## Iterate without pushing

1. Edit `graph-kit`. Run its own gates there, for example
   `swift run -c release graph-layout-lab` and `node scripts/conformance-memory.mjs`
   (`make graph-gates` runs them).
2. The desktop builds from the checkout directly, so `cd desktop && npm run dev`
   picks up a `graph-kit/web` change. A Rust layout-kernel change needs the WASM
   re-vendored: `node scripts/vendor-graph-layout-wasm.mjs`.

Nothing is pushed by any of this.

## Ship a graph-kit change

1. Commit in graph-kit and add the entry under `## [Unreleased]` in its
   `CHANGELOG.md`.
2. Preview the bump. This reads everything and changes nothing:

   ```bash
   make graphkit-bump DRY_RUN=1
   ```

3. Run the bump:

   ```bash
   make graphkit-bump            # pushes graph-kit and stages the gitlink
   make graphkit-bump COMMIT=1   # also commits: chore(graph-kit): bump pin to <sha> — <subject>
   ```

   It refuses unless llm-ide has no other tracked changes and graph-kit is
   clean, on `main`, and a fast-forward of `origin/main`. Then it pushes
   graph-kit `main`, stages the gitlink and runs
   `make graphkit-pin-check ONLINE=1`. Rerunning is the recovery path: a rerun
   after a failure sees the pin already at graph-kit's HEAD, verifies each step
   and only then prints "nothing to bump".

   The commit trailer defaults to `Co-Authored-By: Claude Sonnet 5.5
   <noreply@anthropic.com>`. Set `COAUTHOR="Name <email>"` to change it.
4. Run the gates (`make regression`), then push llm-ide.

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
pushed only after the online pin check passes, so a failed bump leaves no
release behind. The pin itself stays an exact revision.

Check graph-kit's release workflow before you run it with `YES=1`.

## Failures and what they mean

| Message | Meaning | Fix |
| --- | --- | --- |
| `no submodule gitlink for graph-kit` | The index has no gitlink at `graph-kit`. | `git submodule update --init graph-kit` and `git add graph-kit`. |
| `does not exist on …graph-kit.git` | The remote does not have the pinned commit. Both the tip check and the per-object fetch said so. | If the commit is local, push graph-kit: `git -C graph-kit push origin main`. If it should already be on the remote, fetch or check out the submodule: `git submodule update --init graph-kit`. |
| `could not confirm pinned … on the remote` (warning) | The remote could not be asked about a non-tip commit. It is not a failure. | Re-run with network access, or check out the submodule and run `make graphkit-pin-check ONLINE=1` again. |
| `unreachable, existence check skipped` (warning) | `git ls-remote` could not reach graph-kit. | Re-run when the network is back. The hook never blocks a push on this. |
| `TAG is set but empty` | `make graphkit-bump TAG=` was given with no value. | Pass `TAG=X.Y.Z`, or leave `TAG` out for a plain bump. |
| `graph-kit was pushed at <sha>; re-run make graphkit-bump` | A step after the push failed. graph-kit is already on the remote. | Fix the cause shown above, then run `make graphkit-bump` again. |
| `worktree HEAD … differs from the gitlink` (warning) | The submodule checkout is not at the committed commit. | `git submodule update --init graph-kit`, or `git add` the gitlink. |
| `graph-kit local main has diverged` | graph-kit's local `main` is behind or has diverged from `origin/main`. | Reconcile graph-kit's `main` first. The bump never force-pushes. |

## Roll back to an older graph-kit

```bash
git -C graph-kit checkout <older-sha>
git add graph-kit
make graphkit-pin-check ONLINE=1
```

Commit the result with a `revert` subject.

## Checks at a glance

| Check | Command | Where it runs |
| --- | --- | --- |
| Gitlink present | `make graphkit-pin-check` | `make regression` |
| Pin exists on the remote | `make graphkit-pin-check ONLINE=1` | pre-push, when the gitlink changes; the bump |
| Pin unit tests | `node --test extension/tests/graphkit-pin-check.test.mjs` | `make test` |
| Bump dry run | `make graphkit-bump DRY_RUN=1` | manual |
