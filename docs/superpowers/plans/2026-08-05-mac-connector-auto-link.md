# Mac Source-Connector Auto-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Email/Box/Slack in the Mac app auto-link with zero credential re-entry on re-login/rebuild/reinstall (same Mac) by making the Connections cards + source sheets vault-aware — they query the existing `configuredSecretKeys()` (set keys, no values) and reflect Connected/Credentials-needed/Not-configured status.

**Architecture:** A new `SourceLinkStore` (ObservableObject) holds the set of vault secret keys currently saved, refreshed via the **existing** `LlmIdeAPIClient.configuredSecretKeys()` (`GET /auth/me/secrets` → `Set<String>`). The three Connections cards + their sheets observe it; the badge becomes vault-aware (`linked` = local config + vault secret), and each sheet shows a "✓ Saved in vault" hint and refreshes after any save/disconnect/test. Secrets stay server-side (no keychain change, no new API method).

**Tech Stack:** Swift 6 (v5 mode), SwiftUI (macOS 14), XCTest, no new dependencies.

## Global Constraints

- **Secrets stay in the server vault.** Do NOT add connector credentials to `KeychainStore` or any on-device store. The Mac only ever learns which vault keys are *set* (never values) via the **existing** `LlmIdeAPIClient.configuredSecretKeys()` (`LlmIdeAPIClient+Providers.swift:40`) → `GET /auth/me/secrets`. **Do not add a second endpoint caller** — reuse it.
- **userId/tenant scope is implicit** — the vault is per authenticated user; the call is authenticated.
- **Vault key names are exact:** Email → `email.imapPassword` **or** `google.email.refreshToken`; Box → `box.clientSecret`; Slack → `slack.botToken`.
- **Follow existing patterns:** ObservableObject stores use `@StateObject` in `LlmIdeMacApp` + `.environmentObject(...)` on `ContentView` (mirror `GraphSessionStore`); tests are XCTest with `@testable import LlmIdeMacLib`, run via `swift test --filter LlmIdeMacTests.<Class>` from `mac/`.
- **`AppConfig.emailSource/slackSource/boxSource` are `@Published var … : Saved…Source?`** — `!= nil` means "configured"; `?.enabled == true` means "enabled".
- **Badge type is `SourceBadgeTone`** (`.positive` / `.neutral` / `.accent`) from `Views/Sources/InputSourceCard.swift`.
- **Conventional Commits**, one concern per commit. Do not modify the server or `LlmIdeAPIClient` (reuse `configuredSecretKeys()` as-is).

## File Structure

- **Create** `mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift` — vault-aware link state, reusing `configuredSecretKeys()`.
- **Modify** `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` — `@StateObject` + `.environmentObject` + refresh on login.
- **Modify** `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` — observe store, vault-aware card badges, `.task` refresh, `.environmentObject` on the 3 sheets.
- **Modify** `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift`, `BoxSourceSheet.swift`, `SlackSourceSheet.swift` — observe store, "✓ Saved in vault" hint, refresh after save/disconnect/test.
- **Create** `mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift`.

---

### Task 1: `SourceLinkStore` (vault-aware link state)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift`

**Interfaces:**
- Consumes: `LlmIdeAPIClient.configuredSecretKeys() async throws -> Set<String>` (existing, `LlmIdeAPIClient+Providers.swift:40`).
- Produces: `SourceLinkStore` (ObservableObject, `@MainActor`) with `SourceKind {email,box,slack}`, `LinkState {linked,credentialsNeeded,notConfigured}`, `presentKeys: Set<String>`, `lastRefreshFailed: Bool`, `refresh(api:)`, `hasSecret(_:)`, `linkState(_:configured:)`, plus static pure forms `hasSecret(_:presentKeys:)` / `linkState(_:configured:presentKeys:)` for testing. Consumed by Tasks 2 & 3.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceLinkStoreTests: XCTestCase {
    func testEmailLinkedViaImapPassword() {
        XCTAssertEqual(SourceLinkStore.linkState(.email, configured: true, presentKeys: ["email.imapPassword"]), .linked)
    }
    func testEmailLinkedViaGoogleRefreshToken() {
        XCTAssertEqual(SourceLinkStore.linkState(.email, configured: true, presentKeys: ["google.email.refreshToken"]), .linked)
    }
    func testBoxAndSlackSecretKeys() {
        XCTAssertEqual(SourceLinkStore.linkState(.box, configured: true, presentKeys: ["box.clientSecret"]), .linked)
        XCTAssertEqual(SourceLinkStore.linkState(.slack, configured: true, presentKeys: ["slack.botToken"]), .linked)
    }
    func testCredentialsNeededWhenConfiguredButSecretMissing() {
        XCTAssertEqual(SourceLinkStore.linkState(.slack, configured: true, presentKeys: []), .credentialsNeeded)
        XCTAssertEqual(SourceLinkStore.linkState(.box, configured: true, presentKeys: ["email.imapPassword"]), .credentialsNeeded)
    }
    func testNotConfiguredWhenNoLocalConfig() {
        XCTAssertEqual(SourceLinkStore.linkState(.email, configured: false, presentKeys: ["email.imapPassword"]), .notConfigured)
    }
    func testHasSecretPerKind() {
        XCTAssertTrue(SourceLinkStore.hasSecret(.slack, presentKeys: ["slack.botToken"]))
        XCTAssertFalse(SourceLinkStore.hasSecret(.slack, presentKeys: ["email.imapPassword"]))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter LlmIdeMacTests.SourceLinkStoreTests`
Expected: FAIL — `SourceLinkStore` is not defined.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift`:

```swift
import Foundation

/// Vault-aware connection status for the Mac's source connectors (Email/Box/
/// Slack). Holds the set of vault secret keys currently saved (refreshed from
/// the existing `LlmIdeAPIClient.configuredSecretKeys()` — `GET /auth/me/
/// secrets`, never the values) and derives each source's link state from that
/// + the local `AppConfig` source config. Drives the "Connected ✓" badge on
/// the Connections cards and the "✓ Saved in vault" hint in the source sheets,
/// so re-login / rebuild / reinstall on the same Mac re-links with zero
/// credential re-entry.
@MainActor
final class SourceLinkStore: ObservableObject {

    enum SourceKind { case email, box, slack }

    /// The per-source link state shown on the Connections cards.
    enum LinkState {
        /// Local config exists AND the source's secret is in the vault.
        case linked
        /// Local config exists but the vault secret is missing.
        case credentialsNeeded
        /// No local config for this source.
        case notConfigured
    }

    /// Vault secret keys currently set for this user. Empty until the first
    /// successful `refresh(api:)`.
    @Published private(set) var presentKeys: Set<String> = []

    /// True when the most recent `refresh(api:)` failed (offline / server down
    /// / 401). Cards show an unknown "—" badge; `presentKeys` is left as-is.
    @Published private(set) var lastRefreshFailed = false

    /// The vault key(s) whose presence means this source's secret is saved.
    static func secretKeys(_ kind: SourceKind) -> [String] {
        switch kind {
        case .email: return ["email.imapPassword", "google.email.refreshToken"]
        case .box:   return ["box.clientSecret"]
        case .slack: return ["slack.botToken"]
        }
    }

    /// Pure form for testing: true when any of the kind's vault keys is present.
    static func hasSecret(_ kind: SourceKind, presentKeys: Set<String>) -> Bool {
        secretKeys(kind).contains { presentKeys.contains($0) }
    }

    /// Pure form for testing: the card badge state from config + present keys.
    static func linkState(_ kind: SourceKind, configured: Bool, presentKeys: Set<String>) -> LinkState {
        guard configured else { return .notConfigured }
        return hasSecret(kind, presentKeys: presentKeys) ? .linked : .credentialsNeeded
    }

    /// True when this source's secret is in the vault (sheet hint).
    func hasSecret(_ kind: SourceKind) -> Bool { Self.hasSecret(kind, presentKeys: presentKeys) }

    /// Card badge state. `configured` is whether the local AppConfig source
    /// exists (passed in by the card, which already derives it).
    func linkState(_ kind: SourceKind, configured: Bool) -> LinkState {
        Self.linkState(kind, configured: configured, presentKeys: presentKeys)
    }

    /// Refresh `presentKeys` from the server (reuses the existing
    /// `configuredSecretKeys()` — no new endpoint caller). On failure, keeps
    /// the last-known set and sets `lastRefreshFailed` (never wipes to empty).
    func refresh(api: LlmIdeAPIClient) async {
        do {
            presentKeys = try await api.configuredSecretKeys()
            lastRefreshFailed = false
        } catch {
            lastRefreshFailed = true
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter LlmIdeMacTests.SourceLinkStoreTests`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift
git commit -m "feat(mac): SourceLinkStore vault-aware connection state"
```

---

### Task 2: Wire `SourceLinkStore` into the app + vault-aware card badges

**Files:**
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift`

**Interfaces:**
- Consumes: `SourceLinkStore` (Task 1).
- Produces: a `SourceLinkStore` `@StateObject` injected as an `@EnvironmentObject`; refreshed on login; the three Connections cards show vault-aware badges.

- [ ] **Step 1: Register the store in `LlmIdeMacApp`**

In `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`:

(a) Add the state-object property alongside the other `@StateObject` stores (near `graphSessionStore` ~line 48):

```swift
    @StateObject private var sourceLinkStore = SourceLinkStore()
```

(b) Inject it into the environment on `ContentView`, next to `graphSessionStore` (the `.environmentObject(graphSessionStore)` line, ~line 189). Add immediately after that line:

```swift
                    .environmentObject(sourceLinkStore)
```

(c) Refresh on login. Find the `.onChange(of: session.isAuthenticated)` block (~lines 276-278):

```swift
                .onChange(of: session.isAuthenticated) { _, authed in
                    if authed { liveMirror.start() } else { liveMirror.stop() }
                }
```

Change it to also refresh link state when the user becomes authenticated:

```swift
                .onChange(of: session.isAuthenticated) { _, authed in
                    if authed {
                        liveMirror.start()
                        Task { await sourceLinkStore.refresh(api: api) }
                    } else {
                        liveMirror.stop()
                    }
                }
```

- [ ] **Step 2: Observe the store in `ConnectionsSettingsSection` and refresh on appear**

In `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift`:

(a) Add the environment object to the struct (next to `@EnvironmentObject var config`, ~line 20):

```swift
    @EnvironmentObject var sourceLinks: SourceLinkStore
```

(b) In the `.task` modifier (~lines 95-98), refresh link state before the auto-fetch:

```swift
                .task {
                    await sourceLinks.refresh(api: api)
                    if config.emailSource?.enabled == true { await runImport() }
                    if config.slackSource?.enabled == true { await runSlackImport() }
                }
```

- [ ] **Step 3: Make the three card badges vault-aware**

Add a private badge helper to `ConnectionsSettingsSection` (in the `// MARK: - Helpers` section, near `runImport`):

```swift
    /// Vault-aware card badge: reflects whether the source's secret is in the
    /// vault, not just whether local config exists.
    private func linkBadge(_ kind: SourceLinkStore.SourceKind, configured: Bool, enabled: Bool) -> (text: String, tone: SourceBadgeTone) {
        if sourceLinks.lastRefreshFailed { return ("—", .neutral) }
        switch sourceLinks.linkState(kind, configured: configured) {
        case .notConfigured:     return ("Not set up", .accent)
        case .credentialsNeeded: return ("Credentials needed", .accent)
        case .linked:            return enabled ? ("Connected ✓", .positive) : ("Paused", .neutral)
        }
    }
```

Then in **`emailCard`** (~lines 187-196), replace the `badgeText:` / `badgeTone:` lines:

```swift
        let configured = config.emailSource != nil
        let enabled = config.emailSource?.enabled == true
        let badge = linkBadge(.email, configured: configured, enabled: enabled)
        return InputSourceCard(
            icon: "envelope",
            title: "Email",
            subtitle: "Fetch messages and turn them into notes",
            badgeText: badge.text,
            badgeTone: badge.tone
        ) {
```

Apply the identical change in **`slackCard`** (use `.slack`) and **`boxCard`** (use `.box`): keep each card's existing `let configured`/`let enabled` lines, add `let badge = linkBadge(.slack, configured: configured, enabled: enabled)` (resp. `.box`), and replace that card's `badgeText:` / `badgeTone:` args with `badgeText: badge.text, badgeTone: badge.tone`.

- [ ] **Step 4: Build to verify it compiles**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -5`
Expected: `Build of product 'LlmIdeMac' complete!` with no errors.

- [ ] **Step 5: Run the unit tests (no regression)**

Run: `cd mac && swift test --filter LlmIdeMacTests 2>&1 | tail -8`
Expected: all tests PASS, including `SourceLinkStoreTests`.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/LlmIdeMacApp.swift mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift
git commit -m "feat(mac): vault-aware Connected badges on source cards"
```

---

### Task 3: "✓ Saved in vault" sheet hints + refresh after save/disconnect/test

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` (inject store into the 3 sheets)
- Modify: `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Sources/BoxSourceSheet.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift`

**Interfaces:**
- Consumes: `SourceLinkStore` (Task 1).
- Produces: each sheet shows a "✓ Saved in vault — leave blank to keep" hint when its secret is present, and refreshes the store after any vault mutation.

- [ ] **Step 1: Inject the store into the three sheet presentations**

In `ConnectionsSettingsSection.swift`, the three `.sheet(isPresented:)` blocks (~lines 77-91) each inject `theme` and `config`. Add `.environmentObject(sourceLinks)` to each. For example, the email sheet becomes:

```swift
                .sheet(isPresented: $showingEmailSheet) {
                    EmailSourceSheet(api: api)
                        .environmentObject(theme)
                        .environmentObject(config)
                        .environmentObject(sourceLinks)
                }
```

Apply the same `.environmentObject(sourceLinks)` addition to the `SlackSourceSheet` and `BoxSourceSheet` sheet blocks.

- [ ] **Step 2: Email sheet — hint + refresh**

In `EmailSourceSheet.swift`:

(a) Add the environment object to the struct (next to `@EnvironmentObject var config`):

```swift
    @EnvironmentObject var sourceLinks: SourceLinkStore
```

(b) Make the password-blank hint vault-aware. Find the hint (~lines 124-126):

```swift
                        if isEditing {
                            SettingsHint("Leave the password blank to keep the current one.")
                        }
```

Replace with:

```swift
                        if sourceLinks.hasSecret(.email) {
                            SettingsHint("✓ Saved in vault — leave blank to keep.")
                        } else if isEditing {
                            SettingsHint("Leave the password blank to keep the current one.")
                        }
```

(c) Refresh after each vault mutation. In `save()` (~lines 273-286), add a refresh before `dismiss()`:

```swift
        config.emailSource = draft
        await sourceLinks.refresh(api: api)
        dismiss()
```

In `disconnect()` (~lines 345-355):

```swift
        config.emailSource = nil
        await sourceLinks.refresh(api: api)
        dismiss()
```

In `test()` (~lines 254-269), add a refresh at the end of the function (after its `do { … } catch { … }` block, before the closing brace):

```swift
        await sourceLinks.refresh(api: api)
```

- [ ] **Step 3: Box sheet — hint + refresh**

In `BoxSourceSheet.swift`:

(a) Add the environment object:

```swift
    @EnvironmentObject var sourceLinks: SourceLinkStore
```

(b) Make the client-secret hint vault-aware. Find (~line 76):

```swift
                        SettingsHint("Leave the client secret blank to keep the current one.")
```

Replace with:

```swift
                        if sourceLinks.hasSecret(.box) {
                            SettingsHint("✓ Saved in vault — leave blank to keep.")
                        } else {
                            SettingsHint("Leave the client secret blank to keep the current one.")
                        }
```

(c) In `save()` (~lines 158-181), add a refresh before `dismiss()`:

```swift
        config.boxSource = draft
        await sourceLinks.refresh(api: api)
        dismiss()
```

(d) In `disconnect()` (~lines 186-196):

```swift
        config.boxSource = nil
        await sourceLinks.refresh(api: api)
        dismiss()
```

(Box has no separate `test()`; `save()` already verifies via `testBox`.)

- [ ] **Step 4: Slack sheet — hint + refresh**

In `SlackSourceSheet.swift`:

(a) Add the environment object:

```swift
    @EnvironmentObject var sourceLinks: SourceLinkStore
```

(b) Make the token hint vault-aware. Find (~line 78):

```swift
                        SettingsHint("Leave the token blank to keep the current one.")
```

Replace with:

```swift
                        if sourceLinks.hasSecret(.slack) {
                            SettingsHint("✓ Saved in vault — leave blank to keep.")
                        } else {
                            SettingsHint("Leave the token blank to keep the current one.")
                        }
```

(c) In `test()` (~lines 157-172), add a refresh at the end (after the `do { … } catch { … }` block):

```swift
        await sourceLinks.refresh(api: api)
```

(d) In `save()` (~lines 176-193), add a refresh before `dismiss()`:

```swift
        config.slackSource = draft
        await sourceLinks.refresh(api: api)
        dismiss()
```

(e) In `disconnect()` (~lines 198-208):

```swift
        config.slackSource = nil
        await sourceLinks.refresh(api: api)
        dismiss()
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -5`
Expected: `Build of product 'LlmIdeMac' complete!` with no errors.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift mac/Sources/LlmIdeMac/Views/Sources/BoxSourceSheet.swift mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift
git commit -m "feat(mac): source sheets show saved-in-vault hint + refresh link state"
```

---

### Task 4: Regression — build, test, manual verification

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -5`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 2: Full Mac test suite**

Run: `cd mac && swift test 2>&1 | tail -10`
Expected: all tests PASS (including `SourceLinkStoreTests`). No regressions in the existing `LlmIdeMacTests`.

- [ ] **Step 3: Sanity-run the app**

Assemble the bundle and launch (the canonical build is `./build_app.sh`; for a quick check, copy the built binary into the existing bundle and sign):

```bash
cd mac
BIN="$(swift build --product LlmIdeMac --show-bin-path 2>/dev/null)/LlmIdeMac"
cp "$BIN" LlmIdeMac.app/Contents/MacOS/LlmIdeMac
codesign --force --deep --sign - LlmIdeMac.app
open -n "$(pwd)/LlmIdeMac.app"
```
Expected: the app launches (Settings → Connections shows the cards).

- [ ] **Step 4: Manual success criterion (the feature's proof)**

With the app running and the server up on `:3456`:
1. Open **Settings → Connections → Slack → Configure…**, paste a bot token, **Save**. Card badge → **Connected ✓**; re-open the sheet → token field hint reads **"✓ Saved in vault — leave blank to keep."**
2. **Log out** (Account → Log out), then **log back in** as the same user.
3. Open Settings → Connections again. The Slack card still shows **Connected ✓** with **no re-typing** (the vault persisted the secret; `SourceLinkStore.refresh` re-detected it). A Fetch works.
4. Repeat the disconnect step: **Disconnect** in the Slack sheet → card badge → **Not set up** / **Credentials needed**.

If the badge reads **"—"** at any point, the server was unreachable or the session wasn't authenticated — that's the designed fallback, not a bug.

- [ ] **Step 5: (Optional) commit any plan-driven fixups**

If steps 1–4 surfaced a needed tweak (e.g. copy adjustment), commit it:

```bash
git commit -am "fix(mac): <specific tweak from regression>"
```

---

## Notes / Out of scope

- **No server change** and **no new API client method** — `GET /auth/me/secrets` is already wrapped by `LlmIdeAPIClient.configuredSecretKeys()` (`LlmIdeAPIClient+Providers.swift:40`), which `SourceLinkStore` reuses. (An earlier draft of this plan added a duplicate `fetchSecretKeys()`; it was dropped as redundant.)
- **No keychain change** — connector secrets stay server-side; `KeychainStore` is unaffected.
- **Deferred (per spec):** cross-device auto-link (syncing non-secret config to the server); unifying the three sheets via `SourceConnectorManifest`; resurfacing Connections out of Settings; OAuth for Box/Slack; auto-fetch on launch.
