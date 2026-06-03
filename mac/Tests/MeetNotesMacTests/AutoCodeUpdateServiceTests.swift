import Testing
import Foundation
@testable import MeetNotesMac

// These tests cover the pure, side-effect-free helpers on AutoCodeUpdateService.
@Suite("AutoCodeUpdateService helpers")
struct AutoCodeUpdateServiceTests {

    @Test func normalizeLowercasesText() {
        #expect(NoteActionExtractor.normalize("Fix Bug") == "fix bug")
    }

    @Test func normalizeStripsPunctuation() {
        #expect(NoteActionExtractor.normalize("Fix bug: now!") == "fix bug now")
    }

    @Test func normalizeCollapsesWhitespace() {
        #expect(NoteActionExtractor.normalize("  fix   bug  ") == "fix bug")
    }

    @Test func normalizeHandlesEmpty() {
        #expect(NoteActionExtractor.normalize("") == "")
    }

    @Test func activeProjectGitHubWithTokenResolves() async throws {
        let cfg = await MainActor.run { AppConfig.shared }
        await MainActor.run { cfg.gitHubToken = "ghp_test_token_for_test" }
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let proj = stateRoot.appendingPathComponent("proj")
        try FileManager.default.createDirectory(at: proj, withIntermediateDirectories: true)

        let store = await MainActor.run {
            ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        }
        let settings = ProjectSettings(
            language: "en", activeCLI: "claudeCode",
            linkedRepo: ProjectSettings.LinkedRepo(
                kind: .github, url: "https://github.com/o/n",
                remoteId: "o/n", defaultBranch: "main"),
            notesFolderRelative: nil, enabledPlugins: [],
            uaBinaryOverride: "", regressionLookbackCount: 5,
            agentPersona: nil, docTemplatesActive: [])
        let bundle = Project(id: "T", displayName: "T", createdAt: Date(), settings: settings)
        let active = ProjectStore.ActiveProject(bundle: bundle, localPath: proj.path)
        await MainActor.run { store.setActiveForTesting(active) }

        let registry = ProcessedActionsRegistry(
            storeURL: stateRoot.appendingPathComponent("reg.json"))
        let svc = await MainActor.run {
            AutoCodeUpdateService(config: cfg, registry: registry, projectStore: store)
        }
        let resolved = await MainActor.run { svc.resolveBackendAndProject() }
        #expect(resolved?.projectId == "o/n")
        #expect(resolved?.localPath == proj.path)
    }

    @Test func activeProjectGitHubWithoutTokenReturnsNil() async throws {
        let cfg = await MainActor.run { AppConfig.shared }
        // Save+restore — clear token for the duration of this test
        let saved = await MainActor.run { cfg.gitHubToken }
        await MainActor.run { cfg.gitHubToken = "" }
        defer { Task { @MainActor in cfg.gitHubToken = saved } }

        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let proj = stateRoot.appendingPathComponent("proj")
        try FileManager.default.createDirectory(at: proj, withIntermediateDirectories: true)

        let store = await MainActor.run {
            ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        }
        let settings = ProjectSettings(
            language: "en", activeCLI: "claudeCode",
            linkedRepo: ProjectSettings.LinkedRepo(
                kind: .github, url: "https://github.com/o/n",
                remoteId: "o/n", defaultBranch: nil),
            notesFolderRelative: nil, enabledPlugins: [],
            uaBinaryOverride: "", regressionLookbackCount: 5,
            agentPersona: nil, docTemplatesActive: [])
        let bundle = Project(id: "T", displayName: "T", createdAt: Date(), settings: settings)
        let active = ProjectStore.ActiveProject(bundle: bundle, localPath: proj.path)
        await MainActor.run { store.setActiveForTesting(active) }

        let registry = ProcessedActionsRegistry(
            storeURL: stateRoot.appendingPathComponent("reg.json"))
        let svc = await MainActor.run {
            AutoCodeUpdateService(config: cfg, registry: registry, projectStore: store)
        }
        let resolved = await MainActor.run { svc.resolveBackendAndProject() }
        #expect(resolved == nil)
    }
}
