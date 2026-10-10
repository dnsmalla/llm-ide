import Foundation

// The Test loop's `.testMap` stage and the writer's create-only guard, kept out
// of LoopEngineRunner.swift (already ~2,800 lines). Run state (`testStructure`,
// `testMapBefore`, `lastVerifyOutputs`) lives on the runner; extensions cannot
// hold stored properties.
extension LoopEngineRunner {

    // MARK: - Stage

    func runTestMapStage(_ stage: LoopStage, gitRoot: URL, stages: [LoopStage]) async -> StageDecision {
        let startedAt = Date()
        switch stage.testOp {
        case .structure:
            let structure = await Task.detached(priority: .utility) { () -> TestStructure in
                let detector = TestStructureDetector(gitRoot: gitRoot)
                let found = detector.detect()
                _ = try? detector.write(found)
                return found
            }.value
            testStructure = structure
            for root in structure.roots {
                appendLog(.info, "  [\(stage.name)] \(root.testDir.isEmpty ? "." : root.testDir) · \(root.runner.rawValue) · \(root.command)")
            }
            if structure.status == "missing" {
                appendLog(.info, "  [\(stage.name)] no test structure found — the Setup stage will create one")
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
                    _ = try builder.write(map)
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
            return await runLedgerOp(stage, startedAt: startedAt, gitRoot: gitRoot, stages: stages)

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

    private func runLedgerOp(_ stage: LoopStage, startedAt: Date, gitRoot: URL,
                             stages: [LoopStage]) async -> StageDecision {
        guard let attempt = iterationRecords.last?.attempts.last(where: {
            $0.kind == .shellCommand && $0.severity != .advisory }),
              let output = lastVerifyOutputs[attempt.stageId] else {
            appendLog(.info, "  [\(stage.name)] no Test stage ran this iteration — ledger unchanged")
            return finishTestMap(stage, startedAt: startedAt, passed: true, output: "")
        }
        let suiteCommand = stages.first { $0.id == attempt.stageId }?.command ?? ""
        let extraction = TestFailureExtractor.extract(output)
        let passing = Self.passingTestIds(output)
        let runPassed = attempt.passed
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

    // MARK: - Test Write create-only guard

    /// What the writer did that it may not: `modified` = any changed file it did
    /// not create (existing tests are never edited), `created` = new files
    /// outside every test directory. Both are repo-relative.
    nonisolated static func testWriteViolations(changed: [String], created: [String],
                                                allowedDirs: [String]) -> (modified: [String], created: [String]) {
        let createdSet = Set(created)
        let dirs = allowedDirs.filter { !$0.isEmpty }
        func inside(_ p: String) -> Bool { dirs.contains { p == $0 || p.hasPrefix($0 + "/") } }
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
        let created = result?.createdPaths ?? []
        let all = Array(Set(changed).union(result?.changedPaths ?? []).union(created))
        let bad = Self.testWriteViolations(changed: all, created: created, allowedDirs: dirs)
        guard !bad.modified.isEmpty || !bad.created.isEmpty else { return nil }
        var reverted: [String] = []
        if !bad.modified.isEmpty, await scopeGuard.revert(paths: bad.modified, gitRoot: gitRoot) == nil {
            reverted += bad.modified
        }
        for path in bad.created {
            let url = gitRoot.appendingPathComponent(path)
            if (try? FileManager.default.removeItem(at: url)) != nil { reverted.append(path) }
        }
        let roots = dirs.filter { !$0.isEmpty }.joined(separator: ", ")
        return "Test Write may only create files under \(roots); reverted: \((bad.modified + bad.created).joined(separator: ", "))"
            + (reverted.count == bad.modified.count + bad.created.count ? "" : " (some paths could not be reverted)")
    }
}
