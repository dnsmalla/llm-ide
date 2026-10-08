import Foundation

/// Readable model names for ids the live model list does not name.
///
/// The composer's model chip names the model the next turn sends, and that id
/// can be one the account's live list (the Agent SDK's `supportedModels`)
/// lacks — a Settings purpose model, a release newer than the cached list.
/// Showing the raw id ("claude-sonnet-5-5") there read as a bug next to Claude
/// Code's "Sonnet 5.5". Pure and public so `chat-contract-lab` asserts it.
public enum ModelDisplayName {
    /// "claude-sonnet-5-5" → "Sonnet 5.5"; "claude-opus-5[1m]" → "Opus 5";
    /// "claude-haiku-4-5-20251001" → "Haiku 4.5". Nil for anything that is not
    /// a `claude-<family>-<version>` id — the caller then shows the id itself
    /// rather than a guess.
    ///
    /// Mirrors the server's `nameFromId` (extension/llm_agent/sdk/models.mjs)
    /// so a name never differs between the picker rows and this fallback.
    public static func fromId(_ id: String) -> String? {
        let pattern = #"^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?(?:\[1m\])?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)),
              let familyRange = Range(match.range(at: 1), in: id),
              let versionRange = Range(match.range(at: 2), in: id)
        else { return nil }
        let family = String(id[familyRange])
        let version = id[versionRange].split(separator: "-").joined(separator: ".")
        guard let first = family.first, !version.isEmpty else { return nil }
        return first.uppercased() + family.dropFirst().lowercased() + " " + version
    }

    /// The id the effort lookup falls back to when neither the exact id nor
    /// its base id (`AIModel.baseId`: no "[1m]", no date snapshot) is listed:
    /// additionally lowercased, dots as dashes ("claude-sonnet-5.5"), and no
    /// "-latest" alias suffix.
    public static func normalizedId(_ id: String) -> String {
        var s = id.lowercased().trimmingCharacters(in: .whitespaces)
        if s.hasSuffix("[1m]") { s.removeLast(4) }
        if let r = s.range(of: #"-\d{8}$"#, options: .regularExpression) { s.removeSubrange(r) }
        if s.hasSuffix("-latest") { s.removeLast(7) }
        return s.replacingOccurrences(of: ".", with: "-")
    }

    /// The model chip's label, Claude Code style: "Sonnet 5.5 Medium" — name
    /// then effort, no separator. Just the name when the model offers no
    /// effort levels (`effort` nil).
    public static func chipLabel(name: String, effort: String?) -> String {
        guard let effort, !effort.isEmpty else { return name }
        return "\(name) \(effort)"
    }
}
