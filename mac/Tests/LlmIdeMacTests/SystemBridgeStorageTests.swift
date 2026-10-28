import XCTest
@testable import LlmIdeMacLib

/// The Storage calls the OS page makes over the bridge (`SystemBridge`): strict argument
/// validation, the clear two-step (a dry run, then a real clear that carries its previewId),
/// the failure shape native sends back, and the typed client's answers. Nothing reaches a
/// server: the client is given a stub fetcher.
@MainActor
final class SystemBridgeStorageTests: XCTestCase {

    // MARK: Helpers

    /// A request body as the bridge decodes it: JSON parsed by JSONSerialization, so numbers
    /// and booleans keep the NSNumber types a real page message carries.
    private func body(_ json: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    /// A reply body as an object; anything else (a null body, a refusal) is empty.
    private func parse(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
    }

    private func validate(_ method: String, _ path: String, _ json: String? = nil) -> SystemAllowedCall? {
        SystemBridge.validate(method: method, path: path, body: json.map(body))
    }

    private func clear(_ json: String) -> SystemAllowedCall? {
        validate("POST", "/kb/agent-history/clear", json)
    }

    // MARK: Settings and retention

    func testSettingsIsAPlainGet() {
        XCTAssertEqual(validate("GET", "/kb/agent-history/settings"), .agentHistorySettings)
        XCTAssertNil(validate("GET", "/kb/agent-history/settings?x=1"), "no query")
        XCTAssertNil(validate("GET", "/kb/agent-history/settings", #"{"retentionDays":30}"#), "no body")
        XCTAssertNil(validate("POST", "/kb/agent-history/settings"), "GET only")
    }

    func testRetentionAcceptsWholeDaysFrom7To365() {
        XCTAssertEqual(validate("PUT", "/kb/agent-history/settings", #"{"retentionDays":30}"#),
                       .setAgentHistoryRetention(days: 30))
        XCTAssertEqual(validate("PUT", "/kb/agent-history/settings", #"{"retentionDays":7}"#),
                       .setAgentHistoryRetention(days: 7))
        XCTAssertEqual(validate("PUT", "/kb/agent-history/settings", #"{"retentionDays":365}"#),
                       .setAgentHistoryRetention(days: 365))
    }

    func testRetentionRefusesOutOfRangeFractionalBooleanStringAndExtraKeys() {
        let refused = [
            #"{"retentionDays":6}"#, #"{"retentionDays":366}"#, #"{"retentionDays":0}"#,
            #"{"retentionDays":-7}"#, #"{"retentionDays":30.5}"#, #"{"retentionDays":true}"#,
            #"{"retentionDays":"30"}"#, #"{}"#, #"{"retentionDays":30,"rollupKeepDays":1}"#,
        ]
        for json in refused {
            XCTAssertNil(validate("PUT", "/kb/agent-history/settings", json), json)
        }
        XCTAssertNil(validate("PUT", "/kb/agent-history/settings?x=1", #"{"retentionDays":30}"#), "no query")
        XCTAssertNil(validate("PUT", "/kb/agent-history/settings"), "a body is required")
    }

    // MARK: Clear: the dry run

    func testDryRunCarriesScopeCutoffAndNoPreviewId() {
        let call = clear(#"{"scope":"raw","dryRun":true,"beforeDays":30}"#)
        XCTAssertEqual(call, .clearAgentHistory(scope: .raw, beforeDays: 30, dryRun: true, previewId: nil))
        XCTAssertEqual(SystemBridge.clearPlan(call!), .preview(scope: .raw, beforeDays: 30))
    }

    func testDryRunWithoutCutoffOrWithNullPreviewIdIsAccepted() {
        XCTAssertEqual(clear(#"{"scope":"all","dryRun":true}"#),
                       .clearAgentHistory(scope: .all, beforeDays: nil, dryRun: true, previewId: nil))
        XCTAssertEqual(clear(#"{"scope":"all","dryRun":true,"previewId":null}"#),
                       .clearAgentHistory(scope: .all, beforeDays: nil, dryRun: true, previewId: nil))
        XCTAssertEqual(clear(#"{"scope":"raw","dryRun":true,"beforeDays":0}"#),
                       .clearAgentHistory(scope: .raw, beforeDays: 0, dryRun: true, previewId: nil))
        XCTAssertEqual(clear(#"{"scope":"raw","dryRun":true,"beforeDays":3650}"#),
                       .clearAgentHistory(scope: .raw, beforeDays: 3650, dryRun: true, previewId: nil))
    }

    // MARK: Clear: the real clear passes the previewId

    func testRealClearPassesThePreviewIdOfItsDryRun() {
        let call = clear(#"{"scope":"all","dryRun":false,"previewId":"abc.DEF-1_x"}"#)
        XCTAssertEqual(call, .clearAgentHistory(scope: .all, beforeDays: nil, dryRun: false, previewId: "abc.DEF-1_x"))
        XCTAssertEqual(SystemBridge.clearPlan(call!),
                       .commit(scope: .all, beforeDays: nil, previewId: "abc.DEF-1_x"))
    }

    func testRealClearCarriesItsCutoff() {
        let call = clear(#"{"scope":"raw","dryRun":false,"beforeDays":90,"previewId":"p.1"}"#)
        XCTAssertEqual(SystemBridge.clearPlan(call!), .commit(scope: .raw, beforeDays: 90, previewId: "p.1"))
    }

    func testRealClearWithoutPreviewIdIsRefused() {
        XCTAssertNil(clear(#"{"scope":"raw","dryRun":false}"#), "a real clear needs the preview step")
        XCTAssertNil(clear(#"{"scope":"raw","dryRun":false,"previewId":null}"#))
        XCTAssertNil(clear(#"{"scope":"raw","dryRun":false,"previewId":""}"#), "an empty previewId is no previewId")
    }

    func testDryRunWithAPreviewIdIsRefused() {
        XCTAssertNil(clear(#"{"scope":"raw","dryRun":true,"previewId":"p.1"}"#))
    }

    // MARK: Clear: strict arguments

    func testClearRefusesBadScopeDryRunAndCutoff() {
        let refused = [
            #"{"scope":"everything","dryRun":true}"#, #"{"dryRun":true}"#, #"{"scope":"RAW","dryRun":true}"#,
            #"{"scope":"raw"}"#, #"{"scope":"raw","dryRun":1}"#, #"{"scope":"raw","dryRun":"true"}"#,
            #"{"scope":"raw","dryRun":true,"beforeDays":3651}"#, #"{"scope":"raw","dryRun":true,"beforeDays":-1}"#,
            #"{"scope":"raw","dryRun":true,"beforeDays":1.5}"#, #"{"scope":"raw","dryRun":true,"beforeDays":"30"}"#,
            #"{"scope":"raw","dryRun":true,"beforeDays":true}"#,
        ]
        for json in refused {
            XCTAssertNil(clear(json), json)
        }
    }

    func testClearRefusesUnknownKeysBadPreviewIdsAndOtherShapes() {
        let longId = String(repeating: "a", count: SystemBridge.maxPreviewIdLength + 1)
        let refused = [
            #"{"scope":"raw","dryRun":true,"force":true}"#,
            #"{"scope":"raw","dryRun":false,"previewId":"has space"}"#,
            #"{"scope":"raw","dryRun":false,"previewId":"quo\"te"}"#,
            #"{"scope":"raw","dryRun":false,"previewId":"a/../b"}"#,
            #"{"scope":"raw","dryRun":false,"previewId":"\#(longId)"}"#,
            #"{"scope":"raw","dryRun":false,"previewId":7}"#,
        ]
        for json in refused {
            XCTAssertNil(clear(json), json)
        }
        XCTAssertNil(validate("POST", "/kb/agent-history/clear?scope=raw", #"{"scope":"raw","dryRun":true}"#), "no query")
        XCTAssertNil(validate("POST", "/kb/agent-history/clear"), "a body is required")
        XCTAssertNil(validate("GET", "/kb/agent-history/clear", #"{"scope":"raw","dryRun":true}"#), "POST only")
        XCTAssertNil(validate("POST", "/kb/agent-history/clear/../compact", #"{"scope":"raw","dryRun":true}"#))
    }

    func testPreviewIdLengthBoundIsInclusive() {
        let max = String(repeating: "a", count: SystemBridge.maxPreviewIdLength)
        XCTAssertNotNil(clear(#"{"scope":"raw","dryRun":false,"previewId":"\#(max)"}"#))
    }

    // MARK: The body sent to the server

    func testBodyEncodesNumbersAndBooleansAsJSONValues() {
        let call = SystemAllowedCall.clearAgentHistory(scope: .raw, beforeDays: 30, dryRun: true, previewId: nil)
        XCTAssertEqual(call.body, ["scope": "raw", "dryRun": .bool(true), "beforeDays": .int(30)])
        let json = SystemBridge.jsonFragment(call.body) ?? ""
        XCTAssertTrue(json.contains("\"dryRun\":true"), json)
        XCTAssertTrue(json.contains("\"beforeDays\":30"), json)
        XCTAssertFalse(json.contains("previewId"), "a dry run sends no previewId")

        let real = SystemAllowedCall.clearAgentHistory(scope: .all, beforeDays: nil, dryRun: false, previewId: "p.1")
        XCTAssertEqual(real.body, ["scope": "all", "dryRun": .bool(false), "previewId": "p.1"])
        XCTAssertEqual(real.path, "/kb/agent-history/clear")
        XCTAssertEqual(real.method, "POST")

        XCTAssertEqual(SystemAllowedCall.setAgentHistoryRetention(days: 90).body, ["retentionDays": .int(90)])
        XCTAssertEqual(SystemAllowedCall.setAgentHistoryRetention(days: 90).method, "PUT")
        XCTAssertNil(SystemAllowedCall.agentHistorySettings.body)
        XCTAssertNil(SystemAllowedCall.compactAgentHistory.body)
    }

    // MARK: Compact

    func testCompactIsAPostWithNoQueryAndNoBody() {
        XCTAssertEqual(validate("POST", "/kb/agent-history/compact"), .compactAgentHistory)
        XCTAssertNil(validate("POST", "/kb/agent-history/compact", #"{"force":true}"#))
        XCTAssertNil(validate("POST", "/kb/agent-history/compact?full=1"))
        XCTAssertNil(validate("GET", "/kb/agent-history/compact"))
    }

    func testOnlyAgentHistoryCallsAreTypedCalls() {
        XCTAssertTrue(SystemAllowedCall.compactAgentHistory.isAgentHistory)
        XCTAssertTrue(SystemAllowedCall.agentHistorySettings.isAgentHistory)
        XCTAssertFalse(SystemAllowedCall.skillLibrary.isAgentHistory)
        XCTAssertFalse(SystemAllowedCall.state(window: "day", activity: nil).isAgentHistory)
    }

    // MARK: Failure shape

    func testFailureRepliesCarryTheServerCodeAndMessage() {
        let busy = SystemBridge.storageFailure(status: 409, code: "busy", message: "in flight")
        XCTAssertEqual(busy.status, 409)
        XCTAssertEqual(busy.error, "busy")
        XCTAssertEqual(parse(busy.bodyJSON) as NSDictionary, ["code": "busy", "message": "in flight"] as NSDictionary)

        let down = SystemBridge.storageFailure(status: 503, code: "AGENT_STORE_UNAVAILABLE", message: "down")
        XCTAssertEqual(down.status, 503)
        XCTAssertEqual(down.error, "AGENT_STORE_UNAVAILABLE")

        let disk = SystemBridge.storageFailure(status: 507, code: "disk_space", message: "full")
        XCTAssertEqual(disk.status, 507)
        XCTAssertEqual(parse(disk.bodyJSON)["code"] as? String, "disk_space")
    }

    func testOkReplyIsTheEncodedModel() throws {
        let result = try JSONDecoder().decode(LlmIdeAPIClient.AgentHistoryClearResult.self, from: Data(#"""
        {"dryRun":true,"scope":"raw","beforeDays":30,
         "wouldDelete":{"agent_runs":4,"agent_tool_events":9,"turn_composition":2,"agent_daily":1,"agent_daily_tools":3},
         "total":19,"previewId":"p.1","expiresAt":"2026-10-28T00:05:00.000Z"}
        """#.utf8))
        let reply = SystemBridge.okJSON(result)
        XCTAssertEqual(reply.status, 200)
        XCTAssertNil(reply.error)
        let object = parse(reply.bodyJSON)
        XCTAssertEqual(object["previewId"] as? String, "p.1")
        XCTAssertEqual((object["wouldDelete"] as? [String: Int])?["agent_tool_events"], 9)
        XCTAssertNil(object["deleted"], "a dry run has no deleted counts")
    }

    func testNonStorageCallsGetNoTypedReply() async {
        let api = LlmIdeAPIClient(baseURL: "http://test.invalid")
        let reply = await SystemBridge.storageReply(.skillLibrary, api: api)
        XCTAssertNil(reply)
    }

    // MARK: Typed client, end to end over a stub fetcher

    /// Records each request and answers with `answer`. A thrown error stands for no response.
    private final class Stub: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [URLRequest] = []
        let answer: @Sendable (URLRequest) throws -> (Int, String)

        init(_ answer: @escaping @Sendable (URLRequest) throws -> (Int, String)) {
            self.answer = answer
        }

        var requests: [URLRequest] {
            lock.lock(); defer { lock.unlock() }
            return seen
        }

        var fetch: LlmIdeAPIClient.DataFetcher {
            { [self] request in
                lock.lock(); seen.append(request); lock.unlock()
                let (status, text) = try answer(request)
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                               headerFields: ["Content-Type": "application/json"])!
                return (Data(text.utf8), response)
            }
        }
    }

    /// The client client holds its session weakly, so the test keeps the store alive.
    private var sessions: [SessionStore] = []

    private func signedInClient(_ stub: Stub) throws -> LlmIdeAPIClient {
        let session = SessionStore(server: "http://test-\(UUID().uuidString.lowercased()).invalid")
        session.persistRefreshToken = { _, _ in true }
        session.adopt(session: try JSONDecoder().decode(
            SessionResponse.self,
            from: Data(#"{"accessToken":"tok","refreshToken":"rt","accessTokenTTLSec":900}"#.utf8)))
        sessions.append(session)
        return LlmIdeAPIClient(baseURL: "http://test.invalid", sessionStore: session, fetchOverride: stub.fetch)
    }

    private func requestBody(_ request: URLRequest) -> [String: Any] {
        guard let data = request.httpBody else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func testDryRunIsSentWithoutPreviewIdAndAnswersThePreview() async throws {
        let stub = Stub { _ in
            (200, #"{"dryRun":true,"scope":"raw","beforeDays":30,"wouldDelete":{"agent_runs":4,"agent_tool_events":0,"turn_composition":0,"agent_daily":0,"agent_daily_tools":0},"total":4,"previewId":"p.1","expiresAt":"2026-10-28T00:05:00.000Z"}"#)
        }
        let api = try signedInClient(stub)
        let call = SystemAllowedCall.clearAgentHistory(scope: .raw, beforeDays: 30, dryRun: true, previewId: nil)
        let reply = await SystemBridge.storageReply(call, api: api)
        XCTAssertEqual(reply?.status, 200)
        XCTAssertEqual(parse(reply?.bodyJSON ?? "")["previewId"] as? String, "p.1")
        let sent = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.url?.path, "/kb/agent-history/clear")
        XCTAssertEqual(requestBody(sent)["dryRun"] as? Bool, true)
        XCTAssertNil(requestBody(sent)["previewId"])
    }

    func testRealClearSendsTheDryRunsPreviewId() async throws {
        let stub = Stub { _ in
            (200, #"{"dryRun":false,"scope":"all","beforeDays":null,"deleted":{"agent_runs":4,"agent_tool_events":0,"turn_composition":0,"agent_daily":0,"agent_daily_tools":0},"total":4}"#)
        }
        let api = try signedInClient(stub)
        let call = SystemAllowedCall.clearAgentHistory(scope: .all, beforeDays: nil, dryRun: false, previewId: "p.1")
        let reply = await SystemBridge.storageReply(call, api: api)
        XCTAssertEqual(reply?.status, 200)
        XCTAssertNotNil(parse(reply?.bodyJSON ?? "")["deleted"])
        let sent = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(requestBody(sent)["previewId"] as? String, "p.1")
        XCTAssertEqual(requestBody(sent)["dryRun"] as? Bool, false)
        XCTAssertEqual(requestBody(sent)["scope"] as? String, "all")
    }

    func testServerRefusalKeepsStatusCodeAndMessage() async throws {
        let stub = Stub { _ in (409, #"{"error":{"code":"preview_stale","message":"The history changed since the preview"}}"#) }
        let api = try signedInClient(stub)
        let call = SystemAllowedCall.clearAgentHistory(scope: .raw, beforeDays: nil, dryRun: false, previewId: "p.1")
        let reply = await SystemBridge.storageReply(call, api: api)
        XCTAssertEqual(reply?.status, 409)
        XCTAssertEqual(reply?.error, "preview_stale")
        XCTAssertEqual(parse(reply?.bodyJSON ?? "")["code"] as? String, "preview_stale")
        XCTAssertEqual(parse(reply?.bodyJSON ?? "")["message"] as? String, "The history changed since the preview")
    }

    func testCompactDiskFullAnswers507WithItsCode() async throws {
        let stub = Stub { _ in (507, #"{"error":{"code":"disk_space","message":"Not enough free disk space"}}"#) }
        let api = try signedInClient(stub)
        let reply = await SystemBridge.storageReply(.compactAgentHistory, api: api)
        XCTAssertEqual(reply?.status, 507)
        XCTAssertEqual(reply?.error, "disk_space")
        XCTAssertEqual(try XCTUnwrap(stub.requests.first).url?.path, "/kb/agent-history/compact")
    }

    func testRetentionIsSentAsAPutOfAWholeNumber() async throws {
        let stub = Stub { _ in (200, #"{"retentionDays":90,"rollupKeepDays":365,"min":7,"max":365}"#) }
        let api = try signedInClient(stub)
        let reply = await SystemBridge.storageReply(.setAgentHistoryRetention(days: 90), api: api)
        XCTAssertEqual(reply?.status, 200)
        let sent = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(sent.httpMethod, "PUT")
        XCTAssertEqual(sent.url?.path, "/kb/agent-history/settings")
        XCTAssertEqual(requestBody(sent)["retentionDays"] as? Int, 90)
    }

    func testAnUnreachableServerIsStatusZero() async throws {
        struct Down: Error {}
        let stub = Stub { _ in throw Down() }
        let api = try signedInClient(stub)
        let reply = await SystemBridge.storageReply(.agentHistorySettings, api: api)
        XCTAssertEqual(reply?.status, 0)
        XCTAssertEqual(reply?.error, "unreachable")
    }
}
