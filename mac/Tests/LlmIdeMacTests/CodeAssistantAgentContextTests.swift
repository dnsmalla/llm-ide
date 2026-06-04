import Testing
import Foundation
@testable import LlmIdeMac

@Suite("CodeAssistantPanel.deriveActiveProject")
@MainActor
struct CodeAssistantAgentContextTests {

    private func makeActive(linkedRepo: ProjectSettings.LinkedRepo?,
                            displayName: String = "Test Project",
                            localPath: String = "/tmp/test") -> ProjectStore.ActiveProject {
        let settings = ProjectSettings(
            language: "en", activeCLI: "claudeCode",
            linkedRepo: linkedRepo, notesFolderRelative: nil,
            enabledPlugins: [], uaBinaryOverride: "",
            regressionLookbackCount: 5, agentPersona: nil,
            docTemplatesActive: [])
        let project = Project(id: "test-id", displayName: displayName,
                              createdAt: Date(), settings: settings)
        return ProjectStore.ActiveProject(bundle: project, localPath: localPath)
    }

    @Test func nilActiveYieldsNilProject() {
        #expect(CodeAssistantPanel.deriveActiveProject(from: nil) == nil)
    }

    @Test func activeWithoutLinkedRepoYieldsNilProject() {
        let active = makeActive(linkedRepo: nil)
        #expect(CodeAssistantPanel.deriveActiveProject(from: active) == nil)
    }

    @Test func linkedRepoMapsFieldsCorrectly() {
        let lr = ProjectSettings.LinkedRepo(
            kind: .github, url: "https://github.com/o/n",
            remoteId: "o/n", defaultBranch: "main")
        let active = makeActive(linkedRepo: lr, displayName: "My App")
        let p = CodeAssistantPanel.deriveActiveProject(from: active)
        #expect(p?.name == "My App")
        #expect(p?.url == "https://github.com/o/n")
        #expect(p?.defaultBranch == "main")
    }

    @Test func gitlabKindMapsToUrlAndBranchUnchanged() {
        let lr = ProjectSettings.LinkedRepo(
            kind: .gitlab, url: "https://gitlab.com/g/r",
            remoteId: "123", defaultBranch: nil)
        let active = makeActive(linkedRepo: lr)
        let p = CodeAssistantPanel.deriveActiveProject(from: active)
        #expect(p?.url == "https://gitlab.com/g/r")
        #expect(p?.defaultBranch == nil)
    }
}
