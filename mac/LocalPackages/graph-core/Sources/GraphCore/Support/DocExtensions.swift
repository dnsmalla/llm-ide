import Foundation

/// Which file extensions count as documents rather than code.
///
/// This is a **shared convention**, not an engine implementation detail: the
/// app routes files between its code and doc tracks by it, an engine chunks by
/// it, and a change-detection fingerprint has to cover exactly the same set or
/// the cache breaks in both directions (stale graphs, or a rewrite on every
/// run). It lives in GraphCore so all three agree without the app having to
/// reach into a producer package — which would defeat the split that lets the
/// engine be uninstalled.
public enum DocExtensions {
    /// Markdown and plain text. The default doc set: "md is doc".
    public static let markdownAndText: Set<String> = ["md", "mdx", "markdown", "txt"]
}
