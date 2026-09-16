import Foundation
import LlmIdeMacLib

// An executable assertion gate for the Loop feature's stale-default-command
// fix (fix/loop-stale-default-command).
//
// Same rationale as chat-contract-lab / generation-contract-lab: this
// toolchain has no XCTest, so `swift test` never runs (see the Makefile's
// HAS_XCTEST guard) and `make regression` skips it entirely. `swift run`
// works regardless, so the reconciliation logic in
// `LoopStageDetector.revalidatingTestStages`/`ensureDefaultLoops` and the
// exit-127 message in `StageOutputParser.failureNote` are asserted here
// instead.
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

#if FEATURE_AUTOTASK
// Loop lives under Features/Loop, which `libExcludes` drops entirely when
// `auto_tasks` is not in LLMIDE_FEATURES (build-mac-min: agent_chat only —
// see Package.swift's `libExcludes.append(..., "Features/Loop")`). Wrapped
// in `#if` for the same reason ChatContractLab wraps its Graph block: this
// lab gets the same featureDefines as the library, so the whole thing simply
// vanishes from the reduced builds instead of failing to compile.

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

/// A stage that already carries provenance — `detectedCommand` set to
/// whatever `command` currently is, exactly what `defaultStages(forLoop:)`
/// does when it seeds a stage from detection. This is the shape a "provably
/// untouched auto-detected" stage has.
func provenancedStage(command: String, defaultKey: String? = "test") -> LoopStage {
    LoopStage(name: "Test", kind: .shellCommand, command: command, order: 0,
              isDefault: true, defaultKey: defaultKey, detectedCommand: command)
}

/// A LEGACY stage — saved before `detectedCommand` existed, so it decodes
/// with `detectedCommand == nil`. Eligible for update/removal, but only with
/// a mandatory log line (asserted separately at the `ensureDefaultLoops`
/// level is out of scope for a pure-function lab; the log call itself lives
/// in `LoopEngineConfigStore.loops`, which this lab does not exercise, since
/// it needs a real project root file. `revalidatingTestStages` returning a
/// `RevalidationChange` for the legacy-nil case, asserted below, IS what
/// makes that caller-side log possible.)
func legacyStage(command: String, defaultKey: String? = "test") -> LoopStage {
    LoopStage(name: "Test", kind: .shellCommand, command: command, order: 0,
              isDefault: true, defaultKey: defaultKey, detectedCommand: nil)
}

func testLoop(stages: [LoopStage], defaultKey: String? = LoopDefaultLoopKey.test) -> LoopDefinition {
    LoopDefinition(name: "Test", defaultKey: defaultKey, config: LoopEngineConfig(stages: stages))
}

// MARK: 1. Stale command is UPDATED to the newly detected command, only when
// provenance is provable (`command == detectedCommand`).

do {
    // This is the exact shape of the diagnosed bug: a `Test` stage that was
    // once auto-detected against a nested subproject (`pytest`) now sits in a
    // project whose real tooling is Swift. `detectedCommand` matches
    // `command` — provably untouched since it was seeded.
    let stage = provenancedStage(command: "pytest")
    let loop = testLoop(stages: [stage])
    let (result, changes) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: swiftRoot, eligibleStageIDs: [stage.id])
    expect(result.count == 1, "the loop survives when a fresh command is detected")
    expect(result.first?.config.stages.first?.command == "swift test",
           "a stale, provenance-provable test stage's command is corrected to the current detection")
    expect(result.first?.config.stages.first?.detectedCommand == "swift test",
           "detectedCommand is kept in sync with the corrected command")
    expect(changes == [LoopStageDetector.RevalidationChange(
        loopName: "Test", stageName: "Test", kind: .updated(from: "pytest", to: "swift test"))],
           "the change is reported so the caller can log it")
}

// MARK: 2. Stage REMOVED when detection now yields nothing — the LOOP itself
// is NEVER removed (it owns goal/acceptance/budgets/scopeGlobs/id that a
// recreated template loop would not have).

do {
    // The reported bug precisely: `pytest` pinned, but the real project has
    // none of the markers `detectTestCommand` looks for.
    let stage = provenancedStage(command: "pytest")
    let loop = testLoop(stages: [stage])
    let (result, changes) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: bareRoot, eligibleStageIDs: [stage.id])
    expect(result.count == 1, "a loop is NEVER removed by this pass, even when it ends up with no stages")
    expect(result.first?.id == loop.id, "the surviving loop keeps its original id (LoopRunService keys history by it)")
    expect(result.first?.config.stages.isEmpty == true, "only the undetectable stage is dropped")
    expect(changes == [LoopStageDetector.RevalidationChange(
        loopName: "Test", stageName: "Test", kind: .removed(command: "pytest"))],
           "the removal is reported so the caller can log it")
}

do {
    // The Regression loop keeps its regressionSweep stage even when its OWN
    // `regression-test` verify stage goes undetectable — only the stale
    // stage is dropped, never the whole loop, because the sweep stage is
    // untouched by this pass.
    let sweep = LoopStage(name: "Regression", kind: .regressionSweep, order: 0,
                          isDefault: true, defaultKey: "regression")
    let verify = provenancedStage(command: "pytest", defaultKey: "regression-test")
    let loop = testLoop(stages: [sweep, verify], defaultKey: LoopDefaultLoopKey.regression)
    let (result, _) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: bareRoot, eligibleStageIDs: [verify.id])
    expect(result.count == 1, "the Regression loop is not removed")
    expect(result.first?.config.stages.count == 1, "only the stale regression-test stage is dropped")
    expect(result.first?.config.stages.first?.kind == .regressionSweep,
           "the untouched Regression sweep stage remains")
}

// MARK: 3. A user-authored stage (isDefault == false) is NEVER touched.

do {
    let userStage = LoopStage(name: "E2E", kind: .shellCommand, command: "npm run e2e", order: 0,
                              isDefault: false, defaultKey: nil)
    let loop = testLoop(stages: [userStage], defaultKey: nil)
    let (result, changes) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: bareRoot, eligibleStageIDs: [userStage.id])
    expect(result.count == 1, "a user's own loop is never removed by this pass")
    expect(result.first?.config.stages.first?.command == "npm run e2e",
           "a user-authored stage's command is left exactly as they wrote it")
    expect(changes.isEmpty, "nothing is reported for a stage this pass never touches")
}

// MARK: 3b. A stage whose command was EDITED since it was seeded (provenance
// disproven: command != detectedCommand) is never touched, even though it is
// otherwise eligible (isDefault, shellCommand, keyed, in eligibleStageIDs).

do {
    var edited = provenancedStage(command: "swift test --filter Foo")
    edited.detectedCommand = "swift test"   // what detection put there originally
    let loop = testLoop(stages: [edited])
    let (result, changes) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: swiftRoot, eligibleStageIDs: [edited.id])
    expect(result.first?.config.stages.first?.command == "swift test --filter Foo",
           "a stage the user tuned after it was seeded (command != detectedCommand) is never rewritten, "
               + "even when detection still finds a command and the stage is otherwise eligible")
    expect(changes.isEmpty, "no change is reported for a stage this pass correctly leaves alone")
}

// MARK: 4. A stage NOT in `eligibleStageIDs` — i.e. it did not already carry
// this defaultKey when the config was LOADED — is never touched, even when
// every other eligibility condition (isDefault, kind, defaultKey) matches.
// This is the Critical fix: `pinning()`'s legacy kind-alone fallback can
// stamp `defaultKey` onto a user's own unkeyed stage in step 4, immediately
// before this pass would otherwise run on it.

do {
    let stage = provenancedStage(command: "pytest")
    let loop = testLoop(stages: [stage])
    // Deliberately NOT including stage.id — simulating a stage that was just
    // stamped with defaultKey="test" in this same pass, not one that already
    // held it when the config was loaded.
    let (result, changes) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: bareRoot, eligibleStageIDs: [])
    expect(result.first?.config.stages.first?.command == "pytest",
           "a stage stamped with defaultKey in THIS pass (not present in eligibleStageIDs) is left untouched")
    expect(changes.isEmpty, "nothing is reported for a stage outside the eligible set")
}

// MARK: 5. gitRoot == nil changes nothing.

do {
    let stage = provenancedStage(command: "pytest")
    let loop = testLoop(stages: [stage])
    let (result, changes) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: nil, eligibleStageIDs: [stage.id])
    expect(result.count == 1 && result.first?.config.stages.first?.command == "pytest",
           "with no resolvable git root, nothing is updated or removed — "
               + "acting on half the evidence is worse than waiting")
    expect(changes.isEmpty, "nothing is reported when gitRoot is nil")
}

// MARK: 6. Idempotent — running twice yields the same result as running once.

do {
    let stage = provenancedStage(command: "pytest")
    let loop = testLoop(stages: [stage])
    let (once, _) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: swiftRoot, eligibleStageIDs: [stage.id])
    let onceIDs = Set(once.flatMap { $0.config.stages.map(\.id) })
    let (twice, twiceChanges) = LoopStageDetector.revalidatingTestStages(
        in: once, gitRoot: swiftRoot, eligibleStageIDs: onceIDs)
    expect(once == twice, "re-running the pass on its own output is a no-op")
    expect(twiceChanges.isEmpty, "the second pass reports no changes — there is nothing left to correct")

    let (bareOnce, _) = LoopStageDetector.revalidatingTestStages(
        in: [loop], gitRoot: bareRoot, eligibleStageIDs: [stage.id])
    let bareOnceIDs = Set(bareOnce.flatMap { $0.config.stages.map(\.id) })
    let (bareTwice, bareTwiceChanges) = LoopStageDetector.revalidatingTestStages(
        in: bareOnce, gitRoot: bareRoot, eligibleStageIDs: bareOnceIDs)
    expect(bareOnce == bareTwice, "re-running the pass after a removal is also a no-op")
    expect(bareTwiceChanges.isEmpty, "nothing left to remove the second time")
}

// MARK: 7. Integration — `ensureDefaultLoops` end-to-end, driving the exact
// Critical the reviewer found: a user's own unkeyed `.shellCommand` stage in
// the Test loop gets ADOPTED by `pinning()`'s legacy kind-alone fallback
// (stamped defaultKey="test") in the very same call that would otherwise
// revalidate it. Asserting only `revalidatingTestStages` in isolation cannot
// catch this — the adoption happens one step earlier, inside
// `ensureDefaultLoops` itself. This also covers "the call site is
// unasserted": deleting the step-4.5 wiring from `ensureDefaultLoops` would
// make the FIRST integration check below fail (the user's stage doesn't stay
// "npm run e2e" for the wrong reason if 4.5 never runs — see the mutation
// test in the report), and the SECOND check independently proves the wiring
// exists at all by observing a real update happen end-to-end.

do {
    // The Test default loop already exists, but its one stage is the user's
    // own (`defaultKey == nil`) — e.g. right after a previous run's removal
    // path deleted the keyed stage and the user added their own before the
    // next load. Round 3's fix to `pinning()` means this stage's command
    // ("npm run e2e") does not match what detection produces ("swift test"),
    // so it is no longer a KIND-ALONE match at all: it is never adopted, and
    // a separate, genuinely fresh Test default is appended alongside it.
    let userStage = LoopStage(name: "E2E", kind: .shellCommand, command: "npm run e2e", order: 0,
                              isDefault: false, defaultKey: nil)
    let testLoopWithUserStage = LoopDefinition(
        name: "Test", defaultKey: LoopDefaultLoopKey.test,
        config: LoopEngineConfig(stages: [userStage]))
    let saved = LoopEngineProjectStore(loops: [testLoopWithUserStage])

    let (ensured, changes) = LoopStageDetector.ensureDefaultLoops(in: saved, gitRoot: swiftRoot)
    let testLoopResult = ensured.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }
    expect(testLoopResult?.config.stages.count == 2,
           "the user's stage is joined by a separate, genuine Test default — never merged into it")
    let mineStage = testLoopResult?.config.stages.first { $0.defaultKey == nil }
    let defaultStage = testLoopResult?.config.stages.first { $0.defaultKey == LoopDefaultLoopKey.test }
    expect(mineStage?.command == "npm run e2e" && mineStage?.isDefault == false,
           "the user's stage is completely untouched: not adopted, not renamed, not marked default — "
               + "pinning() now refuses a kind-alone match whose command isn't what detection currently produces")
    expect(defaultStage?.command == "swift test" && defaultStage?.detectedCommand == "swift test",
           "the genuinely detected Test default is appended fresh, with correct provenance from the moment "
               + "it is created — not merged into the user's differently-commanded stage")
    expect(changes.isEmpty,
           "appending a brand-new default is pinning()'s job, not revalidatingTestStages's — nothing to report")
}

do {
    // A project loaded from disk with an already-keyed, provenanced Test
    // stage whose command has genuinely gone stale — the reported bug,
    // driven through the real entry point end to end.
    let staleStage = provenancedStage(command: "pytest")
    let staleTestLoop = LoopDefinition(
        name: "Test", defaultKey: LoopDefaultLoopKey.test,
        config: LoopEngineConfig(stages: [staleStage]))
    let saved = LoopEngineProjectStore(loops: [staleTestLoop])

    let (ensured, changes) = LoopStageDetector.ensureDefaultLoops(in: saved, gitRoot: swiftRoot)
    let testLoopResult = ensured.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }
    expect(testLoopResult?.config.stages.first?.command == "swift test",
           "driven end-to-end through ensureDefaultLoops, an already-keyed stale command is still corrected — "
               + "proving step 4.5 is actually wired in, not just correct in isolation")
    expect(changes.contains(LoopStageDetector.RevalidationChange(
        loopName: "Test", stageName: "Test", kind: .updated(from: "pytest", to: "swift test"))),
           "ensureDefaultLoops surfaces the change for the caller to log")
}

// MARK: 7c. THE ROUND-2 GAP, permanently guarded. Round 2's `eligibleStageIDs`
// snapshot only protects the ONE `ensureDefaultLoops` call in which
// `pinning()` adopts a user's stage. Once that adoption round-trips through a
// save/reload, the stage carries the key AS LOADED on the next call — so
// `eligibleStageIDs` alone cannot tell a freshly-adopted user stage apart from
// a genuine legacy one on the SECOND (or any later) load. The actual fix is in
// `pinning()` itself: the kind-alone/name+kind fallback for the two test-role
// keys now requires the candidate's `command` to already equal what detection
// currently produces, so a stage whose command was never the detected one is
// never adopted in the FIRST place — no second-load gap to guard against.
// This scenario drives `ensureDefaultLoops` three times in a row (feeding each
// call's output into the next, exactly like real save → reload → save cycles)
// so a regression here fails immediately instead of surviving to a later load
// nobody happened to simulate.

do {
    let userStage = LoopStage(name: "E2E", kind: .shellCommand, command: "npm run e2e", order: 0,
                              isDefault: false, defaultKey: nil)
    let saved = LoopEngineProjectStore(loops: [LoopDefinition(
        name: "Test", defaultKey: LoopDefaultLoopKey.test, config: LoopEngineConfig(stages: [userStage]))])

    // A root where detection finds a DIFFERENT command ("swift test") — the
    // reviewer's exact attack: naively matching by kind alone would adopt
    // "npm run e2e" as the Test default, then "correct" it to "swift test".
    var current = saved
    for load in 1...3 {
        let (ensured, changes) = LoopStageDetector.ensureDefaultLoops(in: current, gitRoot: swiftRoot)
        let stage = ensured.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }?.config.stages.first
        expect(stage?.command == "npm run e2e",
               "load #\(load) (differing-command root): the user's command must never be overwritten")
        expect(stage?.defaultKey == nil,
               "load #\(load) (differing-command root): the user's stage must never be adopted as a default at all "
                   + "— that is what makes every later load safe, not a snapshot that only covers load #1")
        expect(changes.isEmpty, "load #\(load) (differing-command root): nothing to report — nothing was touched")
        current = ensured
    }

    // A root where detection finds NOTHING — same attack, `.removed` instead
    // of `.updated` is what round 2's gap would have produced.
    current = saved
    for load in 1...3 {
        let (ensured, changes) = LoopStageDetector.ensureDefaultLoops(in: current, gitRoot: bareRoot)
        let stage = ensured.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }?.config.stages.first
        expect(stage?.command == "npm run e2e",
               "load #\(load) (no-detection root): the user's command must never be removed")
        expect(stage?.defaultKey == nil,
               "load #\(load) (no-detection root): the user's stage must never be adopted as a default at all")
        expect(changes.isEmpty, "load #\(load) (no-detection root): nothing to report — nothing was touched")
        current = ensured
    }
}

// MARK: 8. `detectedCommand` round-trips through Codable, including the
// legacy nil case (a stage saved before this field existed).

do {
    let stage = provenancedStage(command: "swift test")
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    if let data = try? encoder.encode(stage), let decoded = try? decoder.decode(LoopStage.self, from: data) {
        expect(decoded.detectedCommand == "swift test", "detectedCommand round-trips through Codable")
        expect(decoded == stage, "the whole stage round-trips identically")
    } else {
        expect(false, "a LoopStage with detectedCommand set should encode and decode")
    }

    // A legacy JSON blob with no "detectedCommand" key at all — exactly what
    // every stage saved before this field existed looks like on disk.
    let legacyJSON = """
    {"id":"abc","name":"Test","kind":"shellCommand","command":"pytest","order":0,
     "isDefault":true,"enabled":true,"defaultKey":"test","severity":"blocking"}
    """
    if let data = legacyJSON.data(using: .utf8),
       let decoded = try? decoder.decode(LoopStage.self, from: data) {
        expect(decoded.detectedCommand == nil,
               "a legacy stage with no detectedCommand key decodes to nil, not a decode failure")
    } else {
        expect(false, "a legacy stage JSON blob (no detectedCommand key) must still decode")
    }
}

// MARK: 9. Exit code 127 produces a command-not-found message, asserted
// against the REAL code path `LoopEngineRunner` calls
// (`StageOutputParser.failureNote`) — not a hand-copied string.

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

    // The REAL function LoopEngineRunner.runShellStage calls to build its
    // failure note — a change to either drifts loudly instead of silently.
    let note127 = StageOutputParser.failureNote(
        exitCode: 127, command: "pytest", output: shOutput, score: nil, didTimeOut: false)
    expect(note127.text == " · command not found: \"pytest\" is not installed or not on PATH",
           "exit 127 produces the actionable command-not-found note, ahead of the failure-count logic")
    expect(note127.isUnrecognised == false,
           "exit 127 must NOT also fire the once-per-run 'failure count not recognised' side effect")

    let noteScored = StageOutputParser.failureNote(
        exitCode: 1, command: "pytest", output: "3 failed, 9 passed in 1.2s", score: 3, didTimeOut: false)
    expect(noteScored.text == " · 3 failing", "a recognised failure count still reports the count, unchanged")
    expect(noteScored.isUnrecognised == false, "a recognised runner never fires the unrecognised side effect")

    let noteTimeout = StageOutputParser.failureNote(
        exitCode: -1, command: "pytest", output: "stage timed out after 30s", score: nil, didTimeOut: true)
    expect(noteTimeout.text == " · timed out before reporting", "a timeout is reported as a timeout, not blamed on the runner's format")
    expect(noteTimeout.isUnrecognised == false, "a timeout never fires the unrecognised side effect")

    let noteUnrecognised = StageOutputParser.failureNote(
        exitCode: 1, command: "some-runner", output: "??? unrecognisable output ???", score: nil, didTimeOut: false)
    expect(noteUnrecognised.text == " · failure count not recognised",
           "a genuinely unparseable, non-127, non-timeout failure keeps the original warning")
    expect(noteUnrecognised.isUnrecognised == true,
           "and DOES fire the once-per-run side effect, unlike every case above")
}
#else
print("  skipped — Loop is excluded from this build (auto_tasks not in LLMIDE_FEATURES)")
#endif

if failures.isEmpty {
    print("loop-contract-lab: all assertions passed")
} else {
    print("loop-contract-lab: \(failures.count) FAILED")
    exit(1)
}
