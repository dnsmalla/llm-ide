import Foundation

/// Collects the facts behind the Environment status.
///
/// File facts (project kind, recommended command, missing executable,
/// virtualenv name) only read the file system and NEVER start a process.
/// The interpreter probes run the project's own Python, and with it pytest and
/// its installed plugins from site-packages, so they only run on explicit
/// request (`runInterpreterProbes`) and are hardened: absolute virtualenv
/// interpreter, a fresh empty working directory, `-c /dev/null`, and a scrubbed
/// environment (no PYTEST_ADDOPTS / PYTEST_PLUGINS / PYTHONPATH).
public enum ProjectEnvironmentInspector {
    /// Files that make a project a Python project.
    private static let pythonMarkers = ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "pytest.ini"]

    /// Collects the environment facts for `repoRoot`.
    ///
    /// With `runInterpreterProbes == false` (the default) no process is started
    /// and every probe stays `.notRun`.
    /// If the calling task is cancelled, no further probe is launched and the
    /// returned facts are INCOMPLETE; callers must discard them.
    public static func inspect(repoRoot: URL,
                               inherited: [String: String] = ProcessInfo.processInfo.environment,
                               timeout: TimeInterval = 20,
                               runInterpreterProbes: Bool = false) async -> ProjectEnvironmentFacts {
        let fileManager = FileManager.default
        var facts = ProjectEnvironmentFacts()
        facts.isPythonProject = pythonMarkers.contains {
            fileManager.fileExists(atPath: repoRoot.appendingPathComponent($0).path)
        }
        facts.recommendedTestCommand = LoopStageDetector.detectTestCommand(gitRoot: repoRoot)

        var environment = ProjectRuntimeEnvironment.overrides(for: repoRoot, inherited: inherited)
        if let command = facts.recommendedTestCommand {
            facts.missingExecutable = StageCommandAvailability.missingExecutable(
                in: command, path: environment["PATH"] ?? "")
        }
        guard facts.isPythonProject else { return facts }

        let venv = ProjectRuntimeEnvironment.virtualEnvironment(in: repoRoot)
        facts.virtualEnvName = venv?.lastPathComponent
        guard runInterpreterProbes else { return facts }
        facts.interpreterProbesRan = true

        // Keep project-controlled configuration and code out of the probes.
        environment["PYTEST_ADDOPTS"] = ""
        environment["PYTEST_PLUGINS"] = ""
        environment["PYTHONPATH"] = ""
        environment["PYTHONSAFEPATH"] = "1"
        environment["PYTHONDONTWRITEBYTECODE"] = "1"

        // A fresh empty directory: repo files are never first on sys.path and
        // pytest finds no rootdir configuration.
        let workDirectory = fileManager.temporaryDirectory
            .appendingPathComponent("llmide-env-inspect-\(UUID().uuidString)")
        do {
            try fileManager.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        } catch {
            facts.pythonVersion = .failed(error.localizedDescription)
            return facts
        }
        defer { try? fileManager.removeItem(at: workDirectory) }

        let python = venv.map { shellQuote(repoRoot.appendingPathComponent("\($0.lastPathComponent)/bin/python").path) }
            ?? "python3"

        guard !Task.isCancelled else { return facts }
        facts.pythonVersion = await run("\(python) --version", in: workDirectory, environment: environment, timeout: timeout)
        // Misleading follow-on failures help nobody when Python itself is broken.
        switch facts.pythonVersion {
        case .failed, .timedOut: return facts
        default: break
        }
        guard !Task.isCancelled else { return facts }
        facts.pytestInstalled = await run(
            "\(python) -c \"import importlib.util as u; print(u.find_spec('pytest') is not None)\"",
            in: workDirectory, environment: environment, timeout: timeout)
        if case .ok(let output) = facts.pytestInstalled,
           output.trimmingCharacters(in: .whitespacesAndNewlines) == "True" {
            guard !Task.isCancelled else { return facts }
            facts.pytestStarts = await run(
                "\(python) -m pytest --version --noconftest -p no:cacheprovider -c /dev/null",
                in: workDirectory, environment: environment, timeout: timeout)
        }
        guard !Task.isCancelled else { return facts }
        facts.pipCheck = await run("\(python) -m pip check", in: workDirectory, environment: environment, timeout: timeout)
        return facts
    }

    private static func shellQuote(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
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
