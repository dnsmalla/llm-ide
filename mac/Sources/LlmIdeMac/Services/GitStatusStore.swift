import Foundation
import Observation

/// Repo-relative path → effective git status, for file-tree decorations.
/// Reuses StatusParser (no parsing duplication). Refreshed by the Explorer.
///
/// **Superseded by `GitTruthStore`, and a deliberate duplicate of it until
/// P3 lands.** `refresh`, `decoration(forAbsolute:root:isDirectory:)` and
/// `decoration(for:existing:)` below are byte-identical to `GitTruthStore`'s;
/// that store adds line marks and per-hunk patching on top and is the one new
/// code should use. This file survives only because `ExplorerView` and
/// `TreeRowLabel.gitStatus` still name `GitStatusStore.Decoration`, and P3's
/// Explorer rewiring deletes it outright — the type swap IS the
/// consolidation.
///
/// It is left duplicated rather than delegated on purpose: forwarding to
/// `GitTruthStore` would add an observation-forwarding layer to a file that
/// is about to be deleted, and there is no XCTest or live-view harness in
/// this toolchain to prove the forwarding still notifies SwiftUI. **Until
/// then, a fix to either `refresh` must be made to BOTH** — the two are
/// downstream of the same `StatusParser.unquote`, so a parsing fix that lands
/// in one and not the other shows up as "Explorer and Source Control disagree
/// about the same file".
@MainActor @Observable
final class GitStatusStore {
    enum Decoration { case modified, added, untracked, deleted, conflicted }
    private(set) var byPath: [String: Decoration] = [:]   // repo-relative path
    private(set) var dirsWithChanges: Set<String> = []     // repo-relative dir paths
    private let repo = RepoManager()

    /// Identical to `GitTruthStore.refresh(root:)` — see the type's note.
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
}
