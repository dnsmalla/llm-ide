import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// After a project switch the Graph view cancels its run, but the previous
/// repo's scan keeps unwinding inside the engine. A Bool "running" flag made
/// Generate on the NEW repo return `.busy` — and do nothing — until then.
@MainActor
final class CodeNoteServiceSupersedeTests: XCTestCase {

    /// Scans of `slowRepo` block until `release()`; any other repo returns at once.
    final class GatedEngine: GraphEngine, @unchecked Sendable {
        let slowRepo: String
        private let lock = NSLock()
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var released = false
        private(set) var slowStarted = false
        init(slowRepo: String) { self.slowRepo = slowRepo }

        var identifier: String { "gated" }
        var displayName: String { "Gated" }
        var supportedDocExtensions: Set<String> { [] }

        func release() {
            lock.lock(); released = true; let w = waiters; waiters = []; lock.unlock()
            w.forEach { $0.resume() }
        }
        func scanCode(repoRoot: URL) async throws -> CodeScan {
            if repoRoot.standardizedFileURL.path == slowRepo {
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    lock.lock()
                    slowStarted = true
                    if released { lock.unlock(); c.resume() } else { waiters.append(c); lock.unlock() }
                }
            }
            return CodeScan(graph: .empty, scan: .empty, changedPaths: [], totalFiles: 0,
                            reusedFiles: 0, reportsSymbols: false)
        }
        func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory { .empty }
        func generateDocMemory(files: [URL]) async throws -> GeneratedMemory { .empty }
        func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData { code }
        func docSetFingerprint(roots: [URL]) -> String { "" }
    }

    private func tempRepo() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("cns-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u.standardizedFileURL
    }

    func testAnotherRepoIsNotBusyWhileASupersededScanUnwinds() async throws {
        let a = try tempRepo(), b = try tempRepo()
        defer { try? FileManager.default.removeItem(at: a); try? FileManager.default.removeItem(at: b) }
        let engine = GatedEngine(slowRepo: a.path)
        let service = CodeNoteService(engine: engine)

        let old = Task { await service.generate(repoRoot: a) }
        while !engine.slowStarted { await Task.yield() }
        old.cancel()   // the project switch

        let fresh = await service.generate(repoRoot: b)
        if case .failure(.busy) = fresh { XCTFail("the new repo must not wait for the old scan") }

        // The same repo is still serialized.
        engine.release()
        let oldResult = await old.value
        if case .success = oldResult { XCTFail("a cancelled, superseded run must not publish") }
        XCTAssertEqual(service.progress, .complete(files: 0, edges: 0, reused: 0),
                       "the superseded run must not overwrite the newer run's progress")
    }

    func testSameRepoStillReportsBusy() async throws {
        let a = try tempRepo()
        defer { try? FileManager.default.removeItem(at: a) }
        let engine = GatedEngine(slowRepo: a.path)
        let service = CodeNoteService(engine: engine)
        let first = Task { await service.generate(repoRoot: a) }
        while !engine.slowStarted { await Task.yield() }
        let second = await service.generate(repoRoot: a)
        XCTAssertEqual(second, .failure(.busy))
        engine.release()
        _ = await first.value
    }
}
