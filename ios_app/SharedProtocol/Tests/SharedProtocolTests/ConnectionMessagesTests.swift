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

    func testPairingRoundTrips() throws {
        let original = Pairing(pin: "123456")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Pairing.self, from: data)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "pairing")
        XCTAssertEqual(decoded.pin, "123456")
    }

    func testLlmIdeChatRoundTrips() throws {
        let chat = LlmIdeChat(commandId: "abc", text: "hello",
                              history: [ChatTurn(role: "user", content: "hi")],
                              images: [ChatImage(mediaType: "image/png", data: "B64")],
                              files: [ChatFileText(name: "notes.md", text: "# hi")])
        let decoded = try roundTrip(chat)
        XCTAssertEqual(decoded, chat)
        XCTAssertEqual(decoded.type, "llmide_chat")
        XCTAssertEqual(decoded.images.count, 1)
        XCTAssertEqual(decoded.files.first?.name, "notes.md")
    }

    func testLlmIdeChatTextOnlyRoundTrips() throws {
        let chat = LlmIdeChat(commandId: "x", text: "q", history: [], images: [], files: [])
        let decoded = try roundTrip(chat)
        XCTAssertEqual(decoded, chat)
        XCTAssertTrue(decoded.images.isEmpty)
        XCTAssertTrue(decoded.files.isEmpty)
    }

    func testOutputHasNestedPayload() throws {
        let out = Output(commandId: "abc", payload: OutputPayload(stream: "reply text", done: true))
        let data = try JSONEncoder().encode(out)
        // Nested payload shape matches iOS receive: {"type":"output",...,"payload":{"stream":...,"done":...}}.
        // Assert only that `payload` is a nested object (field order is not guaranteed by
        // JSONEncoder); the decoded-field checks below verify the values.
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(json.contains("\"payload\":{"), "expected nested payload object, got: \(json)")
        let decoded = try roundTrip(out)
        XCTAssertEqual(decoded.payload.stream, "reply text")
        XCTAssertEqual(decoded.payload.done, true)
    }

    func testCommandErrorRoundTrips() throws {
        let err = CommandError(commandId: "abc", message: "boom")
        let decoded = try roundTrip(err)
        XCTAssertEqual(decoded, err)
        XCTAssertEqual(decoded.type, "error")
    }

    // MARK: - Explorer-chat session messages (Phase B, Task 1)

    func testExploreChatRoundTrips() throws {
        let history = [
            ChatTurn(role: "user", content: "first question"),
            ChatTurn(role: "assistant", content: "first answer")
        ]
        let original = ExploreChat(sessionId: "sess-123", commandId: "cmd-456", text: "new question", history: history)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "explore_chat")
        XCTAssertEqual(decoded.sessionId, "sess-123")
        XCTAssertEqual(decoded.commandId, "cmd-456")
        XCTAssertEqual(decoded.text, "new question")
        XCTAssertEqual(decoded.history.count, 2)
        XCTAssertEqual(decoded.history[0].role, "user")
        XCTAssertEqual(decoded.history[0].content, "first question")
    }

    func testExploreSessionListRoundTrips() throws {
        let sessions = [
            ExploreSessionSummary(id: "sess-1", title: "Project Plan", lastUsedAt: 1_700_000_000),
            ExploreSessionSummary(id: "sess-2", title: "API Design", lastUsedAt: 1_700_000_100)
        ]
        let original = ExploreSessionList(sessions: sessions)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "explore_session_list")
        XCTAssertEqual(decoded.sessions.count, 2)
        XCTAssertEqual(decoded.sessions[0].id, "sess-1")
        XCTAssertEqual(decoded.sessions[0].title, "Project Plan")
        XCTAssertEqual(decoded.sessions[0].lastUsedAt, 1_700_000_000)
        XCTAssertEqual(decoded.sessions[1].id, "sess-2")
        XCTAssertEqual(decoded.sessions[1].title, "API Design")
        XCTAssertEqual(decoded.sessions[1].lastUsedAt, 1_700_000_100)
    }

    func testExploreSessionHistoryRoundTrips() throws {
        let history = [
            ChatTurn(role: "user", content: "analyze code"),
            ChatTurn(role: "assistant", content: "I'll analyze it")
        ]
        let original = ExploreSessionHistory(sessionId: "sess-abc", title: "Code Review", history: history)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "explore_session_history")
        XCTAssertEqual(decoded.sessionId, "sess-abc")
        XCTAssertEqual(decoded.title, "Code Review")
        XCTAssertEqual(decoded.history.count, 2)
        XCTAssertEqual(decoded.history[0].role, "user")
        XCTAssertEqual(decoded.history[0].content, "analyze code")
        XCTAssertEqual(decoded.history[1].role, "assistant")
        XCTAssertEqual(decoded.history[1].content, "I'll analyze it")
    }
}
