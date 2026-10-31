// Extensions catalog screen: the models decode the real server fixtures
// (schema/http/fixtures/extensions), the presentation rules, and the view
// model's flows against a fake API (consent before enable, update preview →
// consent → apply, error hints, no network on load).
import XCTest
@testable import LlmIdeMacLib

private let fixturesDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("schema/http/fixtures/extensions")

private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let raw = try Data(contentsOf: fixturesDir.appendingPathComponent(name))
    let obj = try JSONSerialization.jsonObject(with: raw) as! [String: Any]
    let body = try JSONSerialization.data(withJSONObject: obj["response"]!)
    return try JSONDecoder().decode(T.self, from: body)
}

final class ExtensionsCatalogDecodingTests: XCTestCase {
    func testInstalledList() throws {
        let list = try fixture("get-auth-me-extensions-installed-200-2.json", as: ExtInstalledList.self)
        XCTAssertFalse(list.corrupt)
        XCTAssertEqual(list.items.map(\.id), ["plugin:acme/runner", "plugin:acme/sketchy", "skill:acme/tidy"])
        XCTAssertEqual(list.items[0].members.first?.memberId, "skill:a")
        XCTAssertEqual(list.items[1].scan.count, 3)
        XCTAssertEqual(list.items[1].scan.findings.first?.rule, "pipe_to_shell")
        XCTAssertNil(list.items[1].version)
    }

    func testCatalogPageAndInstalledFlag() throws {
        let page = try fixture("get-auth-me-extensions-catalog-200-2.json", as: ExtCatalogPage.self)
        XCTAssertEqual(page.results.first?.source.path, "skills/pdf")
        XCTAssertEqual(page.results.first?.installed, .no)
        XCTAssertEqual(page.sources.count, 4)
        let yes = try JSONDecoder().decode(ExtInstalledRef.self, from: Data("\"skill:a/b\"".utf8))
        XCTAssertEqual(yes, .yes(id: "skill:a/b"))
        XCTAssertTrue(yes.isInstalled)
    }

    func testUpdatePreviewAndResults() throws {
        let p = try fixture("post-auth-me-extensions-update-preview-200.json", as: ExtUpdatePreview.self)
        XCTAssertEqual(p.executable.newKinds, ["hook"])
        XCTAssertTrue(p.consent.required)
        XCTAssertEqual(p.files.counts.added, 2)
        XCTAssertTrue(p.flags.contains("new_findings"))
        let u = try fixture("post-auth-me-extensions-update-200.json", as: ExtUpdateResult.self)
        XCTAssertEqual(u.update.reason, "consent_required")
        XCTAssertFalse(u.update.enabled)
        XCTAssertEqual(u.item.previous?.version, "1.0.0")
        let r = try fixture("post-auth-me-extensions-rollback-200.json", as: ExtRollbackResult.self)
        XCTAssertEqual(r.rollback.to.prefix(1), "e")
        let rep = try fixture("post-auth-me-extensions-repair-200-restored.json", as: ExtRepairResult.self)
        XCTAssertEqual(rep.status, "restored")
        XCTAssertEqual(rep.was, "corrupt")
    }

    func testRemainingFixtures() throws {
        _ = try fixture("get-auth-me-extensions-active-200.json", as: ExtActiveView.self)
        let upd = try fixture("get-auth-me-extensions-updates-200-2.json", as: ExtUpdateList.self)
        XCTAssertEqual(upd.items.count, 2)
        let chk = try fixture("post-auth-me-extensions-updates-check-200.json", as: ExtUpdateCheckResult.self)
        XCTAssertEqual(chk.results.filter(\.updateAvailable).count, 2)
        XCTAssertEqual(chk.results.compactMap(\.error), ["not_found"])
        let ref = try fixture("post-auth-me-extensions-catalog-refresh-200.json", as: ExtRefreshResult.self)
        XCTAssertEqual(ref.results.count, 4)
        _ = try fixture("post-auth-me-extensions-install-200.json", as: ExtInstallResult.self)
        _ = try fixture("post-auth-me-extensions-toggle-200-members.json", as: ExtToggleResult.self)
    }
}

final class ExtensionsCatalogPresentationTests: XCTestCase {
    func testGroupingOrderAndNames() throws {
        let items = try fixture("get-auth-me-extensions-installed-200-2.json", as: ExtInstalledList.self).items
        let g = ExtensionsCatalogPresentation.grouped(items)
        XCTAssertEqual(g.map(\.kind), ["skill", "plugin"])
        XCTAssertEqual(g[1].items.map(\.name), ["runner", "sketchy"])
    }

    func testRepoNameAndShortCommit() {
        XCTAssertEqual(ExtensionsCatalogPresentation.repoName("https://github.com/acme/runner.git"), "acme/runner")
        XCTAssertEqual(ExtensionsCatalogPresentation.repoName("https://example.com/x"), "https://example.com/x")
        XCTAssertEqual(ExtensionsCatalogPresentation.shortCommit(String(repeating: "a", count: 40)).count, 8)
    }

    func testErrorHints() {
        let allowed = ExtensionsCatalogPresentation.message(forCode: "SOURCE_NOT_ALLOWED", serverMessage: "x")
        XCTAssertTrue(allowed.contains("LLMIDE_EXT_ALLOWED_SOURCES"))
        XCTAssertTrue(ExtensionsCatalogPresentation.message(forCode: "CATALOG_DISABLED", serverMessage: "").contains("turned off"))
        XCTAssertEqual(ExtensionsCatalogPresentation.message(forCode: "WHATEVER", serverMessage: "boom"), "boom")
    }

    func testConsentLinesNameWhatRuns() {
        let members = [ExtInstalledItem.Member(memberId: "hook:Stop", type: "hook", name: "Stop", executable: true)]
        let lines = ExtensionsCatalogPresentation.consentLines(kinds: ["mcp", "hook"], members: members, permissions: [])
        XCTAssertEqual(lines.map(\.kind), ["hook", "mcp"])
        XCTAssertTrue(lines[0].detail.contains("Declared: Stop"))
    }

    func testCatalogStates() {
        let empty = ExtCatalogSource(id: "a", title: "A", kind: "k", status: "empty", count: 0, fetchedAt: nil)
        let fresh = ExtCatalogSource(id: "b", title: "B", kind: "k", status: "fresh", count: 1, fetchedAt: "t")
        XCTAssertTrue(ExtensionsCatalogPresentation.catalogNeverFetched([empty]))
        XCTAssertFalse(ExtensionsCatalogPresentation.catalogNeverFetched([empty, fresh]))
        XCTAssertTrue(ExtensionsCatalogPresentation.reasonText("package_launcher").contains("Browse only"))
    }
}

/// A scripted API: records calls, returns canned items.
private final class FakeExtAPI: ExtensionsCatalogAPI, @unchecked Sendable {
    var installed: [ExtInstalledItem]
    var calls: [String] = []
    var consentsSeen: [[String]?] = []
    var previewResult: ExtUpdatePreview?
    var failWith: Error?
    init(installed: [ExtInstalledItem]) { self.installed = installed }

    private func note(_ s: String) throws { calls.append(s); if let e = failWith { throw e } }
    func extInstalled() async throws -> ExtInstalledList { try note("installed"); return ExtInstalledList(corrupt: false, items: installed) }
    func extInstall(url: String, ref: String?, commit: String?, path: String?) async throws -> ExtInstallResult {
        try note("install"); return ExtInstallResult(ok: true, alreadyInstalled: nil, item: installed[0])
    }
    func extToggle(id: String, enabled: Bool, consents: [String]?) async throws -> ExtToggleResult {
        try note("toggle"); consentsSeen.append(consents)
        return ExtToggleResult(ok: true, item: withEnabled(id, enabled))
    }
    func extToggleMembers(id: String, members: [String], enabled: Bool) async throws -> ExtToggleResult {
        try note("members"); return ExtToggleResult(ok: true, item: installed[0])
    }
    func extUninstall(id: String) async throws { try note("uninstall") }
    func extUpdates() async throws -> ExtUpdateList { try note("updates"); return ExtUpdateList(corrupt: false, items: []) }
    func extCheckUpdates(id: String?) async throws -> ExtUpdateCheckResult {
        try note("check"); return ExtUpdateCheckResult(checkedAt: "t", results: [])
    }
    func extPreviewUpdate(id: String, commit: String?) async throws -> ExtUpdatePreview { try note("preview"); return previewResult! }
    func extApplyUpdate(id: String, commit: String?, consents: [String]?) async throws -> ExtUpdateResult {
        try note("apply"); consentsSeen.append(consents)
        return ExtUpdateResult(ok: true, item: installed[0],
                               update: ExtUpdateSummary(from: "a", to: "b", enabled: true, wasEnabled: true, reason: nil, kinds: []))
    }
    func extRollback(id: String) async throws -> ExtRollbackResult { throw APIError.noSession }
    func extRepair(id: String) async throws -> ExtRepairResult { throw APIError.noSession }
    func extCatalog(query: String, kind: String?, limit: Int, offset: Int) async throws -> ExtCatalogPage {
        try note("catalog"); return ExtCatalogPage(query: query, total: 0, offset: 0, results: [], sources: [])
    }
    func extRefreshCatalog(source: String?) async throws -> ExtRefreshResult { try note("refresh"); return ExtRefreshResult(results: []) }

    private func withEnabled(_ id: String, _ on: Bool) -> ExtInstalledItem {
        let i = installed[0]
        return ExtInstalledItem(id: i.id, kind: i.kind, name: i.name, description: i.description, version: i.version,
                                publisher: i.publisher, source: i.source, subpath: nil, pinnedCommit: i.pinnedCommit,
                                installedAt: i.installedAt, members: i.members, declared: i.declared,
                                permissions: i.permissions, scan: i.scan, consents: [:], integrity: nil, storeDir: nil,
                                updatedAt: nil, update: nil, previous: nil,
                                state: .init(enabled: on, disabledMembers: []))
    }
}

@MainActor
final class ExtensionsCatalogModelTests: XCTestCase {
    private func runnerItem() throws -> ExtInstalledItem {
        try fixture("get-auth-me-extensions-installed-200-2.json", as: ExtInstalledList.self).items[0]
    }

    private func withHook(_ i: ExtInstalledItem) -> ExtInstalledItem {
        ExtInstalledItem(id: i.id, kind: i.kind, name: i.name, description: i.description, version: i.version,
                         publisher: i.publisher, source: i.source, subpath: nil, pinnedCommit: i.pinnedCommit,
                         installedAt: i.installedAt, members: i.members, declared: .init(executableKinds: ["hook"]),
                         permissions: i.permissions, scan: i.scan, consents: [:], integrity: nil, storeDir: nil,
                         updatedAt: nil, update: nil, previous: nil, state: i.state)
    }

    func testLoadReadsOnlyTheInstalledList() async throws {
        let api = FakeExtAPI(installed: [try runnerItem()])
        let model = ExtensionsCatalogModel(api: api)
        await model.loadInstalled()
        XCTAssertEqual(api.calls, ["installed"])
        XCTAssertEqual(model.items.count, 1)
    }

    func testEnableWithoutExecutableKindsTogglesDirectly() async throws {
        let api = FakeExtAPI(installed: [try runnerItem()])
        let model = ExtensionsCatalogModel(api: api)
        await model.loadInstalled()
        await model.requestEnable(model.items[0])
        XCTAssertNil(model.pendingConsent)
        XCTAssertEqual(api.calls, ["installed", "toggle"])
        XCTAssertTrue(model.items[0].state.enabled)
    }

    func testEnableWithHookNeedsConsentThenSendsKinds() async throws {
        let item = withHook(try runnerItem())
        let api = FakeExtAPI(installed: [item])
        let model = ExtensionsCatalogModel(api: api)
        await model.loadInstalled()
        await model.requestEnable(item)
        XCTAssertEqual(model.pendingConsent?.kinds, ["hook"])
        XCTAssertEqual(api.calls, ["installed"], "nothing is sent before the user consents")
        await model.confirmConsent()
        XCTAssertEqual(api.consentsSeen.last ?? nil, ["hook"])
        XCTAssertNil(model.pendingConsent)
    }

    func testUpdatePreviewNeedingConsentGoesThroughConsentThenApplies() async throws {
        let item = try runnerItem()
        let api = FakeExtAPI(installed: [item])
        api.previewResult = try fixture("post-auth-me-extensions-update-preview-200.json", as: ExtUpdatePreview.self)
        let model = ExtensionsCatalogModel(api: api)
        await model.loadInstalled()
        await model.openPreview(item)
        XCTAssertNotNil(model.preview)
        await model.applyPreview()
        XCTAssertNil(model.preview)
        XCTAssertEqual(model.pendingConsent?.kinds, ["hook"])
        XCTAssertFalse(api.calls.contains("apply"))
        await model.confirmConsent()
        XCTAssertTrue(api.calls.contains("apply"))
        XCTAssertEqual(api.consentsSeen.last ?? nil, ["hook"])
    }

    func testSourceNotAllowedShowsAllowlistHint() async throws {
        let api = FakeExtAPI(installed: [try runnerItem()])
        api.failWith = APIError.http(status: 403, code: "SOURCE_NOT_ALLOWED", message: "no", details: nil)
        let model = ExtensionsCatalogModel(api: api)
        model.installURL = "https://github.com/acme/runner"
        await model.install()
        XCTAssertTrue(model.noticeIsError)
        XCTAssertTrue(model.notice?.contains("LLMIDE_EXT_ALLOWED_SOURCES") == true)
        XCTAssertNil(model.lastInstall)
    }

    func testCatalogDisabledSetsOffState() async throws {
        let api = FakeExtAPI(installed: [try runnerItem()])
        api.failWith = APIError.http(status: 404, code: "CATALOG_DISABLED", message: "off", details: nil)
        let model = ExtensionsCatalogModel(api: api)
        await model.refreshCatalog()
        XCTAssertTrue(model.catalogOff)
    }

    func testBrowseSearchIsACachedReadOnly() async throws {
        let api = FakeExtAPI(installed: [try runnerItem()])
        let model = ExtensionsCatalogModel(api: api)
        await model.search()
        XCTAssertEqual(api.calls, ["catalog"])
        XCTAssertTrue(model.browseLoaded)
    }
}
