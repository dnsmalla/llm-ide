import Foundation
import LlmIdeMacLib

// Asserts `ProjectEnvironmentSetupPlanner`: what the "set up environment"
// button WOULD run. The plan is pure so the consent dialog and the executor
// can never disagree about it.

#if FEATURE_AUTOTASK
func runProjectEnvironmentSetupChecks() {
    print("project environment setup plan")
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("loop-env-setup-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }

    func project(_ name: String, files: [String] = [], venv: String? = nil) -> URL {
        let dir = root.appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for file in files { try? "".write(to: dir.appendingPathComponent(file), atomically: true, encoding: .utf8) }
        if let venv {
            try? FileManager.default.createDirectory(at: dir.appendingPathComponent("\(venv)/bin"),
                                                     withIntermediateDirectories: true)
            try? "home = /usr/bin\n".write(to: dir.appendingPathComponent("\(venv)/pyvenv.cfg"),
                                           atomically: true, encoding: .utf8)
        }
        return dir
    }

    expect(ProjectEnvironmentSetupPlanner.plan(for: project("empty")) == nil,
           "no Python requirement file means no plan, so no button")

    let requirements = ProjectEnvironmentSetupPlanner.plan(for: project("req", files: ["requirements.txt"]))
    expect(requirements?.commands == [
        "python3 -m venv .venv",
        ".venv/bin/python -m pip install --upgrade pip",
        ".venv/bin/python -m pip install -r requirements.txt",
        ".venv/bin/python -m pip install pytest",
    ], "requirements.txt: create .venv, install the requirements, then pytest")

    let pyproject = ProjectEnvironmentSetupPlanner.plan(for: project("pyp", files: ["pyproject.toml"]))
    expect(pyproject?.commands == [
        "python3 -m venv .venv",
        ".venv/bin/python -m pip install --upgrade pip",
        ".venv/bin/python -m pip install -e .",
        ".venv/bin/python -m pip install pytest",
    ], "pyproject.toml alone: editable install, then pytest")

    let both = ProjectEnvironmentSetupPlanner.plan(
        for: project("both", files: ["requirements.txt", "pyproject.toml"]))
    expect(both?.commands.contains(".venv/bin/python -m pip install -r requirements.txt") == true
           && both?.commands.contains(".venv/bin/python -m pip install -e .") == false,
           "requirements.txt wins over pyproject.toml")

    let existing = ProjectEnvironmentSetupPlanner.plan(
        for: project("has-venv", files: ["requirements.txt"], venv: "venv"))
    expect(existing?.commands == [
        "venv/bin/python -m pip install --upgrade pip",
        "venv/bin/python -m pip install -r requirements.txt",
        "venv/bin/python -m pip install pytest",
    ], "an existing venv/ is reused, not recreated as .venv")
    expect(existing?.virtualEnvName == "venv", "the plan names the virtualenv it uses")

    expect(requirements?.summary.contains("python3 -m venv .venv") == true,
           "the consent summary lists every command that will run")
}
#endif
