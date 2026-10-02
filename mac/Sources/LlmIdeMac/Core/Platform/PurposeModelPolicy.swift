import Foundation

/// What a model is being chosen FOR. Settings offers one model per purpose
/// (empty = the Default model) so a user can, say, plan with a large model and
/// review with a small one.
///
/// Keyed by the chat's wire `mode` string, not by `CodeAssistMode`: this lives
/// in `Core`, which must not import `Features/Chat`, and the wire value is the
/// contract every surface (panel, quick chat, phone bridge) already shares.
public enum ModelPurpose: String, CaseIterable, Sendable {
    case planning
    case coding
    case reviewing
    case documents

    /// The purpose a chat mode belongs to, or nil for a mode with no purpose.
    ///
    /// `auto` maps to coding on purpose: the Mac sends "auto" and the server
    /// classifies it into plan/execute/etc., so the Mac cannot know the real
    /// mode. Coding is the heaviest realistic outcome, which keeps the user's
    /// capable model for the turns that most need it.
    public init?(mode: String) {
        switch mode {
        case "plan", "assist_plan": self = .planning
        case "execute", "auto": self = .coding
        case "review": self = .reviewing
        // `auto_read_only` is the phone's read-only question mode: Ask in all but name.
        case "document", "ask", "auto_read_only": self = .documents
        default: return nil
        }
    }

    /// The `UserDefaults` key this purpose's model id persists under.
    public var settingsKey: String { "purposeModel.\(rawValue)" }
}

/// Which model a chat turn uses, from the user's Settings.
///
/// Precedence, highest first:
///   1. a model the user picked explicitly in the composer for this chat;
///   2. the purpose's model from Settings;
///   3. the Default model from Settings;
///   4. nil — send no model, so the engine uses the account default.
///
/// Pure value logic so the choice is asserted by `chat-contract-lab` (this
/// toolchain has no XCTest) and every surface resolves it the same way.
public struct PurposeModelPolicy: Sendable, Equatable {
    public var perPurpose: [ModelPurpose: String]
    public var defaultModelId: String

    public init(perPurpose: [ModelPurpose: String], defaultModelId: String) {
        self.perPurpose = perPurpose
        self.defaultModelId = defaultModelId
    }

    /// The model for a chat mode, ignoring any composer pick.
    ///
    /// - Parameter mode: the wire mode string ("plan", "execute", ...).
    /// - Returns: the purpose's model, else the default, else nil.
    public func modelId(forMode mode: String) -> String? {
        if let purpose = ModelPurpose(mode: mode), let id = Self.clean(perPurpose[purpose]) {
            return id
        }
        return Self.clean(defaultModelId)
    }

    /// The model for a chat mode, honouring an explicit composer pick.
    ///
    /// - Parameters:
    ///   - mode: the wire mode string.
    ///   - explicit: the model the user picked in this chat, if they did.
    ///     Empty or nil means "follow Settings".
    public func modelId(forMode mode: String, explicit: String?) -> String? {
        modelId(forMode: mode, explicit: explicit, isOffered: { _ in true })
    }

    /// As above, but a purpose model the provider does not offer is skipped.
    ///
    /// A purpose id is saved once and can outlive the provider's list (a
    /// retired model) or belong to another provider; sending it would make the
    /// engine reject the turn. The explicit pick and the default are NOT
    /// filtered: the pick comes from the live list, and the default is
    /// validated at startup (`startupModelId`).
    ///
    /// - Parameter isOffered: whether the current provider can serve an id.
    public func modelId(forMode mode: String, explicit: String?, isOffered: (String) -> Bool) -> String? {
        if let picked = Self.clean(explicit) { return picked }
        if let purpose = ModelPurpose(mode: mode),
           let id = Self.clean(perPurpose[purpose]), isOffered(id) {
            return id
        }
        return Self.clean(defaultModelId)
    }

    /// The model set specifically for a mode's purpose, with NO fallback.
    ///
    /// For callers that treat the default as a hint rather than a choice (Auto
    /// Tasks hand it to the usage chain and only pin a model when one was
    /// configured). Returns nil for an empty purpose model or an unknown mode.
    public func purposeModelId(forMode mode: String) -> String? {
        guard let purpose = ModelPurpose(mode: mode) else { return nil }
        return Self.clean(perPurpose[purpose])
    }

    /// Trimmed id, or nil when empty — Settings stores "" for "use the default".
    private static func clean(_ id: String?) -> String? {
        let trimmed = id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
