import Foundation
import os.log

/// The kit's default templates and commands, fetched from the server and
/// cached on disk.
///
/// These were Swift constants until now, which meant adding a template was an
/// app change and a release. They live in `dnsmalla/agent-kit` instead, and
/// the server serves them at `/kb/agent/generation-library` (API v51).
///
/// The cache is not an optimisation — it is what keeps the feature working
/// when the fetch cannot happen. The seeder runs on project open and on New
/// Project, both of which can occur before the backend is up, with no network,
/// or against an older server; without a cache those projects would be seeded
/// with nothing and the menus would be empty. A stale default is strictly
/// better than no default, and the seeder only ever writes files that do not
/// exist, so a later refresh tops the project up rather than fighting it.
@MainActor
final class GenerationLibraryStore: ObservableObject {
    static let shared = GenerationLibraryStore()

    private static let log = Logger(subsystem: "com.llmide.macapp", category: "GenerationLibrary")

    @Published private(set) var templates: [LlmIdeAPIClient.GenerationLibraryEntry] = []
    @Published private(set) var commands: [LlmIdeAPIClient.GenerationLibraryEntry] = []

    /// True once entries are available from either source, so a caller can
    /// tell "nothing yet" from "genuinely empty".
    var isLoaded: Bool { !templates.isEmpty || !commands.isEmpty }

    private var cacheURL: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("com.llmide.macapp/generation-library.json")
    }

    private init() { loadCache() }

    /// Fetch from the server and refresh the cache. Best-effort: on any
    /// failure the previously cached entries stay in place.
    func refresh(api: LlmIdeAPIClient) async {
        do {
            let lib = try await api.generationLibrary()
            guard !lib.templates.isEmpty || !lib.commands.isEmpty else {
                // An empty answer is not worth overwriting a good cache with:
                // it means the kit submodule is missing on the server side,
                // which is a setup problem, not a decision to have no defaults.
                Self.log.error("generation library came back empty — keeping the cached entries")
                return
            }
            templates = lib.templates
            commands = lib.commands
            writeCache(lib)
        } catch {
            Self.log.error("generation library fetch failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Disk cache

    private struct Cached: Codable {
        let templates: [Entry]
        let commands: [Entry]
        struct Entry: Codable {
            let id: String, name: String, description: String, surface: String, body: String
        }
    }

    private func loadCache() {
        guard let url = cacheURL, let data = try? Data(contentsOf: url),
              let cached = try? JSONDecoder().decode(Cached.self, from: data) else { return }
        templates = cached.templates.map(Self.entry(from:))
        commands = cached.commands.map(Self.entry(from:))
    }

    private func writeCache(_ lib: LlmIdeAPIClient.GenerationLibrary) {
        guard let url = cacheURL else { return }
        let payload = Cached(
            templates: lib.templates.map(Self.cached(from:)),
            commands: lib.commands.map(Self.cached(from:)))
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(payload).write(to: url, options: .atomic)
        } catch {
            Self.log.debug("generation library cache write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func cached(from e: LlmIdeAPIClient.GenerationLibraryEntry) -> Cached.Entry {
        .init(id: e.id, name: e.name, description: e.description, surface: e.surface, body: e.body)
    }

    /// Rebuild the wire type from a cache row. `GenerationLibraryEntry` is
    /// `Decodable` only (it is a wire type), so this goes through JSON rather
    /// than adding a memberwise init that exists solely for the cache.
    private static func entry(from c: Cached.Entry) -> LlmIdeAPIClient.GenerationLibraryEntry {
        let dict: [String: String] = [
            "id": c.id, "name": c.name, "description": c.description,
            "surface": c.surface, "body": c.body,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: dict)) ?? Data()
        // Force-decodable by construction: every required key is present above.
        return (try? JSONDecoder().decode(LlmIdeAPIClient.GenerationLibraryEntry.self, from: data))
            ?? LlmIdeAPIClient.GenerationLibraryEntry.empty
    }
}

extension LlmIdeAPIClient.GenerationLibraryEntry {
    /// Only reachable if a cache row fails to round-trip through JSON, which
    /// the construction above rules out. Filtered by the seeder on its empty
    /// id rather than crashing on a corrupt cache.
    static let empty = try! JSONDecoder().decode(
        LlmIdeAPIClient.GenerationLibraryEntry.self,
        from: Data(#"{"id":"","name":"","description":"","surface":"doc","body":""}"#.utf8))

    /// The project folder name this entry seeds into: the `<stem>` of
    /// `<family>/<stem>`.
    var folderName: String { String(id.split(separator: "/").last ?? "") }

    var templateSurface: TemplateSurface { TemplateSurface(rawValue: surface) ?? .default }
}
