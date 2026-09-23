import Testing
import Foundation
@testable import LlmIdeMacLib

/// Regression (2026-09 chat review, F10): one message this build couldn't
/// decode made the WHOLE session vanish. The `[ChatMessage]` decode threw,
/// `ChatSession.init(from:)` fell through to the v1 branch (which needs a
/// `history` key v2 files lack), and the store quarantined the file.
@Suite("Chat session decode tolerance")
struct ChatSessionDecodeToleranceTests {
    /// A real v2 session, encoded the way the store writes it, as a mutable
    /// JSON object — so each test corrupts exactly one thing.
    private func sessionJSON(_ messages: [ChatMessage]) throws -> [String: Any] {
        var session = ChatSession(scope: .explorer, title: "Chat")
        session.messages = messages
        let data = try AppJSON.encoder.encode(session)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func decode(_ json: [String: Any]) throws -> ChatSession {
        try AppJSON.decoder.decode(ChatSession.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func message(_ text: String, role: ChatMessage.Role = .user) -> ChatMessage {
        ChatMessage(role: role, content: text, status: .done, createdAt: Date())
    }

    @Test("An unreadable message is dropped; the rest of the chat survives")
    func badMessageDroppedNotSession() throws {
        var json = try sessionJSON([message("first"), message("second", role: .assistant), message("third")])
        var msgs = try #require(json["messages"] as? [[String: Any]])
        msgs[1].removeValue(forKey: "role")          // cannot be placed at all
        json["messages"] = msgs
        let session = try decode(json)
        #expect(session.messages.map(\.content) == ["first", "third"])
    }

    @Test("Values from a newer build fall back instead of failing the message")
    func unknownEnumValuesFallBack() throws {
        let payload = ChatMessage.ToolResultPayload(kind: .git, summary: "(git status result)",
                                                    exitCode: nil, command: nil, output: nil, url: nil)
        var tool = ChatMessage(role: .toolResult, content: "", status: .done, createdAt: Date(),
                               toolResult: payload,
                               metadata: .init(mode: "plan", planCardAction: .execute))
        tool.toolSteps = [.init(label: "Reading", tool: "read-file")]
        var json = try sessionJSON([tool])
        var msgs = try #require(json["messages"] as? [[String: Any]])
        msgs[0]["status"] = "paused"                                   // unknown Status
        var tr = try #require(msgs[0]["toolResult"] as? [String: Any])
        tr["kind"] = "deploy"                                          // unknown Kind
        tr.removeValue(forKey: "isFailure")                            // missing defaulted field
        msgs[0]["toolResult"] = tr
        var meta = try #require(msgs[0]["metadata"] as? [String: Any])
        meta["planCardAction"] = "publish"                             // unknown PlanCardAction
        msgs[0]["metadata"] = meta
        msgs[0]["toolSteps"] = [["garbage": true]] + (msgs[0]["toolSteps"] as? [[String: Any]] ?? [])
        json["messages"] = msgs

        let decoded = try #require(try decode(json).messages.first)
        #expect(decoded.status == .done)
        #expect(decoded.toolResult?.kind == .other)
        #expect(decoded.toolResult?.isFailure == false)
        #expect(decoded.toolResult?.summary == "(git status result)")
        #expect(decoded.metadata?.planCardAction == nil)
        #expect(decoded.metadata?.mode == "plan", "one bad metadata field doesn't cost the others")
        #expect(decoded.toolSteps.map(\.label) == ["Reading"], "a bad step is dropped on its own")
    }

    @Test("A well-formed message still round-trips unchanged")
    func roundTripUnchanged() throws {
        let original = ChatMessage(
            role: .toolResult, content: "x", status: .stopped, createdAt: Date(timeIntervalSince1970: 1_000),
            toolSteps: [.init(label: "Run", tool: "bash", args: "{}", resultText: "ok", isError: false)],
            toolResult: .init(kind: .bash, summary: "(bash result - exit code: 0)", exitCode: 0,
                              command: "ls", output: "a", url: nil, isFailure: false),
            metadata: .init(mode: "execute", failedError: nil, planCardAction: .edit))
        let data = try AppJSON.encoder.encode(original)
        #expect(try AppJSON.decoder.decode(ChatMessage.self, from: data) == original)
    }

    @Test("A v1 file (history, no messages) still migrates")
    func v1StillMigrates() throws {
        var json = try sessionJSON([])
        json.removeValue(forKey: "messages")
        json["history"] = [["role": "user", "content": "hi"], ["role": "assistant", "content": "hello"]]
        #expect(try decode(json).messages.map(\.content) == ["hi", "hello"])
    }
}
