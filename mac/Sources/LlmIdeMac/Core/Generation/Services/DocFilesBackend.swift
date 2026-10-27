import Foundation

/// Where Doc Gen's project-folder files (`templates/<folder>/template.md`,
/// `commands/<folder>/command.md` and the kit seeds) are listed, saved,
/// deleted and seeded.
///
/// Two implementations: `LocalDocFiles` (Swift reads and writes the folder,
/// the path that has always shipped) and `ServerDocFiles` (the `/kb/docs/*`
/// routes, behind the `docGenUseServerStore` preference). `DocFilesWithFallback`
/// asks the server first and answers from `LocalDocFiles` for any call the
/// server cannot serve. The stores pick one at call time; with the preference
/// off they never construct the server side, so no request is made.
///
/// App-support state (the no-project template list, the output folder, the
/// kit cache) is not on this seam; it stays in the stores (docs-kit §5a).
@MainActor
protocol DocFilesBackend {
    /// Every template in the project's `templates/`, sorted by display name.
    func listTemplates(root: URL) async throws -> [DocTemplate]
    /// Every command in the project's `commands/`, sorted by display name.
    func listCommands(root: URL) async throws -> [DocCommand]
    /// Write `template` into `templates/<folderName>/template.md`.
    func saveTemplate(_ template: DocTemplate, folderName: String, root: URL) async throws
    /// Remove `templates/<folderName>/template.md`, and the folder when that
    /// leaves it empty. Nothing else in the folder is removed.
    func deleteTemplate(folderName: String, root: URL) async throws
    /// Write `command` into `commands/<folderName>/command.md`.
    func saveCommand(_ command: DocCommand, folderName: String, root: URL) async throws
    /// Remove `commands/<folderName>/command.md`, and the folder when that
    /// leaves it empty.
    func deleteCommand(folderName: String, root: URL) async throws
    /// Write the README files and the kit's templates and commands, where
    /// absent. An existing file is never replaced.
    func seed(root: URL,
              templateKit: [LlmIdeAPIClient.GenerationLibraryEntry],
              commandKit: [LlmIdeAPIClient.GenerationLibraryEntry]) async throws
}
