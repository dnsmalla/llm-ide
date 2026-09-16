import SwiftUI
import GraphCore

/// App-level color palette for graph node kinds. Lives in the app target
/// (not GraphKit) so the shared engine stays free of SwiftUI/presentation.
public enum CGPalette {
    public static func color(for kind: CGNodeKind) -> Color {
        switch kind {
        case .file:           return .blue
        case .symbol:         return .purple
        case .module:         return .orange
        case .docPage:        return .green
        case .memoryDoc:      return .indigo
        case .memoryChunk:    return .mint
        case .noteDecision:   return .red
        case .noteTask:       return .orange
        case .noteQuestion:   return .yellow
        case .noteFact:       return .green
        case .noteConcept:    return .cyan
        case .notePlaybook:   return .blue
        case .noteHypothesis: return .purple
        case .noteEvent:      return .pink
        case .noteSource:     return .brown
        // UA node types
        case .function:       return Color(red: 0.2, green: 0.6, blue: 0.9)
        case .classType:      return Color(red: 0.6, green: 0.2, blue: 0.8)
        case .config:         return Color(red: 0.5, green: 0.5, blue: 0.5)
        case .service:        return Color(red: 0.0, green: 0.7, blue: 0.5)
        case .table:          return Color(red: 0.8, green: 0.5, blue: 0.1)
        case .endpoint:       return Color(red: 0.9, green: 0.3, blue: 0.3)
        case .pipeline:       return Color(red: 0.3, green: 0.5, blue: 0.9)
        case .schemaNode:     return Color(red: 0.7, green: 0.4, blue: 0.1)
        case .resource:       return Color(red: 0.1, green: 0.5, blue: 0.3)
        case .domain:         return Color(red: 0.9, green: 0.6, blue: 0.1)
        case .flow:           return Color(red: 0.4, green: 0.8, blue: 0.8)
        case .step:           return Color(red: 0.6, green: 0.8, blue: 0.4)
        case .article:        return Color(red: 0.4, green: 0.6, blue: 0.2)
        case .entity:         return Color(red: 0.8, green: 0.2, blue: 0.6)
        case .topic:          return Color(red: 0.2, green: 0.4, blue: 0.8)
        case .claim:          return Color(red: 0.9, green: 0.4, blue: 0.2)
        case .skill:          return Color(red: 0.35, green: 0.75, blue: 0.65) // teal
        case .agent:          return Color(red: 0.85, green: 0.45, blue: 0.75) // magenta
        case .other:          return .gray
        // Future-proof: GraphKit may add further node kinds in a minor
        // release; render any unknown kind neutrally rather than failing to compile.
        @unknown default:     return .gray
        }
    }

    /// Hues for detected clusters, cycled by cluster id.
    ///
    /// Fixed literals rather than SwiftUI semantic colours (`.mint`, `.yellow`)
    /// on purpose: the semantic set resolves against the *system* appearance,
    /// not the app theme, so with the app in Light and macOS in Dark the node
    /// colours were computed for the wrong background. These are chosen to hold
    /// contrast on both of the app's grounds, and are ordered so that clusters
    /// the layout packs next to each other get well-separated hues.
    ///
    /// Colour-vision safety: the sequence avoids adjacent red/green pairs, so
    /// neighbouring clusters stay distinguishable for the common forms of
    /// colour blindness.
    public static let clusterColors: [Color] = [
        Color(red: 0.31, green: 0.48, blue: 0.65),   // steel blue
        Color(red: 0.95, green: 0.56, blue: 0.17),   // amber
        Color(red: 0.35, green: 0.63, blue: 0.31),   // moss
        Color(red: 0.88, green: 0.34, blue: 0.35),   // brick
        Color(red: 0.69, green: 0.48, blue: 0.63),   // mauve
        Color(red: 0.46, green: 0.72, blue: 0.70),   // teal
        Color(red: 0.93, green: 0.79, blue: 0.28),   // gold
        Color(red: 1.00, green: 0.62, blue: 0.65),   // rose
        Color(red: 0.61, green: 0.46, blue: 0.37),   // taupe
        Color(red: 0.55, green: 0.55, blue: 0.58),   // slate
        Color(red: 0.18, green: 0.53, blue: 0.67),   // ocean
        Color(red: 0.51, green: 0.45, blue: 0.70),   // iris
        Color(red: 0.80, green: 0.73, blue: 0.46),   // sand
        Color(red: 0.33, green: 0.66, blue: 0.53),   // jade
        Color(red: 0.77, green: 0.31, blue: 0.55),   // plum
    ]

    /// Colour for a cluster id. Negative or out-of-range ids fall back to the
    /// first hue rather than trapping.
    public static func clusterColor(_ cluster: Int) -> Color {
        guard !clusterColors.isEmpty else { return .gray }
        let index = cluster < 0 ? 0 : cluster % clusterColors.count
        return clusterColors[index]
    }
}
