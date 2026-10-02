import Foundation
import LlmIdeMacLib

// Asserts the pure half of the environment status: given collected facts, what
// the user is told. The collecting half (Inspector) is asserted further down.

#if FEATURE_AUTOTASK
func runProjectEnvironmentAssessorChecks() {
    print("project environment assessor")

    func facts(
        python: Bool = true, command: String? = "pytest", missing: String? = nil, venv: String? = ".venv",
        version: EnvironmentProbe = .ok("Python 3.11.4"), installed: EnvironmentProbe = .ok("True"),
        starts: EnvironmentProbe = .ok("pytest 8.3.5"),
        pip: EnvironmentProbe = .ok("No broken requirements found.")
    ) -> ProjectEnvironmentFacts {
        ProjectEnvironmentFacts(isPythonProject: python, recommendedTestCommand: command,
                                missingExecutable: missing, virtualEnvName: venv, pythonVersion: version,
                                pytestInstalled: installed, pytestStarts: starts, pipCheck: pip)
    }
    func blockingMissing(_ status: ProjectEnvironmentStatus) -> [String] {
        status.findings.filter { $0.severity == .blocking }.compactMap(\.missing)
    }

    let ready = ProjectEnvironmentAssessor.assess(facts())
    expect(ready.readiness == .ready, "a healthy Python project is ready")
    expect(ready.findings.isEmpty, "a healthy project has no findings")
    expect(ready.recommendedTestCommand == "pytest", "the recommended command is passed through")

    // The reported iis_summary state: no `pytest` command, pytest present but crashing on start,
    // dependency conflicts, no virtualenv.
    let iis = ProjectEnvironmentAssessor.assess(facts(
        missing: "pytest", venv: nil, installed: .ok("True"),
        starts: .failed("Traceback (most recent call last):\n  File \"x\"\nSystemError: pydantic-core mismatch"),
        pip: .failed("a 1.0 has requirement b>=2, but you have b 1.0.")))
    expect(iis.readiness == .needsSetup, "the iis_summary state needs setup")
    expect(blockingMissing(iis) == ["pytest"], "the missing pytest command is reported once")
    expect(iis.findings.contains { $0.severity == .blocking && $0.message == "pytest cannot start: SystemError: pydantic-core mismatch" },
           "a pytest start failure is blocking and quotes the last output line")
    expect(iis.findings.contains { $0.severity == .warning && $0.message.contains("Dependency conflicts") },
           "pip check conflicts are a warning")
    expect(iis.findings.contains { $0.severity == .warning && $0.message.contains("No project virtualenv") },
           "a missing virtualenv is a warning")

    let notInstalled = ProjectEnvironmentAssessor.assess(facts(
        missing: "pytest", installed: .ok("False"), starts: .notRun))
    expect(blockingMissing(notInstalled) == ["pytest"],
           "a missing command and a missing module are one finding, not two")

    let conflictsOnly = ProjectEnvironmentAssessor.assess(facts(
        pip: .failed((1...8).map { "line\($0)" }.joined(separator: "\n"))))
    expect(conflictsOnly.readiness == .ready, "pip check conflicts alone do not need setup")
    expect(conflictsOnly.findings.first?.message.contains("line5") == true
           && conflictsOnly.findings.first?.message.contains("line6") == false,
           "pip check output is cut at five lines")

    expect(ProjectEnvironmentAssessor.assess(facts(starts: .timedOut)).readiness == .unknown,
           "a timed-out start check with nothing blocking is unknown")
    expect(ProjectEnvironmentAssessor.assess(facts(version: .failed("boom"))).readiness == .needsSetup,
           "Python that cannot run needs setup")
    let timedOutVersion = ProjectEnvironmentAssessor.assess(facts(version: .timedOut))
    expect(timedOutVersion.readiness == .unknown,
           "a Python that times out is unknown, not blocking")
    expect(blockingMissing(timedOutVersion).isEmpty,
           "a Python that times out does not create a blocking finding")
    expect(timedOutVersion.findings.contains { $0.severity == .warning && $0.message.contains("did not answer") },
           "a Python that times out is reported as a warning about not answering")

    let versionAndStartsTimedOut = ProjectEnvironmentAssessor.assess(facts(
        version: .timedOut, starts: .timedOut))
    expect(versionAndStartsTimedOut.readiness == .unknown,
           "both pythonVersion and pytestStarts timed out => unknown, not needsSetup")

    let swift = ProjectEnvironmentAssessor.assess(facts(
        python: false, command: "swift test", venv: nil,
        version: .failed("ignored"), installed: .failed("ignored"), starts: .failed("ignored"), pip: .failed("ignored")))
    expect(swift.readiness == .ready && swift.findings.isEmpty,
           "Python probes are ignored for a project that is not Python")

    let noCommand = ProjectEnvironmentAssessor.assess(facts(python: false, command: nil, venv: nil))
    expect(noCommand.findings.map(\.severity) == [.info] && noCommand.readiness == .ready,
           "no detected test command is information, not a problem")

    let make = ProjectEnvironmentAssessor.assess(facts(command: "make test", starts: .failed("ignored")))
    expect(make.findings.allSatisfy { !$0.message.contains("pytest") },
           "pytest checks apply only when the recommended command uses pytest")
    for command in ["python3 -m pytest -q", "cd x && pytest"] {
        let status = ProjectEnvironmentAssessor.assess(facts(command: command, starts: .failed("SystemError: x")))
        expect(status.readiness == .needsSetup, "\(command) counts as using pytest")
    }
    expect(ProjectEnvironmentAssessor.assess(facts(command: "run mypytestx", starts: .failed("x"))).readiness == .ready,
           "a word merely containing pytest does not count as using pytest")
    for command in [".venv/bin/pytest -q", "./pytest"] {
        let pathStatus = ProjectEnvironmentAssessor.assess(facts(command: command, starts: .failed("x")))
        expect(pathStatus.readiness == .needsSetup, "\(command) counts as using pytest")
    }

    let pytestInstalledTimedOut = ProjectEnvironmentAssessor.assess(facts(
        installed: .timedOut))
    expect(pytestInstalledTimedOut.readiness == .unknown,
           "pytestInstalled timed out => unknown readiness")
    expect(pytestInstalledTimedOut.findings.contains { $0.severity == .warning && $0.message == "Could not check whether pytest is installed" },
           "pytestInstalled timed out => warning about checking")

    let pytestInstalledInvalid = ProjectEnvironmentAssessor.assess(facts(
        installed: .ok("maybe")))
    expect(pytestInstalledInvalid.readiness == .ready,
           "pytestInstalled .ok(invalid-value) => ready (not blocking)")
    expect(pytestInstalledInvalid.findings.contains { $0.severity == .warning && $0.message == "Could not check whether pytest is installed" },
           "pytestInstalled .ok(non-boolean-string) => warning about checking")

    let blankPip = ProjectEnvironmentAssessor.assess(facts(
        pip: .failed("  \n  \n  ")))
    expect(blankPip.findings.allSatisfy { !$0.message.contains("Dependency conflicts") },
           "pip check with only whitespace produces no finding")

    let pythonNoVenv = ProjectEnvironmentAssessor.assess(facts(
        python: true, venv: nil, version: .ok("3.11"), installed: .ok("True"), starts: .ok("pytest")))
    expect(pythonNoVenv.readiness == .ready,
           "Python project with no venv but otherwise healthy => ready")
    expect(pythonNoVenv.findings.filter { $0.severity == .warning }.count == 1,
           "exactly one warning finding")
    expect(pythonNoVenv.findings.contains { $0.severity == .warning && $0.message.contains("No project virtualenv") },
           "the warning is about missing virtualenv")

    let venvPytestFails = ProjectEnvironmentAssessor.assess(facts(
        command: ".venv/bin/pytest -q", starts: .failed("ImportError: no module")))
    expect(venvPytestFails.readiness == .needsSetup,
           ".venv/bin/pytest command with startup failure => needsSetup")
}

/// A project whose `.venv/bin/python` is a shell script answering the probes
/// from `body`, so the inspector is asserted without a real Python.
private func makeFakePythonProject(name: String, withPytestBinary: Bool, body: String) -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("loop-env-inspect-\(name)-\(UUID().uuidString)")
    let bin = root.appendingPathComponent(".venv/bin")
    try? FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    try? "home = /usr/bin\n".write(to: root.appendingPathComponent(".venv/pyvenv.cfg"),
                                   atomically: true, encoding: .utf8)
    try? "[pytest]\n".write(to: root.appendingPathComponent("pytest.ini"), atomically: true, encoding: .utf8)
    try? "".write(to: root.appendingPathComponent("requirements.txt"), atomically: true, encoding: .utf8)
    func script(_ file: String, _ text: String) {
        FileManager.default.createFile(atPath: bin.appendingPathComponent(file).path,
                                       contents: Data(text.utf8), attributes: [.posixPermissions: 0o755])
    }
    script("python", "#!/bin/sh\n" + body)
    if withPytestBinary { script("pytest", "#!/bin/sh\n") }
    return root
}

private let fakePythonHealthy = """
case "$*" in
  "--version") echo "Python 9.9.9 dwb=$PYTHONDONTWRITEBYTECODE" ;;
  *find_spec*) echo True ;;
  "-m pytest --version --noconftest -p no:cacheprovider") echo "pytest 0.0.0" ;;
  "-m pip check") echo "No broken requirements found." ;;
  *) echo "unexpected: $*"; exit 2 ;;
esac
"""

func runProjectEnvironmentInspectorChecks() async {
    print("project environment inspector")
    let inherited = ["PATH": "/usr/bin:/bin", "HOME": NSTemporaryDirectory()]

    let healthy = makeFakePythonProject(name: "ok", withPytestBinary: true, body: fakePythonHealthy)
    defer { try? FileManager.default.removeItem(at: healthy) }
    let ok = await ProjectEnvironmentInspector.inspect(repoRoot: healthy, inherited: inherited, timeout: 10)
    expect(ok.isPythonProject, "a requirements.txt project is a Python project")
    expect(ok.recommendedTestCommand == "pytest", "pytest.ini yields the pytest command")
    expect(ok.missingExecutable == nil, "pytest in the virtualenv's bin/ is found")
    expect(ok.virtualEnvName == ".venv", "the virtualenv folder is named")
    expect(ok.pythonVersion == .ok("Python 9.9.9 dwb=1"), "the virtualenv's Python version is read")
    expect(ok.pytestInstalled == .ok("True"), "pytest presence is read")
    expect(ok.pytestStarts == .ok("pytest 0.0.0"), "the pytest start check ran")
    expect(ok.pipCheck == .ok("No broken requirements found."), "pip check ran")
    expect(ProjectEnvironmentAssessor.assess(ok).readiness == .ready, "a healthy fake project is ready")

    let broken = makeFakePythonProject(name: "broken", withPytestBinary: false, body: """
    case "$*" in
      "--version") echo "Python 9.9.9 dwb=$PYTHONDONTWRITEBYTECODE" ;;
      *find_spec*) echo True ;;
      "-m pytest --version --noconftest -p no:cacheprovider") printf 'Traceback\\nSystemError: boom\\n'; exit 1 ;;
      "-m pip check") echo "x 1 requires y"; exit 1 ;;
    esac
    """)
    defer { try? FileManager.default.removeItem(at: broken) }
    let bad = await ProjectEnvironmentInspector.inspect(repoRoot: broken, inherited: inherited, timeout: 10)
    expect(bad.pytestStarts == .failed("Traceback\nSystemError: boom"), "a failing start check keeps its output")
    expect(bad.pipCheck == .failed("x 1 requires y"), "a failing pip check keeps its output")

    let absent = makeFakePythonProject(name: "absent", withPytestBinary: true, body: """
    case "$*" in
      "--version") echo "Python 9.9.9 dwb=$PYTHONDONTWRITEBYTECODE" ;;
      *find_spec*) echo False ;;
      "-m pip check") echo "ok" ;;
    esac
    """)
    defer { try? FileManager.default.removeItem(at: absent) }
    let none = await ProjectEnvironmentInspector.inspect(repoRoot: absent, inherited: inherited, timeout: 10)
    expect(none.pytestInstalled == .ok("False"), "an absent pytest is read as False")
    expect(none.pytestStarts == .notRun, "the start check is skipped when pytest is not installed")

    let slow = makeFakePythonProject(name: "slow", withPytestBinary: true, body: """
    case "$*" in
      "-m pip check") echo $$ > "$(dirname "$0")/pid"; sleep 30 ;;
      "--version") echo "Python 9.9.9 dwb=$PYTHONDONTWRITEBYTECODE" ;;
      *find_spec*) echo True ;;
      "-m pytest --version --noconftest -p no:cacheprovider") echo "pytest 0.0.0" ;;
    esac
    """)
    defer { try? FileManager.default.removeItem(at: slow) }
    let started = Date()
    let late = await ProjectEnvironmentInspector.inspect(repoRoot: slow, inherited: inherited, timeout: 1)
    expect(late.pipCheck == .timedOut, "a probe that exceeds the time limit is timedOut")
    expect(late.pythonVersion == .ok("Python 9.9.9 dwb=1"), "the other probes still answer when one times out")
    expect(Date().timeIntervalSince(started) < 15, "a timed-out probe does not hold up the inspection")
    let pidText = (try? String(contentsOf: slow.appendingPathComponent(".venv/bin/pid"), encoding: .utf8)) ?? ""
    let probePid = pid_t(pidText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    var isGone = false
    for _ in 0..<30 where probePid > 0 {
        if kill(probePid, 0) != 0 { isGone = true; break }
        try? await Task.sleep(nanoseconds: 100_000_000)
    }
    expect(isGone, "a timed-out probe's process tree is stopped")

    let swiftRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("loop-env-inspect-swift-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: swiftRoot, withIntermediateDirectories: true)
    try? "".write(to: swiftRoot.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: swiftRoot) }
    let swift = await ProjectEnvironmentInspector.inspect(repoRoot: swiftRoot, inherited: inherited, timeout: 10)
    expect(!swift.isPythonProject && swift.pythonVersion == .notRun && swift.pipCheck == .notRun,
           "no Python probe runs for a project that is not Python")
    expect(swift.recommendedTestCommand == "swift test", "a Swift package recommends swift test")
}
#endif
