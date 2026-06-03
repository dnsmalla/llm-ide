// Code-graph data types. Self-contained — meet-notes has no shared graph
// library to lean on, so this module owns its own minimal node/edge model.
// Inspired by the InfiniteBrain knowledge-graph schema but trimmed to what
// Understand-Anything actually emits.

import Foundation
import CoreGraphics
import SwiftUI

public enum CGNodeKind: String, Sendable, Hashable {
    case file
    case symbol
    case module
    case docPage

    // MemoryGenerator output — InfiniteBrain-style atomic-note typing.
    // `memoryDoc` is the doc root; `memoryChunk` is a generic chunk; the
    // typed variants below come from frontmatter or heading heuristics.
    case memoryDoc
    case memoryChunk
    case noteDecision
    case noteTask
    case noteQuestion
    case noteFact
    case noteConcept
    case notePlaybook
    case noteHypothesis
    case noteEvent
    case noteSource

    // UA node types — Understand-Anything schema (21 types).
    case function
    case classType
    case config
    case service
    case table
    case endpoint
    case pipeline
    case schemaNode
    case resource
    case domain
    case flow
    case step
    case article
    case entity
    case topic
    case claim

    case other
}

/// All atomic-note kinds, in display order.
public extension CGNodeKind {
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
        // UA node types
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
        case .other:          return "Other"
        }
    }
}

public enum CGEdgeKind: String, Sendable, Hashable {
    // Structural
    case imports
    case exports
    case contains
    case inherits
    case implements

    // Behavioral
    case calls
    case subscribes
    case publishes
    case middleware

    // Data flow
    case readsFrom
    case writesTo
    case transforms
    case validates

    // Dependencies
    case dependsOn
    case testedBy
    case configures

    // Semantic
    case relatedTo
    case similarTo

    // Infrastructure
    case deploys
    case serves
    case provisions
    case triggers

    // Schema
    case migrates
    case documents
    case routes
    case definesSchema

    // Domain
    case containsFlow
    case flowStep
    case crossDomain

    // Knowledge
    case cites
    case contradicts
    case buildsOn
    case exemplifies
    case categorizedUnder
    case authoredBy

    // Legacy fallbacks
    case defines
    case references
}

public struct CGNode: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let kind: CGNodeKind
    public var position: CGPoint
    public let metadata: [String: String]

    public init(id: String, title: String, kind: CGNodeKind,
                position: CGPoint = .zero,
                metadata: [String: String] = [:]) {
        self.id = id
        self.title = title
        self.kind = kind
        self.position = position
        self.metadata = metadata
    }
}

public struct CGEdge: Equatable, Sendable {
    public let fromId: String
    public let toId: String
    public let kind: CGEdgeKind
}

/// A named layer grouping nodes by architecture concern.
public struct UALayer: Equatable, Sendable {
    public let id: String
    public let name: String
    public let nodeIds: [String]

    public init(id: String, name: String, nodeIds: [String]) {
        self.id = id
        self.name = name
        self.nodeIds = nodeIds
    }
}

/// A step in a guided graph tour (e.g. onboarding walkthrough).
public struct UATourStep: Equatable, Sendable {
    public let nodeId: String
    public let title: String
    public let body: String

    public init(nodeId: String, title: String, body: String) {
        self.nodeId = nodeId
        self.title = title
        self.body = body
    }
}

public struct CGData: Equatable, Sendable {
    public let nodes: [CGNode]
    public let edges: [CGEdge]
    public let layers: [UALayer]
    public let tour: [UATourStep]

    public init(nodes: [CGNode], edges: [CGEdge],
                layers: [UALayer] = [], tour: [UATourStep] = []) {
        self.nodes = nodes
        self.edges = edges
        self.layers = layers
        self.tour = tour
    }
    public static let empty = CGData(nodes: [], edges: [])
}

/// Stable colour per node kind. Read in views via `.color(for:)`.
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
        case .other:          return .gray
        }
    }
}
