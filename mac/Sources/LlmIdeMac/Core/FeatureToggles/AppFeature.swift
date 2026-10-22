import Foundation

public enum AppFeature: String, CaseIterable, Codable, Identifiable {
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

    var systemImage: String {
        switch self {
        case .fileExplorer: return "folder"
        case .agentChat:    return "bubble.left.and.bubble.right"
        case .codeGraph3D:  return "cube.transparent"
        case .ganttIssues:  return "calendar"
        case .terminal:     return "terminal"
        case .docGen:       return "doc.text"
        case .mobileSync:   return "iphone"
        case .autoTasks:    return "arrow.triangle.2.circlepath.circle"
        }
    }

    /// Features listed in Settings → Workspace. Every feature gets a normal
    /// row here, including `mobileSync` — the toggle drives `MobileModule`
    /// through the registry like any other feature; the Mobile Control card
    /// still manages server enable/auto-start details when compiled in.
    static let settingsToggleable: [AppFeature] = allCases

    /// Features whose build-time inclusion is switchable at all — every
    /// other feature is always compiled in. NOTE: `mac/Package.swift`'s
    /// `includedFeatures` key list (the env-gated `LLMIDE_FEATURES` set)
    /// must mirror this set — it is the single source of truth for which
    /// features `FeatureRebuildService` can ever detect drift on or stage a
    /// smaller rebuild for.
    public static let buildTimeExcludable: Set<AppFeature> = [
        .codeGraph3D, .fileExplorer, .ganttIssues, .docGen, .terminal, .autoTasks, .mobileSync,
    ]

    /// Drop features whose dependencies are not satisfied (e.g. disabling File
    /// Explorer also disables Code Graph, Gantt, and DocGen).
    static func validated(_ features: Set<AppFeature>) -> Set<AppFeature> {
        var validated = features
        var changed = true
        while changed {
            changed = false
            for feature in AppFeature.allCases where validated.contains(feature) {
                if !feature.requiredDependencies.isSubset(of: validated) {
                    validated.remove(feature)
                    changed = true
                }
            }
        }
        return validated
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
            return [.fileExplorer, .terminal]
        case .custom:
            return []
        }
    }
}