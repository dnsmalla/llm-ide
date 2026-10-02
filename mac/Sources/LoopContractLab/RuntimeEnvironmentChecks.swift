import Foundation
import LlmIdeMacLib

// Asserts the two halves of "a stage runs in the project's own environment":
// `ProjectRuntimeEnvironment` (Core — the PATH / virtualenv every verify
// command now gets) and `StageOutputParser.environmentProblem` (Loop — the
// classifier that keeps a missing tool or dependency from being sent to an
// LLM code repair it cannot fix).

/// Every fixture directory made here, removed by `removeRuntimeFixtures()`.
private var runtimeFixtures: [URL] = []

private func makeRuntimeFixture() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("loop-runtime-env-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    runtimeFixtures.append(dir)
    return dir
}

private func removeRuntimeFixtures() {
    for dir in runtimeFixtures { try? FileManager.default.removeItem(at: dir) }
    runtimeFixtures.removeAll()
}

private func makeDirectory(_ relative: String, in root: URL) {
    try? FileManager.default.createDirectory(at: root.appendingPathComponent(relative),
                                             withIntermediateDirectories: true)
}

/// A directory shaped like `python -m venv <name>` output: `pyvenv.cfg` plus `bin/`.
private func makeVenv(_ name: String, in root: URL) -> URL {
    let venv = root.appendingPathComponent(name)
    makeDirectory("\(name)/bin", in: root)
    try? "home = /usr/bin\n".write(to: venv.appendingPathComponent("pyvenv.cfg"),
                                   atomically: true, encoding: .utf8)
    return venv
}

private func pathEntries(_ overrides: [String: String]) -> [String] {
    (overrides["PATH"] ?? "").split(separator: ":").map(String.init)
}

/// Core: always built, so these run in every feature profile.
func runRuntimeEnvironmentChecks() {
    print("runtime environment")
    defer { removeRuntimeFixtures() }
    let home = makeRuntimeFixture()
    makeDirectory(".local/bin", in: home)
    let localBin = home.appendingPathComponent(".local/bin").path
    let inherited = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/bin"]

    // MARK: virtualenv activation

    let dotVenvRoot = makeRuntimeFixture()
    let dotVenv = makeVenv(".venv", in: dotVenvRoot)
    _ = makeVenv("venv", in: dotVenvRoot)
    let withDotVenv = ProjectRuntimeEnvironment.overrides(for: dotVenvRoot, inherited: inherited)
    expect(pathEntries(withDotVenv).first == dotVenv.appendingPathComponent("bin").path,
           "a project's .venv/bin is the FIRST PATH entry, so a bare `pytest` resolves to it")
    expect(withDotVenv["VIRTUAL_ENV"] == dotVenv.path,
           "VIRTUAL_ENV names the project's .venv")

    let plainVenvRoot = makeRuntimeFixture()
    let plainVenv = makeVenv("venv", in: plainVenvRoot)
    expect(ProjectRuntimeEnvironment.overrides(for: plainVenvRoot, inherited: inherited)["VIRTUAL_ENV"]
           == plainVenv.path,
           "`venv/` is used when there is no `.venv/`")

    let fakeVenvRoot = makeRuntimeFixture()
    makeDirectory(".venv/bin", in: fakeVenvRoot)
    expect(ProjectRuntimeEnvironment.overrides(for: fakeVenvRoot, inherited: inherited)["VIRTUAL_ENV"] == nil,
           "a `.venv` folder without pyvenv.cfg is not treated as a virtualenv")

    // MARK: PATH composition

    let bareRoot = makeRuntimeFixture()
    let bare = ProjectRuntimeEnvironment.overrides(for: bareRoot, inherited: inherited)
    expect(bare["VIRTUAL_ENV"] == nil, "no virtualenv → no VIRTUAL_ENV override")
    let barePath = pathEntries(bare)
    expect(Array(barePath.prefix(2)) == ["/usr/bin", "/bin"],
           "the inherited PATH comes first, in its own order — a terminal's nvm/conda choice is not shadowed")
    expect(barePath.contains(localBin),
           "user CLI dirs that exist (~/.local/bin) are appended for a Finder-launched app's minimal PATH")
    expect(!barePath.contains(home.appendingPathComponent(".pyenv/shims").path),
           "a CLI dir that does not exist is not added")
    expect(barePath.filter { $0 == "/usr/bin" }.count == 1, "PATH entries are de-duplicated")

    let already = ProjectRuntimeEnvironment.overrides(
        for: bareRoot, inherited: ["HOME": home.path, "PATH": "\(localBin):/usr/bin"])
    expect(pathEntries(already).first == localBin,
           "a CLI dir already on the inherited PATH keeps its inherited position")
}

#if FEATURE_AUTOTASK
/// Loop: excluded with Features/Loop in builds without auto_tasks.
func runEnvironmentProblemChecks() {
    print("environment-problem classification")
    defer { removeRuntimeFixtures() }
    let projectRoot = makeRuntimeFixture()
    makeDirectory("myapp", in: projectRoot)
    try? "".write(to: projectRoot.appendingPathComponent("helpers.py"), atomically: true, encoding: .utf8)
    makeDirectory("src/srcpkg", in: projectRoot)
    makeDirectory("backend/monopkg", in: projectRoot)
    makeDirectory("src/utils", in: projectRoot)

    func problem(_ exit: Int32, _ output: String) -> String? {
        StageOutputParser.environmentProblem(exitCode: exit, output: output, repoRoot: projectRoot)
    }

    // Missing commands
    expect(problem(127, "/bin/sh: pytest: command not found")?.contains("pytest") == true,
           "exit 127 is an environment problem naming the missing command")
    expect(problem(127, "sh: jest: command not found") != nil,
           "npm test with no node_modules (npm propagates the script's 127) is an environment problem")
    expect(problem(2, "/bin/sh: pytest: command not found\nmake: *** [Makefile:3: test] Error 127") != nil,
           "a make recipe whose command is missing (make exits 2, reports Error 127) is an environment problem")
    expect(problem(1, "FAILED test_shell.py::test_reports_missing - 'zsh: command not found: foo'") == nil,
           "\"command not found\" text in an ordinary failing test's log is NOT an environment problem")

    // Python
    expect(problem(1, "ModuleNotFoundError: No module named 'requests'")?.contains("requests") == true,
           "a missing third-party Python module is an environment problem")
    expect(problem(1, "E   ModuleNotFoundError: No module named 'requests.adapters'")?.contains("requests") == true,
           "a missing submodule (pytest's `E   ` prefix) is judged by its top-level package")
    expect(problem(1, "/usr/bin/python3: No module named pytest") != nil,
           "`python -m pytest` without pytest installed is an environment problem")
    expect(problem(1, "UserWarning: No module named 'ujson', falling back to json\nAssertionError\n1 failed") == nil,
           "a warning that merely MENTIONS a missing module does not hide a real test failure")
    expect(problem(1, "ModuleNotFoundError: No module named 'myapp.models'") == nil,
           "a missing module of the project's OWN package is a code problem — left to repair")
    expect(problem(1, "ModuleNotFoundError: No module named 'helpers'") == nil,
           "a missing project-local .py module is a code problem")
    expect(problem(1, "ModuleNotFoundError: No module named 'srcpkg.core'") == nil,
           "a src-layout project package is recognised as the project's own")
    expect(problem(1, "ModuleNotFoundError: No module named 'monopkg.api'") == nil,
           "a monorepo sub-project's package (backend/monopkg) is recognised as the project's own")

    // Node
    expect(problem(1, "Error: Cannot find module 'lodash'") != nil,
           "a missing bare Node package is an environment problem")
    expect(problem(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@scope/pkg' imported from /x.js") != nil,
           "a missing scoped ESM package is an environment problem")
    expect(problem(1, "    Cannot find module 'lodash' from 'src/a.test.js'") != nil,
           "jest's indented resolver message is recognised")
    expect(problem(1, "Error: Cannot find module './util'") == nil,
           "a missing RELATIVE module is a code problem — left to repair")
    for alias in ["@/lib/date", "~/lib/date", "#internal/date"] {
        expect(problem(1, "Error: Cannot find module '\(alias)'") == nil,
               "a path-alias import (\(alias)) is the project's own code — left to repair")
    }
    expect(problem(1, "Error: Cannot find module 'utils/date'") == nil,
           "a moduleDirectories-style import of a project folder (src/utils) is left to repair")
    expect(problem(2, "src/a.ts(1,20): error TS2307: Cannot find module 'lodash' or its corresponding type declarations.") == nil,
           "a type-checker diagnostic is a code/config problem, not a runtime environment one")

    // Never
    expect(problem(0, "ModuleNotFoundError: No module named 'requests'") == nil,
           "a passing stage is never classified")
    expect(problem(1, "AssertionError: expected 1 == 2\n1 failed") == nil,
           "an ordinary test failure is not an environment problem")
}
#endif
