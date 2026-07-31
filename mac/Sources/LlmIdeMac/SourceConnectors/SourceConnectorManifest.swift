import Foundation

/// One Source Connector's declarative description. No logic — just metadata,
/// UI fields, folder/note names, endpoint paths, the raw-header mapping, and
/// the name of the Swift adapter that owns the wire-shape mechanics.
struct SourceConnectorManifest: Codable, Equatable {
    let id: String
    let displayName: String
    let icon: String
    let emptyText: String
    let platforms: [String]
    let mode: Mode
    let inboxFolder: String
    let noteType: String
    let endpoints: Endpoints
    let adapter: String
    let configFields: [ConfigField]
    let rawHeaders: [String: String]
    let noiseFilter: NoiseFilter?

    enum Mode: String, Codable { case fetch, liveCapture }

    struct Endpoints: Codable, Equatable {
        let test: String
        let fetch: String
        let seen: String
        let classify: String
    }

    struct ConfigField: Codable, Equatable {
        let key: String
        let label: String
        let type: FieldType
        var required: Bool = false
        var `default`: StringDefaultValue? = nil

        enum FieldType: String, Codable {
            case string, stringList, int, toggle, secret, select
        }

        // Synthesized Codable does NOT honor the `= false` default when a key
        // is missing in the JSON — it throws `keyNotFound`. The bundled
        // manifests legitimately omit `required` on optional fields, so we
        // decode it leniently. (Providing init(from:) disables synthesized
        // encode(to:), so both are spelled out below.)
        private enum CodingKeys: String, CodingKey {
            case key, label, type, required, `default`
        }

        init(key: String, label: String, type: FieldType,
             required: Bool = false, default: StringDefaultValue? = nil) {
            self.key = key
            self.label = label
            self.type = type
            self.required = required
            self.default = `default`
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.key = try c.decode(String.self, forKey: .key)
            self.label = try c.decode(String.self, forKey: .label)
            self.type = try c.decode(FieldType.self, forKey: .type)
            self.required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? false
            self.default = try c.decodeIfPresent(StringDefaultValue.self, forKey: .default)
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(key, forKey: .key)
            try c.encode(label, forKey: .label)
            try c.encode(type, forKey: .type)
            try c.encode(required, forKey: .required)
            try c.encodeIfPresent(`default`, forKey: .default)
        }
    }

    /// Wrapper so an int default (`7`) and absence both decode cleanly.
    struct StringDefaultValue: Codable, Equatable {
        let value: String
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { self.value = s }
            else if let i = try? c.decode(Int.self) { self.value = String(i) }
            else { self.value = "" }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            try c.encode(value)
        }
    }

    struct NoiseFilter: Codable, Equatable {
        let minLength: Int?
        let skipEmojiOnly: Bool?
    }

    /// Legacy plural note directories under `llm-doc/` — a connector
    /// `noteType` colliding with one of these would shadow the directory
    /// (`NoteType.meeting` → `meetings/`, `.email` → `emails/`,
    /// `.document` → `documents/`), so `loadBundled` drops any manifest
    /// whose `noteType` matches.
    static let reservedNoteTypes: Set<String> = ["meetings", "emails", "documents"]

    /// Drop manifests whose `noteType` collides with a legacy plural note
    /// directory. Exposed so tests can exercise the guard without a bundled
    /// resource directory.
    static func droppingReservedNoteTypes(
        _ manifests: [SourceConnectorManifest]
    ) -> [SourceConnectorManifest] {
        manifests.filter { !reservedNoteTypes.contains($0.noteType) }
    }

    /// Loads every bundled `Resources/source_connectors/*.json`. Returns an
    /// empty array if the resource directory is absent (Plan A ships no
    /// manifests; Plan B adds email.json + slack.json).
    static func loadBundled() -> [SourceConnectorManifest] {
        guard let dir = Bundle.main.url(forResource: "source_connectors", withExtension: nil),
              let urls = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            return []
        }
        return droppingReservedNoteTypes(
            urls
                .filter { $0.pathExtension.lowercased() == "json" }
                .compactMap { url in
                    guard let data = try? Data(contentsOf: url) else { return nil }
                    return try? JSONDecoder().decode(SourceConnectorManifest.self, from: data)
                }
        )
        .sorted { $0.id < $1.id }
    }
}
