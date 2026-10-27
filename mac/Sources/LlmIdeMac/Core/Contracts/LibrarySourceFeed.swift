import SwiftUI

/// The Library items a source picker can list, for a view that must not name
/// `LibraryItemStore` (Doc Gen's source tree lives in a feature).
///
/// Shell injects one at the app root, built over the live store. Reading
/// `items(for:)` inside a view body still registers observation on the
/// `@Observable` store, so the tree refreshes when the Library changes.
/// The default has no items, which is what a view sees outside the app root.
struct LibrarySourceFeed {
    let items: @MainActor (LibraryItem.Category) -> [LibraryItem]

    init(items: @escaping @MainActor (LibraryItem.Category) -> [LibraryItem]) {
        self.items = items
    }

    static let empty = LibrarySourceFeed { _ in [] }
}

private struct LibrarySourceFeedKey: EnvironmentKey {
    static let defaultValue = LibrarySourceFeed.empty
}

extension EnvironmentValues {
    var librarySourceFeed: LibrarySourceFeed {
        get { self[LibrarySourceFeedKey.self] }
        set { self[LibrarySourceFeedKey.self] = newValue }
    }
}
