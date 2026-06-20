import Testing
import Foundation
@testable import LlmIdeMac

struct ProjectLayoutTests {
    private let root = URL(fileURLWithPath: "/tmp/proj")
    private var L: ProjectLayout { ProjectLayout(root: root) }

    @Test func userFoldersAreUnderRoot() {
        #expect(L.sourceDir.path == "/tmp/proj/source")
        #expect(L.codeDir.path   == "/tmp/proj/code")
        #expect(L.dataDir.path   == "/tmp/proj/data")
        #expect(L.notesDir.path  == "/tmp/proj/notes")
    }
    @Test func systemPathsAreUnderSystem() {
        #expect(L.systemDir.path   == "/tmp/proj/system")
        #expect(L.projectJSON.path == "/tmp/proj/system/project.json")
        #expect(L.faultsDir.path   == "/tmp/proj/system/faults")
        #expect(L.graphDir.path    == "/tmp/proj/system/graph")
        #expect(L.indexDB.path     == "/tmp/proj/system/index.sqlite")
        #expect(L.syncJSON.path    == "/tmp/proj/system/sync.json")
        #expect(L.cacheDir.path    == "/tmp/proj/system/cache")
    }
    @Test func userFoldersListMirrorsLibrarySections() {
        let names = ProjectLayout.userFolders.map(\.name)
        #expect(names == ["source", "code", "data", "notes"])
        let cats = ProjectLayout.userFolders.map(\.category)
        #expect(cats == [.meetings, .code, .data, .notes])
    }
}
