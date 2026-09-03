import XCTest
@testable import LlmIdeMacLib

/// The scope guard is the only thing standing between "the agent fixed the bug"
/// and "the agent deleted the test that proved the bug". Every gap here is a way
/// for the harness to certify a regression as fixed, so the glob set, the
/// newly-dirty attribution, and the revert command are all pinned.
final class RepairScopeGuardTests: XCTestCase {

    /// Serves canned `git` output keyed by the command, so the guard's parsing and
    /// policy logic are tested without a real repository.
    private final class ScriptedVerifier: FaultVerifier, @unchecked Sendable {
        /// Successive `git status` outputs, consumed in order.
        var statusOutputs: [VerifyOutcome]
        private(set) var commands: [String] = []
        /// Set to fail every invocation, simulating a missing git / bad cwd.
        var launchError: Error?

        init(statusOutputs: [VerifyOutcome]) { self.statusOutputs = statusOutputs }

        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            commands.append(command)
            if let launchError { throw launchError }
            if command.hasPrefix("git status") {
                return statusOutputs.isEmpty
                    ? VerifyOutcome(exitCode: 0, output: "")
                    : statusOutputs.removeFirst()
            }
            return VerifyOutcome(exitCode: 0, output: "")
        }
    }

    private let gitRoot = URL(fileURLWithPath: "/repo")
    private let globs = GitRepairScopeGuard.defaultProtectedGlobs

    private func status(_ lines: [String]) -> VerifyOutcome {
        VerifyOutcome(exitCode: 0, output: lines.joined(separator: "\n"))
    }

    // MARK: - Detection

    func testEditToATestFileIsDetected() async {
        let verifier = ScriptedVerifier(statusOutputs: [
            status([]),
            status([" M mac/Tests/LlmIdeMacTests/FooTests.swift"])
        ])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)

        XCTAssertEqual(check, .violated(paths: ["mac/Tests/LlmIdeMacTests/FooTests.swift"],
                                        allChangedPaths: ["mac/Tests/LlmIdeMacTests/FooTests.swift"]))
    }

    func testEditToProductionCodeIsClean() async {
        let verifier = ScriptedVerifier(statusOutputs: [
            status([]),
            status([" M mac/Sources/LlmIdeMac/Services/Thing.swift"])
        ])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)

        XCTAssertEqual(check, .clean(changedPaths: ["mac/Sources/LlmIdeMac/Services/Thing.swift"]))
    }

    /// A NEW file counts too: "make the test pass" can mean adding a shadowing
    /// test or a conftest.py, not only editing an existing file — which is why the
    /// guard asks git for untracked files as well.
    func testNewlyAddedUntrackedTestFileIsDetected() async {
        let verifier = ScriptedVerifier(statusOutputs: [
            status([]),
            status(["?? extension/tests/sneaky.test.mjs"])
        ])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)

        guard case .violated(let paths, _) = check else {
            return XCTFail("expected a violation, got \(check)")
        }
        XCTAssertEqual(paths, ["extension/tests/sneaky.test.mjs"])
    }

    func testRenameUsesTheDestinationPath() async {
        let verifier = ScriptedVerifier(statusOutputs: [
            status([]),
            status(["R  Sources/Old.swift -> mac/Tests/Moved.swift"])
        ])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)

        guard case .violated(let paths, _) = check else {
            return XCTFail("expected a violation, got \(check)")
        }
        XCTAssertEqual(paths, ["mac/Tests/Moved.swift"])
    }

    /// Build config is protected because the stage command resolves through it: a
    /// `Makefile` whose `test:` target becomes `true` passes every stage.
    func testBuildConfigIsProtected() async {
        for path in ["Makefile", "extension/package.json", "mac/Package.swift", "pytest.ini"] {
            let verifier = ScriptedVerifier(statusOutputs: [status([]), status([" M \(path)"])])
            let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
            let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
            let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)
            guard case .violated = check else {
                return XCTFail("\(path) should be protected, got \(check)")
            }
        }
    }

    /// The harness's own state is protected: editing `faults.csv` makes a
    /// regression sweep pass without fixing anything.
    func testHarnessStateIsProtected() async {
        for path in ["system/faults.csv", "system/faults/fault-1.md", "system/loop-runs/index.jsonl"] {
            let verifier = ScriptedVerifier(statusOutputs: [status([]), status([" M \(path)"])])
            let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
            let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
            let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)
            guard case .violated = check else {
                return XCTFail("\(path) should be protected, got \(check)")
            }
        }
    }

    // MARK: - Attribution

    /// A file already dirty BEFORE the repair is the user's own edit and must not
    /// be attributed to the agent — otherwise every run started from a tree with
    /// uncommitted test changes (the normal state while developing) would be
    /// blocked, and the guard would simply get switched off.
    func testAlreadyDirtyProtectedFileIsNotAttributedToTheRepair() async {
        let verifier = ScriptedVerifier(statusOutputs: [
            status([" M mac/Tests/LlmIdeMacTests/FooTests.swift"]),
            status([" M mac/Tests/LlmIdeMacTests/FooTests.swift",
                    " M mac/Sources/LlmIdeMac/Thing.swift"])
        ])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)

        XCTAssertEqual(check, .clean(changedPaths: ["mac/Sources/LlmIdeMac/Thing.swift"]))
    }

    func testNoChangesAtAllIsClean() async {
        let verifier = ScriptedVerifier(statusOutputs: [status([]), status([])])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)
        XCTAssertEqual(check, .clean(changedPaths: []))
    }

    // MARK: - Indeterminate

    /// Never `.clean`. Reporting "no violations" when the check could not run is
    /// exactly the silent pass this mechanism exists to prevent.
    func testUnavailableGitReportsIndeterminateNotClean() async {
        let verifier = ScriptedVerifier(statusOutputs: [])
        verifier.launchError = VerifyError.launchFailed("no such directory")
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)

        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        XCTAssertFalse(before.usable)

        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)
        guard case .indeterminate = check else {
            return XCTFail("expected .indeterminate, got \(check)")
        }
    }

    func testNonZeroGitExitReportsIndeterminate() async {
        let verifier = ScriptedVerifier(statusOutputs: [
            VerifyOutcome(exitCode: 128, output: "fatal: not a git repository")
        ])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let before = await guardUnderTest.snapshot(gitRoot: gitRoot)
        let check = await guardUnderTest.check(since: before, gitRoot: gitRoot, protectedGlobs: globs)
        guard case .indeterminate = check else {
            return XCTFail("expected .indeterminate, got \(check)")
        }
    }

    // MARK: - Revert

    func testRevertRunsGitCheckoutForOnlyTheViolatingPaths() async {
        let verifier = ScriptedVerifier(statusOutputs: [])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        let revertError = await guardUnderTest.revert(
            paths: ["mac/Tests/A.swift", "Makefile"], gitRoot: gitRoot)
        XCTAssertNil(revertError)

        XCTAssertEqual(verifier.commands, ["git checkout -- 'mac/Tests/A.swift' 'Makefile'"])
    }

    /// `--` and quoting matter: without them a path that looks like a revision
    /// would be reinterpreted by git as one.
    func testRevertQuotesPathsAndSeparatesThemFromRevisions() async {
        let verifier = ScriptedVerifier(statusOutputs: [])
        let guardUnderTest = GitRepairScopeGuard(verifier: verifier)
        _ = await guardUnderTest.revert(paths: ["weird dir/it's.swift"], gitRoot: gitRoot)

        XCTAssertEqual(verifier.commands, [#"git checkout -- 'weird dir/it'\''s.swift'"#])
    }

    func testRevertWithNoPathsRunsNothing() async {
        let verifier = ScriptedVerifier(statusOutputs: [])
        let noop = await GitRepairScopeGuard(verifier: verifier).revert(paths: [], gitRoot: gitRoot)
        XCTAssertNil(noop)
        XCTAssertTrue(verifier.commands.isEmpty)
    }

    func testRevertFailureIsReported() async {
        let verifier = ScriptedVerifier(statusOutputs: [])
        verifier.launchError = VerifyError.launchFailed("git missing")
        let reason = await GitRepairScopeGuard(verifier: verifier)
            .revert(paths: ["mac/Tests/A.swift"], gitRoot: gitRoot)
        XCTAssertNotNil(reason)
    }

    // MARK: - Config wiring

    /// Extra globs are additive. A project must be able to widen the protected set
    /// but never narrow the built-ins, since those are what stop the loop
    /// certifying a deleted test as a fix.
    func testExtraProtectedGlobsAreAddedToTheDefaults() {
        let config = LoopEngineConfig(stages: [], extraProtectedGlobs: ["fixtures/**"])
        XCTAssertTrue(config.protectedGlobs.contains("fixtures/**"))
        for builtin in GitRepairScopeGuard.defaultProtectedGlobs {
            XCTAssertTrue(config.protectedGlobs.contains(builtin))
        }
    }

    // MARK: - Parser dedup (StatusParser refactor verification)

    /// Always answers exit 0 with fixed `output` — enough to drive
    /// `GitRepairScopeGuard.snapshot`'s `git status --porcelain` probe
    /// without a real git process or working tree.
    private struct FakeVerifier: FaultVerifier {
        let output: String
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            VerifyOutcome(exitCode: 0, output: output)
        }
    }

    /// The case most likely to break during a parser swap: a rename must
    /// keep only the NEW path, exactly like `StatusParser` (`SCMParsers.swift:16-18`)
    /// already does and `SCMParsersTests` already pins — the pre-fix inline
    /// parser here reimplemented the same "XY <path>" / " -> " splitting
    /// independently, so this proves the swap doesn't silently flip which
    /// side of the arrow survives.
    func testSnapshotKeepsOnlyTheNewPathForRenamesUntrackedAndPlainModifications() async {
        let porcelain = "R  old.txt -> new.txt\n M plain.txt\n?? untracked.txt\n"
        let guardService = GitRepairScopeGuard(verifier: FakeVerifier(output: porcelain))
        let snapshot = await guardService.snapshot(gitRoot: URL(fileURLWithPath: "/tmp"))
        XCTAssertTrue(snapshot.usable)
        XCTAssertEqual(snapshot.dirtyPaths, ["new.txt", "plain.txt", "untracked.txt"])
    }

    func testSnapshotUnusableWhenVerifierFails() async {
        struct FailingVerifier: FaultVerifier {
            func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
                VerifyOutcome(exitCode: 128, output: "fatal: not a git repository")
            }
        }
        let guardService = GitRepairScopeGuard(verifier: FailingVerifier())
        let snapshot = await guardService.snapshot(gitRoot: URL(fileURLWithPath: "/tmp"))
        XCTAssertFalse(snapshot.usable)
    }
}
