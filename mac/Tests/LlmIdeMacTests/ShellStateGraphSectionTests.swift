import XCTest
@testable import LlmIdeMacLib

/// The Graph section's page request (`GraphSectionPage.request`) and the Home
/// picker's choices (`ShellSection.homeChoices`): System is offered only as the
/// resolved Home, since it is the Graph section's default page.
@MainActor
final class ShellStateGraphSectionTests: XCTestCase {

    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "graph-section-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        defaults = nil
        super.tearDown()
    }

    // MARK: GraphSectionPage.request

    func testRequestingTheCodeGraphWritesTheKeyTheSectionReads() {
        XCTAssertEqual(GraphSectionPage.resolve(defaults.string(forKey: GraphSectionPage.storageKey) ?? ""), .system)
        GraphSectionPage.request(.code, defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: GraphSectionPage.storageKey), "code")
        XCTAssertEqual(GraphSectionPage.resolve(defaults.string(forKey: GraphSectionPage.storageKey) ?? ""), .code)
    }

    func testRequestingSystemAgainWritesSystemAndAnUnknownValueIsSystem() {
        GraphSectionPage.request(.code, defaults: defaults)
        GraphSectionPage.request(.system, defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: GraphSectionPage.storageKey), "system")
        XCTAssertEqual(GraphSectionPage.resolve("bogus"), .system)
    }

    // MARK: Home choices

    private var allFeatures: Set<AppFeature> { Set(AppFeature.allCases) }

    func testSystemIsNotOfferedWhenHomeIsSomethingElse() {
        let choices = ShellSection.homeChoices(resolved: .library, hidden: [], compiled: allFeatures)
        XCTAssertFalse(choices.contains(.system))
        XCTAssertTrue(choices.contains(.library))
        XCTAssertTrue(choices.contains(.codeGraph))
    }

    func testSystemIsOfferedWhenItIsTheResolvedHome() {
        // Graph hidden: Home resolves to System, and the picker must still show that choice.
        let resolved = ShellSection.resolveHome("codeGraph", hidden: ["codeGraph"], compiled: allFeatures)
        XCTAssertEqual(resolved, .system)
        let choices = ShellSection.homeChoices(resolved: resolved, hidden: ["codeGraph"], compiled: allFeatures)
        XCTAssertTrue(choices.contains(.system))
        XCTAssertFalse(choices.contains(.codeGraph))
    }

    func testSettingsAndLiveAreNeverOffered() {
        let choices = ShellSection.homeChoices(resolved: .library, hidden: [], compiled: allFeatures)
        XCTAssertFalse(choices.contains(.settings))
        XCTAssertFalse(choices.contains(.live))
    }

    func testHiddenAndCompiledOutSectionsAreNotOffered() {
        let choices = ShellSection.homeChoices(resolved: .library, hidden: ["explorer"],
                                               compiled: allFeatures.subtracting([.codeGraph3D]))
        XCTAssertFalse(choices.contains(.explorer))
        XCTAssertFalse(choices.contains(.codeGraph))
        XCTAssertTrue(choices.contains(.library))
    }

    func testTheResolvedHomeIsOfferedEvenWhenItWouldOtherwiseBeFiltered() {
        // A hidden choice resolves to Library; Library itself must be offered.
        let resolved = ShellSection.resolveHome("explorer", hidden: ["explorer"], compiled: allFeatures)
        let choices = ShellSection.homeChoices(resolved: resolved, hidden: ["explorer"], compiled: allFeatures)
        XCTAssertTrue(choices.contains(resolved))
    }
}
