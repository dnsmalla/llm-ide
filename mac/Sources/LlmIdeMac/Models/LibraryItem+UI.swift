import SwiftUI

extension LibraryItem.Category {
    /// Category-based colors matching the sidebar scheme:
    ///   Notes / Meetings  → blue family
    ///   Code              → green family
    ///   Data              → purple family
    var uiColor: Color {
        switch self {
        case .meetings: return Color(red: 0.20, green: 0.45, blue: 0.95) // vivid blue
        case .notes:    return .blue
        case .code:     return Color(red: 0.22, green: 0.70, blue: 0.45) // green
        case .data:     return .purple
        }
    }

    /// Folder icon color — category-tinted instead of the default yellow.
    var folderTint: Color {
        switch self {
        case .meetings: return Color(red: 0.35, green: 0.55, blue: 0.85) // soft blue
        case .notes:    return Color(red: 0.40, green: 0.60, blue: 0.90) // blue
        case .code:     return Color(red: 0.35, green: 0.65, blue: 0.45) // green
        case .data:     return Color(red: 0.60, green: 0.45, blue: 0.80) // purple
        }
    }
}

extension LibraryItem {
    /// SF Symbol name — delegates to the shared FileIconKit.
    var fileIcon: String { FileIconKit.icon(for: ext) }

    /// Per-extension colour — delegates to the shared FileIconKit.
    var fileIconColor: Color { FileIconKit.color(for: ext) }
}
