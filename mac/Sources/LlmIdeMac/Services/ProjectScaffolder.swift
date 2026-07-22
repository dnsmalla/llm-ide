import Foundation
import os.log

/// Creates and maintains the canonical folder tree inside a LLM IDE project.
///
/// Called on every `ProjectStore.openFolder(at:)` — fully idempotent, so
/// re-opening an existing project only creates whatever is newly missing.
///
/// Expected layout after scaffolding:
///
/// ```
/// <projectFolder>/
/// ├── source/     ← meeting & email transcripts (your Sources)
/// ├── code/       ← code files
/// ├── data/       ← documents, data files, images
/// ├── notes/      ← notes generated from meetings/email
/// ├── templates/  ← Doc Gen templates (`<slug>/template.md`)
/// └── system/     ← LLM IDE managed: settings, faults, graph, index (most git-ignored)
///     ├── project.json   ← project metadata (written by ProjectStore)
///     ├── sync.json      ← last export info  (git-ignored)
///     ├── index.sqlite   ← full-text index   (git-ignored)
///     ├── faults/        ← fault log entries
///     ├── graph/         ← knowledge graph   (git-ignored)
///     └── cache/         ← runtime cache     (git-ignored)
/// ```
enum ProjectScaffolder {

    private static let log = Logger(
        subsystem: "com.llmide.macapp",
        category:  "ProjectScaffolder"
    )

    // Directories that must exist under every project root.
    static let requiredDirectories = [
        "source", "code", "data", "notes", "templates",
        "system", "system/faults", "system/graph", "system/cache",
        ".claude",
    ]

    // MARK: - Public entry point

    /// Validate that `folderURL` is a recognised LLM IDE project folder.
    ///
    /// A folder is accepted when it satisfies **any** of the following:
    ///
    /// 1. Already a new-layout LLM IDE project — has `system/project.json`.
    /// 2. Is completely empty — treated as a new project to be scaffolded.
    ///
    /// Anything else (e.g. a Downloads folder, a code repo, an old-layout
    /// project with `meetings/`/`plans/`) throws
    /// `ProjectStoreError.invalidFolderStructure` so the caller can surface
    /// an error before any state is mutated.
    ///
    /// - Throws: `ProjectStoreError.invalidFolderStructure` when none of
    ///   the above conditions are met.
    static func validate(at folderURL: URL) throws {
        let fm = FileManager.default
        // 1. New-layout project marker.
        if fm.fileExists(atPath: folderURL.appendingPathComponent("system/project.json").path) { return }
        // 2. Empty folder — new project to scaffold.
        let contents = (try? fm.contentsOfDirectory(atPath: folderURL.path)) ?? []
        if contents.isEmpty { return }
        throw ProjectStoreError.invalidFolderStructure(folderURL.lastPathComponent)
    }

    /// Scaffold the project folder.  Safe to call on an existing project.
    ///
    /// - Throws: `CocoaError` when a required directory cannot be created
    ///   (e.g. read-only volume, permissions issue). `.gitignore` / `.gitkeep`
    ///   / README write failures are logged but do not propagate — they are
    ///   non-critical and will succeed on the next open.
    static func scaffold(at folderURL: URL, project: Project) throws {
        let fm = FileManager.default

        // 1. Core directories
        for dir in requiredDirectories {
            try fm.createDirectory(
                at: folderURL.appendingPathComponent(dir),
                withIntermediateDirectories: true)
        }

        // 2. Root .gitignore — append managed block once; never clobber user rules
        ensureRootGitignore(at: folderURL)

        // 3. .gitkeep markers so empty directories survive `git add .`
        for dir in ["notes", "data"] {
            writeIfAbsent(
                at: folderURL.appendingPathComponent("\(dir)/.gitkeep"),
                content: "")
        }

        // 4. README.md — refreshed on every open so settings changes (language,
        //    linked repo, display name) are always reflected.  BUT never clobber
        //    a foreign README: when adopting a cloned code repo as a project, the
        //    repo ships its own README.md.  Only (re)write when the file is absent
        //    or already LLM IDE-managed (carries the auto marker).
        let readmeURL = folderURL.appendingPathComponent("README.md")
        let existingReadme = try? String(contentsOf: readmeURL, encoding: .utf8)
        if existingReadme == nil
            || existingReadme!.contains("<!-- llmide:auto")
            || existingReadme!.contains("<!-- meetnotes:auto") {
            writeAlways(
                at: readmeURL,
                content: makeReadme(project: project, folderURL: folderURL))
        } else {
            log.info("preserving existing non-LLM IDE README at \(folderURL.lastPathComponent, privacy: .public)")
        }

        // 5. .claude directory — project-level agent configuration and instructions
        ensureClaudeConfig(at: folderURL, project: project)

        // 6. Root entry files every AI tool reads on open (CLAUDE.md,
        //    AGENTS.md, .cursorrules, GEMINI.md). Skills/rules dirs are
        //    filled later by ProjectSkillsInstaller; these point agents there.
        ensureAgentEntryFiles(at: folderURL, project: project)

        // 7. Doc Gen templates — default subfolders under templates/
        ProjectDocTemplatesSeeder.seedIfNeeded(at: folderURL)

        log.info("scaffold complete: \(folderURL.lastPathComponent, privacy: .public)")
    }

    // MARK: - Private helpers

    /// Write `content` to `url` only if the file does not yet exist.
    /// Logs but does not propagate write errors (these files are non-critical).
    private static func writeIfAbsent(at url: URL, content: String) {
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            log.debug("writeIfAbsent failed at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Overwrite `url` unconditionally.
    /// Logs but does not propagate write errors.
    private static func writeAlways(at url: URL, content: String) {
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            log.debug("writeAlways failed at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - .gitignore

    private static let managedGitignoreBlock = """
    # >>> LLM IDE managed (auto-generated / ephemeral) — edit your own rules above
    system/cache/
    system/index.sqlite
    system/index.sqlite-shm
    system/index.sqlite-wal
    system/graph/
    system/sync.json
    *.partial.md
    # Agent skills — relative symlinks into the LLM IDE central kit (.skills).
    # Re-created by New Project / Rebuild missing folders via the local server.
    .claude/skills/
    .claude/rules/
    .claude/agents
    .claude/commands
    .claude/prompts
    .cursor/
    .codex/
    .agents/
    .gemini/
    # <<< LLM IDE managed
    """

    /// Ensure the project-root .gitignore contains the managed block. Creates
    /// the file if absent; appends the block once if the marker is missing;
    /// when an older managed block is present without the agent-skills
    /// ignores, injects those lines before the closing marker. Never rewrites
    /// the user's own rules above the managed section.
    private static func ensureRootGitignore(at folderURL: URL) {
        let url = folderURL.appendingPathComponent(".gitignore")
        let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        if existing.contains("# >>> LLM IDE managed") {
            // Upgrade path: older scaffolds lacked the agent-skills ignores.
            if !existing.contains(".agents/") {
                let injected = existing.replacingOccurrences(
                    of: "# <<< LLM IDE managed",
                    with: """
                    # Agent skills — relative symlinks into the LLM IDE central kit (.skills).
                    .claude/skills/
                    .claude/rules/
                    .claude/agents
                    .claude/commands
                    .claude/prompts
                    .cursor/
                    .codex/
                    .agents/
                    .gemini/
                    # <<< LLM IDE managed
                    """)
                if injected != existing {
                    do { try injected.write(to: url, atomically: true, encoding: .utf8) }
                    catch { log.error("gitignore upgrade failed: \(error.localizedDescription, privacy: .public)") }
                }
            }
            return
        }
        let combined: String
        if existing.isEmpty {
            combined = managedGitignoreBlock + "\n"
        } else {
            let sep = existing.hasSuffix("\n") ? "\n" : "\n\n"
            combined = existing + sep + managedGitignoreBlock + "\n"
        }
        do { try combined.write(to: url, atomically: true, encoding: .utf8) }
        catch { log.error("gitignore write failed: \(error.localizedDescription, privacy: .public)") }
    }

    // MARK: - README

    /// Generate the project README.
    ///
    /// The "Auto-generated section" block below the divider is always
    /// refreshed.  Users may add content ABOVE the `<!-- llmide:auto -->`
    /// marker; that content is preserved across refreshes.
    private static func makeReadme(project: Project, folderURL: URL) -> String {
        let isoDate = AppDateFormatter.isoString(project.createdAt)
        let lang    = project.settings.language.uppercased()
        let name    = project.displayName
        let repoLine: String = {
            guard let repo = project.settings.linkedRepo else { return "(none)" }
            return "\(repo.kind.rawValue) — [\(repo.remoteId)](\(repo.url))"
        }()

        return """
        # \(name)

        > Managed by **LLM IDE** — meeting intelligence & project control.

        <!-- llmide:auto — content below is refreshed by LLM IDE on every project open -->

        ## Project Info

        | Field       | Value          |
        |-------------|----------------|
        | ID          | `\(project.id)` |
        | Language    | \(lang)        |
        | Created     | \(isoDate)     |
        | Linked repo | \(repoLine)    |

        ## Folder Structure

        ```
        \(name)/
        ├── source/     ← meeting & email transcripts (your Sources)
        ├── code/       ← code files
        ├── data/       ← documents, data files, images
        ├── notes/      ← notes generated from meetings/email
        ├── templates/  ← Doc Gen templates (`<slug>/template.md`)
        └── system/     ← LLM IDE managed: settings, faults, graph, index (most git-ignored)
        ```

        ## Meetings

        Meeting files land under `source/YYYY/MM/YYYY-MM-DD-<slug>-<id>.md` when
        you close or export the project.  Each file has YAML frontmatter, an action
        items / decisions / blockers summary, and the full transcript (fenced).

        ---
        *Auto-generated by LLM IDE. Add your own notes ABOVE the `<!-- llmide:auto -->` marker.*

        """
    }

    // MARK: - .claude Configuration

    /// Create and populate the `.claude/` directory with project-level agent
    /// configuration and instructions. This makes agents aware of project
    /// context and allows per-project customization of AI behavior.
    private static func ensureClaudeConfig(at folderURL: URL, project: Project) {
        let claudeDir = folderURL.appendingPathComponent(".claude")

        // 1. project.md — project-specific instructions for agents
        let projectMDURL = claudeDir.appendingPathComponent("project.md")
        writeIfAbsent(
            at: projectMDURL,
            content: makeProjectInstructions(project: project, folderURL: folderURL)
        )

        // 2. settings.json — project-level agent settings
        let settingsJSONURL = claudeDir.appendingPathComponent("settings.json")
        writeIfAbsent(
            at: settingsJSONURL,
            content: makeClaudeSettings(project: project)
        )

        // 3. README.md — explains the .claude directory structure
        let claudeReadmeURL = claudeDir.appendingPathComponent("README.md")
        writeIfAbsent(
            at: claudeReadmeURL,
            content: claudeDirectoryReadme
        )
    }

    /// Generate project.md with project-specific instructions for agents.
    /// Users can edit this file to provide context about their project.
    private static func makeProjectInstructions(project: Project, folderURL: URL) -> String {
        let name = project.displayName
        let lang = project.settings.language
        let repoInfo: String = {
            guard let repo = project.settings.linkedRepo else { return "" }
            return """

**Linked Repository:**
- Provider: \(repo.kind.rawValue)
- Repository: \(repo.remoteId)
- URL: \(repo.url)
"""
        }()

        return """
# \(name)

> Project-specific instructions for LLM IDE agents.
>
> Edit this file to provide context about your project, coding standards,
> architecture decisions, and any other information that helps agents
> work more effectively with your codebase.

## Project Overview

**Language:** \(lang.uppercased())\(repoInfo)

## Context for Agents

### Architecture
<!-- Describe your project's architecture, key components, and how they interact -->

### Coding Standards
<!-- Your coding conventions, style preferences, and best practices -->

### Important Notes
<!-- Any critical information agents should know when making changes -->

### Testing Approach
<!-- How to run tests, what testing framework you use -->

---
*Instructions in this file are automatically loaded by agents when working
on this project. Keep it concise and focused on actionable context.*
"""
    }

    /// Generate settings.json with project-level agent configuration.
    private static func makeClaudeSettings(project: Project) -> String {
        let lang = project.settings.language
        // Convert to JSON string
        return """
{
  "projectName": "\(project.displayName)",
  "language": "\(lang)",
  "enabledFeatures": {
    "codeReview": true,
    "docGeneration": true,
    "issueTracking": true
  },
  "agentPreferences": {
    "contextScope": "project",
    "includeTests": true,
    "includeDocs": true
  }
}
"""
    }

    /// README explaining the .claude directory structure.
    private static let claudeDirectoryReadme = """
# .claude Directory

This directory contains project-level configuration and instructions for LLM IDE agents.

## Files

- **project.md** — Project-specific instructions and context for agents.
  Edit this file to help agents understand your project's architecture,
  coding standards, and important conventions.

- **settings.json** — Project-level agent preferences and feature flags.
  Controls which agent features are enabled and how they interact with
  your project.

- **skills/** / **rules/** — Linked from the central LLM IDE skills kit
  (Claude / Cursor / Codex share the same kit via sibling tool dirs).

## Purpose

Agents automatically load instructions from `project.md` when working on
this project, giving them project-aware context. Settings in `settings.json`
allow you to customize agent behavior per project.

## Global vs Project Settings

- **Global settings** (in LLM IDE app Settings): Apply to all projects
- **Project settings** (this directory): Override or customize for this
  specific project

---
*Part of LLM IDE project structure.*
"""

    // MARK: - Root agent entry files

    /// Write the root files each AI tool loads as project instructions.
    ///
    /// | File           | Tool        |
    /// |----------------|-------------|
    /// | `CLAUDE.md`    | Claude Code |
    /// | `AGENTS.md`    | Codex / open `.agents` |
    /// | `.cursorrules` | Cursor      |
    /// | `GEMINI.md`    | Gemini CLI  |
    ///
    /// Only creates/refreshes LLM IDE-managed files (absent, or carrying the
    /// `llmide:auto` marker). Never clobbers a hand-authored entry file.
    private static func ensureAgentEntryFiles(at folderURL: URL, project: Project) {
        let body = makeAgentEntryFile(project: project)
        let targets: [(String, String)] = [
            ("CLAUDE.md", body),
            ("AGENTS.md", body),
            ("GEMINI.md", body),
            (".cursorrules", body),
        ]
        for (name, content) in targets {
            let url = folderURL.appendingPathComponent(name)
            let existing = try? String(contentsOf: url, encoding: .utf8)
            if existing == nil || existing!.contains("<!-- llmide:auto") {
                writeAlways(at: url, content: content)
            } else {
                log.info("preserving existing \(name, privacy: .public) at \(folderURL.lastPathComponent, privacy: .public)")
            }
        }
    }

    /// Shared entry-file body for Claude / Cursor / Codex / Gemini.
    /// Points every tool at the same project context + installed skill/rule dirs.
    private static func makeAgentEntryFile(project: Project) -> String {
        let name = project.displayName
        let lang = project.settings.language.uppercased()
        return """
        # \(name)

        > Managed by **LLM IDE**. Entry point for Claude Code, Cursor, Codex, and Gemini.
        >
        <!-- llmide:auto — refreshed on New Project / Rebuild missing folders -->

        ## Project context

        - **Name:** \(name)
        - **Language:** \(lang)
        - **Editable project notes:** [`.claude/project.md`](.claude/project.md) — put architecture, conventions, and gotchas there.

        ## Folder layout

        | Path | Purpose |
        |------|---------|
        | `source/` | Meeting & email transcripts |
        | `code/` | Code / cloned repos |
        | `data/` | Documents & data files |
        | `notes/` | Generated notes |
        | `templates/` | Doc Gen templates (`<slug>/template.md`) |
        | `system/` | LLM IDE settings (mostly git-ignored) |

        ## Skills & rules (all agents)

        The central skills kit is symlinked into this project (via New Project /
        Rebuild). Each tool reads its own directory:

        | Tool | Skills | Rules / config |
        |------|--------|----------------|
        | Claude Code | `.claude/skills/` | `.claude/rules/`, `.claude/commands/`, `.claude/agents/` |
        | Cursor | `.cursor/skills/` | `.cursor/rules/` (+ this `.cursorrules`) |
        | Codex | `.codex/skills/` | `.codex/rules/`, `.codex/agents/` |
        | Open `.agents` | `.agents/skills/` | — |
        | Gemini | `.gemini/skills/` | `.gemini/rules/` |

        Prefer invoking a matching skill (e.g. `/brainstorming`, `/systematic-debugging`)
        before inventing a parallel workflow.

        ## How to work here

        1. Read `.claude/project.md` for project-specific instructions.
        2. Use skills from the tool dirs above for process / domain work.
        3. Keep changes small; put durable conventions into `.claude/project.md`.

        ---
        *Auto-generated by LLM IDE. Edit `.claude/project.md` for lasting notes;
        hand-edit this file only if you remove the `llmide:auto` marker.*
        """
    }
}
