import Combine
import XCTest
@testable import LlmIdeMacLib

/// The on-disk half of Auto Task templates: seeding, CRUD, and the rename that
/// moves a file and reports its new id.
@MainActor
final class AutoTaskTemplateStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("auto-task-templates-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        root = nil
        try super.tearDownWithError()
    }

    private var templatesDir: URL { ProjectLayout(root: root).autoTaskTemplatesDir }

    func testBindingWithNoProjectLeavesTheListEmpty() {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: nil)
        XCTAssertTrue(store.templates.isEmpty)
        XCTAssertFalse(store.hasProject)
    }

    /// A fresh project gets the starter prompts, so the picker is never an
    /// empty list with no way forward.
    func testFirstBindSeedsTheStarterTemplates() {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        XCTAssertEqual(store.templates.count, AutoTaskTemplateStore.seeds.count)
        XCTAssertTrue(store.templates.contains { $0.name == "Review Code" })
        XCTAssertTrue(FileManager.default.fileExists(atPath: templatesDir.path))
    }

    /// Deleting every template must stay deleted — re-seeding on the next
    /// project open would resurrect prompts the user removed on purpose.
    func testEmptiedFolderIsNotReseeded() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        for template in store.templates { XCTAssertTrue(store.delete(id: template.id)) }
        XCTAssertTrue(store.templates.isEmpty)

        let reopened = AutoTaskTemplateStore()
        reopened.bindProject(root: root)
        XCTAssertTrue(reopened.templates.isEmpty)
    }

    func testCreateWritesAFileAndReturnsIt() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly API Review", body: "Audit the API."))
        XCTAssertEqual(created.id, "nightly-api-review")
        XCTAssertEqual(created.body, "Audit the API.")

        let onDisk = try String(
            contentsOf: templatesDir.appendingPathComponent("nightly-api-review.md"),
            encoding: .utf8)
        XCTAssertTrue(onDisk.contains("Audit the API."))
    }

    func testCreateWithADuplicateNameGetsASuffixedId() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        _ = store.create(name: "Nightly", body: "One.")
        let second = try XCTUnwrap(store.create(name: "Nightly", body: "Two."))
        XCTAssertEqual(second.id, "nightly-2")
        XCTAssertEqual(store.template(id: "nightly")?.body, "One.")
    }

    func testUpdateRewritesTheBodyAndKeepsTheName() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Old."))
        XCTAssertTrue(store.update(id: created.id, body: "New."))
        XCTAssertEqual(store.template(id: created.id)?.body, "New.")
        XCTAssertEqual(store.template(id: created.id)?.name, "Nightly")
    }

    func testUpdateOnUnknownIdFails() {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        XCTAssertFalse(store.update(id: "nope", body: "x"))
    }

    func testRenameMovesTheFileAndReportsTheNewId() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        var reported: (String, String?)?
        store.onTemplateIdChanged = { reported = ($0, $1) }

        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Body."))
        let newId = try XCTUnwrap(store.rename(id: created.id, to: "Weekly Sweep"))

        XCTAssertEqual(newId, "weekly-sweep")
        XCTAssertEqual(reported?.0, "nightly")
        XCTAssertEqual(reported?.1, "weekly-sweep")
        XCTAssertEqual(store.template(id: newId)?.body, "Body.")
        XCTAssertNil(store.template(id: "nightly"))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: templatesDir.appendingPathComponent("nightly.md").path))
    }

    /// A capitalization-only rename maps to the same slug, so the id — and
    /// every config referencing it — must be left alone.
    func testRenameToTheSameSlugKeepsTheIdAndDoesNotNotify() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        var notified = false
        store.onTemplateIdChanged = { _, _ in notified = true }

        let created = try XCTUnwrap(store.create(name: "nightly sweep", body: "Body."))
        let newId = try XCTUnwrap(store.rename(id: created.id, to: "Nightly Sweep"))

        XCTAssertEqual(newId, created.id)
        XCTAssertFalse(notified)
        XCTAssertEqual(store.template(id: newId)?.name, "Nightly Sweep")
    }

    func testRenameToABlankNameIsRejected() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Body."))
        XCTAssertNil(store.rename(id: created.id, to: "   "))
        XCTAssertNotNil(store.template(id: created.id))
    }

    func testDeleteRemovesTheFileAndNotifiesWithNil() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        var reported: (String, String?)?
        store.onTemplateIdChanged = { reported = ($0, $1) }

        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Body."))
        XCTAssertTrue(store.delete(id: created.id))

        XCTAssertNil(store.template(id: created.id))
        XCTAssertEqual(reported?.0, "nightly")
        XCTAssertNil(reported?.1)
    }

    // MARK: - Drafts
    //
    // The unsaved draft lives here, not in the editor's @State, because the
    // Auto Task detail pane reuses one view tree across tasks — view state was
    // discarded on every sidebar click.

    func testEditorTextFallsBackToTheSavedBody() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        XCTAssertEqual(store.editorText(for: created.id), "Saved.")
        XCTAssertFalse(store.hasDraft(for: created.id))
    }

    func testSetDraftMakesTheTemplateDirty() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("Edited.", for: created.id)
        XCTAssertTrue(store.hasDraft(for: created.id))
        XCTAssertEqual(store.editorText(for: created.id), "Edited.")
    }

    /// Typing back to the saved text clears the draft, so "Unsaved" disappears
    /// instead of persisting against identical content.
    func testDraftMatchingTheSavedBodyIsNotDirty() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("Edited.", for: created.id)
        store.setDraft("Saved.", for: created.id)
        XCTAssertFalse(store.hasDraft(for: created.id))
    }

    /// The exact stuck-"Unsaved" case: a trailing newline is normalized away by
    /// `render`, so it must not count as an edit either.
    func testTrailingNewlineIsNotADraft() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("Saved.\n", for: created.id)
        XCTAssertFalse(store.hasDraft(for: created.id))
        store.setDraft("\n\nSaved.\n\n", for: created.id)
        XCTAssertFalse(store.hasDraft(for: created.id))
    }

    /// …but the text is still STORED verbatim, so the editor's binding round
    /// trips. Refusing to store it made pressing Return at the end of an
    /// unmodified prompt do nothing at all — the editor looked frozen.
    func testEditorTextRoundTripsWhateverWasTyped() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Review."))
        for typed in ["Review.\n", "Review.\n\n", "\nReview.", "Review.X\n", ""] {
            store.setDraft(typed, for: created.id)
            XCTAssertEqual(store.editorText(for: created.id), typed)
        }
    }

    func testSavingClearsTheDraft() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("Edited.\n", for: created.id)
        XCTAssertTrue(store.update(id: created.id, body: "Edited.\n"))
        XCTAssertFalse(store.hasDraft(for: created.id))
        XCTAssertEqual(store.template(id: created.id)?.body, "Edited.")
    }

    func testDiscardDraftRestoresTheSavedBody() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("Edited.", for: created.id)
        store.discardDraft(for: created.id)
        XCTAssertEqual(store.editorText(for: created.id), "Saved.")
    }

    /// A rename writes the SAVED body, so an in-progress edit has to travel to
    /// the new id or renaming would silently throw it away.
    func testRenameCarriesTheDraftToTheNewId() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("Edited.", for: created.id)
        let newId = try XCTUnwrap(store.rename(id: created.id, to: "Weekly"))
        XCTAssertEqual(store.editorText(for: newId), "Edited.")
        XCTAssertFalse(store.hasDraft(for: created.id))
    }

    /// A rescan is not an edit — the store keeps the draft the user is typing.
    func testReloadKeepsAnInProgressDraft() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("", for: created.id)   // cleared on purpose
        store.reload()
        XCTAssertEqual(store.editorText(for: created.id), "")
    }

    /// Drafts are keyed by a slug that only means something inside one project.
    func testDraftsDoNotSurviveAProjectSwitch() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Saved."))
        store.setDraft("Edited.", for: created.id)
        store.bindProject(root: nil)
        store.bindProject(root: root)
        XCTAssertFalse(store.hasDraft(for: created.id))
    }

    /// `templatesDidChange` exists so observers that do real work (the mobile
    /// bridge runs two directory scans and pushes a snapshot) are not woken by
    /// a keystroke or by a rescan that found nothing new.
    func testTemplatesDidChangeFiresOnlyForRealChanges() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Body."))

        var announcements = 0
        let subscription = store.templatesDidChange.sink { announcements += 1 }
        defer { subscription.cancel() }

        store.reload()
        XCTAssertEqual(announcements, 0, "a rescan finding the same files is not a change")

        store.setDraft("typing…", for: created.id)
        XCTAssertEqual(announcements, 0, "an unsaved keystroke is not a template change")

        _ = store.create(name: "Another", body: "x")
        XCTAssertEqual(announcements, 1)
    }

    // MARK: - Duplicate / external writers

    func testDuplicateCopiesTheBodyUnderANewId() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Body."))
        let copy = try XCTUnwrap(store.duplicate(id: created.id))
        XCTAssertNotEqual(copy.id, created.id)
        XCTAssertEqual(copy.body, "Body.")
        XCTAssertEqual(copy.name, "Nightly Copy")
    }

    /// `write` overwrites, so slug uniqueness has to be decided against DISK,
    /// not the in-memory list: a `git pull` (or the paired iPhone) can add a
    /// file the store has not scanned yet, and creating over it would destroy
    /// someone else's template.
    func testCreateDoesNotOverwriteAnUnscannedFile() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        try AutoTaskTemplate.render(name: "Nightly", body: "Theirs.")
            .write(to: templatesDir.appendingPathComponent("nightly.md"),
                   atomically: true, encoding: .utf8)
        // Deliberately NOT reloading — the store's list is stale, as it would
        // be moments after an external write.

        let created = try XCTUnwrap(store.create(name: "Nightly", body: "Mine."))
        XCTAssertEqual(created.id, "nightly-2")
        XCTAssertEqual(store.template(id: "nightly")?.body, "Theirs.")
    }

    /// A prompt written into the folder by hand shows up on the next scan.
    func testReloadPicksUpAnExternallyWrittenFile() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)
        try "Hand written.".write(
            to: templatesDir.appendingPathComponent("hand-written.md"),
            atomically: true, encoding: .utf8)
        store.reload()
        XCTAssertEqual(store.template(id: "hand-written")?.body, "Hand written.")
    }

    /// Doc Gen scans `templates/*/template.md`; the Auto Task folder sits
    /// inside `templates/` and must not surface there as a document template.
    func testDocTemplateScanSkipsTheAutoTaskFolder() throws {
        let store = AutoTaskTemplateStore()
        store.bindProject(root: root)

        let docStore = DocTemplateStore()
        docStore.reloadProjectTemplates(at: root)
        XCTAssertTrue(docStore.projectTemplates.isEmpty)
    }
}
