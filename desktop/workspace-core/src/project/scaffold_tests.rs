use super::*;
use std::fs;

/// Owns a temp folder (or marker file) and removes it on drop, so a failing test leaves nothing behind.
struct TempDirGuard(std::path::PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        let _ = std::fs::remove_file(&self.0);
    }
}

impl std::ops::Deref for TempDirGuard {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl AsRef<std::path::Path> for TempDirGuard {
    fn as_ref(&self) -> &std::path::Path {
        &self.0
    }
}

fn scratch(name: &str) -> TempDirGuard {
    let d = std::env::temp_dir().join(format!("llmide-scaf-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    TempDirGuard(fs::canonicalize(&d).unwrap())
}

/// The local home, as the desktop passes it: the breadth rules then match what the app itself refuses.
fn test_home() -> std::path::PathBuf {
    crate::paths::home_dir().map(std::path::PathBuf::from).unwrap_or_default()
}

/// `create_project` for tests that only need the new root.
fn create(parent: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    create_project(parent, name, &test_home()).map(|(root, _)| root)
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
fn create_makes_the_mac_layout_and_the_project_marker() {
    let parent = scratch("create");
    let root = create(&parent, "Alpha Project").unwrap();
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
    let root = create(&parent, "Q3 @ID@ 'Alpha' {x}").unwrap();
    let cs: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap()).unwrap();
    assert_eq!(cs["projectName"], "Q3 @ID@ 'Alpha' {x}");
    let readme = fs::read_to_string(root.join("README.md")).unwrap();
    assert!(readme.starts_with("# Q3 @ID@ 'Alpha' {x}\n"), "the name is never scanned for placeholders");
}

#[test]
fn unicode_and_long_names_work() {
    let parent = scratch("uni");
    let a = create(&parent, "\u{30d7}\u{30ed}\u{30b8}\u{30a7}\u{30af}\u{30c8} caf\u{e9}").unwrap();
    assert!(a.join("system/project.json").is_file());
    let long = "n".repeat(NAME_MAX_CHARS);
    let b = create(&parent, &long).unwrap();
    assert!(b.join("llm-doc").is_dir());
}

#[test]
fn an_existing_path_is_refused_and_left_untouched() {
    let parent = scratch("exists");
    let existing = parent.join("Mine");
    fs::create_dir_all(&existing).unwrap();
    fs::write(existing.join("keep.txt"), "precious").unwrap();
    let err = create(&parent, "Mine").unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    assert_eq!(fs::read_to_string(existing.join("keep.txt")).unwrap(), "precious");
    assert_eq!(fs::read_dir(&existing).unwrap().count(), 1, "nothing was scaffolded into it");
    // an existing FILE of that name too
    fs::write(parent.join("File"), "x").unwrap();
    assert!(create(&parent, "File").unwrap_err().contains("already exists"));
    assert_eq!(fs::read_to_string(parent.join("File")).unwrap(), "x");
}

#[cfg(unix)]
#[test]
fn an_existing_symlink_is_refused_and_a_symlinked_parent_resolves_first() {
    let parent = scratch("links");
    let elsewhere = scratch("links-target");
    std::os::unix::fs::symlink(&elsewhere, parent.join("Linked")).unwrap();
    assert!(create(&parent, "Linked").unwrap_err().contains("already exists"));
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0, "the symlink target was not touched");
    // a symlinked parent: the project lands in the real folder
    let alias = parent.join("alias");
    std::os::unix::fs::symlink(&elsewhere, &alias).unwrap();
    let root = create(&alias, "Inside").unwrap();
    assert_eq!(root, elsewhere.join("Inside"));
    // a parent that is a symlink to "/" resolves to a too-broad project root
    let to_root = parent.join("to-root");
    std::os::unix::fs::symlink("/", &to_root).unwrap();
    assert!(create(&to_root, "evil").unwrap_err().contains("too broad"));
    assert!(!Path::new("/evil").exists());
}

#[test]
fn drive_roots_are_system_trees_in_any_spelling() {
    for p in ["/", r"D:\", r"\\?\D:\", "d:/", "/etc", r"\\?\C:\", r"\\srv\share", r"\\?\UNC\srv\share\", r"\\srv"] {
        assert!(parent_is_system_tree(p), "{p}");
    }
    for p in [r"D:\work", r"\\?\D:\work", "/Users/me/code", r"\\srv\share\work", r"\\?\UNC\srv\share\work"] {
        assert!(!parent_is_system_tree(p), "{p}");
    }
}

#[test]
fn too_broad_or_unusable_parents_are_refused() {
    for p in ["/", "/etc", "/usr", "/System", "/Users", "/home"] {
        if Path::new(p).is_dir() {
            let err = create(Path::new(p), "proj").unwrap_err();
            assert!(err.contains("too broad"), "{p}: {err}");
        }
    }
    assert!(create(Path::new("/nonexistent-llmide-parent"), "proj").is_err());
    let d = scratch("notdir");
    fs::write(d.join("f"), "x").unwrap();
    assert!(create(&d.join("f"), "proj").is_err());
    // a bad name never reaches the filesystem
    assert!(create(&d, "../escape").is_err());
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
    let err = create_project_with(&parent, "Doomed", &test_home(), &boom).unwrap_err();
    assert_eq!(err, "disk full");
    assert!(!parent.join("Doomed").exists(), "the half-built folder is gone");
    assert_eq!(fs::read_to_string(parent.join("neighbour.txt")).unwrap(), "mine");
    // and the name is free again
    assert!(create(&parent, "Doomed").is_ok());
}

#[test]
fn scaffold_is_idempotent_and_never_overwrites_user_edits() {
    let parent = scratch("idem");
    let root = create(&parent, "Again").unwrap();
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
    let root = create(&parent, "Openable").unwrap();
    assert_eq!(crate::paths::validate_root(&root, &test_home()).unwrap(), root);
}

#[test]
fn ensure_scaffold_fills_an_empty_folder() {
    let root = scratch("ensure-empty");
    ensure_scaffold(&root).unwrap();
    assert!(root.join("system/project.json").is_file());
    assert!(root.join("code").is_dir());
    let marker = fs::read_to_string(root.join("system/project.json")).unwrap();
    let name = root.file_name().unwrap().to_string_lossy().into_owned();
    assert!(marker.contains(&name), "the marker carries the folder's display name: {marker}");
}

#[test]
fn ensure_scaffold_counts_a_lone_ds_store_as_empty_and_keeps_it() {
    let root = scratch("ensure-ds-store");
    fs::write(root.join(".DS_Store"), "junk").unwrap();
    ensure_scaffold(&root).unwrap();
    assert!(root.join("system/project.json").is_file());
    assert_eq!(fs::read_to_string(root.join(".DS_Store")).unwrap(), "junk");
}

#[test]
fn ensure_scaffold_leaves_a_non_empty_folder_alone() {
    let root = scratch("ensure-nonempty");
    fs::write(root.join("notes.txt"), "mine").unwrap();
    ensure_scaffold(&root).unwrap();
    assert!(!root.join("system").exists());
    assert!(!root.join("code").exists());
    assert_eq!(fs::read_to_string(root.join("notes.txt")).unwrap(), "mine");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn ensure_scaffold_keeps_an_existing_marker_byte_for_byte() {
    let root = scratch("ensure-marker");
    fs::create_dir_all(root.join("system")).unwrap();
    fs::write(root.join("system/project.json"), "{\"id\":\"keep\"}").unwrap();
    ensure_scaffold(&root).unwrap();
    assert_eq!(fs::read_to_string(root.join("system/project.json")).unwrap(), "{\"id\":\"keep\"}");
    assert!(!root.join("code").exists(), "a folder with the marker is not scaffolded on open");
}

#[test]
fn rebuild_fills_a_plain_folder_and_keeps_existing_files() {
    let root = scratch("rebuild-plain");
    fs::write(root.join("notes.txt"), b"keep me").unwrap();
    rebuild(&root).unwrap();
    assert!(root.join("system/project.json").is_file());
    assert!(root.join("system").is_dir());
    assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"keep me");
    let marker = fs::read(root.join("system/project.json")).unwrap();
    rebuild(&root).unwrap();
    assert_eq!(fs::read(root.join("system/project.json")).unwrap(), marker);
}

#[cfg(unix)]
#[test]
fn rebuild_refuses_a_linked_folder_that_leaves_the_root_and_writes_nothing() {
    let root = scratch("link-out-root");
    let outside = scratch("link-out-target");
    std::os::unix::fs::symlink(&*outside, root.join("system")).unwrap();
    let error = rebuild(&root).unwrap_err();
    assert!(error.contains("resolves outside the project root"), "{error}");
    assert_eq!(fs::read_dir(&*outside).unwrap().count(), 0, "nothing was written through the link");
    let names: Vec<_> = fs::read_dir(&*root).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["system"], "a refusal leaves no half layout behind: {names:?}");
}

#[cfg(unix)]
#[test]
fn rebuild_accepts_a_link_that_stays_inside_the_root() {
    let root = scratch("link-in-root");
    fs::create_dir_all(root.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(root.join("elsewhere"), root.join("code")).unwrap();
    rebuild(&root).unwrap();
    assert!(root.join("system/project.json").is_file());
}

#[cfg(unix)]
#[test]
fn rebuild_refuses_a_linked_template_folder_and_writes_nothing() {
    let root = scratch("link-out-template-root");
    let outside = scratch("link-out-template-target");
    fs::create_dir_all(root.join("templates")).unwrap();
    std::os::unix::fs::symlink(&*outside, root.join("templates/meeting-note")).unwrap();
    let error = rebuild(&root).unwrap_err();
    assert!(error.contains("resolves outside the project root"), "{error}");
    assert_eq!(fs::read_dir(&*outside).unwrap().count(), 0, "nothing was written through the link");
    assert!(!root.join("system").exists(), "a refusal leaves no half layout behind");
}

#[cfg(unix)]
#[test]
fn rebuild_tolerates_a_seed_file_that_is_a_link() {
    let root = scratch("seed-link-root");
    let outside = scratch("seed-link-target");
    let target = outside.join("shared.md");
    fs::write(&target, b"shared bytes").unwrap();
    std::os::unix::fs::symlink(&target, root.join("README.md")).unwrap();
    rebuild(&root).unwrap();
    assert!(root.join("system/project.json").is_file());
    assert_eq!(fs::read(&target).unwrap(), b"shared bytes", "the link was not written through");
}

#[test]
fn every_scaffolded_file_sits_in_a_checked_directory() {
    let root = scratch("checked-dirs");
    rebuild(&root).unwrap();
    // On the complete tree every folder exists, so this is exactly the file-receiving folders plus the templates.
    let checked: Vec<std::path::PathBuf> = preflight_dirs(&root).iter().map(std::path::PathBuf::from).collect();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let parent = path.parent().unwrap().strip_prefix(&*root).unwrap();
            assert!(parent.as_os_str().is_empty() || checked.iter().any(|c| c == parent), "{} sits in an unchecked folder", path.display());
        }
    }
}

#[cfg(unix)]
#[test]
fn rebuild_allows_an_outside_link_that_receives_no_write() {
    let root = scratch("link-nowrite-root");
    let outside = scratch("link-nowrite-target");
    std::os::unix::fs::symlink(&*outside, root.join("code")).unwrap();
    rebuild(&root).unwrap();
    assert!(root.join("system/project.json").is_file());
    assert_eq!(fs::read_dir(&*outside).unwrap().count(), 0, "nothing was written into the linked folder");
}

#[cfg(unix)]
#[test]
fn rebuild_refuses_a_linked_folder_that_would_receive_a_file() {
    let root = scratch("link-gitkeep-root");
    let outside = scratch("link-gitkeep-target");
    std::os::unix::fs::symlink(&*outside, root.join("data")).unwrap();
    let error = rebuild(&root).unwrap_err();
    assert!(error.contains("resolves outside the project root"), "{error}");
    assert_eq!(fs::read_dir(&*outside).unwrap().count(), 0, "no .gitkeep appeared outside");
}
