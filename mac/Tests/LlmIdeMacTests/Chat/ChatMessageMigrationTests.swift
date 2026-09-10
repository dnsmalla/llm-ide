import Foundation
import Testing
@testable import LlmIdeMacLib

/// v1→v2 migration: `ChatSession.init(from:)` transparently upgrades a v1
/// file (flat `history: [{role,content}]`) into `messages: [ChatMessage]`,
/// classifying the legacy `"("`-prefixed synthetic-ack conventions into
/// typed `ToolResultPayload`s and turning the `"\n\n_(stopped)_"` suffix
/// into a real `Status.stopped`. Uses Task 2's `ChatSessionV1Fixtures` (raw
/// v1 JSON, decoded with `AppJSON.decoder` — the store's actual decoder,
/// whose date strategy is `deferredToDate`, not ISO-8601).
@Suite("ChatMessage v1→v2 migration")
struct ChatMessageMigrationTests {
    @Test func plainTurnsMigrate() throws {
        let s = try decode(ChatSessionV1Fixtures.plainTurns)
        #expect(s.storeVersion == 2)
        #expect(s.messages.count == 2)
        #expect(s.messages[0].role == .user && s.messages[0].status == .done)
        #expect(s.messages[0].id == s.messages[0].id)  // stability within one decode
    }

    @Test func ackTurnsBecomeToolResults() throws {
        let s = try decode(ChatSessionV1Fixtures.ackTurns)
        #expect(s.messages.allSatisfy { $0.role == .toolResult })
        #expect(s.messages[0].toolResult?.kind == .issue)
        #expect(s.messages[1].toolResult?.kind == .edit)
        #expect(s.messages[2].toolResult?.kind == .skip)
    }

    @Test func bashTurnParsesExitCodeAndCommand() throws {
        let s = try decode(ChatSessionV1Fixtures.bashTurns)
        let p = try #require(s.messages[0].toolResult)
        #expect(p.kind == .bash); #expect(p.exitCode == 0); #expect(p.command == "npm test")
        #expect(p.output?.contains("3 passing") == true)
        #expect(p.isFailure == false)
    }

    @Test func stoppedMarkerBecomesStatus() throws {
        let s = try decode(ChatSessionV1Fixtures.stoppedTurn)
        let last = try #require(s.messages.last)
        #expect(last.status == .stopped)
        #expect(!last.content.contains("_(stopped)_"))
    }

    @Test func wireTurnResynthesizesLegacyText() throws {
        let s = try decode(ChatSessionV1Fixtures.bashTurns)
        let wire = s.messages.map { $0.wireTurn() }
        #expect(wire[0].role == .user)   // server still sees user/assistant only
        #expect(wire[0].content.hasPrefix("(bash result - exit code: 0)"))
    }

    @Test func v2RoundTripKeepsIds() throws {
        let s = try decode(ChatSessionV1Fixtures.plainTurns)
        let data = try AppJSON.encoder.encode(s)
        let s2 = try AppJSON.decoder.decode(ChatSession.self, from: data)
        #expect(s.messages.map(\.id) == s2.messages.map(\.id))
    }

    // MARK: - Additional classification coverage
    //
    // The brief's own 4-bullet classifier list undercounts the real
    // synthetic-ack conventions (grepped from CodeAssistant+Issues/PR/Git/
    // Edits.swift + CodeAssistantPanel+Session.swift — see
    // `ChatMessage.classifyAckKind`'s doc comment). These fixtures exercise
    // the ones the brief's 3 sample tests don't: create-branch, create-pr,
    // and all three git-op ack shapes (skipped/result/failed).

    @Test func createBranchBecomesGitKind() throws {
        let s = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(executed create-branch → feature/x)"}"#))
        #expect(s.messages[0].toolResult?.kind == .git)
    }

    @Test func createPRBecomesIssueKind() throws {
        let s = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(executed create-pr → #7: https://example.com/pr/7)"}"#))
        #expect(s.messages[0].toolResult?.kind == .issue)
        #expect(s.messages[0].toolResult?.summary.contains("create-pr") == true)
    }

    @Test func gitOpAckVariantsAllBecomeGitKind() throws {
        let skipped = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(git commit skipped — no active repository)"}"#))
        #expect(skipped.messages[0].toolResult?.kind == .git)

        let result = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(git push result)\nOK, pushed 1 commit"}"#))
        #expect(result.messages[0].toolResult?.kind == .git)

        let failed = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(git merge failed) conflict in Foo.swift"}"#))
        #expect(failed.messages[0].toolResult?.kind == .git)
    }

    @Test func bashFailureAndBlockedSetIsFailure() throws {
        let failed = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(bash failed - exit code: 1)\n$ npm test\n\n1 failing"}"#))
        let failedPayload = try #require(failed.messages[0].toolResult)
        #expect(failedPayload.kind == .bash)
        #expect(failedPayload.isFailure == true)
        #expect(failedPayload.exitCode == 1)

        let blocked = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(bash blocked - command contains potentially dangerous operations)"}"#))
        let blockedPayload = try #require(blocked.messages[0].toolResult)
        #expect(blockedPayload.kind == .bash)
        #expect(blockedPayload.isFailure == true)
        #expect(blockedPayload.exitCode == nil)
        #expect(blockedPayload.command == nil)

        let success = try decode(ChatSessionV1Fixtures.bashTurns)
        let successPayload = try #require(success.messages[0].toolResult)
        #expect(successPayload.isFailure == false)
    }

    @Test func unrecognizedAckFallsBackToOther() throws {
        let s = try decode(ChatSessionV1Fixtures.v1JSON(historyJSON:
            #"{"role":"user","content":"(something we've never seen before)"}"#))
        #expect(s.messages[0].toolResult?.kind == .other)
    }

    private func decode(_ json: String) throws -> ChatSession {
        try AppJSON.decoder.decode(ChatSession.self, from: Data(json.utf8))
    }
}
