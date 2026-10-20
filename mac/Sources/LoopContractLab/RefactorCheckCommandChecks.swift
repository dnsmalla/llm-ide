import Foundation
import LlmIdeMacLib

// `LoopStageDetector.detectCheckCommand`: the mechanical-check command (lint /
// type-check — never the test suite) the Refactoring loop's Check Baseline
// and Check stages run (design doc §3.3). Temp dirs only; no git needed.

#if FEATURE_AUTOTASK
func runRefactorCheckCommandChecks() {
    print("refactor check command detection")
    let fm = FileManager.default
    func fixture() -> URL { makeTempDir() }
    func write(_ root: URL, _ rel: String, _ text: String) {
        let url = root.appendingPathComponent(rel)
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    // (a) Makefile: both `check` and `lint` targets join in that fixed order.
    let rootA = fixture()
    defer { try? fm.removeItem(at: rootA) }
    write(rootA, "Makefile", "check:\n\tverify\nlint:\n\tlint-it\n")
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootA) == "make check && make lint",
           "a Makefile with check and lint joins them as \"make check && make lint\"")

    // (b) Makefile `lint:` wins over a package.json `lint` script — Makefile
    // is the first family checked, and a match there is exclusive.
    let rootB = fixture()
    defer { try? fm.removeItem(at: rootB) }
    write(rootB, "Makefile", "lint:\n\tlint-it\n")
    write(rootB, "package.json", #"{"scripts": {"lint": "eslint ."}}"#)
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootB) == "make lint",
           "a Makefile lint target wins over package.json's own lint script")

    // (c) package.json scripts `lint` + `type-check` join as npm run commands,
    // in that order, when the Makefile family matched nothing.
    let rootC = fixture()
    defer { try? fm.removeItem(at: rootC) }
    write(rootC, "package.json", #"{"scripts": {"lint": "eslint .", "type-check": "tsc --noEmit"}}"#)
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootC) == "npm run lint && npm run type-check",
           "package.json scripts lint + type-check join as \"npm run lint && npm run type-check\"")

    // (d) pyproject `[tool.ruff]` + `mypy.ini` join as ruff then mypy.
    let rootD = fixture()
    defer { try? fm.removeItem(at: rootD) }
    write(rootD, "pyproject.toml", "[tool.ruff]\nline-length = 100\n")
    write(rootD, "mypy.ini", "[mypy]\nstrict = True\n")
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootD) == "ruff check . && mypy .",
           "pyproject [tool.ruff] + mypy.ini join as \"ruff check . && mypy .\"")

    // (e) `[tool.mypy]` inside pyproject.toml is enough on its own (no mypy.ini).
    let rootE = fixture()
    defer { try? fm.removeItem(at: rootE) }
    write(rootE, "pyproject.toml", "[tool.mypy]\nstrict = true\n")
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootE) == "mypy .",
           "a [tool.mypy] table alone is enough to produce \"mypy .\"")

    // (f) go.mod → go vet.
    let rootF = fixture()
    defer { try? fm.removeItem(at: rootF) }
    write(rootF, "go.mod", "module example.com/x\n")
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootF) == "go vet ./...",
           "a go.mod alone produces \"go vet ./...\"")

    // (g) Package.swift only → nil (the test command already compiles everything).
    let rootG = fixture()
    defer { try? fm.removeItem(at: rootG) }
    write(rootG, "Package.swift", "// swift-tools-version: 6.0\n")
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootG) == nil,
           "a Swift-only checkout has no detected check command")

    // (h) a Makefile target hidden inside a define…endef block is ignored.
    let rootH = fixture()
    defer { try? fm.removeItem(at: rootH) }
    write(rootH, "Makefile", "define HELP\ncheck:\n\tnot a real target\nendef\nbuild:\n\tbuild-it\n")
    expect(LoopStageDetector.detectCheckCommand(gitRoot: rootH) == nil,
           "a check target inside define…endef is not a real target")

    // (i) refactorStages: both a test command and a check command insert
    // Check Baseline / Check in run order between Test Baseline/Apply and Test.
    let rootI = fixture()
    defer { try? fm.removeItem(at: rootI) }
    write(rootI, "Makefile", "test:\n\trun-tests\nlint:\n\tlint-it\n")
    let stagesI = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: rootI)
    expect(stagesI.map(\.defaultKey) == [
        "refactor-structure", "refactor-setup", "refactor-structure-check", "refactor-graph",
        "refactor-test-map", "refactor-plan", "refactor-plan-check", "refactor-test-write",
        "refactor-test-baseline", "refactor-check-baseline", "refactor-apply", "refactor-conform",
        "refactor-check", "refactor-test", "refactor-ledger", "refactor-graph-check",
    ], "a repo with both test and check tooling runs Check Baseline after Test Baseline "
        + "and Check right before the post-apply Test")
    let checkBaseline = stagesI.first { $0.defaultKey == "refactor-check-baseline" }
    expect(checkBaseline?.allowsRepair == false, "Check Baseline does not repair — a red baseline ends the run")
    expect(checkBaseline?.detectedCommand == "make lint", "Check Baseline carries its detected command")
    expect(checkBaseline?.command == "make lint", "Check Baseline's command is the detected check command")
    let check = stagesI.first { $0.defaultKey == "refactor-check" }
    expect(check?.allowsRepair == true, "Check is repairable")
    expect(check?.detectedCommand == "make lint", "Check carries its detected command")

    // (j) a test command with no check command omits both new stages.
    let rootJ = fixture()
    defer { try? fm.removeItem(at: rootJ) }
    write(rootJ, "Makefile", "test:\n\trun-tests\n")
    let stagesJ = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: rootJ)
    expect(!stagesJ.map(\.defaultKey).contains("refactor-check-baseline")
           && !stagesJ.map(\.defaultKey).contains("refactor-check"),
           "a repo with a test command but no check command gets neither new stage")
}
#endif
