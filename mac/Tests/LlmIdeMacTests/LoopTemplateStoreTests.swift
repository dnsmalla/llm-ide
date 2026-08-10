import XCTest
@testable import LlmIdeMacLib

/// The template library is the one piece of Loop Engineering state that is
/// app-wide rather than per-project, so a persistence or identity bug here loses
/// recipes across every project at once.
@MainActor
final class LoopTemplateStoreTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        try super.setUpWithError()
        defaults = UserDefaults(suiteName: "loop-template-store-\(UUID().uuidString)")!
    }

    private func makeConfig(_ stageName: String = "Test") -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(name: stageName, kind: .shellCommand, command: "make test", order: 0)
        ], maxIterations: 5)
    }

    // MARK: - Built-ins

    func testBuiltInsAreAlwaysPresentAndListedFirst() {
        let store = LoopTemplateStore(defaults: defaults)
        XCTAssertEqual(store.templates.prefix(LoopTemplate.builtIns.count).map(\.id),
                       LoopTemplate.builtIns.map(\.id))
        XCTAssertTrue(store.customTemplates.isEmpty)
    }

    /// Built-ins are the known-good floor: a project must always be able to fall
    /// back to one, so they cannot be deleted or edited away.
    func testBuiltInsCannotBeDeletedOrUpdated() {
        let store = LoopTemplateStore(defaults: defaults)
        store.delete(id: LoopTemplate.testAndFix.id)
        XCTAssertNotNil(store.template(id: LoopTemplate.testAndFix.id))

        var edited = LoopTemplate.testAndFix
        edited.name = "Hijacked"
        store.update(edited)
        XCTAssertEqual(store.template(id: LoopTemplate.testAndFix.id)?.name, "Test & Fix")
    }

    /// Built-ins are a static constant, never persisted — otherwise an improved
    /// starter could never reach a user who had already opened the page once.
    func testBuiltInsAreNotPersisted() {
        _ = LoopTemplateStore(defaults: defaults)
        XCTAssertNil(defaults.data(forKey: "loopTemplateStore"))
    }

    // MARK: - Save

    func testSaveAddsACustomTemplate() {
        let store = LoopTemplateStore(defaults: defaults)
        let saved = store.save(name: "Mine", summary: "my loop", config: makeConfig())
        XCTAssertEqual(store.customTemplates.map(\.id), [saved.id])
        XCTAssertFalse(saved.isBuiltIn)
        XCTAssertEqual(saved.config.maxIterations, 5)
    }

    func testSaveTrimsWhitespace() {
        let store = LoopTemplateStore(defaults: defaults)
        let saved = store.save(name: "  Mine  ", summary: "  does things  ", config: makeConfig())
        XCTAssertEqual(saved.name, "Mine")
        XCTAssertEqual(saved.summary, "does things")
    }

    func testSaveWithAnEmptyNameGetsAPlaceholder() {
        let store = LoopTemplateStore(defaults: defaults)
        XCTAssertEqual(store.save(name: "   ", summary: "", config: makeConfig()).name, "Untitled loop")
    }

    /// Two rows both reading "Mine" with no way to tell them apart is a dead end
    /// for the picker, which shows only the name.
    func testDuplicateNamesAreSuffixed() {
        let store = LoopTemplateStore(defaults: defaults)
        _ = store.save(name: "Mine", summary: "", config: makeConfig())
        XCTAssertEqual(store.save(name: "Mine", summary: "", config: makeConfig()).name, "Mine 2")
        XCTAssertEqual(store.save(name: "Mine", summary: "", config: makeConfig()).name, "Mine 3")
    }

    func testNameCollisionIsCaseInsensitive() {
        let store = LoopTemplateStore(defaults: defaults)
        _ = store.save(name: "Mine", summary: "", config: makeConfig())
        XCTAssertEqual(store.save(name: "mine", summary: "", config: makeConfig()).name, "mine 2")
    }

    /// Collisions are checked against built-ins too — the picker lists both groups.
    func testNameCollidingWithABuiltInIsSuffixed() {
        let store = LoopTemplateStore(defaults: defaults)
        XCTAssertEqual(store.save(name: "Test & Fix", summary: "", config: makeConfig()).name,
                       "Test & Fix 2")
    }

    // MARK: - Update / delete / duplicate

    func testUpdateReplacesACustomTemplate() {
        let store = LoopTemplateStore(defaults: defaults)
        var saved = store.save(name: "Mine", summary: "before", config: makeConfig())
        saved.summary = "after"
        store.update(saved)
        XCTAssertEqual(store.template(id: saved.id)?.summary, "after")
    }

    func testDeleteRemovesACustomTemplate() {
        let store = LoopTemplateStore(defaults: defaults)
        let saved = store.save(name: "Mine", summary: "", config: makeConfig())
        store.delete(id: saved.id)
        XCTAssertNil(store.template(id: saved.id))
        XCTAssertTrue(store.customTemplates.isEmpty)
    }

    /// Duplicating a built-in is how a user starts from a starter and diverges —
    /// the copy must be editable even though its source was not.
    func testDuplicatingABuiltInProducesAnEditableCopy() {
        let store = LoopTemplateStore(defaults: defaults)
        let copy = store.duplicate(LoopTemplate.fullVerify)
        XCTAssertFalse(copy.isBuiltIn)
        XCTAssertNotEqual(copy.id, LoopTemplate.fullVerify.id)
        XCTAssertEqual(copy.name, "Full Verify 2")
        XCTAssertEqual(copy.config, LoopTemplate.fullVerify.config)
        store.delete(id: copy.id)
        XCTAssertNil(store.template(id: copy.id))
    }

    // MARK: - Persistence

    func testCustomTemplatesSurviveAFreshStore() {
        let first = LoopTemplateStore(defaults: defaults)
        let saved = first.save(name: "Mine", summary: "my loop", config: makeConfig("Verify"))

        let second = LoopTemplateStore(defaults: defaults)
        XCTAssertEqual(second.customTemplates.map(\.id), [saved.id])
        XCTAssertEqual(second.template(id: saved.id)?.config.stages.first?.name, "Verify")
    }

    func testDeleteIsPersisted() {
        let first = LoopTemplateStore(defaults: defaults)
        let saved = first.save(name: "Mine", summary: "", config: makeConfig())
        first.delete(id: saved.id)
        XCTAssertTrue(LoopTemplateStore(defaults: defaults).customTemplates.isEmpty)
    }

    /// A stored `isBuiltIn: true` (hand-edited defaults, or a future format change)
    /// must not be able to produce an undeletable custom template.
    func testStoredIsBuiltInFlagIsForcedFalseOnLoad() throws {
        struct StoreFile: Codable { var storeVersion = 1; var templates: [LoopTemplate] }
        var sneaky = LoopTemplate(name: "Sneaky", summary: "", config: makeConfig())
        sneaky.isBuiltIn = true
        defaults.set(try JSONEncoder().encode(StoreFile(templates: [sneaky])),
                     forKey: "loopTemplateStore")

        let store = LoopTemplateStore(defaults: defaults)
        XCTAssertEqual(store.customTemplates.first?.isBuiltIn, false)
        store.delete(id: sneaky.id)
        XCTAssertNil(store.template(id: sneaky.id))
    }

    /// Corrupt persisted data must degrade to "no custom templates", never crash —
    /// the built-ins still give the page something to offer.
    func testCorruptStoreDegradesToBuiltInsOnly() {
        defaults.set(Data("not json".utf8), forKey: "loopTemplateStore")
        let store = LoopTemplateStore(defaults: defaults)
        XCTAssertTrue(store.customTemplates.isEmpty)
        XCTAssertEqual(store.templates.count, LoopTemplate.builtIns.count)
    }
}
