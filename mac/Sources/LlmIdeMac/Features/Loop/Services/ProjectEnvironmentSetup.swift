import Foundation

/// What the "Set up environment" button will run, as data. Pure so the consent
/// dialog shows exactly what the executor runs — they read the same list.
public struct ProjectEnvironmentSetupPlan: Equatable {
    /// Shell commands, run in order from the repo root.
    public let commands: [String]
    /// The virtualenv folder the plan creates or reuses (`.venv` or `venv`).
    public let virtualEnvName: String

    public var summary: String {
        "Folder: \(virtualEnvName)/ (inside this project only)\n\n" + commands.joined(separator: "\n")
    }
}

/// Decides what to run to give a Python project a virtualenv with its
/// dependencies and pytest. Returns nil when the project declares no Python
/// dependencies, so no button is offered for it.
public enum ProjectEnvironmentSetupPlanner {
    public static func plan(for repoRoot: URL) -> ProjectEnvironmentSetupPlan? {
        let fileManager = FileManager.default
        let hasRequirements = fileManager.fileExists(atPath: repoRoot.appendingPathComponent("requirements.txt").path)
        let hasPyproject = fileManager.fileExists(atPath: repoRoot.appendingPathComponent("pyproject.toml").path)
        guard hasRequirements || hasPyproject else { return nil }

        let existing = ProjectRuntimeEnvironment.virtualEnvironment(in: repoRoot)
        let name = existing?.lastPathComponent ?? ".venv"
        let python = "\(name)/bin/python"
        var commands: [String] = []
        // An existing virtualenv is reused: recreating it would throw away
        // whatever the user already installed there.
        if existing == nil { commands.append("python3 -m venv \(name)") }
        // `-e .[dev]` would fail on a project with no `dev` extra, so install
        // the project itself and add pytest as its own step.
        commands.append("\(python) -m pip install --upgrade pip")
        commands.append(hasRequirements
                        ? "\(python) -m pip install -r requirements.txt"
                        : "\(python) -m pip install -e .")
        commands.append("\(python) -m pip install pytest")
        return ProjectEnvironmentSetupPlan(commands: commands, virtualEnvName: name)
    }
}

struct ProjectEnvironmentSetupResult: Equatable {
    public let succeeded: Bool
    /// Output of the failing command, or the last command on success.
    public let output: String
}

/// Runs a plan. Only ever called from a user's click on the button — the loop
/// runner itself never installs anything (see invariants.md).
final class ProjectEnvironmentSetupService {
    func run(_ plan: ProjectEnvironmentSetupPlan, in repoRoot: URL) async -> ProjectEnvironmentSetupResult {
        // The same PATH a loop stage gets, so `python3` resolves the way the
        // Test stage's tools will.
        let environment = ProjectRuntimeEnvironment.overrides(
            for: repoRoot, inherited: ProcessInfo.processInfo.environment)
        var lastOutput = ""
        for command in plan.commands {
            do {
                let process = try GroupedSubprocess.launch(
                    shellCommand: command, directory: repoRoot, environment: environment)
                // Cancellation (user stop or sheet dismiss): `waitForExit` may throw
                // on its own, but this `defer` ensures the process tree is stopped
                // instead of orphaning the running `pip install`. It cannot await;
                // `terminateTree` schedules the SIGKILL and the reaper thread still
                // collects the exit.
                defer { if !process.hasExited { process.terminateTree(grace: 2) } }

                try await process.waitForExit()
                lastOutput = await process.collectOutput()
                if process.exitStatus != 0 {
                    return ProjectEnvironmentSetupResult(
                        succeeded: false, output: "$ \(command)\n\(lastOutput)")
                }
            } catch is CancellationError {
                // Reached only if the owning Task is cancelled; the current caller
                // (LoopEngineView) does not cancel it. The defer above stops
                // the process. Leave the half-built .venv in place; the planner
                // re-detects it on next run via pyvenv.cfg.
                return ProjectEnvironmentSetupResult(succeeded: false, output: "Cancelled")
            } catch {
                return ProjectEnvironmentSetupResult(
                    succeeded: false, output: "$ \(command)\n\(error.localizedDescription)")
            }
        }
        return ProjectEnvironmentSetupResult(succeeded: true, output: lastOutput)
    }
}
