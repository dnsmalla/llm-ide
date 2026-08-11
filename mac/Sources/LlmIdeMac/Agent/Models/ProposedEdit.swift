import Foundation

/// An `update-file` proposal resolved against the real filesystem: which file
/// it lands in, what that file says now, and what it would say afterwards.
///
/// Everything risky about applying an agent edit is decided here, once, so the
/// three call sites that need it (the card's diff preview, the review sheet,
/// and the actual write) can never disagree about the target or the result —
/// a disagreement between "what the diff showed" and "what got written" is the
/// one failure this type exists to make impossible.
struct ProposedEdit: Equatable {
    /// How the target was found. `attachment` files are also tracked in the
    /// chat's attachment list, so applying one has extra bookkeeping (the chip
    /// is retired); `workspace` files were located by the agent itself.
    enum Source: Equatable { case attachment, workspace }

    /// Canonical absolute path — the path that will actually be written. Always
    /// derived from the resolved target, never echoed from the agent's args.
    let absolutePath: String
    /// Path as the user sees it: the attachment chip's label, or the
    /// project-relative path for a workspace file.
    let displayPath: String
    let original: String
    let proposed: String
    let source: Source

    /// True when applying would write the file back unchanged. Callers disable
    /// Apply on this rather than performing a pointless write (which would also
    /// dirty the file's mtime and show up as a spurious git change).
    var isNoOp: Bool { original == proposed }

    var stats: DiffStats { DiffStats.compute(old: original, new: proposed) }
}

/// Why a proposal could not be turned into a write. Each case is surfaced to
/// the user verbatim AND fed back to the agent, so the messages are written to
/// be actionable by both.
enum ProposedEditError: Error, Equatable {
    case noProjectOrAttachment(path: String)
    case outsideProject(path: String, root: String)
    case unreadable(path: String, reason: String)
    case anchorNotFound(path: String)
    case anchorAmbiguous(path: String, count: Int)

    var message: String {
        switch self {
        case .noProjectOrAttachment(let path):
            return "“\(path)” isn't attached to this chat and there's no open project to resolve it in — refusing to write."
        case .outsideProject(let path, let root):
            return "“\(path)” is outside the open project (\(root)) — refusing to write."
        case .unreadable(let path, let reason):
            return "Couldn't read \(path): \(reason)"
        case .anchorNotFound(let path):
            return "The text to replace wasn't found in \(path) — the file may have changed since it was read. Re-read the file and propose the edit again."
        case .anchorAmbiguous(let path, let count):
            return "The text to replace appears \(count) times in \(path) — refusing to guess which one. Include surrounding lines to make the anchor unique."
        }
    }
}

enum ProposedEditResolver {

    /// A file already in the chat's attachment list. Mirrors
    /// `LlmIdeAPIClient.CodeAttachment` as a plain pair so this resolver (and
    /// its tests) don't depend on the API client's types.
    struct KnownFile: Equatable {
        let path: String
        let content: String
        init(path: String, content: String) {
            self.path = path
            self.content = content
        }
    }

    /// Resolve `args` into a concrete, appliable edit.
    ///
    /// - Parameters:
    ///   - attachments: files attached to this chat, matched first — their
    ///     in-memory content is authoritative for the diff.
    ///   - projectRoot: the open project. Any path not matching an attachment
    ///     must resolve INSIDE this directory; without it, non-attached paths
    ///     are refused outright.
    ///   - allowBasenameFallback: permit matching an attachment on basename
    ///     alone when the agent's parent directory is wrong. Callers pass
    ///     `false` when nobody will review the result (auto-edit), where a
    ///     lenient match could silently redirect a write.
    ///   - readFile: injected so tests don't need a real filesystem.
    static func resolve(
        args: PendingTool.UpdateFileArgs,
        attachments: [KnownFile],
        projectRoot: URL?,
        allowBasenameFallback: Bool,
        readFile: (String) throws -> String = {
            try String(contentsOf: URL(fileURLWithPath: $0), encoding: .utf8)
        }
    ) -> Result<ProposedEdit, ProposedEditError> {
        // 1. An attached file wins: its content is what the agent was shown,
        //    so diffing against anything else could hide a concurrent change.
        if let match = matchingAttachment(for: args.path,
                                         in: attachments,
                                         allowBasenameFallback: allowBasenameFallback) {
            return apply(args, to: match.content).map {
                ProposedEdit(absolutePath: PathUtils.canonicalise(match.path),
                             displayPath: match.path,
                             original: match.content,
                             proposed: $0,
                             source: .attachment)
            }
        }

        // 2. Otherwise it must be a file inside the open project.
        guard let projectRoot else {
            return .failure(.noProjectOrAttachment(path: args.path))
        }
        let root = PathUtils.canonicalise(projectRoot.path)
        let absolute = absolutise(args.path, under: root)
        // Containment is checked AFTER canonicalisation, which resolves `..`
        // and follows symlinks — so neither a traversal nor a symlink planted
        // inside the project can point the write somewhere else. The trailing
        // separator matters: without it "/repo-backup" passes a "/repo" prefix.
        guard absolute == root || absolute.hasPrefix(root + "/") else {
            return .failure(.outsideProject(path: args.path, root: PathUtils.homeRelative(root)))
        }
        let current: String
        do {
            current = try readFile(absolute)
        } catch {
            return .failure(.unreadable(path: PathUtils.homeRelative(absolute),
                                        reason: error.localizedDescription))
        }
        return apply(args, to: current).map {
            ProposedEdit(absolutePath: absolute,
                         displayPath: relativeDisplay(of: absolute, under: root),
                         original: current,
                         proposed: $0,
                         source: .workspace)
        }
    }

    // MARK: - Edit application

    /// Turn one of the two edit shapes into the resulting file content.
    private static func apply(_ args: PendingTool.UpdateFileArgs,
                              to current: String) -> Result<String, ProposedEditError> {
        // Whole-file rewrite.
        if let content = args.content {
            return .success(content)
        }
        guard let oldText = args.oldText, !oldText.isEmpty else {
            // The server rejects this shape before it reaches us; treat a
            // malformed proposal as "anchor didn't match" rather than trusting
            // it, so no path here can fall through to writing `current`.
            return .failure(.anchorNotFound(path: args.path))
        }
        let newText = args.newText ?? ""
        // Count matches before touching anything: replacing "the first one" of
        // several is exactly the silent-wrong-edit this refuses to do.
        let matches = occurrences(of: oldText, in: current)
        switch matches {
        case 0: return .failure(.anchorNotFound(path: args.path))
        case 1: break
        default: return .failure(.anchorAmbiguous(path: args.path, count: matches))
        }
        guard let range = current.range(of: oldText) else {
            return .failure(.anchorNotFound(path: args.path))
        }
        return .success(current.replacingCharacters(in: range, with: newText))
    }

    /// Count non-overlapping occurrences. `components(separatedBy:)` would be
    /// shorter but allocates the whole file per call; this walks it once.
    static func occurrences(of needle: String, in haystack: String) -> Int {
        guard !needle.isEmpty else { return 0 }
        var count = 0
        var searchStart = haystack.startIndex
        while searchStart < haystack.endIndex,
              let found = haystack.range(of: needle, range: searchStart..<haystack.endIndex) {
            count += 1
            searchStart = found.upperBound
        }
        return count
    }

    // MARK: - Path resolution

    /// Resolve an agent-supplied path to one of the chat's attachments. The
    /// agent emits absolute paths but the chip stores `~/`-prefixed display
    /// paths, so both sides are normalised before comparing (canonicalisation
    /// lives in `PathUtils` so this uses the same tilde-expansion and
    /// symlink-resolution rules as every other path site in the app).
    static func matchingAttachment(for proposedPath: String,
                                   in attachments: [KnownFile],
                                   allowBasenameFallback: Bool) -> KnownFile? {
        // 1. Exact canonicalised match (handles ~, file://, symlinks, ./).
        let canonProposed = PathUtils.canonicalise(proposedPath)
        if let exact = attachments.first(where: {
            PathUtils.canonicalise($0.path) == canonProposed
        }) {
            return exact
        }
        // 2. Basename match as a fallback when the agent emitted a different
        //    parent path (e.g. it guessed /Users/.../README.md while the user
        //    attached ~/Developer/.../README.md). The agent is supposed to use
        //    the exact attachment path, but LLMs slip — better to update the
        //    obviously-intended file than refuse on a parent-dir difference.
        //    DISABLED in auto-edit mode (allowBasenameFallback=false): with no
        //    confirmation sheet, a poisoned/hallucinated path that merely shares
        //    a basename with an attachment would silently overwrite that file.
        //    Auto mode requires an exact path the agent explicitly chose.
        //    Compared on the RAW basename, because a workspace-relative path
        //    can't be canonicalised meaningfully — that would resolve it
        //    against the process cwd, which for a GUI app is `/`.
        let basename = (proposedPath as NSString).lastPathComponent
        guard allowBasenameFallback, !basename.isEmpty else { return nil }
        let matches = attachments.filter { ($0.path as NSString).lastPathComponent == basename }
        // Only fall back when there's exactly one candidate — if multiple
        // attachments share the basename, the agent's ambiguous path means we
        // can't pick safely.
        return matches.count == 1 ? matches.first : nil
    }

    /// Absolute canonical form of an agent-supplied path. Workspace-relative
    /// paths (what `find-code` returns) are joined onto the project root rather
    /// than resolved against the process working directory.
    static func absolutise(_ raw: String, under root: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let isAbsolute = trimmed.hasPrefix("/") || trimmed.hasPrefix("~")
            || trimmed.hasPrefix("file://")
        if isAbsolute { return PathUtils.canonicalise(trimmed) }
        // Tolerate a "./" prefix and a stray leading "/" from string building.
        var relative = trimmed
        while relative.hasPrefix("./") { relative.removeFirst(2) }
        return PathUtils.canonicalise(root + "/" + relative)
    }

    /// Project-relative label for a workspace file, falling back to a
    /// home-relative absolute path if it somehow isn't under the root.
    static func relativeDisplay(of absolute: String, under root: String) -> String {
        guard absolute.hasPrefix(root + "/") else { return PathUtils.homeRelative(absolute) }
        return String(absolute.dropFirst(root.count + 1))
    }
}
