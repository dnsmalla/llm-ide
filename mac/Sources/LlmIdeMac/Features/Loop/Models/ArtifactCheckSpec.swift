import Foundation

/// Parameters of a `LoopStage.Kind.artifactCheck` stage: a deterministic,
/// in-app check of what a generate loop wrote. Every path is relative; how it
/// is resolved is `ArtifactCheckEvaluator`'s job.
public struct ArtifactCheckSpec: Codable, Equatable {
    /// A line cap for every file matching `glob`.
    public struct LineLimit: Codable, Equatable {
        public var glob: String
        public var maxLines: Int
        /// Globs exempt from this cap (they may carry their own `LineLimit`).
        public var excludes: [String]
        public init(glob: String, maxLines: Int, excludes: [String] = []) {
            self.glob = glob
            self.maxLines = maxLines
            self.excludes = excludes
        }

        enum CodingKeys: String, CodingKey { case glob, maxLines, excludes }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            glob = try c.decode(String.self, forKey: .glob)
            maxLines = try c.decode(Int.self, forKey: .maxLines)
            excludes = try c.decodeIfPresent([String].self, forKey: .excludes) ?? []
        }
    }

    /// Files that must exist.
    public var requiredPaths: [String]
    /// Per-glob line caps.
    public var lineLimits: [LineLimit]
    /// Markdown globs whose backticked repo paths and `path:line` citations
    /// must all resolve to a real file (under the repo root).
    public var citationGlobs: [String]
    /// Also resolve `requiredPaths` / `lineLimits` against the PROJECT root
    /// when the repo root has no such file (plan and refactor files live in the
    /// project's llm-doc/, which may sit outside the repo). Docs do not: a doc
    /// tree outside the git tree is never scanned by the code graph.
    public var projectRootFallback: Bool

    public init(requiredPaths: [String] = [], lineLimits: [LineLimit] = [],
                citationGlobs: [String] = [], projectRootFallback: Bool = false) {
        self.requiredPaths = requiredPaths
        self.lineLimits = lineLimits
        self.citationGlobs = citationGlobs
        self.projectRootFallback = projectRootFallback
    }

    enum CodingKeys: String, CodingKey {
        case requiredPaths, lineLimits, citationGlobs, projectRootFallback
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requiredPaths = try c.decodeIfPresent([String].self, forKey: .requiredPaths) ?? []
        lineLimits = try c.decodeIfPresent([LineLimit].self, forKey: .lineLimits) ?? []
        citationGlobs = try c.decodeIfPresent([String].self, forKey: .citationGlobs) ?? []
        projectRootFallback = try c.decodeIfPresent(Bool.self, forKey: .projectRootFallback) ?? false
    }

    /// One-line description for the stage row.
    var summary: String {
        var parts: [String] = []
        if !requiredPaths.isEmpty { parts.append("exists: " + requiredPaths.joined(separator: ", ")) }
        for limit in lineLimits { parts.append("\(limit.glob) ≤ \(limit.maxLines) lines") }
        if !citationGlobs.isEmpty { parts.append("citations resolve in " + citationGlobs.joined(separator: ", ")) }
        return parts.isEmpty ? "no checks configured" : parts.joined(separator: " · ")
    }
}
