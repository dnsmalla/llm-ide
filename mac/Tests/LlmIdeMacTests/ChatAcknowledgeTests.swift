import Testing
import Foundation
@testable import LlmIdeMacLib

/// Task 10: the confirmers in `CodeAssistant+Bash/Git/Issues/PR.swift` and
/// `CodeAssistantPanel+Session.swift`/`+Edits.swift` no longer build a
/// synthetic ack STRING and hand it to `appendTurn` to be classified back
/// into a `ToolResultPayload` (`ChatMessage.migrate`); they build the typed
/// payload directly and call `ChatEngine.acknowledge(_:followUp:)`. This
/// suite pins that one new entry point: it appends exactly one `.toolResult`
/// message, and `followUp` controls whether a round-trip fires at all.
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

    @Test("followUp: true appends exactly one .toolResult message and starts a follow-up turn")
    func acknowledgeWithFollowUpStartsATurn() async {
        let (engine, t) = makeEngine()
        t.result = .init(reply: "Got it.", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        let payload = ChatMessage.ToolResultPayload(
            kind: .edit, summary: "applied update to a.swift: +3 lines",
            exitCode: nil, command: nil, output: nil, url: nil, isFailure: false
        )

        await engine.acknowledge(payload, followUp: true)

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

    @Test("followUp: false appends the message and never invokes the transport")
    func acknowledgeWithoutFollowUpNeverCallsTransport() async {
        let (engine, t) = makeEngine()
        let payload = ChatMessage.ToolResultPayload(
            kind: .bash, summary: "(bash result - exit code: 0)",
            exitCode: 0, command: "npm test", output: "3 passing", url: nil, isFailure: false
        )

        await engine.acknowledge(payload, followUp: false)

        #expect(engine.messages.count == 1)
        #expect(engine.messages[0].role == .toolResult)
        #expect(engine.messages[0].toolResult == payload)
        // The wire text the server would see, reconstructed losslessly.
        #expect(engine.messages[0].wireTurn().content == "(bash result - exit code: 0)\n$ npm test\n3 passing")
        #expect(t.receivedInputs.isEmpty)
        #expect(engine.busy == false)
    }

    @Test("followUp: true still fires even mid-turn (busy already true)")
    func acknowledgeFollowUpFiresEvenWhenBusy() async {
        // Mirrors the Bypass-mode auto-chain path: `runBashCommand` /
        // `runGitOpFlow` can call `acknowledge(..., followUp: true)` from
        // INSIDE a turn that already set `busy = true`. A plain
        // `sendFollowup()` would no-op under its `!busy` guard; `acknowledge`
        // must route through `unblockAndFollowUp()` instead so the ack's
        // follow-up isn't silently dropped.
        let (engine, t) = makeEngine()
        t.result = .init(reply: "done", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        engine.beginPanelRun()   // sets busy = true, as an in-flight turn would
        #expect(engine.busy == true)

        let payload = ChatMessage.ToolResultPayload(
            kind: .git, summary: "(git push result)",
            exitCode: nil, command: nil, output: "Everything up-to-date", url: nil, isFailure: false
        )
        await engine.acknowledge(payload, followUp: true)

        #expect(t.receivedInputs.last?.message == "(continue)")
        #expect(engine.messages.filter { $0.role == .toolResult }.count == 1)
        #expect(engine.messages.last?.content == "done")
    }
}
