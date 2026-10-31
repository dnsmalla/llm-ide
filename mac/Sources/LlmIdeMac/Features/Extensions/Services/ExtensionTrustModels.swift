import Foundation

/// Settings list of folders the user has decided on (`/auth/me/workspace-trust`).
/// Appearing reads the server's own table only; every change is a click.
@MainActor
@Observable
final class WorkspaceTrustListModel {
    private let api: any ExtensionsTrustAPI
    init(api: any ExtensionsTrustAPI) { self.api = api }

    private(set) var items: [WorkspaceTrustItem] = []
    /// False when the operator turned the server's trust check off (every folder then behaves as trusted).
    private(set) var enforced = true
    private(set) var loaded = false
    private(set) var loading = false
    var errorText: String?
    private(set) var busy: Set<String> = []
    /// The folder the user is about to trust (a confirmation is showing).
    var pendingTrust: WorkspaceTrustItem?

    func load() async {
        loading = true
        defer { loading = false }
        do {
            let list = try await api.workspaceTrust()
            items = list.items
            enforced = list.enforced
            errorText = nil
            loaded = true
        } catch {
            errorText = Self.message(for: error)
        }
    }

    /// Switching off needs no confirmation; switching on goes through `pendingTrust`.
    func requestChange(_ item: WorkspaceTrustItem, trusted: Bool) async {
        if trusted { pendingTrust = item } else { await apply(item, trusted: false) }
    }

    func confirmPendingTrust() async {
        guard let item = pendingTrust else { return }
        pendingTrust = nil
        await apply(item, trusted: true)
    }

    private func apply(_ item: WorkspaceTrustItem, trusted: Bool) async {
        guard !busy.contains(item.path) else { return }
        busy.insert(item.path)
        defer { busy.remove(item.path) }
        do {
            let r = try await api.setWorkspaceTrust(path: item.path, trusted: trusted)
            if let i = items.firstIndex(where: { $0.path == item.path }) { items[i] = r.item }
            errorText = nil
        } catch {
            errorText = Self.message(for: error)
        }
    }

    var confirmation: String {
        pendingTrust.map { WorkspaceTrustPresentation.confirmationText(path: $0.path, servers: []) } ?? ""
    }

    static func message(for error: Error) -> String {
        if let api = error as? APIError, case .http(_, let code, let msg, _) = api {
            return WorkspaceTrustPresentation.message(forCode: code, serverMessage: msg)
        }
        return WorkspaceTrustPresentation.message(forCode: nil, serverMessage: nil)
    }
}

/// The per-user install allowlist card: operator list, ceiling, the user's additions,
/// the effective list and ignored entries; add / remove `owner/repo` or `owner/*`.
@MainActor
@Observable
final class ExtensionAllowlistModel {
    private let api: any ExtensionsTrustAPI
    init(api: any ExtensionsTrustAPI) { self.api = api }

    private(set) var allowlist: ExtAllowlist?
    private(set) var loading = false
    private(set) var saving = false
    var errorText: String?
    var draft = ""

    func load() async {
        loading = true
        defer { loading = false }
        do {
            allowlist = try await api.extAllowlist()
            errorText = nil
        } catch {
            errorText = ExtensionAllowlistText.message(forError: error, entry: nil)
        }
    }

    var canAdd: Bool { !saving && ExtensionAllowlistText.normalize(draft) != nil }

    func addDraft() async {
        guard let entry = ExtensionAllowlistText.normalize(draft) else {
            errorText = ExtensionAllowlistText.message(forCode: "INVALID_SOURCE", entry: draft.trimmingCharacters(in: .whitespaces))
            return
        }
        let current = allowlist?.user ?? []
        if current.contains(entry) { errorText = "\(entry) is already in your list."; return }
        if await save(current + [entry], entry: entry) { draft = "" }
    }

    func remove(_ entry: String) async {
        _ = await save((allowlist?.user ?? []).filter { $0 != entry }, entry: entry)
    }

    @discardableResult
    private func save(_ sources: [String], entry: String) async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        do {
            allowlist = try await api.setExtAllowlist(sources: sources)
            errorText = nil
            return true
        } catch {
            errorText = ExtensionAllowlistText.message(forError: error, entry: entry)
            return false
        }
    }
}

/// Wording and validation for the allowlist card. Pure.
enum ExtensionAllowlistText {
    /// `owner/repo` or `owner/*`, lowercased, as GitHub names them; nil when it is neither.
    static func normalize(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = s.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let name = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-_.")
        func ok(_ p: Substring) -> Bool {
            !p.isEmpty && p.unicodeScalars.allSatisfy { name.contains($0) }
        }
        guard ok(parts[0]) else { return nil }
        guard parts[1] == "*" || ok(parts[1]) else { return nil }
        return s
    }

    static func message(forCode code: String, entry: String?) -> String {
        let shown = entry.flatMap { $0.isEmpty ? nil : "\"\($0)\"" } ?? "That entry"
        switch code {
        case "INVALID_SOURCE":
            return "\(shown) is not a valid source. Use owner/repo for one repository or owner/* for everything one owner publishes."
        case "TOO_MANY_SOURCES":
            return "You have reached the most sources one account can save. Remove one before adding another."
        case "SOURCE_EXCEEDS_CEILING":
            return "\(shown) is wider than the operator allows. Use owner/repo or owner/* inside the limit shown above; anything wider has to be allowed by the operator on the server."
        case "VALIDATION_FAILED":
            return "The server did not accept that list. Reload the card and try again."
        default:
            return "The list could not be saved. Check that the backend is running and try again."
        }
    }

    static func message(forError error: Error, entry: String?) -> String {
        if let api = error as? APIError, case .http(_, let code, _, _) = api {
            return message(forCode: code, entry: entry)
        }
        return "Could not reach the backend. Check that it is running and try again."
    }

    /// Why a saved entry is not in effect.
    static let ignoredReason = "Not in effect: the operator's current limit no longer covers it."

    static func ceilingText(_ ceiling: [String]?) -> String {
        guard let ceiling else {
            return "The operator set no limit: you can add any owner/repo or owner/*."
        }
        if ceiling.isEmpty { return "The operator allows no additions, so only the operator's list applies." }
        return "You can add sources covered by: \(ceiling.joined(separator: ", "))."
    }
}
