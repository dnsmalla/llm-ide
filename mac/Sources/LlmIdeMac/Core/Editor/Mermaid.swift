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
/// view, wherever it came from (download, disk, or a stale dev bundle).
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

    /// Where a script may be found, in order: a dev build's leftover bundled
    /// copy first (so nothing breaks for a checkout mid-migration), then the
    /// user-installed copy.
    static func candidateURLs() -> [URL] {
        bundledCandidateURLs() + [MermaidInstaller.makeDefault().scriptURL]
    }

    /// The pre-on-demand lookup, kept only for dev builds that still have the
    /// file beside them (an old `.build` resource bundle). A release `.app` no
    /// longer contains it — `Scripts/build.sh` excludes it.
    ///
    /// Never `Bundle.module` here: its generated accessor calls fatalError when
    /// the bundle is not beside the .app or at the absolute `.build` path baked
    /// in at compile time — i.e. on every machine but the one that built the
    /// app. `Bundle(url:)` returns nil instead.
    private static func bundledCandidateURLs() -> [URL] {
        var candidates = [
            Bundle.main.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "mermaid"),
            Bundle.main.url(forResource: "mermaid.min", withExtension: "js"),
        ]
        let owning = Bundle(for: MermaidBundleLocator.self)
        var roots: [URL] = []
        for base in [owning.bundleURL, Bundle.main.bundleURL] {
            roots.append(base)
            roots.append(base.deletingLastPathComponent())
        }
        if let resourceURL = owning.resourceURL { roots.append(resourceURL) }
        if let resourceURL = Bundle.main.resourceURL { roots.append(resourceURL) }
        for root in roots {
            let bundle = Bundle(url: root.appendingPathComponent("LlmIdeMac_LlmIdeMacLib.bundle"))
            candidates.append(bundle?.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "mermaid"))
        }
        return candidates.compactMap { $0 }
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

/// Anchor class for `Bundle(for:)` — resolves to whichever bundle this module
/// was linked into (the app, or a test bundle).
private final class MermaidBundleLocator {}
