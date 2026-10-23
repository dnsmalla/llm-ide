import CryptoKit
import Foundation

/// mermaid.js, the renderer behind ```mermaid fences in the markdown preview.
///
/// An OPTIONAL component: it is 3.4 MB and only a document that actually
/// contains a mermaid fence needs it, so the app no longer ships it. The user
/// installs it once, on demand (`MermaidRuntime.install()`), into Application
/// Support. Until then a ```mermaid fence renders as an ordinary code block —
/// `MarkdownRenderer`'s render step guards on `window.mermaid`, so an absent
/// script degrades gracefully rather than failing.
///
/// Everything here is pinned: one exact release, one exact SHA-256. mermaid
/// bundles its own DOMPurify, and that is what makes `securityLevel: 'strict'`
/// actually sanitise the SVG the preview injects with innerHTML — so a script
/// that is not byte-for-byte the reviewed release is never handed to a web
/// view, wherever it came from (the download, or a file edited on disk).
enum Mermaid {
    /// The pinned mermaid release. Bumping it means bumping `sha256` and
    /// `byteCount` together: `Scripts/mermaid-pin.mjs <version>` prints all
    /// three after checking the CDN file against the npm tarball.
    static let version = "11.17.2"

    /// SHA-256 of `dist/mermaid.min.js` at `version`. Computed from the copy
    /// that used to be vendored in the app AND confirmed identical to the CDN
    /// file at `downloadURL` (2026-10-23).
    static let sha256 = "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8"

    /// Size of the pinned file, for the "3.4 MB, one-time download" copy and
    /// as a sanity bound on the download.
    static let byteCount = 3_572_661

    /// Exact-version URL: jsDelivr serves an `@x.y.z` path immutably, unlike a
    /// range (`@11`) that would silently move under the pinned hash and turn
    /// every install into an integrity failure.
    static let downloadURL = URL(string: "https://cdn.jsdelivr.net/npm/mermaid@\(version)/dist/mermaid.min.js")!

    /// The verified script, or nil when mermaid is not installed (or what is
    /// on disk fails the integrity check).
    static func script() -> String? { MermaidScriptCache.shared.script() }

    /// mermaid's own built-in themes; anything else needs a full theme object.
    static func theme(isDark: Bool) -> String { isDark ? "dark" : "default" }

    /// Lowercase hex SHA-256 of `data`.
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Where the user-installed copy lives. Resolved ONCE per process: the
    /// path cannot change while the app runs, and resolving it is not free —
    /// `MermaidInstaller.makeDefault()` goes through
    /// `AppIdentity.applicationSupportRoot()`, which stats (and may create)
    /// the support folder. Before this was cached, every render of a fenced
    /// document with mermaid NOT installed (a cache miss — misses are not
    /// cached, see `MermaidScriptCache`) repeated that file-system work.
    static let installedScriptURL: URL = MermaidInstaller.makeDefault().scriptURL

    /// Where a script may be found: only the user-installed copy.
    ///
    /// The old in-bundle `mermaid/mermaid.min.js` lookups are gone: the app no
    /// longer ships the file, and a stale `.build` resource bundle that still
    /// had it made `MermaidRuntime.remove()` look inert in dev builds (the
    /// loader went on serving the leftover copy).
    static func candidateURLs() -> [URL] {
        [installedScriptURL]
    }
}

/// Process-wide cache of the verified script.
///
/// `MarkdownRenderer.html` is a synchronous, non-isolated function, so this
/// cannot live on the main-actor `MermaidRuntime`. A hit is cached for the
/// life of the process (3.4 MB read + hash once, not per render); a miss is
/// NOT cached, so an install made in this session is picked up on the next
/// render without anyone having to remember to invalidate. `invalidate()` is
/// still called after install/remove so a removed script stops being served.
final class MermaidScriptCache: @unchecked Sendable {
    static let shared = MermaidScriptCache(
        expectedSHA256: Mermaid.sha256,
        candidates: { Mermaid.candidateURLs() }
    )

    private let lock = NSLock()
    private var cached: String?
    private let expectedSHA256: String
    private let candidates: () -> [URL]

    init(expectedSHA256: String, candidates: @escaping () -> [URL]) {
        self.expectedSHA256 = expectedSHA256
        self.candidates = candidates
    }

    /// The first candidate whose bytes match the pinned hash, as UTF-8 text.
    /// A file that exists but fails the hash is skipped, never executed.
    func script() -> String? {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        for url in candidates() {
            guard let data = try? Data(contentsOf: url),
                  Mermaid.sha256Hex(data) == expectedSHA256,
                  let text = String(data: data, encoding: .utf8) else { continue }
            cached = text
            return text
        }
        return nil
    }

    func invalidate() {
        lock.lock()
        cached = nil
        lock.unlock()
    }
}
