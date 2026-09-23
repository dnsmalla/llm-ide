import Foundation

/// Where a chat-proposed `bash` command runs.
///
/// The tool contract (`extension/llm_agent/global/bash.md`) promises the
/// command "defaults to the active workspace root". `BashService` only sets a
/// working directory when it is given one, so a proposal without
/// `workingDirectory` inherited the app's own cwd — `/` for a GUI app — and
/// `find . -name '*.orig' -delete` in Bypass mode walked the whole disk. The
/// model-supplied directory wasn't contained to the project either.
enum ChatBashDirectory {
    /// Resolve `requested` against the open project:
    /// - nil / empty → the project root
    /// - relative → inside the project root
    /// - absolute or `~` → must canonicalise to the root or a folder inside it
    ///
    /// No project open, or a directory outside it, is a refusal (the message
    /// is fed back to the agent) rather than a silent fallback somewhere else.
    static func resolve(_ requested: String?, repoRoot: URL?) -> Result<URL, Refusal> {
        guard let repoRoot else { return .failure(.noProject) }
        let root = URL(fileURLWithPath: PathUtils.canonicalise(repoRoot.path))
        let raw = requested?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty else { return .success(root) }
        let absolute = raw.hasPrefix("/") || raw.hasPrefix("~") || raw.hasPrefix("file://")
            ? raw
            : root.appendingPathComponent(raw).path
        let url = URL(fileURLWithPath: PathUtils.canonicalise(absolute))
        guard ProjectPaths.isInside(url, root: root) else { return .failure(.outsideProject(url.path)) }
        return .success(url)
    }

    enum Refusal: Error, Equatable {
        case noProject
        case outsideProject(String)

        var message: String {
            switch self {
            case .noProject:
                return "blocked - no project is open, and chat commands only run inside the project folder"
            case .outsideProject(let path):
                return "blocked - working directory \(path) is outside the project folder"
            }
        }
    }
}
