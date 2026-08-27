import Foundation
import CoreGraphics

public enum CGNodeKind: String, Sendable, Hashable, Codable {
    case file, symbol, module, docPage
    case memoryDoc, memoryChunk
    case noteDecision, noteTask, noteQuestion, noteFact
    case noteConcept, notePlaybook, noteHypothesis, noteEvent, noteSource
    case function, classType, config, service, table, endpoint
    case pipeline, schemaNode, resource, domain, flow, step
    case article, entity, topic, claim
    case skill, agent
    case other
}

public extension CGNodeKind {
    /// All atomic-note kinds, in display order.
    static let atomicNoteKinds: [CGNodeKind] = [
        .noteDecision, .noteTask, .noteQuestion, .noteFact,
        .noteConcept, .notePlaybook, .noteHypothesis, .noteEvent, .noteSource
    ]

    var displayName: String {
        switch self {
        case .file:           return "File"
        case .symbol:         return "Symbol"
        case .module:         return "Module"
        case .docPage:        return "Doc"
        case .memoryDoc:      return "Document"
        case .memoryChunk:    return "Note"
        case .noteDecision:   return "Decision"
        case .noteTask:       return "Task"
        case .noteQuestion:   return "Question"
        case .noteFact:       return "Fact"
        case .noteConcept:    return "Concept"
        case .notePlaybook:   return "Playbook"
        case .noteHypothesis: return "Hypothesis"
        case .noteEvent:      return "Event"
        case .noteSource:     return "Source"
        case .function:       return "Function"
        case .classType:      return "Class"
        case .config:         return "Config"
        case .service:        return "Service"
        case .table:          return "Table"
        case .endpoint:       return "Endpoint"
        case .pipeline:       return "Pipeline"
        case .schemaNode:     return "Schema"
        case .resource:       return "Resource"
        case .domain:         return "Domain"
        case .flow:           return "Flow"
        case .step:           return "Step"
        case .article:        return "Article"
        case .entity:         return "Entity"
        case .topic:          return "Topic"
        case .claim:          return "Claim"
        case .skill:          return "Skill"
        case .agent:          return "Agent"
        case .other:          return "Other"
        }
    }

    /// Map a vault `NodeType` raw value to the matching `CGNodeKind`.
    /// Allows the Knowledge Graph to share the same canvas and palette as
    /// the Code Graph without changing the underlying notes data model.
    static func from(_ rawValue: String) -> CGNodeKind {
        switch rawValue {
        case "decision":    return .noteDecision
        case "concept":     return .noteConcept
        case "question":    return .noteQuestion
        case "task":        return .noteTask
        case "hypothesis":  return .noteHypothesis
        case "fact":        return .noteFact
        case "source":      return .noteSource
        case "playbook":    return .notePlaybook
        case "event":       return .noteEvent
        case "pillar":      return .domain
        case "pattern":     return .notePlaybook
        case "bookmark":    return .noteSource
        case "note":        return .memoryChunk
        case "contact":     return .entity
        case "reference":   return .noteSource
        case "custom":      return .other
        case "code_file":   return .file
        case "code_symbol": return .symbol
        case "code_module": return .module
        case "doc_page":    return .docPage
        default:            return .other
        }
    }

    /// Kinds shown in the Knowledge Graph legend (vault note types only).
    static let knowledgeGraphKinds: [CGNodeKind] = [
        .domain, .noteDecision, .noteConcept, .noteQuestion,
        .noteTask, .noteHypothesis, .noteFact, .noteSource,
        .notePlaybook, .noteEvent, .memoryChunk, .entity, .other
    ]
}

public enum CGEdgeKind: String, Sendable, Hashable, Codable {
    case imports, exports, contains, inherits, implements
    case calls, subscribes, publishes, middleware
    case readsFrom, writesTo, transforms, validates
    case dependsOn, testedBy, configures
    case relatedTo, similarTo
    case deploys, serves, provisions, triggers
    case migrates, documents, routes, definesSchema
    case containsFlow, flowStep, crossDomain
    case cites, contradicts, buildsOn, exemplifies, categorizedUnder, authoredBy
    case defines, references
}

public struct CGNode: Identifiable, Equatable, Sendable, Codable {
    public let id: String
    public let title: String
    public let kind: CGNodeKind
    public var position: CGPoint
    public let metadata: [String: String]

    public init(id: String, title: String, kind: CGNodeKind,
                position: CGPoint = .zero,
                metadata: [String: String] = [:]) {
        self.id = id; self.title = title; self.kind = kind
        self.position = position; self.metadata = metadata
    }

    // Custom Codable so `position` serializes as the canonical { "x", "y" } object
    // (CGPoint's synthesized form is platform-specific) and `position`/`metadata`
    // are tolerated as absent on decode. See schema/SCHEMA.md.
    private enum CodingKeys: String, CodingKey { case id, title, kind, position, metadata }
    private struct Point: Codable { var x: Double; var y: Double }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        kind = try c.decode(CGNodeKind.self, forKey: .kind)
        let p = try c.decodeIfPresent(Point.self, forKey: .position)
        position = p.map { CGPoint(x: $0.x, y: $0.y) } ?? .zero
        metadata = try c.decodeIfPresent([String: String].self, forKey: .metadata) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(kind, forKey: .kind)
        // Omit a zero position so output matches producers that carry no layout
        // (e.g. text→graph, the TS impl). `position` is a layout hint only.
        if position != .zero {
            try c.encode(Point(x: Double(position.x), y: Double(position.y)), forKey: .position)
        }
        try c.encode(metadata, forKey: .metadata)
    }
}

public enum CGEdgeConfidence: String, Sendable, Hashable, Codable {
    /// Explicitly stated in source code — 100% reliable.
    case extracted = "EXTRACTED"
    /// Reasonably deduced (e.g. call sites) — ~80% reliable.
    case inferred  = "INFERRED"
    /// Uncertain (dynamic dispatch, reflection) — 50–70% reliable.
    case ambiguous = "AMBIGUOUS"
}

public struct CGEdge: Equatable, Sendable, Codable {
    public let fromId: String
    public let toId: String
    public let kind: CGEdgeKind
    public let confidence: CGEdgeConfidence

    public init(fromId: String, toId: String, kind: CGEdgeKind,
                confidence: CGEdgeConfidence = .extracted) {
        self.fromId = fromId; self.toId = toId; self.kind = kind
        self.confidence = confidence
    }
}

public struct UALayer: Equatable, Sendable, Codable {
    public let id: String
    public let name: String
    public let nodeIds: [String]

    public init(id: String, name: String, nodeIds: [String]) {
        self.id = id; self.name = name; self.nodeIds = nodeIds
    }
}

public struct UATourStep: Equatable, Sendable, Codable {
    public let nodeId: String
    public let title: String
    public let body: String

    public init(nodeId: String, title: String, body: String) {
        self.nodeId = nodeId; self.title = title; self.body = body
    }
}

public struct CGData: Equatable, Sendable, Codable {
    public let nodes: [CGNode]
    public let edges: [CGEdge]
    public let layers: [UALayer]
    public let tour: [UATourStep]

    public init(nodes: [CGNode], edges: [CGEdge],
                layers: [UALayer] = [], tour: [UATourStep] = []) {
        self.nodes = nodes; self.edges = edges
        self.layers = layers; self.tour = tour
    }
    public static let empty = CGData(nodes: [], edges: [])
}
