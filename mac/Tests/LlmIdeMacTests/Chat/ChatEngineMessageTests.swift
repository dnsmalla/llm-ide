import Foundation
import Testing
@testable import LlmIdeMacLib

/// Task 9's safety net: the engine now holds `[ChatMessage]`, so the two
/// things that used to be encoded in strings — a client-executed tool result
/// ("(bash result - exit code: 0)\n$ …") and a stopped reply
/// ("…\n\n_(stopped)_") — are typed state instead. The server contract is
/// UNCHANGED, which means every one of those strings has to come back out
/// byte-identical on the wire; that is what most of this suite pins.
///
/// The rest covers the two new per-message behaviours: a stop sets `.stopped`
/// without touching the streamed text, and a failed send leaves the
/// placeholder `.failed` with the reason attached (Task 16 hangs the retry
/// affordance off exactly that).
@MainActor
@Suite("ChatEngine on ChatMessage")
struct ChatEngineMessageTests {
    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: t)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }
        return (engine, t)
    }

    // MARK: - legacyContent() round trip

    /// Reads the RAW v1 turns straight out of a fixture's JSON, so the
    /// comparison below is against the literal bytes an old session file
    /// holds — not against a re-derived expectation that could drift with the
    /// code under test.
    private func originalV1Turns(_ raw: String) throws -> [(role: String, content: String)] {
        let obj = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        let history = try #require(obj?["history"] as? [[String: Any]])
        return history.map { (($0["role"] as? String) ?? "", ($0["content"] as? String) ?? "") }
    }

    /// Decode → migrate → `wireTurn()` must reproduce the original v1 text
    /// exactly, for EVERY fixture kind. This is the guarantee that the
    /// server's view of a conversation cannot drift when a user upgrades
    /// mid-session: the agent reads back the same tool-result and stopped-reply
    /// text it always did.
    @Test("Every v1 fixture round-trips byte-identically through migrate → wireTurn")
    func fixturesRoundTripByteExact() throws {
        let fixtures: [(String, String)] = [
            ("plain", ChatSessionV1Fixtures.plainTurns),
            ("acks", ChatSessionV1Fixtures.ackTurns),
            ("bash", ChatSessionV1Fixtures.bashTurns),
            ("stopped", ChatSessionV1Fixtures.stoppedTurn),
        ]
        for (name, raw) in fixtures {
            let session = try AppJSON.decoder.decode(ChatSession.self, from: Data(raw.utf8))
            let originals = try originalV1Turns(raw)
            #expect(session.messages.count == originals.count, "\(name): turn count")
            for (message, original) in zip(session.messages, originals) {
                let wire = message.wireTurn()
                #expect(wire.content == original.content, "\(name): content")
                #expect(wire.role.rawValue == original.role, "\(name): role")
            }
        }
    }

    /// The formats the confirmers actually write today (copied from
    /// `CodeAssistant+Bash.swift`, `+Git.swift`, `+Edits.swift`, `+Issues
    /// .swift`, `+PR.swift` and `CodeAssistantPanel+Session.swift`), including
    /// the three shapes the Task 8 fallback got wrong: a bash body separated
    /// by a SINGLE newline, the "blocked" message (which must not be
    /// double-wrapped), and a multi-line non-bash ack (whose lines after the
    /// first must not be truncated away).
    @Test("Production ack formats round-trip byte-identically, including blocked and multi-line")
    func productionAckFormatsRoundTrip() {
        let acks = [
            // CodeAssistant+Bash.swift: "\(header)\n$ \(displayCommand)\n\(body)"
            "(bash result - exit code: 0)\n$ npm test\n\n3 passing",
            "(bash result - exit code: 0)\n$ echo hi\nhi",
            "(bash failed - exit code: 1)\n$ npm test\n1 failing\n2 errors",
            "(bash result - exit code: 0)\n$ true\n(no output)",
            // The blocked variant is a single line and IS its own header.
            "(bash blocked - command contains potentially dangerous operations)",
            // Multi-line non-bash acks — the git-op result/failure shapes.
            "(git push result)\nEverything up-to-date",
            "(git push result)\nline one\nline two\n",
            "(git merge failed) conflict in Foo.swift",
            // Single-line acks.
            "(executed create-issue → #42 https://example.com/issues/42)",
            "(executed create-pr → #7: https://example.com/pr/7)",
            "(executed create-branch → feature/x)",
            "(applied update to parser.swift: +3 lines)",
            "(skipped the proposed edit to config.swift — do not apply it)",
            "(something we've never seen before)",
        ]
        for ack in acks {
            let message = ChatMessage.migrate(role: .user, content: ack, sessionDate: Date())
            #expect(message.role == .toolResult, "not classified: \(ack)")
            let payload = message.toolResult
            #expect(payload?.legacyContent() == ack, "legacyContent drift: \(ack)")
            #expect(message.wireTurn().content == ack, "wire drift: \(ack)")
        }
    }

    /// The blocked message specifically: `parse` strips the leading "(bash "
    /// and the trailing ")", so the reconstruction has to re-wrap exactly that
    /// much. Wrapping `summary` (already the full header) or re-adding
    /// "blocked - " would nest the message inside itself.
    @Test("Blocked bash result is unwrapped and re-wrapped exactly once")
    func blockedBashIsNotDoubleWrapped() {
        let content = "(bash blocked - command contains potentially dangerous operations)"
        let payload = try? #require(ChatMessage.ToolResultPayload.parse(content: content))
        #expect(payload?.output == "blocked - command contains potentially dangerous operations")
        #expect(payload?.legacyContent() == content)
        #expect(payload?.legacyContent().contains("(bash blocked - (bash") == false)
    }

    /// A non-bash ack with a body keeps that body: `summary` alone is only its
    /// first line, and returning just that would silently shorten what the
    /// agent sees of its own tool output on the next round-trip.
    @Test("Non-bash ack keeps every line after the first")
    func multiLineNonBashAckIsNotTruncated() {
        let content = "(git push result)\nTo github.com:acme/app.git\n   abc123..def456  main -> main"
        let message = ChatMessage.migrate(role: .user, content: content, sessionDate: Date())
        let payload = try? #require(message.toolResult)
        #expect(payload?.kind == .git)
        #expect(payload?.summary == "(git push result)")
        #expect(payload?.output == "To github.com:acme/app.git\n   abc123..def456  main -> main")
        #expect(payload?.legacyContent() == content)
    }

    // MARK: - Engine construction of tool results

    /// The confirmers still build their ack STRINGS (unchanged in Task 9);
    /// what changed is that `appendTurn` classifies each one on the way in, so
    /// the transcript never has to sniff content at render time.
    @Test("appendTurn classifies a confirmer's synthetic ack and returns its message id")
    func appendTurnClassifies() {
        let (engine, _) = makeEngine()
        let id = engine.appendTurn(.init(role: .user,
                                         content: "(applied update to parser.swift: +3 lines)"))
        #expect(engine.messages.count == 1)
        #expect(engine.messages[0].id == id)
        #expect(engine.messages[0].role == .toolResult)
        #expect(engine.messages[0].toolResult?.kind == .edit)
        // ...and the server still sees exactly the string the confirmer wrote.
        #expect(engine.messages[0].wireTurn().content == "(applied update to parser.swift: +3 lines)")

        // A plain assistant turn (the Loop run's placeholder) stays a plain
        // assistant message, and `setTurnContent` addresses it by the id the
        // append handed back.
        let loopID = engine.appendTurn(.init(role: .assistant, content: "Starting Loop…"))
        engine.setTurnContent(id: loopID, "stage 1 passed")
        #expect(engine.messages[1].role == .assistant)
        #expect(engine.messages[1].content == "stage 1 passed")
    }

    /// A real user prompt that happens to start with "(" is NOT a tool result:
    /// `runTurn` knows statically that it is typing from the human, so it
    /// constructs the message directly instead of going through the
    /// legacy-string classifier.
    @Test("A user prompt starting with ( stays a user message")
    func userPromptIsNeverClassified() async {
        let (engine, t) = makeEngine()
        t.result = .init(reply: "ok", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        await engine.runTurn("(this is just how I write)")
        #expect(engine.messages[0].role == .user)
        #expect(engine.messages[0].toolResult == nil)
    }

    // MARK: - Status transitions

    @Test("finishStreamingTurn(stopped: true) sets .stopped and leaves content untouched")
    func stoppedStatusDoesNotTouchContent() {
        let (engine, _) = makeEngine()
        let id = engine.beginStreamingTurn()
        #expect(engine.messages.last?.status == .streaming)
        engine.appendStreamedChunk(id, "half an ")
        engine.appendStreamedChunk(id, "answer")

        engine.finishStreamingTurn(id, pendingTool: nil, tasks: nil, continueNeeded: nil,
                                   usage: nil, mode: nil, stopped: true)

        let message = engine.messages.last
        #expect(message?.status == .stopped)
        #expect(message?.content == "half an answer")   // no "_(stopped)_" suffix
        #expect(message?.metadata?.failedError == nil)
        // The marker is re-attached only on the way to the server.
        #expect(message?.wireTurn().content == "half an answer\n\n_(stopped)_")
    }

    @Test("A completed turn records usage and its non-default mode on the message")
    func doneStatusRecordsMetadata() {
        let (engine, _) = makeEngine()
        let id = engine.beginStreamingTurn()
        engine.appendStreamedChunk(id, "planned")
        let usage = LlmIdeAPIClient.CodeAssistResponse.Usage(
            attachmentCount: 0, attachmentChars: 0, paths: [], truncatedPaths: nil,
            memoryApproxTokens: 42, memoryChars: nil, memoryHasChatMemory: true)
        engine.finishStreamingTurn(id, pendingTool: nil, tasks: nil, continueNeeded: nil,
                                   usage: usage, mode: CodeAssistMode.plan.rawValue, stopped: false)

        let message = engine.messages.last
        #expect(message?.status == .done)
        #expect(message?.metadata?.mode == CodeAssistMode.plan.rawValue)
        #expect(message?.metadata?.usage?.memoryApproxTokens == 42)
    }

    @Test("A failing runTurn leaves the placeholder .failed with the reason attached")
    func failedSendMarksMessage() async {
        let (engine, t) = makeEngine()
        t.thrownError = APIError.agent(message: "down")
        await engine.runTurn("hi")

        let message = try? #require(engine.messages.last)
        #expect(message?.role == .assistant)
        #expect(message?.status == .failed)
        #expect(message?.metadata?.failedError != nil)
        // The engine-level banner still fires too — the two are complementary,
        // one for the conversation and one for the transcript's error bubble.
        #expect(engine.error != nil)
    }

    @Test("A failing sendFollowup leaves ITS placeholder .failed too")
    func failedFollowupMarksMessage() async {
        let (engine, t) = makeEngine()
        engine.appendTurn(.init(role: .user, content: "(executed create-issue → #1 https://x/1)"))
        t.thrownError = APIError.agent(message: "down")
        await engine.sendFollowup()

        let message = try? #require(engine.messages.last)
        #expect(message?.status == .failed)
        #expect(message?.metadata?.failedError != nil)
        #expect(engine.error != nil)
    }

    // MARK: - Persistence

    /// Tool steps, status and metadata are part of the message now, so they
    /// survive the save/reload that the old engine-side dictionaries (keyed by
    /// a turn id that was re-minted on every decode) could not.
    @Test("Message state survives a session save/reload round trip")
    func statePersistsAcrossReload() throws {
        let message = ChatMessage(
            role: .assistant, content: "answer", status: .stopped, createdAt: Date(),
            toolSteps: [.init(label: "Reading Foo.swift", tool: "read-file")],
            metadata: .init(mode: CodeAssistMode.plan.rawValue, usage: nil, skills: nil,
                            failedError: nil, retryPayload: nil))
        let session = ChatSession(scope: .explorer, messages: [message])
        let data = try AppJSON.encoder.encode(session)
        let reloaded = try AppJSON.decoder.decode(ChatSession.self, from: data)

        #expect(reloaded.messages == [message])
        #expect(reloaded.messages[0].toolSteps.map(\.label) == ["Reading Foo.swift"])
        #expect(reloaded.messages[0].toolSteps[0].icon == "doc.text")
        #expect(reloaded.messages[0].status == .stopped)
    }
}
