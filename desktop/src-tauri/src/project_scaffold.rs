//! New project: create `<parent>/<name>` and lay out the workspace the Mac app lays out.
//!
//! This is a faithful port of `Core/Project/ProjectScaffolder.swift` (folder list, `.gitignore` managed
//! block, `.gitkeep` markers, README, `.claude/` files, the four agent entry files, the two ingest
//! templates) plus the `system/project.json` marker `ProjectStore.ensureProjectScaffold` writes. The
//! server's skills installer refuses a folder without that marker, so it is written first.
//!
//! Security and safety:
//! - The name is untrusted text from the webview: one safe path segment, validated here (the webview
//!   check is only a convenience). No separators, no `.`/`..`, no control or bidi characters, no leading
//!   dot, no Windows-reserved names, bounded length.
//! - The parent comes from a host-run folder dialog and is canonicalised (so a symlinked parent resolves
//!   first); the resulting project root must pass the same breadth rules as opening a project.
//! - `<parent>/<name>` is reserved with a plain `create_dir`: it fails if anything (a file, a symlink, a
//!   folder) is already there, so an existing path is never touched. On any failure after that the folder
//!   this call created is removed again; nothing else is ever deleted.
//! - Files are written only when absent (`create_new`), so re-running the scaffold on a project never
//!   overwrites anything the user edited.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Longest accepted project name in characters.
pub const NAME_MAX_CHARS: usize = 80;
/// Longest accepted project name in UTF-8 bytes (a path segment is limited to 255 on common filesystems).
const NAME_MAX_BYTES: usize = 200;

/// Directories that exist under every project root (`ProjectScaffolder.requiredDirectories`).
pub const REQUIRED_DIRECTORIES: [&str; 17] = [
    "source",
    "source/meetings",
    "source/emails",
    "source/documents",
    "code",
    "data",
    "llm-doc",
    "llm-doc/plans",
    "llm-doc/loop",
    "llm-doc/generated",
    "templates",
    "commands",
    "system",
    "system/faults",
    "system/graph",
    "system/cache",
    ".claude",
];

const GITKEEP_DIRS: [&str; 7] = ["llm-doc", "llm-doc/plans", "llm-doc/loop", "data", "source/meetings", "source/emails", "source/documents"];

const WINDOWS_RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5",
    "lpt6", "lpt7", "lpt8", "lpt9",
];

fn is_bidi_or_invisible(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// Validates a project name and returns it trimmed. The result is exactly one safe path segment.
pub fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("enter a project name".into());
    }
    if name.chars().count() > NAME_MAX_CHARS || name.len() > NAME_MAX_BYTES {
        return Err(format!("the project name is too long (at most {NAME_MAX_CHARS} characters)"));
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Err("the project name cannot start with a dot".into());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("the project name cannot end with a dot or a space".into());
    }
    for c in name.chars() {
        if c.is_control() || is_bidi_or_invisible(c) {
            return Err("the project name contains a control or invisible character".into());
        }
        if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0') {
            return Err("the project name cannot contain / \\ : * ? \" < > |".into());
        }
    }
    let stem = name.split('.').next().unwrap_or("").to_lowercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        return Err("that name is reserved by the operating system".into());
    }
    Ok(name.to_string())
}

// ---- time and ids ---------------------------------------------------------------------------

/// `YYYY-MM-DDTHH:MM:SSZ` for a Unix time in seconds (UTC, no dependency).
pub fn iso8601_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // civil_from_days (Howard Hinnant), valid for the whole supported range.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Time-prefixed random id, the shape of the Mac's `RandomID.generate()` (base-32 millis + 20 hex digits).
fn random_id(now_ms: u64) -> String {
    let mut bytes = [0u8; 10];
    let _ = getrandom::fill(&mut bytes);
    let mut ts = String::new();
    let mut n = now_ms;
    if n == 0 {
        ts.push('0');
    }
    while n > 0 {
        ts.insert(0, char::from_digit((n % 32) as u32, 32).unwrap_or('0'));
        n /= 32;
    }
    let rand: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{ts}{rand}")
}

/// What the scaffold needs to know about the project (the Mac's `Project`).
pub struct NewProject {
    pub id: String,
    pub display_name: String,
    pub language: String,
    pub created_iso: String,
}

impl NewProject {
    pub fn fresh(display_name: &str) -> NewProject {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        NewProject { id: random_id(now), display_name: display_name.to_string(), language: "en".into(), created_iso: iso8601_utc(now / 1000) }
    }
}

// ---- file writing -----------------------------------------------------------------------------

/// Writes `content` only when `path` does not exist; never follows an existing symlink or replaces a file.
fn write_if_absent(path: &Path, content: &str) -> Result<(), String> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    match opts.open(path) {
        Ok(mut f) => f.write_all(content.as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("cannot write {}: {e}", path.display())),
    }
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// `system/project.json`, the shape `Project.toJSON()` writes.
fn project_json(p: &NewProject) -> String {
    format!(
        "{{\"schemaVersion\":1,\"id\":{},\"displayName\":{},\"createdAt\":{},\"settings\":{{\"language\":{}}}}}",
        json_str(&p.id),
        json_str(&p.display_name),
        json_str(&p.created_iso),
        json_str(&p.language)
    )
}

fn fill(template: &str, p: &NewProject) -> String {
    // The name is substituted last, so text inside it is never scanned for placeholders.
    template.replace("@ID@", &p.id).replace("@LANG@", &p.language.to_uppercase()).replace("@DATE@", &p.created_iso).replace("@NAME@", &p.display_name)
}

/// Scaffolds `root` (which must exist) for `project`. Idempotent: every file is written only when absent.
pub fn scaffold(root: &Path, project: &NewProject) -> Result<(), String> {
    for dir in REQUIRED_DIRECTORIES {
        fs::create_dir_all(root.join(dir)).map_err(|e| format!("cannot create {dir}: {e}"))?;
    }
    // The marker the server's skills installer requires.
    write_if_absent(&root.join("system/project.json"), &project_json(project))?;
    write_if_absent(&root.join(".gitignore"), &format!("{GITIGNORE_BLOCK}\n"))?;
    for dir in GITKEEP_DIRS {
        write_if_absent(&root.join(dir).join(".gitkeep"), "")?;
    }
    write_if_absent(&root.join("README.md"), &fill(README, project))?;
    write_if_absent(&root.join(".claude/project.md"), &fill(CLAUDE_PROJECT_MD, project))?;
    write_if_absent(&root.join(".claude/settings.json"), &claude_settings(project))?;
    write_if_absent(&root.join(".claude/README.md"), CLAUDE_DIR_README)?;
    let entry = fill(ENTRY_FILE, project);
    for name in ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules"] {
        write_if_absent(&root.join(name), &entry)?;
    }
    for (folder, body) in [("meeting-note", MEETING_TEMPLATE), ("email-note", EMAIL_TEMPLATE)] {
        let dir = root.join("templates").join(folder);
        fs::create_dir_all(&dir).map_err(|e| format!("cannot create templates/{folder}: {e}"))?;
        write_if_absent(&dir.join("template.md"), body)?;
    }
    Ok(())
}

/// `.claude/settings.json` exactly as `JSONSerialization` (pretty printed, sorted keys) writes it.
fn claude_settings(p: &NewProject) -> String {
    format!(
        "{{\n  \"agentPreferences\" : {{\n    \"contextScope\" : \"project\",\n    \"includeDocs\" : true,\n    \"includeTests\" : true\n  }},\n  \"enabledFeatures\" : {{\n    \"codeReview\" : true,\n    \"docGeneration\" : true,\n    \"issueTracking\" : true\n  }},\n  \"language\" : {},\n  \"projectName\" : {}\n}}\n",
        json_str(&p.language),
        json_str(&p.display_name)
    )
}

/// True for a canonical parent inside an operating-system tree, where a project must never be created
/// (on macOS `/etc` resolves to `/private/etc`, so the canonical form is what is checked).
fn parent_is_system_tree(real_parent: &str) -> bool {
    let w = real_parent.replace('\\', "/").to_lowercase();
    let segs: Vec<&str> = w.split('/').filter(|s| !s.is_empty()).collect();
    match segs.as_slice() {
        [] => true,
        ["etc" | "usr" | "bin" | "sbin" | "system" | "library" | "proc" | "dev" | "sys" | "boot", ..] => true,
        ["private", "etc", ..] => true,
        ["private", "var", third, ..] => !matches!(*third, "folders" | "tmp"),
        ["private", "var"] => true,
        _ => false,
    }
}

/// Creates `<parent>/<name>` and scaffolds it. Returns the canonical project root.
///
/// `parent` is canonicalised first; the new root must pass the project breadth rules. The folder is
/// reserved with `create_dir` (fails if the path exists in any form) and removed again on failure.
pub fn create_project(parent: &Path, name: &str) -> Result<PathBuf, String> {
    create_project_with(parent, name, &scaffold)
}

/// `create_project` with the scaffold step injectable (tests make it fail to prove the cleanup).
fn create_project_with(parent: &Path, name: &str, scaffold_fn: &dyn Fn(&Path, &NewProject) -> Result<(), String>) -> Result<PathBuf, String> {
    let name = validate_name(name)?;
    let real_parent = fs::canonicalize(parent).map_err(|e| format!("cannot resolve the chosen location: {e}"))?;
    if !real_parent.is_dir() {
        return Err("the chosen location is not a folder".into());
    }
    if parent_is_system_tree(&real_parent.to_string_lossy()) {
        return Err("that location is too broad to hold a project; choose a folder inside it".into());
    }
    let target = real_parent.join(&name);
    // Same breadth rules as opening a project (checked on the would-be root, before anything is created).
    let probe = target.to_string_lossy();
    if probe.contains('\0') || crate::project::is_too_broad(&probe, crate::project::home_dir().as_deref()) {
        return Err("that location is too broad to hold a project; choose a folder inside it".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err(format!("\"{name}\" already exists in that location; choose another name or location")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot inspect the chosen location: {e}")),
    }
    // The reservation: atomic, and it fails if anything appeared since the check above.
    fs::create_dir(&target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("\"{name}\" already exists in that location; choose another name or location")
        } else {
            format!("cannot create the project folder: {e}")
        }
    })?;
    let project = NewProject::fresh(&name);
    if let Err(e) = scaffold_fn(&target, &project) {
        // Only the folder this call just created (and what was written inside it) is removed.
        let _ = fs::remove_dir_all(&target);
        return Err(e);
    }
    crate::project::validate_root(&target).map_err(|e| {
        let _ = fs::remove_dir_all(&target);
        e
    })
}

// ---- generated text (ported from ProjectScaffolder.swift / IngestTemplateRenderer.swift) -------

const GITIGNORE_BLOCK: &str = "# >>> LLM-IDE managed (auto-generated / ephemeral) \u{2014} edit your own rules above
system/cache/
system/index.sqlite
system/index.sqlite-shm
system/index.sqlite-wal
system/graph/
system/sync.json
# Loop run history \u{2014} regenerated by every run; the Loop's CONTRACT
# (system/loop.json) is committed, its run log is not.
system/loop-runs/
system/loop-worktrees/
*.partial.md
# Agent skills \u{2014} relative symlinks into the LLM-IDE central kit (.skills).
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
# <<< LLM-IDE managed";

const README: &str = "# @NAME@

> Managed by **LLM-IDE** \u{2014} meeting intelligence & project control.

<!-- llmide:auto \u{2014} content below is refreshed by LLM-IDE on every project open -->

## Project Info

| Field       | Value          |
|-------------|----------------|
| ID          | `@ID@` |
| Language    | @LANG@        |
| Created     | @DATE@     |
| Linked repo | (none)    |

## Folder Structure

```
@NAME@/
\u{251c}\u{2500}\u{2500} source/     \u{2190} raw inputs (your Sources: meetings/emails/documents/\u{2026})
\u{251c}\u{2500}\u{2500} code/       \u{2190} code files
\u{251c}\u{2500}\u{2500} data/       \u{2190} documents, data files, images
\u{251c}\u{2500}\u{2500} llm-doc/    \u{2190} notes generated from meetings/email
\u{251c}\u{2500}\u{2500} templates/  \u{2190} Doc Gen templates (`<slug>/template.md`)
\u{2514}\u{2500}\u{2500} system/     \u{2190} LLM-IDE managed: settings, faults, graph, index (most git-ignored)
```

## Meetings

Meeting files land under `source/YYYY/MM/YYYY-MM-DD-<slug>-<id>.md` when
you close or export the project.  Each file has YAML frontmatter, an action
items / decisions / blockers summary, and the full transcript (fenced).

---
*Auto-generated by LLM-IDE. Add your own notes ABOVE the `<!-- llmide:auto -->` marker.*
";

const CLAUDE_PROJECT_MD: &str = "# @NAME@

> Project-specific instructions for LLM-IDE agents.
>
> Edit this file to provide context about your project, coding standards,
> architecture decisions, and any other information that helps agents
> work more effectively with your codebase.

## Project Overview

**Language:** @LANG@

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
on this project. Keep it concise and focused on actionable context.*";

const CLAUDE_DIR_README: &str = "# .claude Directory

This directory contains project-level configuration and instructions for LLM-IDE agents.

## Files

- **project.md** \u{2014} Project-specific instructions and context for agents.
  Edit this file to help agents understand your project's architecture,
  coding standards, and important conventions.

- **settings.json** \u{2014} Project-level agent preferences and feature flags.
  Controls which agent features are enabled and how they interact with
  your project.

- **skills/** / **rules/** \u{2014} Linked from the central LLM-IDE skills kit
  (Claude / Cursor / Codex share the same kit via sibling tool dirs).

## Purpose

Agents automatically load instructions from `project.md` when working on
this project, giving them project-aware context. Settings in `settings.json`
allow you to customize agent behavior per project.

## Global vs Project Settings

- **Global settings** (in LLM-IDE app Settings): Apply to all projects
- **Project settings** (this directory): Override or customize for this
  specific project

---
*Part of LLM-IDE project structure.*";

const ENTRY_FILE: &str = "# @NAME@

> Managed by **LLM-IDE**. Entry point for Claude Code, Cursor, Codex, and Gemini.
>
<!-- llmide:auto \u{2014} refreshed on New Project / Rebuild missing folders -->

## Project context

- **Name:** @NAME@
- **Language:** @LANG@
- **Editable project notes:** [`.claude/project.md`](.claude/project.md) \u{2014} put architecture, conventions, and gotchas there.

## Folder layout

| Path | Purpose |
|------|---------|
| `source/` | Raw inputs (meetings/emails/documents/\u{2026}) |
| `code/` | Code / cloned repos |
| `data/` | Documents & data files |
| `llm-doc/` | Generated notes |
| `templates/` | Doc Gen templates (`<slug>/template.md`) |
| `system/` | LLM-IDE settings (mostly git-ignored) |

## Skills & rules (all agents)

The central skills kit is symlinked into this project (via New Project /
Rebuild). Each tool reads its own directory:

| Tool | Skills | Rules / config |
|------|--------|----------------|
| Claude Code | `.claude/skills/` | `.claude/rules/`, `.claude/commands/`, `.claude/agents/` |
| Cursor | `.cursor/skills/` | `.cursor/rules/` (+ this `.cursorrules`) |
| Codex | `.codex/skills/` | `.codex/rules/`, `.codex/agents/` |
| Open `.agents` | `.agents/skills/` | \u{2014} |
| Gemini | `.gemini/skills/` | `.gemini/rules/` |

Prefer invoking a matching skill (e.g. `/brainstorming`, `/systematic-debugging`)
before inventing a parallel workflow.

## How to work here

1. Read `.claude/project.md` for project-specific instructions.
2. Use skills from the tool dirs above for process / domain work.
3. Keep changes small; put durable conventions into `.claude/project.md`.

---
*Auto-generated by LLM-IDE. Edit `.claude/project.md` for lasting notes;
hand-edit this file only if you remove the `llmide:auto` marker.*";

const MEETING_TEMPLATE: &str = "---
source: meeting
title: \"{{title_yaml}}\"
date: {{date}}
rawFile: {{raw_file}}
---

# {{title}}

<!-- llmide:ingest-template source=meeting -->

## Summary

{{gist}}

## Action items

{{actions}}";

const EMAIL_TEMPLATE: &str = "---
source: email
platform: email
from: \"{{from_yaml}}\"
date: {{date}}
category: {{category}}
noteWorthy: {{note_worthy}}
sourceHash: \"{{source_hash}}\"
rawFile: {{raw_file}}
todos:
{{todos_yaml}}
---

# {{subject}}

<!-- llmide:ingest-template source=email -->

## Summary

{{summary}}

## To-dos

{{todos}}";

#[cfg(test)]
#[path = "project_scaffold_tests.rs"]
mod tests;
