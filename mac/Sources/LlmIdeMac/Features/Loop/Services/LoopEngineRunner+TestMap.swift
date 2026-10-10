import Foundation

// The Test loop's `.testMap` stage and the writer's create-only guard, kept out
// of LoopEngineRunner.swift (already ~2,800 lines). Run state (`testStructure`,
// `testMapBefore`, `lastVerifyOutputs`) lives on the runner; extensions cannot
// hold stored properties.
extension LoopEngineRunner {

    // MARK: - Stage

    func runTestMapStage(_ stage: LoopStage, gitRoot: URL, stages: [LoopStage]) async -> StageDecision {
        let startedAt = Date()
        // Reads use the run's tree; outputs, ledger, faults and approvals live under
        // the main checkout (`system/` is gitignored, so a worktree would lose them).
        let mainRoot = currentRunContext?.mainGitRoot ?? gitRoot
        switch stage.testOp {
        case .structure:
            let structure = await Task.detached(priority: .utility) { () -> TestStructure in
                let detector = TestStructureDetector(gitRoot: gitRoot)
                let found = detector.detect()
                _ = try? detector.write(found, outputRoot: mainRoot)
                return found
            }.value
            testStructure = structure
            for root in structure.roots {
                appendLog(.info, "  [\(stage.name)] \(root.testDir.isEmpty ? "." : root.testDir) · \(root.runner.rawValue) · \(root.command)")
            }
            if structure.status == "missing" {
                appendLog(.info, "  [\(stage.name)] no test structure found — the Setup stage will create one")
            }
            // Setup already ran this run but nothing detectable came of it: fail, so
            // an empty Setup cannot pass as "structure created".
            let setupRan = stages.contains { $0.isTestSetup && lastSkillResults[$0.id] != nil }
            if setupRan, structure.status == "missing" {
                let message = "Test Setup ran but no test runner/folder was detected — see TEST-STRUCTURE.md notes"
                appendLog(.error, "  [\(stage.name)] \(message)")
                return finishTestMap(stage, startedAt: startedAt, passed: false, output: message)
            }
            return finishTestMap(stage, startedAt: startedAt, passed: true, output: "")

        case .map:
            let structure: TestStructure
            if let known = testStructure { structure = known } else {
                structure = await Task.detached(priority: .utility) { TestStructureDetector(gitRoot: gitRoot).detect() }.value
                testStructure = structure
            }
            let built: TestMap
            do {
                built = try await Task.detached(priority: .utility) { () throws -> TestMap in
                    let builder = TestMapBuilder(gitRoot: gitRoot, structure: structure)
                    let map = try builder.build()
                    _ = try builder.write(map, outputRoot: mainRoot)
                    return map
                }.value
            } catch {
                appendLog(.error, "  [\(stage.name)] could not build the test map: \(error.localizedDescription)")
                return finishTestMap(stage, startedAt: startedAt, passed: false, output: error.localizedDescription)
            }
            appendLog(.info, "  [\(stage.name)] \(built.untestedFunctions) untested / \(built.testedFunctions) tested function(s)")
            guard let before = testMapBefore else {
                testMapBefore = built
                return finishTestMap(stage, startedAt: startedAt, passed: true, output: "")
            }
            let delta = TestMap.delta(before: before, after: built)
            let writer = stages.first { $0.enabled && $0.testWriteOnly }
            let wrote = writer.flatMap { lastSkillResults[$0.id] }.map { !($0.changedPaths + $0.createdPaths).isEmpty } ?? false
            if wrote, (delta["untestedFunctions"] ?? 0) >= 0 {
                let message = "Test Write changed files but untestedFunctions did not fall"
                appendLog(.warn, "  [\(stage.name)] \(message)")
                return finishTestMap(stage, startedAt: startedAt, passed: false, output: message, delta: delta)
            }
            return finishTestMap(stage, startedAt: startedAt, passed: true, output: "", delta: delta)

        case .ledger:
            return await runLedgerOp(stage, startedAt: startedAt, gitRoot: mainRoot, stages: stages)

        case nil:
            stageStates[stage.id] = .failed
            return .terminate(.error("Stage \"\(stage.name)\" has no operation chosen"))
        }
    }

    /// Records the attempt and settles the stage state. A failed `.testMap`
    /// stage honours severity: advisory proceeds, blocking ends the run.
    private func finishTestMap(_ stage: LoopStage, startedAt: Date, passed: Bool, output: String,
                               delta: [String: Double]? = nil, newFaults: [String]? = nil) -> StageDecision {
        stageStates[stage.id] = passed ? .passed : .failed
        record(stage, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt),
               exitCode: nil, passed: passed, output: output, score: nil)
        if (delta != nil || newFaults != nil), !iterationRecords.isEmpty {
            let last = iterationRecords.count - 1
            if let a = iterationRecords[last].attempts.indices.last {
                iterationRecords[last].attempts[a].testMapDelta = delta
                iterationRecords[last].attempts[a].newFaults = newFaults
            }
        }
        if passed || stage.severity == .advisory { return .proceed }
        return .terminate(.error(output))
    }

    /// Hands a blocking shell stage's pending FAILING output to the enabled ledger
    /// stage positioned after it (the normal position is never reached once the
    /// stage fails), recording faults with `runPassed = false`. Runs at most once
    /// per shell attempt.
    func flushFailureLedger(stages: [LoopStage]) async {
        guard let pending = pendingFailureLedger else { return }
        pendingFailureLedger = nil
        guard let index = stages.firstIndex(where: { $0.id == pending.stageId }),
              let ledger = stages[(index + 1)...].first(where: {
                  $0.enabled && $0.kind == .testMap && $0.testOp == .ledger }) else { return }
        let mainRoot = currentRunContext?.mainGitRoot ?? pending.gitRoot
        _ = await runLedgerOp(ledger, startedAt: Date(), gitRoot: mainRoot, stages: stages,
                              failing: (pending.stageId, pending.output))
    }

    /// `failing` is a failed attempt's output handed in directly (see
    /// `flushFailureLedger`); otherwise the nearest PRECEDING enabled blocking
    /// shell stage in `stages` is the Test stage the ledger reads.
    func runLedgerOp(_ stage: LoopStage, startedAt: Date, gitRoot: URL, stages: [LoopStage],
                     failing: (stageId: String, output: String)? = nil) async -> StageDecision {
        let source: (stageId: String, output: String, passed: Bool)
        if let failing {
            source = (failing.stageId, failing.output, false)
            ledgerRecordedKeys.insert("\(failing.stageId)#\(shellAttemptSeq[failing.stageId] ?? 0)")
        } else {
            let position = stages.firstIndex { $0.id == stage.id } ?? stages.endIndex
            guard let testStage = stages[..<position].last(where: { $0.enabled && $0.verifies }),
                  let attempt = iterationRecords.last?.attempts.last(where: {
                      $0.stageId == testStage.id && $0.kind == .shellCommand }),
                  let output = lastVerifyOutputs[testStage.id] else {
                appendLog(.info, "  [\(stage.name)] no Test stage ran this iteration — ledger unchanged")
                return finishTestMap(stage, startedAt: startedAt, passed: true, output: "")
            }
            if ledgerRecordedKeys.contains("\(testStage.id)#\(shellAttemptSeq[testStage.id] ?? 0)") {
                appendLog(.info, "  [\(stage.name)] this attempt's failures were already recorded — ledger unchanged")
                return finishTestMap(stage, startedAt: startedAt, passed: true, output: "")
            }
            source = (testStage.id, output, attempt.passed)
        }
        let output = source.output
        let suiteCommand = stages.first { $0.id == source.stageId }?.command ?? ""
        let extraction = TestFailureExtractor.extract(output)
        let passing = Self.passingTestIds(output)
        let runPassed = source.passed
        let structure = testStructure
        let runId = currentRunContext?.runId ?? UUID().uuidString
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        let approvals = self.approvals
        let result: (RegressionFaultSync.Outcome, [String])? = await Task.detached(priority: .utility) {
            do {
                let previous = TestLedger.load(gitRoot: gitRoot)
                let diff = TestLedger.diff(previous: previous, currentFailing: extraction.ids,
                                           currentPassing: passing, runPassed: runPassed)
                var root: TestRoot? = structure?.roots.first
                if let loc = extraction.locations.first, let file = loc.split(separator: ":").first.map(String.init) {
                    let base = gitRoot.path.hasSuffix("/") ? gitRoot.path : gitRoot.path + "/"
                    let rel = file.hasPrefix(base) ? String(file.dropFirst(base.count)) : file
                    root = structure?.testRoot(forSourcePath: rel) ?? root
                }
                let sync = RegressionFaultSync(gitRoot: gitRoot)
                let outcome = try sync.apply(diff: diff, root: root, suiteCommand: suiteCommand,
                                             gitHead: Self.gitHead(gitRoot), appVersion: version)
                try TestLedger(runId: runId, recordedAt: Date(), failing: extraction.ids, passing: passing)
                    .write(gitRoot: gitRoot)
                // The commands below were built natively by VerifyCommandBuilder
                // (never model-authored), so approving them spares the Regression
                // loop one prompt per new fault.
                var approved: [String] = []
                for u in sync.store.listFaults(at: gitRoot) {
                    guard let f = try? sync.store.loadFault(at: u),
                          let tag = f.tags.first(where: { $0.hasPrefix("test:") }),
                          outcome.created.contains(String(tag.dropFirst(5))),
                          let command = f.verify, !command.isEmpty else { continue }
                    approvals.approve(repo: gitRoot, faultFile: u.lastPathComponent, command: command)
                    approved.append("\(u.lastPathComponent): \(command)")
                }
                return (outcome, approved)
            } catch {
                return nil
            }
        }.value
        guard let (outcome, approved) = result else {
            appendLog(.warn, "  [\(stage.name)] could not update the test ledger")
            return finishTestMap(stage, startedAt: startedAt, passed: true, output: "")
        }
        for line in approved { appendLog(.info, "  [\(stage.name)] approved verify command · \(line)") }
        appendLog(.info, "  [\(stage.name)] ledger · \(outcome.created.count) new fault(s), "
                  + "\(outcome.markedFixed.count) fixed, \(outcome.skippedExisting.count) already open")
        return finishTestMap(stage, startedAt: startedAt, passed: true, output: "", newFaults: outcome.created)
    }

    // MARK: - Pure helpers

    /// XCTest `Test Case '-[M.C m]' passed` lines → `M.C/m`.
    nonisolated static func passingTestIds(_ output: String) -> [String] {
        guard let rx = try? NSRegularExpression(pattern: #"Test Case '-\[(\S+) (\S+)\]' passed"#) else { return [] }
        let ns = output as NSString
        var ids: [String] = []
        for m in rx.matches(in: output, range: NSRange(location: 0, length: ns.length)) {
            ids.append("\(ns.substring(with: m.range(at: 1)))/\(ns.substring(with: m.range(at: 2)))")
        }
        return ids
    }

    nonisolated static func gitHead(_ root: URL) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", root.path, "rev-parse", "HEAD"]
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = Pipe()
        guard (try? p.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let out = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return p.terminationStatus == 0 && !out.isEmpty ? out : nil
    }

    /// The guards' fail-closed answer when no pre-edit snapshot exists: nothing is
    /// reverted, because a revert could destroy the user's own uncommitted edits.
    nonisolated static func noSnapshotMessage(stage: LoopStage, offenders: [String]) -> String {
        "\(stage.name) broke its file rules; no pre-edit snapshot was taken, so nothing was reverted. "
            + "Left in place (no snapshot): \(offenders.joined(separator: ", "))"
    }

    // MARK: - Test Write create-only guard

    /// What the writer did that it may not: `modified` = any changed file it did
    /// not create (existing tests are never edited), `created` = new files
    /// outside every test directory. Both are repo-relative.
    nonisolated static func testWriteViolations(changed: [String], created: [String],
                                                allowedDirs: [String],
                                                testNamedPackageDirs: [String] = []) -> (modified: [String], created: [String]) {
        let createdSet = Set(created)
        let dirs = allowedDirs.filter { !$0.isEmpty }
        func inside(_ p: String) -> Bool {
            if dirs.contains(where: { p == $0 || p.hasPrefix($0 + "/") }) { return true }
            // A root with no test directory (Go: tests sit beside sources) allows
            // only files whose name follows the language's test-name rule.
            return testNamedPackageDirs.contains { $0.isEmpty || p.hasPrefix($0 + "/") }
                && TestSourceMapper.sourceStem(forTestPath: p) != nil
        }
        let modified = Set(changed).subtracting(createdSet).sorted()
        let outside = createdSet.filter { !inside($0) }.sorted()
        return (modified, outside)
    }

    /// Enforces the guard after the writer returned. Returns the stage's failure
    /// message when it broke the rule (after reverting), else nil.
    func enforceTestWriteOnly(stage: LoopStage, result: LoopAgentResult?, changed: [String],
                              gitRoot: URL) async -> String? {
        let structure: TestStructure
        if let known = testStructure { structure = known } else {
            structure = await Task.detached(priority: .utility) { TestStructureDetector(gitRoot: gitRoot).detect() }.value
            testStructure = structure
        }
        let dirs = structure.roots.map(\.testDir)
        let beside = structure.roots.filter { $0.testDir.isEmpty }.map(\.packageDir)
        let created = result?.createdPaths ?? []
        let all = Array(Set(changed).union(result?.changedPaths ?? []).union(created))
        let bad = Self.testWriteViolations(changed: all, created: created, allowedDirs: dirs,
                                           testNamedPackageDirs: beside)
        guard !bad.modified.isEmpty || !bad.created.isEmpty else { return nil }
        // No snapshot means we cannot tell the user's earlier edits from the
        // writer's: revert nothing, fail, and say so.
        guard let snapshot = lastGuardSnapshot else {
            return Self.noSnapshotMessage(stage: stage, offenders: bad.modified + bad.created)
        }
        // Same rule as `handleViolation`: a path that was already dirty holds the
        // user's earlier edits, which a checkout would destroy — leave it, say so.
        let preDirty = bad.modified.filter { snapshot.dirtyPaths.contains($0) }
        let revertable = bad.modified.filter { !preDirty.contains($0) }
        if !preDirty.isEmpty {
            appendLog(.warn, "  [\(stage.name)] not reverting already-modified path(s), to keep their earlier uncommitted edits: \(preDirty.joined(separator: ", "))")
        }
        var notReverted = preDirty
        if !revertable.isEmpty {
            // Restores tracked files; deletes an untracked one only when it sits under
            // a test root (the server may report a Bash-made file as modified).
            let deletable = Set(revertable.filter { p in dirs.filter { !$0.isEmpty }.contains { p.hasPrefix($0 + "/") } })
            if let error = await scopeGuard.revertUnlisted(paths: revertable, created: deletable,
                                                           before: snapshot, gitRoot: gitRoot) {
                appendLog(.warn, "  [\(stage.name)] \(error)")
                notReverted += revertable
            }
        }
        // Per path, through the guard: it refuses `..`/absolute entries and never
        // deletes a tracked file.
        for path in bad.created {
            if let error = await scopeGuard.revertUnlisted(paths: [path], created: [path],
                                                           before: snapshot, gitRoot: gitRoot) {
                appendLog(.warn, "  [\(stage.name)] \(error)")
                notReverted.append(path)
            }
        }
        let roots = dirs.filter { !$0.isEmpty }.joined(separator: ", ")
        let all2 = bad.modified + bad.created
        let kept = Set(notReverted)
        let done = all2.filter { !kept.contains($0) }
        return "Test Write may only create files under \(roots.isEmpty ? "the test roots" : roots); reverted: \(done.joined(separator: ", "))"
            + (kept.isEmpty ? "" : "; left in place: \(kept.sorted().joined(separator: ", "))")
    }

    // MARK: - Test Setup guard

    nonisolated static let testManifestNames: Set<String> = [
        "Package.swift", "package.json", "pytest.ini", "pyproject.toml", "setup.cfg", "go.mod", "Cargo.toml"]

    /// What Setup did that it may not. Modified files may only be package
    /// manifests; created files only test-named files, `__init__.py`/`pytest.ini`
    /// under a test directory, or a manifest (a bare repo has none to modify).
    nonisolated static func testSetupViolations(changed: [String], created: [String]) -> (modified: [String], created: [String]) {
        func name(_ p: String) -> String { (p as NSString).lastPathComponent }
        let createdSet = Set(created)
        func underTestDir(_ p: String) -> Bool {
            p.split(separator: "/").dropLast().contains { ["tests", "Tests", "test"].contains(String($0)) }
        }
        let modified = Set(changed).subtracting(createdSet).filter { !testManifestNames.contains(name($0)) }.sorted()
        let outside = createdSet.filter { p in
            if TestSourceMapper.sourceStem(forTestPath: p) != nil { return false }
            // Setup never invents a build system: only pytest config may be created.
            if ["pytest.ini", "pyproject.toml"].contains(name(p)) { return false }
            if name(p) == "__init__.py", underTestDir(p) { return false }
            return true
        }.sorted()
        return (modified, outside)
    }

    func enforceTestSetupOnly(stage: LoopStage, result: LoopAgentResult?, changed: [String],
                              gitRoot: URL) async -> String? {
        let created = result?.createdPaths ?? []
        let all = Array(Set(changed).union(result?.changedPaths ?? []).union(created))
        let bad = Self.testSetupViolations(changed: all, created: created)
        guard !bad.modified.isEmpty || !bad.created.isEmpty else { return nil }
        guard let snapshot = lastGuardSnapshot else {
            return Self.noSnapshotMessage(stage: stage, offenders: bad.modified + bad.created)
        }
        let preDirty = bad.modified.filter { snapshot.dirtyPaths.contains($0) }
        let revertable = bad.modified.filter { !preDirty.contains($0) }
        var kept = Set(preDirty)
        if !preDirty.isEmpty {
            appendLog(.warn, "  [\(stage.name)] not reverting already-modified path(s), to keep their earlier uncommitted edits: \(preDirty.joined(separator: ", "))")
        }
        if !revertable.isEmpty {
            if let error = await scopeGuard.revertUnlisted(paths: revertable, created: [], before: snapshot, gitRoot: gitRoot) {
                appendLog(.warn, "  [\(stage.name)] \(error)")
                kept.formUnion(revertable)
            }
        }
        for path in bad.created {
            if let error = await scopeGuard.revertUnlisted(paths: [path], created: [path],
                                                           before: snapshot, gitRoot: gitRoot) {
                appendLog(.warn, "  [\(stage.name)] \(error)")
                kept.insert(path)
            }
        }
        let offenders = bad.modified + bad.created
        let done = offenders.filter { !kept.contains($0) }
        return "Test Setup may only add test files and package manifests; offending path(s): \(offenders.joined(separator: ", "))"
            + (done.isEmpty ? "" : "; reverted: \(done.joined(separator: ", "))")
            + (kept.isEmpty ? "" : "; left in place: \(kept.sorted().joined(separator: ", "))")
    }
}
