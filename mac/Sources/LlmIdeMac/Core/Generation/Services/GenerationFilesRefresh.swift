import Foundation

/// Brings the open project's generation files up to date. Runs on project
/// open and whenever the generation kit arrives (`.generationLibraryChanged`),
/// so the kit landing late tops the project up without a project switch.
///
/// Ingest templates are seeded here, always. Doc Gen's templates and commands
/// are seeded only while Doc Gen or Visual is the visible section, so an idle
/// project never gets them until first open; otherwise the provider only
/// reloads what is already on disk. The decision reads the section at call
/// time, so a kit arriving while Doc Gen is open seeds straight away.
@MainActor
enum GenerationFilesRefresh {
    static func run(projectRoot: URL?,
                    visibleSection: ShellSection,
                    provider: (any GenerationProviding)?) {
        if let projectRoot {
            IngestTemplateSeeder.seedIfNeeded(at: projectRoot)
        }
        if visibleSection == .docGen || visibleSection == .visual {
            provider?.seedProjectFiles(at: projectRoot)
        } else {
            provider?.reloadProjectFiles(at: projectRoot)
        }
    }
}
