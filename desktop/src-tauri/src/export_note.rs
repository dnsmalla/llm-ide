//! Export one note through the host's native save panel.
//!
//! The webview never supplies the destination: the user picks it in the OS dialog, exactly like
//! `attach_pick_files` chooses sources. The only file this command writes is the one the dialog returned.
//! A cancelled dialog is `Ok(None)`.

use std::path::Path;

const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// The filename shown in the save panel. It is a suggestion, never a path: separators, control
/// characters and leading dots are removed so the dialog opens on a plain Markdown name.
pub fn export_file_name(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != ':')
        .collect();
    out = out.trim().trim_start_matches('.').trim().to_string();
    if out.is_empty() {
        out = "note.md".into();
    }
    if !out.to_ascii_lowercase().ends_with(".md") {
        out.push_str(".md");
    }
    out.chars().take(120).collect()
}

/// Writes the chosen export file. Kept separate from the dialog so it is testable.
pub fn write_export(path: &Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_EXPORT_BYTES {
        return Err("The note is too large to export.".into());
    }
    // Temp file beside the target, then rename: a full disk never leaves the user's existing file truncated.
    let mut name = path.file_name().ok_or("The note could not be saved: no file name.")?.to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    let saved = std::fs::write(&tmp, text.as_bytes()).and_then(|()| std::fs::rename(&tmp, path));
    saved.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("The note could not be saved: {e}")
    })
}

#[tauri::command]
pub async fn export_note(name: String, text: String, title: Option<String>) -> Result<Option<String>, String> {
    if text.len() > MAX_EXPORT_BYTES {
        return Err("The note is too large to export.".into());
    }
    let title = title
        .map(|t| t.chars().filter(|c| !c.is_control()).take(80).collect::<String>().trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Export Meeting".into());
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title(title)
        .set_file_name(export_file_name(&name))
        .add_filter("Markdown", &["md"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    write_export(&path, &text)?;
    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_export_replaces_the_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("llmide-export-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("n.md");
        std::fs::write(&f, "old").unwrap();
        write_export(&f, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_are_plain_markdown_files() {
        assert_eq!(export_file_name("Meeting / notes"), "Meeting  notes.md");
        assert_eq!(export_file_name("  .hidden\u{0007} "), "hidden.md");
        assert_eq!(export_file_name(""), "note.md");
        assert_eq!(export_file_name("plan.MD"), "plan.MD");
    }

    #[test]
    fn writes_the_exact_text_and_refuses_oversize() {
        let dir = std::env::temp_dir().join(format!("llmide-export-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("note.md");
        write_export(&p, "# hello\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "# hello\n");
        let huge = "x".repeat(MAX_EXPORT_BYTES + 1);
        assert!(write_export(&p, &huge).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
