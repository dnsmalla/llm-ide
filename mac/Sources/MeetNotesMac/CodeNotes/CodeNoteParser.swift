import Foundation
import GraphKit

/// Derives a renderable ``CGData`` graph from a set of ``CodeNote`` records:
/// one node per note, one edge per link. Edges whose target is not itself a
/// node are dropped (dangling links would render as edges into nothing).
public enum CodeNoteParser {
    public static func derive(from notes: [CodeNote]) -> CGData {
        let nodes = notes.map { note in
            CGNode(id: note.id, title: note.title, kind: nodeKind(note.kind))
        }
        let nodeIds = Set(nodes.map(\.id))

        var edges: [CGEdge] = []
        for note in notes {
            for link in note.links where nodeIds.contains(link.to) {
                edges.append(CGEdge(fromId: note.id, toId: link.to, kind: edgeKind(link.kind)))
            }
        }
        return CGData(nodes: nodes, edges: edges)
    }

    /// Maps a note's `kind` string onto a `CGNodeKind`. Known aliases are mapped
    /// explicitly; an exact raw-value match is honored; everything else is `.other`.
    private static func nodeKind(_ raw: String) -> CGNodeKind {
        switch raw {
        case "file":     return .file
        case "class":    return .classType
        case "module":   return .module
        case "function": return .function
        case "symbol":   return .symbol
        default:         return CGNodeKind(rawValue: raw) ?? .other
        }
    }

    /// Maps a link's `kind` string onto a `CGEdgeKind`. Honors an exact raw-value
    /// match, then a snake_case alias, then falls back to `.relatedTo`.
    private static func edgeKind(_ raw: String) -> CGEdgeKind {
        if let exact = CGEdgeKind(rawValue: raw) { return exact }
        switch raw {
        case "depends_on": return .dependsOn
        case "reads_from": return .readsFrom
        case "writes_to":  return .writesTo
        case "related_to": return .relatedTo
        case "similar_to": return .similarTo
        case "tested_by":  return .testedBy
        default:           return .relatedTo
        }
    }
}
