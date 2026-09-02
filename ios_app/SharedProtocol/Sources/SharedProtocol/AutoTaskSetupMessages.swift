import Foundation

// MARK: - Auto-task setup channel
//
// The Mac's Auto Tasks page gained per-task settings (input path, output path,
// agent skill) and a library of reusable prompt templates stored in the
// project's `templates/auto_task/`. These messages mirror that surface to the
// phone: one snapshot request carrying everything the editor needs, plus four
// mutations.
//
// The Mac stays the source of truth — every mutation replies with a fresh
// `AutoTaskSetupReply`, exactly like the toggle/run handlers reply with a fresh
// `AutoTaskState`, so the phone never has to guess what took effect.

/// One saved prompt template (`templates/auto_task/<id>.md`).
public struct AutoTaskTemplateInfo: Codable, Equatable, Identifiable {
    /// Filename stem — the id an `AutoTaskConfigInfo.templateId` references.
    public let id: String
    public let name: String
    public let body: String

    public init(id: String, name: String, body: String) {
        self.id = id
        self.name = name
        self.body = body
    }
}

/// One task's saved settings. Absent fields mean "not set".
public struct AutoTaskConfigInfo: Codable, Equatable, Identifiable {
    /// `AutoTask.rawValue` or `CustomAutoTask.id`.
    public let taskId: String
    public let inputPath: String?
    public let outputPath: String?
    public let skillName: String?
    public let templateId: String?
    public var id: String { taskId }

    public init(taskId: String, inputPath: String?, outputPath: String?,
                skillName: String?, templateId: String?) {
        self.taskId = taskId
        self.inputPath = inputPath
        self.outputPath = outputPath
        self.skillName = skillName
        self.templateId = templateId
    }
}

/// One agent skill available in the open project's `.claude/skills/`.
public struct AutoTaskSkillInfo: Codable, Equatable, Identifiable {
    public let name: String
    public let description: String
    public var id: String { name }

    public init(name: String, description: String) {
        self.name = name
        self.description = description
    }
}

/// iPhone → Mac: send the whole Auto Task setup snapshot.
public struct AutoTaskSetupList: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskSetupList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

/// Mac → iPhone: templates, per-task settings, and the pickable folders and
/// skills — everything the phone's editor needs in one round trip.
public struct AutoTaskSetupReply: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskSetupReply
    /// False when no project is open on the Mac; the phone then shows why the
    /// editor is unavailable instead of an empty list that looks broken.
    public let hasProject: Bool
    public let projectName: String?
    public let templates: [AutoTaskTemplateInfo]
    public let configs: [AutoTaskConfigInfo]
    public let skills: [AutoTaskSkillInfo]
    /// Project-relative folders the Library knows about, for the path pickers.
    public let folders: [String]

    public init(hasProject: Bool, projectName: String?,
                templates: [AutoTaskTemplateInfo], configs: [AutoTaskConfigInfo],
                skills: [AutoTaskSkillInfo], folders: [String]) {
        self.hasProject = hasProject
        self.projectName = projectName
        self.templates = templates
        self.configs = configs
        self.skills = skills
        self.folders = folders
    }
    private enum CodingKeys: String, CodingKey {
        case type, hasProject, projectName, templates, configs, skills, folders
    }
}

/// iPhone → Mac: replace one task's settings.
///
/// Carries the WHOLE desired config, not a patch: a nil field means "clear
/// this", which a patch shape could not express without a second "unset" flag
/// per field.
public struct AutoTaskConfigSet: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskConfigSet
    public let taskId: String
    public let inputPath: String?
    public let outputPath: String?
    public let skillName: String?
    public let templateId: String?

    public init(taskId: String, inputPath: String?, outputPath: String?,
                skillName: String?, templateId: String?) {
        self.taskId = taskId
        self.inputPath = inputPath
        self.outputPath = outputPath
        self.skillName = skillName
        self.templateId = templateId
    }
    private enum CodingKeys: String, CodingKey {
        case type, taskId, inputPath, outputPath, skillName, templateId
    }
}

/// iPhone → Mac: create a template (`id == nil`) or update an existing one.
///
/// Carries BOTH the name and the body, and the Mac applies them in one handler.
/// Splitting an edit into a save frame plus a rename frame is a race: inbound
/// messages are dispatched as independent tasks, and a rename serviced first
/// moves the file out from under the body write, losing it silently.
public struct AutoTaskTemplateSave: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskTemplateSave
    /// nil = create a new template named `name`.
    public let id: String?
    /// The desired name. On an update, the Mac renames when it differs from
    /// the template's current name.
    public let name: String
    public let body: String

    public init(id: String?, name: String, body: String) {
        self.id = id
        self.name = name
        self.body = body
    }
    private enum CodingKeys: String, CodingKey { case type, id, name, body }
}

/// iPhone → Mac: rename a template. The Mac may return a DIFFERENT id in the
/// following snapshot — the id is the filename stem, so a rename moves the file
/// — and it repoints every task that referenced the old one.
public struct AutoTaskTemplateRename: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskTemplateRename
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
    private enum CodingKeys: String, CodingKey { case type, id, name }
}

/// iPhone → Mac: delete a template file.
public struct AutoTaskTemplateDelete: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskTemplateDelete
    public let id: String

    public init(id: String) { self.id = id }
    private enum CodingKeys: String, CodingKey { case type, id }
}
