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
            body = "swift test --filter \(quote(rx(name)))"
        case .nodeTest:
            let leaf = testId.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? testId
            body = "node --test --test-name-pattern \(quote("^" + rx(leaf) + "$")) tests/"
        case .jest:     body = "npx jest -t \(quote(rx(testId)))"
        case .pytest:   body = "pytest \(q)"
        case .goTest:   body = "go test ./... -run \(quote("^" + rx(testId) + "$"))"
        case .cargo, .npm, .make: return fallback
        }
        return packageDir.isEmpty ? body : "cd \(packageDir) && \(body)"
    }

    /// Escape regex metacharacters (`/` stays literal).
    private static func rx(_ s: String) -> String {
        var out = ""
        for ch in s {
            if ".+*?()[]{}|^$\\".contains(ch) { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    private static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
