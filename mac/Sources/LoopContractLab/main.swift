import Foundation
import LlmIdeMacLib

// An executable assertion gate for the Loop feature's stale-default-command
// fix (fix/loop-stale-default-command).
//
// Same rationale as chat-contract-lab / generation-contract-lab: this
// toolchain has no XCTest, so `swift test` never runs (see the Makefile's
// HAS_XCTEST guard) and `make regression` skips it entirely. `swift run`
// works regardless, so the reconciliation logic in
// `LoopStageDetector.revalidatingTestStages` and the exit-127 message in
// `StageOutputParser.missingCommandName` are asserted here instead.
//
// This is a SEPARATE target, so it sees only `public` symbols of
// LlmIdeMacLib — `@testable import` is test-target-only. Every type and
// member asserted below was made `public` for exactly this reason.

var failures: [String] = []

func expect(_ condition: Bool, _ label: String) {
    if condition {
        print("  ok   \(label)")
    } else {
        failures.append(label)
        print("  FAIL \(label)")
    }
}

print("loop-contract-lab")

// MARK: - Fixture helpers

/// A throwaway directory standing in for a project's git root, cleaned up
/// when the caller is done with it.
func makeTempDir() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("loop-contract-lab-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// A `gitRoot` with NO detectable test tooling — the shape of the reported
/// bug's actual project (`~/Desktop/LLM`): no Package.swift, package.json,
/// Makefile, pytest.ini, pyproject.toml, or setup.cfg.
let bareRoot = makeTempDir()

/// A `gitRoot` that IS a Swift package — `detectTestCommand` returns
/// "swift test" for it.
let swiftRoot = makeTempDir()
try? "".write(to: swiftRoot.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)

defer {
    try? FileManager.default.removeItem(at: bareRoot)
    try? FileManager.default.removeItem(at: swiftRoot)
}

func testStage(command: String, isDefault: Bool = true, defaultKey: String? = "test") -> LoopStage {
    LoopStage(name: "Test", kind: .shellCommand, command: command, order: 0,
              isDefault: isDefault, defaultKey: defaultKey)
}

func testLoop(stages: [LoopStage], defaultKey: String? = LoopDefaultLoopKey.test) -> LoopDefinition {
    LoopDefinition(name: "Test", defaultKey: defaultKey, config: LoopEngineConfig(stages: stages))
}

// MARK: 1. Stale command is UPDATED to the newly detected command.

do {
    // This is the exact shape of the diagnosed bug: a `Test` stage that was
    // once auto-detected against a nested subproject (`pytest`) now sits in a
    // project whose real tooling is Swift.
    let loop = testLoop(stages: [testStage(command: "pytest")])
    let result = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: swiftRoot)
    expect(result.count == 1, "the loop survives when a fresh command is detected")
    expect(result.first?.config.stages.first?.command == "swift test",
           "a stale isDefault test stage's command is corrected to the current detection")
}

// MARK: 2. Stage REMOVED when detection now yields nothing; empty default
// loop removed with it.

do {
    // The reported bug precisely: `pytest` pinned, but the real project has
    // none of the markers `detectTestCommand` looks for.
    let loop = testLoop(stages: [testStage(command: "pytest")])
    let result = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: bareRoot)
    expect(result.isEmpty,
           "a Test loop whose only stage goes stale-and-undetectable is removed entirely, "
               + "not left behind as a dead loop that can never succeed")
}

do {
    // The Regression loop keeps its regressionSweep stage even when its OWN
    // `regression-test` verify stage goes undetectable — only the stale
    // stage is dropped, never the whole loop, because the sweep stage is
    // untouched by this pass.
    let sweep = LoopStage(name: "Regression", kind: .regressionSweep, order: 0,
                          isDefault: true, defaultKey: "regression")
    let verify = LoopStage(name: "Test", kind: .shellCommand, command: "pytest", order: 1,
                           isDefault: true, defaultKey: "regression-test")
    let loop = testLoop(stages: [sweep, verify], defaultKey: LoopDefaultLoopKey.regression)
    let result = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: bareRoot)
    expect(result.count == 1, "the Regression loop is not removed")
    expect(result.first?.config.stages.count == 1, "only the stale regression-test stage is dropped")
    expect(result.first?.config.stages.first?.kind == .regressionSweep,
           "the untouched Regression sweep stage remains")
}

// MARK: 3. A user-authored stage (isDefault == false) with the same command
// is NEVER touched, even when it would otherwise be "stale" or "undetectable".

do {
    let userStage = testStage(command: "pytest", isDefault: false, defaultKey: nil)
    let loop = testLoop(stages: [userStage], defaultKey: nil)
    let result = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: bareRoot)
    expect(result.count == 1, "a user's own loop is never removed by this pass")
    expect(result.first?.config.stages.first?.command == "pytest",
           "a user-authored stage's command is left exactly as they wrote it, "
               + "even though the same command on a `isDefault` stage would be dropped")
}

// MARK: 4. gitRoot == nil changes nothing.

do {
    let loop = testLoop(stages: [testStage(command: "pytest")])
    let result = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: nil)
    expect(result.count == 1 && result.first?.config.stages.first?.command == "pytest",
           "with no resolvable git root, nothing is updated or removed — "
               + "acting on half the evidence is worse than waiting")
}

// MARK: 5. Idempotent — running twice yields the same result as running once.

do {
    let loop = testLoop(stages: [testStage(command: "pytest")])
    let once = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: swiftRoot)
    let twice = LoopStageDetector.revalidatingTestStages(in: once, gitRoot: swiftRoot)
    expect(once == twice, "re-running the pass on its own output is a no-op")

    let bareOnce = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: bareRoot)
    let bareTwice = LoopStageDetector.revalidatingTestStages(in: bareOnce, gitRoot: bareRoot)
    expect(bareOnce == bareTwice, "re-running the pass after a removal is also a no-op")
}

// MARK: 6. Exit code 127 produces a command-not-found message, not just
// "failure count not recognised".

do {
    let shOutput = "/bin/sh: pytest: command not found\n"
    expect(StageOutputParser.missingCommandName(in: shOutput) == "pytest",
           "the missing binary name is extracted from the sh/bash/dash phrasing")

    let shWithLine = "/bin/sh: line 1: pytest: command not found\n"
    expect(StageOutputParser.missingCommandName(in: shWithLine) == "pytest",
           "a 'line N:' segment in between does not defeat extraction")

    let zshOutput = "zsh: command not found: pytest\n"
    expect(StageOutputParser.missingCommandName(in: zshOutput) == "pytest",
           "zsh's reversed phrasing is also recognised")

    expect(StageOutputParser.missingCommandName(in: "3 failed, 9 passed in 1.2s") == nil,
           "ordinary test output is never mistaken for a command-not-found line")

    // The message LoopEngineRunner.runShellStage composes for an exit-127
    // stage failure — same format, asserted here so a change to either
    // drifts loudly instead of silently. This is exactly the bug report's
    // "failure count not recognised" note replaced with something actionable.
    let missing = StageOutputParser.missingCommandName(in: shOutput) ?? "pytest"
    let note = " · command not found: \"\(missing)\" is not installed or not on PATH"
    expect(note.contains("command not found") && note.contains("pytest"),
           "the composed note names the command and says it was not found / not on PATH")
}

if failures.isEmpty {
    print("loop-contract-lab: all assertions passed")
} else {
    print("loop-contract-lab: \(failures.count) FAILED")
    exit(1)
}
