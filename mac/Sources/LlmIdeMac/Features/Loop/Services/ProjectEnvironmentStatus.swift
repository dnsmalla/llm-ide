import Foundation

/// The outcome of one read-only probe. `notRun` means the probe was skipped
/// on purpose (nothing to ask), which is different from `timedOut`
/// (it was asked and did not answer).
public enum EnvironmentProbe: Equatable {
    case ok(String)
    case failed(String)
    case timedOut
    case notRun
}

/// Everything the inspector learned, with no judgement applied. Keeping the
/// collection and the judgement apart lets the judgement be asserted without
/// running any process.
public struct ProjectEnvironmentFacts: Equatable {
    public var isPythonProject: Bool
    public var recommendedTestCommand: String?
    /// First executable of the recommended command that is not on PATH.
    public var missingExecutable: String?
    /// `.venv` or `venv`; nil when the project has none.
    public var virtualEnvName: String?
    public var pythonVersion: EnvironmentProbe
    /// Output `True` / `False` of an `importlib` spec lookup for pytest.
    public var pytestInstalled: EnvironmentProbe
    public var pytestStarts: EnvironmentProbe
    public var pipCheck: EnvironmentProbe

    public init(isPythonProject: Bool = false, recommendedTestCommand: String? = nil,
                missingExecutable: String? = nil, virtualEnvName: String? = nil,
                pythonVersion: EnvironmentProbe = .notRun, pytestInstalled: EnvironmentProbe = .notRun,
                pytestStarts: EnvironmentProbe = .notRun, pipCheck: EnvironmentProbe = .notRun) {
        self.isPythonProject = isPythonProject
        self.recommendedTestCommand = recommendedTestCommand
        self.missingExecutable = missingExecutable
        self.virtualEnvName = virtualEnvName
        self.pythonVersion = pythonVersion
        self.pytestInstalled = pytestInstalled
        self.pytestStarts = pytestStarts
        self.pipCheck = pipCheck
    }

    /// Whether the recommended command runs pytest as a whole word, so a
    /// `make test` project is not blamed for a pytest that it never calls.
    var usesPytest: Bool {
        guard let command = recommendedTestCommand else { return false }
        return command.range(of: #"(^|[\s;&|/])pytest(\s|$)"#,
                             options: .regularExpression) != nil
    }
}

public struct ProjectEnvironmentStatus: Equatable {
    public enum Readiness: Equatable { case ready, needsSetup, unknown }

    public struct Finding: Equatable {
        public enum Severity: Equatable { case blocking, warning, info }
        public let severity: Severity
        public let message: String
        /// The name of what is missing (for example "pytest"), when there is one.
        public let missing: String?
    }

    public let readiness: Readiness
    public let recommendedTestCommand: String?
    public let findings: [Finding]
}

/// Turns collected facts into what the user is told. Pure.
public enum ProjectEnvironmentAssessor {
    /// `pip check` also reports conflicts that do not stop anything from
    /// running, so its output is capped and never blocks by itself.
    private static let pipCheckLineLimit = 5

    public static func assess(_ facts: ProjectEnvironmentFacts) -> ProjectEnvironmentStatus {
        var findings: [ProjectEnvironmentStatus.Finding] = []
        func add(_ severity: ProjectEnvironmentStatus.Finding.Severity, _ message: String,
                 missing: String? = nil) {
            // One finding per missing thing: "no pytest command" and "pytest
            // not installed" are the same fix.
            if severity == .blocking, let missing,
               findings.contains(where: { $0.severity == .blocking && $0.missing == missing }) { return }
            findings.append(.init(severity: severity, message: message, missing: missing))
        }

        if facts.recommendedTestCommand == nil {
            add(.info, "No test command was detected for this project")
        }
        if let missing = facts.missingExecutable {
            add(.blocking, "\"\(missing)\" is not installed or not on PATH", missing: missing)
        }

        if facts.isPythonProject {
            if facts.virtualEnvName == nil {
                add(.warning, "No project virtualenv (.venv/ or venv/) found — the system Python is used")
            }
            switch facts.pythonVersion {
            case .failed: add(.blocking, "Python could not be run", missing: "python3")
            case .timedOut: add(.warning, "Python did not answer within the time limit")
            default: break
            }
            if facts.usesPytest {
                switch facts.pytestInstalled {
                case .ok(let output):
                    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmed == "False" {
                        add(.blocking, "pytest is not installed for this Python", missing: "pytest")
                    } else if trimmed != "True" {
                        add(.warning, "Could not check whether pytest is installed")
                    }
                case .failed, .timedOut:
                    add(.warning, "Could not check whether pytest is installed")
                default: break
                }
                switch facts.pytestStarts {
                case .failed(let output): add(.blocking, "pytest cannot start: \(lastLine(of: output))")
                case .timedOut: add(.warning, "pytest did not start within the time limit")
                default: break
                }
            }
            if case .failed(let output) = facts.pipCheck {
                let lines = nonEmptyLines(of: output).prefix(pipCheckLineLimit)
                if !lines.isEmpty {
                    add(.warning, "Dependency conflicts: " + lines.joined(separator: "; "))
                }
            }
        }

        let hasBlocking = findings.contains { $0.severity == .blocking }
        let hasUnknown = [facts.pythonVersion, facts.pytestInstalled, facts.pytestStarts].contains(.timedOut)
        return ProjectEnvironmentStatus(
            readiness: hasBlocking ? .needsSetup : (hasUnknown ? .unknown : .ready),
            recommendedTestCommand: facts.recommendedTestCommand,
            findings: findings)
    }

    private static func nonEmptyLines(of text: String) -> [String] {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private static func lastLine(of text: String) -> String {
        nonEmptyLines(of: text).last ?? "no output"
    }
}
