import Foundation
import LlmIdeMacLib

// Asserts `StageCommandAvailability`: the preflight that finds a missing
// executable BEFORE a shell stage runs. Loop lives under Features/Loop, so the
// whole file vanishes from builds that exclude it (same as the other Loop checks).

#if FEATURE_AUTOTASK
private func makeFile(_ name: String, in dir: URL, mode: Int) {
    FileManager.default.createFile(atPath: dir.appendingPathComponent(name).path,
                                   contents: Data("#!/bin/sh\n".utf8),
                                   attributes: [.posixPermissions: mode])
}

func runStageCommandAvailabilityChecks() {
    print("stage command availability")
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("loop-cmd-availability-\(UUID().uuidString)")
    let bin = root.appendingPathComponent("bin")
    try? FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: bin.appendingPathComponent("adir"),
                                             withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    makeFile("pytest", in: bin, mode: 0o755)
    makeFile("notexec", in: bin, mode: 0o644)
    let path = bin.path

    func missing(_ command: String) -> String? {
        StageCommandAvailability.missingExecutable(in: command, path: path)
    }

    expect(missing("pytest") == nil, "an executable on PATH is found")
    expect(missing("pytest -q tests/") == nil, "arguments are ignored")
    expect(missing("nosuchtool") == "nosuchtool", "an absent executable is reported by name")
    expect(missing("cd src && pytest") == nil, "a builtin before && is not looked up")
    expect(missing("cd src && nosuchtool") == "nosuchtool", "each && segment is checked")
    expect(missing("pytest || nosuchtool") == "nosuchtool", "each || segment is checked")
    expect(missing("pytest; nosuchtool") == "nosuchtool", "each ; segment is checked")
    expect(missing("pytest | nosuchtool") == "nosuchtool", "each pipe segment is checked")
    expect(missing("echo \"a && nosuchtool\"") == nil,
           "an operator inside quotes is not a command boundary")
    expect(missing("nosuchtool --grep \"a b\"") == "nosuchtool",
           "a quoted argument still leaves the leading word checked")
    expect(missing("FOO=1 nosuchtool") == nil,
           "an environment-assignment prefix is undecidable, so it passes")
    expect(missing("./gradlew test") == nil, "a relative path is not looked up on PATH")
    expect(missing("/usr/bin/env nosuchtool") == nil, "an absolute path is not looked up on PATH")
    expect(missing("$(which nosuchtool)") == nil, "a substitution is undecidable, so it passes")
    expect(missing("notexec") == "notexec", "a file without the execute bit is not found")
    expect(missing("adir") == "adir", "a directory is not found")
    expect(missing("") == nil, "an empty command reports nothing")

    // Additional quoting and unreliable-character tests
    expect(missing("pytest \"x && nosuchtool y\"") == nil,
           "quoted operators with a quoted word ending cleanly pass (unreliableCharacters guard prevents parsing)")
    expect(missing("pytest&&nosuchtool") == "nosuchtool", "no-space operator is still split")
    expect(missing("pytest\t-q") == nil, "tab-separated arguments are handled like spaces")
    expect(missing("pytest &&") == nil, "a trailing operator with no right side reports nothing")
    expect(missing("&&") == nil, "an operator-only string reports nothing")

    // Heredocs and comments: both contain unreliable characters so the whole
    // command must be treated as a single unit (leading word only).
    expect(missing("pytest <<EOF\nhello world\nEOF") == nil,
           "a heredoc redirection is undecidable, so it passes (< is unreliable)")
    expect(missing("pytest # run; then x") == nil,
           "a comment's content is undecidable, so it passes (# is unreliable)")

    // New builtins added to shellWords
    expect(missing("pushd dir && pytest") == nil,
           "pushd is a builtin and is not looked up on PATH")

    // Stage level: the project's virtualenv is searched first.
    let tool = "llmide-no-such-tool-xyz"
    let repo = root.appendingPathComponent("repo")
    let venvBin = repo.appendingPathComponent(".venv/bin")
    try? FileManager.default.createDirectory(at: venvBin, withIntermediateDirectories: true)
    try? "home = /usr/bin\n".write(to: repo.appendingPathComponent(".venv/pyvenv.cfg"),
                                   atomically: true, encoding: .utf8)
    makeFile(tool, in: venvBin, mode: 0o755)
    let bare = root.appendingPathComponent("bare")
    try? FileManager.default.createDirectory(at: bare, withIntermediateDirectories: true)

    let stage = LoopStage(id: "t", name: "Test", kind: .shellCommand, command: tool, order: 0)
    let inherited = ["PATH": "", "HOME": bare.path]
    expect(StageCommandAvailability.problem(for: stage, repoRoot: repo, inherited: inherited) == nil,
           "a tool inside the project's virtualenv satisfies the check")
    let problem = StageCommandAvailability.problem(for: stage, repoRoot: bare, inherited: inherited)
    expect(problem?.contains(tool) == true, "the problem names the missing tool")
    expect(problem?.contains("no project virtualenv") == true,
           "the problem says when no virtualenv was found")
    let skill = LoopStage(id: "s", name: "Skill", kind: .skill, order: 0)
    expect(StageCommandAvailability.problem(for: skill, repoRoot: bare, inherited: inherited) == nil,
           "a stage without a shell command is never reported")
}
#endif
