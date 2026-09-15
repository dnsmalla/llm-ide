# Chat Feature Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mac chat slice's Plan and Mode features editable without touching `ChatEngine.swift` / `CodeAssistantPanel*.swift` for every change — the five smallest refactors from the 2026-09-14 coupling audit, in order of size.

**Architecture:** Each task lifts one piece of cross-feature knowledge out of a hub file into a pure, `public`, lab-asserted policy type (or a single injectable value), then rewires the hub to call it. Nothing about runtime behaviour changes; every task is a pure move + rename verified by `swift build` and `chat-contract-lab`, with a NEW lab assertion written FIRST wherever the moved logic is a pure function.

**Tech Stack:** Swift 5.9 / SwiftUI (`@Observable`), SwiftPM, `chat-contract-lab` executable gate (this toolchain has NO XCTest — `swift test` cannot run; see `Makefile` `HAS_XCTEST`). Node `scripts/conformance-agent-v2.mjs` guards the wire.

**Spec:** `docs/superpowers/specs/2026-09-10-chat-linker-restructure-design.md` §4.1 (target Mac structure: `ChatEngineHooks`, `PlanExecutionTracker` in `Engine/`, `AgentV2Selection` policy-only). Audit evidence is in this session's coupling report (fan-out table, hot-spot list).

## Global Constraints

- Files ≤ 500 lines, classes ≤ 300 lines, functions ≤ 40 lines (GRID rule; `ChatEngine.swift` is 1,383 today — these tasks must not GROW it).
- A type asserted by `chat-contract-lab` MUST be `public` (separate target, no `@testable`).
- Verify every task with BOTH: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` AND `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab` (must print `all assertions passed`). Run `swift build --build-tests` too: it fails on `import XCTest` (expected) but any OTHER error in `mac/Tests/` is a real break.
- Commit per task, Conventional Commits with Japanese subject (`refactor(mac): …`), one concern per commit. Do NOT push mid-plan; push once at the end (the pre-push gate takes ~3 min).
- No behaviour change. If a step would change what the user sees, stop and ask.

---

### Task 1: One path for the resolved mode (`ModePolicy.pickerMode`)

Today the server-resolved mode reaches the picker by TWO routes: live `mode_set` → `AgentV2Transport.onModeResolved` (`ClaudeLink/AgentV2Transport.swift:346-347`) → `AgentV2Selection.onModeResolved` passthrough (`Chat/Transport/AgentV2Selection.swift:321-323`) → `ChatEngine.onResolvedMode` (`Chat/Engine/ChatEngine.swift:245,548,1212`) → panel closure (`Chat/Views/Panel/CodeAssistantPanel.swift:516-522`); AND the terminal `resp.mode` into `finishStreamingTurn`. The panel closure also holds the only copy of the "follow only when on Auto" rule. Keep BOTH sources (the live one is what makes the picker move mid-turn) but funnel them into ONE engine-owned state the panel observes, and lift the rule into a pure policy.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/Views/Panel/ModePolicy.swift`
- Modify: `mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift:245` (hook → state), `:548`, `:1212`
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel.swift:516-522`
- Test: `mac/Sources/ChatContractLab/main.swift` (append before the final `if failures.isEmpty`)

**Interfaces:**
- Produces: `public enum ModePolicy { public static func pickerMode(current: String, resolved: String) -> String? }` — returns the mode the picker should move to, or nil to leave it.
- Produces: `ChatEngine.resolvedMode: String?` (observable state, set from both sources).
- Task 2 adds `releasesStickyMode` to this same `ModePolicy`.

- [ ] **Step 1: Write the failing lab assertions**

Append to `mac/Sources/ChatContractLab/main.swift`, directly above `if failures.isEmpty {`:

```swift
// ModePolicy.pickerMode — the picker follows the mode the server resolved,
// but ONLY while it sits on Auto. A mode the user picked by hand is theirs;
// and Auto resolving to Auto is not a move.
do {
    expect(ModePolicy.pickerMode(current: "auto", resolved: "plan") == "plan",
           "on Auto, the picker follows the resolved mode")
    expect(ModePolicy.pickerMode(current: "auto", resolved: "auto") == nil,
           "Auto resolving to Auto is not a move")
    expect(ModePolicy.pickerMode(current: "execute", resolved: "plan") == nil,
           "a hand-picked mode is never overruled by the server")
    expect(ModePolicy.pickerMode(current: "auto", resolved: "not-a-mode") == nil,
           "an unknown wire value moves nothing")
}
```

- [ ] **Step 2: Run the lab to verify it fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | tail -5`
Expected: compile error `cannot find 'ModePolicy' in scope`.

- [ ] **Step 3: Create `ModePolicy.swift`**

```swift
import Foundation

/// Mode-picker rules the chat lifecycle applies, kept out of the views and
/// the engine so both can change without touching the other.
///
/// Keyed on the mode's raw string (the wire value, and what message metadata
/// stores) so the rules stay assertable from `chat-contract-lab` without
/// making the SwiftUI-facing `CodeAssistMode` public.
public enum ModePolicy {

    /// The one mode that re-decides per turn; the target of every release.
    public static let autoMode = "auto"

    /// Wire values `CodeAssistMode` knows. Mirrors its `rawValue`s; an
    /// unknown server value must never move the picker.
    static let knownModes: Set<String> = [
        "auto", "plan", "assist_plan", "review", "document", "execute",
    ]

    /// Where the picker should move when the server resolves `resolved`
    /// for a turn, or nil to leave it. Only Auto ever follows: moving OFF
    /// Auto is the point (the user asked the picker to show what the agent
    /// is doing), and a mode picked by hand is not the server's to change.
    public static func pickerMode(current: String, resolved: String) -> String? {
        guard current == autoMode, resolved != autoMode, knownModes.contains(resolved) else { return nil }
        return resolved
    }
}
```

Check `knownModes` against `CodeAssistMode`'s cases in `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantModelState.swift:6-20` and copy the exact `rawValue`s (they are the server's mode names, e.g. `assist_plan`).

- [ ] **Step 4: Run the lab to verify the new assertions pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | tail -8`
Expected: the four new `ok` lines and `all assertions passed`.

- [ ] **Step 5: Replace the engine hook with engine state**

In `ChatEngine.swift`, replace the declaration at line 245 (and its doc comment above it, lines ~234-244) with:

```swift
    /// The mode the SERVER resolved for the current/last turn — live from the
    /// Agent engine's `mode_set` event (right after the agent starts) and
    /// again from every engine's turn result (the earliest the legacy stream
    /// can say). ONE state for both sources; the panel observes it and applies
    /// `ModePolicy.pickerMode`. Replaces the `onResolvedMode` hook, which
    /// carried the same value by a second route and had to be identity-guarded
    /// against a parked background engine flipping the displayed chat's picker
    /// — observing THIS engine's state has no such problem.
    var resolvedMode: String?
```

At line 548 replace `self?.onResolvedMode(mode)` with `self?.resolvedMode = mode`.
At line 1212 replace `onResolvedMode(resolved.rawValue)` with `resolvedMode = resolved.rawValue`.

- [ ] **Step 6: Rewire the panel to observe instead of being called**

In `CodeAssistantPanel.swift` delete the `engine.onResolvedMode = { raw in … }` block (lines 509-522 including its comment). Find the view that owns the engine binding (the `body`/root `View` in the same file — search `.onChange(of:`) and add next to the existing `.onChange` modifiers:

```swift
        .onChange(of: engine.resolvedMode) { _, raw in
            guard let raw,
                  let next = ModePolicy.pickerMode(current: modelState.selectedMode.rawValue, resolved: raw),
                  let mode = CodeAssistMode(rawValue: next)
            else { return }
            modelState.selectedMode = mode
        }
```

- [ ] **Step 7: Build, lab, test-target compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | grep -E "error|Build complete"`
Expected: `Build complete!`
Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | tail -1`
Expected: `chat-contract-lab: all assertions passed`
Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests 2>&1 | grep error: | grep -v "no such module 'XCTest'"`
Expected: no output. If `mac/Tests` references `onResolvedMode` (grep first: `grep -rn onResolvedMode mac/Tests`), replace each with reading `engine.resolvedMode`.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/Views/Panel/ModePolicy.swift mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel.swift mac/Sources/ChatContractLab/main.swift
git commit -m "refactor(mac): 解決モードの伝達を engine の状態 1 本に統一する"
```

---

### Task 2: Sticky-mode policy moves next to its rule (`ModePolicy.releasesStickyMode`)

`AgentV2Selection.releasesStickyMode` / `autoMode` (`Chat/Transport/AgentV2Selection.swift:189-217`) is UI policy living in the transport-selection file — the spec says `AgentV2Selection` should be "policy only" about ENGINE selection. The four call sites each spell the release set as a literal (`CodeAssistantPanel.swift:542`, `CodeAssistant+PlanExecution.swift:36,140`, `CodeAssistant+Plan.swift:422` default), so adding a stage means editing four files.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/ModePolicy.swift` (from Task 1)
- Modify: `mac/Sources/LlmIdeMac/Chat/Transport/AgentV2Selection.swift:189-217` (delete)
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistant+Plan.swift:414-428`
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel.swift:542`
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistant+PlanExecution.swift:36,140`
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/PlanRequestPolicy.swift` (doc comment mentions `releaseStickyMode` — leave; it names the panel method, which stays)
- Test: `mac/Sources/ChatContractLab/main.swift:365-392, 912-924` (retarget existing assertions)

**Interfaces:**
- Produces: `ModePolicy.releasesStickyMode(current: String, releasing: Set<String>) -> Bool` (same semantics), plus named sets `ModePolicy.planStages`, `.runStages`, `.runAndReviewStages`, `.reviewStage`.
- Consumes: Task 1's `ModePolicy.autoMode`.

- [ ] **Step 1: Retarget the lab assertions (they become the failing test)**

In `main.swift`, in the two blocks at ~365-392 and ~912-924, replace every `AgentV2Selection.releasesStickyMode` with `ModePolicy.releasesStickyMode`, `AgentV2Selection.autoMode` with `ModePolicy.autoMode`, and replace the local literals with the named sets:
`let planStages: Set<String> = ["plan", "assist_plan"]` → `let planStages = ModePolicy.planStages`;
`let runStages: Set<String> = ["execute", "plan", "assist_plan"]` → `let runStages = ModePolicy.runStages`;
`let runStagesNow: Set<String> = [...]` → `let runStagesNow = ModePolicy.runStages`.
Then add, inside the first block:

```swift
    expect(ModePolicy.runAndReviewStages == ModePolicy.runStages.union(ModePolicy.reviewStage),
           "dismissing a finished run releases the run's modes AND Code Review — one set, built from the others")
    expect(ModePolicy.reviewStage == ["review"],
           "releasing a review takes back Code Review only")
```

- [ ] **Step 2: Run the lab to verify it fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | tail -3`
Expected: compile error `type 'ModePolicy' has no member 'releasesStickyMode'`.

- [ ] **Step 3: Move the rule and add the named sets**

Cut lines 189-217 of `AgentV2Selection.swift` (the `releasesStickyMode` doc comment + function, and `autoMode`). Add to `ModePolicy`:

```swift
    // Release sets, named once. Each caller says WHICH lifecycle moment it
    // is instead of spelling the modes — adding a stage is one edit here.

    /// Saving a plan ends the planning stages.
    public static let planStages: Set<String> = ["plan", "assist_plan"]
    /// A finished run set one of these.
    public static let runStages: Set<String> = ["execute", "plan", "assist_plan"]
    /// Dismissing a finished plan card: the run's modes plus the Code Review
    /// its finish card's Review button puts the picker into.
    public static let runAndReviewStages: Set<String> = runStages.union(reviewStage)
    /// A review turn (normal end, stop, cancel or failure) set only this.
    public static let reviewStage: Set<String> = ["review"]

    /// Whether a sticky mode should be handed back to Auto now that the work
    /// that set it is finished. Releases only a mode the FLOW set: a user who
    /// deliberately picked something outside `releasing` keeps it — this
    /// undoes stickiness, it never overrules a choice. (Full rationale was the
    /// doc comment on `AgentV2Selection.releasesStickyMode`, now here.)
    public static func releasesStickyMode(current: String, releasing: Set<String>) -> Bool {
        current != autoMode && releasing.contains(current)
    }
```

Move the original 20-line rationale comment along with it (the "The picker follows the mode … nobody does" paragraphs) — it explains WHY, keep it verbatim.

- [ ] **Step 4: Rewire the four call sites**

`CodeAssistant+Plan.swift:422-428` becomes:

```swift
    @MainActor
    func releaseStickyMode(from stages: Set<String> = ModePolicy.planStages) {
        guard ModePolicy.releasesStickyMode(
            current: modelState.selectedMode.rawValue,
            releasing: stages)
        else { return }
        modelState.selectedMode = .auto
    }
```

`CodeAssistantPanel.swift:542`: `releaseStickyMode(from: [.execute, .plan, .assistPlan])` → `releaseStickyMode(from: ModePolicy.runStages)`.
`CodeAssistant+PlanExecution.swift:36`: `releaseStickyMode(from: [.execute, .plan, .assistPlan, .review])` → `releaseStickyMode(from: ModePolicy.runAndReviewStages)`.
`CodeAssistant+PlanExecution.swift:140`: `releaseStickyMode(from: [.review])` → `releaseStickyMode(from: ModePolicy.reviewStage)`.
`grep -rn "AgentV2Selection.autoMode\|AgentV2Selection.releasesStickyMode" mac/` must now return nothing (fix any stragglers the same way).

- [ ] **Step 5: Build, lab, test-target compile**

Same three commands as Task 1 Step 7. Expected: build complete, `all assertions passed`, no non-XCTest test errors.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/Views/Panel/ModePolicy.swift mac/Sources/LlmIdeMac/Chat/Transport/AgentV2Selection.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistant+Plan.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistant+PlanExecution.swift mac/Sources/ChatContractLab/main.swift
git commit -m "refactor(mac): sticky モードの解放規則を ModePolicy に移し、解放セットに名前を付ける"
```

---

### Task 3: Post-turn landing becomes one pure decision (`PlanTurnLanding`)

`CodeAssistantPanel+Session.swift:358-393` is three same-shaped `if pendingTool == nil, …` blocks deciding, after every turn, whether to (a) save an update-turn reply as the plan, (b) fire a plan rewrite after a review fix, (c) land a review verdict. The inputs are all metadata already on the last two messages. A fourth plan-side action would be a fourth block in a file about SESSIONS.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/Views/Panel/PlanTurnLanding.swift`
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel+Session.swift:358-393`
- Test: `mac/Sources/ChatContractLab/main.swift` (append)

**Interfaces:**
- Produces:
  ```swift
  public enum PlanTurnLanding {
      public enum Action: Equatable, Sendable { case savePlanReply, updatePlanAfterFix, landReview }
      public struct Turn: Equatable, Sendable {
          public let pendingToolParked: Bool
          public let lastUserIsPlanUpdate: Bool
          public let lastUserIsPlanReview: Bool
          public let replyDone: Bool
          public let replyAlreadySaved: Bool
          public let replyLooksLikePlan: Bool
          public let turnChangedCode: Bool
          public let reviewVerdict: PlanReviewVerdict?
          public let hasPlanFile: Bool
          public init(...)  // memberwise, all labelled
      }
      public static func actions(for turn: Turn) -> [Action]
  }
  ```
- Consumes: `PlanReviewPolicy.updatesPlanAfterFix(verdict:turnChangedCode:isPlanUpdateTurn:hasPlanFile:)` (`PlanTranscriptPolicy.swift:290`), `PlanReviewVerdict` (`:119`).

- [ ] **Step 1: Write the failing lab assertions**

Append above `if failures.isEmpty {`:

```swift
// PlanTurnLanding — what a finished turn does to the chat's plan file, decided
// in one place from the last two messages. Order matters: a review landing
// never also rewrites the plan.
do {
    func turn(parked: Bool = false, update: Bool = false, review: Bool = false, done: Bool = true,
              saved: Bool = false, looksLikePlan: Bool = true, changedCode: Bool = false,
              verdict: PlanReviewVerdict? = nil, hasPlan: Bool = true) -> PlanTurnLanding.Turn {
        .init(pendingToolParked: parked, lastUserIsPlanUpdate: update, lastUserIsPlanReview: review,
              replyDone: done, replyAlreadySaved: saved, replyLooksLikePlan: looksLikePlan,
              turnChangedCode: changedCode, reviewVerdict: verdict, hasPlanFile: hasPlan)
    }
    expect(PlanTurnLanding.actions(for: turn(update: true)) == [.savePlanReply],
           "the reply to an update turn IS the rewritten plan — save it")
    expect(PlanTurnLanding.actions(for: turn(update: true, looksLikePlan: false)) == [],
           "an update turn that answered with a question leaves the old plan alone")
    expect(PlanTurnLanding.actions(for: turn(update: true, saved: true)) == [],
           "an already-saved reply is not saved twice")
    expect(PlanTurnLanding.actions(for: turn(changedCode: true, verdict: .changesRequested)) == [.updatePlanAfterFix],
           "review asked for changes and this turn edited a file — rewrite the plan")
    expect(PlanTurnLanding.actions(for: turn(update: true, changedCode: true, verdict: .changesRequested)) == [.savePlanReply],
           "the update turn itself never triggers another update — that is the loop")
    expect(PlanTurnLanding.actions(for: turn(changedCode: true, verdict: .changesRequested, hasPlan: false)) == [],
           "with no plan file there is nothing to update — this never CREATES one")
    expect(PlanTurnLanding.actions(for: turn(review: true)) == [.landReview],
           "the Review button's turn lands its verdict")
    expect(PlanTurnLanding.actions(for: turn(review: true, done: false)) == [.landReview],
           "a review lands even when the reply is not marked done (stopped review still releases the card)")
    expect(PlanTurnLanding.actions(for: turn(parked: true, update: true)) == [],
           "a parked proposal defers every landing to the answer")
}
```

- [ ] **Step 2: Run the lab to verify it fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | tail -3`
Expected: compile error `cannot find 'PlanTurnLanding' in scope`.

- [ ] **Step 3: Create `PlanTurnLanding.swift`**

```swift
import Foundation

/// What a finished turn does to the chat's saved plan, decided from the last
/// two messages in ONE place. `CodeAssistantPanel+Session` used to hold this
/// as three same-shaped `if` blocks; every new plan-side landing meant a fourth
/// block in a file about sessions. Now a landing is a case here and one
/// `switch` arm there.
///
/// Public because `chat-contract-lab` asserts it.
public enum PlanTurnLanding {

    public enum Action: Equatable, Sendable {
        /// The reply to an update turn IS the rewritten document: save it.
        case savePlanReply
        /// Review asked for changes and this turn edited code: rewrite the plan.
        case updatePlanAfterFix
        /// The Review button's turn finished: its reply is the verdict.
        case landReview
    }

    /// The facts a landing is decided from — all read off the transcript's
    /// last user and assistant messages and the tracker.
    public struct Turn: Equatable, Sendable {
        public let pendingToolParked: Bool
        public let lastUserIsPlanUpdate: Bool
        public let lastUserIsPlanReview: Bool
        public let replyDone: Bool
        public let replyAlreadySaved: Bool
        public let replyLooksLikePlan: Bool
        public let turnChangedCode: Bool
        public let reviewVerdict: PlanReviewVerdict?
        public let hasPlanFile: Bool

        public init(pendingToolParked: Bool, lastUserIsPlanUpdate: Bool, lastUserIsPlanReview: Bool,
                    replyDone: Bool, replyAlreadySaved: Bool, replyLooksLikePlan: Bool,
                    turnChangedCode: Bool, reviewVerdict: PlanReviewVerdict?, hasPlanFile: Bool) {
            self.pendingToolParked = pendingToolParked
            self.lastUserIsPlanUpdate = lastUserIsPlanUpdate
            self.lastUserIsPlanReview = lastUserIsPlanReview
            self.replyDone = replyDone
            self.replyAlreadySaved = replyAlreadySaved
            self.replyLooksLikePlan = replyLooksLikePlan
            self.turnChangedCode = turnChangedCode
            self.reviewVerdict = reviewVerdict
            self.hasPlanFile = hasPlanFile
        }
    }

    /// Actions in the order the panel must perform them. A parked proposal
    /// defers everything: the answer's own turn will land.
    public static func actions(for turn: Turn) -> [Action] {
        guard !turn.pendingToolParked else { return [] }
        var out: [Action] = []
        if turn.lastUserIsPlanUpdate, turn.replyDone, !turn.replyAlreadySaved, turn.replyLooksLikePlan {
            out.append(.savePlanReply)
        }
        if turn.replyDone,
           PlanReviewPolicy.updatesPlanAfterFix(verdict: turn.reviewVerdict,
                                               turnChangedCode: turn.turnChangedCode,
                                               isPlanUpdateTurn: turn.lastUserIsPlanUpdate,
                                               hasPlanFile: turn.hasPlanFile) {
            out.append(.updatePlanAfterFix)
        }
        if turn.lastUserIsPlanReview {
            out.append(.landReview)
        }
        return out
    }
}
```

- [ ] **Step 4: Run the lab to verify the new assertions pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | grep -E "FAIL|all assertions"`
Expected: `all assertions passed`. If the "review lands even when not done" assertion fails, check the ORIGINAL third block at `+Session.swift:384-393`: it has no `reply.status == .done` guard — the policy above mirrors that; fix the test's expectation only if the original code disagrees.

- [ ] **Step 5: Replace the three blocks with one switch**

In `CodeAssistantPanel+Session.swift`, replace lines 358-393 (the three `if pendingTool == nil,` blocks; keep the long explanatory comment above them, it still applies) with:

```swift
        let lastUser = engine.messages.last(where: { $0.role == .user })
        let reply = engine.messages.last(where: { $0.role == .assistant })
        let landing = PlanTurnLanding.Turn(
            pendingToolParked: pendingTool != nil,
            lastUserIsPlanUpdate: lastUser?.metadata?.planUpdateDisplay != nil,
            lastUserIsPlanReview: lastUser?.metadata?.planReviewDisplay != nil,
            replyDone: reply?.status == .done,
            replyAlreadySaved: reply?.metadata?.planSaved == true,
            replyLooksLikePlan: reply.map { PlanEditPolicy.looksLikePlan(content: $0.content) } ?? false,
            turnChangedCode: reply?.toolSteps.contains { PlanReviewPolicy.isCodeChangingTool($0.tool ?? "") } ?? false,
            reviewVerdict: engine.agent.planExecution?.reviewVerdict,
            hasPlanFile: sessionPlanPath != nil)
        for action in PlanTurnLanding.actions(for: landing) {
            switch action {
            case .savePlanReply:
                if let reply { await savePlanFromMessage(reply) }
            case .updatePlanAfterFix:
                updatePlanAfterReviewFix()
            case .landReview:
                if let reply { landPlanReview(reply: reply) }
            }
        }
```

- [ ] **Step 6: Build, lab, test-target compile**

Same three commands as Task 1 Step 7.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/Views/Panel/PlanTurnLanding.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel+Session.swift mac/Sources/ChatContractLab/main.swift
git commit -m "refactor(mac): ターン終了後のプラン着地判定を PlanTurnLanding に一本化する"
```

---

### Task 4: `ChatEngineHooks` — 12 loose closures become one injectable value

`ChatEngine.swift:190-436` declares the panel-wired closures one by one (`onExternalApproval`, `resolveTransportInput`, `onPlanExecutionSettled`, `onPlanReviewReleased`, `onTurnStart`, `onRecordPrompt`, `onNudge`, `attachmentsForTurn`, `packHistory`, `autoChain`, `onHistoryReplaced`, `onResetActiveTurnExtra`, `onResetTransientStateExtra` — `onResolvedMode` is gone after Task 1). The panel assigns them at `CodeAssistantPanel.swift:516-548`. Adding a plan-side hook means editing `ChatEngine.swift`. Spec §4.1 prescribes one `ChatEngineHooks` value.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/Engine/ChatEngineHooks.swift`
- Modify: `mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift:190-436` (declarations), every `onX(` / `onX?(` call site in `Chat/Engine/*.swift` and `Chat/Session/*.swift`
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel.swift:516-548`
- Modify: any `mac/Tests/LlmIdeMacTests/Chat/*.swift` that assigns `engine.onX = …` (grep first)

**Interfaces:**
- Produces:
  ```swift
  @MainActor struct ChatEngineHooks {
      var onExternalApproval: ((AgentV2Approval) -> Void)? = nil
      var resolveTransportInput: /* copy the exact type from ChatEngine.swift:313-316 */
      var onPlanExecutionSettled: () -> Void = {}
      var onPlanReviewReleased: () -> Void = {}
      var onTurnStart: () -> Void = {}
      var onRecordPrompt: (String) -> Void = { _ in }
      var onNudge: (String) -> Void = { _ in }
      var attachmentsForTurn: () -> [LlmIdeAPIClient.CodeAttachment] = { [] }
      var packHistory: ([ChatMessage]) -> [LlmIdeAPIClient.CodeAssistTurn] = { $0.map { $0.wireTurn() } }
      var autoChain: ((PendingTool?, LlmIdeAPIClient.CodeAssistResponse.Usage?) async -> Void)? = nil
      var onHistoryReplaced: ([ChatMessage]) -> Void = { _ in }
      var onResetActiveTurnExtra: () -> Void = {}
      var onResetTransientStateExtra: () -> Void = {}
  }
  ```
  and `ChatEngine.hooks: ChatEngineHooks` (a `var`, default `ChatEngineHooks()`).
- Behavioural note: `packHistory`'s default in `ChatEngine.init` (see the comment at `CodeAssistantPanel.swift:549-551`, "defaults to engine.historyForRequest in ChatEngine.init") must be preserved — keep that assignment, now as `hooks.packHistory = …`.

- [ ] **Step 1: Inventory (this is the test — a pure move has no new behaviour to assert)**

Run and SAVE the output, it is your checklist:
```bash
grep -n "^    var on[A-Za-z]*\|^    var attachmentsForTurn\|^    var packHistory\|^    var resolveTransportInput\|^    var autoChain" mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift
grep -rn "engine\.\(on[A-Z][A-Za-z]*\|attachmentsForTurn\|packHistory\|resolveTransportInput\|autoChain\) *=" mac/Sources mac/Tests
grep -rn "\bon[A-Z][A-Za-z]*\(?\)\?(" mac/Sources/LlmIdeMac/Chat/Engine mac/Sources/LlmIdeMac/Chat/Session | grep -v "^.*//"
```
Expected: 13 declarations; ~15 assignment sites (panel + tests); ~25 call sites.

- [ ] **Step 2: Create `ChatEngineHooks.swift`**

Move each declaration's doc comment WITH it (they explain why the hook exists — several cite past regressions). Use the exact closure types from `ChatEngine.swift` (copy-paste, do not retype `resolveTransportInput`'s multi-line type).

- [ ] **Step 3: Replace the declarations in `ChatEngine.swift`**

Delete the 13 declarations (lines 190-436, keeping any non-hook state that sits between them — read the range first; `continueDelayNanos`, `maxAutoContinueRounds`, `autoContinueRounds`, `nextTurnIsAutoContinue`, `currentTurnAttachments` etc. are NOT hooks and stay). Add in their place:

```swift
    /// Every panel-wired collaborator, as one value. Assign the whole struct
    /// once (`adoptEngine`) or mutate a member; a new plan-side hook is a new
    /// field in `ChatEngineHooks`, not an edit to this file.
    var hooks = ChatEngineHooks()
```

Then mechanically rewrite every call site from Step 1: `onTurnStart()` → `hooks.onTurnStart()`, `autoChain?(…)` → `hooks.autoChain?(…)`, `packHistory(messages)` → `hooks.packHistory(messages)`, etc. `ChatEngine.init`'s `packHistory = …` becomes `hooks.packHistory = …`.

- [ ] **Step 4: Rewire the panel and tests**

`CodeAssistantPanel.swift:516-548`: each `engine.onX = { … }` → `engine.hooks.onX = { … }` (the closures' bodies do not change). Same in every `mac/Tests` file the inventory found.

- [ ] **Step 5: Build, lab, test-target compile**

Same three commands as Task 1 Step 7. `wc -l mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift` must be ≥ 150 lines smaller than before (report the number in the commit body).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/Engine/ChatEngineHooks.swift mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel.swift mac/Tests/LlmIdeMacTests/Chat
git commit -m "refactor(mac): ChatEngine のパネル連携クロージャ 13 個を ChatEngineHooks に束ねる"
```

---

### Task 5: `PlanExecutionTracker` moves to `Engine/` and settles itself

The tracker (`Views/Panel/CodeAssistantAgentState.swift:29-78`, nested `struct PlanExecutionTracker`) is a state machine the ENGINE drives: `ChatEngine.swift` writes `phase`/`reviewPhase` in four places (the `stopped` branch ~1244-1258, the auto-continue cap branch, `applyLiveTasks` ~1374, `updatePlanExecution` ~1383-1414). That is Engine → Views dependency, and the two transition rules live as inline `if`s. Spec §4.1 puts the tracker in `Engine/`. Referenced from 5 files (`ChatMessageList.swift`, `CodeAssistant+PlanExecution.swift`, `CodeAssistantAgentState.swift`, `PlanExecutionCard.swift`, `mac/Tests/.../ChatEngineTurnTests.swift`).

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/Engine/PlanExecutionTracker.swift`
- Modify: `mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantAgentState.swift:29-78` (delete nested struct; `var planExecution: PlanExecutionTracker?` stays)
- Modify: `mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift` (the four sites)
- Modify: `CodeAssistantAgentState.PlanExecutionTracker` qualified references (5 — `grep -rn "CodeAssistantAgentState\.PlanExecutionTracker" mac/`) → `PlanExecutionTracker`
- Test: `mac/Sources/ChatContractLab/main.swift` (append)

**Interfaces:**
- Produces: top-level `public struct PlanExecutionTracker: Equatable` with the SAME stored properties and nested enums as today, plus:
  ```swift
  /// A turn ended without the chain continuing (Stop, error, auto-continue
  /// ceiling). Returns true when this settled a running tracker.
  public mutating func settleInterrupted() -> Bool
  /// Live task list mid-turn; only a running tracker records it.
  public mutating func noteLiveTasks(_ tasks: [AgentTask])
  /// Terminal task list for a turn. Returns true when the run is genuinely
  /// over and the mode picker may be released.
  public mutating func apply(tasks: [AgentTask], continueNeeded: Bool?, pendingToolParked: Bool) -> Bool
  /// A review turn ended without landing. Returns true when it was running.
  public mutating func releaseInterruptedReview() -> Bool
  ```
- `AgentTask`/`AgentTask.Status` must be `public` (check `grep -rn "struct AgentTask" mac/Sources`); if not, make the struct and `status`/`id`/`title` public — the lab needs to construct them.

- [ ] **Step 1: Write the failing lab assertions**

Append above `if failures.isEmpty {`:

```swift
// PlanExecutionTracker — the plan-run state machine the engine drives. Its two
// transition rules used to be inline `if`s in ChatEngine.finishStreamingTurn.
do {
    func tracker() -> PlanExecutionTracker {
        PlanExecutionTracker(planTitle: "t", steps: ["a", "b"], planCardMessageId: UUID())
    }
    func task(_ status: AgentTask.Status) -> AgentTask {
        AgentTask(id: UUID().uuidString, title: "x", status: status)
    }
    var t = tracker()
    expect(t.settleInterrupted() && t.phase == .failed,
           "a Stop mid-run lands on .failed — the phase whose card carries Dismiss")
    expect(!t.settleInterrupted(),
           "settling an already-settled tracker is a no-op")

    t = tracker()
    expect(!t.apply(tasks: [task(.pending)], continueNeeded: true, pendingToolParked: false) && t.phase == .running,
           "pending tasks with the chain continuing keep the run open")
    expect(t.apply(tasks: [task(.done)], continueNeeded: false, pendingToolParked: false) && t.phase == .finished,
           "all tasks done and the chain ended: finished, release the picker")

    t = tracker()
    expect(t.apply(tasks: [task(.failed)], continueNeeded: true, pendingToolParked: false) == false && t.phase == .failed,
           "a failed task settles the tracker even mid-chain, but does NOT release while the chain continues")

    t = tracker()
    expect(!t.apply(tasks: [], continueNeeded: nil, pendingToolParked: false) && t.phase == .running,
           "an empty list with an external turn's nil carries no evidence — stay running")
    expect(!t.apply(tasks: [], continueNeeded: false, pendingToolParked: true) && t.phase == .running,
           "an empty list with a parked proposal is a card mid-plan, not the end")
    expect(t.apply(tasks: [], continueNeeded: false, pendingToolParked: false) && t.phase == .finished,
           "an empty list finishes only when the turn itself ended the chain")

    t = tracker()
    t.reviewPhase = .running
    expect(t.releaseInterruptedReview() && t.reviewPhase == .none,
           "a stopped review releases the finish card")
    expect(!t.releaseInterruptedReview(),
           "and nothing happens when no review was running")
}
```

Check `AgentTask`'s real initializer and `Status` case names (`grep -n "struct AgentTask" -A 15 -r mac/Sources`) and adjust `task(_:)` to match — the CASES used in `updatePlanExecution` are `.failed`, `.pending`, `.inProgress`; the "done" case may be named `.done` or `.completed`.

- [ ] **Step 2: Run the lab to verify it fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | tail -3`
Expected: compile error `cannot find 'PlanExecutionTracker' in scope` (or `AgentTask` not public).

- [ ] **Step 3: Create `Engine/PlanExecutionTracker.swift`**

Move the nested struct verbatim (all stored properties, `Phase`, `ReviewPhase`, `hasReviewed`, `totalSteps`, and every doc comment) to top level, mark `public struct PlanExecutionTracker: Equatable`, make the members the lab touches `public` (`init`, `phase`, `reviewPhase`, `steps`, `lastTasks`). Add a public memberwise-style init with the three required fields:

```swift
    public init(planTitle: String, steps: [String], planCardMessageId: UUID) {
        self.planTitle = planTitle
        self.steps = steps
        self.planCardMessageId = planCardMessageId
    }
```

Then add the four methods, lifting the bodies from `ChatEngine.swift` — the doc comments there ("A plan executed via direct tool calls … leaves `tasks` empty …") move with the logic:

```swift
    public mutating func settleInterrupted() -> Bool {
        guard phase == .running else { return false }
        phase = .failed
        return true
    }

    public mutating func noteLiveTasks(_ tasks: [AgentTask]) {
        guard phase == .running, !tasks.isEmpty else { return }
        lastTasks = tasks
    }

    public mutating func apply(tasks: [AgentTask], continueNeeded: Bool?, pendingToolParked: Bool) -> Bool {
        guard phase == .running else { return false }
        if !tasks.isEmpty { lastTasks = tasks }
        if tasks.contains(where: { $0.status == .failed }) {
            phase = .failed
        } else if !tasks.contains(where: { $0.status == .pending || $0.status == .inProgress }),
                  continueNeeded != true,
                  !tasks.isEmpty || (continueNeeded == false && !pendingToolParked) {
            phase = .finished
        }
        // Release only when the run is genuinely OVER — never while the chain
        // is about to send "Continue working…" (see ChatEngine.finishStreamingTurn).
        return phase != .running && continueNeeded != true
    }

    public mutating func releaseInterruptedReview() -> Bool {
        guard reviewPhase == .running else { return false }
        reviewPhase = .none
        return true
    }
```

- [ ] **Step 4: Run the lab to verify the new assertions pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab 2>&1 | grep -E "FAIL|all assertions"`
Expected: `all assertions passed`.

- [ ] **Step 5: Rewire `ChatEngine.swift` to the methods**

The `stopped` branch (~1244-1258) becomes:

```swift
            if var tracker = agent.planExecution, tracker.settleInterrupted() {
                agent.planExecution = tracker
                hooks.onPlanExecutionSettled()
            }
            if var tracker = agent.planExecution, tracker.releaseInterruptedReview() {
                agent.planExecution = tracker
                hooks.onPlanReviewReleased()
            }
```

The auto-continue cap branch (added 2026-09-14, `if var tracker = agent.planExecution, tracker.phase == .running { tracker.phase = .failed … }`) becomes the same first three lines. `applyLiveTasks` becomes:

```swift
    func applyLiveTasks(_ tasks: [AgentTask]) {
        guard !tasks.isEmpty else { return }
        agent.agentPendingTasks = tasks
        guard var tracker = agent.planExecution else { return }
        tracker.noteLiveTasks(tasks)
        agent.planExecution = tracker
    }
```

`updatePlanExecution` becomes:

```swift
    private func updatePlanExecution(with tasks: [AgentTask], continueNeeded: Bool?) {
        guard var tracker = agent.planExecution else { return }
        let release = tracker.apply(tasks: tasks, continueNeeded: continueNeeded,
                                    pendingToolParked: agent.pendingTool != nil)
        agent.planExecution = tracker
        if release { hooks.onPlanExecutionSettled() }
    }
```

(If Task 4 was not done first, use `onPlanExecutionSettled()` / `onPlanReviewReleased()` without the `hooks.` prefix.)

- [ ] **Step 6: Fix the qualified references**

`grep -rn "CodeAssistantAgentState\.PlanExecutionTracker" mac/` → replace each with `PlanExecutionTracker` (5 sites across `ChatMessageList.swift`, `CodeAssistant+PlanExecution.swift`, `PlanExecutionCard.swift`, `ChatEngineTurnTests.swift`). Delete the nested struct from `CodeAssistantAgentState.swift` (lines 29-78), keeping `var planExecution: PlanExecutionTracker?` and its comment.

- [ ] **Step 7: Build, lab, test-target compile**

Same three commands as Task 1 Step 7. Also `cd mac/LocalPackages/graph-kit && true` is NOT needed — no graph code is touched.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/Engine/PlanExecutionTracker.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantAgentState.swift mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/ChatMessageList.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistant+PlanExecution.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/PlanExecutionCard.swift mac/Tests/LlmIdeMacTests/Chat/ChatEngineTurnTests.swift mac/Sources/ChatContractLab/main.swift
git commit -m "refactor(mac): PlanExecutionTracker を Engine/ に移し、遷移規則を自身のメソッドにする"
```

---

### Task 6: Ship

- [ ] **Step 1: Full gate**

Run: `cd /Users/dinesh.malla/llm-ide && GIT_CONFIG_GLOBAL=/dev/null make regression 2>&1 | tail -15` (do NOT pipe through `| tail` when checking the exit code — memory: `tail` masks it; run `make regression; echo exit=$?` if in doubt).
Expected: mac build + chat-contract-lab + agent/v2 conformance + generation-contract-lab all pass; lite/min builds (`make build-mac-lite`, `make build-mac-min`) complete.

- [ ] **Step 2: Line counts vs. the audit**

Run: `wc -l mac/Sources/LlmIdeMac/Chat/Engine/ChatEngine.swift mac/Sources/LlmIdeMac/Chat/Views/Panel/CodeAssistantPanel+Session.swift mac/Sources/LlmIdeMac/Chat/Transport/AgentV2Selection.swift`
Expected: `ChatEngine.swift` below 1,200 (was 1,383); `+Session.swift` and `AgentV2Selection.swift` each smaller than before.

- [ ] **Step 3: Push once**

Run (foreground, NOT run_in_background — memory: a background push dies at SSH connect): `git push origin main` with a 600 s timeout, sandbox disabled (the sandbox blocks the SSH SOCKS connection).
Expected: last line `main -> main`.

## Self-review notes

- Spec coverage: §4.1 `ChatEngineHooks` → Task 4; `PlanExecutionTracker` in `Engine/` → Task 5; `AgentV2Selection` policy-only → Task 2 (Task 1 removes its `onModeResolved` passthrough's only consumer; the passthrough property itself can be deleted in Task 1 Step 5 if `grep -rn onModeResolved mac/` shows no other reader). `ChatTurnRunner` and `QuickChatSurface` are deliberately OUT (L-sized; audit rec #6).
- Type consistency: `ModePolicy.autoMode` (Task 1) is what Task 2's `releasesStickyMode` reads; `PlanReviewVerdict` is already `public` (`PlanTranscriptPolicy.swift:119`); `PlanTurnLanding` consumes `PlanReviewPolicy.updatesPlanAfterFix` with its existing labels; Task 5's `hooks.` prefix depends on Task 4 — the fallback is stated inline.
- Behaviour: every task is a move. The one place a reader might suspect a change — Task 3's `.landReview` without a `replyDone` guard — mirrors the original third block exactly (`+Session.swift:384-393` has no such guard).
