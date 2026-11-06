# Cut a release

How to ship a new llm-ide version. The extension zip is built and published
automatically by CI on a `v*` tag push. The desktop app has its own release
train (§3). (The Swift Mac app and its `mac-v*` train were removed 2026-11-06.)

## 1. Prepare the version

1. Bump `extension/package.json` `version` (semver — the extension is the
   version of record for the whole repo).
2. Move the `## [Unreleased]` items in `CHANGELOG.md` into a new
   `## [X.Y.Z] — YYYY-MM-DD` section.
3. Commit: `chore(release): vX.Y.Z`.

## 2. Tag and push

```bash
git tag vX.Y.Z
git push --follow-tags
```

The `Release` workflow (`.github/workflows/release.yml`) then:

- verifies `extension/package.json` matches the tag,
- re-runs type-check, lint, and the test suite,
- packages `extension-vX.Y.Z.zip`,
- creates a GitHub Release with the CHANGELOG section as notes and the
  zip attached.

If the version check fails, fix the mismatch and re-tag (delete the bad tag
with `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`).

## 3. Desktop app

The Tauri desktop app has its own `desktop-vX.Y.Z` tag train: a tag builds all four targets, signs and notarizes
macOS, and creates a draft release; you check it, publish it and promote it to the update channel. Full steps,
secrets and the real-run checklist: [desktop-release.md](desktop-release.md).

## Version policy

- **MAJOR** — breaking changes to the extension↔core control plane, the KB
  schema (without migration), or the plugin API.
- **MINOR** — new features, new endpoints, new skills wiring.
- **PATCH** — fixes and docs.
