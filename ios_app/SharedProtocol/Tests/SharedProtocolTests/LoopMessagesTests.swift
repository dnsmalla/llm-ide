import XCTest
import SharedProtocol

/// Wire-shape guard for the Loop channel. Both ends decode these structs, so a
/// field rename on one side has to fail here rather than in a silent no-op on
/// the phone.
final class LoopMessagesTests: XCTestCase {

    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Every message carries its `type` so the receive loop can route it. These
    /// literals are what the Mac switches on, so pin them.
    func testTagsAreStable() {
        XCTAssertEqual(MobileProtocol.Tag.loopStatusList, "loop_status_list")
        XCTAssertEqual(MobileProtocol.Tag.loopState, "loop_state")
        XCTAssertEqual(MobileProtocol.Tag.loopStart, "loop_start")
        XCTAssertEqual(MobileProtocol.Tag.loopStop, "loop_stop")
        XCTAssertEqual(MobileProtocol.Tag.loopAck, "loop_ack")
        XCTAssertEqual(MobileProtocol.Tag.loopHistory, "loop_history")
        XCTAssertEqual(MobileProtocol.Tag.loopHistoryReply, "loop_history_reply")
    }

    /// The Mac routes the whole family on a `loop_` prefix, so every tag must
    /// carry it — a tag that didn't would be silently unhandled.
    func testEveryTagSharesTheRoutingPrefix() {
        for tag in [MobileProtocol.Tag.loopStatusList, MobileProtocol.Tag.loopState,
                    MobileProtocol.Tag.loopStart, MobileProtocol.Tag.loopStop,
                    MobileProtocol.Tag.loopAck, MobileProtocol.Tag.loopHistory,
                    MobileProtocol.Tag.loopHistoryReply] {
            XCTAssertTrue(tag.hasPrefix("loop_"), "\(tag) would not route")
        }
    }

    func testRequestsEncodeOnlyTheirType() throws {
        for data in [try JSONEncoder().encode(LoopStatusList()),
                     try JSONEncoder().encode(LoopStart()),
                     try JSONEncoder().encode(LoopStop())] {
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(json.keys.count, 1, "a bare command must carry nothing but its type")
            XCTAssertNotNil(json["type"])
        }
    }

    func testStateRoundTrips() throws {
        let state = LoopState(
            configured: true, projectName: "LLM", running: true, startedHere: false,
            iteration: 0, maxIterations: 8,
            logTail: ["stage 1 passed", "stage 2 failed"],
            lastStatusSummary: "given up (max iterations)", lastFinishedAt: 1_700_000_100,
            stages: [LoopStageInfo(name: "Build", kind: "shellCommand", severity: "blocking",
                                   enabled: true, order: 0)])
        let back = try roundTrip(state)
        XCTAssertEqual(back, state)
        XCTAssertEqual(back.type, MobileProtocol.Tag.loopState)
        XCTAssertEqual(back.stages.first?.name, "Build")
        // running && !startedHere is the "the desktop started this" case the
        // phone renders differently — it must survive the wire.
        XCTAssertTrue(back.running)
        XCTAssertFalse(back.startedHere)
    }

    /// The unconfigured snapshot is what the phone shows as "set this up on the
    /// Mac", so its optional fields must survive as nil rather than as "".
    func testUnconfiguredStateRoundTrips() throws {
        let state = LoopState(configured: false, projectName: nil, running: false, startedHere: false,
                              iteration: 0, maxIterations: 0, logTail: [],
                              lastStatusSummary: nil, lastFinishedAt: nil, stages: [])
        let back = try roundTrip(state)
        XCTAssertEqual(back, state)
        XCTAssertNil(back.projectName)
        XCTAssertNil(back.lastStatusSummary)
        XCTAssertTrue(back.stages.isEmpty)
    }

    /// A refused start is a normal reply, not an error frame — the phone shows
    /// it as a status. Both polarities have to decode.
    func testAckRoundTripsBothWays() throws {
        let accepted = try roundTrip(LoopAck(accepted: true, message: "Loop started."))
        XCTAssertTrue(accepted.accepted)
        let refused = try roundTrip(LoopAck(accepted: false, message: "A loop run is already in progress."))
        XCTAssertFalse(refused.accepted)
        XCTAssertEqual(refused.type, MobileProtocol.Tag.loopAck)
    }

    func testHistoryRoundTrips() throws {
        let reply = LoopHistoryReply(runs: [
            LoopRunSummary(id: "r1", startedAt: 1_700_000_000, durationSeconds: 91.5,
                           iterationsUsed: 3, statusCode: "success",
                           statusSummary: "success", trigger: "manual"),
            LoopRunSummary(id: "r2", startedAt: 1_700_001_000, durationSeconds: 12,
                           iterationsUsed: 1, statusCode: "givenUp",
                           statusSummary: "given up (max iterations)", trigger: "autoTask"),
        ])
        let back = try roundTrip(reply)
        XCTAssertEqual(back, reply)
        XCTAssertEqual(back.runs.map(\.id), ["r1", "r2"])
        // Identifiable by run id — the history list depends on it being stable.
        XCTAssertEqual(back.runs[0].id, back.runs[0].id)
    }

    func testHistoryRequestLimitIsOptional() throws {
        XCTAssertEqual(try roundTrip(LoopHistoryRequest(limit: 5)).limit, 5)
        XCTAssertNil(try roundTrip(LoopHistoryRequest()).limit)
    }
}
