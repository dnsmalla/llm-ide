# Cut a release

How to ship a new llm-ide version. The extension zip is built and published
automatically by CI on a `v*` tag push. The mac app has its own release
train: a `mac-v*` tag builds, signs, notarizes and publishes the DMG in CI,
or you run the same pipeline locally (§3).

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

## 3. Mac app

The mac app is versioned separately: `mac/VERSION` is its version of record,
and `Scripts/build.sh` and `Scripts/dmg.sh` both read it.

### From CI (tag-driven)

```bash
# mac/VERSION must already contain X.Y.Z, or the workflow fails.
git tag mac-vX.Y.Z
git push origin mac-vX.Y.Z
```

`.github/workflows/mac-release.yml` runs `mac/Scripts/release.sh` with the
Developer ID and notary credentials from the repo secrets (listed in that
file's header), then creates a GitHub Release `mac-vX.Y.Z` with
`LlmIdeMac_vX.Y.Z.dmg` attached. It also uploads the build's dSYM as a
workflow artifact named
`LlmIdeMac_mac-vX.Y.Z_b<run number>.app.dSYM.zip`. Download it from the
workflow run's summary page. It expires after 90 days, so copy it somewhere
permanent if crashes from that release must stay symbolicatable for longer.

### Locally

```bash
cd mac
LLMIDE_SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" \
LLMIDE_NOTARY_PROFILE=<notarytool keychain profile> \
Scripts/release.sh        # build → sign → notarize → DMG
```

`Scripts/release.sh` refuses to run without both variables. Set
`LLMIDE_ALLOW_DEV_RELEASE=1` only for an unsigned dev build that must never be
distributed. The DMG is written to `mac/LlmIdeMac_vX.Y.Z.dmg`.
`./build_app.sh` (its only flag is `--clean-all`) runs build → sign → DMG
without notarization, so use it for dev builds only.

Distribution-grade signing and notarisation require a Developer ID. See
[ship-production-build](ship-production-build.md) for the one-time setup and
[release-with-auto-update](release-with-auto-update.md) for the Sparkle
appcast. Attach a locally built DMG to the GitHub Release manually:

```bash
gh release upload mac-vX.Y.Z mac/LlmIdeMac_vX.Y.Z.dmg
```

The build strips the app's executable before signing. Its debug symbols are
written beside the bundle as `mac/LlmIdeMac.app.dSYM`, which is not in the DMG.
For a local release, archive that dSYM yourself: without it, the shipped
build's crash reports cannot be symbolicated, and a later rebuild is not
guaranteed to reproduce the same binary UUID. Set `LLMIDE_SKIP_STRIP=1` to
keep the symbols in the executable instead. See
[mac/README.md → Stripped executable and debug symbols](https://github.com/dnsmalla/llm-ide/blob/main/mac/README.md#stripped-executable-and-debug-symbols).

## Version policy

- **MAJOR** — breaking changes to the extension↔mac control plane, the KB
  schema (without migration), or the plugin API.
- **MINOR** — new features, new endpoints, new skills wiring.
- **PATCH** — fixes and docs.
