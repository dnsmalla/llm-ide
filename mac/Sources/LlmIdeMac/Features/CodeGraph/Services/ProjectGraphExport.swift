import Foundation
import GraphCore

/// Encodes the Graph feature's cached graph for the System view. The bytes are
/// graph-kit's canonical `GraphDocument` JSON, which `ProjectGraphDocument`
/// (Core, no GraphCore) decodes. Lives here, not in Shell, so that the one
/// place that names GraphCore for this seam is inside the Graph feature.
enum ProjectGraphExport {
    /// The graph as `GraphDocument` JSON, or nil when it cannot be encoded.
    static func documentJSON(_ graph: CGData) -> Data? {
        try? JSONEncoder().encode(GraphDocument(graph))
    }
}
