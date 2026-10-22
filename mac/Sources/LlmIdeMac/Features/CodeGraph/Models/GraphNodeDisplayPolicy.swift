import Foundation
import GraphCore

/// Whether a graph node's detail pane shows the node's own body, or the whole
/// file the node points at.
///
/// Extracted from `UAGraphView.shouldRenderFileDetail` so the rule is assertable
/// — as a `private` method on a `View` it was reachable by nothing, which is how
/// it came to exclude `.memoryDoc` unnoticed since the repo's initial commit.
///
/// The distinction is only ever about ONE thing: is the node the whole file, or
/// a piece of it?
///
/// - `.memoryChunk` is a *section* of a document. `MemoryGenerator` emits it
///   alongside — not instead of — the document node, and its `fileURL` points at
///   the parent document. Handing that whole file to the viewer would not show
///   the section the user clicked, so a chunk renders its own body inline.
/// - `.memoryDoc` is the whole document: exactly one node per file, carrying
///   that file's own URL. It belongs in the file viewer. It was excluded
///   alongside chunks by an over-generalisation of the sentence above, which
///   left a `.md` node with no readable content in the app at all.
///
/// Every other kind that carries a `fileURL` names a location IN a file
/// (`symbol`, `function`, …) or the file itself (`file`, `docPage`); both are
/// served by the file viewer, the former with a line reveal.
public enum GraphNodeDisplayPolicy {
    /// True when the node renders its own body text instead of its file.
    static func rendersOwnBodyInline(_ kind: CGNodeKind) -> Bool {
        kind == .memoryChunk
    }

    /// Same rule, addressed by raw value, so `chat-contract-lab` can assert it
    /// without taking a `GraphCore` dependency of its own. Returns nil for a
    /// string that is not a known kind — a typo in an assertion should fail
    /// loudly rather than quietly read as "renders its file".
    public static func rendersOwnBodyInline(kindRawValue: String) -> Bool? {
        CGNodeKind(rawValue: kindRawValue).map(rendersOwnBodyInline)
    }
}
