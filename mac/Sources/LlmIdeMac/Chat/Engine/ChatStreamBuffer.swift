import Foundation

/// Accumulates streamed text deltas so they publish in batches rather than
/// per-delta.
///
/// The server emits one SSE chunk per model text delta — 5-20 characters — so
/// a normal reply arrives as a thousand-plus callbacks. Publishing each one
/// straight into `messages` cost a thousand SwiftUI invalidations, a thousand
/// `WKWebView` document reloads, and (via the panel's `.onChange(of:)`) a
/// thousand synchronous session-file read/write pairs, all on the MainActor.
///
/// This type owns only the arithmetic. The flush *timer* stays on `ChatEngine`
/// because it is actor-bound scheduling; keeping the two apart is what makes
/// the batching rules assertable without a running app.
///
/// `public` so `chat-contract-lab` — a separate executable target — can assert
/// it. `@testable import` is available to test targets only, and this
/// toolchain has no XCTest.
public struct ChatStreamBuffer {
    private var text = ""
    private var turnID: UUID?

    public init() {}

    public var isEmpty: Bool { text.isEmpty }

    /// Buffer `chunk` against `id`.
    ///
    /// - Returns: the previous turn's batch when `id` differs from the turn
    ///   currently buffered — text must never append across a turn boundary —
    ///   and `nil` otherwise.
    public mutating func append(_ id: UUID, _ chunk: String) -> (id: UUID, text: String)? {
        var flushed: (id: UUID, text: String)?
        if let current = turnID, current != id {
            flushed = take()
        }
        turnID = id
        text += chunk
        return flushed
    }

    /// Drain the buffer, returning what should be published.
    public mutating func take() -> (id: UUID, text: String)? {
        defer { text = ""; turnID = nil }
        guard !text.isEmpty, let id = turnID else { return nil }
        return (id, text)
    }

    /// Drop buffered text without publishing it. For the one case where the
    /// buffer is genuinely unwanted: the turn's content is about to be replaced
    /// wholesale by the server's authoritative final reply, so flushing first
    /// would append text the overwrite is about to discard anyway — and would
    /// briefly render a duplicated tail while it did.
    public mutating func discard() {
        text = ""
        turnID = nil
    }
}
