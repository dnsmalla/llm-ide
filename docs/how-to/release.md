# Cut a release

How to ship a new llm-ide version. The extension zip is built and published
automatically by CI on a tag push; the mac app DMG is built locally because
signing needs a local Developer ID.

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

## 3. Mac app (local, optional per release)

```bash
cd mac
./build_app.sh            # build + ad-hoc sign
./build_app.sh --dmg      # also produce the DMG
```

Distribution-grade signing and notarisation require a Developer ID — see
[ship-production-build](ship-production-build.md). Attach the DMG to the
GitHub Release manually:

```bash
gh release upload vX.Y.Z mac/dist/LlmIde-X.Y.Z.dmg
```

## Version policy

- **MAJOR** — breaking changes to the extension↔mac control plane, the KB
  schema (without migration), or the plugin API.
- **MINOR** — new features, new endpoints, new skills wiring.
- **PATCH** — fixes and docs.
