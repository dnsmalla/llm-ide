# Desktop signing and update decisions

The Tauri desktop app has no signed build. `.github/workflows/desktop-release.yml` is a manual draft that produces
**unsigned** bundles and references no secrets. Signing, notarisation and the update channel need decisions and
credentials only you can provide. Nothing here has been run against real certificates.

## What is unsigned today

| OS | Unsigned result | User impact |
|---|---|---|
| macOS | `.app` and `.dmg`, ad-hoc signed node only | Gatekeeper blocks it; right-click Open needed |
| Windows | NSIS `.exe` | SmartScreen "unknown publisher" warning |
| Linux | `.deb` and `.AppImage` | No OS-level signature check |

## Decisions

### 1. macOS signing and notarisation

- Needs an Apple Developer Program membership and a **Developer ID Application** certificate.
- Notarisation needs an app-specific password or an App Store Connect API key.
- The Mac app already has `mac/Scripts/sign.sh` and `notarize.sh`; the Tauri bundle needs the same entitlements
  (hardened runtime, the bundled node binary signed with the same identity).
- **Recommendation:** reuse the existing Developer ID and notarisation credentials. Use an API key, not a password.

### 2. Windows signing

| Option | Cost shape | Notes |
|---|---|---|
| Azure Trusted Signing | Low monthly fee | No hardware token, works from CI; needs an eligible identity |
| OV Authenticode certificate | Yearly | SmartScreen reputation builds slowly; key must live in an HSM or cloud service |
| EV Authenticode certificate | Highest yearly | Immediate SmartScreen trust; hardware token or cloud HSM |

- **Recommendation:** Azure Trusted Signing if your organisation qualifies; otherwise an EV certificate held in a
  cloud HSM so CI can sign without a USB token.

### 3. Linux package formats

| Format | For | Notes |
|---|---|---|
| `.deb` | Debian, Ubuntu | Simple; no auto-update without an apt repository |
| `.AppImage` | Any distro | One file, works with the Tauri updater, WebKitGTK must exist on the host |
| `.rpm` | Fedora, RHEL | Add only on demand |
| Flatpak | Any distro | Sandbox conflicts with the PTY and Node sidecar; defer |

- **Recommendation:** ship `.deb` and `.AppImage`; the AppImage carries updates. Skip Flatpak and rpm for now.

### 4. Update-signing keys

The Tauri updater verifies every update against a minisign-style public key embedded in the app. This is separate
from OS code signing.

- Generate the key pair once with `npm run tauri signer generate`.
- The public key goes in `tauri.conf.json`; the private key and its password go in CI secrets.
- Losing the private key means existing installs can never update. Back it up offline.
- You also choose where update manifests are hosted (GitHub Releases is the simplest).
- **Recommendation:** GitHub Releases as the endpoint, one key pair per release channel, private key stored in
  two places.

## What you must provide

1. Apple Developer ID Application certificate (`.p12`), its password, the team id, and notarisation credentials.
2. Windows: Azure Trusted Signing account details, or the EV certificate and its signing service.
3. The Linux format choice above.
4. The updater key pair, plus the hosting choice for update manifests.
5. A production bundle identifier and product name. The current `com.llmide.desktop.poc` and "LLM-IDE Desktop PoC"
   are spike values.

## After you decide

Add the credentials as repository secrets, then extend `desktop-release.yml` with signing steps and a tag trigger.
Keep `workflow_dispatch` for dry runs. Until then the artifacts must not be distributed.
