import Foundation

/// The single declarative list of input sources and the lookups everything
/// source-related uses (classification, Library SOURCES display, ingestion).
/// Adding a source is one entry here plus its `InputSource` struct.
enum SourceRegistry {
    static let all: [InputSource] = [MeetingSource(), EmailSource()]

    /// Match a frontmatter `platform` value to its source. Unknown/empty →
    /// the meeting source (preserves the historical default-to-meeting).
    static func source(forPlatform platform: String) -> InputSource {
        let key = platform.lowercased()
        return all.first { $0.platforms.contains(key) } ?? MeetingSource()
    }

    static func source(id: String) -> InputSource? {
        all.first { $0.id == id }
    }

    /// Sources the ingestion driver should poll (live-capture is excluded —
    /// it's driven by its own engine).
    static var fetchSources: [InputSource] {
        all.filter { $0.mode == .fetch }
    }
}
