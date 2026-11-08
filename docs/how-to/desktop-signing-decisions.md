# Desktop signing and update decisions

The release pipeline (`.github/workflows/desktop-release.yml`) signs and notarizes macOS on a tag release and
writes signed updater files for every OS. Windows is **not signed**, by decision (2026-11-05, no paid certificate);
Windows signing exists only behind an opt-in dispatch input. The runbook is [desktop-release.md](desktop-release.md).
Nothing has run against real certificates or secrets yet (UN-071, UN-115).

## What is unsigned without the pipeline's secrets

| OS | Unsigned result | User impact |
|---|---|---|
| macOS | `.app` and `.dmg`, ad-hoc signed node only | Gatekeeper blocks it; right-click Open needed |
| Windows | NSIS `.exe` | SmartScreen "unknown publisher" warning |
| Linux | `.deb` and `.AppImage` | No OS-level signature check |

## Decisions

### 1. macOS signing and notarisation

- Needs an Apple Developer Program membership and a **Developer ID Application** certificate.
- Notarisation needs an app-specific password or an App Store Connect API key.
- The Mac app (since removed) already had `mac/Scripts/sign.sh` and `notarize.sh`; the Tauri bundle needs the same entitlements
  (hardened runtime, the bundled node binary signed with the same identity).
- **Decided:** the pipeline reuses the Mac app's seven `MAC_*` secrets (Developer ID, Apple ID, app-specific password).
  Moving both trains to an App Store Connect API key is a later option.

### 2. Windows signing

**Decided 2026-11-05: Windows ships unsigned.** Users see a SmartScreen warning and choose More info, then Run
anyway ("First launch on Windows" in [desktop-release.md](desktop-release.md)). Updates are still verified by the
updater key. The signing step is built but off: it runs only for a manual dry run with `windows_signed=true` and
the six `DESKTOP_WIN_*` secrets. Tag releases never need them. Read on only if you reverse the decision.

| Option | Cost shape | Notes |
|---|---|---|
| Azure Artifact Signing (formerly Trusted Signing) | About USD 10 a month (Basic) | No hardware token, works from CI. Eligibility: organisations in the USA, Canada, EU or UK with 3 or more years of verifiable history; individuals only in the USA and Canada |
| OV Authenticode certificate | Yearly | The key must live in a cloud HSM or signing service that offers a signtool KSP. Only the `Prepare Windows signing` step would change |
| EV Authenticode certificate | Highest yearly | No longer buys instant SmartScreen trust; not worth the price now |

Neither Artifact Signing nor OV gives instant SmartScreen trust. Reputation builds over weeks of downloads.
If you are not eligible for Artifact Signing, use the OV option.

### 3. Linux package formats

| Format | For | Notes |
|---|---|---|
| `.deb` | Debian, Ubuntu | Simple; no auto-update without an apt repository |
| `.AppImage` | Any distro | One file, works with the Tauri updater, WebKitGTK must exist on the host |
| `.rpm` | Fedora, RHEL | Add only on demand |
| Flatpak | Any distro | Sandbox conflicts with the PTY and Node sidecar; defer |

- **Decided:** ship `.deb` and `.AppImage`; rpm and Flatpak deferred. The AppImage carries updates through the
  updater; the deb is updated by the package manager.

### 4. Update-signing keys

The Tauri updater verifies every update against a minisign-style public key embedded in the app. This is separate
from OS code signing.

- Generate the key pair once: `cd desktop && npx tauri signer generate -w ~/.llmide-desktop-updater.key`.
- The public key is committed at `desktop/release/updater.pubkey` (a key change is then a reviewed commit). The
  private key and its password are the secrets `DESKTOP_UPDATER_PRIVATE_KEY` and `DESKTOP_UPDATER_KEY_PASSWORD`.
- Losing the private key means existing installs can never update. Keep two offline copies.
- **Decided:** GitHub Releases with a fixed `desktop-stable` release holding `latest.json` (not `/releases/latest`,
  which would pick the newest Mac or extension release in this repo). One key, stable channel only; you move the
  channel by hand with `desktop-promote.yml` after the real-run checklist.

## What you must provide

1. Apple Developer ID Application certificate (`.p12`), its password, the team id, and notarisation credentials.
2. Windows: nothing (unsigned by decision). Only if you reverse it: Azure Artifact Signing details or an OV certificate in a cloud HSM.
3. The Linux format choice above.
4. The updater key pair, plus the hosting choice for update manifests.
5. Done: `com.llmide.desktop` and `LLM-IDE` are the production identifier and name (they keep the app separate
   from the Swift app's `com.llmide.macapp`).

## After you decide

Add the secrets and the committed public key as described in [desktop-release.md](desktop-release.md), run a
signed dry run, then cut a tag.
