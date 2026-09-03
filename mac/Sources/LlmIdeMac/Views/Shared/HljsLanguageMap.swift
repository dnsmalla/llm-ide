/// Shared source of truth for mapping a file extension to a highlight.js
/// language id. Used by `DiffWebView` (unified diff) — `CodeWebView`, the
/// other former consumer, was retired in P1 (VS Code parity plan) in favor
/// of `MonacoEditorView`.
///
/// Hint only — `hljs.highlightAuto()` handles unknown extensions reasonably;
/// an empty id means "no language class".
enum HljsLanguage {
    static let map: [String: String] = [
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

    /// Look up the hljs language id for a file extension, with the same
    /// `lowercased()` normalization and `""` fallback both web views rely on.
    static func id(for language: String) -> String {
        map[language.lowercased()] ?? ""
    }
}
