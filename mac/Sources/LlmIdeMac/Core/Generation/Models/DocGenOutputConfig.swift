import Foundation

/// Where a generated document is delivered.
///
/// Only `.localFolder` is wired today. Box, Slack, and email are listed so the
/// surface states the intended shape, and render disabled — the existing
/// connectors for all three are inbound-only and cannot post or send.
enum DocGenOutputDestination: String, Codable, CaseIterable, Identifiable {
    case localFolder
    case box
    case slack
    case email

    var id: String { rawValue }

    var isAvailable: Bool { self == .localFolder }

    var displayName: String {
        switch self {
        case .localFolder: return "Local Folder"
        case .box:         return "Box"
        case .slack:       return "Slack"
        case .email:       return "Email"
        }
    }

    var icon: String {
        switch self {
        case .localFolder: return "folder"
        case .box:         return "shippingbox"
        case .slack:       return "number.square"
        case .email:       return "envelope"
        }
    }
}

/// Doc Gen's output settings for one project.
struct DocGenOutputConfig: Codable, Equatable {
    var destination: DocGenOutputDestination = .localFolder
    /// nil ⇒ `<project>/data/`.
    var localFolderPath: String?
    /// Dormant. Reserved for "output sent to Slack also goes to email"; has no
    /// effect until Slack delivery ships, and is persisted now so enabling it
    /// later is a wiring change rather than a stored-format change.
    var sendCopyToEmail: Bool = false

    /// Destination directory for a save, or nil when neither an explicit folder
    /// nor a project is available (callers then fall back to Downloads).
    func resolvedDirectory(projectRoot: URL?) -> URL? {
        if let path = localFolderPath, !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        guard let root = projectRoot else { return nil }
        return ProjectLayout(root: root).dataDir
    }
}
