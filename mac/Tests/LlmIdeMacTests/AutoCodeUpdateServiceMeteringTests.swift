import XCTest
@testable import LlmIdeMacLib

/// Metering + turn cap for Claude Code Auto Task runs: parsing the
/// `--output-format json` result and deciding success from it.
final class AutoCodeUpdateServiceMeteringTests: XCTestCase {

    private func parse(_ json: String) -> ClaudeCLI.RunResult {
        ClaudeCLI.parseRunResult(Data(json.utf8))
    }

    func testParsesSuccessResultWithUsage() {
        let r = parse("""
        {"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"All good.",
         "usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":55},
         "modelUsage":{"claude-opus-4-8":{"inputTokens":12}}}
        """)
        XCTAssertTrue(r.parsed)
        XCTAssertEqual(r.text, "All good.")
        XCTAssertEqual(r.numTurns, 4)
        XCTAssertEqual(r.usage, ClaudeCLI.RunUsage(inputTokens: 12, outputTokens: 55,
                                                   cacheReadTokens: 4000, cacheCreationTokens: 300))
        XCTAssertFalse(r.reportedFailure)
        XCTAssertTrue(AutoCodeUpdateService.meteredRunSucceeded(processOK: true, claude: r))
    }

    func testTurnCapIsReportedAsFailureEvenOnExitZero() {
        let r = parse("""
        {"type":"result","subtype":"error_max_turns","is_error":false,"num_turns":31,
         "usage":{"input_tokens":1,"output_tokens":2}}
        """)
        XCTAssertTrue(r.hitTurnCap)
        XCTAssertTrue(r.reportedFailure)
        XCTAssertEqual(r.text, "")
        XCTAssertFalse(AutoCodeUpdateService.meteredRunSucceeded(processOK: true, claude: r))
        XCTAssertNotNil(AutoCodeUpdateService.meteredFailureNote(r))
    }

    func testIsErrorIsFailure() {
        let r = parse(#"{"type":"result","subtype":"success","is_error":true,"result":"boom"}"#)
        XCTAssertTrue(r.reportedFailure)
        XCTAssertFalse(AutoCodeUpdateService.meteredRunSucceeded(processOK: true, claude: r))
    }

    func testArrayOfEventsUsesLastResult() {
        let r = parse("""
        [{"type":"system","subtype":"init"},
         {"type":"result","subtype":"success","is_error":false,"result":"done","num_turns":2,
          "usage":{"input_tokens":3,"output_tokens":4}}]
        """)
        XCTAssertTrue(r.parsed)
        XCTAssertEqual(r.text, "done")
        XCTAssertEqual(r.usage?.outputTokens, 4)
    }

    func testUnparseableOutputFallsBackToRawTextAndNoTokens() {
        let r = parse("plain text reply, not json")
        XCTAssertFalse(r.parsed)
        XCTAssertEqual(r.text, "plain text reply, not json")
        XCTAssertNil(r.usage)
        XCTAssertFalse(r.reportedFailure)
        XCTAssertTrue(AutoCodeUpdateService.meteredRunSucceeded(processOK: true, claude: r))
        XCTAssertNil(AutoCodeUpdateService.meteredFailureNote(r))
    }

    func testNonZeroExitIsAlwaysFailure() {
        let ok = parse(#"{"type":"result","subtype":"success","is_error":false,"result":"x"}"#)
        XCTAssertFalse(AutoCodeUpdateService.meteredRunSucceeded(processOK: false, claude: ok))
        XCTAssertFalse(AutoCodeUpdateService.meteredRunSucceeded(processOK: false, claude: nil))
        XCTAssertTrue(AutoCodeUpdateService.meteredRunSucceeded(processOK: true, claude: nil))
    }

    func testMeteredRunArgsCapTurns() {
        XCTAssertEqual(ClaudeCLI.meteredRunArgs(),
                       ["--output-format", "json", "--max-turns", "30"])
        XCTAssertEqual(ClaudeCLI.meteredRunArgs(maxTurns: 5).last, "5")
    }

    func testMeteredOutputRoundTripsAndCleansUp() throws {
        let out = try XCTUnwrap(AutoCodeUpdateService.MeteredOutput.create())
        try out.handle.write(contentsOf: Data("{\"a\":1}".utf8))
        let url = out.url
        XCTAssertEqual(String(data: out.finish(), encoding: .utf8), "{\"a\":1}")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
