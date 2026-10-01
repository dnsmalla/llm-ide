import Foundation

// MARK: - Doc Gen / Visual + llm-doc browser
//
// Doc Gen and Visual are ONE generator on the Mac: both POST `/generate-doc`
// and both return Markdown. They differ only in which template/command menu
// they draw from (`surface`). Visual does NOT produce images — the phone UI
// says so rather than let "Visual" promise a picture.
//
// A phone run always SAVES on the Mac, under `llm-doc/generated/`, and the
// result carries that path so the phone can open it again through the
// `llmdoc_*` messages below. Those are a read-only window onto the project's
// `llm-doc/` folder: list a directory, read a text file. Nothing here can
// write, delete or leave `llm-doc/` — the Mac rejects any path that escapes it.

/// A template or command the phone may run, flattened for display.
public struct GenerationChoice: Codable, Equatable, Identifiable, Hashable {
    /// Mac-side UUID string — the handle `generation_run` targets.
    public let id: String
    public let name: String
    /// `TemplateSurface` raw value: "doc" | "visual".
    public let surface: String
    public init(id: String, name: String, surface: String) {
        self.id = id
        self.name = name
        self.surface = surface
    }
}

public struct GenerationOptionsList: Codable, Equatable {
    public let type = MobileProtocol.Tag.generationOptionsList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct GenerationOptions: Codable, Equatable {
    public let type = MobileProtocol.Tag.generationOptions
    /// False when there is no active project — templates and the save folder
    /// both live in the project, so the phone shows "open a project" instead.
    public let available: Bool
    public let projectName: String?
    public let templates: [GenerationChoice]
    public let commands: [GenerationChoice]
    /// Project-relative save folder, e.g. "llm-doc/generated".
    public let saveFolder: String
    public init(available: Bool, projectName: String?, templates: [GenerationChoice],
                commands: [GenerationChoice], saveFolder: String) {
        self.available = available
        self.projectName = projectName
        self.templates = templates
        self.commands = commands
        self.saveFolder = saveFolder
    }
    private enum CodingKeys: String, CodingKey {
        case type, available, projectName, templates, commands, saveFolder
    }
}

/// A text source the phone supplies (extracted on-device, like chat files).
public struct GenerationSource: Codable, Equatable {
    public let name: String
    public let text: String
    public init(name: String, text: String) { self.name = name; self.text = text }
}

public struct GenerationRun: Codable, Equatable {
    public let type = MobileProtocol.Tag.generationRun
    /// Phone-minted id; echoed on the result and usable with `llmide_cancel`.
    public let commandId: String
    /// "doc" | "visual".
    public let surface: String
    public let templateId: String?
    public let commandRefId: String?
    public let prompt: String?
    public let sources: [GenerationSource]
    public init(commandId: String, surface: String, templateId: String?,
                commandRefId: String?, prompt: String?, sources: [GenerationSource]) {
        self.commandId = commandId
        self.surface = surface
        self.templateId = templateId
        self.commandRefId = commandRefId
        self.prompt = prompt
        self.sources = sources
    }
    private enum CodingKeys: String, CodingKey {
        case type, commandId, surface, templateId, commandRefId, prompt, sources
    }
}

public struct GenerationResult: Codable, Equatable {
    public let type = MobileProtocol.Tag.generationResult
    public let commandId: String
    public let ok: Bool
    public let title: String?
    public let markdown: String?
    /// `llm-doc`-relative path of the saved file, e.g. "generated/notes-doc.md".
    /// Nil when the run failed or the save failed (then `error` says why and
    /// `markdown` is still returned so nothing is lost).
    public let savedPath: String?
    public let skipped: [String]
    public let notice: String?
    public let error: String?
    public init(commandId: String, ok: Bool, title: String? = nil, markdown: String? = nil,
                savedPath: String? = nil, skipped: [String] = [], notice: String? = nil,
                error: String? = nil) {
        self.commandId = commandId
        self.ok = ok
        self.title = title
        self.markdown = markdown
        self.savedPath = savedPath
        self.skipped = skipped
        self.notice = notice
        self.error = error
    }
    private enum CodingKeys: String, CodingKey {
        case type, commandId, ok, title, markdown, savedPath, skipped, notice, error
    }
}

// MARK: llm-doc browser (read-only)

public struct LlmDocEntry: Codable, Equatable, Identifiable, Hashable {
    public let name: String
    public let isDirectory: Bool
    public let size: Int
    /// Seconds since 1970 — same convention as the other phone messages.
    public let modified: Double
    public var id: String { name }
    public init(name: String, isDirectory: Bool, size: Int, modified: Double) {
        self.name = name
        self.isDirectory = isDirectory
        self.size = size
        self.modified = modified
    }
}

public struct LlmDocList: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmDocList
    /// `llm-doc`-relative directory; "" is the root.
    public let path: String
    public init(path: String) { self.path = path }
    private enum CodingKeys: String, CodingKey { case type, path }
}

public struct LlmDocListing: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmDocListing
    public let path: String
    public let entries: [LlmDocEntry]
    public let error: String?
    public init(path: String, entries: [LlmDocEntry], error: String? = nil) {
        self.path = path
        self.entries = entries
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, path, entries, error }
}

public struct LlmDocRead: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmDocRead
    public let path: String
    public init(path: String) { self.path = path }
    private enum CodingKeys: String, CodingKey { case type, path }
}

public struct LlmDocFile: Codable, Equatable {
    public let type = MobileProtocol.Tag.llmDocFile
    public let path: String
    public let text: String?
    /// True when the file was cut at the Mac's read cap.
    public let truncated: Bool
    public let error: String?
    public init(path: String, text: String?, truncated: Bool = false, error: String? = nil) {
        self.path = path
        self.text = text
        self.truncated = truncated
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, path, text, truncated, error }
}
