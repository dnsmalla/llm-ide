import Foundation

/// Whether the executables a shell stage's command names can be found BEFORE
/// the stage runs.
///
/// Without this, a missing tool is only discovered by running the stage, which
/// exits 127 and lands in the journal as a failed run with no hint of the fix.
/// This is a convenience, never a gate on correctness: anything it cannot
/// decide with certainty PASSES, because stopping a run that would have worked
/// costs far more than letting one that will not work fail at exit 127.
public enum StageCommandAvailability {
    /// Words the shell handles itself, so PATH never resolves them.
    static let shellWords: Set<String> = [
        "cd", "export", "set", "unset", "source", "exit", "eval", "exec", "read", "wait", "umask",
        "alias", "unalias", "ulimit", "pwd", "type", "command", "trap", "shift", "return", "local",
        "if", "then", "elif", "else", "fi", "for", "in", "do", "done", "while", "until", "case",
        "esac", "function", "time", "true", "false", "test", "echo", "printf",
        "declare", "typeset", "let", "readonly", "pushd", "popd", "dirs", "break", "continue",
        "builtin", "hash", "getopts", "jobs", "fg", "bg", "disown", "select", "mapfile", "history",
    ]

    /// Characters that make splitting a command by operator unreliable: a
    /// quoted `&&` is an argument, not a boundary; heredoc redirection and comments
    /// contain multiple words that are not commands.
    private static let unreliableCharacters = CharacterSet(charactersIn: "\"'\\$`(){}<#")

    /// The first executable the command names that is not on `path`, or nil.
    public static func missingExecutable(in command: String, path: String) -> String? {
        executableNames(in: command).first { !isOnPath($0, path: path) }
    }

    /// The reason a shell stage cannot run in `repoRoot`'s environment, or nil.
    public static func problem(for stage: LoopStage, repoRoot: URL,
                               inherited: [String: String]) -> String? {
        guard stage.kind == .shellCommand, let command = stage.command else { return nil }
        let path = ProjectRuntimeEnvironment.overrides(for: repoRoot, inherited: inherited)["PATH"] ?? ""
        guard let missing = missingExecutable(in: command, path: path) else { return nil }
        let searched = ProjectRuntimeEnvironment.virtualEnvironment(in: repoRoot)
            .map { "searched the project's \($0.lastPathComponent)/ first" }
            ?? "no project virtualenv (.venv/ or venv/) found"
        return "\"\(missing)\" is not installed or not on PATH (\(searched))"
    }

    /// The problem of the FIRST enabled, non-advisory shell stage, or nil.
    /// Later stages are not checked: an earlier stage may provision the
    /// environment (create `.venv`, install tools) that they need, so they keep
    /// the runtime exit-127 path. Advisory stages never gate.
    public static func firstProblem(in orderedStages: [LoopStage], repoRoot: URL,
                                    inherited: [String: String])
        -> (stageId: String, stageName: String, problem: String)? {
        guard let first = orderedStages.first(where: {
            $0.kind == .shellCommand && $0.severity != .advisory
        }), let problem = problem(for: first, repoRoot: repoRoot, inherited: inherited) else { return nil }
        return (first.id, first.name, problem)
    }

    /// Plain command names the string starts a segment with. Undecidable
    /// words (paths, substitutions, assignments, builtins) are dropped.
    static func executableNames(in command: String) -> [String] {
        let segments: [String]
        if command.rangeOfCharacter(from: unreliableCharacters) != nil {
            // Only the leading word is trustworthy when quoting is involved.
            segments = [command]
        } else {
            segments = command
                .replacingOccurrences(of: "&&", with: "\n")
                .replacingOccurrences(of: "||", with: "\n")
                .replacingOccurrences(of: ";", with: "\n")
                .replacingOccurrences(of: "|", with: "\n")
                .components(separatedBy: .newlines)
        }
        var names: [String] = []
        for segment in segments {
            guard let word = segment.split(whereSeparator: \.isWhitespace).first.map(String.init) else {
                continue
            }
            // Checked on the RAW word: `.` and `NAME=value` are not plain names.
            if changesEnvironment(word) { break }
            guard isPlainName(word), !shellWords.contains(word) else { continue }
            names.append(word)
        }
        return names
    }

    /// Words after which PATH may differ from the one we inspected, so every
    /// later segment is undecidable.
    private static let environmentChangingWords: Set<String> = [
        "source", ".", "export", "eval", "set", "unset", "alias", "hash", "declare", "typeset",
    ]

    private static func changesEnvironment(_ word: String) -> Bool {
        environmentChangingWords.contains(word)
            || word.range(of: #"^[A-Za-z_][A-Za-z0-9_]*="#, options: .regularExpression) != nil
    }

    private static func isPlainName(_ word: String) -> Bool {
        word.range(of: #"^[A-Za-z0-9][A-Za-z0-9._+-]*$"#, options: .regularExpression) != nil
    }

    static func isOnPath(_ name: String, path: String, fileManager: FileManager = .default) -> Bool {
        path.split(separator: ":").contains { directory in
            let candidate = (String(directory) as NSString).appendingPathComponent(name)
            var isDirectory: ObjCBool = false
            return fileManager.fileExists(atPath: candidate, isDirectory: &isDirectory)
                && !isDirectory.boolValue && fileManager.isExecutableFile(atPath: candidate)
        }
    }
}
