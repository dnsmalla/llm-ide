# iOS App ↔ Mac App Native Link — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the foundation — a shared Mac↔iOS protocol package, and the iOS app moved into the repo under `ios_app/`, rebranded to llm-ide and consuming that package — with no runtime behavior change yet.

**Architecture:** Create a new SwiftPM package `ios_app/SharedProtocol` (pure `Codable` message types + constants) consumed by both the Mac app (SwiftPM path dependency) and the iOS app (local SPM package in Xcode). Copy the existing iOS app from `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/` into `ios_app/`, rebrand its identity to llm-ide, and switch its Bonjour service type to the shared constant. Later phases (2–6) build the native Mac server, screen capture, and input on top of this.

**Tech Stack:** Swift 5.9 (SharedProtocol package), SwiftPM, XCTest, Xcode (`xcodebuild`), SwiftUI (iOS 16), rsync.

**Scope note (deliberate):** This phase does the **identity** rebrand (bundle id, display name, usage strings, Bonjour type). The full **color-palette** swap is deferred to Phase 6 (polish) so Phase 1 stays focused on structure + wiring. The `aicontrol://` QR pairing scheme is also deferred to Phase 2 (the Mac app generates the QR there).

## Global Constraints

(Verbatim values every task implicitly inherits.)

- SharedProtocol package platforms: `.macOS(.v14)`, `.iOS(.v16)`.
- SharedProtocol `swift-tools-version`: `5.9`.
- iOS deployment target: `16.0` (keep). `TARGETED_DEVICE_FAMILY = "1,2"` (keep — iPad stays).
- iOS bundle id: `com.llmide.mobile`. Display name: `LLM IDE`.
- Bonjour service type: `_llmide._tcp` (Info.plist `NSBonjourServices`) and `_llmide._tcp.` (NetServiceBrowser — trailing dot).
- Default port: `3006`. Heartbeat interval: `10`s. Heartbeat timeout: `25`s.
- `DEVELOPMENT_TEAM = 9A3YFRQ7SM`, `CODE_SIGN_IDENTITY = "iPhone Developer"` (keep).
- Mac `Package.swift` keeps `swift-tools-version: 6.0` and `swiftLanguageModes: [.v5]`. Only add the SharedProtocol dependency — do not otherwise touch it.
- Conventional Commits; one concern per commit; do not push.

---

## File Structure

**Created**
- `ios_app/SharedProtocol/Package.swift` — SwiftPM manifest for the shared package (library + test target).
- `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift` — protocol constants + connection-lifecycle `Codable` message types.
- `ios_app/SharedProtocol/Tests/SharedProtocolTests/MobileProtocolTests.swift` — constants tests.
- `ios_app/SharedProtocol/Tests/SharedProtocolTests/ConnectionMessagesTests.swift` — message round-trip tests.
- `ios_app/MyApp.xcodeproj/` — copied from the external repo.
- `ios_app/MyApp/` — copied iOS sources.

**Modified**
- `mac/Package.swift` — add SharedProtocol as a path dependency + target product.
- `ios_app/MyApp/Supporting/Info.plist` — display name, usage strings, `NSBonjourServices`.
- `ios_app/MyApp.xcodeproj/project.pbxproj` — `PRODUCT_BUNDLE_IDENTIFIER` → `com.llmide.mobile`; add local SharedProtocol package reference (Task 6).
- `ios_app/MyApp/Services/DeviceDiscovery.swift` — use `MobileProtocol.serviceType`.
- `.githooks/pre-push` — gate SharedProtocol tests when `ios_app/` changes.

---

## Task 1: SharedProtocol package skeleton + constants (TDD)

**Files:**
- Create: `ios_app/SharedProtocol/Package.swift`
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/MobileProtocolTests.swift`

**Interfaces:**
- Produces: `SharedProtocol.MobileProtocol` with `static let serviceType: String` (`"_llmide._tcp"`), `static let defaultPort: Int` (`3006`), `static let heartbeatInterval: TimeInterval` (`10`), `static let heartbeatTimeout: TimeInterval` (`25`).

- [ ] **Step 1: Create the package manifest**

Create `ios_app/SharedProtocol/Package.swift`:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SharedProtocol",
    platforms: [
        .macOS(.v14),
        .iOS(.v16)
    ],
    products: [
        .library(name: "SharedProtocol", targets: ["SharedProtocol"]),
    ],
    targets: [
        .target(
            name: "SharedProtocol",
            path: "Sources/SharedProtocol"
        ),
        .testTarget(
            name: "SharedProtocolTests",
            dependencies: ["SharedProtocol"],
            path: "Tests/SharedProtocolTests"
        ),
    ]
)
```

- [ ] **Step 2: Write the failing test**

Create `ios_app/SharedProtocol/Tests/SharedProtocolTests/MobileProtocolTests.swift`:

```swift
import XCTest
@testable import SharedProtocol

final class MobileProtocolTests: XCTestCase {
    func testServiceTypeMatchesLlmIde() {
        XCTAssertEqual(MobileProtocol.serviceType, "_llmide._tcp")
    }

    func testDefaultPort() {
        XCTAssertEqual(MobileProtocol.defaultPort, 3006)
    }

    func testHeartbeatIntervals() {
        XCTAssertEqual(MobileProtocol.heartbeatInterval, 10)
        XCTAssertEqual(MobileProtocol.heartbeatTimeout, 25)
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ios_app/SharedProtocol && swift test`
Expected: FAIL — compile error `cannot find 'MobileProtocol' in scope` (the type does not exist yet).

- [ ] **Step 4: Write minimal implementation**

Create `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift`:

```swift
import Foundation

/// Wire-protocol constants shared by the macOS server and the iOS client.
public enum MobileProtocol {
    /// Bonjour service type advertised by the Mac app (no trailing dot).
    /// `NSBonjourServices` uses this form; `NetServiceBrowser` appends a dot.
    public static let serviceType = "_llmide._tcp"

    /// Default TCP port the Mac app listens on.
    public static let defaultPort = 3006

    /// Heartbeat cadence (seconds).
    public static let heartbeatInterval: TimeInterval = 10

    /// Drop the connection if no heartbeat is received within this window.
    public static let heartbeatTimeout: TimeInterval = 25
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ios_app/SharedProtocol && swift test`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add ios_app/SharedProtocol
git commit -m "feat(shared-protocol): add package skeleton + wire constants"
```

---

## Task 2: Connection-lifecycle message types (TDD)

**Files:**
- Modify: `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift` (append message structs)
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/ConnectionMessagesTests.swift`

**Interfaces:**
- Consumes: `MobileProtocol` (Task 1).
- Produces: `Codable` structs `Heartbeat`, `HeartbeatAck(ts:)`, `Connected(deviceName:)`, `AuthFailed(message:)`. Each encodes to the flat wire shape `{"type":"<tag>", …}` so it matches the existing protocol; later phases add the remaining message types.

- [ ] **Step 1: Write the failing tests**

Create `ios_app/SharedProtocol/Tests/SharedProtocolTests/ConnectionMessagesTests.swift`:

```swift
import XCTest
@testable import SharedProtocol

final class ConnectionMessagesTests: XCTestCase {
    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func testHeartbeatHasTypeTag() throws {
        let data = try JSONEncoder().encode(Heartbeat())
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertEqual(json, #"{"type":"heartbeat"}"#)
    }

    func testHeartbeatAckRoundTrips() throws {
        let original = HeartbeatAck(ts: 1_700_000_000)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "heartbeat_ack")
    }

    func testConnectedRoundTrips() throws {
        let original = Connected(deviceName: "Dinesh's Mac")
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "connected")
    }

    func testAuthFailedRoundTrips() throws {
        let original = AuthFailed(message: "Wrong PIN")
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "auth_failed")
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ios_app/SharedProtocol && swift test`
Expected: FAIL — `cannot find 'Heartbeat' in scope` (types not defined yet).

- [ ] **Step 3: Write minimal implementation**

Append to `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift`:

```swift
// MARK: - Connection lifecycle messages

/// Client → server keepalive.
public struct Heartbeat: Codable, Equatable {
    public let type = "heartbeat"
    public init() {}
}

/// Server → client heartbeat acknowledgement.
public struct HeartbeatAck: Codable, Equatable {
    public let type = "heartbeat_ack"
    public let ts: Double
    public init(ts: Double) { self.ts = ts }
}

/// Server → client: pairing succeeded; carry the Mac's device name.
public struct Connected: Codable, Equatable {
    public let type = "connected"
    public let deviceName: String
    public init(deviceName: String) { self.deviceName = deviceName }
}

/// Server → client: PIN rejected; sent before closing the socket.
public struct AuthFailed: Codable, Equatable {
    public let type = "auth_failed"
    public let message: String
    public init(message: String) { self.message = message }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ios_app/SharedProtocol && swift test`
Expected: PASS — all Task 1 + Task 2 tests (7 total).

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol
git commit -m "feat(shared-protocol): add connection-lifecycle message types"
```

---

## Task 3: Wire SharedProtocol into the Mac package

**Files:**
- Modify: `mac/Package.swift` (lines 12–17 dependencies block, lines 21–26 target dependencies block)

**Interfaces:**
- Consumes: `ios_app/SharedProtocol` (Tasks 1–2).
- Produces: the Mac target `LlmIdeMac` now imports `SharedProtocol` (used in Phase 2).

- [ ] **Step 1: Add the package dependency**

In `mac/Package.swift`, add the path dependency to the `dependencies:` array. Replace:

```swift
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
        .package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.6.0"),
    ],
```

with:

```swift
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
        .package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.6.0"),
        .package(path: "../ios_app/SharedProtocol"),
    ],
```

- [ ] **Step 2: Add the product to the executable target**

In the same file, add the product to the `LlmIdeMac` target's `dependencies:`. Replace:

```swift
            dependencies: [
                "Yams",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "GraphKit", package: "graph-kit"),
            ],
```

with:

```swift
            dependencies: [
                "Yams",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "GraphKit", package: "graph-kit"),
                .product(name: "SharedProtocol", package: "SharedProtocol"),
            ],
```

- [ ] **Step 3: Verify the Mac package builds with the new dependency**

Run: `cd mac && swift build`
Expected: BUILD SUCCEEDS. (SharedProtocol resolves from `../ios_app/SharedProtocol` and compiles as a dependency. No Mac source references `SharedProtocol` yet — that is Phase 2.)

- [ ] **Step 4: Commit**

```bash
git add mac/Package.swift
git commit -m "build(mac): add SharedProtocol as a path dependency"
```

---

## Task 4: Copy the iOS app into `ios_app/`

**Files:**
- Create: `ios_app/MyApp.xcodeproj/` (from external repo)
- Create: `ios_app/MyApp/` (from external repo)

**Interfaces:** none (file copy). Produces an in-repo iOS project identical to the source minus machine-local artifacts.

- [ ] **Step 1: Create the folder and copy the project + sources**

Run:

```bash
mkdir -p ios_app
rsync -a --exclude='.DS_Store' --exclude='xcuserdata' \
  ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp.xcodeproj ios_app/
rsync -a --exclude='.DS_Store' --exclude='build' \
  ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp ios_app/
```

- [ ] **Step 2: Verify the copied tree**

Run: `find ios_app -maxdepth 2 -type d | sort`
Expected output includes:
```
ios_app
ios_app/MyApp
ios_app/MyApp.xcodeproj
ios_app/MyApp/Services
ios_app/MyApp/Views
ios_app/MyApp/Supporting
ios_app/MyApp/Theme
```
And `ls ios_app/MyApp.xcodeproj` shows `project.pbxproj` (no `xcuserdata`).

- [ ] **Step 3: Commit**

```bash
git add ios_app/MyApp.xcodeproj ios_app/MyApp
git commit -m "feat(ios): bring the iOS control app into the repo under ios_app/"
```

---

## Task 5: Rebrand iOS app identity to llm-ide

**Files:**
- Modify: `ios_app/MyApp/Supporting/Info.plist`
- Modify: `ios_app/MyApp.xcodeproj/project.pbxproj`

**Interfaces:** none (config). Produces bundle id `com.llmide.mobile`, display name `LLM IDE`, `_llmide._tcp` Bonjour service, llm-ide usage strings.

- [ ] **Step 1: Rebrand the Info.plist display name**

In `ios_app/MyApp/Supporting/Info.plist`, replace:

```xml
  <key>CFBundleDisplayName</key>
  <string>AI Control</string>
```

with:

```xml
  <key>CFBundleDisplayName</key>
  <string>LLM IDE</string>
```

- [ ] **Step 2: Switch the Bonjour service type in Info.plist**

In the same file, replace:

```xml
  <key>NSBonjourServices</key>
  <array>
    <string>_aicontrol._tcp</string>
  </array>
```

with:

```xml
  <key>NSBonjourServices</key>
  <array>
    <string>_llmide._tcp</string>
  </array>
```

- [ ] **Step 3: Rebrand the usage-description strings**

In the same file, replace these four strings (each line individually):

```xml
  <string>AI Control discovers your Mac on the local network to connect automatically.</string>
```
→
```xml
  <string>LLM IDE discovers your Mac on the local network to connect automatically.</string>
```

```xml
  <string>AI Control uses the camera to scan the pairing QR code shown in the agent's terminal.</string>
```
→
```xml
  <string>LLM IDE uses the camera to scan the pairing QR code shown on your Mac.</string>
```

```xml
  <string>AI Control uses the microphone for voice commands — speak to open apps and type text on your computer.</string>
```
→
```xml
  <string>LLM IDE uses the microphone for voice commands — speak to open apps and type text on your computer.</string>
```

```xml
  <string>AI Control converts your speech to text on-device to control your computer by voice.</string>
```
→
```xml
  <string>LLM IDE converts your speech to text on-device to control your computer by voice.</string>
```

- [ ] **Step 4: Change the bundle id in the Xcode project**

In `ios_app/MyApp.xcodeproj/project.pbxproj`, replace **every** occurrence (Debug + Release build configs):

```
PRODUCT_BUNDLE_IDENTIFIER = com.aicontrol.MyApp;
```
with:

```
PRODUCT_BUNDLE_IDENTIFIER = com.llmide.mobile;
```

(Use the editor's replace-all; there are exactly two occurrences, at the `Debug` and `Release` `XCBuildConfiguration` sections.)

- [ ] **Step 5: Verify the rebrand via grep**

Run:

```bash
grep -RIn "com.aicontrol" ios_app && echo "STILL REFERENCES OLD BUNDLE ID" || echo "OK: no old bundle id"
grep -RIn "AI Control" ios_app/MyApp/Supporting/Info.plist && echo "STILL REFERENCES OLD NAME" || echo "OK: no old name"
grep -n "_llmide._tcp" ios_app/MyApp/Supporting/Info.plist
grep -c "com.llmide.mobile" ios_app/MyApp.xcodeproj/project.pbxproj
```
Expected: three `OK:` lines, one `_llmide._tcp` line, and a count of `2` for the bundle id.

- [ ] **Step 6: Verify the iOS app builds for the simulator**

Run (if the scheme name is not `MyApp`, run `xcodebuild -project MyApp.xcodeproj -list` first and substitute it):

```bash
cd ios_app && xcodebuild -project MyApp.xcodeproj -scheme MyApp \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug build CODE_SIGNING_ALLOWED=NO
```
Expected: `** BUILD SUCCEEDED **`. (Simulator build needs no signing team.)

- [ ] **Step 7: Commit**

```bash
git add ios_app/MyApp/Supporting/Info.plist ios_app/MyApp.xcodeproj/project.pbxproj
git commit -m "feat(ios): rebrand to llm-ide (bundle id, name, Bonjour service)"
```

---

## Task 6: Make the iOS app consume SharedProtocol

**Files:**
- Modify: `ios_app/MyApp.xcodeproj/project.pbxproj` (add local package — Xcode-managed)
- Modify: `ios_app/MyApp/Services/DeviceDiscovery.swift:10`, `:22`

**Interfaces:**
- Consumes: `SharedProtocol.MobileProtocol.serviceType` (Task 1).
- Produces: an iOS app whose discovery uses the shared service-type constant (the single wire constant now shared with the Mac app).

- [ ] **Step 1: Add the SharedProtocol package to the Xcode project (UI)**

Open `ios_app/MyApp.xcodeproj` in Xcode. Then:

1. Select the project (`MyApp`) in the project navigator → **Package Dependencies** tab.
2. **File → Add Package Dependencies…** → **Add Local…** → select `/Users/dinsmallade/llm-ide/ios_app/SharedProtocol`.
3. In the "Add Package" sheet, ensure the `SharedProtocol` library is added to the **MyApp** target, then click **Add Package**.

Save the project (⌘S). This records the local package reference in `project.pbxproj`.

> Note: Xcode writes the local-package reference; do not hand-edit that part of `project.pbxproj`. If Xcode is unavailable, this step blocks the rest of the task — the package must be linked before `import SharedProtocol` compiles.

- [ ] **Step 2: Use the shared service-type constant in DeviceDiscovery**

In `ios_app/MyApp/Services/DeviceDiscovery.swift`, replace the doc comment and the browse call. Replace:

```swift
/// Discovers AI Control agents on the local network via Bonjour (_aicontrol._tcp).
```
with:

```swift
/// Discovers llm-ide Mac apps on the local network via Bonjour (_llmide._tcp).
```

And replace:

```swift
        browser.searchForServices(ofType: "_aicontrol._tcp.", inDomain: "local.")
```
with:

```swift
        browser.searchForServices(ofType: MobileProtocol.serviceType + ".", inDomain: "local.")
```

Then add the import at the top of the file. Replace the first line:

```swift
import Foundation
```
with:

```swift
import Foundation
import SharedProtocol
```

- [ ] **Step 3: Verify the iOS app still builds for the simulator**

Run (if the scheme name is not `MyApp`, run `xcodebuild -project MyApp.xcodeproj -list` first and substitute it):

```bash
cd ios_app && xcodebuild -project MyApp.xcodeproj -scheme MyApp \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug build CODE_SIGNING_ALLOWED=NO
```
Expected: `** BUILD SUCCEEDED **`. (Confirms `SharedProtocol` is linked and `MobileProtocol.serviceType` resolves.)

- [ ] **Step 4: Commit**

```bash
git add ios_app/MyApp.xcodeproj/project.pbxproj ios_app/MyApp/Services/DeviceDiscovery.swift
git commit -m "feat(ios): consume SharedProtocol service-type constant"
```

---

## Task 7: Gate SharedProtocol tests in the pre-push hook

**Files:**
- Modify: `.githooks/pre-push` (add `ios_changed` detection + test run, mirroring the existing `ext_changed` block)

**Interfaces:** none (tooling). Produces: pushes touching `ios_app/` run `swift test` for the SharedProtocol package.

- [ ] **Step 1: Add `ios_changed` detection**

In `.githooks/pre-push`, in the `while read …` loop, add an `ios_changed` flag alongside `mac_changed`/`ext_changed`. First, add the variable initialization. Replace:

```bash
zero=0000000000000000000000000000000000000000
mac_changed=0
ext_changed=0
```
with:

```bash
zero=0000000000000000000000000000000000000000
mac_changed=0
ext_changed=0
ios_changed=0
```

Then, in the loop, add detection next to the existing two. Replace:

```bash
    if printf '%s\n' "$files" | grep -q '^extension/'; then
        ext_changed=1
    fi
done
```
with:

```bash
    if printf '%s\n' "$files" | grep -q '^extension/'; then
        ext_changed=1
    fi
    if printf '%s\n' "$files" | grep -q '^ios_app/'; then
        ios_changed=1
    fi
done
```

- [ ] **Step 2: Add the gate run**

Just before the final `exit 0`, add the ios gate block. Replace:

```bash
    fi
fi

exit 0
```
with:

```bash
    fi
fi

if [ "$ios_changed" -eq 1 ]; then
    echo "pre-push: ios_app/ changed — running SharedProtocol tests…"
    if ! (cd "$(git rev-parse --show-toplevel)/ios_app/SharedProtocol" && swift test); then
        echo "pre-push: SharedProtocol test gate FAILED — push aborted." >&2
        echo "          Fix the failure, or bypass with: git push --no-verify" >&2
        exit 1
    fi
fi

exit 0
```

- [ ] **Step 3: Verify the hook parses**

Run: `bash -n .githooks/pre-push && echo "syntax OK"`
Expected: `syntax OK` (no output from `bash -n` means valid).

- [ ] **Step 4: Commit**

```bash
git add .githooks/pre-push
git commit -m "chore: gate SharedProtocol tests on ios_app/ changes in pre-push"
```

---

## Phase 1 Done — Definition of Done

- [ ] `cd ios_app/SharedProtocol && swift test` passes (≥7 tests).
- [ ] `cd mac && swift build` succeeds with SharedProtocol linked.
- [ ] `xcodebuild … -destination 'generic/platform=iOS Simulator' build` succeeds for the rebranded iOS app.
- [ ] No `com.aicontrol` / `AI Control` / `_aicontrol._tcp` references remain under `ios_app/`.
- [ ] iOS app's `DeviceDiscovery` uses `MobileProtocol.serviceType` from the shared package.
- [ ] `.githooks/pre-push` runs SharedProtocol tests when `ios_app/` changes.
- [ ] All commits are conventional-commit scoped and not pushed.

## Follow-on Phases (separate plans)

- **Phase 2** — Native server core: `MobileWebSocketServer`, `MobileBonjourAdvertiser`, PIN (Keychain), heartbeat; refactor `MobileControlManager` to own it; Settings → IP/PIN/QR.
- **Phase 3** — llm-ide command channel (inbound `MobileCommandRouter`, chat via `LlmIdeAPIClient`, deep links, app/menu control) + `LlmIdeChat`/`LlmIdeDeepLink`/`LaunchApp`/`QuitApp`/`MenuClick` message types.
- **Phase 4** — Screen capture (in-process ScreenCaptureKit) + `StartViewing`/`StopViewing`.
- **Phase 5** — Input injection (CGEvent) + `RemoteInput`.
- **Phase 6** — Polish + docs + llm-ide color-palette swap.
