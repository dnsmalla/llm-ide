import Foundation
import Testing
@testable import LlmIdeMacLib

/// Raw on-disk v1 session JSON used by migration tests. Shapes lifted from
/// ChatSession.swift (v1 encoder) and the ack conventions in
/// CodeAssistant+Issues/Bash/Git.swift + CodeAssistantPanel+Session.swift.
///
/// Dates are Doubles (seconds since the 2001-01-01 reference date), NOT ISO
/// strings: ChatSessionStore reads/writes session files with
/// AppJSON.encoder/decoder, whose date strategy is the Codable default
/// (deferredToDate). The ISO-8601 strings in the task brief would fail to
/// decode with the store's decoder — 807271200.0 is 2026-08-01T10:00:00Z
/// and 807357600.0 is 2026-08-02T10:00:00Z.
enum ChatSessionV1Fixtures {
    static func v1JSON(id: String = "11111111-1111-1111-1111-111111111111",
                       historyJSON: String) -> String {
        """
        {"storeVersion":1,"id":"\(id)","scope":"explorer","title":"Fix the parser",
         "createdAt":807271200.0,"lastUsedAt":807357600.0,
         "history":[\(historyJSON)]}
        """
    }

    /// Ordinary user/assistant exchange.
    static let plainTurns = v1JSON(historyJSON:
        """
        {"role":"user","content":"Why does the scraper miss short captions?"},
        {"role":"assistant","content":"Because `isValidCaption` filters any text under 2 chars."}
        """)

    /// The legacy ack convention: role user, content starting with "(".
    static let ackTurns = v1JSON(historyJSON:
        """
        {"role":"user","content":"(executed create-issue → #42 https://example.com/issues/42)"},
        {"role":"user","content":"(applied update to parser.swift: +3 lines)"},
        {"role":"user","content":"(skipped proposed edit to config.swift)"}
        """)

    /// Bash-result ack — first line carries exit code + command, body is output.
    /// Matches the "(bash result - exit code: N)\n$ cmd\n<output>" convention
    /// parsed by BashResultDisplay.parse (CommandOutputView.swift).
    static let bashTurns = v1JSON(historyJSON:
        """
        {"role":"user","content":"(bash result - exit code: 0)\\n$ npm test\\n\\n3 passing"}
        """)

    /// A stopped turn — the legacy marker is embedded in assistant content.
    static let stoppedTurn = v1JSON(historyJSON:
        """
        {"role":"user","content":"long analysis please"},
        {"role":"assistant","content":"Here is the start of the analysis.\\n\\n_(stopped)_"}
        """)
}

@Suite("v1 fixture sanity")
struct ChatSessionV1FixtureTests {
    // NOTE: as of Task 8, `ChatSession.init(from:)` migrates v1 JSON
    // transparently on decode — there is no way to observe the RAW v1 shape
    // through `ChatSession` anymore (that's the point: a v1 file becomes a
    // fully-formed v2 `ChatSession` the instant it's read). These
    // assertions were written against pre-migration behavior (Task 2); they
    // now assert the POST-migration shape instead — same fixtures, updated
    // expectations, not new behavior under test (that's
    // `ChatMessageMigrationTests`'s job).
    @Test func plainFixtureDecodesAsV1() throws {
        let data = Data(ChatSessionV1Fixtures.plainTurns.utf8)
        let session = try AppJSON.decoder.decode(ChatSession.self, from: data)
        #expect(session.storeVersion == 2)
        #expect(session.messages.count == 2)
        #expect(session.messages[1].role == .assistant)
    }

    @Test func allFixturesDecodeWithStoreDecoder() throws {
        // The store's own decoder (AppJSON.decoder, default date strategy)
        // must accept every fixture envelope — ack/bash/stopped histories are
        // consumed by the Task 8/9 migration tests, so they can't be broken
        // raw JSON today.
        for raw in [ChatSessionV1Fixtures.ackTurns,
                    ChatSessionV1Fixtures.bashTurns,
                    ChatSessionV1Fixtures.stoppedTurn] {
            let session = try AppJSON.decoder.decode(ChatSession.self, from: Data(raw.utf8))
            #expect(session.storeVersion == 2)
            #expect(session.scope == .explorer)
            #expect(!session.messages.isEmpty)
        }
    }
}
