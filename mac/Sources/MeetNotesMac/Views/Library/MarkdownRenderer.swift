import Foundation

enum MarkdownRenderer {
    static func html(for markdown: String, isDark: Bool) -> String {
        let bg             = isDark ? "#1e1e1e" : "#ffffff"
        let fg             = isDark ? "#d4d4d4" : "#1a1a1a"
        let codeBg         = isDark ? "#2d2d2d" : "#f5f5f5"
        let border         = isDark ? "#3e3e3e" : "#e0e0e0"
        let link           = isDark ? "#6cb6ff" : "#0969da"
        let blockquoteColor = isDark ? "#888" : "#666"

        let escaped = markdown
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "`", with: "\\`")
            .replacingOccurrences(of: "$", with: "\\$")

        return template
            .replacingOccurrences(of: "{{bg}}", with: bg)
            .replacingOccurrences(of: "{{fg}}", with: fg)
            .replacingOccurrences(of: "{{codeBg}}", with: codeBg)
            .replacingOccurrences(of: "{{border}}", with: border)
            .replacingOccurrences(of: "{{link}}", with: link)
            .replacingOccurrences(of: "{{blockquoteColor}}", with: blockquoteColor)
            .replacingOccurrences(of: "{{colorScheme}}", with: isDark ? "dark" : "light")
            .replacingOccurrences(of: "{{content}}", with: escaped)
    }

    private static let template = """
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="{{colorScheme}}">
    <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Helvetica Neue', sans-serif; font-size: 14px;
           line-height: 1.7; padding: 24px; max-width: 860px; margin: 0 auto;
           background: {{bg}}; color: {{fg}}; }
    h1 { font-size: 1.6em; font-weight: 700; margin: 28px 0 12px; border-bottom: 1px solid {{border}}; padding-bottom: 6px; }
    h2 { font-size: 1.3em; font-weight: 600; margin: 24px 0 10px; }
    h3 { font-size: 1.1em; font-weight: 600; margin: 20px 0 8px; }
    p  { margin: 0 0 14px; }
    a  { color: {{link}}; text-decoration: none; }
    a:hover { text-decoration: underline; }
    pre { background: {{codeBg}}; border: 1px solid {{border}}; border-radius: 8px;
          padding: 14px 16px; overflow-x: auto; margin: 14px 0; }
    code { font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 12.5px; }
    p > code, li > code { background: {{codeBg}}; padding: 2px 5px; border-radius: 4px; }
    blockquote { border-left: 3px solid {{border}}; margin: 0 0 14px; padding: 4px 16px;
                 color: {{blockquoteColor}}; }
    ul, ol { padding-left: 24px; margin: 0 0 14px; }
    li { margin: 4px 0; }
    hr { border: none; border-top: 1px solid {{border}}; margin: 24px 0; }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; }
    th, td { border: 1px solid {{border}}; padding: 8px 12px; text-align: left; }
    th { background: {{codeBg}}; font-weight: 600; }
    img { max-width: 100%; border-radius: 6px; }
    </style>
    </head>
    <body>
    <div id="content"></div>
    <script>
    const raw = `{{content}}`;
    function parseMarkdown(text) {
      let html = text;
      const codeBlocks = [];
      html = html.replace(/```(\\w*)\\n?([\\s\\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push('<pre><code>' + escHtml(code.trimEnd()) + '</code></pre>');
        return '\\x00CODE' + idx + '\\x00';
      });
      html = html.replace(/^(?:---|-{3,}|\\*{3,})$/gm, '<hr>');
      html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
      html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
      html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      html = html.replace(/_(.+?)_/g, '<em>$1</em>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
      html = html.replace(/^[\\*\\-] (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
      html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
      html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
      html = html.replace(/\\n\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      html = html.replace(/\\n/g, '<br>');
      codeBlocks.forEach((block, i) => { html = html.replace('\\x00CODE' + i + '\\x00', block); });
      return html;
    }
    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    document.getElementById('content').innerHTML = parseMarkdown(raw);
    </script>
    </body>
    </html>
    """
}
