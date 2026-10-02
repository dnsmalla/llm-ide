import Foundation

/// The environment a project's own verify/test commands should run in.
///
/// A Finder-launched app inherits launchd's minimal PATH (`/usr/bin:/bin:…`),
/// so a Loop stage's bare `pytest` or `npm test` used to resolve against
/// whatever the system happened to have — never the project's virtualenv and
/// never a Homebrew/pyenv install. This activates the project's virtualenv
/// (the same two variables `source .venv/bin/activate` sets) and appends the
/// user CLI directories that exist, without installing anything. The
/// inherited PATH keeps its order, so a command that resolved before still
/// resolves to the same binary — only commands that were "not found" gain one.
///
/// NOTE: a git worktree has no gitignored folders, so a worktree run finds no
/// `.venv` here. Borrowing the main checkout's is deliberately NOT done: an
/// editable install (`pip install -e .`) inside it imports the MAIN
/// checkout's source, so the worktree's fix would be tested against the
/// unfixed code and could pass for the wrong reason.
public enum ProjectRuntimeEnvironment {
    /// Virtualenv folder names checked, in priority order.
    static let virtualEnvNames = [".venv", "venv"]

    /// User CLI directories appended (when they exist) after the inherited
    /// PATH. Relative entries are under `$HOME`.
    static let cliDirectories = [
        ".local/bin", ".pyenv/shims", ".cargo/bin", ".volta/bin",
        "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
    ]

    /// The project's virtualenv: the first of `.venv/`, `venv/` under
    /// `repoRoot` that contains `pyvenv.cfg` (which every `venv`/`virtualenv`/
    /// `uv venv` writes — a bare folder of that name is not one).
    public static func virtualEnvironment(in repoRoot: URL) -> URL? {
        let fm = FileManager.default
        return virtualEnvNames
            .map { repoRoot.appendingPathComponent($0) }
            .first { fm.fileExists(atPath: $0.appendingPathComponent("pyvenv.cfg").path) }
    }

    /// Variables to add to (and override in) `inherited` for a command run
    /// at `repoRoot`.
    ///
    /// - Postcondition: always contains `PATH` — the virtualenv's `bin/`
    ///   first, then `inherited`'s own PATH in its own order, then the
    ///   existing CLI directories it lacks, de-duplicated. Contains `VIRTUAL_ENV` only
    ///   when `repoRoot` has a virtualenv.
    public static func overrides(for repoRoot: URL, inherited: [String: String]) -> [String: String] {
        let fm = FileManager.default
        let home = inherited["HOME"] ?? NSHomeDirectory()
        var result: [String: String] = [:]
        var leading: [String] = []
        if let venv = virtualEnvironment(in: repoRoot) {
            leading.append(venv.appendingPathComponent("bin").path)
            result["VIRTUAL_ENV"] = venv.path
        }
        let inheritedPath = (inherited["PATH"] ?? "").split(separator: ":").map(String.init)
        let trailing = cliDirectories
            .map { $0.hasPrefix("/") ? $0 : (home as NSString).appendingPathComponent($0) }
            .filter { fm.fileExists(atPath: $0) }
        var seen = Set<String>()
        result["PATH"] = (leading + inheritedPath + trailing)
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
        return result
    }
}
