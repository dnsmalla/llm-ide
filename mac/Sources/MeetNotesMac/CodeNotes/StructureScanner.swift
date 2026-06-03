import Foundation

/// Runs the deterministic extractors (Swift/TS/JS line parser + Python AST)
/// and assembles a resolved ScanResult. Supports incremental scanning: on a
/// re-scan only files whose content hash changed are re-parsed; the rest are
/// reused from `.code-notes/scan-cache.json`. The Python subprocess only
/// re-runs when a `.py` file changed/added/removed.
public final class StructureScanner {
    private let launcher: ProcessLauncher
    private let fileExtractor: FileStructureExtractor
    private let python: PythonASTExtractor
    private let gitURL: URL?

    public init(launcher: ProcessLauncher) {
        self.launcher      = launcher
        self.fileExtractor = FileStructureExtractor(launcher: launcher)
        self.python        = PythonASTExtractor(launcher: launcher)
        self.gitURL        = FileStructureExtractor.resolve("git")
    }

    // MARK: - Full (non-incremental) scan

    /// Re-parse everything. Used for tests / when no cache is desired.
    public func scan(repoRoot: URL) async -> ScanResult {
        async let file = fileExtractor.run(repoRoot: repoRoot)
        async let py   = python.run(repoRoot: repoRoot)
        let raws = await file + py
        return Self.assemble(raws)
    }

    // MARK: - Incremental scan

    public struct IncrementalResult: Sendable {
        public let result: ScanResult
        /// Files re-parsed this run (changed + new).
        public let changedPaths: Set<String>
        public let totalFiles: Int
        public let reusedFiles: Int
    }

    /// Re-parse only files whose content hash changed since the last run.
    public func scanIncremental(repoRoot: URL) async -> IncrementalResult {
        let cache = ScanCache.load(forRepo: repoRoot)
        let allPaths = await listTrackedFiles(repoRoot: repoRoot)

        // Hash everything present (cheap single pass; the parse is what we skip).
        var currentHash: [String: String] = [:]
        for path in allPaths {
            let url = repoRoot.appendingPathComponent(path)
            if let data = try? Data(contentsOf: url) {
                currentHash[path] = Fingerprint.hash(of: data)
            }
        }
        let present = Set(currentHash.keys)

        func isPy(_ p: String) -> Bool { (p as NSString).pathExtension.lowercased() == "py" }

        // Classify against the cache.
        var reused: [String: RawFileStructure] = [:]
        var changedNonPy: [String] = []
        var pyChanged = false
        for path in present {
            if let entry = cache.entries[path], entry.hash == currentHash[path] {
                reused[path] = entry.structure
            } else if isPy(path) {
                pyChanged = true
            } else {
                changedNonPy.append(path)
            }
        }
        // A deleted/added .py also forces a Python re-run so stale entries drop.
        let cachedPy  = Set(cache.entries.keys.filter(isPy))
        let currentPy = Set(present.filter(isPy))
        if cachedPy != currentPy { pyChanged = true }

        // Re-parse only changed non-Python files.
        let freshNonPy = fileExtractor.parseFiles(paths: changedNonPy.sorted(), repoRoot: repoRoot)

        // Python: re-run whole-repo only when a .py changed; else reuse cache.
        let pyStructures: [RawFileStructure]
        if pyChanged {
            pyStructures = await python.run(repoRoot: repoRoot)
        } else {
            pyStructures = currentPy.compactMap { reused[$0] }
        }

        // Merge: reused non-py + fresh non-py + python, dropping anything gone.
        var byPath: [String: RawFileStructure] = [:]
        for (path, s) in reused where !isPy(path) { byPath[path] = s }
        for s in freshNonPy   { byPath[s.path] = s }
        for s in pyStructures { byPath[s.path] = s }
        byPath = byPath.filter { present.contains($0.key) }

        let all = Array(byPath.values)
        let result = Self.assemble(all)

        // Persist updated cache (hash + structure for every present file).
        var newEntries: [String: ScanCache.Entry] = [:]
        for s in all where currentHash[s.path] != nil {
            newEntries[s.path] = ScanCache.Entry(hash: currentHash[s.path]!, structure: s)
        }
        ScanCache(entries: newEntries).save(forRepo: repoRoot)

        var changed = Set(changedNonPy)
        if pyChanged { changed.formUnion(currentPy) }
        return IncrementalResult(result: result,
                                 changedPaths: changed,
                                 totalFiles: all.count,
                                 reusedFiles: max(0, all.count - changed.count))
    }

    // MARK: - File listing

    private func listTrackedFiles(repoRoot: URL) async -> [String] {
        let exts = FileStructureExtractor.codeExtensions.union(["py"])
        if let git = gitURL {
            do {
                let (exit, out, _) = try await launcher.run(
                    executable: git, arguments: ["-C", repoRoot.path, "ls-files"],
                    currentDirectory: repoRoot, environment: nil)
                if exit == 0 {
                    return (String(data: out, encoding: .utf8) ?? "")
                        .split(separator: "\n").map(String.init)
                        .filter { exts.contains(($0 as NSString).pathExtension.lowercased()) }
                }
            } catch { /* fall through to FileManager */ }
        }
        return fallbackList(repoRoot: repoRoot, exts: exts)
    }

    private func fallbackList(repoRoot: URL, exts: Set<String>) -> [String] {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: repoRoot, includingPropertiesForKeys: nil,
                                     options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else { return [] }
        let skip: Set<String> = [".git", "node_modules", ".build", "dist", "build",
                                 ".venv", "venv", "__pycache__", ".code-notes", ".mypy_cache"]
        var paths: [String] = []
        for case let url as URL in en {
            if let n = url.pathComponents.last, skip.contains(n) { en.skipDescendants(); continue }
            guard exts.contains(url.pathExtension.lowercased()) else { continue }
            let rel = url.path.hasPrefix(repoRoot.path + "/")
                ? String(url.path.dropFirst(repoRoot.path.count + 1)) : url.path
            paths.append(rel)
        }
        return paths.sorted()
    }

    // MARK: - Assembly

    /// Pure: turn raw per-file structures into a resolved ScanResult.
    public static func assemble(_ raws: [RawFileStructure]) -> ScanResult {
        var byPath: [String: RawFileStructure] = [:]
        for r in raws where byPath[r.path] == nil { byPath[r.path] = r }
        let all = byPath.values.sorted { $0.path < $1.path }
        let fileSet = Set(all.map { $0.path })

        var files:   [ScanResult.FileEntry] = []
        var imports: [String: [String]]     = [:]
        var symbols: [String: [ScanResult.Symbol]] = [:]

        for r in all {
            files.append(.init(path: r.path, language: r.language, loc: r.loc))
            symbols[r.path] = r.symbols
            var resolved: [String] = []
            for imp in r.rawImports {
                if let target = ImportResolver.resolve(imp, fromFile: r.path,
                                                       language: r.language, files: fileSet),
                   target != r.path {
                    resolved.append(target)
                }
            }
            var seen = Set<String>()
            imports[r.path] = resolved.filter { seen.insert($0).inserted }
        }
        return ScanResult(files: files, imports: imports, symbols: symbols)
    }
}
