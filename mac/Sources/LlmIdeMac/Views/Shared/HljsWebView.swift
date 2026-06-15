import SwiftUI
import WebKit

/// Shared highlight.js assets + helpers for the code/diff web views. A single
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

    /// HTML-escape for text inserted into the page. Both views run ALL dynamic
    /// content (file content, diff text, blame author names) through this.
    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// The 5 shared palette tokens both views use. Per-view extras (hover,
    /// blame, hunk-header, add/del row tints) stay local to each view.
    struct Palette {
        let bg, fg, gutterBg, gutterFg, border: String
        init(isDark: Bool) {
            bg       = isDark ? "#1e1e1e" : "#fafafa"
            fg       = isDark ? "#abb2bf" : "#383a42"
            gutterBg = isDark ? "#21252b" : "#f0f0f0"
            gutterFg = isDark ? "#5c6370" : "#9d9d9d"
            border   = isDark ? "#181a1f" : "#e5e5e5"
        }
    }

    /// CSS shared by both views' `<head>`: the box-sizing reset, the
    /// html/body background + monospace body font, and the hljs background
    /// reset so the page background shows through highlighted tokens.
    /// `fontSize`/`lineHeight` differ slightly between the two views, so they
    /// are parameters (code: 12.5px/1.6, diff: 12px/1.55).
    static func sharedCSS(palette p: Palette, fontSize: String, lineHeight: String) -> String {
        """
          * { margin:0; padding:0; box-sizing:border-box; }
          html, body { height:100%; background:\(p.bg); }
          body {
            font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: \(fontSize);
            line-height: \(lineHeight);
            color: \(p.fg);
          }
        """
    }
}

/// A WKWebView that renders a self-contained HTML string. Owns the
/// NSViewRepresentable boilerplate (transparent background, loadHTMLString)
/// so call sites only build their HTML.
struct HljsWebView: NSViewRepresentable {
    let html: String

    func makeNSView(context: Context) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        wv.setValue(false, forKey: "drawsBackground")
        wv.loadHTMLString(html, baseURL: nil)
        return wv
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        web.loadHTMLString(html, baseURL: nil)
    }
}
