import Foundation

/// Semantic strength of a graph edge, in `0...1`.
///
/// The canonical schema carries an edge's *kind* and *confidence* but no
/// numeric weight, so every consumer had to treat a `relatedTo`/`AMBIGUOUS`
/// guess (`MemoryGenerator`'s title-match fallback, which fires whenever one
/// chunk merely mentions another's title) exactly like an `imports`/`EXTRACTED`
/// fact. With signal and noise indistinguishable, the only way to make a dense
/// doc graph legible was to throw most edges away — `GraphPrune.capDegree(6)`
/// kept the first six edges per node in emission order and discarded the rest,
/// which also truncates a hub that legitimately has 87 importers.
///
/// Weighting instead lets the layout and the renderer *rank* edges: noise sinks
/// to a weight the layout can ignore and the UI can filter behind a slider,
/// while real structure keeps its full pull. Nothing is deleted, so a filter is
/// reversible where a prune is not.
public enum EdgeWeight {

    /// Base strength per edge kind, before the confidence multiplier.
    ///
    /// Three tiers: **structural** facts a compiler could verify (containment,
    /// imports, inheritance, calls), **semantic** links asserted by a producer
    /// (documents, cites, reads/writes), and **associative** guesses derived
    /// from surface similarity (`relatedTo`, `similarTo`) — the tier that
    /// generates the edge explosion and the tier a default threshold excludes.
    public static func base(for kind: CGEdgeKind) -> Double {
        switch kind {
        // Structural — the skeleton of a codebase.
        case .contains:       return 1.00
        case .inherits:       return 0.95
        case .implements:     return 0.95
        case .defines:        return 0.92
        case .definesSchema:  return 0.90
        case .imports:        return 0.90
        case .exports:        return 0.85
        case .dependsOn:      return 0.85
        case .calls:          return 0.80
        case .containsFlow:   return 0.80
        case .flowStep:       return 0.78

        // Semantic — asserted relationships between real artifacts.
        case .middleware:     return 0.72
        case .publishes:      return 0.70
        case .subscribes:     return 0.70
        case .readsFrom:      return 0.70
        case .writesTo:       return 0.70
        case .routes:         return 0.70
        case .testedBy:       return 0.68
        case .configures:     return 0.68
        case .migrates:       return 0.68
        case .deploys:        return 0.65
        case .serves:         return 0.65
        case .provisions:     return 0.65
        case .triggers:       return 0.65
        case .transforms:     return 0.62
        case .validates:      return 0.62
        case .documents:      return 0.60
        case .references:     return 0.58
        case .cites:          return 0.58
        case .buildsOn:       return 0.55
        case .contradicts:    return 0.52
        case .exemplifies:    return 0.50
        case .categorizedUnder: return 0.48
        case .authoredBy:     return 0.42
        case .crossDomain:    return 0.40

        // Associative — surface-similarity guesses. Deliberately below the
        // default `minWeight` so they never shape the layout on their own.
        case .relatedTo:      return 0.24
        case .similarTo:      return 0.20
        }
    }

    /// How much a producer's stated certainty scales the base strength.
    /// `EXTRACTED` is a fact, `INFERRED` a name-resolution guess, `AMBIGUOUS`
    /// an acknowledged coin-flip (dynamic dispatch, reflection, title match).
    public static func multiplier(for confidence: CGEdgeConfidence) -> Double {
        switch confidence {
        case .extracted: return 1.00
        case .inferred:  return 0.75
        case .ambiguous: return 0.45
        }
    }

    /// Final weight for one edge, in `0...1`.
    ///
    /// The two extremes bound the scale: `contains`/`EXTRACTED` = 1.0 (a file
    /// really does contain that symbol) and `similarTo`/`AMBIGUOUS` = 0.09 (two
    /// chunks share a word). A `relatedTo`/`AMBIGUOUS` title match lands at
    /// 0.108 — an order of magnitude under any structural edge.
    public static func weight(of edge: CGEdge) -> Double {
        base(for: edge.kind) * multiplier(for: edge.confidence)
    }

    /// Default cut-off for edges that participate in layout and are drawn.
    ///
    /// 0.30 sits in the empty band between the associative tier — whose ceiling
    /// is `relatedTo`/`EXTRACTED` at 0.24 — and the semantic tier, whose floor
    /// is `crossDomain`/`EXTRACTED` at 0.40. That is what removes the
    /// title-match explosion.
    ///
    /// **It excludes the associative tier at EVERY confidence, including
    /// `EXTRACTED`.** A producer that emits `relatedTo` or `similarTo` as an
    /// extracted fact loses those edges from the layout entirely. That is
    /// deliberate — the two kinds mean "these look similar", which is a
    /// statement about surface text however confidently it is asserted — but it
    /// is a real exclusion, not merely a filter on low confidence. A producer
    /// with a genuinely structural relationship should pick a kind that says
    /// so. Raise `GraphLayoutOptions.minWeight` to include them; nothing is
    /// deleted, so it is reversible.
    public static let defaultMinWeight: Double = 0.30

    /// Whether this edge is a containment (tree) edge rather than a peer
    /// relation. Containment is the backbone of the folder → file → symbol
    /// hierarchy and is laid out as nesting, not as a spring of equal standing.
    public static func isHierarchical(_ kind: CGEdgeKind) -> Bool {
        kind == .contains || kind == .containsFlow
    }
}

extension Double {
    /// Clamp into a closed range. Used to keep a coordinate inside the domain
    /// where `Int64(_:)` is defined — that initialiser traps on NaN/infinity.
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
