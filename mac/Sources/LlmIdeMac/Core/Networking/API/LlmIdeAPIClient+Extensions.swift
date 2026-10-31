import Foundation

// The installed-extensions catalog API (`/auth/me/extensions/*`, API 94; spec
// docs/spec/extensions-catalog.md §9–9b). Every call is the user's own action
// except the two cached reads (`installed`, `updates`, `catalog`, `active`),
// which never reach the network server side. Models decode the fixtures in
// schema/http/fixtures/extensions/ (APIContractLab decodes them in CI).

// MARK: - Models

/// One installed item (a skill, plugin, MCP registry entry or skill bundle).
public struct ExtInstalledItem: Codable, Equatable, Identifiable {
    public struct Publisher: Codable, Equatable {
        public let id: String
        /// `official`, `unknown`, … — the server derives it from the source.
        public let trust: String
    }
    public struct Source: Codable, Equatable {
        public let kind: String
        public let url: String
        public let ref: String?
        public let commit: String
    }
    public struct Member: Codable, Equatable, Identifiable {
        public let memberId: String
        public let type: String
        public let name: String
        public let executable: Bool
        public var id: String { memberId }
    }
    public struct Declared: Codable, Equatable {
        /// Subset of `hook`, `mcp`, `lsp`, `bin`: what would run if enabled.
        public let executableKinds: [String]
    }
    public struct Permission: Codable, Equatable {
        public let type: String
        public let executable: Bool
        public let text: String
    }
    public struct Scan: Codable, Equatable {
        public let count: Int
        public let byRule: [String: Int]
        public let findings: [ExtScanFinding]
    }
    public struct State: Codable, Equatable {
        public let enabled: Bool
        public let disabledMembers: [String]
    }
    public struct UpdateHint: Codable, Equatable {
        public let latest: String
        public let checkedAt: String
    }
    public struct Previous: Codable, Equatable {
        public let pinnedCommit: String
        public let version: String?
        public let installedAt: String
    }

    public let id: String
    public let kind: String
    public let name: String
    public let description: String
    public let version: String?
    public let publisher: Publisher
    public let source: Source
    public let subpath: String?
    public let pinnedCommit: String
    public let installedAt: String
    public let members: [Member]
    public let declared: Declared
    public let permissions: [Permission]
    public let scan: Scan
    /// Per executable kind, the consent granted at a pinned commit. The Mac
    /// never reads the payload (the server enforces it), so it stays opaque.
    public let consents: [String: AnyCodable]
    public let integrity: String?
    public let storeDir: String?
    public let updatedAt: String?
    public let update: UpdateHint?
    public let previous: Previous?
    public let state: State
}

/// A scan finding. Always advisory (`severity` is `warn`); never a verdict.
public struct ExtScanFinding: Codable, Equatable {
    public let severity: String
    public let rule: String
    public let file: String
    public let line: Int?
    public let detail: String
    public let excerpt: String?
}

public struct ExtInstalledList: Codable, Equatable {
    /// The installed record could not be read: the list is not "empty".
    public let corrupt: Bool
    public let items: [ExtInstalledItem]
}

/// `install` answer. `alreadyInstalled` is true for the same commit again.
public struct ExtInstallResult: Codable, Equatable {
    public let ok: Bool
    public let alreadyInstalled: Bool?
    public let item: ExtInstalledItem
}

public struct ExtToggleResult: Codable, Equatable {
    public let ok: Bool
    public let item: ExtInstalledItem
}

public struct ExtOk: Codable, Equatable { public let ok: Bool }

public struct ExtUpdateSummary: Codable, Equatable {
    public let from: String
    public let to: String
    public let enabled: Bool
    public let wasEnabled: Bool
    public let reason: String?
    public let kinds: [String]
}

public struct ExtUpdateResult: Codable, Equatable {
    public let ok: Bool
    public let item: ExtInstalledItem
    public let update: ExtUpdateSummary
}

public struct ExtRollbackResult: Codable, Equatable {
    public let ok: Bool
    public let item: ExtInstalledItem
    public let rollback: ExtUpdateSummary
}

public struct ExtRepairResult: Codable, Equatable {
    public let ok: Bool
    public let repaired: Bool
    /// `ok`, `verified` or `restored`.
    public let status: String
    public let was: String?
    public let item: ExtInstalledItem
}

public struct ExtUpdateEntry: Codable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let kind: String
    public let current: String
    public let latest: String?
    public let checkedAt: String?
    public let ref: String?
    public let hasPrevious: Bool
}

public struct ExtUpdateList: Codable, Equatable {
    public let corrupt: Bool
    public let items: [ExtUpdateEntry]
}

public struct ExtUpdateCheckResult: Codable, Equatable {
    public struct Row: Codable, Equatable, Identifiable {
        public let id: String
        public let current: String
        public let latest: String?
        public let updateAvailable: Bool
        public let error: String?
    }
    public let checkedAt: String
    public let results: [Row]
}

/// What an update would change; written nothing server side.
public struct ExtUpdatePreview: Codable, Equatable {
    public struct Versions: Codable, Equatable { public let from: String?; public let to: String? }
    public struct FileEntry: Codable, Equatable { public let path: String; public let size: Int }
    public struct ChangedFile: Codable, Equatable {
        public let path: String
        public let before: Int
        public let after: Int
    }
    public struct Counts: Codable, Equatable { public let added: Int; public let removed: Int; public let changed: Int }
    public struct Files: Codable, Equatable {
        public let counts: Counts
        public let added: [FileEntry]
        public let removed: [FileEntry]
        public let changed: [ChangedFile]
        public let truncated: Bool
    }
    public struct ScanCounts: Codable, Equatable { public let count: Int; public let byRule: [String: Int]? }
    public struct ScanDelta: Codable, Equatable {
        public let before: ScanCounts
        public let after: ScanCounts
        public let newFindings: [ExtScanFinding]
        public let resolvedCount: Int
    }
    public struct NewMember: Codable, Equatable { public let memberId: String; public let type: String; public let name: String }
    public struct Executable: Codable, Equatable {
        public let newKinds: [String]
        public let newMembers: [NewMember]
        public let kinds: [String]
    }
    public struct MemberDelta: Codable, Equatable { public let added: [String]; public let removed: [String] }
    public struct Consent: Codable, Equatable { public let required: Bool; public let kinds: [String] }

    public let id: String
    public let from: String
    public let to: String
    public let version: Versions
    public let files: Files
    public let scan: ScanDelta
    public let executable: Executable
    public let members: MemberDelta
    public let consent: Consent
    public let wasEnabled: Bool
    public let staysEnabledWithoutConsent: Bool
    /// `new_executable_kind`, `new_executable_member`, `new_findings`, `consent_required`.
    public let flags: [String]
}

/// `installed` is the item id when this user has it, else false. Decoded from
/// either shape so a server change from bool to id does not break the screen.
public enum ExtInstalledRef: Codable, Equatable {
    case no
    case yes(id: String?)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .yes(id: s); return }
        let b = try c.decode(Bool.self)
        self = b ? .yes(id: nil) : .no
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .no: try c.encode(false)
        case .yes(let id): if let id { try c.encode(id) } else { try c.encode(true) }
        }
    }
    public var isInstalled: Bool { if case .yes = self { return true } else { return false } }
}

public struct ExtCatalogEntry: Codable, Equatable, Identifiable {
    public struct Source: Codable, Equatable { public let url: String?; public let path: String? }
    public let indexId: String
    public let kind: String
    public let name: String
    public let description: String
    public let publisher: String
    public let source: Source
    public let installable: Bool
    /// Why a browse-only entry cannot be installed here (`package_launcher`,
    /// `registry_install_not_supported`, `unsupported_source`, `source_not_allowed`, …).
    public let reason: String?
    public let installed: ExtInstalledRef
    public var id: String { "\(indexId)|\(kind)|\(name)|\(source.url ?? "")|\(source.path ?? "")" }
}

public struct ExtCatalogSource: Codable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let kind: String
    /// `fresh`, `stale`, `empty` or `error`.
    public let status: String
    public let count: Int
    public let fetchedAt: String?
}

public struct ExtCatalogPage: Codable, Equatable {
    public let query: String
    public let total: Int
    public let offset: Int
    public let results: [ExtCatalogEntry]
    public let sources: [ExtCatalogSource]
}

public struct ExtRefreshResult: Codable, Equatable {
    public struct Row: Codable, Equatable, Identifiable {
        public let id: String
        /// `refreshed`, `fresh`, `throttled`, `error`, …
        public let status: String
        public let count: Int?
        public let error: String?
    }
    public let results: [Row]
}

/// Names and counts only (the server never returns configs or paths).
public struct ExtActiveView: Codable, Equatable {
    public struct Item: Codable, Equatable { public let id: String; public let kind: String; public let trust: String }
    public struct Skill: Codable, Equatable { public let id: String; public let name: String; public let description: String; public let sourceId: String }
    public let fingerprint: String
    public let failClosed: Bool
    public let items: [Item]
    public let skills: [Skill]
    public let pluginSkills: [AnyCodable]
    public let commands: [AnyCodable]
    public let subagents: [AnyCodable]
    public let sdkPlugins: Int
    public let mcpServers: [AnyCodable]
    public let excluded: [AnyCodable]
    public let warnings: [AnyCodable]
}

// MARK: - Client

/// The slice of the client the Extensions catalog screen uses, so its view
/// model is testable with a fake.
protocol ExtensionsCatalogAPI: AnyObject, Sendable {
    func extInstalled() async throws -> ExtInstalledList
    func extInstall(url: String, ref: String?, commit: String?, path: String?) async throws -> ExtInstallResult
    func extToggle(id: String, enabled: Bool, consents: [String]?) async throws -> ExtToggleResult
    func extToggleMembers(id: String, members: [String], enabled: Bool) async throws -> ExtToggleResult
    func extUninstall(id: String) async throws
    func extUpdates() async throws -> ExtUpdateList
    func extCheckUpdates(id: String?) async throws -> ExtUpdateCheckResult
    func extPreviewUpdate(id: String, commit: String?) async throws -> ExtUpdatePreview
    func extApplyUpdate(id: String, commit: String?, consents: [String]?) async throws -> ExtUpdateResult
    func extRollback(id: String) async throws -> ExtRollbackResult
    func extRepair(id: String) async throws -> ExtRepairResult
    func extCatalog(query: String, kind: String?, limit: Int, offset: Int) async throws -> ExtCatalogPage
    func extRefreshCatalog(source: String?) async throws -> ExtRefreshResult
}

extension LlmIdeAPIClient: ExtensionsCatalogAPI {
    private struct IdBody: Encodable { let id: String }

    func extInstalled() async throws -> ExtInstalledList {
        try await get("/auth/me/extensions/installed", authenticated: true)
    }

    func extInstall(url: String, ref: String?, commit: String?, path: String?) async throws -> ExtInstallResult {
        struct Req: Encodable { let url: String; let ref: String?; let commit: String?; let path: String? }
        return try await post("/auth/me/extensions/install",
                              body: Req(url: url, ref: ref, commit: commit, path: path), authenticated: true)
    }

    /// Switch an item on or off. `consents` names each executable kind the user
    /// agreed to (required to enable an item that declares any).
    func extToggle(id: String, enabled: Bool, consents: [String]?) async throws -> ExtToggleResult {
        struct Req: Encodable { let id: String; let enabled: Bool; let consents: [String]? }
        return try await post("/auth/me/extensions/toggle",
                              body: Req(id: id, enabled: enabled, consents: consents), authenticated: true)
    }

    /// Check (`enabled` true) or uncheck member ids of an item, not the item itself.
    func extToggleMembers(id: String, members: [String], enabled: Bool) async throws -> ExtToggleResult {
        struct Req: Encodable { let id: String; let enabled: Bool; let members: [String] }
        return try await post("/auth/me/extensions/toggle",
                              body: Req(id: id, enabled: enabled, members: members), authenticated: true)
    }

    func extUninstall(id: String) async throws {
        let _: ExtOk = try await post("/auth/me/extensions/uninstall", body: IdBody(id: id), authenticated: true)
    }

    func extUpdates() async throws -> ExtUpdateList {
        try await get("/auth/me/extensions/updates", authenticated: true)
    }

    /// Network step (one GitHub call per item); user-initiated only.
    func extCheckUpdates(id: String?) async throws -> ExtUpdateCheckResult {
        struct Req: Encodable { let id: String? }
        return try await post("/auth/me/extensions/updates/check", body: Req(id: id), authenticated: true)
    }

    func extPreviewUpdate(id: String, commit: String?) async throws -> ExtUpdatePreview {
        struct Req: Encodable { let id: String; let commit: String? }
        return try await post("/auth/me/extensions/update/preview", body: Req(id: id, commit: commit), authenticated: true)
    }

    func extApplyUpdate(id: String, commit: String?, consents: [String]?) async throws -> ExtUpdateResult {
        struct Req: Encodable { let id: String; let commit: String?; let consents: [String]? }
        return try await post("/auth/me/extensions/update",
                              body: Req(id: id, commit: commit, consents: consents), authenticated: true)
    }

    func extRollback(id: String) async throws -> ExtRollbackResult {
        try await post("/auth/me/extensions/rollback", body: IdBody(id: id), authenticated: true)
    }

    func extRepair(id: String) async throws -> ExtRepairResult {
        try await post("/auth/me/extensions/repair", body: IdBody(id: id), authenticated: true)
    }

    /// Reads the server's cached index only (no network).
    func extCatalog(query: String, kind: String?, limit: Int = 25, offset: Int = 0) async throws -> ExtCatalogPage {
        var items = [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let kind { items.append(URLQueryItem(name: "kind", value: kind)) }
        var comps = URLComponents()
        comps.queryItems = items
        return try await get("/auth/me/extensions/catalog?" + (comps.percentEncodedQuery ?? ""), authenticated: true)
    }

    /// Network step; user-initiated only. `source` nil refreshes every index.
    func extRefreshCatalog(source: String?) async throws -> ExtRefreshResult {
        struct Req: Encodable { let source: String? }
        return try await post("/auth/me/extensions/catalog/refresh", body: Req(source: source), authenticated: true)
    }

    func extActive() async throws -> ExtActiveView {
        try await get("/auth/me/extensions/active", authenticated: true)
    }
}
