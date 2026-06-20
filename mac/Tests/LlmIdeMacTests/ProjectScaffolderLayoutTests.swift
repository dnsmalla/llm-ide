import Testing
import Foundation
@testable import LlmIdeMac

struct ProjectScaffolderLayoutTests {
    private func tmp() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("scaf-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    private func makeProject(_ root: URL) -> Project {
        Project(id: "test-id", displayName: "Test",
                createdAt: Date(timeIntervalSince1970: 0),
                settings: ProjectStore.fallbackDefaults)
    }

    @Test func scaffoldCreatesNewLayout() throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try ProjectScaffolder.scaffold(at: root, project: makeProject(root))
        let fm = FileManager.default
        for d in ["source", "code", "data", "notes", "system", "system/faults", "system/graph", "system/cache"] {
            var isDir: ObjCBool = false
            #expect(fm.fileExists(atPath: root.appendingPathComponent(d).path, isDirectory: &isDir) && isDir.boolValue)
        }
        for d in ["meetings", "plans", "assets", ".llmide", ".understand-anything", ".code-notes"] {
            #expect(!fm.fileExists(atPath: root.appendingPathComponent(d).path))
        }
    }

    @Test func validateAcceptsNewMarkerAndEmpty_rejectsOldLayout() throws {
        let fm = FileManager.default
        let empty = try tmp(); defer { try? fm.removeItem(at: empty) }
        #expect(throws: Never.self) { try ProjectScaffolder.validate(at: empty) }

        let marked = try tmp(); defer { try? fm.removeItem(at: marked) }
        try fm.createDirectory(at: marked.appendingPathComponent("system"), withIntermediateDirectories: true)
        try "{}".write(to: marked.appendingPathComponent("system/project.json"), atomically: true, encoding: .utf8)
        #expect(throws: Never.self) { try ProjectScaffolder.validate(at: marked) }

        let old = try tmp(); defer { try? fm.removeItem(at: old) }
        for d in ["meetings", "notes", "plans"] { try fm.createDirectory(at: old.appendingPathComponent(d), withIntermediateDirectories: true) }
        #expect(throws: (any Error).self) { try ProjectScaffolder.validate(at: old) }
    }
}
