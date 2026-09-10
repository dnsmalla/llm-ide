import Foundation
import SwiftUI

/// Measured transcript-bubble heights for ONE rendering surface.
///
/// This was previously `ChatEngine.bubbleHeights`, which put view geometry on
/// a shared engine. Its doc comment named a single writer (`ChatMessageList`),
/// but `MenuBarChatView` writes it too — and the quick-chat sheet and the menu
/// bar render the SAME `.quick` engine at different widths, so both wrote the
/// same message id and each clobbered the other's measurement.
///
/// Height is a property of a view, not of a conversation: every surface owns
/// its own cache. Never persisted.
///
/// `public` so `chat-contract-lab` — a separate executable target — can assert
/// it; see `ChatStreamBuffer` for why that gate exists.
@Observable
public final class BubbleHeightCache {
    private var heights: [UUID: CGFloat] = [:]

    public init() {}

    public subscript(id: UUID) -> CGFloat? {
        get { heights[id] }
        set { if heights[id] != newValue { heights[id] = newValue } }
    }

    /// Measured height for `id`, floored at `floor`.
    public func height(for id: UUID, min floor: CGFloat) -> CGFloat {
        Swift.max(heights[id] ?? floor, floor)
    }
}
