import Foundation

/// The vendored mermaid bundle, loaded the same way `Hljs` loads highlight.js.
///
/// Vendored rather than fetched from a CDN because the markdown preview is a
/// WKWebView rendering a LOCAL html string and the app is expected to work
/// offline — see `Scripts/build-mermaid-bundle.mjs`.
///
/// Returns "" when the resource is missing, which is a graceful degradation
/// rather than a failure: `MarkdownRenderer`'s render step guards on
/// `window.mermaid`, so an absent bundle just leaves a ```mermaid fence looking
/// like any other code block.
enum Mermaid {
    static let js: String = bundled()

    /// mermaid's own built-in themes; anything else needs a full theme object.
    static func theme(isDark: Bool) -> String { isDark ? "dark" : "default" }

    private static func bundled() -> String {
        // `.copy("Resources/mermaid")` preserves the directory, so unlike
        // Hljs's flat resources this needs the subdirectory. Bundle.main first
        // (where the app build lands), then the SwiftPM module bundle.
        //
        // Never `Bundle.module` here: its generated accessor calls fatalError
        // when the bundle is not beside the .app or at the absolute `.build`
        // path baked in at compile time — i.e. on every machine but the one
        // that built the app. `Bundle(url:)` returns nil instead.
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
        if let r = owning.resourceURL { roots.append(r) }
        if let r = Bundle.main.resourceURL { roots.append(r) }
        for root in roots {
            let bundle = Bundle(url: root.appendingPathComponent("LlmIdeMac_LlmIdeMacLib.bundle"))
            candidates.append(bundle?.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "mermaid"))
        }
        for case let url? in candidates {
            if let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        }
        return ""
    }
}

/// Anchor class for `Bundle(for:)` — resolves to whichever bundle this module
/// was linked into (the app, or a test bundle).
private final class MermaidBundleLocator {}
