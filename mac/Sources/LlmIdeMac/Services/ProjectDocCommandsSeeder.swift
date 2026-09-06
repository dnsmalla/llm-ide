import Foundation
import os.log

/// Seeds and maintains `<projectRoot>/commands/<folder-name>/command.md`
/// for Doc Gen. Idempotent — only writes files that don't exist yet, so a
/// user's edits to a seeded command survive every reopen.
enum ProjectDocCommandsSeeder {

    private static let log = Logger(
        subsystem: "com.llmide.macapp",
        category: "ProjectDocCommandsSeeder")

    /// Create `commands/` and seed default command folders + README.
    static func seedIfNeeded(at projectRoot: URL) {
        let layout = ProjectLayout(root: projectRoot)
        let fm = FileManager.default

        do {
            try fm.createDirectory(at: layout.commandsDir, withIntermediateDirectories: true)
        } catch {
            log.error("commands dir failed: \(error.localizedDescription, privacy: .public)")
            return
        }

        writeIfAbsent(
            at: layout.commandsDir.appendingPathComponent("README.md"),
            content: commandsReadme)

        for def in DocCommand.seedDefinitions {
            let dir = layout.commandDir(named: def.folderName)
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                log.error("command dir \(def.folderName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                continue
            }
            writeIfAbsent(at: dir.appendingPathComponent("command.md"), content: def.markdown())
        }
    }

    // MARK: - Private

    private static func writeIfAbsent(at url: URL, content: String) {
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            log.debug("writeIfAbsent failed at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private static let commandsReadme = """
    # Doc Gen Commands

    Each subfolder is one reusable instruction for **Doc Gen** in LLM-IDE.

    ## Layout

    ```
    commands/
    ├── summarize/
    │   └── command.md
    ├── explain-code/
    └── release-notes/
    ```

    ## Editing

    - The `# Heading` line is the display name.
    - Everything below the heading is the instruction sent to the model.
    - A template supplies document *structure* (`##` sections); a command
      supplies *instructions*. Either one alone is enough to generate.
    - Add a new command: create `commands/my-command/command.md`, then reopen
      the project.

    <!-- llmide:doc-command-readme -->
    """
}
