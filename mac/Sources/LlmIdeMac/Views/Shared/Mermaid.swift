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
        let candidates = [
            Bundle.main.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "mermaid"),
            Bundle.main.url(forResource: "mermaid.min", withExtension: "js"),
            Bundle.module.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "mermaid"),
        ]
        for case let url? in candidates {
            if let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        }
        return ""
    }
}
