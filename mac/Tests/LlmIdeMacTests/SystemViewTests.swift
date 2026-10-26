import XCTest
@testable import LlmIdeMacLib

/// The OS view (`Features/System`) and its Home routing: the System section is
/// the Home landing, never a menu item; the bridge decodes only the fixed
/// message contract; the configure script escapes the token; and the `open`
/// target honours disabled features.
@MainActor
final class SystemViewTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "system-view-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        suite.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private let allCompiled = Set(AppFeature.allCases)

    // MARK: Home routing

    func testSystemIsTheDefaultHomeWhenNothingWasChosen() {
        // A fresh install has no stored homeSection, so the fallback applies.
        let config = AppConfig(userDefaults: suite)
        XCTAssertEqual(config.homeSection, ShellSection.system.rawValue)
        XCTAssertEqual(
            ShellSection.resolveHome(config.homeSection, hidden: [], compiled: allCompiled), .system)
    }

    func testExplicitlyChosenHomeIsKept() {
        suite.set("gantt", forKey: "homeSection")
        let config = AppConfig(userDefaults: suite)
        XCTAssertEqual(config.homeSection, "gantt", "an explicit user choice must not be overwritten by the new default")
    }

    func testStaleHomeValueFallsBackToSystem() {
        suite.set("regression", forKey: "homeSection")
        let config = AppConfig(userDefaults: suite)
        XCTAssertEqual(config.homeSection, ShellSection.system.rawValue)
    }

    func testResolveHomeReturnsSystemWithoutAnyFeature() {
        // System has no backingFeature, so no compiled set can strand it.
        XCTAssertEqual(ShellSection.resolveHome("system", hidden: [], compiled: []), .system)
    }

    func testResolveHomeSystemIsNotSwallowedByHiddenSet() {
        XCTAssertEqual(ShellSection.resolveHome("system", hidden: ["explorer"], compiled: allCompiled), .system)
    }

    // MARK: Menu exclusion

    func testSystemIsNotAToolbarMenuItem() {
        XCTAssertFalse(ShellSection.toolbarOrder.contains(.system))
    }

    func testSystemIsNotUserHideable() {
        XCTAssertFalse(ShellSection.userHideable.contains(.system))
    }

    func testSystemIsStillOfferedAsAHomeChoice() {
        // The Settings "Home opens" picker iterates allCases; System must be
        // in it so the user can choose it.
        XCTAssertTrue(ShellSection.allCases.contains(.system))
        XCTAssertEqual(ShellSection.system.label, "System")
        XCTAssertNil(ShellSection.system.backingFeature)
    }

    // MARK: Bridge decoding

    func testDecodesTheFixedMessageContract() {
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "ready"]), .ready)
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "open", "target": "loop"]), .open(target: "loop"))
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "subscribe"]), .subscribe)
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "unsubscribe"]), .unsubscribe)
    }

    func testDecodesAnAllowlistedRequest() {
        let inbound = SystemBridgeInbound.decode([
            "type": "request", "id": "r1", "method": "GET", "path": "/kb/os/state?window=day",
        ])
        XCTAssertEqual(inbound, .request(SystemBridgeRequest(id: "r1", call: .state(window: "day", activity: nil))))
    }

    func testDecodesACancelRequestWithItsBody() {
        let inbound = SystemBridgeInbound.decode([
            "type": "request", "id": "r2", "method": "POST", "path": "/agent/v2/cancel",
            "body": ["chatSessionId": "chat-1"],
        ])
        XCTAssertEqual(inbound, .request(SystemBridgeRequest(id: "r2", call: .cancelChat(chatSessionId: "chat-1"))))
    }

    func testARefusedRequestKeepsItsIdSoThePageGetsAnErrorReply() {
        let inbound = SystemBridgeInbound.decode([
            "type": "request", "id": "r3", "method": "GET", "path": "/kb/os/state/../x?window=day",
        ])
        XCTAssertEqual(inbound, .request(SystemBridgeRequest(id: "r3", call: nil)))
    }

    func testAMalformedRequestBodyIsRefusedWithItsId() {
        let inbound = SystemBridgeInbound.decode([
            "type": "request", "id": "r4", "method": "POST", "path": "/agent/v2/cancel", "body": "chat-1",
        ])
        XCTAssertEqual(inbound, .request(SystemBridgeRequest(id: "r4", call: nil)))
    }

    func testIgnoresUnknownOrMalformedMessages() {
        XCTAssertNil(SystemBridgeInbound.decode(["type": "stop"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "needToken"]), "native owns auth now")
        XCTAssertNil(SystemBridgeInbound.decode(["type": "open"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "open", "target": ""]))
        XCTAssertNil(SystemBridgeInbound.decode(["target": "loop"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "request", "method": "GET", "path": "/kb/os/state"]),
                     "a request without an id cannot be answered, so it is dropped")
        XCTAssertNil(SystemBridgeInbound.decode(["type": "request", "id": "bad id!", "method": "GET", "path": "/x"]))
        XCTAssertNil(SystemBridgeInbound.decode("ready"))
        XCTAssertNil(SystemBridgeInbound.decode(NSNull()))
    }

    // MARK: Request allowlist

    func testAllowlistAcceptsTheThreeCalls() {
        XCTAssertEqual(SystemBridge.validate(method: "GET", path: "/kb/os/state?window=day", body: nil),
                       .state(window: "day", activity: nil))
        XCTAssertEqual(SystemBridge.validate(method: "GET", path: "/kb/os/state?window=week&activity=1", body: nil),
                       .state(window: "week", activity: 1))
        XCTAssertEqual(SystemBridge.validate(method: "GET", path: "/kb/os/state?activity=100&window=day", body: nil),
                       .state(window: "day", activity: 100))
        XCTAssertEqual(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel",
                                             body: ["chatSessionId": "chat-1"]),
                       .cancelChat(chatSessionId: "chat-1"))
        XCTAssertEqual(SystemBridge.validate(method: "POST", path: "/kb/agent/stop",
                                             body: ["sessionId": "sess_01.a:b-c"]),
                       .stopAgentRun(sessionId: "sess_01.a:b-c"))
    }

    func testAllowlistRebuildsThePathFromValidatedValues() {
        XCTAssertEqual(SystemAllowedCall.state(window: "week", activity: 5).path,
                       "/kb/os/state?window=week&activity=5")
        XCTAssertEqual(SystemAllowedCall.state(window: "day", activity: nil).path, "/kb/os/state?window=day")
        XCTAssertEqual(SystemAllowedCall.cancelChat(chatSessionId: "c").method, "POST")
        XCTAssertNil(SystemAllowedCall.state(window: "day", activity: nil).body)
        XCTAssertEqual(SystemAllowedCall.stopAgentRun(sessionId: "s").body, ["sessionId": "s"])
    }

    func testAllowlistRejectsPathTricks() {
        let day = "?window=day"
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state/../x\(day)", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "//evil/kb/os/state\(day)", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state/\(day)", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state%2F..%2Fx\(day)", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "https://evil.example/kb/os/state\(day)", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/KB/OS/STATE\(day)", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state\(day)#frag", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel/../stop",
                                           body: ["chatSessionId": "c"]))
        let long = "/kb/os/state?window=day&" + String(repeating: "a", count: 300)
        XCTAssertNil(SystemBridge.validate(method: "GET", path: long, body: nil), "an oversize path is refused")
    }

    func testAllowlistRejectsOtherPathsAndMethods() {
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/stream", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/agent/ask", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state", body: nil), "window is required")
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/kb/os/state?window=day", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "DELETE", path: "/kb/os/state?window=day", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "get", path: "/kb/os/state?window=day", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "PUT", path: "/agent/v2/cancel", body: ["chatSessionId": "c"]))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/agent/v2/cancel", body: ["chatSessionId": "c"]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/kb/agent/stop", body: ["chatSessionId": "c"]),
                     "each call takes only its own key")
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/stream", body: ["chatSessionId": "c"]))
    }

    func testAllowlistRejectsOddQueries() {
        let bad = [
            "window=day&window=week",       // repeated key
            "window=day&x=1",               // unknown key
            "window=month",                 // unknown window
            "window=",                      // empty value
            "window=day&",                  // empty trailing pair
            "window=day&activity=0",        // below range
            "window=day&activity=101",      // above range
            "window=day&activity=+5",       // not plain digits
            "window=day&activity=-1",
            "window=day&activity=1.5",
            "window=day&activity=abc",
            "window=day&activity=",
            "window=day&activity=1&activity=2",
            "window=day%26x=1",             // encoded separator is not a separator
            "window=day&activity=1000",     // too many digits
            "window",                       // no value
            "",                             // empty query after ?
        ]
        for query in bad {
            XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state?\(query)", body: nil),
                         "query \(query) must be refused")
        }
        let oversize = "window=day&" + String(repeating: "a", count: SystemBridge.maxQueryLength)
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state?\(oversize)", body: nil))
    }

    func testAllowlistRejectsOddBodies() {
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel", body: [:]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel",
                                           body: ["chatSessionId": "c", "extra": "x"]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel", body: ["chatSessionId": 5]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel", body: ["chatSessionId": ""]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel",
                                           body: ["chatSessionId": "a/../b"]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel",
                                           body: ["chatSessionId": "a\nb"]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel",
                                           body: ["chatSessionId": String(repeating: "a", count: 129)]))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/os/state?window=day", body: ["window": "day"]),
                     "a GET takes no body")
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/agent/v2/cancel?x=1",
                                           body: ["chatSessionId": "c"]), "a cancel takes no query")
    }

    func testRequestIdsMustBePlain() {
        XCTAssertTrue(SystemBridge.isValidRequestId("r1"))
        XCTAssertTrue(SystemBridge.isValidRequestId("a-b_9"))
        XCTAssertFalse(SystemBridge.isValidRequestId(""))
        XCTAssertFalse(SystemBridge.isValidRequestId("a b"))
        XCTAssertFalse(SystemBridge.isValidRequestId("a\"b"))
        XCTAssertFalse(SystemBridge.isValidRequestId(String(repeating: "a", count: 65)))
    }

    // MARK: Scripts handed to the page

    /// Strips `prefix` and the trailing `);` and parses what is between as a JSON array.
    private func argumentsOf(_ script: String, prefix: String) throws -> [Any] {
        XCTAssertTrue(script.hasPrefix(prefix), script)
        XCTAssertTrue(script.hasSuffix(");"), script)
        let inner = String(script.dropFirst(prefix.count).dropLast(2))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data("[\(inner)]".utf8)) as? [Any])
    }

    func testConfigureScriptCarriesOnlyThemeAndProject() throws {
        let config = SystemBridgeConfig(theme: "midnight", projectName: "Demo")
        let script = try XCTUnwrap(SystemBridge.configureScript(config))
        let args = try argumentsOf(script, prefix: "window.llmideConfigure(")
        let object = try XCTUnwrap(args.first as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["theme", "projectName"], "no token and no server address reach the page")
        XCTAssertEqual(object["theme"] as? String, "midnight")
        XCTAssertEqual(object["projectName"] as? String, "Demo")
    }

    func testConfigureScriptSendsANullProjectWhenThereIsNone() throws {
        let script = try XCTUnwrap(SystemBridge.configureScript(SystemBridgeConfig(theme: "dark", projectName: nil)))
        let object = try XCTUnwrap(try argumentsOf(script, prefix: "window.llmideConfigure(").first as? [String: Any])
        XCTAssertTrue(object["projectName"] is NSNull)
    }

    func testResponseScriptRoundTripsAnyBodyAndEscapesTheId() throws {
        let hostile = #"{"note":"quote \" and </script> and \\ backslash","n":3}"#
        let script = try XCTUnwrap(SystemBridge.responseScript(
            id: #"r"1"#, status: 200, body: Data(hostile.utf8), error: nil))
        let args = try argumentsOf(script, prefix: "window.llmideResponse(")
        XCTAssertEqual(args.first as? String, #"r"1"#, "the id is a JSON string, never raw text")
        let reply = try XCTUnwrap(args.dropFirst().first as? [String: Any])
        XCTAssertEqual(reply["status"] as? Int, 200)
        let body = try XCTUnwrap(reply["body"] as? [String: Any])
        XCTAssertEqual(body["note"] as? String, #"quote " and </script> and \ backslash"#)
        XCTAssertEqual(body["n"] as? Int, 3)
        XCTAssertTrue(reply["error"] is NSNull)
    }

    func testResponseScriptTurnsANonJsonBodyIntoNull() throws {
        let script = try XCTUnwrap(SystemBridge.responseScript(
            id: "r2", status: 502, body: Data("<html>bad gateway</html>".utf8), error: "HTTP 502"))
        let reply = try XCTUnwrap(try argumentsOf(script, prefix: "window.llmideResponse(").dropFirst().first as? [String: Any])
        XCTAssertTrue(reply["body"] is NSNull)
        XCTAssertEqual(reply["error"] as? String, "HTTP 502")
        XCTAssertEqual(reply["status"] as? Int, 502)
    }

    func testResponseScriptForAnUnreachableServerIsStatusZero() throws {
        let script = try XCTUnwrap(SystemBridge.responseScript(id: "r3", status: 0, body: nil, error: "unreachable"))
        let reply = try XCTUnwrap(try argumentsOf(script, prefix: "window.llmideResponse(").dropFirst().first as? [String: Any])
        XCTAssertEqual(reply["status"] as? Int, 0)
        XCTAssertTrue(reply["body"] is NSNull)
    }

    func testEventScriptCarriesOnlyTypeAndTime() throws {
        let script = try XCTUnwrap(SystemBridge.eventScript(
            SystemFeedEvent(type: "activity", at: "2026-10-26T13:56:08.000Z")))
        let object = try XCTUnwrap(try argumentsOf(script, prefix: "window.llmideEvent(").first as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["type", "at"])
        XCTAssertEqual(object["type"] as? String, "activity")
        let bare = try XCTUnwrap(SystemBridge.eventScript(SystemFeedEvent(type: "usage", at: nil)))
        let bareObject = try XCTUnwrap(try argumentsOf(bare, prefix: "window.llmideEvent(").first as? [String: Any])
        XCTAssertTrue(bareObject["at"] is NSNull)
    }

    func testStatusScriptRoundTrips() throws {
        let script = try XCTUnwrap(SystemBridge.statusScript(status: "reconnecting", detail: "a \"b\" </script>"))
        let object = try XCTUnwrap(try argumentsOf(script, prefix: "window.llmideStatus(").first as? [String: Any])
        XCTAssertEqual(object["status"] as? String, "reconnecting")
        XCTAssertEqual(object["detail"] as? String, "a \"b\" </script>")
    }

    // MARK: SSE parser

    private func events(fromChunks chunks: [String]) -> [SystemFeedEvent] {
        var parser = SystemSSEParser()
        var out: [SystemFeedEvent] = []
        for chunk in chunks { out += parser.feed(bytes: Array(chunk.utf8)) }
        return out
    }

    func testSSEParserHandlesEventsSplitAtAnyByte() {
        let stream = "event: hello\r\ndata: {\"type\":\"hello\",\"at\":\"t0\"}\r\n\r\n"
            + ": heartbeat\n\n"
            + "event: activity\ndata: {\"type\":\"activity\",\n"
            + "data: \"at\":\"t1\"}\n\n"
            + "event: usage\ndata: {\"type\":\"usage\",\"at\":\"t2\"}\n\n"
        let expected = [
            SystemFeedEvent(type: "hello", at: "t0"),
            SystemFeedEvent(type: "activity", at: "t1"),
            SystemFeedEvent(type: "usage", at: "t2"),
        ]
        // One byte at a time: the worst possible split.
        XCTAssertEqual(events(fromChunks: stream.map { String($0) }), expected)
        // And a few coarse splits, including one through the middle of a line.
        XCTAssertEqual(events(fromChunks: [String(stream.prefix(17)), String(stream.dropFirst(17))]), expected)
    }

    func testSSEParserKeepsMultiByteCharactersWhole() {
        let stream = "data: {\"type\":\"activity\",\"at\":\"2026-10-26T10:00:00Z — café\"}\n\n"
        let bytes = Array(stream.utf8)
        var parser = SystemSSEParser()
        var out: [SystemFeedEvent] = []
        for byte in bytes { out += parser.feed(bytes: [byte]) }
        XCTAssertEqual(out, [SystemFeedEvent(type: "activity", at: "2026-10-26T10:00:00Z — café")])
    }

    func testSSEParserIgnoresHeartbeatsBlankLinesAndNonEvents() {
        XCTAssertEqual(events(fromChunks: [": ping\n\n\n"]), [])
        XCTAssertEqual(events(fromChunks: ["event: only-name\n\n"]), [], "a blank line without data dispatches nothing")
        XCTAssertEqual(events(fromChunks: ["data: not json\n\n"]), [])
        XCTAssertEqual(events(fromChunks: ["data: {\"at\":\"x\"}\n\n"]), [], "an event without a type is dropped")
        XCTAssertEqual(events(fromChunks: ["data: {\"type\":\"\"}\n\n"]), [])
    }

    func testSSEParserJoinsMultiLineDataWithNewlines() {
        var parser = SystemSSEParser()
        XCTAssertNil(parser.consume(line: "data: {\"type\":"))
        XCTAssertNil(parser.consume(line: "data: \"activity\"}"))
        XCTAssertEqual(parser.consume(line: ""), SystemFeedEvent(type: "activity", at: nil))
    }

    // MARK: Backoff

    func testBackoffMatchesThePageTable() {
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 0, rateLimited: false), 1)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 1, rateLimited: false), 2)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 3, rateLimited: false), 8)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 5, rateLimited: false), 30)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 20, rateLimited: false), 30)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 0, rateLimited: true), 60)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 1, rateLimited: true), 120)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 2, rateLimited: true), 240)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 3, rateLimited: true), 300)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: 9, rateLimited: true), 300)
        XCTAssertEqual(SystemStreamBackoff.seconds(attempt: -1, rateLimited: false), 1)
    }

    // MARK: open target mapping

    func testOpenTargetsMapToSections() {
        let on: (AppFeature) -> Bool = { _ in true }
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "loop", isEnabled: on), .loopEngine)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "autoTasks", isEnabled: on), .autoCode)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "settings", isEnabled: on), .settings)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "library", isEnabled: on), .library)
    }

    func testOpenRejectsUnknownTargets() {
        let on: (AppFeature) -> Bool = { _ in true }
        XCTAssertNil(SystemBridge.section(forOpenTarget: "system", isEnabled: on))
        XCTAssertNil(SystemBridge.section(forOpenTarget: "../../etc", isEnabled: on))
    }

    func testOpenHonoursDisabledFeatures() {
        // Loop and Auto Tasks are backed by .autoTasks: disabled means ignored.
        let off: (AppFeature) -> Bool = { $0 != .autoTasks }
        XCTAssertNil(SystemBridge.section(forOpenTarget: "loop", isEnabled: off))
        XCTAssertNil(SystemBridge.section(forOpenTarget: "autoTasks", isEnabled: off))
        // Settings and Library have no backing feature, so they still open.
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "settings", isEnabled: off), .settings)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "library", isEnabled: off), .library)
    }

    // MARK: Navigation policy

    func testOnlyFilesInsideTheBundledPageDirectoryLoad() {
        let dir = URL(fileURLWithPath: "/Applications/LLM-IDE.app/Contents/Resources/os-view")
        XCTAssertTrue(SystemBridge.isLocalNavigation(
            dir.appendingPathComponent("index.html"), bundleDirectory: dir))
        XCTAssertTrue(SystemBridge.isLocalNavigation(
            dir.appendingPathComponent("assets/app.js"), bundleDirectory: dir))
    }

    func testRemoteAndOutsideNavigationsAreRefused() {
        let dir = URL(fileURLWithPath: "/Applications/LLM-IDE.app/Contents/Resources/os-view")
        XCTAssertFalse(SystemBridge.isLocalNavigation(URL(string: "https://example.com/x"), bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(URL(string: "about:blank"), bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(
            URL(fileURLWithPath: "/Users/someone/secret.txt"), bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(
            URL(fileURLWithPath: "/Applications/LLM-IDE.app/Contents/Resources/os-view/../secret.txt"),
            bundleDirectory: dir), "a parent-directory escape must not count as inside the bundle")
        XCTAssertFalse(SystemBridge.isLocalNavigation(nil, bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(
            dir.appendingPathComponent("index.html"), bundleDirectory: nil))
    }
}
