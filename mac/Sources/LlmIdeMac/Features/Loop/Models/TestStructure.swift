import Foundation

public enum TestRunner: String, Codable { case xctest, nodeTest, npm, jest, pytest, goTest, cargo, make }

public struct TestRoot: Codable, Equatable {
    public var packageDir: String      // "" for repo root, "mac" for mac/Package.swift
    public var testDir: String
    public var runner: TestRunner
    public var command: String         // runnable from the repo root
    public var namingRule: String
    public var languages: [String]

    public init(packageDir: String, testDir: String, runner: TestRunner, command: String,
                namingRule: String, languages: [String]) {
        self.packageDir = packageDir; self.testDir = testDir; self.runner = runner
        self.command = command; self.namingRule = namingRule; self.languages = languages
    }
}

public struct TestStructure: Codable, Equatable {
    public var generatedAt: Date
    public var roots: [TestRoot]
    public var status: String          // "ok" | "missing"
    public var notes: [String]         // detection order; a missing-layout note starts with the package dir

    public init(generatedAt: Date, roots: [TestRoot], status: String, notes: [String]) {
        self.generatedAt = generatedAt; self.roots = roots; self.status = status; self.notes = notes
    }

    /// Longest `packageDir` prefix wins; the repo-root package ("") matches everything.
    public func testRoot(forSourcePath path: String) -> TestRoot? {
        roots.filter { $0.packageDir.isEmpty || path == $0.packageDir || path.hasPrefix($0.packageDir + "/") }
            .max { $0.packageDir.count < $1.packageDir.count }
    }

    /// TEST-STRUCTURE.md
    public func render() -> String {
        var out = "# Test structure (\(ISO8601DateFormatter().string(from: generatedAt)))\n\nstatus: \(status)\n"
        for r in roots {
            out += "\n## \(r.testDir.isEmpty ? "." : r.testDir)\n- runner: \(r.runner.rawValue)\n- command: \(r.command)\n"
            out += "- naming: \(r.namingRule)\n- languages: \(r.languages.joined(separator: ", "))\n"
        }
        out += "\n## Notes\n"
        out += notes.isEmpty ? "- none\n" : notes.map { "- \($0)\n" }.joined()
        out += "\n## Where a new test goes\n"
        for r in roots {
            let base = r.packageDir.isEmpty ? "." : r.packageDir
            let dest = r.testDir.isEmpty ? "." : r.testDir
            for ext in r.languages {
                guard let name = TestSourceMapper.testFileName(forSourcePath: "X.\(ext)") else { continue }
                out += "- `\(base)/**/X.\(ext)` → `\(dest)/\(name)`\n"
            }
        }
        return out
    }
}
