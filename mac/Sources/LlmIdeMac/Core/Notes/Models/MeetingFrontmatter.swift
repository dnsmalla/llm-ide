import Foundation

/// YAML frontmatter at the top of every meeting .md file.
/// Field names use snake_case on disk; Swift uses camelCase via CodingKeys.
struct MeetingFrontmatter: Codable, Equatable {
    var id: String
    var title: String
    var startedAt: Date
    var endedAt: Date?
    var durationSeconds: Int?
    var participants: [String]
    var platform: String          // "meet" | "teams" | "zoom" | "mic"
    var language: String
    var gist: String?
    var tldr: [String]
    var summaryGeneratedAt: Date?
    var summaryModel: String?

    init(id: String,
         title: String,
         startedAt: Date,
         endedAt: Date? = nil,
         durationSeconds: Int? = nil,
         participants: [String] = [],
         platform: String,
         language: String,
         gist: String? = nil,
         tldr: [String] = [],
         summaryGeneratedAt: Date? = nil,
         summaryModel: String? = nil) {
        self.id = id
        self.title = title
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.durationSeconds = durationSeconds
        self.participants = participants
        self.platform = platform
        self.language = language
        self.gist = gist
        self.tldr = tldr
        self.summaryGeneratedAt = summaryGeneratedAt
        self.summaryModel = summaryModel
    }

    enum CodingKeys: String, CodingKey {
        case id, title, platform, language, gist, tldr
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case durationSeconds = "duration_seconds"
        case participants
        case summaryGeneratedAt = "summary_generated_at"
        case summaryModel = "summary_model"
    }

    // Custom coding stores dates as ISO 8601 strings so Yams round-trips
    // them reliably.  Yams encodes Date via its YAMLEncodable path but
    // decodes via Date.construct(from:) which uses a regex that can fail
    // to match the emitted format, producing a typeMismatch error.

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(AppDateFormatter.isoString(startedAt), forKey: .startedAt)
        try c.encodeIfPresent(endedAt.map { AppDateFormatter.isoString($0) }, forKey: .endedAt)
        try c.encodeIfPresent(durationSeconds, forKey: .durationSeconds)
        try c.encode(participants, forKey: .participants)
        try c.encode(platform, forKey: .platform)
        try c.encode(language, forKey: .language)
        try c.encodeIfPresent(gist, forKey: .gist)
        try c.encode(tldr, forKey: .tldr)
        try c.encodeIfPresent(summaryGeneratedAt.map { AppDateFormatter.isoString($0) }, forKey: .summaryGeneratedAt)
        try c.encodeIfPresent(summaryModel, forKey: .summaryModel)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        startedAt = try c.decode(String.self, forKey: .startedAt).asDate()
        endedAt = try c.decodeIfPresent(String.self, forKey: .endedAt).flatMap { try $0.asDate() }
        durationSeconds = try c.decodeIfPresent(Int.self, forKey: .durationSeconds)
        participants = try c.decode([String].self, forKey: .participants)
        platform = try c.decode(String.self, forKey: .platform)
        language = try c.decode(String.self, forKey: .language)
        gist = try c.decodeIfPresent(String.self, forKey: .gist)
        tldr = try c.decode([String].self, forKey: .tldr)
        summaryGeneratedAt = try c.decodeIfPresent(String.self, forKey: .summaryGeneratedAt)
            .flatMap { try $0.asDate() }
        summaryModel = try c.decodeIfPresent(String.self, forKey: .summaryModel)
    }
}

private extension String {
    func asDate() throws -> Date {
        if let d = AppDateFormatter.parseISO(self) { return d }
        if let ts = Double(self) { return Date(timeIntervalSince1970: ts) }
        throw DecodingError.dataCorrupted(
            .init(codingPath: [], debugDescription: "Cannot parse date: \(self)"))
    }
}
