
/// Shared source of truth for mapping a file extension to a vendored Monaco
/// `basic-languages` id (`MonacoEditorView`'s `language` parameter). Separate
/// from `HljsLanguageMap` deliberately: Monaco's vendored bundle (P0,
/// `Scripts/build-monaco-bundle.mjs`) covers exactly 10 languages, a
/// different set than highlight.js's — most notably no `json`, since
/// monaco-editor has never shipped a standalone Monarch tokenizer for it
/// (confirmed against the installed package during P0; only the excluded
/// `language/json/` full-mode plugin has JSON support).
///
/// Unknown/unsupported extensions fall back to `"plaintext"` — Monaco's core
/// editor edits any text with zero language files loaded, just without
/// syntax coloring.
enum MonacoLanguageMap {
    static let map: [String: String] = [
        "swift": "swift",
        "md": "markdown", "markdown": "markdown",
        "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
        "ts": "typescript", "tsx": "typescript",
        "py": "python",
        "sql": "sql",
        "sh": "shell", "bash": "shell", "zsh": "shell",
        "yml": "yaml", "yaml": "yaml",
        "html": "html", "htm": "html",
        "css": "css",
    ]

    /// Look up the Monaco language id for a file extension (case-insensitive,
    /// leading-dot tolerant). Falls back to `"plaintext"` for anything not in
    /// `map` — never an empty string, unlike `HljsLanguageMap.id(for:)`.
    static func id(for extension: String) -> String {
        let key = `extension`.hasPrefix(".") ? String(`extension`.dropFirst()) : `extension`
        return map[key.lowercased()] ?? "plaintext"
    }
}
