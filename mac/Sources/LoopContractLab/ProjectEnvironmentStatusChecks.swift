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
#endif
