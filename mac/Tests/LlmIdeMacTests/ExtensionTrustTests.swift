// Workspace trust and the install allowlist (API 95): models decode the real
// fixtures, wording and validation rules, and the view models' flows against a
// fake API (explicit confirmation before trust, plain sentences for the 400/403
// codes, nothing sent without a click).
import XCTest
@testable import LlmIdeMacLib

private let trustFixturesDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("schema/http/fixtures/extensions")

private func trustFixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let raw = try Data(contentsOf: trustFixturesDir.appendingPathComponent(name))
    let obj = try JSONSerialization.jsonObject(with: raw) as! [String: Any]
    return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: obj["response"]!))
}

private final class FakeTrustAPI: ExtensionsTrustAPI, @unchecked Sendable {
    var trust = WorkspaceTrustList(enforced: true, items: [])
    var allowlist: ExtAllowlist
    var setTrustCalls: [(String, Bool)] = []
    var allowlistPuts: [[String]] = []
    var failure: Error?

    init() {
        allowlist = try! JSONDecoder().decode(ExtAllowlist.self, from: Data(
            #"{"operator":["anthropics/*"],"ceiling":null,"user":[],"ignored":[],"effective":["anthropics/*"]}"#.utf8))
    }

    func workspaceTrust() async throws -> WorkspaceTrustList { if let failure { throw failure }; return trust }
    func setWorkspaceTrust(path: String, trusted: Bool) async throws -> WorkspaceTrustSetResult {
        setTrustCalls.append((path, trusted))
        if let failure { throw failure }
        return WorkspaceTrustSetResult(ok: true, item: WorkspaceTrustItem(path: path, trusted: trusted, updatedAt: "now"))
    }
    func extAllowlist() async throws -> ExtAllowlist { if let failure { throw failure }; return allowlist }
    func setExtAllowlist(sources: [String]) async throws -> ExtAllowlist {
        allowlistPuts.append(sources)
        if let failure { throw failure }
        allowlist = ExtAllowlist(operator: allowlist.operator, ceiling: allowlist.ceiling, user: sources, ignored: [],
                                 effective: allowlist.operator + sources)
        return allowlist
    }
}

private func http(_ status: Int, _ code: String) -> APIError { .http(status: status, code: code, message: "server words", details: nil) }

final class ExtensionTrustDecodingTests: XCTestCase {
    func testTrustFixtures() throws {
        let empty = try trustFixture("get-auth-me-workspace-trust-200.json", as: WorkspaceTrustList.self)
        XCTAssertTrue(empty.enforced); XCTAssertTrue(empty.items.isEmpty)
        let two = try trustFixture("get-auth-me-workspace-trust-200-2.json", as: WorkspaceTrustList.self)
        XCTAssertEqual(two.items.map(\.trusted), [true, false])
        XCTAssertEqual(two.items.first?.id, "/Users/dev/project")
        let put = try trustFixture("put-auth-me-workspace-trust-200.json", as: WorkspaceTrustSetResult.self)
        XCTAssertTrue(put.ok); XCTAssertEqual(put.item.path, "/Users/dev/project")
    }

    func testAllowlistFixtures() throws {
        let plain = try trustFixture("get-auth-me-extensions-allowlist-200.json", as: ExtAllowlist.self)
        XCTAssertNil(plain.ceiling)
        XCTAssertEqual(plain.operator, ["anthropics/*", "modelcontextprotocol/*"])
        let capped = try trustFixture("get-auth-me-extensions-allowlist-200-2.json", as: ExtAllowlist.self)
        XCTAssertEqual(capped.ceiling, ["acme/*"])
        XCTAssertEqual(capped.ignored, ["evil/x"])
        XCTAssertFalse(capped.effective.contains("evil/x"))
        let put = try trustFixture("put-auth-me-extensions-allowlist-200.json", as: ExtAllowlist.self)
        XCTAssertEqual(put.user, ["acme/tools", "foo/*"])
    }

    func testWorkspaceTrustNoticeWording() {
        let n = ChatWorkspaceTrustNotice(path: "/Users/dev/app", text: "t", skipped: [
            .init(kind: "mcp-stdio", name: "db", file: ".mcp.json", withheld: true),
            .init(kind: "hooks", name: "PreToolUse", file: ".claude/settings.json", withheld: false)])
        XCTAssertTrue(WorkspaceTrustPresentation.bannerText(n).contains("db"))
        let c = WorkspaceTrustPresentation.confirmationText(n)
        XCTAssertTrue(c.contains("/Users/dev/app") && c.contains(".mcp.json") && c.contains("db"))
        XCTAssertTrue(c.contains("Hooks and plugins"))
        XCTAssertEqual(WorkspaceTrustPresentation.withheld(n).map(\.name), ["db"])
    }

    func testAllowlistNormalizeAndText() {
        XCTAssertEqual(ExtensionAllowlistText.normalize(" Acme/Tools "), "acme/tools")
        XCTAssertEqual(ExtensionAllowlistText.normalize("foo/*"), "foo/*")
        for bad in ["", "*/*", "foo", "a/b/c", "*/x", "foo bar/x", "foo/"] {
            XCTAssertNil(ExtensionAllowlistText.normalize(bad), bad)
        }
        XCTAssertTrue(ExtensionAllowlistText.message(forCode: "SOURCE_EXCEEDS_CEILING", entry: "*/*").contains("operator"))
        XCTAssertTrue(ExtensionAllowlistText.message(forCode: "TOO_MANY_SOURCES", entry: nil).contains("Remove one"))
        XCTAssertTrue(ExtensionAllowlistText.message(forCode: "INVALID_SOURCE", entry: "x").contains("owner/repo"))
        XCTAssertTrue(ExtensionAllowlistText.ceilingText(nil).contains("no limit"))
    }
}

@MainActor
final class ExtensionTrustFlowTests: XCTestCase {
    func testBannerTrustsOnlyAfterConfirmAndDropsOnError() async {
        let api = FakeTrustAPI()
        let notice = ChatWorkspaceTrustNotice(path: "/p", text: "t", skipped: [])
        let model = WorkspaceTrustBannerModel(api: api, notice: notice)
        XCTAssertTrue(api.setTrustCalls.isEmpty, "nothing is sent before an explicit click")
        let ok = await model.confirmTrust()
        XCTAssertTrue(ok)
        XCTAssertEqual(api.setTrustCalls.count, 1); XCTAssertEqual(api.setTrustCalls[0].0, "/p"); XCTAssertTrue(api.setTrustCalls[0].1)

        api.failure = http(400, "INVALID_PATH")
        let bad = WorkspaceTrustBannerModel(api: api, notice: ChatWorkspaceTrustNotice(path: "/", text: "t", skipped: []))
        let ok2 = await bad.confirmTrust()
        XCTAssertFalse(ok2)
        XCTAssertTrue(bad.errorText?.contains("too broad") == true)
    }

    func testTrustListLoadsAndSwitchOnNeedsConfirmation() async {
        let api = FakeTrustAPI()
        api.trust = WorkspaceTrustList(enforced: false, items: [WorkspaceTrustItem(path: "/a", trusted: false, updatedAt: "t")])
        let model = WorkspaceTrustListModel(api: api)
        await model.load()
        XCTAssertFalse(model.enforced); XCTAssertEqual(model.items.count, 1)
        await model.requestChange(model.items[0], trusted: true)
        XCTAssertNotNil(model.pendingTrust); XCTAssertTrue(api.setTrustCalls.isEmpty)
        await model.confirmPendingTrust()
        XCTAssertEqual(api.setTrustCalls.count, 1)
        XCTAssertTrue(model.items[0].trusted)
        await model.requestChange(model.items[0], trusted: false)
        XCTAssertNil(model.pendingTrust, "turning trust off needs no confirmation")
        XCTAssertFalse(model.items[0].trusted)
    }

    func testAllowlistAddRemoveAndErrors() async {
        let api = FakeTrustAPI()
        let model = ExtensionAllowlistModel(api: api)
        await model.load()
        model.draft = "Acme/Tools"
        await model.addDraft()
        XCTAssertEqual(api.allowlistPuts.last, ["acme/tools"])
        XCTAssertEqual(model.allowlist?.user, ["acme/tools"]); XCTAssertEqual(model.draft, "")
        model.draft = "acme/tools"
        await model.addDraft()
        XCTAssertEqual(api.allowlistPuts.count, 1, "a duplicate is not sent")
        model.draft = "*/*"
        await model.addDraft()
        XCTAssertEqual(api.allowlistPuts.count, 1, "an invalid entry is refused before the network")
        XCTAssertTrue(model.errorText?.contains("not a valid source") == true)

        api.failure = http(403, "SOURCE_EXCEEDS_CEILING")
        model.draft = "wide/*"
        await model.addDraft()
        XCTAssertTrue(model.errorText?.contains("wider than the operator allows") == true)
        XCTAssertEqual(model.draft, "wide/*", "the draft stays so the user can fix it")
        api.failure = nil
        await model.remove("acme/tools")
        XCTAssertEqual(api.allowlistPuts.last, [])
    }
}
