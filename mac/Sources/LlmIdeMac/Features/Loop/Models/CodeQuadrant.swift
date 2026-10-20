import Foundation

/// The test guideline's code-classification matrix: what kind of test (if any) a file earns.
public enum CodeQuadrant: String, Codable {
    case domainLogic   // unit tests
    case controller    // integration tests
    case overComplex   // refactor first, no tests until split
    case trivial       // not tested by policy
}

public enum CodeQuadrantClassifier {
    public static let complexLoc = 60
    public static let complexFunctions = 3
    public static let manyCollaborators = 6
    public static let overComplexLoc = 500

    /// Roles that mark glue code (UI, routing). Matched case-insensitively.
    /// NOTE: the file-role vocabulary in graph.json comes from `CodeNoteGenerator.inferRole`:
    /// Test, ViewModel, View, Service, Store, Client, Error, Model, Router, Web, Module.
    /// It has no separate "controller", "entry" or "pipeline" role, so only these three apply.
    public static let controllerRoles: Set<String> = ["view", "viewmodel", "router"]

    public static func classify(loc: Int, functionCount: Int, collaborators: Int, role: String?) -> CodeQuadrant {
        let isComplex = loc >= complexLoc && functionCount >= complexFunctions
        if loc >= overComplexLoc || (isComplex && collaborators >= manyCollaborators) { return .overComplex }
        if let role, controllerRoles.contains(role.lowercased()) { return .controller }
        if collaborators >= manyCollaborators { return .controller }
        if isComplex { return .domainLogic }
        return .trivial
    }
}
