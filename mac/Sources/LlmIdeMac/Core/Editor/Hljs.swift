import Foundation

/// Shared highlight.js assets for the web views that highlight code. A single
/// static cache (these were previously loaded TWICE, once per view).
///
/// highlight.js v11.9.0 is vendored under Resources/ and inlined by callers —
/// no remote CDN, so previews work offline and can't be tampered with in
/// transit (closes a MITM/XSS vector against local file/diff content).
enum Hljs {
    static let js: String       = bundled("highlight.min", "js")
    static let darkCSS: String  = bundled("atom-one-dark.min", "css")
    static let lightCSS: String = bundled("atom-one-light.min", "css")

    static func themeCSS(isDark: Bool) -> String { isDark ? darkCSS : lightCSS }

    private static func bundled(_ name: String, _ ext: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return s
    }
}

