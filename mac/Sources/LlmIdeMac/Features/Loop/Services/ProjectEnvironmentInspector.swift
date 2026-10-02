import Foundation

/// Collects the facts behind the Environment status by running a few FIXED,
/// read-only commands. It never runs project code: `find_spec` does not import
/// the module, `pip check` reads package metadata, and the pytest start check
/// passes `--noconftest` so the project's conftest.py is not loaded (pytest
/// itself and its installed plugins are, exactly as in a Test stage — that is
/// what makes a broken dependency visible before a run).
public enum ProjectEnvironmentInspector {
    /// Files that make a project a Python project.
    private static let pythonMarkers = ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "pytest.ini"]

    /// Collects the environment facts for `repoRoot`.
    ///
    /// If the calling task is cancelled, no further probe is launched and the
    /// returned facts are INCOMPLETE; callers must discard them.
    public static func inspect(repoRoot: URL,
                               inherited: [String: String] = ProcessInfo.processInfo.environment,
                               timeout: TimeInterval = 20) async -> ProjectEnvironmentFacts {
        let fileManager = FileManager.default
        var facts = ProjectEnvironmentFacts()
        facts.isPythonProject = pythonMarkers.contains {
            fileManager.fileExists(atPath: repoRoot.appendingPathComponent($0).path)
        }
        facts.recommendedTestCommand = LoopStageDetector.detectTestCommand(gitRoot: repoRoot)

        // PYTHONDONTWRITEBYTECODE: the inspection must not leave .pyc files behind.
        var environment = ProjectRuntimeEnvironment.overrides(for: repoRoot, inherited: inherited)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"

        if let command = facts.recommendedTestCommand {
            facts.missingExecutable = StageCommandAvailability.missingExecutable(
                in: command, path: environment["PATH"] ?? "")
        }
        guard facts.isPythonProject else { return facts }

        let venv = ProjectRuntimeEnvironment.virtualEnvironment(in: repoRoot)
        facts.virtualEnvName = venv?.lastPathComponent
        let python = venv.map { "\($0.lastPathComponent)/bin/python" } ?? "python3"

        guard !Task.isCancelled else { return facts }
        facts.pythonVersion = await run("\(python) --version", in: repoRoot, environment: environment, timeout: timeout)
        guard !Task.isCancelled else { return facts }
        facts.pytestInstalled = await run(
            "\(python) -c \"import importlib.util as u; print(u.find_spec('pytest') is not None)\"",
            in: repoRoot, environment: environment, timeout: timeout)
        if case .ok(let output) = facts.pytestInstalled,
           output.trimmingCharacters(in: .whitespacesAndNewlines) == "True" {
            guard !Task.isCancelled else { return facts }
            facts.pytestStarts = await run(
                "\(python) -m pytest --version --noconftest -p no:cacheprovider",
                in: repoRoot, environment: environment, timeout: timeout)
        }
        guard !Task.isCancelled else { return facts }
        facts.pipCheck = await run("\(python) -m pip check", in: repoRoot, environment: environment, timeout: timeout)
        return facts
    }

    /// Runs one fixed command with a time limit. Output is trimmed and capped.
    /// `.notRun` is returned when the task is cancelled while waiting; the
    /// same value also means "skipped on purpose" elsewhere in the facts, so
    /// callers must check cancellation before trusting a `.notRun`.
    private static func run(_ command: String, in directory: URL, environment: [String: String],
                            timeout: TimeInterval) async -> EnvironmentProbe {
        let process: GroupedSubprocess
        do {
            process = try GroupedSubprocess.launch(shellCommand: command, directory: directory,
                                                   environment: environment)
        } catch {
            return .failed(error.localizedDescription)
        }
        // Same reason as the verifier: a cancelled inspection must not leave a
        // child running. It cannot await; terminateTree returns immediately.
        defer { if !process.hasExited { process.terminateTree(grace: 1) } }

        let deadline = Date().addingTimeInterval(timeout)
        while !process.hasExited {
            if Task.isCancelled { return .notRun }
            if Date() >= deadline { return .timedOut }
            await GroupedSubprocess.pause(nanoseconds: 25_000_000)
        }
        let output = String((await process.collectOutput()).trimmingCharacters(in: .whitespacesAndNewlines).prefix(4_000))
        return process.exitStatus == 0 ? .ok(output) : .failed(output)
    }
}
