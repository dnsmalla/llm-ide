import Foundation

public enum AppFeature: String, CaseIterable, Codable, Identifiable {
    case codeEditor        = "code_editor"
    case fileExplorer      = "file_explorer"
    case agentChat         = "agent_chat"
    case codeGraph3D       = "code_graph_3d"
    case ganttIssues       = "gantt_issues"
    case terminal          = "terminal"
    case docGen            = "doc_gen"
    case mobileSync        = "mobile_sync"
    case autoTasks         = "auto_tasks"
    
    public var id: String { rawValue }
    
    public var displayName: String {
        switch self {
        case .codeEditor:     return "Code Editor"
        case .fileExplorer:   return "File Explorer"
        case .agentChat:      return "AI Agent Chat"
        case .codeGraph3D:    return "3D Code Graph Engine"
        case .ganttIssues:    return "Gantt & Issue Board"
        case .terminal:       return "Integrated Terminal"
        case .docGen:         return "Document Generator"
        case .mobileSync:     return "Mobile Companion Sync"
        case .autoTasks:      return "Auto-Tasks & Activity Capture"
        }
    }
    
    /// Required dependencies to prevent broken UI states
    public var requiredDependencies: Set<AppFeature> {
        switch self {
        case .codeGraph3D: return [.fileExplorer]
        case .ganttIssues: return [.fileExplorer]
        case .docGen:      return [.fileExplorer]
        default:           return []
        }
    }
}

public enum ProfilePreset: String, CaseIterable, Identifiable {
    case fullPower     = "Full IDE + AI (Default)"
    case focusedAI     = "Focused AI Assistant"
    case minimalEditor = "Minimal Code Editor"
    case custom        = "Custom System Configuration"
    
    public var id: String { rawValue }
    
    public var features: Set<AppFeature> {
        switch self {
        case .fullPower:
            return Set(AppFeature.allCases)
        case .focusedAI:
            return [.agentChat, .docGen, .fileExplorer]
        case .minimalEditor:
            return [.codeEditor, .fileExplorer, .terminal]
        case .custom:
            return []
        }
    }
}