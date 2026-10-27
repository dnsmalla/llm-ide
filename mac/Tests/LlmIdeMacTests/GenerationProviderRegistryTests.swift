import XCTest
@testable import LlmIdeMacLib

/// The Core seam Doc Gen is reached through: the registry holds one provider
/// at a time, and the library feed is empty until Shell injects one.
@MainActor
final class GenerationProviderRegistryTests: XCTestCase {

    private final class FakeProvider: GenerationProviding {
        var signOutResets = 0
        var projectResets = 0
        func resetForSignOut() { signOutResets += 1 }
        func resetForProjectChange() { projectResets += 1 }
        func reloadProjectFiles(at projectRoot: URL?) {}
        func seedProjectFiles(at projectRoot: URL?) {}
        func templateRefs(surface: TemplateSurface) -> [GenerationTemplateRef] { [] }
        func commandRefs(surface: TemplateSurface) -> [GenerationCommandRef] { [] }
        func templateRef(id: String, surface: TemplateSurface) -> GenerationTemplateRef? { nil }
        func commandRef(id: String, surface: TemplateSurface) -> GenerationCommandRef? { nil }
        func sourceFitNotice(for result: LlmIdeAPIClient.GeneratedDoc, sentCount: Int) -> String? { nil }
    }

    func testNoProviderUntilInstalled() {
        let registry = GenerationProviderRegistry()
        XCTAssertNil(registry.provider)
    }

    func testInstallMakesProviderActive() {
        let registry = GenerationProviderRegistry()
        let fake = FakeProvider()
        registry.install(fake)
        XCTAssertTrue(registry.provider === fake)
    }

    func testUninstallRemovesProvider() {
        let registry = GenerationProviderRegistry()
        registry.install(FakeProvider())
        registry.uninstall()
        XCTAssertNil(registry.provider)
    }

    func testReinstallReplacesEarlierProvider() {
        let registry = GenerationProviderRegistry()
        let first = FakeProvider()
        let second = FakeProvider()
        registry.install(first)
        registry.install(second)
        XCTAssertTrue(registry.provider === second)
        registry.provider?.resetForSignOut()
        XCTAssertEqual(second.signOutResets, 1)
        XCTAssertEqual(first.signOutResets, 0)
    }

    func testEmptyLibraryFeedListsNothing() {
        XCTAssertTrue(LibrarySourceFeed.empty.items(.code).isEmpty)
    }
}
