import Foundation
import Observation

/// Repo-relative path -> effective git status, for file-tree decorations and
/// (Task 8) editor gutter marks. Supersedes `GitStatusStore` — same
/// behavior, same names, so P3's Explorer rewiring is a type swap, not a
/// rewrite. `GitStatusStore.swift` is deleted once that swap happens; it is
/// deliberately left in place (unused by anything new) until then so this
/// task doesn't break `ExplorerView`'s build.
///
/// The bug `GitStatusStore` had in practice was never in this logic — it was
/// that Explorer passed a root with no `.git` of its own (a container
/// folder holding several clones). `refresh` already degrades safely for
/// that case (empty status, no throw); the fix is entirely in what root
/// callers pass — see `WorkspaceRoot.gitWorkingTree(config:projectStore:)`,
/// which P1/P3 must use instead of a raw project/container path.
@MainActor @Observable
final class GitTruthStore {
    /// `: Equatable` (the original `GitStatusStore.Decoration` this is
    /// ported from has no test exercising `==` on it, so the gap was latent
    /// there — `GitTruthStoreTests` compares `Decoration?` via
    /// `XCTAssertEqual`, which needs it).
    enum Decoration: Equatable { case modified, added, untracked, deleted, conflicted }

    private(set) var byPath: [String: Decoration] = [:]   // repo-relative path
    private(set) var dirsWithChanges: Set<String> = []     // repo-relative dir paths
    private let repo: RepoManager

    // NOTE: default value is `nil`, not `RepoManager()`, because a default
    // *parameter* value expression is evaluated in a nonisolated context in
    // this toolchain (Swift 6.2.3, language mode v5) even when both the
    // parameter type and the enclosing initializer are `@MainActor` — unlike
    // a stored-property initializer, which does inherit the type's actor
    // isolation. `RepoManager()` in the signature itself fails to compile
    // with "call to main actor-isolated initializer 'init()' in a
    // synchronous nonisolated context". Coalescing in the body sidesteps it
    // without changing observable behavior: `GitTruthStore()` still gets a
    // fresh `RepoManager`.
    init(repo: RepoManager? = nil) {
        self.repo = repo ?? RepoManager()
    }

    func refresh(root: URL?) async {
        guard let root,
              FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path) else {
            byPath = [:]; dirsWithChanges = []; return
        }
        guard let out = try? await repo.runGit(
            ["status", "--porcelain=v1", "--untracked-files=all"], at: root) else { return }
        let changes = StatusParser.parse(porcelain: out)
        var map: [String: Decoration] = [:]
        for c in changes {
            // Prefer the strongest signal if a path appears staged+unstaged.
            map[c.path] = decoration(for: c.status, existing: map[c.path])
        }
        // Roll up: every ancestor dir of a changed path is "has changes".
        var dirs = Set<String>()
        for path in map.keys {
            var comps = path.split(separator: "/").map(String.init)
            guard !comps.isEmpty else { continue }
            comps.removeLast()
            var acc = ""
            for comp in comps {
                acc = acc.isEmpty ? comp : acc + "/" + comp
                dirs.insert(acc)
            }
        }
        byPath = map; dirsWithChanges = dirs
    }

    /// Decoration for an absolute file/dir URL within `root` (nil = clean).
    func decoration(forAbsolute url: URL, root: URL, isDirectory: Bool) -> Decoration? {
        let rootPath = root.standardizedFileURL.path
        let p = url.standardizedFileURL.path
        guard p.hasPrefix(rootPath + "/") else { return nil }
        let rel = String(p.dropFirst(rootPath.count + 1))
        if isDirectory { return dirsWithChanges.contains(rel) ? .modified : nil }  // folder tint = changed
        return byPath[rel]
    }

    /// Working-tree line marks for one file — what the editor gutter should
    /// decorate. `git diff HEAD -- path` combines staged and unstaged changes
    /// in one call, with new-line numbers already relative to the CURRENT
    /// working file, so no separate staged/unstaged merge is needed.
    ///
    /// A file this store's own `byPath` reports as `.added`/`.untracked` has
    /// no HEAD blob — `git diff HEAD` produces nothing for it even though the
    /// whole file is new content, so that case is handled directly from the
    /// file's current contents instead of a diff.
    func lineMarks(root: URL, path: String) async -> [Int: GitGutter.Mark] {
        if byPath[path] == .added || byPath[path] == .untracked {
            guard let text = try? String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) else {
                return [:]
            }
            if text.isEmpty { return [:] }
            // A trailing newline (the normal case for a text file) produces a
            // phantom empty trailing component if left in — drop it so
            // "a\nb\nc\n" counts as 3 lines, not 4. Split on `\.isNewline`
            // character-by-character rather than `CharacterSet.newlines`
            // component splitting: `.newlines` treats \r and \n as two
            // separate splits, inserting a spurious empty component between
            // them and over-counting lines for CRLF content. Same technique
            // `UnifiedDiffParser.parse` already uses for exactly this reason
            // (see its doc comment) — Swift treats "\r\n" as one extended
            // grapheme cluster, so a single `removeLast()` drops the whole
            // terminator without truncating the line before it.
            var content = text
            if let last = content.last, last.isNewline { content.removeLast() }
            let lineCount = content.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count
            return Dictionary(uniqueKeysWithValues: (1...lineCount).map { ($0, GitGutter.Mark.added) })
        }
        guard let diff = try? await repo.runGit(["diff", "HEAD", "--", path], at: root), !diff.isEmpty else {
            return [:]
        }
        return GitGutter.changedLines(fromDiff: diff)
    }

    private func decoration(for s: FileChange.Status, existing: Decoration?) -> Decoration {
        switch s {
        case .untracked:  return existing ?? .untracked
        case .added:      return .added
        case .deleted:    return .deleted
        case .renamed:    return .modified
        case .conflicted: return .conflicted
        case .modified:   return existing == .added ? .added : .modified
        }
    }

    /// Stage exactly one hunk (not the whole file) via `git apply --cached`,
    /// piping a minimal synthesized patch to its stdin (`RepoManager`'s new
    /// stdin support, added alongside this method). `path` is the file's
    /// repo-relative path — the SAME string `DiffHunk`'s own rows don't
    /// carry (a `DiffHunk` has no path of its own; it's always scoped to
    /// one file by whoever parsed it).
    func stagePatch(root: URL, path: String, hunk: DiffHunk) async throws {
        let patch = Self.synthesizePatch(path: path, hunk: hunk)
        _ = try await repo.runGit(["apply", "--cached", "-"], at: root, stdin: Data(patch.utf8))
    }

    /// Reverse of `stagePatch` — unstages exactly one currently-staged hunk.
    /// `hunk` must be one parsed from the STAGED diff (`git diff --cached`),
    /// not the working-tree diff, or `--reverse` will apply against the
    /// wrong baseline and `git apply` will correctly reject it.
    func unstagePatch(root: URL, path: String, hunk: DiffHunk) async throws {
        let patch = Self.synthesizePatch(path: path, hunk: hunk)
        _ = try await repo.runGit(["apply", "--cached", "--reverse", "-"], at: root, stdin: Data(patch.utf8))
    }

    /// Builds the minimal patch text `git apply` needs for one hunk of an
    /// already-tracked file: a `diff --git`/`---`/`+++` header (both sides
    /// name the same path — this task's use case is always a modification,
    /// never a whole-file add/delete, which stay on `SourceControlService`'s
    /// existing whole-file `stage`/`discard`), then the hunk's own `@@`
    /// header line verbatim, then each row reconstructed with its unified-
    /// diff prefix character.
    private static func synthesizePatch(path: String, hunk: DiffHunk) -> String {
        var lines = [
            "diff --git a/\(path) b/\(path)",
            "--- a/\(path)",
            "+++ b/\(path)",
            hunk.header,
        ]
        for row in hunk.rows {
            switch row.kind {
            case .context: lines.append(" " + row.text)
            case .insert:  lines.append("+" + row.text)
            case .delete:  lines.append("-" + row.text)
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private var watcher: RepoFileWatcher?

    /// Start live-refreshing on filesystem changes under `root`. Debounced
    /// 2s by `RepoFileWatcher`'s default — the same coalescing window
    /// `GraphAutoUpdater` already relies on. Safe to call repeatedly (e.g. on
    /// every workspace-root change): replaces any existing watcher.
    /// `RepoFileWatcher.init?` returns nil if FSEvents can't start (rare) —
    /// in that case this is a silent no-op and callers keep whatever manual
    /// refresh path they already have.
    func startWatching(root: URL) {
        stopWatching()
        watcher = RepoFileWatcher(repoRoot: root, debounce: 2.0) { [weak self] in
            // Fires on the watcher's own background queue — hop back to the
            // main actor before touching `self`.
            Task { @MainActor in
                await self?.refresh(root: root)
            }
        }
    }

    func stopWatching() {
        watcher?.stop()
        watcher = nil
    }
}
