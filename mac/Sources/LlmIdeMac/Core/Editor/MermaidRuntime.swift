import Foundation

// On-demand install of the optional mermaid component (see `Mermaid`).
//
// Three layers, so the security-relevant part is testable without a network
// or the main actor:
//   - `MermaidDownloading`  — the network seam (tests inject a fake).
//   - `MermaidInstaller`    — fetch → verify pinned SHA-256 → atomic write.
//   - `MermaidRuntime`      — main-actor state the UI observes.

/// Fetches the bytes of one URL.
///
/// Contract:
/// - Precondition: `maxBytes > 0`.
/// - Postcondition: returns the COMPLETE body of a 2xx response, never a
///   partial one; throws on a transport error, a non-2xx status, or a body
///   larger than `maxBytes`.
/// - `progress` is called with the running byte count, from any thread. It is
///   advisory only — callers must not rely on it being called at all.
/// - The returned bytes are UNTRUSTED. Verification is the caller's job.
protocol MermaidDownloading: Sendable {
    func fetch(_ url: URL, maxBytes: Int,
               progress: @escaping @Sendable (Int) -> Void) async throws -> Data
}

/// `URLSession`-backed downloader used by the app.
struct URLSessionMermaidDownloader: MermaidDownloading {
    let session: URLSession

    /// Ephemeral, so the 3.4 MB body is not also parked in the shared URL
    /// cache — the verified copy on disk is the only one worth keeping.
    private static let ephemeralSession = URLSession(configuration: .ephemeral)

    static func makeDefault() -> MermaidDownloading {
        URLSessionMermaidDownloader(session: ephemeralSession)
    }

    func fetch(_ url: URL, maxBytes: Int,
               progress: @escaping @Sendable (Int) -> Void) async throws -> Data {
        let (bytes, response) = try await session.bytes(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw MermaidInstallError.badResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw MermaidInstallError.httpStatus(http.statusCode)
        }
        // Refuse up front when the server already says it is too big, and
        // again while streaming for a server that does not say — the cap is
        // what stops a misbehaving mirror from growing this buffer unbounded.
        if response.expectedContentLength > Int64(maxBytes) {
            throw MermaidInstallError.tooLarge(limit: maxBytes)
        }
        return try await Self.collect(
            bytes, maxBytes: maxBytes,
            expectedLength: Int(clamping: max(0, response.expectedContentLength)),
            progress: progress)
    }

    /// Bytes handed to `Data` / `progress` at a time. One progress callback
    /// per chunk is ~55 for this file — a smooth bar without flooding the
    /// main actor.
    static let chunkSize = 65_536

    /// Drain `bytes` into one `Data`, `chunkSize` bytes at a time.
    ///
    /// `URLSession.AsyncBytes` only iterates per byte, but the old loop also
    /// did a `Data.append` + size check + progress test PER BYTE (~3.5 M
    /// times for this file). Here the per-byte work is a store into a
    /// pre-reserved array; the copy into `Data`, the cap check and the
    /// progress report happen once per chunk.
    ///
    /// - Postcondition: returns every byte of `bytes`, or throws `.tooLarge`
    ///   once the running total exceeds `maxBytes` — checked per chunk, so
    ///   memory stays bounded by `maxBytes + chunkSize`.
    /// - `progress` gets the running total after each full chunk and once
    ///   at the end.
    static func collect<Bytes: AsyncSequence>(
        _ bytes: Bytes, maxBytes: Int, expectedLength: Int = 0,
        progress: @escaping @Sendable (Int) -> Void
    ) async throws -> Data where Bytes.Element == UInt8 {
        var data = Data()
        data.reserveCapacity(min(maxBytes, expectedLength))
        var chunk: [UInt8] = []
        chunk.reserveCapacity(chunkSize)
        for try await byte in bytes {
            chunk.append(byte)
            guard chunk.count == chunkSize else { continue }
            data.append(contentsOf: chunk)
            chunk.removeAll(keepingCapacity: true)
            if data.count > maxBytes { throw MermaidInstallError.tooLarge(limit: maxBytes) }
            progress(data.count)
        }
        data.append(contentsOf: chunk)
        if data.count > maxBytes { throw MermaidInstallError.tooLarge(limit: maxBytes) }
        progress(data.count)
        return data
    }
}

enum MermaidInstallError: Error, Equatable, LocalizedError {
    case badResponse
    case httpStatus(Int)
    case tooLarge(limit: Int)
    case integrityMismatch(actual: String)

    var errorDescription: String? {
        switch self {
        case .badResponse:
            return "The download server returned an unexpected response."
        case .httpStatus(let code):
            return "The download failed (HTTP \(code))."
        case .tooLarge:
            return "The download was larger than expected and was discarded."
        case .integrityMismatch:
            return "The downloaded file did not match the expected checksum and was discarded."
        }
    }
}

/// Downloads, verifies and stores one pinned mermaid release.
///
/// Layout: `<root>/runtime/mermaid/<version>/mermaid.min.js`, where `root` is
/// the app's Application Support folder. Versioned so a future pin bump can
/// never serve the previous release's file under the new release's name.
struct MermaidInstaller: Sendable {
    let root: URL
    let version: String
    let expectedSHA256: String
    let sourceURL: URL
    /// Used only to turn byte counts into a progress fraction.
    let expectedBytes: Int
    let maxBytes: Int
    let downloader: MermaidDownloading

    static func makeDefault(
        downloader: MermaidDownloading = URLSessionMermaidDownloader.makeDefault()
    ) -> MermaidInstaller {
        MermaidInstaller(
            root: AppIdentity.applicationSupportRoot(),
            version: Mermaid.version,
            expectedSHA256: Mermaid.sha256,
            sourceURL: Mermaid.downloadURL,
            expectedBytes: Mermaid.byteCount,
            // Generous headroom over the real 3.4 MB; the hash is the actual
            // control, this only bounds memory.
            maxBytes: 16 * 1024 * 1024,
            downloader: downloader
        )
    }

    /// Every installed mermaid version lives under here; `remove()` deletes it.
    var componentDirectory: URL {
        root.appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent("mermaid", isDirectory: true)
    }

    var versionDirectory: URL {
        componentDirectory.appendingPathComponent(version, isDirectory: true)
    }

    var scriptURL: URL {
        versionDirectory.appendingPathComponent("mermaid.min.js", isDirectory: false)
    }

    /// Download and store the pinned release.
    ///
    /// - Postcondition: on return, `scriptURL` holds bytes whose SHA-256 is
    ///   `expectedSHA256`. On throw, nothing at `scriptURL` changed.
    /// - Parameter progress: fraction 0…1, from any thread.
    func install(progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws {
        let total = Double(max(1, expectedBytes))
        let data = try await downloader.fetch(sourceURL, maxBytes: maxBytes) { received in
            progress(min(1, Double(received) / total))
        }
        try commit(data)
    }

    /// Verify `data` against the pinned hash and, only if it matches, write it.
    ///
    /// Split from `install` so the integrity check — the one control between a
    /// network response and script execution in the preview — can be asserted
    /// synchronously, with no downloader at all.
    ///
    /// - Throws: `MermaidInstallError.integrityMismatch` (and writes NOTHING,
    ///   not even the directory) when the hash differs; a file-system error if
    ///   the write fails.
    func commit(_ data: Data) throws {
        let actual = Mermaid.sha256Hex(data)
        guard actual == expectedSHA256 else {
            throw MermaidInstallError.integrityMismatch(actual: actual)
        }
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: versionDirectory, withIntermediateDirectories: true)
        // `.atomic` writes a temporary file in the same directory and renames
        // it over `scriptURL`, so a crash or full disk mid-write can never
        // leave a truncated script where the loader looks. (The loader would
        // reject one by hash anyway — this keeps the good copy in place.)
        try data.write(to: scriptURL, options: .atomic)
        pruneOtherVersions()
    }

    /// Delete every installed version. A no-op when nothing is installed.
    func remove() throws {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: componentDirectory.path) else { return }
        try fileManager.removeItem(at: componentDirectory)
    }

    /// After a pin bump the old release is dead weight nothing can load (the
    /// loader only looks under the current version), so drop it.
    private func pruneOtherVersions() {
        let fileManager = FileManager.default
        guard let entries = try? fileManager.contentsOfDirectory(
            at: componentDirectory, includingPropertiesForKeys: nil) else { return }
        for entry in entries where entry.lastPathComponent != version {
            try? fileManager.removeItem(at: entry)
        }
    }
}

/// The app-wide mermaid install state, observed by the install banner, the
/// Settings card and `MarkdownWebView` (which reloads when it flips to
/// installed, so an open preview draws its diagrams without a manual refresh).
///
/// Nothing here downloads on its own: the app is local-first and must stay
/// usable offline, so `install()` runs only from an explicit user action.
@MainActor
final class MermaidRuntime: ObservableObject {
    enum State: Equatable {
        case notInstalled
        case downloading(Double)
        case installed
        case failed(String)
    }

    static let shared = MermaidRuntime(installer: .makeDefault(), cache: .shared)

    @Published private(set) var state: State

    private let installer: MermaidInstaller
    private let cache: MermaidScriptCache

    init(installer: MermaidInstaller, cache: MermaidScriptCache) {
        self.installer = installer
        self.cache = cache
        self.state = cache.script() == nil ? .notInstalled : .installed
    }

    var isInstalled: Bool { state == .installed }

    var isDownloading: Bool {
        if case .downloading = state { return true }
        return false
    }

    /// The verified script, or nil. Same source `MarkdownRenderer` reads.
    func installedScript() -> String? { cache.script() }

    /// Download, verify and install. Ignored while a download is running.
    func install() async {
        guard !isDownloading else { return }
        state = .downloading(0)
        do {
            try await installer.install { [weak self] fraction in
                Task { @MainActor in self?.reportProgress(fraction) }
            }
            cache.invalidate()
            state = cache.script() == nil
                ? .failed("The installed file could not be read back.")
                : .installed
        } catch {
            state = .failed(Self.message(for: error))
        }
    }

    /// Delete the downloaded copy. The installed copy is the loader's only
    /// candidate, so this always ends `.notInstalled` (or `.failed`).
    func remove() {
        do {
            try installer.remove()
            cache.invalidate()
            state = cache.script() == nil ? .notInstalled : .installed
        } catch {
            state = .failed(Self.message(for: error))
        }
    }

    private func reportProgress(_ fraction: Double) {
        // A late progress hop must not overwrite a finished or failed state.
        guard isDownloading else { return }
        state = .downloading(fraction)
    }

    private static func message(for error: Error) -> String {
        if let urlError = error as? URLError,
           urlError.code == .notConnectedToInternet || urlError.code == .networkConnectionLost {
            return "You appear to be offline. Connect to the internet and try again."
        }
        return error.localizedDescription
    }
}
