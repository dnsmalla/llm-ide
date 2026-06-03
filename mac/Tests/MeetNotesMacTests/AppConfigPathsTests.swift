import Testing
import Foundation
@testable import MeetNotesMac

/// Pin AppConfig's path-resolution behaviour. The clone fix in
/// GitLab/GitHub depends on `resolvedClonesURL` returning the
/// expected URL — these tests guarantee it.
@MainActor
struct AppConfigPathsTests {

    /// Build an AppConfig backed by an isolated UserDefaults suite so
    /// tests can't pollute / read real production defaults.
    private func makeConfig() -> AppConfig {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppConfig(userDefaults: defaults)
    }

    @Test func dataRootURLIsNilWhenUnset() {
        let c = makeConfig()
        #expect(c.dataRootURL == nil)
        #expect(c.resolvedClonesURL == nil)
        #expect(c.resolvedNotesURL == nil)
    }

    @Test func dataRootURLExpandsTilde() {
        let c = makeConfig()
        c.dataRoot = "~/MeetNotes"
        let home = NSHomeDirectory()
        #expect(c.dataRootURL?.path == "\(home)/MeetNotes")
    }

    @Test func resolvedClonesURLJoinsRootAndSubdir() {
        let c = makeConfig()
        c.dataRoot = "/tmp/workspace"
        c.clonesSubdir = "Clones"
        #expect(c.resolvedClonesURL?.path == "/tmp/workspace/Clones")
    }

    @Test func resolvedClonesURLHandlesNestedSubdir() {
        let c = makeConfig()
        c.dataRoot = "/tmp/workspace"
        c.clonesSubdir = "Repos/Code"
        // appendingPathComponent treats the whole string as one
        // segment, which is fine for our use — Finder shows
        // /tmp/workspace/Repos/Code regardless.
        #expect(c.resolvedClonesURL?.path == "/tmp/workspace/Repos/Code")
    }

    @Test func resolvedNotesURLFollowsDataRoot() {
        let c = makeConfig()
        c.dataRoot = "/Users/dinsmallade/Desktop/meet-note_folders"
        c.notesSubdir = "Notes"
        #expect(c.resolvedNotesURL?.path == "/Users/dinsmallade/Desktop/meet-note_folders/Notes")
    }

    @Test func allResolvedSubfoldersContainsAllFour() {
        let c = makeConfig()
        c.dataRoot = "/tmp/ws"
        let urls = c.allResolvedSubfolders
        let names = Set(urls.map { $0.lastPathComponent })
        #expect(names.contains("Notes"))
        #expect(names.contains("Docs"))
        #expect(names.contains("Clones"))
        #expect(names.contains("InfiniteBrain"))
        #expect(urls.count == 4)
    }

    @Test func emptyDataRootSuppressesAllResolved() {
        let c = makeConfig()
        c.dataRoot = ""
        #expect(c.allResolvedSubfolders.isEmpty)
    }

    @Test func whitespaceDataRootSuppressesAllResolved() {
        let c = makeConfig()
        c.dataRoot = "   "
        #expect(c.dataRootURL == nil)
        #expect(c.allResolvedSubfolders.isEmpty)
    }
}

/// Pins AppConfig.defaultProjectSettings — the snapshot ProjectStore
/// uses to materialise `<folder>/.meetnotes/project.json` on first
/// open. Each AppConfig field that flows into the bundle gets one
/// assertion so future renames break the test instead of silently
/// dropping a default.
@MainActor
struct AppConfigDefaultProjectSettingsTests {

    private func makeConfig() -> AppConfig {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppConfig(userDefaults: defaults)
    }

    @Test func defaultProjectSettingsMirrorsAppConfig() {
        let cfg = makeConfig()
        let snap = cfg.defaultProjectSettings
        // AppConfig has no global language field — snapshot uses "".
        #expect(snap.language == "")
        #expect(snap.activeCLI == cfg.activeCLI)
        #expect(snap.uaBinaryOverride == cfg.uaBinaryOverride)
        #expect(snap.regressionLookbackCount == cfg.autoCodeUpdateLookbackCount)
        #expect(snap.linkedRepo == nil)
        #expect(snap.notesFolderRelative == nil)
        #expect(snap.enabledPlugins.isEmpty)
        #expect(snap.agentPersona == nil)
        #expect(snap.docTemplatesActive.isEmpty)
    }
}
