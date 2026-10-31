use super::*;
use std::fs;

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("llmide-scaf-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    fs::canonicalize(&d).unwrap()
}

#[test]
fn names_must_be_one_safe_segment() {
    for bad in [
        "", "   ", ".", "..", "../x", "a/b", "a\\b", ".hidden", "x.", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\0b", "a\nb", "a\tb",
        "con", "NUL", "com1.txt", "LPT9", "evil\u{202e}gpj.exe", "zero\u{200b}width", "iso\u{2066}late", "\u{feff}bom",
    ] {
        assert!(validate_name(bad).is_err(), "{bad:?} must be refused");
    }
    assert!(validate_name(&"a".repeat(NAME_MAX_CHARS + 1)).is_err());
    assert!(validate_name(&"\u{3042}".repeat(NAME_MAX_CHARS)).is_err(), "byte cap applies to wide characters");
    assert_eq!(validate_name("  My Project 2  ").unwrap(), "My Project 2");
    assert_eq!(validate_name("\u{30d7}\u{30ed}\u{30b8}\u{30a7}\u{30af}\u{30c8}").unwrap(), "\u{30d7}\u{30ed}\u{30b8}\u{30a7}\u{30af}\u{30c8}");
    assert_eq!(validate_name(&"a".repeat(NAME_MAX_CHARS)).unwrap().len(), NAME_MAX_CHARS);
    assert_eq!(validate_name("naive caf\u{e9} - v1.2").unwrap(), "naive caf\u{e9} - v1.2");
}

#[test]
fn iso_dates_are_utc_and_exact() {
    assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(iso8601_utc(1_793_448_000), "2026-10-31T12:00:00Z");
    assert_eq!(iso8601_utc(1_709_251_199), "2024-02-29T23:59:59Z");
}

#[test]
fn create_makes_the_mac_layout_and_the_project_marker() {
    let parent = scratch("create");
    let root = create_project(&parent, "Alpha Project").unwrap();
    assert_eq!(root, parent.join("Alpha Project"));
    for d in REQUIRED_DIRECTORIES {
        assert!(root.join(d).is_dir(), "{d} missing");
    }
    for d in GITKEEP_DIRS {
        assert!(root.join(d).join(".gitkeep").is_file(), "{d}/.gitkeep missing");
    }
    for f in ["README.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".gitignore", ".claude/project.md", ".claude/settings.json", ".claude/README.md", "templates/meeting-note/template.md", "templates/email-note/template.md"] {
        assert!(root.join(f).is_file(), "{f} missing");
    }
    // the marker the skills installer needs parses and carries the name
    let pj: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join("system/project.json")).unwrap()).unwrap();
    assert_eq!(pj["schemaVersion"], 1);
    assert_eq!(pj["displayName"], "Alpha Project");
    assert!(pj["id"].as_str().unwrap().len() >= 20);
    assert!(pj["createdAt"].as_str().unwrap().ends_with('Z'));
    // the settings file is valid JSON (the Mac once shipped a name that broke it)
    let cs: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap()).unwrap();
    assert_eq!(cs["projectName"], "Alpha Project");
    let readme = fs::read_to_string(root.join("README.md")).unwrap();
    assert!(readme.starts_with("# Alpha Project\n"));
    assert!(readme.contains("<!-- llmide:auto"));
    assert!(!readme.contains("@NAME@") && !readme.contains("@ID@") && !readme.contains("@LANG@") && !readme.contains("@DATE@"));
    let ignore = fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(ignore.contains("# >>> LLM-IDE managed") && ignore.trim_end().ends_with("# <<< LLM-IDE managed"));
    assert!(ignore.contains("system/loop-runs/") && !ignore.contains("system/loop.json\n"));
    let claude = fs::read_to_string(root.join("CLAUDE.md")).unwrap();
    assert_eq!(claude, fs::read_to_string(root.join("AGENTS.md")).unwrap());
    assert!(claude.contains("<!-- llmide:auto"));
    assert!(fs::read_to_string(root.join("templates/email-note/template.md")).unwrap().contains("{{todos_yaml}}"));
    // no temp leftovers next to it
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[test]
fn a_name_with_json_and_placeholder_text_stays_inert() {
    let parent = scratch("inert");
    let root = create_project(&parent, "Q3 @ID@ 'Alpha' {x}").unwrap();
    let cs: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap()).unwrap();
    assert_eq!(cs["projectName"], "Q3 @ID@ 'Alpha' {x}");
    let readme = fs::read_to_string(root.join("README.md")).unwrap();
    assert!(readme.starts_with("# Q3 @ID@ 'Alpha' {x}\n"), "the name is never scanned for placeholders");
}

#[test]
fn unicode_and_long_names_work() {
    let parent = scratch("uni");
    let a = create_project(&parent, "\u{30d7}\u{30ed}\u{30b8}\u{30a7}\u{30af}\u{30c8} caf\u{e9}").unwrap();
    assert!(a.join("system/project.json").is_file());
    let long = "n".repeat(NAME_MAX_CHARS);
    let b = create_project(&parent, &long).unwrap();
    assert!(b.join("llm-doc").is_dir());
}

#[test]
fn an_existing_path_is_refused_and_left_untouched() {
    let parent = scratch("exists");
    let existing = parent.join("Mine");
    fs::create_dir_all(&existing).unwrap();
    fs::write(existing.join("keep.txt"), "precious").unwrap();
    let err = create_project(&parent, "Mine").unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    assert_eq!(fs::read_to_string(existing.join("keep.txt")).unwrap(), "precious");
    assert_eq!(fs::read_dir(&existing).unwrap().count(), 1, "nothing was scaffolded into it");
    // an existing FILE of that name too
    fs::write(parent.join("File"), "x").unwrap();
    assert!(create_project(&parent, "File").unwrap_err().contains("already exists"));
    assert_eq!(fs::read_to_string(parent.join("File")).unwrap(), "x");
}

#[cfg(unix)]
#[test]
fn an_existing_symlink_is_refused_and_a_symlinked_parent_resolves_first() {
    let parent = scratch("links");
    let elsewhere = scratch("links-target");
    std::os::unix::fs::symlink(&elsewhere, parent.join("Linked")).unwrap();
    assert!(create_project(&parent, "Linked").unwrap_err().contains("already exists"));
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0, "the symlink target was not touched");
    // a symlinked parent: the project lands in the real folder
    let alias = parent.join("alias");
    std::os::unix::fs::symlink(&elsewhere, &alias).unwrap();
    let root = create_project(&alias, "Inside").unwrap();
    assert_eq!(root, elsewhere.join("Inside"));
    // a parent that is a symlink to "/" resolves to a too-broad project root
    let to_root = parent.join("to-root");
    std::os::unix::fs::symlink("/", &to_root).unwrap();
    assert!(create_project(&to_root, "evil").unwrap_err().contains("too broad"));
    assert!(!Path::new("/evil").exists());
}

#[test]
fn too_broad_or_unusable_parents_are_refused() {
    for p in ["/", "/etc", "/usr", "/System", "/Users", "/home"] {
        if Path::new(p).is_dir() {
            let err = create_project(Path::new(p), "proj").unwrap_err();
            assert!(err.contains("too broad"), "{p}: {err}");
        }
    }
    assert!(create_project(Path::new("/nonexistent-llmide-parent"), "proj").is_err());
    let d = scratch("notdir");
    fs::write(d.join("f"), "x").unwrap();
    assert!(create_project(&d.join("f"), "proj").is_err());
    // a bad name never reaches the filesystem
    assert!(create_project(&d, "../escape").is_err());
    assert!(!d.parent().unwrap().join("escape").exists());
}

#[test]
fn a_failed_scaffold_removes_only_the_folder_this_call_created() {
    let parent = scratch("cleanup");
    fs::write(parent.join("neighbour.txt"), "mine").unwrap();
    let boom = |root: &Path, _: &NewProject| -> Result<(), String> {
        fs::create_dir_all(root.join("system")).unwrap();
        fs::write(root.join("system/partial"), "x").unwrap();
        Err("disk full".into())
    };
    let err = create_project_with(&parent, "Doomed", &boom).unwrap_err();
    assert_eq!(err, "disk full");
    assert!(!parent.join("Doomed").exists(), "the half-built folder is gone");
    assert_eq!(fs::read_to_string(parent.join("neighbour.txt")).unwrap(), "mine");
    // and the name is free again
    assert!(create_project(&parent, "Doomed").is_ok());
}

#[test]
fn scaffold_is_idempotent_and_never_overwrites_user_edits() {
    let parent = scratch("idem");
    let root = create_project(&parent, "Again").unwrap();
    fs::write(root.join("README.md"), "my own readme").unwrap();
    fs::write(root.join("CLAUDE.md"), "my rules").unwrap();
    fs::write(root.join("system/project.json"), "{\"id\":\"keep\"}").unwrap();
    scaffold(&root, &NewProject::fresh("Again")).unwrap();
    assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "my own readme");
    assert_eq!(fs::read_to_string(root.join("CLAUDE.md")).unwrap(), "my rules");
    assert_eq!(fs::read_to_string(root.join("system/project.json")).unwrap(), "{\"id\":\"keep\"}");
    assert!(root.join("AGENTS.md").is_file());
}

#[test]
fn the_new_root_opens_as_a_project() {
    let parent = scratch("opens");
    let root = create_project(&parent, "Openable").unwrap();
    assert_eq!(crate::project::validate_root(&root).unwrap(), root);
}
