import Foundation
import LlmIdeMacLib

// `RefactorRulesCollector.digest`: the deterministic RULES.md the Refactoring
// loop's plan/apply stages read first. Temp dirs only; no git needed.

#if FEATURE_AUTOTASK
func runRefactorRulesChecks() {
    print("refactor rules digest")
    let fm = FileManager.default
    func fixture() -> URL { makeTempDir() }
    func write(_ root: URL, _ rel: String, _ text: String) {
        let url = root.appendingPathComponent(rel)
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }
    func position(_ text: String, _ needle: String) -> Int? {
        text.range(of: needle).map { text.distance(from: text.startIndex, to: $0.lowerBound) }
    }

    // (a) order: root CLAUDE.md, nested AGENTS.md, .claude/rules
    let rootA = fixture()
    defer { try? fm.removeItem(at: rootA) }
    write(rootA, "CLAUDE.md", "root rules")
    write(rootA, "sub/AGENTS.md", "sub rules")
    write(rootA, ".claude/rules/a.md", "rule a")
    let digestA = RefactorRulesCollector.digest(gitRoot: rootA, inputPath: "sub", checkCommand: nil, testCommand: nil)
    let pa = position(digestA, "### CLAUDE.md")
    let pb = position(digestA, "### sub/AGENTS.md")
    let pc = position(digestA, "### .claude/rules/a.md")
    expect(pa != nil && pb != nil && pc != nil && pa! < pb! && pb! < pc!,
           "digest lists root CLAUDE.md, then sub/AGENTS.md, then .claude/rules/a.md")
    expect(digestA.contains("root rules") && digestA.contains("sub rules") && digestA.contains("rule a"),
           "digest quotes each source verbatim")

    // (b) linked docs: only rule-like names
    let rootB = fixture()
    defer { try? fm.removeItem(at: rootB) }
    write(rootB, "CLAUDE.md", "See [x](docs/explanation/invariants.md) and [y](docs/other.md)")
    write(rootB, "docs/explanation/invariants.md", "INVARIANT BODY")
    write(rootB, "docs/other.md", "OTHER BODY")
    let digestB = RefactorRulesCollector.digest(gitRoot: rootB, inputPath: ".", checkCommand: nil, testCommand: nil)
    expect(digestB.contains("INVARIANT BODY"), "a linked invariants doc is included")
    expect(!digestB.contains("OTHER BODY"), "a linked doc with a non-rule name is excluded")

    // (c) per-source cap
    let rootC = fixture()
    defer { try? fm.removeItem(at: rootC) }
    write(rootC, "CLAUDE.md", (1...500).map { "line \($0)" }.joined(separator: "\n"))
    let digestC = RefactorRulesCollector.digest(gitRoot: rootC, inputPath: ".", checkCommand: nil, testCommand: nil)
    expect(digestC.contains("line 200") && !digestC.contains("line 201"),
           "a 500-line source is cut at 200 lines")
    expect(digestC.contains("truncated"), "a cut source is marked truncated")

    // (d) nothing found
    let rootD = fixture()
    defer { try? fm.removeItem(at: rootD) }
    let digestD = RefactorRulesCollector.digest(gitRoot: rootD, inputPath: ".", checkCommand: nil, testCommand: nil)
    expect(digestD.contains("No project rule files found"), "an empty project says no rule files were found")

    // (e) tooling presence
    let rootE = fixture()
    defer { try? fm.removeItem(at: rootE) }
    write(rootE, "pyproject.toml", "[tool.ruff]\nline-length = 100\n")
    let digestE = RefactorRulesCollector.digest(gitRoot: rootE, inputPath: ".", checkCommand: nil, testCommand: nil)
    expect(digestE.contains("Tooling present") && digestE.contains("ruff"),
           "a [tool.ruff] table lists ruff under Tooling present")

    // (f) check command
    let digestF = RefactorRulesCollector.digest(gitRoot: rootD, inputPath: ".", checkCommand: "make lint", testCommand: "make test")
    expect(digestF.contains("Checks the loop runs") && digestF.contains("make lint") && digestF.contains("make test"),
           "the check and test commands are listed")

    // (g) symlink leaving the root is skipped
    let outside = fixture()
    let rootG = fixture()
    defer { try? fm.removeItem(at: outside); try? fm.removeItem(at: rootG) }
    write(outside, "secret.md", "OUTSIDE SECRET")
    try? fm.createSymbolicLink(at: rootG.appendingPathComponent("CLAUDE.md"),
                               withDestinationURL: outside.appendingPathComponent("secret.md"))
    let digestG = RefactorRulesCollector.digest(gitRoot: rootG, inputPath: ".", checkCommand: nil, testCommand: nil)
    expect(!digestG.contains("OUTSIDE SECRET"), "a CLAUDE.md symlinked outside the repo is skipped")

    // A fence-closing marker inside a source must not end the quote early.
    let rootH = fixture()
    defer { try? fm.removeItem(at: rootH) }
    write(rootH, "CLAUDE.md", "before\n```\ninside\n```\nafter")
    let digestH = RefactorRulesCollector.digest(gitRoot: rootH, inputPath: ".", checkCommand: nil, testCommand: nil)
    expect(digestH.contains("````\nbefore"), "the fence is longer than any backtick run in the source")
}
#endif
