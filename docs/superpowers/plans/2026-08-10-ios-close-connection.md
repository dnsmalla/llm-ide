# iOS Close Connection + Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the iOS app close the mobile-control link to the Mac without forgetting the paired device, and reconnect either via a new in-app button or automatically on next launch.

**Architecture:** Add a `closeConnection()` method to `ConnectionService` that reuses the existing `disconnect(clearDirect:)` teardown path but keeps the saved `directIP`/`directPort`/`directPIN` (and never touches `ConnectionStore`). Wire it into a new non-destructive toolbar item in `MobileHomeView`, rename the existing destructive item to "Forget this Mac" for clarity, and add a "Reconnect" button to the disconnected-state view that calls the same `connectDirect` path `ContentView`'s cold-launch auto-reconnect already uses.

**Tech Stack:** Swift, SwiftUI, no new dependencies. No wire-protocol (`SharedProtocol`) changes — the Mac's `MobileWebSocketServer` already handles a client disconnect via its existing `.failed`/`.cancelled` state handler.

**Design reference:** `docs/superpowers/specs/2026-08-10-ios-close-connection-design.md`

---

## Testing approach for this codebase

This project has no iOS UI test target (XCTest/UI-test harness) — verification for SwiftUI view changes in this repo is manual, via building and running in Xcode/Simulator, per existing project convention (see `mac-build-environment` notes: even the macOS Swift package's `swift test` silently no-ops with no XCTest bundle). `xcodebuild` is also unavailable in this shell (only Command Line Tools installed, not full Xcode), so every task's "verify" step is a manual instruction to run in Xcode — there is no automated command to execute here. Do not skip these manual checks; they are the only verification this plan has.

---

### Task 1: Add `closeConnection()` to `ConnectionService`

**Files:**
- Modify: `ios_app/MyApp/Services/ConnectionService.swift:163`

- [ ] **Step 1: Add the new method right after the existing `disconnect()`**

Find this exact block (line 163):

```swift
    func disconnect() { disconnect(clearDirect: true) }

    private func disconnect(clearDirect: Bool) {
```

Replace it with:

```swift
    func disconnect() { disconnect(clearDirect: true) }

    /// Close the socket but keep the saved pairing (`directIP`/`directPort`/
    /// `directPIN`) so a later `connectDirect` call — from the Reconnect
    /// button or the next cold launch — can re-establish the link without
    /// re-pairing. Unlike `disconnect()`, callers must NOT also clear
    /// `ConnectionStore` — that would defeat the point of this method.
    func closeConnection() { disconnect(clearDirect: false) }

    private func disconnect(clearDirect: Bool) {
```

- [ ] **Step 2: Sanity-check the edit**

Run: `grep -n "func closeConnection\|func disconnect" ios_app/MyApp/Services/ConnectionService.swift`

Expected output includes both:
```
163:    func disconnect() { disconnect(clearDirect: true) }
169:    func closeConnection() { disconnect(clearDirect: false) }
171:    private func disconnect(clearDirect: Bool) {
```
(line numbers may shift slightly — what matters is `closeConnection` sits between `disconnect()` and `private func disconnect(clearDirect:)`)

- [ ] **Step 3: Commit**

```bash
git add ios_app/MyApp/Services/ConnectionService.swift
git commit -m "feat(mobile): add closeConnection() that keeps saved pairing"
```

---

### Task 2: Toolbar menu — add "Close Connection", rename "Disconnect" to "Forget this Mac"

**Files:**
- Modify: `ios_app/MyApp/Views/Control/MobileHomeView.swift:394-407`

- [ ] **Step 1: Replace the toolbar `Menu` block**

Find this exact block:

```swift
                Menu {
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "gear")
                    }
                    Divider()
                    Button("Disconnect", role: .destructive) {
                        connection.disconnect()
                        connectionStore.clear()
                    }
                } label: {
                    Image(systemName: "ellipsis.circle.fill")
                        .font(.system(size: DesignSystem.Typography.headline))
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
```

Replace it with:

```swift
                Menu {
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "gear")
                    }
                    Divider()
                    Button {
                        connection.closeConnection()
                    } label: {
                        Label("Close Connection", systemImage: "network.slash")
                    }
                    Button("Forget this Mac", role: .destructive) {
                        connection.disconnect()
                        connectionStore.clear()
                    }
                } label: {
                    Image(systemName: "ellipsis.circle.fill")
                        .font(.system(size: DesignSystem.Typography.headline))
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
```

- [ ] **Step 2: Sanity-check the edit**

Run: `grep -n "Close Connection\|Forget this Mac" ios_app/MyApp/Views/Control/MobileHomeView.swift`

Expected output:
```
<line>:                        Label("Close Connection", systemImage: "network.slash")
<line>:                    Button("Forget this Mac", role: .destructive) {
```

- [ ] **Step 3: Commit**

```bash
git add ios_app/MyApp/Views/Control/MobileHomeView.swift
git commit -m "feat(mobile): add Close Connection toolbar action, rename Disconnect"
```

---

### Task 3: Add "Reconnect" to the disconnected-state view

**Files:**
- Modify: `ios_app/MyApp/Views/Control/MobileHomeView.swift` (`disconnectedHint`, currently lines 329-347)

- [ ] **Step 1: Replace the `disconnectedHint` computed property**

Find this exact block:

```swift
    private var disconnectedHint: some View {
        VStack(spacing: DesignSystem.Spacing.md) {
            if connection.connectionStatus == .connecting {
                ProgressView()
                    .tint(DesignSystem.Colors.primary)
            } else {
                Image(systemName: "wifi.slash")
                    .font(.system(size: 44))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            Text(connection.connectionStatus == .connecting ? "Connecting…" : "Not connected")
                .font(.system(size: DesignSystem.Typography.title2, weight: .semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text("Pair again from the login screen if this persists.")
                .font(.system(size: DesignSystem.Typography.subheadline))
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
```

Replace it with:

```swift
    private var disconnectedHint: some View {
        VStack(spacing: DesignSystem.Spacing.md) {
            if connection.connectionStatus == .connecting {
                ProgressView()
                    .tint(DesignSystem.Colors.primary)
            } else {
                Image(systemName: "wifi.slash")
                    .font(.system(size: 44))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            Text(connection.connectionStatus == .connecting ? "Connecting…" : "Not connected")
                .font(.system(size: DesignSystem.Typography.title2, weight: .semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            if connection.connectionStatus == .disconnected {
                Text("Your Mac is still saved. Reconnect now, or reopen the app once it's back online.")
                    .font(.system(size: DesignSystem.Typography.subheadline))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, DesignSystem.Spacing.lg)
                Button {
                    connection.connectDirect(
                        ip: connectionStore.deviceIP,
                        port: connectionStore.devicePort,
                        pin: connectionStore.devicePIN
                    )
                } label: {
                    Text("Reconnect")
                        .font(.system(size: DesignSystem.Typography.body, weight: .semibold))
                        .frame(maxWidth: 200)
                }
                .buttonStyle(.borderedProminent)
                .tint(DesignSystem.Colors.primary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
```

Note: `connectionStore` is already an `@EnvironmentObject` on `MobileHomeView` (declared at the top of the struct), so no new property is needed to reference it here.

- [ ] **Step 2: Sanity-check the edit**

Run: `grep -n "Reconnect\|Your Mac is still saved" ios_app/MyApp/Views/Control/MobileHomeView.swift`

Expected output includes both the new `Text` copy and the `Button` label.

- [ ] **Step 3: Commit**

```bash
git add ios_app/MyApp/Views/Control/MobileHomeView.swift
git commit -m "feat(mobile): add Reconnect button to disconnected state"
```

---

### Task 4: Manual verification in Xcode

**Files:** none (verification only)

- [ ] **Step 1: Open the project**

```bash
open ios_app/MyApp.xcodeproj
```

- [ ] **Step 2: Build**

In Xcode: Product → Build (Cmd+B) for the `MyApp` scheme. Confirm it compiles with no errors — this is the only compiler check available, since `xcodebuild` CLI isn't set up with a full Xcode toolchain in this environment (Command Line Tools only).

- [ ] **Step 3: Run against a live Mac and verify Close Connection**

1. Run the Mac app (`Settings → Mobile Control → Start`, per `docs/mobile/quick-start.md`).
2. Run the iOS app on a simulator or device on the same network/Tailscale, pair once via PIN.
3. In the iOS app's toolbar menu (⋯), tap **Close Connection**.
4. Confirm the socket closes (status pill shows "Offline", `disconnectedHint` appears with the new copy and Reconnect button).
5. Open Settings in the iOS app — confirm the Mac's IP/PIN are still shown as saved (not cleared).

- [ ] **Step 4: Verify Reconnect**

1. From the disconnected state, tap **Reconnect**.
2. Confirm the status pill returns to "Live" and the native dashboard reappears, without re-entering the PIN.

- [ ] **Step 5: Verify cold-launch auto-reconnect still works**

1. Force-quit the iOS app.
2. Relaunch it while the Mac app is still running.
3. Confirm it auto-reconnects via `ContentView`'s existing `hasDevice` check — no manual tap needed.

- [ ] **Step 6: Regression-check "Forget this Mac"**

1. In the toolbar menu, tap **Forget this Mac**.
2. Confirm the app routes back to `ConnectView` (fresh pairing screen) and Settings no longer shows a saved Mac — i.e. this still behaves exactly like the old "Disconnect" did.

- [ ] **Step 7: Final commit (docs only, if any notes were added)**

If Task 4 surfaced any copy or behavior tweak, make that specific edit, then:

```bash
git add -A
git commit -m "fix(mobile): address manual verification feedback for close-connection flow"
```

If no changes were needed, skip this step — nothing to commit.
