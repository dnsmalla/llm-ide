import XCTest
import GraphKit

/// Regression coverage for the fallback (non-git) file-listing path used by
/// `StructureScanner.scanIncremental` and `FileStructureExtractor.run` —
/// exercised whenever a project has no `.git` (so `git ls-files` can't run).
/// Both walkers must skip the indexer's own generated-output directories,
/// or a re-run re-discovers its own previous output as new input and mirrors
/// it one level deeper each time — unbounded, self-referential nesting.
final class StructureScannerFallbackTests: XCTestCase {

    /// `FileManager.temporaryDirectory` returns a `/var/…` path, but the
    /// enumerator these walkers use reports the fully-resolved `/private/var/…`
    /// form (`.resolvingSymlinksInPath()` does not touch `/var` on macOS) — so
    /// tests must canonicalise via `realpath(3)` or every relative-path
    /// assertion below spuriously fails on a mismatch that has nothing to do
    /// with the exclusion logic under test.
    private func canonical(_ url: URL) -> URL {
        var buf = [Int8](repeating: 0, count: Int(PATH_MAX))
        guard realpath(url.path, &buf) != nil else { return url }
        return URL(fileURLWithPath: String(cString: buf))
    }

    private func makeNonGitProject() throws -> URL {
        // Resolve the (existing) temp root first, THEN append the new leaf —
        // realpath(3) needs the path it's given to already exist.
        let dir = canonical(FileManager.default.temporaryDirectory)
            .appendingPathComponent("structure-scanner-fallback-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "export const x = 1;\n".write(
            to: dir.appendingPathComponent("real.ts"), atomically: true, encoding: .utf8)
        // Simulate a PRIOR indexing run's leftover output — exactly what a
        // buggy walker would re-discover and mirror one level deeper.
        let priorOutput = dir.appendingPathComponent("system/graph", isDirectory: true)
        try FileManager.default.createDirectory(at: priorOutput, withIntermediateDirectories: true)
        try "stale mirror\n".write(
            to: priorOutput.appendingPathComponent("real.ts.md"), atomically: true, encoding: .utf8)
        return dir
    }

    func testScanIncrementalFallbackSkipsGeneratedOutputDirs() async throws {
        let dir = try makeNonGitProject()
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(".git").path),
                        "must be a non-git directory to exercise the fallback path")

        let scanner = StructureScanner(launcher: SystemProcessLauncher())
        let incremental = await scanner.scanIncremental(repoRoot: dir)

        XCTAssertTrue(incremental.result.files.contains { $0.path == "real.ts" })
        XCTAssertFalse(incremental.result.files.contains { $0.path.hasPrefix("system/") },
                       "fallback listing must not descend into system/ (generated output)")
    }

    func testFileStructureExtractorFallbackSkipsGeneratedOutputDirs() async throws {
        let dir = try makeNonGitProject()
        defer { try? FileManager.default.removeItem(at: dir) }

        let raws = await FileStructureExtractor(launcher: SystemProcessLauncher()).run(repoRoot: dir)

        XCTAssertTrue(raws.contains { $0.path == "real.ts" })
        XCTAssertFalse(raws.contains { $0.path.hasPrefix("system/") },
                       "fallback enumeration must not descend into system/ (generated output)")
    }
}
