import Foundation

enum VerifyCommandBuilder {
    /// A command, runnable from the repo root, that runs ONLY `testId` with `runner` in `packageDir` ("" = root).
    /// Runners with no single-test form return `fallback` (the suite command).
    static func command(runner: TestRunner, testId: String, packageDir: String, fallback: String) -> String {
        let q = quote(testId)
        let body: String
        switch runner {
        case .xctest:
            let name = testId.firstIndex(of: ".").map { String(testId[testId.index(after: $0)...]) } ?? testId
            body = "swift test --filter \(quote(name))"
        case .nodeTest: body = "node --test --test-name-pattern \(q) tests/"
        case .jest:     body = "npx jest -t \(q)"
        case .pytest:   body = "pytest \(q)"
        case .goTest:   body = "go test ./... -run \(quote("^\(testId)$"))"
        case .cargo, .npm, .make: return fallback
        }
        return packageDir.isEmpty ? body : "cd \(packageDir) && \(body)"
    }

    private static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
