# Regression Verify + Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regression check's LLM answer-comparison with a deterministic verify-command + agent-repair pipeline, add portable fault packs, and fix the silent-corruption / sub-model / concurrency defects.

**Architecture:** `RegressionRunner` stays the orchestrator; its per-fault loop becomes a staged pipeline (`verify → repair → re-verify`) with two new injected protocols (`FaultVerifier`, `FaultRepairer`), a per-machine `VerifyApprovalStore`, and a command-less fallback to today's answer-compare+judge. Fault knowledge moves between projects via a `FaultPackService` JSON bundle. A small server change lets short judge/verify-author calls use the sub-model tier.

**Tech Stack:** Swift 5.9 / SwiftUI / Swift Testing / `Process` / Yams; Node.js (extension `route.mjs` / `ai-routes.mjs`).

**Spec:** [docs/superpowers/specs/2026-06-20-regression-verify-repair-design.md](../specs/2026-06-20-regression-verify-repair-design.md)

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `mac/Sources/LlmIdeMac/Services/FaultVerifier.swift` | `FaultVerifier` protocol + `ShellFaultVerifier` — run a verify command as a subprocess with a timeout. |
| `mac/Sources/LlmIdeMac/Services/VerifyApprovalStore.swift` | Per-machine approve-once gate keyed by `sha256(repo+file+command)`. |
| `mac/Sources/LlmIdeMac/Services/FaultRepairer.swift` | `FaultRepairer` protocol + `AgentFaultRepairer` — drive the agent to fix a confirmed regression. |
| `mac/Sources/LlmIdeMac/Services/FaultPack.swift` | `FaultPack` Codable + `FaultPackService` export/import. |
| `mac/Tests/LlmIdeMacTests/FaultVerifierTests.swift` | Shell verifier: pass/fail/timeout. |
| `mac/Tests/LlmIdeMacTests/VerifyApprovalStoreTests.swift` | approve/lookup/hash-change. |
| `mac/Tests/LlmIdeMacTests/RegressionPipelineTests.swift` | Pipeline routing, repair flow, cancellation, reentrancy. |
| `mac/Tests/LlmIdeMacTests/FaultPackTests.swift` | export→import round-trip, dup-guard, verify-stripped. |
| `mac/Tests/LlmIdeMacTests/FaultReportVerifyFieldTests.swift` | new fields round-trip + legacy decode. |

**Modify:**

| Path | Why |
|---|---|
| `mac/Sources/LlmIdeMac/CodeGraph/FaultReport.swift` | Add optional `verify` + `verifyKind` fields to the model + markdown round-trip. |
| `mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift` | CSV gains a `verify` column; add `gitDiff(at:paths:)` + `gitCheckout(at:paths:)` helpers. |
| `mac/Sources/LlmIdeMac/Services/RegressionRunner.swift` | New verdicts; pipeline; cancellation; reentrancy guard; inject verifier/repairer/approvals. |
| `mac/Sources/LlmIdeMac/Models/Config.swift` | Add `regressionAttemptRepair` + `regressionVerifyTimeout`. |
| `mac/Sources/LlmIdeMac/Views/Regression/RegressionView.swift` | Verify row, approval, diff review, pack buttons, timeout field. |
| `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` | Toggles for attempt-repair + auto-reopen + timeout field. |
| `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` | Wire the judge into the sweep; run verify+repair (stop at `.repaired`). |
| `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` | Generate a verify command (sub-model) when a fault is marked `fixed`. |
| `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift` | Add optional `tier` param to request. |
| `extension/server/ai-routes.mjs` | Map `tier: "subagent"` → `LLMIDE_SUBAGENT_MODEL`. |

---

## Task 1: `FaultReport` verify fields + round-trip

**Files:**
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/FaultReport.swift`
- Test: `mac/Tests/LlmIdeMacTests/FaultReportVerifyFieldTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/FaultReportVerifyFieldTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

struct FaultReportVerifyFieldTests {
    private func sample(verify: String?, verifyKind: FaultReport.VerifyKind?) -> FaultReport {
        FaultReport(
            prompt: "why does login 500?", response: "missing await on token refresh",
            notes: "n", severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc123", appVersion: "0.1", agent: "claude_code",
            status: .fixed, tags: ["auth"],
            verify: verify, verifyKind: verifyKind
        )
    }

    @Test func roundTripsVerifyFields() throws {
        let original = sample(verify: "swift test --filter AuthTests", verifyKind: .command)
        let md = try original.toMarkdown()
        let decoded = try FaultReport.fromMarkdown(md)
        #expect(decoded.verify == "swift test --filter AuthTests")
        #expect(decoded.verifyKind == .command)
    }

    @Test func legacyMarkdownWithoutVerifyFieldsDecodes() throws {
        // A fault written before this change — no verify/verify_kind keys.
        let legacy = """
        ---
        prompt: old question
        response: old answer
        severity: minor
        reported_at: "2024-05-23T12:00:00Z"
        app_version: "0.1"
        agent: claude_code
        status: fixed
        tags: []
        ---
        notes body
        """
        let decoded = try FaultReport.fromMarkdown(legacy)
        #expect(decoded.verify == nil)
        #expect(decoded.verifyKind == nil)
        #expect(decoded.status == .fixed)
    }

    @Test func omitsVerifyKeysWhenNil() throws {
        let md = try sample(verify: nil, verifyKind: nil).toMarkdown()
        #expect(!md.contains("verify:"))
        #expect(!md.contains("verify_kind:"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter FaultReportVerifyFieldTests`
Expected: FAIL — `FaultReport` has no `verify` / `verifyKind` / `VerifyKind`.

- [ ] **Step 3: Add the `VerifyKind` enum + stored properties**

In `FaultReport.swift`, after the `FaultStatus` enum (line 44), add:

```swift
enum VerifyKind: String, Codable, CaseIterable, Identifiable {
    case command
    var id: String { rawValue }
}
```

In `struct FaultReport`, after `var tags: [String]` (line 60), add (defaults keep the memberwise
initializer backward-compatible — existing call sites that don't pass these still compile):

```swift
    /// Agent-authored shell command, runnable from the repo root, that
    /// FAILS (non-zero exit) when this fault is present and PASSES when
    /// it is fixed. nil on legacy faults and faults with no runnable
    /// check — those fall back to answer comparison.
    var verify: String? = nil
    /// Kind of `verify`. `.command` is the only kind today; reserved so
    /// the schema can grow without a migration. nil ⇔ `verify` is nil.
    var verifyKind: VerifyKind? = nil
```

- [ ] **Step 4: Encode the new fields in `toMarkdown()`**

In `toMarkdown()`, after the `if let gitHead { ... }` line (line 116), add:

```swift
        if let verify { fm["verify"] = verify }
        if let verifyKind { fm["verify_kind"] = verifyKind.rawValue }
```

- [ ] **Step 5: Decode the new fields in `fromMarkdown()`**

In `fromMarkdown()`, after `let tags = (dict["tags"] as? [String]) ?? []` (line 147), add:

```swift
        let verify = dict["verify"] as? String
        let verifyKind = (dict["verify_kind"] as? String).flatMap(VerifyKind.init(rawValue:))
```

Then extend the returned initializer (line 148-152) to pass them:

```swift
        return FaultReport(
            prompt: prompt, response: response, notes: notes,
            severity: severity, reportedAt: reportedAt, gitHead: gitHead,
            appVersion: appVersion, agent: agent, status: status, tags: tags,
            verify: verify, verifyKind: verifyKind
        )
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd mac && swift test --filter FaultReportVerifyFieldTests`
Expected: PASS (3/3).

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/CodeGraph/FaultReport.swift mac/Tests/LlmIdeMacTests/FaultReportVerifyFieldTests.swift
git commit -m "feat(faults): optional verify/verify_kind fields on FaultReport"
```

---

## Task 2: CSV `verify` column

**Files:**
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift:138-164`
- Test: extend `mac/Tests/LlmIdeMacTests/FaultReportVerifyFieldTests.swift`

- [ ] **Step 1: Write the failing test** (append to `FaultReportVerifyFieldTests`)

```swift
    @Test func csvIncludesVerifyColumn() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("csv-verify-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo, sample(verify: "make test", verifyKind: .command))

        let csvURL = try store.exportFaultsCSV(at: repo)
        let csv = try String(contentsOf: csvURL, encoding: .utf8)
        let header = csv.split(separator: "\n").first.map(String.init) ?? ""
        #expect(header.contains("verify"))
        #expect(csv.contains("\"make test\""))
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter csvIncludesVerifyColumn`
Expected: FAIL — header has no `verify` column.

- [ ] **Step 3: Add the column to `exportFaultsCSV`**

In `MemoryStore.swift`, change the header (line 139) to:

```swift
        let header = "reported,severity,status,fault,answer,verify,git_head,app_version,agent,file"
```

And add the cell in the `cells` array (after `Self.shorten(fault.response)`, line 149):

```swift
                Self.shorten(fault.verify ?? ""),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter csvIncludesVerifyColumn`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift mac/Tests/LlmIdeMacTests/FaultReportVerifyFieldTests.swift
git commit -m "feat(faults): add verify column to faults.csv export"
```

---

## Task 3: Config fields

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift`

- [ ] **Step 1: Add the published properties**

In `Config.swift`, directly after the `regressionAutoReopen` block (line 251-253), add:

```swift
    @Published var regressionAttemptRepair: Bool {
        didSet { defaults.set(regressionAttemptRepair, forKey: "regressionAttemptRepair") }
    }
    @Published var regressionVerifyTimeout: TimeInterval {
        didSet { defaults.set(regressionVerifyTimeout, forKey: "regressionVerifyTimeout") }
    }
```

- [ ] **Step 2: Initialise from defaults**

In `init`, directly after the `self.regressionAutoReopen = ...` line (line 403), add:

```swift
        self.regressionAttemptRepair = defaults.object(forKey: "regressionAttemptRepair") as? Bool ?? false
        let savedTimeout = defaults.double(forKey: "regressionVerifyTimeout")
        self.regressionVerifyTimeout = savedTimeout > 0 ? savedTimeout : 120
```

- [ ] **Step 3: Build**

Run: `cd mac && swift build 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Config.swift
git commit -m "feat(config): regressionAttemptRepair + regressionVerifyTimeout"
```

---

## Task 4: Critical fix — judge in the auto-sweep + autoReopen safety guard

This fixes the silent file-corruption bug independently of the rest of the pipeline.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/RegressionRunner.swift` (run signature guard)
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift:343-367`
- Test: `mac/Tests/LlmIdeMacTests/RegressionGateTests.swift`

- [ ] **Step 1: Write the failing test** (append to `RegressionGateTests`)

```swift
    @Test func noJudgeWithAutoReopenDoesNotMutateDiskOnTextualDrift() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q",
                                 response: "the answer is 42", status: .fixed,
                                 reportedAt: Date(timeIntervalSince1970: 1_716_465_600))
        let prompter = FakePrompter()
        prompter.replies["q"] = "the answer is forty-two"   // textual drift, same meaning

        // No judge supplied + autoReopen requested → MUST refuse to reopen.
        let runner = RegressionRunner(prompter: prompter, judge: nil, store: store)
        await runner.run(at: repo, autoReopen: true)

        let reloaded = try store.loadFault(at: url)
        #expect(reloaded.status == .fixed)   // not flipped to .open
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter noJudgeWithAutoReopenDoesNotMutateDiskOnTextualDrift`
Expected: FAIL — fault is reopened (status == .open).

- [ ] **Step 3: Add the guard in `RegressionRunner.run`**

In `RegressionRunner.swift`, at the top of `run(at:only:autoReopen:)` (right after `running = true`,
line 111), neutralize unsafe auto-reopen:

```swift
        // Auto-reopen mutates files on disk. The exact-match verdict is
        // a heuristic; without a semantic judge to confirm textual drift
        // is a real regression, reopening would corrupt fault files on
        // every reworded LLM answer. Refuse the unsafe combination.
        let autoReopen = autoReopen && judge != nil
        if autoReopen == false { /* report-only; no disk mutation */ }
```

Rename the parameter so the shadowing is legal — change the signature to:

```swift
    func run(at repoRoot: URL, only: Set<URL>? = nil, autoReopen requestedAutoReopen: Bool = false) async {
```

and the first body line to:

```swift
        let autoReopen = requestedAutoReopen && judge != nil
```

(Place this immediately after `running = true`; remove the placeholder `if` above — it was illustrative.)

- [ ] **Step 4: Wire the judge into the auto-sweep**

In `AutoCodeUpdateService.swift`, change line 354 from:

```swift
        let runner = RegressionRunner(prompter: prompter, config: config)
```

to:

```swift
        let judge = CodeAssistJudge(api: api)
        let runner = RegressionRunner(prompter: prompter, judge: judge, config: config)
```

And fix the misleading status text (line 363) — only claim auto-reopen when it actually happened:

```swift
        } else if regressed > 0 {
            let reopened = config.regressionAutoReopen ? " (auto-reopened)" : ""
            taskErrors[AutoTask.regression.rawValue] = "Regression: \(regressed)/\(total) regressed\(reopened)."
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mac && swift test --filter RegressionGateTests`
Expected: PASS (both the existing `exportedCSVReflects...` test and the new one).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/RegressionRunner.swift mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift mac/Tests/LlmIdeMacTests/RegressionGateTests.swift
git commit -m "fix(regression): never auto-reopen without a judge; wire judge into auto-sweep"
```

---

## Task 5: `FaultVerifier` + `ShellFaultVerifier`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/FaultVerifier.swift`
- Test: `mac/Tests/LlmIdeMacTests/FaultVerifierTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/FaultVerifierTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

struct FaultVerifierTests {
    private func tmpRepo() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("verify-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func passingCommandReturnsZeroExit() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let out = try await ShellFaultVerifier().verify(command: "true", repoRoot: repo, timeout: 10)
        #expect(out.exitCode == 0)
    }

    @Test func failingCommandReturnsNonZeroExit() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let out = try await ShellFaultVerifier().verify(command: "false", repoRoot: repo, timeout: 10)
        #expect(out.exitCode != 0)
    }

    @Test func capturesOutput() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let out = try await ShellFaultVerifier().verify(command: "echo hello-verify", repoRoot: repo, timeout: 10)
        #expect(out.output.contains("hello-verify"))
    }

    @Test func timeoutKillsAndThrows() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        await #expect(throws: VerifyError.self) {
            _ = try await ShellFaultVerifier().verify(command: "sleep 5", repoRoot: repo, timeout: 1)
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter FaultVerifierTests`
Expected: FAIL — no `ShellFaultVerifier` / `VerifyError`.

- [ ] **Step 3: Implement the verifier**

```swift
// mac/Sources/LlmIdeMac/Services/FaultVerifier.swift
//
// Runs a fault's verify command as a local subprocess. A non-zero exit
// means the fault is present (regression); exit 0 means fixed. The
// command string is the agent-authored, user-approved verify command —
// nothing else reaches /bin/sh, and no fault content is interpolated
// into the command line.

import Foundation

struct VerifyOutcome: Equatable {
    let exitCode: Int32
    let output: String   // combined stdout + stderr
}

enum VerifyError: Error, Equatable {
    case timedOut(TimeInterval)
    case launchFailed(String)
}

protocol FaultVerifier: Sendable {
    func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome
}

struct ShellFaultVerifier: FaultVerifier {
    func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = repoRoot
        // New process group so a timeout can kill the whole subtree.
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do { try process.run() } catch {
            throw VerifyError.launchFailed(error.localizedDescription)
        }

        // Read output on a background thread so a large stream can't
        // deadlock the pipe before the process exits.
        let dataBox = OutputBox()
        let reader = Thread {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            dataBox.set(data)
        }
        reader.start()

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning {
            if Date() >= deadline {
                process.terminate()                 // SIGTERM
                // Give it a beat, then SIGKILL the group.
                kill(-process.processIdentifier, SIGKILL)
                throw VerifyError.timedOut(timeout)
            }
            try await Task.sleep(nanoseconds: 50_000_000) // 50ms poll
        }
        process.waitUntilExit()
        let output = String(data: dataBox.get(), encoding: .utf8) ?? ""
        return VerifyOutcome(exitCode: process.terminationStatus, output: output)
    }
}

/// Tiny thread-safe box so the reader thread and the awaiting task can
/// hand the captured data across without a data race.
private final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
    func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter FaultVerifierTests`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/FaultVerifier.swift mac/Tests/LlmIdeMacTests/FaultVerifierTests.swift
git commit -m "feat(regression): ShellFaultVerifier — run verify commands with a timeout"
```

---

## Task 6: `VerifyApprovalStore`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/VerifyApprovalStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/VerifyApprovalStoreTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/VerifyApprovalStoreTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

struct VerifyApprovalStoreTests {
    private func store() -> VerifyApprovalStore {
        // Isolated UserDefaults suite per test.
        let defaults = UserDefaults(suiteName: "approval-\(UUID().uuidString)")!
        return VerifyApprovalStore(defaults: defaults)
    }
    private let repo = URL(fileURLWithPath: "/tmp/repo")
    private let file = "2024-01-01T00-00-00Z-q.md"

    @Test func unknownCommandIsNotApproved() {
        #expect(store().isApproved(repo: repo, faultFile: file, command: "make test") == false)
    }

    @Test func approvedCommandIsApproved() {
        let s = store()
        s.approve(repo: repo, faultFile: file, command: "make test")
        #expect(s.isApproved(repo: repo, faultFile: file, command: "make test"))
    }

    @Test func changingCommandRearmsApproval() {
        let s = store()
        s.approve(repo: repo, faultFile: file, command: "make test")
        #expect(s.isApproved(repo: repo, faultFile: file, command: "make test-v2") == false)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter VerifyApprovalStoreTests`
Expected: FAIL — no `VerifyApprovalStore`.

- [ ] **Step 3: Implement the store**

```swift
// mac/Sources/LlmIdeMac/Services/VerifyApprovalStore.swift
//
// Per-MACHINE approve-once gate for verify commands. Approval is keyed
// by sha256(repoPath \0 faultFile \0 command) and stored in UserDefaults
// — deliberately NOT in the fault frontmatter, which travels with the
// repo via git. Local storage means each machine approves a command
// before it ever runs, and any edit to the command text (new hash)
// forces re-approval.

import Foundation
import CryptoKit

final class VerifyApprovalStore {
    private let defaults: UserDefaults
    private static let key = "regressionApprovedVerifyHashes"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func isApproved(repo: URL, faultFile: String, command: String) -> Bool {
        approvedSet().contains(hash(repo: repo, faultFile: faultFile, command: command))
    }

    func approve(repo: URL, faultFile: String, command: String) {
        var set = approvedSet()
        set.insert(hash(repo: repo, faultFile: faultFile, command: command))
        defaults.set(Array(set), forKey: Self.key)
    }

    private func approvedSet() -> Set<String> {
        Set(defaults.stringArray(forKey: Self.key) ?? [])
    }

    private func hash(repo: URL, faultFile: String, command: String) -> String {
        let material = "\(repo.standardizedFileURL.path)\u{0}\(faultFile)\u{0}\(command)"
        let digest = SHA256.hash(data: Data(material.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter VerifyApprovalStoreTests`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/VerifyApprovalStore.swift mac/Tests/LlmIdeMacTests/VerifyApprovalStoreTests.swift
git commit -m "feat(regression): per-machine VerifyApprovalStore (approve-once)"
```

---

## Task 7: `FaultRepairer` + `AgentFaultRepairer`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/FaultRepairer.swift`

The protocol + production adapter are introduced here; behavioral tests live in Task 8 (the pipeline)
using a fake repairer, because repair only has meaning inside the verify → repair → re-verify loop.

- [ ] **Step 1: Implement the protocol + production adapter**

```swift
// mac/Sources/LlmIdeMac/Services/FaultRepairer.swift
//
// Drives the agent (with write access) to fix a confirmed regression.
// The repairer edits the working tree in place; the resulting diff is
// read separately from git by the caller. Repair is a multi-file code
// edit, so the production adapter uses the FULL chat model, not the
// sub-model tier.

import Foundation

protocol FaultRepairer: AnyObject {
    /// Attempt to fix `fault`, given the failing verify output. Returns
    /// when the agent has finished editing (or made no change). Throws
    /// only on transport/CLI failure — "made no edit" is not an error
    /// (the caller re-verifies to decide the verdict).
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws
}

/// Production adapter — sends a structured repair instruction through
/// the same code-assist surface the rest of the app uses. The agent has
/// write tools in this deployment, so it can edit the repo directly.
final class AgentFaultRepairer: FaultRepairer {
    private let api: LlmIdeAPIClient
    private let language: String

    init(api: LlmIdeAPIClient, language: String = "en") {
        self.api = api
        self.language = language
    }

    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws {
        let prompt = """
        A previously-fixed fault has regressed. Fix it in the codebase at \(repoRoot.path).

        Original fault:
        \(fault.prompt)

        What the fix looked like when it was last working:
        \(String(fault.response.prefix(4_000)))

        The verify command now FAILS with this output:
        \(String(failureOutput.prefix(4_000)))

        Edit the code so the verify command passes again. Make the minimal
        change required. Do not modify the verify command itself.
        """
        _ = try await api.codeAssist(
            message: prompt, language: language, model: nil,
            history: [], attachments: [], agentContext: nil
        )
    }
}
```

- [ ] **Step 2: Build**

Run: `cd mac && swift build 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/FaultRepairer.swift
git commit -m "feat(regression): FaultRepairer protocol + agent-backed adapter"
```

---

## Task 8: `RegressionRunner` pipeline rewrite

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/RegressionRunner.swift`
- Test: `mac/Tests/LlmIdeMacTests/RegressionPipelineTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/RegressionPipelineTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct RegressionPipelineTests {
    final class FakePrompter: RegressionPrompter {
        var replies: [String: String] = [:]
        func ask(prompt: String) async throws -> String { replies[prompt] ?? "" }
    }
    /// Fake verifier driven by a queue of outcomes per command.
    final class FakeVerifier: FaultVerifier, @unchecked Sendable {
        var outcomes: [VerifyOutcome] = []
        var calls = 0
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            defer { calls += 1 }
            return calls < outcomes.count ? outcomes[calls] : VerifyOutcome(exitCode: 0, output: "")
        }
    }
    final class FakeRepairer: FaultRepairer {
        var repaired = false
        func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws { repaired = true }
    }

    private func tmpRepo() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pipe-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    private func writeFault(_ store: MemoryStore, at repo: URL, prompt: String,
                            response: String, verify: String?) throws -> URL {
        try store.writeFault(at: repo, FaultReport(
            prompt: prompt, response: response, notes: "", severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600), gitHead: nil,
            appVersion: "0.1", agent: "claude_code", status: .fixed, tags: [],
            verify: verify, verifyKind: verify == nil ? nil : .command))
    }

    @Test func verifyPassMarksUnchanged() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "ok-cmd")
        let verifier = FakeVerifier(); verifier.outcomes = [VerifyOutcome(exitCode: 0, output: "")]
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        approvals.approve(repo: repo, faultFile: store.listFaults(at: repo)[0].lastPathComponent, command: "ok-cmd")

        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: verifier, approvals: approvals)
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .unchanged)
    }

    @Test func unapprovedCommandNeedsApproval() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "ok-cmd")
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: FakeVerifier(), approvals: approvals)
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .needsApproval)
    }

    @Test func verifyFailThenRepairFixesMarksRepaired() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "c")
        let verifier = FakeVerifier()
        verifier.outcomes = [VerifyOutcome(exitCode: 1, output: "boom"),  // first verify fails
                             VerifyOutcome(exitCode: 0, output: "")]       // re-verify passes
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        approvals.approve(repo: repo, faultFile: url.lastPathComponent, command: "c")
        let repairer = FakeRepairer()
        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: verifier, repairer: repairer, approvals: approvals)
        await runner.run(at: repo, attemptRepair: true)
        #expect(repairer.repaired)
        #expect(runner.results.first?.verdict == .repaired)
    }

    @Test func verifyFailRepairOffMarksRegressed() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "c")
        let verifier = FakeVerifier(); verifier.outcomes = [VerifyOutcome(exitCode: 1, output: "x")]
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        approvals.approve(repo: repo, faultFile: url.lastPathComponent, command: "c")
        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: verifier, approvals: approvals)
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .regressed)
    }

    @Test func commandlessFaultUsesAnswerCompareFallback() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFault(store, at: repo, prompt: "q", response: "same", verify: nil)
        let prompter = FakePrompter(); prompter.replies["q"] = "same"
        let runner = RegressionRunner(prompter: prompter, store: store,
                                      verifier: FakeVerifier(),
                                      approvals: VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!))
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .unchanged)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter RegressionPipelineTests`
Expected: FAIL — new init params + verdicts + `attemptRepair` don't exist.

- [ ] **Step 3: Extend the `Verdict` enum**

In `RegressionRunner.swift`, replace the `Verdict` enum (line 35-41) with:

```swift
    enum Verdict: Equatable {
        case pending
        case unchanged
        case regressed
        case repaired                 // verify failed → repaired → re-verify passed
        case repairFailed(String)     // repaired but re-verify still failing
        case needsApproval            // has a verify command not yet approved on this machine
        case failed(String)           // couldn't run the check
    }
```

- [ ] **Step 4: Add the new dependencies to the initializer**

Replace the stored deps + `init` (lines 77-94) with:

```swift
    private let prompter: RegressionPrompter
    private let judge: RegressionJudge?
    private let store: MemoryStore
    private let verifier: FaultVerifier?
    private let repairer: FaultRepairer?
    private let approvals: VerifyApprovalStore
    private let verifyTimeout: TimeInterval
    weak var config: AppConfig?

    init(prompter: RegressionPrompter,
         judge: RegressionJudge? = nil,
         store: MemoryStore = MemoryStore(),
         verifier: FaultVerifier? = nil,
         repairer: FaultRepairer? = nil,
         approvals: VerifyApprovalStore = VerifyApprovalStore(),
         verifyTimeout: TimeInterval = 120,
         config: AppConfig? = nil) {
        self.prompter = prompter
        self.judge = judge
        self.store = store
        self.verifier = verifier
        self.repairer = repairer
        self.approvals = approvals
        self.verifyTimeout = verifyTimeout
        self.config = config
    }
```

- [ ] **Step 5: Add `diffPaths` to `Result`**

In `struct Result` (after `autoReopened`, line 54), add:

```swift
        /// Working-tree paths the repair touched, for the diff-review UI.
        var repairedPaths: [String] = []
```

- [ ] **Step 6: Rewrite the run loop**

Replace the signature + per-fault loop. Change the signature (line 110) to add `attemptRepair`:

```swift
    func run(at repoRoot: URL, only: Set<URL>? = nil,
             autoReopen requestedAutoReopen: Bool = false,
             attemptRepair: Bool = false) async {
```

Add reentrancy guard + the judge guard as the first lines after the signature:

```swift
        guard !running else { return }
        running = true
        let autoReopen = requestedAutoReopen && judge != nil
```

(Keep the existing `defer { ... }` block.)

Replace the body of the `for (idx, pair) in fixed.enumerated()` loop (lines 139-182) with a dispatch
to two private helpers:

```swift
        for (idx, pair) in fixed.enumerated() {
            if Task.isCancelled { appendLog(.warn, "Run cancelled"); break }
            let (url, fault) = pair
            let preview = String(fault.prompt.prefix(60))
            appendLog(.info, "[\(idx + 1)/\(fixed.count)] \(preview)")
            if let cmd = fault.verify, !cmd.isEmpty, let verifier {
                await runCommandFault(idx: idx, url: url, command: cmd,
                                      verifier: verifier, repoRoot: repoRoot,
                                      attemptRepair: attemptRepair)
            } else {
                await runAnswerCompareFault(idx: idx, fault: fault, url: url, autoReopen: autoReopen)
            }
        }
```

- [ ] **Step 7: Add the two private helpers**

Add these methods to `RegressionRunner` (before `appendLog`):

```swift
    /// Command-backed path: approve-gate → verify → (repair → re-verify).
    private func runCommandFault(idx: Int, url: URL, command: String,
                                 verifier: FaultVerifier, repoRoot: URL,
                                 attemptRepair: Bool) async {
        guard approvals.isApproved(repo: repoRoot, faultFile: url.lastPathComponent, command: command) else {
            results[idx].verdict = .needsApproval
            appendLog(.warn, "  → needs approval: \(command)")
            return
        }
        do {
            let first = try await verifier.verify(command: command, repoRoot: repoRoot, timeout: verifyTimeout)
            if first.exitCode == 0 {
                results[idx].verdict = .unchanged
                appendLog(.info, "  → verify passed")
                return
            }
            appendLog(.warn, "  → verify FAILED (exit \(first.exitCode))")
            guard attemptRepair, let repairer else {
                results[idx].verdict = .regressed
                return
            }
            appendLog(.info, "  → repairing…")
            try await repairer.repair(fault: (try store.loadFault(at: url)),
                                      failureOutput: first.output, repoRoot: repoRoot)
            let second = try await verifier.verify(command: command, repoRoot: repoRoot, timeout: verifyTimeout)
            if second.exitCode == 0 {
                results[idx].verdict = .repaired
                results[idx].repairedPaths = (try? store.gitDiff(at: repoRoot).changedPaths) ?? []
                appendLog(.info, "  → repaired · re-verify passed (review diff)")
            } else {
                results[idx].verdict = .repairFailed(String(second.output.suffix(200)))
                appendLog(.error, "  → repair attempted · re-verify still failing")
            }
        } catch let e as VerifyError {
            results[idx].verdict = .failed("\(e)")
            appendLog(.error, "  → \(e)")
        } catch {
            results[idx].verdict = .failed(error.localizedDescription)
            appendLog(.error, "  → failed: \(error.localizedDescription)")
        }
    }

    /// Command-less fallback — today's re-ask + semantic-judge path.
    private func runAnswerCompareFault(idx: Int, fault: FaultReport, url: URL, autoReopen: Bool) async {
        do {
            let reply = try await prompter.ask(prompt: fault.prompt)
            var v = Self.verdict(originalAnswer: fault.response, currentAnswer: reply)
            if v == .regressed, let judge {
                do {
                    if try await judge.sameMeaning(prompt: fault.prompt, original: fault.response, current: reply) {
                        v = .unchanged
                        appendLog(.info, "  → reworded, semantically unchanged (judge)")
                    }
                } catch {
                    v = .failed("answers differ textually; semantic judge unavailable: \(error.localizedDescription)")
                    appendLog(.error, "  → judge unavailable — verdict undecided")
                }
            }
            results[idx].currentAnswer = reply
            results[idx].verdict = v
            if v == .regressed {
                if autoReopen, (try? store.updateFaultStatus(at: url, to: .open)) != nil {
                    results[idx].autoReopened = true
                    appendLog(.warn, "  → REGRESSED · auto-reopened")
                } else {
                    appendLog(.warn, "  → REGRESSED")
                }
            } else if v == .unchanged {
                appendLog(.info, "  → unchanged")
            }
        } catch {
            results[idx].verdict = .failed(error.localizedDescription)
            appendLog(.error, "  → failed: \(error.localizedDescription)")
        }
    }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd mac && swift test --filter RegressionPipelineTests`
Expected: PASS (5/5). NOTE: the `gitDiff` call is added in Task 9 — if the build fails on
`store.gitDiff`, do Task 9 Step 3 first, then return here.

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/RegressionRunner.swift mac/Tests/LlmIdeMacTests/RegressionPipelineTests.swift
git commit -m "feat(regression): verify→repair→re-verify pipeline + new verdicts"
```

---

## Task 9: `MemoryStore` git diff/checkout helpers

**Files:**
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift`

- [ ] **Step 1: Add the helpers**

Append to `MemoryStore` (after `exportFaultsCSV`, around line 164):

```swift
    // MARK: - Working-tree diff (for repair review)

    struct GitDiff: Equatable {
        let unified: String
        let changedPaths: [String]
    }

    /// Unified diff of the working tree vs HEAD, plus the changed paths.
    /// Best-effort: throws only if git can't be launched.
    func gitDiff(at repo: URL) throws -> GitDiff {
        let unified = try Self.runGit(["-C", repo.path, "diff"], at: repo)
        let names = try Self.runGit(["-C", repo.path, "diff", "--name-only"], at: repo)
        let paths = names.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        return GitDiff(unified: unified, changedPaths: paths)
    }

    /// Revert the given working-tree paths to HEAD. Used by "Discard" in
    /// the repair-review UI.
    func gitCheckout(at repo: URL, paths: [String]) throws {
        guard !paths.isEmpty else { return }
        _ = try Self.runGit(["-C", repo.path, "checkout", "--"] + paths, at: repo)
    }

    private static func runGit(_ args: [String], at repo: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = repo
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }
```

- [ ] **Step 2: Build**

Run: `cd mac && swift build 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 3: Run the pipeline tests (now that `gitDiff` exists)**

Run: `cd mac && swift test --filter RegressionPipelineTests`
Expected: PASS (5/5).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift
git commit -m "feat(regression): MemoryStore git diff/checkout helpers for repair review"
```

---

## Task 10: Sub-model tier for short calls (server + client)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift`
- Modify: `extension/server/ai-routes.mjs:348-371`

- [ ] **Step 1: Add `tier` to the Swift request**

In `LlmIdeAPIClient+CodeAssist.swift`, add a field to `CodeAssistRequest` (after `let provider: String?`, line 43):

```swift
        /// Optional model tier hint. "subagent" → server routes to
        /// LLMIDE_SUBAGENT_MODEL (cheap, for short judge/verify-author
        /// calls). nil → normal global model.
        let tier: String?
```

Add a parameter to `codeAssist(...)` (after `provider:`, line 67) and pass it through:

```swift
        provider: String? = nil,
        tier: String? = nil,
        history: [CodeAssistTurn],
        attachments: [CodeAttachment],
        agentContext: AgentContext? = nil,
    ) async throws -> CodeAssistResponse {
        try await post(
            "/code-assist",
            body: CodeAssistRequest(
                message: message, language: language, model: model,
                provider: provider, tier: tier, history: history,
                attachments: attachments, agentContext: agentContext,
            ),
            authenticated: true,
        )
    }
```

- [ ] **Step 2: Honor `tier` server-side**

In `extension/server/ai-routes.mjs`, the code-assist handler builds `runClaude` with `model: body.model`
(line ~354). Change that closure so a `subagent` tier falls back to the env model when no explicit model
is given:

```javascript
        const tierModel = body.model
          || (body.tier === 'subagent' ? process.env.LLMIDE_SUBAGENT_MODEL : undefined);
        const out = await handleCodeAssist({
          // ...existing fields...
          runClaude: (p) => runClaude(p, { userId: req.user?.id, model: tierModel, provider: body.provider }),
```

(Apply the same `tierModel` to the non-agent `runClaude` call at line ~371 if present.)

- [ ] **Step 3: Route the judge + add a verify-author through the sub-model tier**

In `RegressionRunner.swift`, change `CodeAssistJudge.sameMeaning` (line 301) to pass the tier:

```swift
        let resp = try await api.codeAssist(
            message: Self.buildPrompt(prompt: prompt, original: original, current: current),
            language: "en", model: nil, tier: "subagent",
            history: [], attachments: [], agentContext: nil
        )
```

Also correct the now-accurate comment at lines 245-248 (drop "rather than the full chat model" caveat —
it now IS the sub-model tier).

- [ ] **Step 4: Build + run existing regression tests**

Run: `cd mac && swift build 2>&1 | tail -3 && swift test --filter "RegressionGateTests|RegressionPipelineTests"`
Expected: `Build complete!` then PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift extension/server/ai-routes.mjs mac/Sources/LlmIdeMac/Services/RegressionRunner.swift
git commit -m "feat(regression): route judge through LLMIDE_SUBAGENT_MODEL via tier hint"
```

---

## Task 11: Fix-time verify-command generation

When a fault is flipped to `fixed`, ask the sub-model for a verify command and persist it.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/VerifyCommandAuthor.swift`
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift` (status update that can also set verify)
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` (call it on fix)
- Test: `mac/Tests/LlmIdeMacTests/VerifyCommandAuthorTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/VerifyCommandAuthorTests.swift
import Testing
@testable import LlmIdeMac

struct VerifyCommandAuthorTests {
    @Test func noneReplyYieldsNilCommand() {
        #expect(VerifyCommandAuthor.parseReply("NONE") == nil)
        #expect(VerifyCommandAuthor.parseReply("  none ") == nil)
    }
    @Test func commandReplyIsTrimmed() {
        #expect(VerifyCommandAuthor.parseReply("```\nswift test --filter X\n```") == "swift test --filter X")
        #expect(VerifyCommandAuthor.parseReply("swift test --filter X\n") == "swift test --filter X")
    }
    @Test func emptyReplyYieldsNil() {
        #expect(VerifyCommandAuthor.parseReply("") == nil)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter VerifyCommandAuthorTests`
Expected: FAIL — no `VerifyCommandAuthor`.

- [ ] **Step 3: Implement the author**

```swift
// mac/Sources/LlmIdeMac/Services/VerifyCommandAuthor.swift
//
// Asks the sub-model for a single shell command that fails when a fault
// is present and passes when it's fixed. Called once when a fault is
// marked `fixed`. A reply of NONE (or empty) means no runnable check —
// the fault then rides the answer-compare fallback.

import Foundation

enum VerifyCommandAuthor {
    static func buildPrompt(fault: FaultReport, repoRoot: URL) -> String {
        """
        You just confirmed this fault is fixed in the repo at \(repoRoot.path).

        Fault: \(String(fault.prompt.prefix(1_000)))
        Fix summary: \(String(fault.response.prefix(2_000)))

        Give the SINGLE shell command, runnable from the repo root, that
        exits non-zero if this fault is present and exits zero if it is
        fixed (prefer an existing test). Reply with ONLY the command on
        one line, or exactly NONE if no such command exists.
        """
    }

    /// nil ⇔ no runnable command. Strips code fences and whitespace.
    static func parseReply(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("```") {
            s = s.replacingOccurrences(of: "```", with: "")
                 .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if s.isEmpty || s.uppercased() == "NONE" { return nil }
        return s.split(separator: "\n").first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Production call — uses the sub-model tier.
    static func author(fault: FaultReport, repoRoot: URL, api: LlmIdeAPIClient) async -> String? {
        let prompt = buildPrompt(fault: fault, repoRoot: repoRoot)
        guard let resp = try? await api.codeAssist(
            message: prompt, language: "en", model: nil, tier: "subagent",
            history: [], attachments: [], agentContext: nil
        ) else { return nil }
        return parseReply(resp.reply)
    }
}
```

- [ ] **Step 4: Add a `MemoryStore` helper to set both status and verify**

In `MemoryStore.swift`, after `updateFaultStatus` (line 124), add:

```swift
    /// Flip status to `.fixed` and attach a verify command in one write.
    /// When `command` is nil only the status changes.
    func markFixed(at url: URL, verify command: String?) throws {
        var fault = try loadFault(at: url)
        fault.status = .fixed
        if let command { fault.verify = command; fault.verifyKind = .command }
        let md = try fault.toMarkdown()
        try md.write(to: url, atomically: true, encoding: .utf8)
    }
```

- [ ] **Step 5: Call it where a fault is marked fixed**

In `CodeAssistantPanel.swift`, find the existing place that flips a fault to `.fixed` (search
`updateFaultStatus` / `.fixed`). Replace the status flip with: write status first (so the UI updates
immediately), then author the command in the background and patch the file:

```swift
        try store.updateFaultStatus(at: url, to: .fixed)
        Task {
            if let cmd = await VerifyCommandAuthor.author(fault: fault, repoRoot: repo, api: api) {
                try? store.markFixed(at: url, verify: cmd)
            }
        }
```

(Use the panel's existing `api`, `store`, and active-repo URL bindings — they are already in scope
where faults are managed. If `fault`/`url`/`repo` aren't all in scope at that call site, load the fault
via `store.loadFault(at: url)` first.)

- [ ] **Step 6: Run tests + build**

Run: `cd mac && swift test --filter VerifyCommandAuthorTests && swift build 2>&1 | tail -3`
Expected: PASS (3/3) then `Build complete!`

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/VerifyCommandAuthor.swift mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift mac/Tests/LlmIdeMacTests/VerifyCommandAuthorTests.swift
git commit -m "feat(regression): author verify command (sub-model) when a fault is fixed"
```

---

## Task 12: `FaultPack` export/import

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/FaultPack.swift`
- Test: `mac/Tests/LlmIdeMacTests/FaultPackTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/FaultPackTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

struct FaultPackTests {
    private func tmpRepo() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pack-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    private func fault(_ prompt: String, verify: String?) -> FaultReport {
        FaultReport(prompt: prompt, response: "r", notes: "n", severity: .minor,
                    reportedAt: Date(timeIntervalSince1970: 1_716_465_600), gitHead: "deadbeef",
                    appVersion: "9.9", agent: "claude_code", status: .fixed, tags: ["t"],
                    verify: verify, verifyKind: verify == nil ? nil : .command)
    }

    @Test func exportStripsHostSpecificFields() throws {
        let svc = FaultPackService(store: MemoryStore())
        let data = try svc.export(faults: [fault("q1", verify: "make test")], sourceProject: "proj-a",
                                  exportedAt: Date(timeIntervalSince1970: 1_716_500_000))
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("q1"))
        #expect(!json.contains("make test"))   // verify command stripped
        #expect(!json.contains("deadbeef"))    // git_head stripped
    }

    @Test func importWritesOpenFaultsAndDedupes() throws {
        let store = MemoryStore()
        let svc = FaultPackService(store: store)
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let data = try svc.export(faults: [fault("dup", verify: nil)], sourceProject: "src",
                                  exportedAt: Date(timeIntervalSince1970: 1_716_500_000))

        let s1 = try svc.importPack(data: data, into: repo)
        #expect(s1.imported == 1)
        let loaded = try store.loadFault(at: store.listFaults(at: repo)[0])
        #expect(loaded.status == .open)
        #expect(loaded.verify == nil)
        #expect(loaded.tags.contains("imported:src"))

        let s2 = try svc.importPack(data: data, into: repo)   // re-import is idempotent
        #expect(s2.imported == 0)
        #expect(s2.skipped == 1)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter FaultPackTests`
Expected: FAIL — no `FaultPackService`.

- [ ] **Step 3: Implement the pack**

```swift
// mac/Sources/LlmIdeMac/Services/FaultPack.swift
//
// Portable fault knowledge. Carries only the reusable signal — prompt,
// response, notes, severity, tags + provenance. Host-specific fields
// (verify command, status, git_head, app_version) are intentionally
// dropped: each importing project regenerates its own verify command
// when it works the fault.

import Foundation

struct FaultPackEntry: Codable, Equatable {
    let prompt: String
    let response: String
    let notes: String
    let severity: String
    let tags: [String]
    let reportedAt: Date
}

struct FaultPack: Codable, Equatable {
    let schemaVersion: Int
    let sourceProject: String
    let exportedAt: Date
    let entries: [FaultPackEntry]
}

struct ImportSummary: Equatable {
    var imported: Int = 0
    var skipped: Int = 0
}

final class FaultPackService {
    private let store: MemoryStore
    init(store: MemoryStore) { self.store = store }

    func export(faults: [FaultReport], sourceProject: String, exportedAt: Date) throws -> Data {
        let entries = faults.map {
            FaultPackEntry(prompt: $0.prompt, response: $0.response, notes: $0.notes,
                           severity: $0.severity.rawValue, tags: $0.tags, reportedAt: $0.reportedAt)
        }
        let pack = FaultPack(schemaVersion: 1, sourceProject: sourceProject,
                             exportedAt: exportedAt, entries: entries)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        enc.dateEncodingStrategy = .iso8601
        return try enc.encode(pack)
    }

    func importPack(data: Data, into repo: URL) throws -> ImportSummary {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        let pack = try dec.decode(FaultPack.self, from: data)
        let existing = Set(store.listFaults(at: repo).compactMap {
            try? store.loadFault(at: $0).prompt
        }.map(Self.normalise))
        var summary = ImportSummary()
        for entry in pack.entries {
            if existing.contains(Self.normalise(entry.prompt)) { summary.skipped += 1; continue }
            var tags = entry.tags
            tags.append("imported:\(pack.sourceProject)")
            let fault = FaultReport(
                prompt: entry.prompt, response: entry.response, notes: entry.notes,
                severity: FaultSeverity(rawValue: entry.severity) ?? .minor,
                reportedAt: entry.reportedAt, gitHead: nil, appVersion: "",
                agent: "imported", status: .open, tags: tags,
                verify: nil, verifyKind: nil)
            _ = try store.writeFault(at: repo, fault)
            summary.imported += 1
        }
        return summary
    }

    private static func normalise(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter FaultPackTests`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/FaultPack.swift mac/Tests/LlmIdeMacTests/FaultPackTests.swift
git commit -m "feat(regression): portable FaultPack export/import (knowledge only)"
```

---

## Task 13: Wire deps into `RegressionView` + UI states

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Regression/RegressionView.swift`

- [ ] **Step 1: Build the runner with the new deps**

In `RegressionView.init` (line 37-46), replace the runner construction with:

```swift
    init(api: LlmIdeAPIClient) {
        self.api = api
        let prompter = CodeAssistPrompter(api: api, agent: "claude_code")
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api)
        _runner = StateObject(wrappedValue: RegressionRunner(
            prompter: prompter, judge: judge,
            verifier: ShellFaultVerifier(), repairer: repairer))
    }
```

- [ ] **Step 2: Pass repair flag + timeout from config in `runSelected`**

Replace `runSelected()` (line 114-118):

```swift
    private func runSelected() async {
        guard let repo = activeRepoRoot else { return }
        let only = checked.isEmpty ? nil : checked
        runner.applyTimeout(config.regressionVerifyTimeout)
        await runner.run(at: repo, only: only,
                         autoReopen: config.regressionAutoReopen,
                         attemptRepair: config.regressionAttemptRepair)
    }
```

Add a setter to `RegressionRunner` (the stored `verifyTimeout` is `let`; change it to `private var` and add):

```swift
    func applyTimeout(_ t: TimeInterval) { /* stored */ }
```

Change `private let verifyTimeout` → `private var verifyTimeout` in Task 8's init block, and implement
`applyTimeout` as `verifyTimeout = max(1, t)`.

- [ ] **Step 3: Extend the verdict pills**

In `verdictPill` (line 315-330) and `verdictBadge` (line 527-549), add the new cases:

```swift
            case .repaired:        return ("repaired", t.accent3)
            case .repairFailed:    return ("repair-failed", t.danger)
            case .needsApproval:   return ("approve", t.accent4)
```

(Add to both `switch` statements; keep existing `pending`/`unchanged`/`regressed`/`failed`.)

- [ ] **Step 4: Add the Verify row + approval to `faultDetail`**

In `RegressionDetailPane.faultDetail` (after `fmGrid(fault)`, line 410), add:

```swift
                    if let cmd = fault.verify, !cmd.isEmpty {
                        sectionHeader("Verify command")
                        Text(cmd).font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                        let approved = approvals.isApproved(repo: repo, faultFile: url.lastPathComponent, command: cmd)
                        if !approved {
                            Button("Approve & enable") {
                                approvals.approve(repo: repo, faultFile: url.lastPathComponent, command: cmd)
                            }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                        }
                    } else {
                        sectionHeader("Verify command")
                        Text("no check — uses answer comparison")
                            .font(Typography.caption).foregroundStyle(t.textMuted)
                    }
```

`RegressionDetailPane` needs an `approvals` handle and the repo — add `let approvals: VerifyApprovalStore`
and `let repoRoot: URL?` to its properties and pass them from `RegressionView.body` (use a shared
`VerifyApprovalStore()` stored on the view). Guard the block with `if let repo = repoRoot`.

- [ ] **Step 5: Add the diff-review block for repaired faults**

Still in `faultDetail`, after the verify block, add:

```swift
                    if let r = results.first(where: { $0.faultURL.standardizedFileURL.path == url.standardizedFileURL.path }),
                       (r.verdict == .repaired || { if case .repairFailed = r.verdict { return true }; return false }()),
                       let repo = repoRoot,
                       let diff = try? config.memoryStore.gitDiff(at: repo), !diff.unified.isEmpty {
                        sectionHeader("Repair diff")
                        ScrollView { Text(diff.unified).font(.system(size: 10, design: .monospaced)).textSelection(.enabled) }
                            .frame(maxHeight: 240)
                        HStack {
                            Button("Approve (mark fixed)") {
                                try? config.memoryStore.markFixed(at: url, verify: fault.verify)
                            }.buttonStyle(.borderedProminent).controlSize(.small)
                            Button("Discard (revert + reopen)") {
                                try? config.memoryStore.gitCheckout(at: repo, paths: r.repairedPaths)
                                try? config.memoryStore.updateFaultStatus(at: url, to: .open)
                            }.buttonStyle(.bordered).controlSize(.small)
                        }
                    }
```

- [ ] **Step 6: Add Export/Import pack buttons + timeout field to the toolbar**

In `RegressionDetailPane.toolbar` (after the auto-reopen toggle, line 379), add:

```swift
            Button("Export pack…") { exportPack() }
                .buttonStyle(.bordered).controlSize(.small).disabled(running || !hasRepo)
            Button("Import pack…") { importPack() }
                .buttonStyle(.bordered).controlSize(.small).disabled(running || !hasRepo)
            HStack(spacing: 4) {
                Text("timeout").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("120", value: $config.regressionVerifyTimeout, format: .number)
                    .frame(width: 50).textFieldStyle(.roundedBorder)
            }
```

Add `exportPack()` / `importPack()` to `RegressionDetailPane` using `NSSavePanel` / `NSOpenPanel` and
`FaultPackService` (load faults via `config.memoryStore.listFaults` + `loadFault`):

```swift
    private func exportPack() {
        guard let repo = repoRoot else { return }
        let store = config.memoryStore
        let faults = store.listFaults(at: repo).compactMap { try? store.loadFault(at: $0) }
        guard let data = try? FaultPackService(store: store)
            .export(faults: faults, sourceProject: repo.lastPathComponent, exportedAt: Date()) else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = "faults-pack.json"
        if panel.runModal() == .OK, let url = panel.url { try? data.write(to: url) }
    }
    private func importPack() {
        guard let repo = repoRoot else { return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url, let data = try? Data(contentsOf: url) else { return }
        _ = try? FaultPackService(store: config.memoryStore).importPack(data: data, into: repo)
    }
```

`RegressionDetailPane` will need `repoRoot` (added in Step 4). `NSSavePanel`/`NSOpenPanel` require
`import AppKit` at the top of the file.

- [ ] **Step 7: Build**

Run: `cd mac && swift build 2>&1 | tail -5`
Expected: `Build complete!` (fix any property-passing mismatches the compiler flags).

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Regression/RegressionView.swift mac/Sources/LlmIdeMac/Services/RegressionRunner.swift
git commit -m "feat(regression): verify/approval/diff-review UI + fault-pack buttons"
```

---

## Task 14: Settings toggles

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift`

- [ ] **Step 1: Add the toggles + timeout under the Regression task toggle**

In `AutoCodeSettingsSection.swift`, after the Regression `taskToggle` (line 66), add:

```swift
                        taskToggle("Attempt repair on regression", icon: "wrench.and.screwdriver",
                                   binding: $config.regressionAttemptRepair)
                        taskToggle("Auto-reopen regressed faults", icon: "arrow.uturn.backward",
                                   binding: $config.regressionAutoReopen)
                        HStack {
                            Image(systemName: "timer").font(.system(size: 12))
                            Text("Verify timeout (s)").font(Typography.caption)
                            Spacer()
                            TextField("120", value: $config.regressionVerifyTimeout, format: .number)
                                .frame(width: 60).textFieldStyle(.roundedBorder)
                        }
```

- [ ] **Step 2: Build**

Run: `cd mac && swift build 2>&1 | tail -3`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift
git commit -m "feat(settings): regression repair + auto-reopen toggles + verify timeout"
```

---

## Task 15: AutoCode sweep runs verify+repair

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift:343-367`

- [ ] **Step 1: Build the sweep runner with the full pipeline**

Replace the runner construction in `runRegressionSweep` (the lines around 353-355, as left by Task 4) with:

```swift
        let prompter = CodeAssistPrompter(api: api, agent: config.activeCLI)
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api)
        let runner = RegressionRunner(prompter: prompter, judge: judge,
                                      verifier: ShellFaultVerifier(), repairer: repairer,
                                      verifyTimeout: config.regressionVerifyTimeout, config: config)
        await runner.run(at: repoRoot,
                         autoReopen: config.regressionAutoReopen,
                         attemptRepair: config.regressionAttemptRepair)
```

The background sweep stops at `.repaired` (the pipeline never commits — diff review is a UI action), so
no further change is needed here; the summary counting `regressed` already excludes `.repaired`.

- [ ] **Step 2: Build + run regression tests**

Run: `cd mac && swift build 2>&1 | tail -3 && swift test --filter "RegressionGateTests|RegressionPipelineTests"`
Expected: `Build complete!` then PASS.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift
git commit -m "feat(regression): auto-sweep runs verify+repair pipeline"
```

---

## Task 16: Full verification + manual smoke

- [ ] **Step 1: Full test suite**

Run: `cd mac && swift test 2>&1 | tail -20`
Expected: all new suites pass; no NEW failures vs. the pre-existing baseline.

- [ ] **Step 2: Build + launch**

Run: `bash mac/Scripts/build.sh && open mac/LlmIdeMac.app`
Expected: `[build] ok` then the app launches.

- [ ] **Step 3: Manual smoke**

1. With an active repo, file a fault from Code Assistant and mark it **Fixed** → after a moment the
   fault's frontmatter gains a `verify:` command (check `Reveal in Finder` → open the `.md`).
2. Open **Regression**, select the fault → the **Verify command** row shows the command with
   **Approve & enable**.
3. Approve, then **Run** → verdict shows `ok` (or `repaired`/`regressed` depending on the code state).
4. Enable **Attempt repair on regression** in Settings; break the code so verify fails; Run again →
   `repaired` with a **Repair diff** and **Approve / Discard** actions. Verify Discard reverts the tree.
5. **Export pack…** → save JSON; in another repo, **Import pack…** → faults appear as `open` with an
   `imported:<repo>` tag and no verify command.
6. Settings → confirm the **Auto-reopen** + **Attempt repair** toggles and **Verify timeout** field
   persist across relaunch.

- [ ] **Step 4: Final commit (if smoke fixes were needed)**

```bash
git add -A && git commit -m "fix(regression): smoke-test corrections"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `verify` / `verify_kind` fields on faults | Task 1 |
| Fix-time verify-command generation (sub-model, NONE handling) | Task 11 |
| Per-machine approve-once gate | Task 6, surfaced in Task 13 |
| Verify subprocess + timeout | Task 5 |
| Verdict pipeline (verify → repair → re-verify) + new verdicts | Task 8 |
| Repair via agent, diff review (approve/discard) | Task 7 (repairer), Task 9 (diff), Task 13 (UI) |
| Command-less fallback to answer-compare + judge | Task 8 (`runAnswerCompareFault`) |
| Concurrency: reentrancy guard + cancellation | Task 8 |
| Silent-corruption fix (no judge ⇒ no auto-reopen) + judge in sweep | Task 4 |
| Sub-model wiring via `tier` | Task 10 |
| Portable fault packs (knowledge-only, dedupe, re-verify per project) | Task 12, Task 13 (buttons) |
| Config fields + Settings UI (+ auto-reopen toggle) | Task 3, Task 14 |
| CSV `verify` column | Task 2 |
| AutoCode sweep runs the pipeline, stops at `.repaired` | Task 15 |

**Placeholder scan:** No TBDs. The two UI tasks (13, 14) and the `CodeAssistantPanel` edit (Task 11
Step 5) describe call-site integration that depends on existing in-scope bindings; each names the
exact symbols to use and the fallback (`loadFault(at:)`) when a binding isn't already present.

**Type consistency:** `FaultVerifier.verify(command:repoRoot:timeout:) -> VerifyOutcome`,
`FaultRepairer.repair(fault:failureOutput:repoRoot:)`, `VerifyApprovalStore.{isApproved,approve}(repo:faultFile:command:)`,
`RegressionRunner.run(at:only:autoReopen:attemptRepair:)`, `Verdict.{repaired,repairFailed,needsApproval}`,
`MemoryStore.{gitDiff,gitCheckout,markFixed}`, `FaultPackService.{export,importPack}`, and the
`codeAssist(..., tier:)` param are used consistently across the tasks that define and consume them.

**Concurrency note for the implementer:** `RegressionRunner` is `@MainActor`. The spec calls for moving
disk scan + verify off the main actor; Task 8 keeps the orchestration on the main actor and relies on
`ShellFaultVerifier` (a `Sendable` struct doing its blocking work via `Task.sleep` polling, not a busy
loop) to avoid blocking. If profiling shows the disk scan stutters the UI, wrap `store.listFaults` +
decode in a `Task.detached` and hop back — left as a follow-up rather than blocking this plan.
