import XCTest
@testable import LlmIdeMacLib

/// CustomAutoTask persistence — mirrors CustomProvider's shape (Codable
/// struct, UserDefaults-JSON list), with an injectable UserDefaults so
/// tests use a throwaway suite instead of touching the app's real defaults
/// (CustomProvider itself hardcodes .standard; this is a small, deliberate
/// improvement, not an unexplained deviation).
final class CustomAutoTaskTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "custom-auto-task-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testLoadAllIsEmptyByDefault() {
        XCTAssertEqual(CustomAutoTask.loadAll(from: suite), [])
    }

    func testSaveThenLoadAllRoundTrips() {
        let task = CustomAutoTask(name: "Nightly Cleanup", template: "Clean up stray branches.")
        task.save(in: suite)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.id, task.id)
        XCTAssertEqual(loaded.first?.name, "Nightly Cleanup")
        XCTAssertEqual(loaded.first?.template, "Clean up stray branches.")
        XCTAssertTrue(loaded.first?.isEnabled ?? false)
    }

    func testSaveTwiceUpsertsByIdInsteadOfDuplicating() {
        var task = CustomAutoTask(name: "Original", template: "prompt A")
        task.save(in: suite)

        task.name = "Renamed"
        task.template = "prompt B"
        task.save(in: suite)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.name, "Renamed")
        XCTAssertEqual(loaded.first?.template, "prompt B")
    }

    func testDeleteRemovesOnlyThatTask() {
        let a = CustomAutoTask(name: "A", template: "prompt A")
        let b = CustomAutoTask(name: "B", template: "prompt B")
        a.save(in: suite)
        b.save(in: suite)

        a.delete(from: suite)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.id, b.id)
    }

    func testToggleIsEnabledPersists() {
        var task = CustomAutoTask(name: "Toggle Me", template: "prompt")
        task.save(in: suite)

        task.isEnabled = false
        task.save(in: suite)

        XCTAssertEqual(CustomAutoTask.loadAll(from: suite).first?.isEnabled, false)
    }

    // MARK: - mode + cron (sub-project 2)

    func testDefaultsToReviewModeAndNilCron() {
        let t = CustomAutoTask(name: "X", template: "p")
        XCTAssertEqual(t.mode, .review)
        XCTAssertNil(t.cron)
    }

    func testModeAndCronRoundTrip() {
        var t = CustomAutoTask(name: "Refactor", template: "p")
        t.mode = .implement
        t.cron = "0 2 * * *"
        t.save(in: suite)

        let loaded = CustomAutoTask.loadAll(from: suite).first
        XCTAssertEqual(loaded?.mode, .implement)
        XCTAssertEqual(loaded?.cron, "0 2 * * *")
    }

    func testLegacyPayloadDecodesAsReviewAndNilCron() throws {
        // A payload that predates mode/cron — simulate by encoding a dict
        // without those keys.
        let legacy = """
            [{"id":"abc","name":"Old","template":"p","isEnabled":true,"createdAt":0}]
            """
        suite.data(forKey: CustomAutoTask.defaultsKey) // ensure clean
        suite.set(Data(legacy.utf8), forKey: CustomAutoTask.defaultsKey)

        let loaded = CustomAutoTask.loadAll(from: suite)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.mode, .review)
        XCTAssertNil(loaded.first?.cron)
    }
}
