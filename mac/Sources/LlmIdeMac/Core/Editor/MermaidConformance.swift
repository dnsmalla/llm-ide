import Foundation

/// The narrow public surface `chat-contract-lab` uses to pin the mermaid
/// installer's integrity check.
///
/// Same reasoning as `GenerationConformance`: this toolchain has no XCTest, so
/// the XCTest/swift-testing suite (`MermaidRuntimeTests`) never runs here, and
/// the check standing between a network response and script execution in the
/// preview needs a gate that actually executes. Every probe works in a fresh
/// temporary directory and never touches the network.
public enum MermaidConformance {
    /// A wrong-hash payload is rejected with `integrityMismatch` and leaves
    /// nothing behind — not the script, not even its directory.
    public static func wrongHashIsRejectedAndNothingWritten() -> Bool {
        withTemporaryRoot { root in
            let installer = makeInstaller(root: root, expecting: Data("good".utf8))
            do {
                try installer.commit(Data("tampered".utf8))
                return false
            } catch MermaidInstallError.integrityMismatch {
                return !FileManager.default.fileExists(atPath: installer.scriptURL.path)
                    && !FileManager.default.fileExists(atPath: installer.componentDirectory.path)
            } catch {
                return false
            }
        }
    }

    /// A matching payload is written byte-for-byte at the versioned path.
    public static func matchingHashIsWritten() -> Bool {
        withTemporaryRoot { root in
            let payload = Data("window.mermaid = {};".utf8)
            let installer = makeInstaller(root: root, expecting: payload)
            guard (try? installer.commit(payload)) != nil else { return false }
            return (try? Data(contentsOf: installer.scriptURL)) == payload
        }
    }

    /// A file edited on disk after install is never served to a web view.
    public static func tamperedInstalledFileIsNotServed() -> Bool {
        withTemporaryRoot { root in
            let payload = Data("window.mermaid = {};".utf8)
            let installer = makeInstaller(root: root, expecting: payload)
            guard (try? installer.commit(payload)) != nil,
                  (try? Data("evil()".utf8).write(to: installer.scriptURL)) != nil else { return false }
            let cache = MermaidScriptCache(expectedSHA256: installer.expectedSHA256,
                                           candidates: { [installer.scriptURL] })
            return cache.script() == nil
        }
    }

    /// The download's chunked collector returns every byte, reports progress
    /// once per full chunk plus once at the end, and throws `tooLarge` past
    /// the cap. Driven by an in-memory stream — no network.
    public static func chunkedCollectorKeepsBytesProgressAndCap() -> Bool {
        let chunk = URLSessionMermaidDownloader.chunkSize
        let count = chunk * 2 + 10
        let expected = Data((0..<count).map { UInt8(truncatingIfNeeded: $0) })
        return runBlocking {
            let log = ProgressLog()
            guard let data = try? await URLSessionMermaidDownloader.collect(
                byteStream(count), maxBytes: count, progress: { log.record($0) }),
                  data == expected,
                  log.values == [chunk, chunk * 2, count] else { return false }
            do {
                _ = try await URLSessionMermaidDownloader.collect(
                    byteStream(count), maxBytes: chunk, progress: { _ in })
                return false
            } catch MermaidInstallError.tooLarge {
                return true
            } catch {
                return false
            }
        }
    }

    /// The loader looks in exactly one place: the installed copy. (The old
    /// in-bundle lookups kept serving a stale dev `.build` copy after
    /// `remove()`.)
    public static func onlyInstalledCopyIsACandidate() -> Bool {
        Mermaid.candidateURLs() == [Mermaid.installedScriptURL]
            && Mermaid.installedScriptURL.path.hasSuffix(
                "runtime/mermaid/\(Mermaid.version)/mermaid.min.js")
    }

    /// The install path relative to the Application Support root.
    public static func installedScriptRelativePath() -> String {
        let root = URL(fileURLWithPath: "/root", isDirectory: true)
        let installer = makeInstaller(root: root, expecting: Data())
        return String(installer.scriptURL.path.dropFirst(root.path.count + 1))
    }

    /// The pinned download URL, so the lab can assert it names an exact version.
    public static var pinnedDownloadURL: String { Mermaid.downloadURL.absoluteString }
    public static var pinnedVersion: String { Mermaid.version }

    // MARK: - Private

    private struct OfflineDownloader: MermaidDownloading {
        func fetch(_ url: URL, maxBytes: Int,
                   progress: @escaping @Sendable (Int) -> Void) async throws -> Data {
            throw URLError(.notConnectedToInternet)
        }
    }

    private final class ProgressLog: @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [Int] = []
        func record(_ value: Int) {
            lock.withLock { recorded.append(value) }
        }
        var values: [Int] {
            lock.withLock { recorded }
        }
    }

    private static func byteStream(_ count: Int) -> AsyncStream<UInt8> {
        AsyncStream { continuation in
            for index in 0..<count { continuation.yield(UInt8(truncatingIfNeeded: index)) }
            continuation.finish()
        }
    }

    /// The lab's top-level code is synchronous. Safe to block here: the work
    /// runs on the global executor and never hops to the main actor.
    private static func runBlocking(_ body: @escaping @Sendable () async -> Bool) -> Bool {
        final class Box: @unchecked Sendable { var value = false }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            box.value = await body()
            done.signal()
        }
        done.wait()
        return box.value
    }

    private static func makeInstaller(root: URL, expecting payload: Data) -> MermaidInstaller {
        MermaidInstaller(root: root, version: Mermaid.version,
                         expectedSHA256: Mermaid.sha256Hex(payload),
                         sourceURL: Mermaid.downloadURL, expectedBytes: payload.count,
                         maxBytes: 1024, downloader: OfflineDownloader())
    }

    private static func withTemporaryRoot(_ body: (URL) -> Bool) -> Bool {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mermaid-conformance-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        return body(root)
    }
}
