import Testing
import Foundation
@testable import LlmIdeMacLib

/// The classic engine's `ask-user` question card.
///
/// Before it existed that engine had no question tool and asked fixed-choice
/// questions in prose ("A, B or C?"), which the user had to answer by retyping
/// an option. It now arrives as a `pendingTool` the panel renders with the
/// Agent engine's own `ApprovalQuestionCard`.
@MainActor
@Suite("ask-user question card")
struct AskUserQuestionTests {
    private func tool(_ json: String, name: String = "ask-user") -> PendingTool {
        PendingTool(name: name, arguments: .init(raw: Data(json.utf8)))
    }

    @Test("A usable question decodes; options are trimmed, blanks dropped, capped at 6")
    func decodes() throws {
        let args = try #require(tool(#"{"question":"Which cache?","header":"Cache","options":[" SQLite (Recommended) ","","Memory","Disk"],"multiSelect":false}"#).askUserArgs)
        #expect(args.question == "Which cache?")
        #expect(args.options == ["SQLite (Recommended)", "Memory", "Disk"])
        #expect(args.header == "Cache")
        let many = try #require(tool(#"{"question":"q?","options":["1","2","3","4","5","6","7","8"]}"#).askUserArgs)
        #expect(many.options.count == 6)
    }

    @Test("Nothing to tap → no question card (falls back to the generic card)")
    func unusable() {
        #expect(tool(#"{"question":"q?","options":["only one"]}"#).askUserArgs == nil)
        #expect(tool(#"{"question":"  ","options":["a","b"]}"#).askUserArgs == nil)
        #expect(tool(#"{"options":["a","b"]}"#).askUserArgs == nil)
        #expect(tool(#"{"question":"q?","options":["a","b"]}"#, name: "save-plan").askUserArgs == nil)
        #expect(tool(#"{"question":"q?","options":["a","b"]}"#).kind == .askUser)
    }

    @Test("It maps onto the same card model the Agent engine's AskUserQuestion uses")
    func approvalShape() throws {
        let args = try #require(tool(#"{"question":"Pick?","header":"H","options":["a","b"],"multiSelect":true}"#).askUserArgs)
        let q = try #require(args.approval(requestId: "r").questions.first)
        #expect(q.question == "Pick?")
        #expect(q.header == "H")
        #expect(q.options.map(\.label) == ["a", "b"])
        #expect(q.multiSelect)
    }

    @Test("The recorded answer names the choice; multi-select survives labels with commas")
    func chosenAnswer() {
        let single = PendingTool.AskUserArgs(question: "Q?", options: ["Yes", "No"], header: nil, multiSelect: nil)
        #expect(CodeAssistantPanel.chosenAnswer(["Q?": "Yes"], for: single) == "\"Yes\"")
        #expect(CodeAssistantPanel.chosenAnswer([:], for: single) == "")
        let multi = PendingTool.AskUserArgs(question: "Q?", options: ["Tests, unit", "Docs", "Lint"],
                                            header: nil, multiSelect: true)
        // The card sorts labels and comma-joins them.
        #expect(CodeAssistantPanel.chosenAnswer(["Q?": "Docs,Tests, unit"], for: multi)
                == "\"Tests, unit\" and \"Docs\"")
    }

    @Test("Auto-continue never talks past a question the user has not answered")
    func noAutoContinuePastCard() async {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: t)
        engine.hooks.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "execute")
        }
        engine.continueDelayNanos = 1_000_000
        // Execute mode with tasks still pending: the server says continue —
        // but the turn ended on a question.
        t.result = .init(reply: "One thing first.",
                         pendingTool: tool(#"{"question":"Which DB?","options":["SQLite","Postgres"]}"#),
                         tasks: [AgentTask(id: "1", title: "wire it", status: .pending)],
                         continueNeeded: true, usage: nil, mode: nil, tokenUsage: nil)
        await engine.runTurn("add storage")
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(t.receivedInputs.count == 1, "no \"Continue working…\" round while the card waits")
        #expect(engine.agent.pendingTool?.kind == .askUser)
        #expect(!engine.agent.agentIsAutonomous)
    }
}
