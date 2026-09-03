import Foundation
import Observation

/// Why a `DiffHunk` was refused before any patch reached `git apply`.
///
/// These are REFUSALS, not git failures: nothing is spawned, so the index is
/// provably untouched. They exist because `git apply --cached` is happy to
/// accept a patch that is well-formed but semantically wrong and write a
/// zero-byte blob for it — see `GitTruthStore.assertPatchable`.
enum HunkPatchError: LocalizedError {
    /// The hunk covers a whole-file creation (`@@ -0,0 …`) or a whole-file
    /// deletion (`@@ … +0,0 @@`).
    case wholeFileHunk(path: String)
    /// The `@@` header isn't a parsable unified-diff range, so the patch's
    /// line counts can't be trusted.
    case unparsableHeader(path: String, header: String)

    var errorDescription: String? {
        switch self {
        case .wholeFileHunk(let path):
            return "\(path): per-hunk staging can't add or delete a whole file — use the file row's + / − button instead."
        case .unparsableHeader(let path, let header):
            return "\(path): this hunk's header (\(header.isEmpty ? "empty" : header)) isn't a unified-diff range, so no patch can be built from it."
        }
    }
}

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

    /// Byte-identical to `GitStatusStore.refresh(root:)`, deliberately — see
    /// that type's note for why the duplicate survives until P3 deletes it,
    /// and fix BOTH when you fix either.
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

    /// Refuse, BEFORE spawning git, any hunk `synthesizePatch` cannot
    /// honestly represent. This is the load-bearing safety check for
    /// per-hunk staging; the view's `canStageHunks`/`canUnstageHunks` gates
    /// are the first line, this is the one that cannot be bypassed.
    ///
    /// **The hazard is a patch that SUCCEEDS.** `synthesizePatch` always
    /// emits a content-modification header (`--- a/p` / `+++ b/p`). Handed a
    /// whole-file add (`@@ -0,0 +1,N @@`) or a whole-file delete
    /// (`@@ -1,N +0,0 @@`), `git apply --cached` accepts it with **exit
    /// status 0** and rewrites the index blob to **zero bytes** instead of
    /// adding or removing the index entry. Verified against real repos:
    /// unstaging the one hunk of a staged new file left `AM <path>` with an
    /// empty blob; doing it to a staged rename left `D  old` + `AM new`,
    /// destroying the rename; staging the one hunk of a deleted file staged
    /// an empty blob instead of the deletion. Commit after any of those and
    /// the user commits an empty file — silently.
    ///
    /// **Why refuse rather than emit `/dev/null` headers.** A `DiffHunk`
    /// carries no origin marker, and the header alone is genuinely
    /// ambiguous: an empty TRACKED file gaining lines produces the same
    /// `@@ -0,0 +1,N @@` as a brand-new file (verified), so `--- /dev/null`
    /// would break that legitimate, currently-working case. And the rename
    /// case is unrepairable in principle — restoring a staged rename needs
    /// the OLD path, which a `DiffHunk` does not carry, so no header choice
    /// can express it. Whole-file add/delete/rename already have correct,
    /// tested handling on `SourceControlService`'s whole-file
    /// `stage`/`unstage`/`discard`; per-hunk staging stays a
    /// modification-only primitive and says so out loud.
    ///
    /// An unparsable header is refused for the same reason: the `@@` counts
    /// are the only promise `synthesizePatch` makes about its body, so a
    /// header git wouldn't recognise cannot produce a patch worth applying.
    /// (`DiffHunk.fromLineDiff` builds hunks with an EMPTY header for the
    /// agent-diff views — those must never reach `git apply`.)
    /// Header parsing is shared with `UnifiedDiffParser` — one strict reader,
    /// two policies. `hunkRanges` returns nil rather than guessing, and the
    /// STRICT half of the contract lives here: an unreadable header is a
    /// refusal, where the parser's own fallback is to keep rendering.
    static func assertPatchable(path: String, hunk: DiffHunk) throws {
        guard let ranges = UnifiedDiffParser.hunkRanges(hunk.header) else {
            throw HunkPatchError.unparsableHeader(path: path, header: hunk.header)
        }
        guard ranges.oldCount > 0, ranges.newCount > 0 else {
            throw HunkPatchError.wholeFileHunk(path: path)
        }
    }

    /// Stage exactly one hunk (not the whole file) via `git apply --cached`,
    /// piping a minimal synthesized patch to its stdin (`RepoManager`'s new
    /// stdin support, added alongside this method). `path` is the file's
    /// repo-relative path — the SAME string `DiffHunk`'s own rows don't
    /// carry (a `DiffHunk` has no path of its own; it's always scoped to
    /// one file by whoever parsed it).
    ///
    /// Throws `HunkPatchError` — WITHOUT spawning git, so the index is
    /// untouched — for any hunk `synthesizePatch` cannot represent; see
    /// `assertPatchable`.
    func stagePatch(root: URL, path: String, hunk: DiffHunk) async throws {
        try Self.assertPatchable(path: path, hunk: hunk)
        let patch = Self.synthesizePatch(path: path, hunk: hunk)
        _ = try await repo.runGit(["apply", "--cached", "-"], at: root, stdin: Data(patch.utf8))
    }

    /// Reverse of `stagePatch` — unstages exactly one currently-staged hunk.
    /// `hunk` must be one parsed from the STAGED diff (`git diff --cached`),
    /// not the working-tree diff, or `--reverse` will apply against the
    /// wrong baseline and `git apply` will correctly reject it.
    ///
    /// Guarded by the SAME `assertPatchable` check as `stagePatch`. The
    /// asymmetry — a guard on the stage side only — was the actual bug:
    /// unstaging is where the whole-file hunks live, because a staged new
    /// file and a staged rename BOTH diff as `@@ -0,0 +1,N @@`.
    func unstagePatch(root: URL, path: String, hunk: DiffHunk) async throws {
        try Self.assertPatchable(path: path, hunk: hunk)
        let patch = Self.synthesizePatch(path: path, hunk: hunk)
        _ = try await repo.runGit(["apply", "--cached", "--reverse", "-"], at: root, stdin: Data(patch.utf8))
    }

    /// Builds the minimal patch text `git apply` needs for one hunk of an
    /// already-tracked file: a `diff --git`/`---`/`+++` header (both sides
    /// name the same path), then the hunk's own `@@` header line verbatim,
    /// then each row reconstructed with its unified-diff prefix character.
    ///
    /// **Modification-only, by construction.** The header this emits is a
    /// content modification, so a whole-file add or delete would be a lie —
    /// and a dangerous one, because git accepts it and empties the blob.
    /// Callers MUST go through `stagePatch`/`unstagePatch`, which run
    /// `assertPatchable` first; do not call this directly.
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
