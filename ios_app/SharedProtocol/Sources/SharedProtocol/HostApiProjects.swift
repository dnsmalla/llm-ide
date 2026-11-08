import Foundation

// MARK: - Host API v1 project scope (projects.list + optional projectId)
//
// Mirrors web/src/projects/controller.ts: the paired device's projects and its effective role on each,
// the selected project, and the host's refusal reason. A frame without `projectId` keeps the v1 team
// behavior, so an empty list (or an older host) still chats.

public enum HostApiProjectRefusalCode: String, CaseIterable, Sendable {
    case required = "PROJECT_REQUIRED"
    case denied = "PROJECT_DENIED"
    case mismatch = "PROJECT_MISMATCH"
}

/// A project-scoped frame the host refused, in the picker's vocabulary. `message` is the host's own
/// text (clamped), not a client guess.
public struct HostApiProjectRefusal: Equatable, Sendable {
    public var code: HostApiProjectRefusalCode
    public var message: String

    public init(code: HostApiProjectRefusalCode, message: String) {
        self.code = code
        self.message = message
    }

    /// The contract has no PROJECT_* error codes yet: the gateway answers `denied` (role/project refusal)
    /// or `not_found` (the named project is not registered here). Also accept a host that names a
    /// PROJECT_* code in the error or its message, so this picker is ready for the narrower contract.
    public static func from(_ error: Error, selectedId: String?) -> HostApiProjectRefusal? {
        guard let rejection = error as? HostApiRejection else { return nil }
        if let code = HostApiProjectRefusalCode(rawValue: rejection.code) {
            return HostApiProjectRefusal(code: code, message: text(rejection))
        }
        let upper = rejection.message.uppercased()
        if let literal = HostApiProjectRefusalCode.allCases.first(where: { upper.contains($0.rawValue) }) {
            return HostApiProjectRefusal(code: literal, message: text(rejection))
        }
        // A team-role refusal is not a project refusal: only map these when a project was named.
        guard selectedId != nil else { return nil }
        switch rejection.code {
        case "denied": return HostApiProjectRefusal(code: .denied, message: text(rejection))
        case "not_found": return HostApiProjectRefusal(code: .mismatch, message: text(rejection))
        default: return nil
        }
    }

    private static func text(_ rejection: HostApiRejection) -> String {
        let trimmed = rejection.message.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((trimmed.isEmpty ? rejection.code : trimmed).prefix(500))
    }
}

/// The chat picker's copy. Kept beside the controller (and tested) so the empty state is one string,
/// not a view's paraphrase.
public enum HostApiProjectNotices {
    public static let empty = "No projects are available to this account."
    public static let loading = "Loading projects…"
    public static let choose = "Choose a project…"

    public static func loadError(_ error: String) -> String {
        let trimmed = error.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Could not load projects." : "Could not load projects. \(trimmed)"
    }

    public static func refusal(_ refusal: HostApiProjectRefusal) -> String {
        let reason: String
        switch refusal.code {
        case .required: reason = "A project is required."
        case .denied: reason = "The desktop refused this project."
        case .mismatch: reason = "This project doesn't match the desktop."
        }
        let message = refusal.message.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? reason : "\(reason) \(message)"
    }
}

public struct HostApiProjectsState: Equatable, Sendable {
    public var projects: [HostApiProjectsListResultProjectsItem]
    /// The project every project-scoped frame names; nil keeps the v1 team behavior.
    public var selectedId: String?
    public var loading: Bool
    /// At least one `projects.list` reply has landed (success or failure).
    public var loaded: Bool
    /// `projects.list` itself failed; the previous list and choice are kept.
    public var error: String?
    /// A project-scoped frame was refused; the picker stays usable and shows this.
    public var refusal: HostApiProjectRefusal?

    public init(projects: [HostApiProjectsListResultProjectsItem] = [], selectedId: String? = nil,
                loading: Bool = true, loaded: Bool = false, error: String? = nil,
                refusal: HostApiProjectRefusal? = nil) {
        self.projects = projects
        self.selectedId = selectedId
        self.loading = loading
        self.loaded = loaded
        self.error = error
        self.refusal = refusal
    }
}

/// The phone's project picker over Host API v1 `host`. Sends only through the host the owner hands it.
/// Persistence is injected (`storedId`/`persist`) so this type stays free of UserDefaults.
@MainActor
public final class HostApiProjectController {
    public static let maxProjects = 500

    public private(set) var state = HostApiProjectsState() {
        didSet { if state != oldValue { onChange?(state) } }
    }
    public var onChange: ((HostApiProjectsState) -> Void)?

    private let host: () -> HostConnection?
    private let storedId: () -> String?
    private let persist: (String?) -> Void
    private var generation = 0
    private var ticket = 0

    public init(host: @escaping () -> HostConnection?,
                storedId: @escaping () -> String? = { nil },
                persist: @escaping (String?) -> Void = { _ in }) {
        self.host = host
        self.storedId = storedId
        self.persist = persist
    }

    public var selectedId: String? { state.selectedId }

    public func selectedProject() -> HostApiProjectsListResultProjectsItem? {
        state.projects.first(where: { $0.id == state.selectedId })
    }

    /// Ask for the projects visible to this device. The stored choice wins while it still exists;
    /// otherwise the first project, else none. A failed list keeps the previous list and choice.
    public func refresh() async {
        guard let h = host(), h.state == .connected else { return }
        ticket += 1
        let mine = ticket
        let gen = generation
        state.loading = true
        state.error = nil
        do {
            let reply = try await h.send(.projectsList, HostApiProjectsListRequest(),
                                         as: HostApiProjectsListResult.self)
            guard gen == generation, mine == ticket else { return }
            let projects = Array(reply.projects.prefix(Self.maxProjects))
            let current = state.selectedId
            let keep = projects.first(where: { $0.id == current })?.id
            let stored = projects.first(where: { $0.id == storedId() })?.id
            let next = keep ?? stored ?? projects.first?.id
            var updated = state
            updated.projects = projects
            updated.selectedId = next
            updated.loading = false
            updated.loaded = true
            updated.error = nil
            if next != current { updated.refusal = nil }
            state = updated
            persist(next)
        } catch {
            guard gen == generation, mine == ticket else { return }
            var updated = state
            updated.loading = false
            updated.loaded = true
            let text = (error as? HostApiRejection)?.message ?? ""
            updated.error = String((text.isEmpty ? "Something went wrong." : text).prefix(500))
            state = updated
        }
    }

    /// Pick a project that this device was actually offered. Returns false for an unknown id.
    @discardableResult
    public func select(_ id: String) -> Bool {
        guard state.projects.contains(where: { $0.id == id }) else { return false }
        guard id != state.selectedId else { return true }
        var updated = state
        updated.selectedId = id
        updated.refusal = nil
        state = updated
        persist(id)
        return true
    }

    /// Show a project-scoped frame's refusal without disabling the picker; a non-project error is ignored.
    @discardableResult
    public func noteRefusal(_ error: Error) -> HostApiProjectRefusal? {
        guard let refusal = HostApiProjectRefusal.from(error, selectedId: state.selectedId) else { return nil }
        var updated = state
        updated.refusal = refusal
        state = updated
        return refusal
    }

    public func clearRefusal() {
        guard state.refusal != nil else { return }
        var updated = state
        updated.refusal = nil
        state = updated
    }

    /// A new device or a fresh pairing: forget the list, but keep the stored per-host choice for next time.
    public func reset() {
        generation += 1
        ticket += 1
        state = HostApiProjectsState()
    }
}
