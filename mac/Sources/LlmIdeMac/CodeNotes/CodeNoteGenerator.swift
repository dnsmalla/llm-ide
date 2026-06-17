import Foundation
import GraphKit
import os

/// Generates deterministic, human-readable code notes from a ScanResult.
/// No AI — notes are produced directly from structural facts (imports, types,
/// function signatures, roles, reverse-deps). Output lives under
/// `<repo>/.code-notes/`:
///
///   index.md      ← whole-repo summary ranked by impact (LLM reads first)
///   graph.json    ← machine-readable adjacency list for tooling
///   notes/        ← one .md per code file
///
/// Incremental: when `changedPaths` is supplied, only those files' notes are
/// rewritten; unchanged notes already on disk are left untouched. `index.md`
/// and `graph.json` are always rebuilt (whole-repo, cheap). Notes for files no
/// longer present are pruned.
public enum CodeNoteGenerator {

    private static let log = Logger(subsystem: "com.llmide.macapp", category: "CodeNoteGenerator")

    /// Write all artifacts. Returns the number of per-file notes (re)written.
    @discardableResult
    public static func generate(scan: ScanResult, repoRoot: URL,
                                changedPaths: Set<String>? = nil) -> Int {
        let notesRoot = repoRoot.appendingPathComponent(".code-notes/notes", isDirectory: true)
        try? FileManager.default.createDirectory(at: notesRoot, withIntermediateDirectories: true)

        // Self-ignoring marker: makes git ignore everything under `.code-notes`
        // in ANY repo, regardless of the repo's root .gitignore. Idempotent /
        // write-always (cheap), so generated notes never flood Source Control.
        let codeNotesRoot = repoRoot.appendingPathComponent(".code-notes", isDirectory: true)
        try? "*\n".write(to: codeNotesRoot.appendingPathComponent(".gitignore"),
                         atomically: true, encoding: .utf8)

        let usedBy = buildUsedBy(scan: scan)
        let codeFiles = scan.files.filter { $0.language != "other" }

        var written = 0
        for file in codeFiles {
            // Incremental: skip unchanged files whose note already exists.
            if let changed = changedPaths, !changed.contains(file.path) {
                let existing = notesRoot.appendingPathComponent(file.path + ".md")
                if FileManager.default.fileExists(atPath: existing.path) { continue }
            }
            let content = noteMarkdown(path: file.path, scan: scan, usedBy: usedBy)
            let noteURL = notesRoot.appendingPathComponent(file.path + ".md")
            do {
                try FileManager.default.createDirectory(
                    at: noteURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try content.write(to: noteURL, atomically: true, encoding: .utf8)
                written += 1
            } catch {
                // Don't fail the whole run for one note — but surface it so a
                // silent permissions/disk-full failure is observable.
                log.error("note write failed path=\(file.path, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            }
        }

        pruneOrphanNotes(notesRoot: notesRoot, validPaths: Set(codeFiles.map(\.path)))
        writeIndex(scan: scan, usedBy: usedBy, repoRoot: repoRoot)
        writeGraphJSON(scan: scan, usedBy: usedBy, repoRoot: repoRoot)
        return written
    }

    // MARK: - Per-file note

    public static func noteMarkdown(path: String, scan: ScanResult,
                                    usedBy: [String: [String]]) -> String {
        let entry   = scan.files.first { $0.path == path }
        let lang    = entry?.language ?? "unknown"
        let loc     = entry?.loc ?? 0
        let symbols = scan.symbols[path] ?? []
        let imports = scan.imports[path] ?? []
        let role    = inferRole(path: path, language: lang)
        let deps    = (usedBy[path] ?? []).sorted()

        var out: [String] = []
        out.append("# \((path as NSString).lastPathComponent)")
        out.append("")
        out.append("| Field | Value |")
        out.append("|-------|-------|")
        out.append("| **Path** | `\(path)` |")
        out.append("| **Language** | \(lang) |")
        out.append("| **Lines** | \(loc) |")
        out.append("| **Role** | \(role) |")
        out.append("")

        if !imports.isEmpty {
            out.append("## Imports")
            out.append("")
            out.append("| Module | Kind |")
            out.append("|--------|------|")
            for imp in imports.sorted() {
                let isInternal = scan.files.contains { $0.path == imp }
                out.append("| `\((imp as NSString).lastPathComponent)` | \(isInternal ? "internal" : "external") |")
            }
            out.append("")
        }

        let types = symbols.filter { $0.kind == "class" }
        if !types.isEmpty {
            out.append("## Types")
            out.append("")
            out.append("| Name | Line | Declaration |")
            out.append("|------|------|-------------|")
            for t in types {
                let decl = t.declaration.map { "`\($0)`" } ?? "`\(t.name)`"
                out.append("| `\(t.name)` | L\(t.line) | \(decl) |")
            }
            out.append("")
        }

        let funcs = symbols.filter { $0.kind == "function" }
        if !funcs.isEmpty {
            out.append("## Functions")
            out.append("")
            out.append("| Name | Line | Signature |")
            out.append("|------|------|-----------|")
            for f in funcs {
                let sig = f.declaration.map { "`\($0)`" } ?? "`\(f.name)`"
                out.append("| `\(f.name)` | L\(f.line) | \(sig) |")
            }
            out.append("")
        }

        if !deps.isEmpty {
            out.append("## Used By")
            out.append("")
            for d in deps { out.append("- `\((d as NSString).lastPathComponent)`") }
            out.append("")
        }

        out.append("---")
        out.append("*Auto-generated by LLM IDE · regenerate from the Code Graph view*")
        return out.joined(separator: "\n")
    }

    // MARK: - index.md

    static func writeIndex(scan: ScanResult, usedBy: [String: [String]], repoRoot: URL) {
        let codeDir = repoRoot.appendingPathComponent(".code-notes")
        try? FileManager.default.createDirectory(at: codeDir, withIntermediateDirectories: true)

        let codeFiles = scan.files.filter { $0.language != "other" }
        let langs = Array(Set(codeFiles.map(\.language))).sorted().joined(separator: ", ")

        var out: [String] = []
        out.append("# Codebase Index")
        out.append("")
        out.append("| Field | Value |")
        out.append("|-------|-------|")
        out.append("| **Files** | \(codeFiles.count) |")
        out.append("| **Languages** | \(langs) |")
        out.append("| **Total lines** | \(codeFiles.reduce(0) { $0 + $1.loc }) |")
        out.append("")

        let ranked = codeFiles
            .map { f -> (ScanResult.FileEntry, Int) in (f, usedBy[f.path]?.count ?? 0) }
            .sorted { $0.1 > $1.1 }
            .prefix(20)

        out.append("## High-Impact Files")
        out.append("> Files most depended on — change these with care.")
        out.append("")
        out.append("| File | Role | Used By | Functions |")
        out.append("|------|------|---------|-----------|")
        for (f, depCount) in ranked where depCount > 0 {
            let role = inferRole(path: f.path, language: f.language)
            let fns  = scan.symbols[f.path]?.filter { $0.kind == "function" }.count ?? 0
            out.append("| `\((f.path as NSString).lastPathComponent)` | \(role) | \(depCount) | \(fns) |")
        }
        out.append("")

        let byRole = Dictionary(grouping: codeFiles) { inferRole(path: $0.path, language: $0.language) }
        out.append("## Files by Role")
        out.append("")
        for role in byRole.keys.sorted() {
            let files = (byRole[role] ?? []).sorted { $0.path < $1.path }
            out.append("### \(role) (\(files.count) files)")
            out.append("")
            for f in files {
                let fns = scan.symbols[f.path]?.filter { $0.kind == "function" }.count ?? 0
                out.append("- `\(f.path)` — \(f.loc) lines, \(fns) functions")
            }
            out.append("")
        }

        out.append("---")
        out.append("*Auto-generated by LLM IDE · regenerate from the Code Graph view*")
        let indexURL = codeDir.appendingPathComponent("index.md")
        do {
            try out.joined(separator: "\n").write(to: indexURL, atomically: true, encoding: .utf8)
        } catch {
            // Non-fatal, but surface it: a silent failure leaves an empty or
            // stale index.md that looks generated but isn't.
            log.error("index.md write failed path=\(indexURL.path, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - graph.json

    static func writeGraphJSON(scan: ScanResult, usedBy: [String: [String]], repoRoot: URL) {
        let codeDir = repoRoot.appendingPathComponent(".code-notes")

        struct SymEntry: Encodable {
            let name: String; let line: Int; let declaration: String?
        }
        struct FileNode: Encodable {
            let path: String; let name: String; let language: String; let loc: Int
            let role: String; let imports: [String]; let usedBy: [String]
            let types: [SymEntry]; let functions: [SymEntry]
        }
        struct Summary: Encodable { let totalFiles: Int; let totalEdges: Int }
        struct Graph: Encodable { let version: String; let summary: Summary; let files: [FileNode] }

        let codeFiles = scan.files.filter { $0.language != "other" }
        let nodes: [FileNode] = codeFiles.map { f in
            let syms  = scan.symbols[f.path] ?? []
            let types = syms.filter { $0.kind == "class" }
                .map { SymEntry(name: $0.name, line: $0.line, declaration: $0.declaration) }
            let funcs = syms.filter { $0.kind == "function" }
                .map { SymEntry(name: $0.name, line: $0.line, declaration: $0.declaration) }
            return FileNode(path: f.path, name: (f.path as NSString).lastPathComponent,
                            language: f.language, loc: f.loc,
                            role: inferRole(path: f.path, language: f.language),
                            imports: (scan.imports[f.path] ?? []).sorted(),
                            usedBy: (usedBy[f.path] ?? []).sorted(),
                            types: types, functions: funcs)
        }
        let totalEdges = scan.imports.values.reduce(0) { $0 + $1.count }
        let graph = Graph(version: "1.0",
                          summary: Summary(totalFiles: codeFiles.count, totalEdges: totalEdges),
                          files: nodes)
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let graphURL = codeDir.appendingPathComponent("graph.json")
        do {
            try enc.encode(graph).write(to: graphURL, options: .atomic)
        } catch {
            log.error("graph.json write failed path=\(graphURL.path, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Helpers

    /// Inverts scan.imports: filePath → [files that import it].
    public static func buildUsedBy(scan: ScanResult) -> [String: [String]] {
        var usedBy: [String: [String]] = [:]
        for (importer, targets) in scan.imports {
            for target in targets { usedBy[target, default: []].append(importer) }
        }
        return usedBy
    }

    /// Remove note .md files whose source file is no longer present.
    static func pruneOrphanNotes(notesRoot: URL, validPaths: Set<String>) {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: notesRoot, includingPropertiesForKeys: nil) else { return }
        for case let url as URL in en where url.pathExtension == "md" {
            let rel = url.path.hasPrefix(notesRoot.path + "/")
                ? String(url.path.dropFirst(notesRoot.path.count + 1)) : url.lastPathComponent
            // Note path is "<source path>.md" → strip the .md to get the source path.
            let sourcePath = rel.hasSuffix(".md") ? String(rel.dropLast(3)) : rel
            if !validPaths.contains(sourcePath) { try? fm.removeItem(at: url) }
        }
    }

    public static func inferRole(path: String, language: String) -> String {
        let lower    = path.lowercased()
        let filename = (path as NSString).lastPathComponent.lowercased()
        if filename.contains("test")                                    { return "Test" }
        if filename.hasSuffix("viewmodel.swift")                        { return "ViewModel" }
        if filename.hasSuffix("view.swift") ||
           filename.hasSuffix("panel.swift") ||
           filename.hasSuffix("sheet.swift") ||
           filename.hasSuffix("screen.swift")                           { return "View" }
        if filename.hasSuffix("service.swift")                          { return "Service" }
        if filename.hasSuffix("store.swift") ||
           filename.hasSuffix("repository.swift")                       { return "Store" }
        if filename.hasSuffix("client.swift")                           { return "Client" }
        if filename.hasSuffix("error.swift") ||
           filename.hasSuffix("errors.swift")                           { return "Error" }
        if filename.hasSuffix("model.swift")                            { return "Model" }
        if filename.hasSuffix("router.swift") ||
           filename.hasSuffix("coordinator.swift")                      { return "Router" }
        if lower.contains("/viewmodels/")                               { return "ViewModel" }
        if lower.contains("/views/")                                    { return "View" }
        if lower.contains("/models/")                                   { return "Model" }
        if lower.contains("/services/")                                 { return "Service" }
        if language == "typescript" || language == "javascript"         { return "Web" }
        return "Module"
    }
}
