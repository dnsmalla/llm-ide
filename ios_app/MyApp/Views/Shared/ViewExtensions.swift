import Foundation
import UIKit
import SwiftUI

// MARK: — Haptics

extension View {
    /// Fire a one-shot impact haptic. No-op on hardware without a Taptic Engine
    /// (UIKit handles the fallback). Replaces the private `haptic(_:)` helpers
    /// that were copy-pasted across `LlmIdeControlView` and `AutoTaskView`, and
    /// the one inline call left in `ExplorerChatView.send()`.
    func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
}

// MARK: — Relative time

extension Date {
    /// Construct from epoch seconds — the wire format the Mac sends for
    /// `lastUsedAt` / `lastRunDate` / `lastUpdated` (`timeIntervalSince1970`).
    init(epochSeconds: Double) {
        self.init(timeIntervalSince1970: epochSeconds)
    }

    /// Short localized relative string (e.g. "2h ago"). Replaces the private
    /// `relativeTime(from:)` statics duplicated in `ExplorerChatView` and
    /// `AutoTaskView`. A new `RelativeDateTimeFormatter` is allocated per call
    /// (matching pre-refactor behavior); if this ever lands on a hot path,
    /// cache a formatter on a static lazy.
    func relativeTimeShort() -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: self, relativeTo: Date())
    }
}
