import Foundation

/// Gutter-row action offered on the plain editor's decoration hover (stage
/// this file's change / revert it) — file-level actions, since Task 8's
/// `lineMarks` are per-line but P0 has no per-hunk model in the plain editor
/// (that arrives with the diff editor in P2).
enum GutterAction: String, Codable {
    case stage, unstage, revert
}

/// Action on one hunk inside Monaco's diff editor (P2's hunk staging).
enum HunkAction: String, Codable {
    case stage, unstage
}

/// One line's decoration, as sent TO Monaco (`MonacoHost.setDecorations`,
/// Task 13) — `kind` mirrors `GitGutter.Mark`'s three cases as plain strings
/// since the wire format is JSON, not a Swift enum.
struct MonacoDecoration: Codable, Equatable {
    let line: Int
    let kind: String   // "added" | "modified" | "deleted"
}

extension MonacoDecoration {
    /// `GitGutter.Mark` -> the wire string Monaco's `bootstrap.js` switches
    /// on (Task 13's JS: `'llmide-gutter-' + d.kind`).
    static func kind(for mark: GitGutter.Mark) -> String {
        switch mark {
        case .added: return "added"
        case .modified: return "modified"
        case .deleted: return "deleted"
        }
    }

    /// `GitTruthStore.lineMarks`' output, converted to what `MonacoHost`
    /// sends across the bridge (Task 13's `setDecorations`).
    static func decorations(from marks: [Int: GitGutter.Mark]) -> [MonacoDecoration] {
        marks.map { MonacoDecoration(line: $0.key, kind: kind(for: $0.value)) }
    }
}

/// A message Monaco's bootstrap script posts to
/// `window.webkit.messageHandlers.monacoBridge`. Decoded from the message
/// body's JSON by `MonacoHost`'s `WKScriptMessageHandler` (Task 13).
enum MonacoOutboundMessage: Decodable {
    case ready
    case contentChanged(text: String)
    case requestSave
    case gutterAction(line: Int, action: GutterAction)
    case cursorMoved(line: Int, column: Int)
    case diffHunkAction(hunkId: String, action: HunkAction)

    private enum CodingKeys: String, CodingKey {
        case type, text, line, column, action, hunkId
    }

    private enum Kind: String, Decodable {
        case ready, contentChanged, requestSave, gutterAction, cursorMoved, diffHunkAction
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .type) {
        case .ready:
            self = .ready
        case .contentChanged:
            self = .contentChanged(text: try c.decode(String.self, forKey: .text))
        case .requestSave:
            self = .requestSave
        case .gutterAction:
            self = .gutterAction(line: try c.decode(Int.self, forKey: .line),
                                 action: try c.decode(GutterAction.self, forKey: .action))
        case .cursorMoved:
            self = .cursorMoved(line: try c.decode(Int.self, forKey: .line),
                                column: try c.decode(Int.self, forKey: .column))
        case .diffHunkAction:
            self = .diffHunkAction(hunkId: try c.decode(String.self, forKey: .hunkId),
                                   action: try c.decode(HunkAction.self, forKey: .action))
        }
    }
}
