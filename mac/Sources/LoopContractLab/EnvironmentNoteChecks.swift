import Foundation
import LlmIdeMacLib

// Asserts `EnvironmentNoteWriter` (Core): the `system/memory/environment.md`
// note the server's repo-memory reader hands the chat agents, so they know
// this machine's virtualenv, PATH additions and project files without
// rediscovering them. Core, so these run in every feature profile.

private func makeNoteFixture() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("env-note-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func touch(_ relative: String, in root: URL, _ body: String = "") {
    let url = root.appendingPathComponent(relative)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? body.write(to: url, atomically: true, encoding: .utf8)
}

func runEnvironmentNoteChecks() {
    print("environment note")
    let fm = FileManager.default
    let home = makeNoteFixture()
    let project = makeNoteFixture()
    defer {
        try? fm.removeItem(at: home)
        try? fm.removeItem(at: project)
    }
    try? fm.createDirectory(at: home.appendingPathComponent(".local/bin"), withIntermediateDirectories: true)
    let inherited = ["HOME": home.path, "PATH": "/usr/bin:/bin"]

    let repo = project.appendingPathComponent("code/app")
    touch(".venv/pyvenv.cfg", in: repo, "home = /usr/bin\nversion = 3.11.4\n")
    touch("pyproject.toml", in: repo)
    touch("uv.lock", in: repo)
    touch("package.json", in: repo, "{}")
    touch("pnpm-lock.yaml", in: repo)
    touch("src/app/__init__.py", in: repo)
    touch("tests/test_app.py", in: repo)

    let note = EnvironmentNoteWriter.render(projectRoot: project, repoRoot: repo, inherited: inherited)
    expect(note.hasPrefix("# Runtime environment"), "the note starts with its title")
    expect(note.contains("Repository: `code/app`"), "the repo is named relative to the project root")
    expect(note.contains("`.venv` (Python 3.11.4)"), "the virtualenv and its Python version (from pyvenv.cfg) are named")
    expect(note.contains("pyproject.toml, uv.lock"), "the Python project files present are listed")
    expect(note.contains("package.json, pnpm-lock.yaml"), "the Node project files present are listed")
    expect(note.contains("node_modules: not installed"), "a Node project without node_modules says so")
    expect(note.contains("~/.local/bin"), "PATH dirs the app adds are listed, with $HOME shown as ~")
    expect(note.contains("Top-level folders: src, tests"), "top-level folders are listed, hidden ones (.venv) skipped")
    expect(!note.contains(home.path), "no absolute home path leaks into the note")

    let bare = makeNoteFixture()
    defer { try? fm.removeItem(at: bare) }
    let bareNote = EnvironmentNoteWriter.render(projectRoot: bare, repoRoot: bare, inherited: inherited)
    expect(bareNote.contains("Python virtualenv: none"), "a project without a virtualenv says so")
    expect(!bareNote.contains("Node project files"), "a project without Node files has no Node line")

    // MARK: writing

    let written = EnvironmentNoteWriter.write(projectRoot: project, repoRoot: repo, inherited: inherited)
    let noteURL = project.appendingPathComponent("system/memory/environment.md")
    expect(written && (try? String(contentsOf: noteURL, encoding: .utf8)) == note,
           "write puts the rendered note at system/memory/environment.md")
    expect((try? String(contentsOf: project.appendingPathComponent("system/memory/.gitignore"),
                        encoding: .utf8)) == "*\n",
           "write adds the self-ignoring marker, so the machine-specific note is never committed")
    expect(!EnvironmentNoteWriter.write(projectRoot: project, repoRoot: repo, inherited: inherited),
           "an unchanged note is not rewritten")

    // Every caller (project open, Loop run start) describes the SAME repo:
    // the clone-into-code/ child the code graph uses, else the project root.
    try? fm.removeItem(at: noteURL)
    EnvironmentNoteWriter.write(projectRoot: project, inherited: inherited)
    expect((try? String(contentsOf: noteURL, encoding: .utf8))?.contains("Repository: `code/app`") == true,
           "writing for a project describes its code/<repo> child, the same repo the code graph uses")

    let custom = makeNoteFixture()
    defer { try? fm.removeItem(at: custom) }
    touch("system/memory/.gitignore", in: custom, "graph-notes.md\n")
    _ = EnvironmentNoteWriter.write(projectRoot: custom, repoRoot: custom, inherited: inherited)
    expect((try? String(contentsOf: custom.appendingPathComponent("system/memory/.gitignore"),
                        encoding: .utf8)) == "graph-notes.md\nenvironment.md\n",
           "an existing memory .gitignore that does not cover the note gets the note's line appended")

    let covered = makeNoteFixture()
    defer { try? fm.removeItem(at: covered) }
    touch("system/memory/.gitignore", in: covered, "*\n")
    _ = EnvironmentNoteWriter.write(projectRoot: covered, repoRoot: covered, inherited: inherited)
    expect((try? String(contentsOf: covered.appendingPathComponent("system/memory/.gitignore"),
                        encoding: .utf8)) == "*\n",
           "a memory .gitignore that already ignores everything is left untouched")
}
