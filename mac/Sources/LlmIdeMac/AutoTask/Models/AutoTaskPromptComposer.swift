import Foundation

/// Turns a task's prompt body plus its `AutoTaskConfig` into the single string
/// handed to the CLI. Pure and static so the exact prompt a given setup
/// produces is unit-testable without spawning a subprocess.
///
/// Layout of the composed prompt, top to bottom:
///
/// ```
/// <skill directive>          ← only when a skill is selected
///
/// --- PATHS ---              ← only for paths the body didn't already place
/// Input: …
/// Output: …
///
/// <body, with {{…}} substituted>
/// ```
///
/// The placeholder rule matters: a template that says "summarise every file in
/// {{INPUT_PATH}}" has already put the path exactly where it belongs, so
/// repeating it in a header block would be noise. The block exists for the
/// other case — a plain prompt with no placeholders — where the paths would
/// otherwise never reach the model at all.
enum AutoTaskPromptComposer {

    static let inputPlaceholder = "{{INPUT_PATH}}"
    static let outputPlaceholder = "{{OUTPUT_PATH}}"
    static let rootPlaceholder = "{{PROJECT_ROOT}}"

    /// Compose the final prompt.
    ///
    /// - Parameters:
    ///   - body: the prompt template (a saved `AutoTaskTemplate.body`, a
    ///     built-in `AppConfig` template, or a custom task's inline text).
    ///   - config: the task's saved settings.
    ///   - projectRoot: absolute project root, used to resolve the relative
    ///     paths in `config`. When nil the paths are passed through as written.
    ///   - writesFiles: whether this task's file changes are kept. False for
    ///     every review task — `runCLI(persistChanges: false)` reverts the
    ///     working tree afterwards — and the output path is then reported as a
    ///     destination to describe, never one to write to. Telling a model to
    ///     write files that are deleted seconds later wastes the whole run, and
    ///     for an output path outside the git root (the clone-into-project
    ///     layout, where `projectRoot != gitRoot`) the revert would not even
    ///     reach them, quietly breaking the read-only contract.
    /// - Returns: the prompt to run. Never empty when `body` is non-empty.
    static func compose(body: String, config: AutoTaskConfig, projectRoot: URL?,
                        writesFiles: Bool) -> String {
        let settings = config.trimmed
        let input = absolutePath(settings.inputPath, root: projectRoot)
        let output = absolutePath(settings.outputPath, root: projectRoot)

        var prompt = body
        var placedInput = false
        var placedOutput = false
        if let input, prompt.contains(inputPlaceholder) {
            prompt = prompt.replacingOccurrences(of: inputPlaceholder, with: input)
            placedInput = true
        }
        if let output, prompt.contains(outputPlaceholder) {
            prompt = prompt.replacingOccurrences(of: outputPlaceholder, with: output)
            placedOutput = true
        }
        if let root = projectRoot?.path {
            prompt = prompt.replacingOccurrences(of: rootPlaceholder, with: root)
        }

        var blocks: [String] = []
        if let directive = settings.skillDirective { blocks.append(directive) }
        if let pathBlock = pathBlock(input: placedInput ? nil : input,
                                     output: placedOutput ? nil : output,
                                     writesFiles: writesFiles) {
            blocks.append(pathBlock)
        }
        blocks.append(prompt.trimmingCharacters(in: .whitespacesAndNewlines))
        return blocks.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// Resolve a project-relative setting to an absolute path inside the
    /// project, or nil when the value is blank or escapes the project.
    ///
    /// Containment is enforced here rather than trusted, because the Mac
    /// picker is not the only writer: the paired iPhone can set any string
    /// (`AutoTaskConfigSet`), and a `.implement` task is told to write to
    /// whatever this returns. An absolute path or a `..` that climbs out is
    /// dropped — the task then falls back to project scope instead of being
    /// aimed somewhere the user never chose.
    static func absolutePath(_ relative: String?, root: URL?) -> String? {
        guard let value = AutoTaskConfig.normalized(relative) else { return nil }
        guard !value.hasPrefix("/"), !value.hasPrefix("~") else { return nil }
        guard let root else {
            // No project to resolve against; still refuse traversal so the
            // literal never reaches the prompt.
            return value.contains("..") ? nil : value
        }
        // LEXICAL containment, deliberately not `ProjectPaths.isInside`. That
        // helper canonicalizes through the filesystem, and an output folder
        // that does not exist yet — the common case for a task's destination —
        // canonicalizes differently from the root that does, so a perfectly
        // valid path was rejected. Removing `.`/`..` textually and comparing
        // prefixes is what this check actually needs, and it gives the same
        // answer whether or not the folder has been created.
        //
        // The residual: a SYMLINK inside the project that points outward still
        // resolves, because nothing here touches the filesystem. That is an
        // accepted limit — this stops path traversal, which is what a remote
        // writer can construct out of thin air; planting a symlink in the
        // user's own project requires local write access they already have.
        let base = root.standardizedFileURL.path
        let resolved = root.appendingPathComponent(value).standardizedFileURL.path
        guard resolved == base || resolved.hasPrefix(base.hasSuffix("/") ? base : base + "/")
        else { return nil }
        return resolved
    }

    /// The `--- PATHS ---` header, or nil when neither path needs announcing.
    private static func pathBlock(input: String?, output: String?,
                                  writesFiles: Bool) -> String? {
        var lines: [String] = []
        if let input {
            lines.append("- Input: \(input) — read from here; treat it as the scope of this task.")
        }
        if let output {
            lines.append(writesFiles
                ? "- Output: \(output) — write every file you produce here, creating the folder if needed."
                : "- Output: \(output) — the intended destination. This run is READ-ONLY: report what you would write there, and do not create or modify any file.")
        }
        guard !lines.isEmpty else { return nil }
        return (["--- PATHS ---"] + lines).joined(separator: "\n")
    }
}
