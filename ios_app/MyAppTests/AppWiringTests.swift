import XCTest
import SharedProtocol
@testable import MyApp

/// A sink that records what the connection tells it.
@MainActor
private final class RecordingSink: HostEventSink {
    var resets = 0, errors: [String?] = [], clears = 0, events = 0
    func handle(_ event: HostEvent) { events += 1 }
    func handleChatError(commandId: String?) { errors.append(commandId) }
    func clearPendingPrompts() { clears += 1 }
    func resetForNewDevice() { resets += 1 }
}

@MainActor
final class AppWiringTests: XCTestCase {
    func testConnectionRoutesToEverySink() {
        let connection = ConnectionService()
        let a = RecordingSink(), b = RecordingSink()
        connection.registerSink(a); connection.registerSink(b)
        connection.resetStoresForNewDevice()
        XCTAssertEqual(a.resets, 1); XCTAssertEqual(b.resets, 1)
        connection.disconnect()
        XCTAssertEqual(a.errors.count, 1); XCTAssertNil(a.errors[0] ?? nil, "a dropped connection ends every turn")
        XCTAssertEqual(b.errors.count, 1)
    }

    func testReleasedSinksAreDropped() {
        let connection = ConnectionService()
        var kept: RecordingSink? = RecordingSink()
        connection.registerSink(kept!)
        let live = RecordingSink()
        connection.registerSink(live)
        kept = nil
        connection.resetStoresForNewDevice() // must not crash on the released sink
        XCTAssertEqual(live.resets, 1)
    }

    func testAppModelWiresBothChatsToTheConnection() {
        let model = AppModel()
        model.llmIdeStore.llmIdeMessages = [ChatMessage(role: .user, text: "ask")]
        model.executeStore.llmIdeMessages = [ChatMessage(role: .user, text: "run")]
        model.connection.resetStoresForNewDevice()
        XCTAssertTrue(model.llmIdeStore.llmIdeMessages.isEmpty, "the Ask chat is registered as a sink")
        XCTAssertTrue(model.executeStore.llmIdeMessages.isEmpty, "the Execute chat is registered as a sink")
        XCTAssertEqual(model.executeStore.surface, "execute")
        XCTAssertEqual(model.llmIdeStore.surface, "ask")
    }

    func testStoreContextReportsOfflineByDefault() async {
        let connection = ConnectionService()
        XCTAssertFalse(connection.isConnected)
        let project = await connection.scopedProjectId()
        XCTAssertNil(project, "no picker, no project")
    }
}
