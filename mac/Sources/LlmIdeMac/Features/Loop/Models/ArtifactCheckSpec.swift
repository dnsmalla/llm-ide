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

    /// A rule about a SIBLING generate stage's editable Output, resolved at RUN
    /// time (`resolved(against:)`), so redirecting a stage's Output redirects
    /// its check. The persisted spec only names the stage, so it stays stable
    /// (default-revision equality survives an Output edit).
    public struct OutputRule: Codable, Equatable {
        public enum Shape: String, Codable { case file, directory }
        /// The sibling's `defaultKey` (falls back to matching its `skillId`).
        public var stage: String
        public var skillId: String?
        /// `file`: the Output is a file that must exist within `maxLines`.
        /// `directory`: the Output is a directory (nothing required to exist).
        public var shape: Shape
        public var maxLines: Int
        /// Glob under the Output's directory (a file Output's parent, or the
        /// directory itself) whose matches are also capped at `maxLines`.
        public var subGlob: String?
        /// Sibling stages whose Output is exempt from `subGlob`'s cap.
        public var excludeStages: [String]
        /// Check citations in `subGlob`'s markdown (and the file Output itself).
        public var citations: Bool

        public init(stage: String, skillId: String? = nil, shape: Shape, maxLines: Int,
                    subGlob: String? = nil, excludeStages: [String] = [], citations: Bool = false) {
            self.stage = stage
            self.skillId = skillId
            self.shape = shape
            self.maxLines = maxLines
            self.subGlob = subGlob
            self.excludeStages = excludeStages
            self.citations = citations
        }
    }

    /// Output-following rules, resolved against the loop's stages.
    public var outputRules: [OutputRule]
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
                citationGlobs: [String] = [], projectRootFallback: Bool = false,
                outputRules: [OutputRule] = []) {
        self.outputRules = outputRules
        self.requiredPaths = requiredPaths
        self.lineLimits = lineLimits
        self.citationGlobs = citationGlobs
        self.projectRootFallback = projectRootFallback
    }

    enum CodingKeys: String, CodingKey {
        case requiredPaths, lineLimits, citationGlobs, projectRootFallback, outputRules
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requiredPaths = try c.decodeIfPresent([String].self, forKey: .requiredPaths) ?? []
        lineLimits = try c.decodeIfPresent([LineLimit].self, forKey: .lineLimits) ?? []
        citationGlobs = try c.decodeIfPresent([String].self, forKey: .citationGlobs) ?? []
        projectRootFallback = try c.decodeIfPresent(Bool.self, forKey: .projectRootFallback) ?? false
        outputRules = try c.decodeIfPresent([OutputRule].self, forKey: .outputRules) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requiredPaths, forKey: .requiredPaths)
        try c.encode(lineLimits, forKey: .lineLimits)
        try c.encode(citationGlobs, forKey: .citationGlobs)
        try c.encode(projectRootFallback, forKey: .projectRootFallback)
        if !outputRules.isEmpty { try c.encode(outputRules, forKey: .outputRules) }
    }

    /// The concrete spec for a run: `outputRules` replaced by the paths the
    /// sibling stages' CURRENT Outputs name. A rule whose stage is absent,
    /// disabled (callers pass only enabled stages) or has no Output is skipped.
    func resolved(against stages: [LoopStage]) -> ArtifactCheckSpec {
        var out = self
        out.outputRules = []
        func sibling(_ key: String, _ skill: String? = nil) -> LoopStage? {
            stages.first { $0.defaultKey == key } ?? skill.flatMap { id in stages.first { $0.skillId == id } }
        }
        func outputPath(_ stage: LoopStage?) -> String? {
            guard let raw = stage?.outputPath?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
            var p = raw
            while p.hasPrefix("./") { p.removeFirst(2) }
            while p.count > 1, p.hasSuffix("/") { p.removeLast() }
            return p == "." ? "" : p
        }
        func join(_ base: String, _ tail: String) -> String { base.isEmpty ? tail : base + "/" + tail }
        for rule in outputRules {
            guard let path = outputPath(sibling(rule.stage, rule.skillId)) else { continue }
            let dir: String
            switch rule.shape {
            case .file:
                out.requiredPaths.append(path)
                out.lineLimits.append(.init(glob: path, maxLines: rule.maxLines))
                dir = (path as NSString).deletingLastPathComponent
                if rule.citations { out.citationGlobs.append(path) }
            case .directory:
                dir = path
            }
            if let sub = rule.subGlob {
                let glob = join(dir, sub)
                let excludes = rule.excludeStages.compactMap { outputPath(sibling($0)) }
                out.lineLimits.append(.init(glob: glob, maxLines: rule.maxLines, excludes: excludes))
                if rule.citations { out.citationGlobs.append(glob) }
            }
        }
        return out
    }

    /// One-line description for the stage row, with output-following rules
    /// resolved against `stages` so the real paths are visible.
    func summary(resolvedAgainst stages: [LoopStage]) -> String {
        resolved(against: stages).summary
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
