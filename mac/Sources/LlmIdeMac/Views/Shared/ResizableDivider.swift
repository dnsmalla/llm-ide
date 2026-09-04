import SwiftUI
import AppKit

/// A vertical `Divider` with an invisible 8pt drag handle over it, writing a
/// clamped width back to `width`.
///
/// This is the fixed-width-column counterpart to `persistedPanelWidth`. That
/// modifier works by reading an `HSplitView` child's RENDERED width back
/// through a `GeometryReader` — useless for a column that is pinned outside
/// the split view precisely because `HSplitView` would not respect its cap
/// (see `ExplorerView.body`'s comment). Here the drag is the source of truth.
///
/// Pair it with an `@AppStorage` binding and the width persists across
/// launches with no extra plumbing.
struct ResizableDivider: View {
    @Binding var width: Double
    var minWidth: Double = 160
    var maxWidth: Double = 520

    /// Width at the moment the drag began. `DragGesture.translation` is
    /// cumulative from the gesture's start, so accumulating it onto the LIVE
    /// width would apply each delta repeatedly and make the pane fly away.
    @State private var dragStartWidth: Double?

    /// Whether the pointer is currently inside the handle.
    ///
    /// `NSCursor.push()`/`pop()` manipulate a process-wide STACK, so they must
    /// be balanced exactly. `onHover` can deliver the same value twice (and
    /// fires again while a drag leaves the 8pt strip), and an unmatched `pop()`
    /// corrupts the cursor for the whole app — a stuck resize arrow with no way
    /// back short of relaunching. This flag makes each push have exactly one
    /// pop.
    @State private var isHovering = false

    /// Pure so the bounds behavior is testable without a gesture. `minWidth`
    /// wins if the bounds are inverted (a window narrower than the minimum),
    /// because a value below it leaves the user with a sliver they cannot
    /// grab to drag back.
    ///
    /// The finiteness guard is not theoretical padding: this value is written
    /// straight to `@AppStorage`, and a NaN that got stored once would come
    /// back on every launch as a NaN `.frame(width:)` — an invalid dimension
    /// SwiftUI cannot lay out, with no user-reachable way to correct it.
    static func clamp(_ proposed: Double, minWidth: Double, maxWidth: Double) -> Double {
        guard proposed.isFinite else { return minWidth }
        return min(max(proposed, minWidth), max(minWidth, maxWidth))
    }

    var body: some View {
        Divider()
            .overlay(alignment: .center) {
                Rectangle()
                    .fill(Color.clear)
                    .frame(width: 8)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        guard inside != isHovering else { return }
                        isHovering = inside
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { value in
                                let start = dragStartWidth ?? width
                                if dragStartWidth == nil { dragStartWidth = start }
                                width = Self.clamp(start + Double(value.translation.width),
                                                   minWidth: minWidth, maxWidth: maxWidth)
                            }
                            .onEnded { _ in dragStartWidth = nil }
                    )
                    .accessibilityLabel("Resize file tree")
                    .onDisappear {
                        // Hiding the tree while the pointer sits on the handle
                        // would otherwise leave the pushed cursor on the stack.
                        if isHovering { NSCursor.pop(); isHovering = false }
                    }
            }
    }
}
