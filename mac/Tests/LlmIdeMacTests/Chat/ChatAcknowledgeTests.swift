import Testing
import Foundation
@testable import LlmIdeMacLib

/// Task 10: the confirmers in `CodeAssistant+Bash/Git/Issues/PR.swift` and
/// `CodeAssistantPanel+Session.swift`/`+Edits.swift` no longer build a
/// synthetic ack STRING and hand it to `appendTurn` to be classified back
/// into a `ToolResultPayload` (`ChatMessage.migrate`); they build the typed
/// payload directly and call `ChatEngine.acknowledge(_:followUp:)`. This
/// suite pins that one new entry point: it appends exactly one `.toolResult`
/// message, and `followUp` (a `ChatEngine.FollowUp`, not a plain `Bool` — see
/// its cases' doc comments) controls whether and how a round-trip fires.
///
/// `.ifIdle` vs `.forceUnblock` is the exact distinction a code-review pass
/// caught missing from the first version of this method: routing every
/// confirmer through `unblockAndFollowUp()` unconditionally let a sheet
/// confirm force a SECOND concurrent round-trip while an autonomous turn was
/// still streaming. `acknowledgeIfIdleNoOpsWhenBusy` below pins the guard
/// that regression would have broken.
@MainActor
@Suite("ChatEngine.acknowledge")
struct ChatAcknowledgeTests {
    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        // Scope is irrelevant here — these tests never touch session files.
        let engine = ChatEngine(scope: .explorer, transport: t)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }
        return (engine, t)
    }

    @Test(".ifIdle appends exactly one .toolResult message and starts a follow-up turn when idle")
    func acknowledgeIfIdleStartsATurnWhenIdle() async {
        let (engine, t) = makeEngine()
        t.result = .init(reply: "Got it.", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        let payload = ChatMessage.ToolResultPayload(
            kind: .edit, summary: "applied update to a.swift: +3 lines",
            exitCode: nil, command: nil, output: nil, url: nil, isFailure: false
        )

        await engine.acknowledge(payload, followUp: .ifIdle)

        // Exactly one .toolResult message, carrying the payload verbatim.
        let toolResultMessages = engine.messages.filter { $0.role == .toolResult }
        #expect(toolResultMessages.count == 1)
        #expect(toolResultMessages[0].toolResult == payload)

        // ...plus the follow-up turn's assistant reply (sendFollowup's own
        // placeholder), so a follow-up really did fire — asserted through the
        // scripted transport's recorded input, per the brief.
        #expect(t.receivedInputs.last?.message == "(continue)")
        #expect(engine.messages.count == 2)
        #expect(engine.messages.last?.role == .assistant)
        #expect(engine.messages.last?.content == "Got it.")
    }

    @Test(".none appends the message and never invokes the transport")
    func acknowledgeNoneNeverCallsTransport() async {
        let (engine, t) = makeEngine()
        let payload = ChatMessage.ToolResultPayload(
            kind: .bash, summary: "(bash result - exit code: 0)",
            exitCode: 0, command: "npm test", output: "3 passing", url: nil, isFailure: false
        )

        await engine.acknowledge(payload, followUp: .none)

        #expect(engine.messages.count == 1)
        #expect(engine.messages[0].role == .toolResult)
        #expect(engine.messages[0].toolResult == payload)
        // The wire text the server would see, reconstructed losslessly.
        #expect(engine.messages[0].wireTurn().content == "(bash result - exit code: 0)\n$ npm test\n3 passing")
        #expect(t.receivedInputs.isEmpty)
        #expect(engine.busy == false)
    }

    @Test(".forceUnblock still fires even mid-turn (busy already true)")
    func acknowledgeForceUnblockFiresEvenWhenBusy() async {
        // Mirrors the Bypass-mode auto-chain path: `runBashCommand` /
        // `runGitOpFlow` / `confirmUpdateFile` / `skipPendingEdit` call
        // `acknowledge(..., followUp: .forceUnblock)` from INSIDE a turn that
        // already set `busy = true`. `.ifIdle` (plain `sendFollowup()`) would
        // no-op under its `!busy` guard; `.forceUnblock` routes through
        // `unblockAndFollowUp()` instead so the ack's follow-up isn't
        // silently dropped and `busy` isn't left stuck `true` forever.
        let (engine, t) = makeEngine()
        t.result = .init(reply: "done", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        engine.beginPanelRun()   // sets busy = true, as an in-flight turn would
        #expect(engine.busy == true)

        let payload = ChatMessage.ToolResultPayload(
            kind: .git, summary: "(git push result)",
            exitCode: nil, command: nil, output: "Everything up-to-date", url: nil, isFailure: false
        )
        await engine.acknowledge(payload, followUp: .forceUnblock)

        #expect(t.receivedInputs.last?.message == "(continue)")
        #expect(engine.messages.filter { $0.role == .toolResult }.count == 1)
        #expect(engine.messages.last?.content == "done")
    }

    @Test(".ifIdle appends the message but does NOT start a follow-up while busy — no second round-trip")
    func acknowledgeIfIdleNoOpsWhenBusy() async {
        // This is the sheet-confirmer policy: confirmCreateIssue /
        // confirmCommentIssue / confirmUpdateIssue / confirmPRCreation /
        // confirmBranchCreation all use `.ifIdle`, which must behave exactly
        // like the old plain `sendFollowup()` call they replaced — a no-op if
        // an autonomous turn is already mid-stream when the sheet confirms.
        // Getting this wrong (routing through `unblockAndFollowUp()`
        // unconditionally) would start a SECOND concurrent `/code-assist`
        // round-trip: two streaming placeholders racing `revealingTurnID`,
        // with `runTask` tracking only one so Stop can't cancel both.
        let (engine, t) = makeEngine()
        t.result = .init(reply: "should not appear", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        engine.beginPanelRun()   // sets busy = true, as a mid-stream turn would
        #expect(engine.busy == true)

        let payload = ChatMessage.ToolResultPayload(
            kind: .issue, summary: "(executed create-issue → #1 https://example.com/issues/1)",
            exitCode: nil, command: nil, output: nil, url: "https://example.com/issues/1", isFailure: false
        )
        await engine.acknowledge(payload, followUp: .ifIdle)

        // The ack itself still lands...
        #expect(engine.messages.count == 1)
        #expect(engine.messages[0].role == .toolResult)
        // ...but no round-trip was started, and busy is left exactly as this
        // caller set it — `.ifIdle` must not clear a busy flag it didn't set.
        #expect(t.receivedInputs.isEmpty)
        #expect(engine.busy == true)
    }
}
