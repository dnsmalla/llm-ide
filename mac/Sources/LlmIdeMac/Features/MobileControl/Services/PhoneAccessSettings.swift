import Foundation
import Observation

/// What the paired phone is allowed to do, decided on the Mac.
///
/// The phone is a remote control, so its reach is a Mac-side setting, not a phone-side one: each
/// capability that exposes code, changes the repo, or answers prompts has a switch in
/// Settings → Mobile Control → Phone access. Bridges check it on EVERY request (a stale phone
/// can't act on a capability list it received before the switch was flipped), and the capability
/// list sent in `Connected` / `mac_capabilities` leaves the feature out while it is off, so the
/// phone hides the screen instead of showing one that always errors.
///
/// Reading and low-risk, reversible actions default ON; anything that edits files, writes to a
/// tracker, or approves a tool defaults OFF.
enum PhoneAccess: String, CaseIterable, Identifiable {
    case projectSwitch      // change the active project
    case fileBrowse         // read-only file viewer
    case sourceControlRead  // branch / status / diff / log
    case issuesRead         // list + view issues
    case issueComment       // post a comment on an issue
    case selfHealApply      // apply a Self-Heal proposal to the checkout
    case toolApprovals      // answer tool/edit permission prompts
    case autoTaskControl    // toggle / run auto tasks, edit their config and templates
    case loopControl        // start a Loop run or a single stage
    case generationRun      // run Doc Gen from the phone (writes files under llm-doc/)

    var id: String { rawValue }

    var title: String {
        switch self {
        case .projectSwitch:     return "Switch projects"
        case .fileBrowse:        return "Browse and read project files"
        case .sourceControlRead: return "See Source Control (branch, changes, diffs, log)"
        case .issuesRead:        return "See issues"
        case .issueComment:      return "Comment on issues"
        case .selfHealApply:     return "Apply or discard Self-Heal fixes"
        case .toolApprovals:     return "Approve or deny tool and edit requests"
        case .autoTaskControl:   return "Control Auto Tasks (run, enable, edit settings and templates)"
        case .loopControl:       return "Start Loop runs"
        case .generationRun:     return "Run document generation"
        }
    }

    var detail: String {
        switch self {
        case .projectSwitch:     return "Refused while a loop or auto task is running."
        case .fileBrowse:        return "Read-only; secrets, keys and .git are never shown."
        case .sourceControlRead: return "Read-only. Nothing is committed, pushed or discarded from the phone."
        case .issuesRead:        return "Uses the Mac's GitHub/GitLab sign-in; tokens never leave the Mac."
        case .issueComment:      return "Posts as you. Closing, editing and deleting stay on the Mac."
        case .selfHealApply:     return "Apply patches the LLM-IDE source checkout (never commits); discard deletes the proposal. Viewing, ignoring and retrying need no switch."
        case .toolApprovals:     return "Lets the phone answer a running chat's permission prompts, one tap each."
        case .autoTaskControl:   return "Auto Tasks can edit files in the project. Viewing state, history and logs, and Stop, need no switch."
        case .loopControl:       return "A Loop run edits files and runs commands in the project. Viewing and Stop need no switch."
        case .generationRun:     return "Writes generated documents into the project's llm-doc/generated folder and uses your LLM quota."
        }
    }

    /// Off unless the user turns it on: these change files, post as the user, or authorise a tool.
    var defaultsOn: Bool {
        switch self {
        case .projectSwitch, .fileBrowse, .sourceControlRead, .issuesRead: return true
        case .issueComment, .selfHealApply, .toolApprovals,
             .autoTaskControl, .loopControl, .generationRun:               return false
        }
    }

    /// What the phone is told when a request hits a switch that is off.
    var deniedMessage: String {
        "Turned off on the Mac. Enable \"\(title)\" in LLM-IDE → Settings → Mobile Control → Phone access."
    }
}

@MainActor
@Observable
final class PhoneAccessSettings {
    private let defaults: UserDefaults
    private var values: [String: Bool] = [:]
    /// Fired after a switch changes, so the manager can re-advertise capabilities to a paired phone.
    @ObservationIgnored var onChange: (() -> Void)?

    static func key(_ access: PhoneAccess) -> String { "mobile.phoneAccess.\(access.rawValue)" }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        for access in PhoneAccess.allCases {
            if let stored = defaults.object(forKey: Self.key(access)) as? Bool { values[access.rawValue] = stored }
        }
    }

    func isAllowed(_ access: PhoneAccess) -> Bool {
        values[access.rawValue] ?? access.defaultsOn
    }

    func set(_ access: PhoneAccess, _ on: Bool) {
        guard isAllowed(access) != on else { return }
        values[access.rawValue] = on
        defaults.set(on, forKey: Self.key(access))
        onChange?()
    }
}
