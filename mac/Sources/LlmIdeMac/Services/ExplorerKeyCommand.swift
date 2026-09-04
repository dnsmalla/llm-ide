import Foundation

/// Pure key → Explorer-tree-command routing, so the tree's `onKeyPress`
/// handler stays a two-line call and every binding decision is testable
/// without a running view.
///
/// Deliberately NOT handling ↑/↓: SwiftUI's `List` already moves its own
/// selection (including ⇧-extend), and returning a command for those would
/// require reimplementing that correctly. `resolve` answers `nil` for them,
/// the handler returns `.ignored`, and `List` gets the key.
///
/// Lives under `Services/`, not `Views/Explorer/`, because `Package.swift`
/// excludes `Views/Explorer` wholesale from a build with `file_explorer`
/// deselected but excludes NO test file — a resolver under `Views/Explorer/`
/// would make `ExplorerKeyCommandTests` fail to compile in every lite build.
enum ExplorerKeyCommand: Equatable {
    case expand
    case collapse
    case open
    case rename
    case cut
    case copy
    case paste

    /// The AppKit function-key scalars SwiftUI's `KeyEquivalent` constants
    /// carry (`NSRightArrowFunctionKey` = 0xF703, `NSLeftArrowFunctionKey` =
    /// 0xF702, `NSF2FunctionKey` = 0xF705). Named here rather than inlined so
    /// `ExplorerKeyCommandTests` can pin them against
    /// `KeyEquivalent.rightArrow.character` — a wrong literal would otherwise
    /// show up only as dead arrow keys in the app.
    static let rightArrow: Character = "\u{F703}"
    static let leftArrow: Character = "\u{F702}"
    static let returnKey: Character = "\r"
    /// F2 — the rename key on macOS and in VS Code. It has to be routed here
    /// rather than through a `.keyboardShortcut` because the tree's rows are
    /// `List` rows now, not buttons.
    static let f2: Character = "\u{F705}"

    /// `command` is whether ⌘ was held. The ONLY command chords claimed are
    /// ⌘X/⌘C/⌘V; everything else command-modified is left to the system —
    /// ⌘←/⌘→ are macOS line-navigation chords, and ⌘⏎ is reserved.
    static func resolve(character: Character, command: Bool) -> ExplorerKeyCommand? {
        if command {
            // ⇧⌘C reports "C", so compare lowercased — otherwise the shifted
            // chord falls through as an unhandled key. Compared as a `String`
            // rather than via `Character(character.lowercased())`:
            // `Character(_:)` requires exactly one grapheme and user input
            // isn't guaranteed to be one. This switch has no need to
            // reconstruct a `Character` either way.
            switch character.lowercased() {
            case "x": return .cut
            case "c": return .copy
            case "v": return .paste
            default:  return nil
            }
        }
        switch character {
        case rightArrow: return .expand
        case leftArrow:  return .collapse
        case returnKey:  return .open
        case f2:         return .rename
        default:         return nil
        }
    }
}
