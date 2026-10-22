import Foundation

/// Which row the Library sidebar has selected.
///
/// Lives in Core (not nested in `ShellState`) because Core's
/// `CompletionController` carries one as a navigation target — accepting a
/// hook/MCP completion row lands on that exact Library row — and Core is a
/// leaf that may not name Shell. `ShellState` (now Core too) keeps
/// `ShellState.LibrarySelection` as a typealias for its existing call sites. Every payload is a plain value
/// (an id string or a file URL), so nothing here depends on a feature.
enum LibrarySelection: Hashable {
    case meeting(String)
    case file(URL)
    /// A plugin row. String is the plugin's `name` field.
    case plugin(String)
    /// An LLM-source row. String is the source's `id` field.
    case llmSource(String)
    /// An MCP-plugin row. String is the plugin's `id` field.
    case mcpPlugin(String)
    /// A connector row. String is the catalog entry's `id` field
    /// (e.g. "box", "slack", "gdrive").
    case connector(String)
}
