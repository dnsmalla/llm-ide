# Phase C — Repeated-Command Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** When the user sends the same prompt 3 times in a session, surface a non-blocking banner above the composer offering to save the most recent answer as a Q&A entry under `<repo>/graphify-out/memory/q&a/`.

**Architecture:** New `CodeAssistantSession` `ObservableObject` holds an in-memory `[String: Int]` of normalised-prompt-hash → count, plus a `Set<String>` of hashes the user dismissed for the session. `CodeAssistantPanel.send()` calls `session.record(prompt:)` and reads `session.shouldNudge(for:)` to decide whether to show the banner. `MemoryStore` gains `writeQA(at:_:)`. Resets on app launch (fresh instance) and active-repo switch (observed via `config.activeProjectId`).

**Tech Stack:** Swift 5.9 / SwiftUI / Yams / CryptoKit (SHA-256).

**Spec:** [docs/superpowers/specs/2026-05-24-agent-memory-and-feedback-design.md §C](../specs/2026-05-24-agent-memory-and-feedback-design.md).

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `mac/Sources/LlmIdeMac/CodeGraph/QAEntry.swift` | `QAEntry` struct + YAML-frontmatter encode + `suggestedFileName()`. |
| `mac/Sources/LlmIdeMac/Services/CodeAssistantSession.swift` | Session-scoped repeat counter + dismissed set. `ObservableObject`. |
| `mac/Tests/LlmIdeMacTests/QAEntryTests.swift` | Frontmatter encode test + slug test. |
| `mac/Tests/LlmIdeMacTests/CodeAssistantSessionTests.swift` | Normalisation + threshold + dismiss tests. |

**Modify:**

| Path | Why |
|---|---|
| `mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift` | Add `writeQA(at:_:)`. |
| `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` | Own a `@StateObject CodeAssistantSession`; call `record()` in `send()`; render banner above the composer when `shouldNudge` is true. |

---

## Task 1: `QAEntry` model

**Files:**
- Create: `mac/Sources/LlmIdeMac/CodeGraph/QAEntry.swift`
- Create: `mac/Tests/LlmIdeMacTests/QAEntryTests.swift`

- [ ] **Step 1: Write tests**

```swift
// mac/Tests/LlmIdeMacTests/QAEntryTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

struct QAEntryTests {
    @Test func encodeIncludesRequiredFrontmatterFields() throws {
        let entry = QAEntry(
            question: "How does auth work?",
            answer: "JWT with refresh tokens.",
            savedAt: Date(timeIntervalSince1970: 1_716_465_600),
            askCount: 3,
            agent: "claude_code"
        )
        let md = try entry.toMarkdown()
        #expect(md.hasPrefix("---\n"))
        #expect(md.contains("question:"))
        #expect(md.contains("answer:"))
        #expect(md.contains("ask_count: 3"))
        #expect(md.contains("agent: claude_code"))
        #expect(md.contains("saved_at: 2024-05-23T12:00:00Z"))
    }

    @Test func suggestedFileNameUsesTimestampPlusSlug() {
        let entry = QAEntry(
            question: "How does AUTH work?!",
            answer: "x",
            savedAt: Date(timeIntervalSince1970: 1_716_465_600),
            askCount: 3,
            agent: "claude_code"
        )
        let name = entry.suggestedFileName()
        #expect(name.hasPrefix("2024-05-23T12-00-00Z-"))
        #expect(name.contains("how-does-auth-work"))
        #expect(name.hasSuffix(".md"))
    }
}
```

- [ ] **Step 2: Implement `QAEntry`**

```swift
// mac/Sources/LlmIdeMac/CodeGraph/QAEntry.swift
//
// User-saved Q&A pair. Persisted as markdown with YAML frontmatter
// under <repo>/graphify-out/memory/q&a/<slug>.md, alongside bug
// reports. Phase C's repeated-command detection writes these.
//
// We share slugify + the FS-safe timestamp formatter with BugReport
// by going through static helpers on BugReport — both files live in
// the same module so there's no visibility concern.

import Foundation
import Yams

struct QAEntry: Equatable {
    var question: String
    var answer: String
    var savedAt: Date
    var askCount: Int
    /// `AICliTool.rawValue` of the agent that produced the answer.
    var agent: String

    func toMarkdown() throws -> String {
        let fm: [String: Any] = [
            "question": question,
            "answer": answer,
            "saved_at": BugReport.isoFormatter.string(from: savedAt),
            "ask_count": askCount,
            "agent": agent
        ]
        let yaml = try Yams.dump(object: fm)
        // No notes body — Q&A is purely the (question, answer) pair.
        return "---\n\(yaml)---\n"
    }

    func suggestedFileName() -> String {
        let ts = Self.fsTimestamp.string(from: savedAt)
        return "\(ts)-\(BugReport.slugify(question)).md"
    }

    private static let fsTimestamp: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        return f
    }()
}
```

NOTE: `BugReport.isoFormatter` is already `static let`. `BugReport.slugify` is `static`. Both are accessible from QAEntry without changes.

- [ ] **Step 3: Run tests, expect 2/2 PASS**

```
swift test --filter QAEntryTests
```

- [ ] **Step 4: Commit**

```
git add mac/Sources/LlmIdeMac/CodeGraph/QAEntry.swift mac/Tests/LlmIdeMacTests/QAEntryTests.swift
git commit -m "feat(memory): QAEntry model for saved question/answer pairs"
```

---

## Task 2: Extend `MemoryStore` with `writeQA`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift`

- [ ] **Step 1: Add `writeQA(at:_:)`**

Insert after the existing `updateBugStatus` block, before `// MARK: - Template`:

```swift
    // MARK: - Q&A writes (Phase C)

    /// Write a saved Q&A under `<repo>/graphify-out/memory/q&a/`.
    /// Same naming convention as bugs — ISO timestamp + slug, so
    /// directory listings are chronological.
    @discardableResult
    func writeQA(at repo: URL, _ entry: QAEntry) throws -> URL {
        let dir = qaDir(in: repo)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(entry.suggestedFileName())
        let md = try entry.toMarkdown()
        try md.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
```

`qaDir(in:)` is already a private helper on `MemoryStore` — no other changes needed.

- [ ] **Step 2: Build**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 3: Commit**

```
git add mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift
git commit -m "feat(memory): MemoryStore.writeQA — persist saved Q&A pairs"
```

---

## Task 3: `CodeAssistantSession` service

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/CodeAssistantSession.swift`
- Create: `mac/Tests/LlmIdeMacTests/CodeAssistantSessionTests.swift`

- [ ] **Step 1: Write tests**

```swift
// mac/Tests/LlmIdeMacTests/CodeAssistantSessionTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct CodeAssistantSessionTests {
    @Test func normalisesWhitespaceAndCase() {
        let s = CodeAssistantSession()
        let h1 = s.hashForPrompt("  How does AUTH work? ")
        let h2 = s.hashForPrompt("how does auth work")
        #expect(h1 == h2)
    }

    @Test func recordIncrementsCounter() {
        let s = CodeAssistantSession()
        let h = s.record(prompt: "explain auth")
        #expect(s.count(for: h) == 1)
        _ = s.record(prompt: "explain auth")
        _ = s.record(prompt: "explain auth")
        #expect(s.count(for: h) == 3)
    }

    @Test func shouldNudgeFiresAtThresholdAndStaysOnUntilDismissed() {
        let s = CodeAssistantSession()
        let p = "explain auth"
        _ = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == false)
        _ = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == false)
        let h = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == true)

        s.dismiss(hash: h)
        #expect(s.shouldNudge(for: p) == false)
        // Further repeats stay dismissed.
        _ = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == false)
    }

    @Test func resetClearsCounterAndDismissed() {
        let s = CodeAssistantSession()
        let h = s.record(prompt: "x")
        s.dismiss(hash: h)
        s.reset()
        #expect(s.count(for: h) == 0)
        #expect(s.shouldNudge(for: "x") == false)
        _ = s.record(prompt: "x")
        _ = s.record(prompt: "x")
        _ = s.record(prompt: "x")
        // After reset, dismiss state is cleared too — threshold fires again.
        #expect(s.shouldNudge(for: "x") == true)
    }

    @Test func emptyOrWhitespacePromptsAreIgnored() {
        let s = CodeAssistantSession()
        let h = s.record(prompt: "   ")
        #expect(h.isEmpty)
        #expect(s.shouldNudge(for: "   ") == false)
    }
}
```

- [ ] **Step 2: Implement the service**

```swift
// mac/Sources/LlmIdeMac/Services/CodeAssistantSession.swift
//
// In-memory bookkeeping for "the user just asked this 3 times in a
// row" detection. Lives for the lifetime of a CodeAssistantPanel
// instance + active repo. Reset on app launch (fresh instance) and
// on active-repo switch (caller invokes reset()).
//
// Prompts are normalised before hashing so cosmetic variations
// ("How does auth work?" vs "how does auth work") collapse to the
// same bucket.

import Foundation
import CryptoKit

@MainActor
final class CodeAssistantSession: ObservableObject {
    /// Number of repeats that triggers the banner. 3 is the spec's
    /// conservative default; tunable here if it proves noisy.
    static let nudgeThreshold = 3

    @Published private(set) var counts: [String: Int] = [:]
    @Published private(set) var dismissed: Set<String> = []

    /// Record a user prompt. Returns the hash so the caller can pass
    /// it back to `dismiss(hash:)` without recomputing. Empty / pure-
    /// whitespace prompts return "" and are ignored.
    @discardableResult
    func record(prompt: String) -> String {
        let h = hashForPrompt(prompt)
        guard !h.isEmpty else { return "" }
        counts[h, default: 0] += 1
        return h
    }

    /// Stable hash of a normalised prompt. Public for tests + UI
    /// (the banner needs it to look up the dismiss set).
    func hashForPrompt(_ prompt: String) -> String {
        let n = normalise(prompt)
        guard !n.isEmpty else { return "" }
        let digest = SHA256.hash(data: Data(n.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    func count(for hash: String) -> Int { counts[hash, default: 0] }

    /// True iff the prompt has hit the threshold AND the user hasn't
    /// dismissed the nudge for this hash yet.
    func shouldNudge(for prompt: String) -> Bool {
        let h = hashForPrompt(prompt)
        guard !h.isEmpty else { return false }
        return counts[h, default: 0] >= Self.nudgeThreshold && !dismissed.contains(h)
    }

    /// Suppress the banner for this hash for the rest of the session.
    func dismiss(hash: String) { dismissed.insert(hash) }

    /// Wipe all counters + dismiss state. Called on app launch
    /// (implicitly — new instance) and on active-repo switch.
    func reset() {
        counts.removeAll()
        dismissed.removeAll()
    }

    // MARK: - Normalisation

    /// Lowercase, collapse whitespace runs, strip trailing
    /// punctuation. Keeps the bucket forgiving without being
    /// aggressive — "fix the auth bug" and "Fix the auth bug." land
    /// together, but "explain auth" and "explain the auth flow"
    /// stay separate.
    private func normalise(_ s: String) -> String {
        let lower = s.lowercased()
        // Collapse all whitespace (incl. newlines/tabs) into single spaces.
        let parts = lower.split(whereSeparator: { $0.isWhitespace })
        let collapsed = parts.joined(separator: " ")
        // Strip trailing punctuation (., !, ?, …, etc).
        let trimmed = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: " .!?…,;:"))
        return trimmed
    }
}
```

- [ ] **Step 3: Run tests, expect 5/5 PASS**

```
swift test --filter CodeAssistantSessionTests
```

- [ ] **Step 4: Commit**

```
git add mac/Sources/LlmIdeMac/Services/CodeAssistantSession.swift mac/Tests/LlmIdeMacTests/CodeAssistantSessionTests.swift
git commit -m "feat(memory): CodeAssistantSession — session-scoped repeated-prompt counter"
```

---

## Task 4: Wire banner into `CodeAssistantPanel`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`

- [ ] **Step 1: Own the session object**

Near the existing `@State`/`@StateObject` declarations (around line 48), add:

```swift
    @StateObject private var session = CodeAssistantSession()
    /// Captured at the moment the banner appears so Save uses the
    /// prompt+answer that triggered the threshold, not whatever the
    /// user types next.
    @State private var nudgePrompt: String?
    @State private var savingQA = false
    @State private var qaSaveError: String?
```

- [ ] **Step 2: Record in `send()`**

In `send()` (around line 1096), after `let msg = draft.trimmingCharacters…` and the empty-guard, BEFORE `history.append`, add:

```swift
        _ = session.record(prompt: msg)
        if session.shouldNudge(for: msg) {
            nudgePrompt = msg
        }
```

- [ ] **Step 3: Reset on active-repo switch**

Find the existing `.onChange(of: config.activeCLI)` modifier (around line 158) and add a sibling for the active project. Use whichever single identifier captures both GitLab + GitHub. Inside `CodeAssistantPanel`, add a computed:

```swift
    /// Single identifier for "which repo is active right now". When
    /// it changes we wipe the session counters so a switch doesn't
    /// carry stale repeats across repos.
    private var activeRepoKey: String {
        if let p = config.gitLabSavedProjects.first(where: { $0.isActive }) { return "gl:\(p.id)" }
        if let r = config.gitHubSavedRepos.first(where: { $0.isActive }) { return "gh:\(r.id)" }
        return "none"
    }
```

Add the modifier next to the existing `onChange` chain:

```swift
        .onChange(of: activeRepoKey) { _, _ in
            session.reset()
            nudgePrompt = nil
        }
```

NOTE: Confirm `SavedGitLabProject.id` and `SavedGitHubRepo.id` both exist (read the model files). If a model uses a different identifier (e.g. `projectId`, `name`, `url`), substitute it.

- [ ] **Step 4: Render the banner above the composer**

The composer lives in `inputBar`. Find where `inputBar` is composed into the body — search for `inputBar` and add the banner just ABOVE it. The chat scroll view ends; then a `nudgeBanner` view; then `inputBar`.

Add to the body where the input bar is referenced:

```swift
            if let prompt = nudgePrompt, activeRepoRoot != nil {
                nudgeBanner(prompt: prompt)
            }
```

Then add the banner helper:

```swift
    @ViewBuilder
    private func nudgeBanner(prompt: String) -> some View {
        let t = theme.current
        let count = session.count(for: session.hashForPrompt(prompt))
        HStack(spacing: Spacing.sm) {
            Image(systemName: "sparkles")
                .foregroundStyle(t.accent2)
            Text("You've asked this \(count) times — save the answer to memory?")
                .font(Typography.caption).foregroundStyle(t.text)
                .lineLimit(2).truncationMode(.tail)
            Spacer(minLength: 8)
            if let err = qaSaveError {
                Text(err).font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(1).truncationMode(.tail)
            }
            Button(savingQA ? "Saving…" : "Save") {
                Task { await saveLatestAnswer(forPrompt: prompt) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(savingQA)
            Button("Dismiss") {
                session.dismiss(hash: session.hashForPrompt(prompt))
                nudgePrompt = nil
                qaSaveError = nil
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(savingQA)
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, 6)
        .background(t.accent2.opacity(0.08))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .top)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .bottom)
    }

    /// Find the most recent assistant turn that followed `prompt` and
    /// write it as a QAEntry. Falls back to the last assistant turn
    /// in history when no exact prompt match is found.
    private func saveLatestAnswer(forPrompt prompt: String) async {
        guard let repoRoot = activeRepoRoot else {
            qaSaveError = "No active repo."
            return
        }
        savingQA = true
        qaSaveError = nil
        defer { savingQA = false }
        let answer = mostRecentAnswer(forPrompt: prompt) ?? ""
        guard !answer.isEmpty else {
            qaSaveError = "No agent answer found yet."
            return
        }
        let entry = QAEntry(
            question: prompt,
            answer: answer,
            savedAt: Date(),
            askCount: session.count(for: session.hashForPrompt(prompt)),
            agent: config.activeCLI
        )
        let store = MemoryStore()
        do {
            _ = try store.writeQA(at: repoRoot, entry)
            // Dismiss so the banner doesn't reappear for this hash.
            session.dismiss(hash: session.hashForPrompt(prompt))
            nudgePrompt = nil
        } catch {
            qaSaveError = "Couldn't save: \(error.localizedDescription)"
        }
    }

    /// Walk the history in reverse, find the most recent assistant
    /// turn that follows a user turn whose content matches `prompt`.
    /// Best-effort — exact-match on the user content. If nothing
    /// matches, return the last assistant turn (the spec says "the
    /// most recent agent response").
    private func mostRecentAnswer(forPrompt prompt: String) -> String? {
        for i in stride(from: history.count - 1, through: 0, by: -1) {
            let t = history[i]
            if t.role == .assistant {
                // Look one step back — was the preceding user turn this prompt?
                if i > 0 && history[i - 1].role == .user && history[i - 1].content == prompt {
                    return t.content
                }
            }
        }
        return history.last(where: { $0.role == .assistant })?.content
    }
```

- [ ] **Step 5: Build**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 6: Commit**

```
git add mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift
git commit -m "feat(memory): repeated-prompt banner in CodeAssistant composer

Phase C.4. CodeAssistantSession tracks repeats per session; at
threshold 3 a non-blocking banner offers Save (writes Q&A to
graphify-out/memory/q&a) or Dismiss (silences for the rest of
the session). Counters reset on active-repo switch."
```

---

## Task 5: Verification + smoke test

- [ ] **Step 1: Targeted tests**

```
swift test --filter "QAEntryTests|CodeAssistantSessionTests|MemoryStoreTests|MemoryStoreWritesTests|BugReportTests"
```

Expected: all pass.

- [ ] **Step 2: Full suite — only the two pre-existing failures**

```
swift test 2>&1 | grep -cE "✘ Test "
```

Expected: `2`.

- [ ] **Step 3: Manual smoke**

```
./build_app.sh && pkill -f LlmIdeMac.app; sleep 1; open -n LlmIdeMac.app
```

1. Pick a repo as Active.
2. Open Code Assistant.
3. Send the same prompt 3 times (use the resend / re-type).
4. After the 3rd send, banner appears above the composer: "You've asked this 3 times — save the answer to memory? [Save] [Dismiss]".
5. Hit **Save** → banner disappears; Graphify → Memory tab → new file under Q&A section with the prompt slug.
6. Send the same prompt again — banner does NOT reappear (dismissed).
7. Send a different prompt 3 times — banner reappears for that prompt.
8. Switch active project → counters reset; threshold has to be reached again.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Normalise + SHA-256 hash of prompt | Task 3 (`hashForPrompt`, `normalise`) |
| Counter, threshold 3, session-scoped | Task 3 (`record`, `shouldNudge`) |
| Reset on app launch | Task 4 (fresh `@StateObject` per panel) |
| Reset on active-repo switch | Task 4 (Step 3 `onChange(of: activeRepoKey)`) |
| Banner above composer with Save / Dismiss | Task 4 (Step 4 `nudgeBanner`) |
| Save writes `q&a/<slug>.md` with required frontmatter | Task 1 (`toMarkdown`), Task 2 (`writeQA`) |
| Dismiss silences hash for session | Task 3 (`dismiss`), Task 4 (banner Dismiss) |

**Placeholder scan:** No TBD / TODO / vague handling. Every step is concrete.

**Type consistency:**
- `CodeAssistantSession.record` returns `String` (hash) → consumed by `dismiss(hash:)`.
- `QAEntry.suggestedFileName` → used by `MemoryStore.writeQA`.
- `BugReport.slugify` + `BugReport.isoFormatter` referenced from `QAEntry` — confirmed both are `static` and same-module.
- `activeRepoRoot` reuses the same computed added in Phase B (Task 4).

No spec gap.
