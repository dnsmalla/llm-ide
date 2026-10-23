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
