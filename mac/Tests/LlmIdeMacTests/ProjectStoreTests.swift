import Testing
import Foundation
@testable import LlmIdeMac

@Suite("ProjectStore")
@MainActor
struct ProjectStoreTests {

    private func tmpRoot() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ps-test-\(UUID().uuidString)")
    }

    @Test func startsWithNoActiveAndEmptyRecents() throws {
        let root = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: root)
        #expect(store.activeProject == nil)
        #expect(store.recents.isEmpty)
    }

    @Test func opensFolderCreatesProjectAndPersists() throws {
        let root = tmpRoot()
        let proj = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: proj, withIntermediateDirectories: true)
        let defaults = ProjectSettings(
            language: "en", activeCLI: "claudeCode",
            linkedRepo: nil, notesFolderRelative: nil,
            enabledPlugins: [],
            regressionLookbackCount: 5, agentPersona: nil,
            docTemplatesActive: [])

        let store = ProjectStore(stateDirectory: root, defaults: defaults)
        try store.openFolder(at: proj)

        #expect(store.activeProject != nil)
        #expect(store.activeProject?.localPath == proj.path)
        #expect(FileManager.default.fileExists(
            atPath: proj.appendingPathComponent("system/project.json").path))

        // Persistence: a fresh store reads it back.
        let reborn = ProjectStore(stateDirectory: root, defaults: defaults)
        #expect(reborn.activeProject?.localPath == proj.path)
    }

    @Test func recentsAreSortedByLastOpenedDesc() throws {
        let root = tmpRoot()
        let a = tmpRoot(); let b = tmpRoot(); let c = tmpRoot()
        for u in [root, a, b, c] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }
        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        try store.openFolder(at: a); try store.openFolder(at: b); try store.openFolder(at: c)
        #expect(store.recents.first?.path == c.path)
        #expect(store.recents.last?.path  == a.path)
    }

    @Test func recentsCapAt20() throws {
        let root = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        for _ in 0..<25 {
            let p = tmpRoot()
            try FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
            try store.openFolder(at: p)
        }
        #expect(store.recents.count == 20)
    }

    @Test func corruptStateFileIsArchived() throws {
        let root = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let statePath = root.appendingPathComponent("projects.json")
        try "{ not json".data(using: .utf8)!.write(to: statePath)

        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        #expect(store.activeProject == nil)

        let siblings = try FileManager.default.contentsOfDirectory(atPath: root.path)
        #expect(siblings.contains(where: { $0.hasPrefix("projects.corrupt.") }))
    }

    @Test func openingSameFolderTwiceDoesNotDuplicateRecent() throws {
        let root = tmpRoot()
        let proj = tmpRoot()
        for u in [root, proj] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }
        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        try store.openFolder(at: proj)
        try store.openFolder(at: proj)
        #expect(store.recents.count == 1)
    }

    @Test func closeActiveClearsActiveProject() throws {
        let root = tmpRoot()
        let proj = tmpRoot()
        for u in [root, proj] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }
        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        try store.openFolder(at: proj)
        #expect(store.activeProject != nil)
        try store.closeActive()
        #expect(store.activeProject == nil)
        // Recents survive close — only the active flag clears.
        #expect(store.recents.count == 1)
    }

    @Test func switchToRecentReactivatesPriorProject() throws {
        let root = tmpRoot()
        let a = tmpRoot(); let b = tmpRoot()
        for u in [root, a, b] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }
        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        try store.openFolder(at: a)
        try store.openFolder(at: b)
        #expect(store.activeProject?.localPath == b.path)
        guard let aEntry = store.recents.first(where: { $0.path == a.path }) else {
            Issue.record("no recent entry for a"); return
        }
        try store.switchTo(recent: aEntry)
        #expect(store.activeProject?.localPath == a.path)
    }

    @Test func staleRecentForDeletedFolderIsPruned() throws {
        let root = tmpRoot()
        let proj = tmpRoot()
        for u in [root, proj] {
            try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        }
        do {
            let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
            try store.openFolder(at: proj)
            #expect(store.recents.count == 1)
        }
        // Delete the project folder on disk between store lifetimes.
        try FileManager.default.removeItem(at: proj)
        let reborn = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        #expect(reborn.recents.isEmpty)
        #expect(reborn.activeProject == nil)
    }

    @Test func legacyMeetnotesRecentIsPrunedOnLoad() throws {
        // Old-layout projects (only a `.meetnotes` marker, no `system/project.json`)
        // must be pruned from recents on launch — the new store only keeps entries
        // that have a valid `system/project.json`.
        let root = tmpRoot()
        let legacyProj = tmpRoot()
        let mn = legacyProj.appendingPathComponent(".meetnotes")
        try FileManager.default.createDirectory(at: mn, withIntermediateDirectories: true)
        try "{}".write(to: mn.appendingPathComponent("project.json"),
                       atomically: true, encoding: .utf8)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let state = """
        {"schemaVersion":1,"activeId":null,"recents":[
          {"id":"p1","path":"\(legacyProj.path)","displayName":"Legacy","lastOpenedAt":"2026-01-01T00:00:00Z"}
        ]}
        """
        try state.write(to: root.appendingPathComponent("projects.json"),
                        atomically: true, encoding: .utf8)

        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        // Legacy project has no `system/project.json`, so it is pruned.
        #expect(store.recents.isEmpty)
    }

    @Test func corruptStateIsSurfacedNotSilent() throws {
        let root = tmpRoot()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "{ this is not valid json".write(
            to: root.appendingPathComponent("projects.json"),
            atomically: true, encoding: .utf8)

        let store = ProjectStore(stateDirectory: root, defaults: .testDefaults)
        #expect(store.recents.isEmpty)
        #expect(store.corruptStateArchivedAt != nil)   // reset is surfaced, not silent
        store.acknowledgeCorruptState()
        #expect(store.corruptStateArchivedAt == nil)
    }
}

extension ProjectSettings {
    static let testDefaults = ProjectSettings(
        language: "en", activeCLI: "claudeCode", linkedRepo: nil,
        notesFolderRelative: nil, enabledPlugins: [],
        regressionLookbackCount: 5,
        agentPersona: nil, docTemplatesActive: [])
}
