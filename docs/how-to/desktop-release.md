# Release the desktop app

How to cut, check, publish and roll back a release of the Tauri desktop app (`desktop/`). It has its own
tag train, `desktop-vX.Y.Z`, separate from the extension (`v*`) and the Mac app (`mac-v*`). The pipeline is
`.github/workflows/desktop-release.yml`; the update channel is moved by `.github/workflows/desktop-promote.yml`.
Decisions behind it: [desktop-signing-decisions.md](desktop-signing-decisions.md).

Nothing here has run against real secrets yet. The first run is your first signed dry run (section 3).

## 1. What ships

| Target | Files | Signed by | Updates through |
|---|---|---|---|
| macOS arm64 | `LLM-IDE_X.Y.Z_aarch64.dmg`, `LLM-IDE_X.Y.Z_aarch64.app.tar.gz` | Developer ID, notarized, stapled | The updater (the `.app.tar.gz`) |
| macOS x64 | `LLM-IDE_X.Y.Z_x64.dmg`, `LLM-IDE_X.Y.Z_x64.app.tar.gz` | Developer ID, notarized, stapled | The updater |
| Windows x64 | `LLM-IDE_X.Y.Z_x64-setup.exe` (NSIS, per user, no admin) | **Not signed** (decision, see below) | The updater (passive installer) |
| Linux x64 | `LLM-IDE_X.Y.Z_amd64.AppImage`, `LLM-IDE_X.Y.Z_amd64.deb` | Not signed | AppImage: the updater. deb: your package manager |

Every release also has `SHA256SUMS`, two CycloneDX SBOMs (`..._core.cdx.json`, `..._frontend.cdx.json`),
`latest.json` and one `.sig` per updater file. Tag releases carry GitHub provenance attestations. Verify a file:

```bash
gh attestation verify LLM-IDE_X.Y.Z_amd64.deb --repo dnsmalla/llm-ide
```

Every updater file is signed with the **updater key** on every OS (free). The app never installs an update
whose signature does not match the public key committed at `desktop/release/updater.pubkey`. That is what keeps
updates safe on Windows and Linux without a paid certificate.

Windows is unsigned by decision (2026-11-05, no paid certificate). Users see a SmartScreen warning; see
"First launch on Windows" below. If you change your mind, use the `windows_signed` input (section 2).

## 2. One-time setup

Add these as repository secrets (GitHub, Settings, Secrets and variables, Actions).

| Secret | What | Needed for |
|---|---|---|
| `MAC_CERT_P12_BASE64` | Developer ID Application certificate, base64 | Every signed run |
| `MAC_CERT_PASSWORD` | Password of that `.p12` | Every signed run |
| `MAC_CI_KEYCHAIN_PASSWORD` | Any random string; protects the CI keychain | Every signed run |
| `MAC_SIGN_IDENTITY` | `Developer ID Application: Name (TEAMID)` | Every signed run |
| `MAC_NOTARY_APPLE_ID` | Apple ID used to notarize | Every signed run |
| `MAC_NOTARY_PASSWORD` | App-specific password for that Apple ID | Every signed run |
| `MAC_NOTARY_TEAM_ID` | Apple team id | Every signed run |
| `DESKTOP_UPDATER_PRIVATE_KEY` | Updater private key (file content) | Every signed run |
| `DESKTOP_UPDATER_KEY_PASSWORD` | Its password | Every signed run |
| `DESKTOP_WIN_AZURE_CLIENT_ID`, `..._CLIENT_SECRET`, `..._TENANT_ID`, `DESKTOP_WIN_SIGN_ENDPOINT`, `..._SIGN_ACCOUNT`, `..._SIGN_PROFILE` | Azure Artifact Signing | Only a dry run with `windows_signed`. Tag releases never need them |

The seven `MAC_*` secrets are the same ones `mac-release.yml` uses. If the Mac release already works, you add nothing.

"Every signed run" means a tag push, or a manual run with `signed=true`. The preflight job fails before any
build if one is missing.

### The updater key (UN-115)

Do this once. Losing the key means installed apps can never update again.

```bash
cd desktop && npx tauri signer generate -w ~/.llmide-desktop-updater.key
```

Choose a password. Then:

1. Copy the content of the printed `.pub` file into `desktop/release/updater.pubkey` and commit it. The preflight
   fails with a message naming this file until it exists.
2. Put the content of `~/.llmide-desktop-updater.key` in the secret `DESKTOP_UPDATER_PRIVATE_KEY`, and the password
   in `DESKTOP_UPDATER_KEY_PASSWORD`.
3. Keep two offline copies of the key file and the password: a password manager and an encrypted USB stick.

## 3. Dry runs

A dry run builds all four targets, smoke-tests each packaged app and keeps the files for 7 days. It never
publishes. Do not give the files to anyone.

```bash
gh workflow run desktop-release.yml                              # unsigned
gh workflow run desktop-release.yml -f signed=true               # signed and notarized, updater files, latest.json
gh workflow run desktop-release.yml -f signed=true -f windows_signed=true   # also sign Windows (optional)
```

An unsigned dry run makes no `latest.json` and no updater signatures. Only signed runs make them.
Watch it with `gh run watch`. Files are in the run's artifacts.

## 4. Cut a release

1. Set the version `X.Y.Z` in both `desktop/src-tauri/tauri.conf.json` (`version`) and
   `desktop/src-tauri/Cargo.toml` (`version`).
2. Refresh the lockfile's root entry:

   ```bash
   cd desktop/src-tauri && cargo update -p llmide-desktop-poc --offline
   ```

3. Add a section to `CHANGELOG.md` with exactly this heading, then the notes. The date part is free text.
   The release notes are the lines under this heading. **If the heading is missing, the notes are empty.**

   ```markdown
   ## [desktop-X.Y.Z] - YYYY-MM-DD

   What changed, in plain sentences.

   ### First launch on Windows

   Windows shows "Windows protected your PC" because the installer is not signed. Click **More info**, then
   **Run anyway**. To check the file first, compare its hash with `SHA256SUMS` from this release:
   `Get-FileHash .\LLM-IDE_X.Y.Z_x64-setup.exe -Algorithm SHA256`.
   ```

4. Commit, tag, push. The tag must be exactly `desktop-vX.Y.Z` and match the version in step 1:

   ```bash
   git commit -am "chore(release): desktop-vX.Y.Z"
   git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z
   ```

CI builds, signs, notarizes, smoke-tests, writes `latest.json` (it verifies every signature against the
committed public key) and `SHA256SUMS`, attests provenance and creates a **draft** release. Nothing reaches
installed apps yet.

## 5. Check, publish, promote

1. Run the real-run checklist (section 7) on the draft's files.
2. Publish the draft in the GitHub UI.
3. Put it on the update channel:

   ```bash
   gh workflow run desktop-promote.yml -f tag=desktop-vX.Y.Z
   ```

   It refuses a draft, a prerelease or a bad tag name. It re-checks `latest.json`, then copies it to the fixed
   release `desktop-stable` (created on first use; do not delete it). Installed apps read only that file.
   Only now do they see the update.

## 6. Stop or roll back

- Re-run promote with the previous good tag. No further app installs the bad version.
- Apps that already updated stay on it. The updater never downgrades. Ship the fix as the next version.
- A single user can turn updates off: Settings, Updates and About, switch off "Check for updates automatically".
  The app checks once a day when on, and always asks before installing.

## 7. Real-run checklist

Do it per machine: macOS arm64, macOS x64 (if you have one), Windows 11 x64, Ubuntu 24.04 x64. About 45 minutes
each (UN-114). Use the files from the draft release.

- [ ] **Checksum.** macOS and Linux: `sha256sum -c SHA256SUMS --ignore-missing` (macOS: `shasum -a 256 -c SHA256SUMS --ignore-missing`).
  Windows: `Get-FileHash <file> -Algorithm SHA256` and compare by eye. Expected: matches.
- [ ] **Install.**
  - macOS: open the dmg, drag to Applications. Expected: no Gatekeeper warning.
  - Windows: run the setup. Expected: "Windows protected your PC" (unsigned), More info, Run anyway, no admin prompt.
  - Linux deb: `sudo apt install ./LLM-IDE_*.deb`. Expected: pulls `libayatana-appindicator3-1`.
  - Linux AppImage: `chmod +x` and run it.
- [ ] **First run.** Welcome screen, sign up on the local core. Expected: status bar shows the core healthy;
  Settings, Server and Backend shows the bundled core (not `:3456`); Settings, Updates and About says
  "Not checked yet" or "Up to date".
- [ ] **Project.** Open a scratch folder. Expected: Explorer lists files; open and save one; Search finds a word.
- [ ] **Chat.** Ask a one-line question. Needs `claude login` done once in a terminal. With no `claude`
  installed the error says to install Claude Code. Bypass mode asks in a native dialog.
- [ ] **Terminal.** Open the dock, run `echo hi`, resize the window, close the tab.
- [ ] **Tray.** Icon present, Show and Quit work. On GNOME without the AppIndicator extension a missing tray is fine.
- [ ] **Quit.** From the tray or the app menu. Expected: no `node` process left (`ps aux | grep core/node`;
  Windows Task Manager).
- [ ] **Update N-1 to N.** Install the previous published version, promote N. Settings, Check Now shows N;
  Install asks; the app restarts on N; chats and projects are still there. Once, switch off "Check for updates
  automatically", relaunch, and confirm no check happens until Check Now.
- [ ] **Uninstall.** macOS: drag to Trash. Windows: Settings, Apps, Uninstall. Linux: `sudo apt remove llm-ide`
  (check the name with `dpkg -l | grep -i llm`). User data stays: macOS `~/Library/Application Support/llm-ide-desktop`,
  Windows `%LOCALAPPDATA%\llm-ide-desktop`, Linux `~/.local/share/llm-ide-desktop`; secrets stay in the OS store
  under `com.llmide.desktop`. Reinstall: the same account and chats are back.

Record each result in USER-NEEDS (UN-114 and UN-070) with the date and version.

## 8. Autobench (UN-009)

Indicative numbers from a runner (it has no GPU, so the graph frame rate is not a real result):

```bash
gh workflow run desktop-autobench.yml -f os=windows-latest
```

It builds a spike binary (never a release), runs `LLMIDE_POC_AUTOBENCH=all` and uploads `bench.txt` and
`autobench.log` for 30 days. For the real numbers (graph at 30 fps or more, sidecar start and quit, installer size),
run the same steps from the workflow on your Windows machine.

## First launch on Windows

Put this in the release notes (the template in section 4 has it). The Windows installer is unsigned, so
SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**. To check the download,
compare `Get-FileHash <file> -Algorithm SHA256` with the line in `SHA256SUMS`.
