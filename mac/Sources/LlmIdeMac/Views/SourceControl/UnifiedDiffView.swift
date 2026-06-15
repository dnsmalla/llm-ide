import SwiftUI
import WebKit

/// Read-only unified diff renderer backed by a `WKWebView` + vendored
/// highlight.js — the same offline highlighter scaffold `CodeWebView`
/// uses (Resources/highlight.min.js + atom-one-dark/light CSS). Each
/// `DiffRow` becomes a table row with old/new line gutters, a +/−/space
/// sign cell, and a syntax-highlighted code cell. Insert rows get a green
/// background, delete rows red, context none; only the code cell is run
/// through hljs so the row backgrounds survive highlighting. No wrap +
/// horizontal scroll (the VSCode/Cursor pattern). Empty hunks render a
/// "No changes to show" state for parity with the old SwiftUI view.
struct UnifiedDiffView: View {
    let hunks: [DiffHunk]
    let fileExtension: String
    @EnvironmentObject var theme: ThemeStore

    init(hunks: [DiffHunk], fileExtension: String = "") {
        self.hunks = hunks
        self.fileExtension = fileExtension
    }

    var body: some View {
        if hunks.isEmpty {
            VStack {
                Text("No changes to show")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            DiffWebView(hunks: hunks,
                        language: fileExtension,
                        isDark: theme.current.isDark)
        }
    }
}

// MARK: - WKWebView diff renderer

/// Renders a parsed unified diff as a highlighted HTML table. Mirrors
/// `CodeWebView`'s vendored highlight.js loading: the JS + theme CSS are
/// inlined from `Bundle.main` Resources (no remote CDN — offline + no MITM).
private struct DiffWebView: NSViewRepresentable {
    let hunks: [DiffHunk]
    let language: String
    let isDark: Bool

    func makeNSView(context: Context) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        wv.setValue(false, forKey: "drawsBackground")
        wv.loadHTMLString(html(), baseURL: nil)
        return wv
    }

    func updateNSView(_ wv: WKWebView, context: Context) {
        wv.loadHTMLString(html(), baseURL: nil)
    }

    // MARK: extension → highlight.js language id

    /// Same map as `CodeWebView.hljsLanguageMap`. Hint only — hljs handles
    /// unknown extensions reasonably; an empty id means "no language class".
    private static let hljsLanguageMap: [String: String] = [
        "swift": "swift", "ts": "typescript", "tsx": "typescript",
        "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
        "py": "python", "rb": "ruby", "go": "go", "rs": "rust",
        "java": "java", "kt": "kotlin",
        "c": "c", "h": "c", "cpp": "cpp", "hpp": "cpp", "cc": "cpp",
        "m": "objectivec", "mm": "objectivec",
        "json": "json", "md": "markdown", "yml": "yaml", "yaml": "yaml",
        "sh": "bash", "bash": "bash", "zsh": "bash",
        "html": "xml", "css": "css", "scss": "scss",
        "sql": "sql", "toml": "ini", "ini": "ini", "xml": "xml",
        "env": "bash", "dockerfile": "dockerfile", "makefile": "makefile",
    ]

    private var hljsLanguage: String {
        Self.hljsLanguageMap[language.lowercased()] ?? ""
    }

    // MARK: vendored highlight.js (inlined from Resources)

    private static let hljsJS: String       = bundledText("highlight.min", "js")
    private static let hljsDarkCSS: String  = bundledText("atom-one-dark.min", "css")
    private static let hljsLightCSS: String = bundledText("atom-one-light.min", "css")

    private static func bundledText(_ name: String, _ ext: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return s
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
    }

    private func html() -> String {
        let themeCSS = isDark ? Self.hljsDarkCSS : Self.hljsLightCSS
        let hljsJS   = Self.hljsJS

        let bg      = isDark ? "#1e1e1e" : "#fafafa"
        let fg      = isDark ? "#abb2bf" : "#383a42"
        let gutBg   = isDark ? "#21252b" : "#f0f0f0"
        let gutFg   = isDark ? "#5c6370" : "#9d9d9d"
        let border  = isDark ? "#181a1f" : "#e5e5e5"
        let hdrBg   = isDark ? "#2c313a" : "#eef1f5"
        let hdrFg   = isDark ? "#7f8694" : "#8a9099"
        // Row backgrounds — translucent so the hljs token colors still read.
        let addBg   = isDark ? "rgba(63,185,80,0.16)"  : "rgba(46,160,67,0.13)"
        let delBg   = isDark ? "rgba(248,81,73,0.16)"  : "rgba(207,34,46,0.12)"

        let langClass = hljsLanguage.isEmpty ? "" : " language-\(hljsLanguage)"

        // Build the table rows from the parsed hunks.
        var rowsHTML = ""
        for hunk in hunks {
            rowsHTML += """
            <tr class="hdr"><td class="num"></td><td class="num"></td><td class="sign"></td><td class="code">\(Self.escape(hunk.header))</td></tr>
            """
            for row in hunk.rows {
                let cls: String
                let sign: String
                switch row.kind {
                case .insert: cls = "add"; sign = "+"
                case .delete: cls = "del"; sign = "−"
                case .context: cls = "ctx"; sign = " "
                }
                let oldN = row.oldLine.map(String.init) ?? ""
                let newN = row.newLine.map(String.init) ?? ""
                // Keep at least one char so empty lines render with height.
                let text = row.text.isEmpty ? " " : row.text
                rowsHTML += """
                <tr class="\(cls)"><td class="num">\(oldN)</td><td class="num">\(newN)</td><td class="sign">\(sign)</td><td class="code"><code class="hljs\(langClass)">\(Self.escape(text))</code></td></tr>
                """
            }
        }

        return """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <style>\(themeCSS)</style>
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          html, body { height:100%; background:\(bg); }
          body {
            font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: 12px;
            line-height: 1.55;
            color: \(fg);
          }
          table { border-collapse: collapse; width: 100%; }
          tr.add { background: \(addBg); }
          tr.del { background: \(delBg); }
          tr.hdr td { background: \(hdrBg); color: \(hdrFg); }
          td { vertical-align: top; padding: 0; }
          /* Gutter cells: sticky line numbers, no select. */
          td.num {
            white-space: pre;
            text-align: right;
            color: \(gutFg);
            background: \(gutBg);
            border-right: 1px solid \(border);
            user-select: none;
            -webkit-user-select: none;
            padding: 0 8px;
            min-width: 44px;
            width: 1%;
          }
          td.sign {
            white-space: pre;
            text-align: center;
            color: \(gutFg);
            padding: 0 4px;
            width: 1%;
            user-select: none;
            -webkit-user-select: none;
          }
          td.code { white-space: pre; padding: 0 16px 0 8px; }
          /* hljs adds .hljs to <code>; clear its own background so the
             row's add/del tint shows through. */
          td.code code, td.code code.hljs {
            background: transparent !important;
            padding: 0;
            display: inline;
            font: inherit;
            white-space: pre;
          }
          tr.hdr td.code { white-space: pre; }
        </style>
        </head>
        <body>
        <table>\(rowsHTML)</table>
        <script>\(hljsJS)</script>
        <script>
          (function() {
            try {
              if (!window.hljs) return;
              // Highlight ONLY the code cells (not the hunk-header rows) so
              // the green/red row backgrounds survive.
              var codes = document.querySelectorAll('tr.add td.code code, tr.del td.code code, tr.ctx td.code code');
              for (var i = 0; i < codes.length; i++) {
                try { window.hljs.highlightElement(codes[i]); }
                catch (e) { /* leave plain text on failure */ }
              }
            } catch (e) { /* no-op */ }
          })();
        </script>
        </body>
        </html>
        """
    }
}
