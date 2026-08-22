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

        // Custom Codable: decode leniently (decodeIfPresent ?? false for `required`); encode the full set.
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

    /// Loads every bundled `Resources/source_connectors/*.json`, id-sorted,
    /// with reserved-noteType manifests dropped. A miss at every candidate
    /// returns `[]` — this must never trap, it runs on the first Library
    /// render and on every ingest tick.
    ///
    /// **Never mention `Bundle.module` in this file.** The SwiftPM-generated
    /// accessor calls `Swift.fatalError` unless `LlmIdeMac_LlmIdeMacLib.bundle`
    /// sits at `Bundle.main.bundleURL/` or at the absolute build path baked in
    /// at compile time — and `Scripts/build.sh` never copies that bundle into
    /// the .app (it rsyncs `Sources/LlmIdeMac/Resources/` into
    /// `Contents/Resources/`, which the accessor does not look at). Swift also
    /// evaluates *every* element of an array literal before the loop body, so
    /// even `for b in [Bundle.main, Bundle.module]` with an immediate `break`
    /// forces the accessor and hard-crashes the shipped app on any machine
    /// other than the build machine. `Bundle(url:)` is the safe equivalent:
    /// it returns `nil` instead of trapping.
    ///
    /// Two shapes matter:
    ///   * Packaged app — `build.sh` rsyncs the manifests into
    ///     `Contents/Resources/`, so `Bundle.main` finds them.
    ///   * `swift test` — `Bundle.main` is the xctest runner and finds nothing;
    ///     the manifests live in the SwiftPM resource bundle next to the test
    ///     bundle, opened here by URL rather than through the trapping accessor.
    static func loadBundled() -> [SourceConnectorManifest] {
        for dir in bundledResourceDirectories() {
            let loaded = loadManifests(inDirectory: dir)
            if loaded.isEmpty { continue }
            return droppingReservedNoteTypes(loaded).sorted { $0.id < $1.id }
        }
        return []
    }

    /// Decodes every `*.json` in `dir`. Unreadable or undecodable files are
    /// skipped; a missing directory yields `[]`. Exposed so tests can exercise
    /// the decode path against a directory they control.
    static func loadManifests(inDirectory dir: URL) -> [SourceConnectorManifest] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil) else { return [] }
        return urls
            .filter { $0.pathExtension.lowercased() == "json" }
            .compactMap { url -> SourceConnectorManifest? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(SourceConnectorManifest.self, from: data)
            }
    }

    /// Candidate `source_connectors/` directories, most-likely first. Every
    /// lookup here is optional-returning — nothing in this path can trap.
    static func bundledResourceDirectories() -> [URL] {
        var out: [URL] = []
        var seen: Set<String> = []
        func add(_ url: URL?) {
            guard let url, seen.insert(url.standardizedFileURL.path).inserted else { return }
            out.append(url)
        }

        // 1. Shipped app: build.sh put the JSON in Contents/Resources/.
        add(Bundle.main.url(forResource: "source_connectors", withExtension: nil))

        // 2. `swift test` / any host that ships the SwiftPM resource bundle:
        //    find LlmIdeMac_LlmIdeMacLib.bundle by URL. Under `swift test` the
        //    bundle is a sibling of the .xctest bundle in .build/<triple>/debug;
        //    an Xcode test host copies it into the .xctest's Resources.
        let bundleName = "LlmIdeMac_LlmIdeMacLib.bundle"
        let owning = Bundle(for: BundleLocator.self)
        var roots: [URL] = []
        for base in [owning.bundleURL, Bundle.main.bundleURL] {
            roots.append(base)
            roots.append(base.deletingLastPathComponent())
        }
        if let r = owning.resourceURL { roots.append(r) }
        if let r = Bundle.main.resourceURL { roots.append(r) }
        for root in roots {
            guard let bundle = Bundle(url: root.appendingPathComponent(bundleName)) else { continue }
            add(bundle.url(forResource: "source_connectors", withExtension: nil))
        }
        return out
    }
}

/// Anchor class used only with `Bundle(for:)` to find the image this module was
/// loaded from. Deliberately not `Bundle.module` — see `loadBundled`.
private final class BundleLocator {}
