//! Write side of the Library notes folder (S-I): open-for-edit, save, create, rename and
//! delete-to-trash for NOTE FILES inside the validated notes root of `notes_fs`.
//!
//! The hardening is `fs_ops`' (this module delegates the byte-level work to it, with the notes
//! root in place of the project root) plus note-specific rules:
//!
//! - Same root as the read side: `notes_fs::current_root()` (chosen by the host dialog, re-
//!   canonicalised and re-checked against the too-broad list on every call). The webview only
//!   sends RELATIVE paths; every path is lexically validated, canonicalised and must stay inside.
//! - Only note files: the last segment must be `*.md|*.markdown|*.txt` (not `.partial.md`), no
//!   segment may be hidden (`.x`) or `node_modules` (the lister skips those, so a note written
//!   there would be invisible). Folders are never renamed or deleted here.
//! - Save is atomic and optimistic: temp file in the same directory, fsync, rename, directory
//!   fsync. The caller sends the SHA-256 (hex) of the exact bytes it read (`note_open`); a different
//!   hash on disk is `conflict`. Create never overwrites (`exists`). Missing parent folders of a
//!   new note are created one level at a time (`create_dir`, never following a link), each
//!   re-verified inside the root.
//! - Delete moves to the OS trash through an injected `Trasher` and NEVER falls back to a
//!   permanent delete (`trash_unavailable`). A final symlink is trashed as the link, never its
//!   target. Tests inject a fake trasher, so no test touches the real Trash.
//! - A file that is not valid UTF-8 is refused for editing (`not_utf8`) rather than lossy-decoded
//!   and then written back corrupted. A leading BOM is reported (`bom`) and restored on save.
//! - Bounded: edit size (`EDIT_MAX_BYTES`), items per bulk delete (`BULK_MAX`), folder depth.
//!
//! Errors are strings `code: detail`; codes: `no_root`, `invalid_root`, `outside_root`,
//! `not_found`, `not_downloaded`, `too_large`, `invalid_path`, `not_note`, `not_utf8`,
//! `conflict`, `exists`, `hardlink`, `not_regular`, `trash_unavailable`, `permission_denied`, `io`.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::fs_ops;
use crate::notes_fs;

/// Largest note the editor opens or saves.
pub const EDIT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Items per `notes_delete_many` call (the webview chunks larger selections).
pub const BULK_MAX: usize = 200;
const MAX_DEPTH: usize = 24;

fn err(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

fn from_fs(e: fs_ops::FsError) -> String {
    err(e.code, e.message)
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// ---- types -----------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct OpenedNote {
    pub rel: String,
    /// The whole file as text, without a leading BOM. Line endings are exactly the file's.
    pub text: String,
    /// SHA-256 (hex) of the raw bytes: send it back as `expected_hash` when saving.
    pub hash: String,
    pub bom: bool,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SavedNote {
    pub rel: String,
    pub hash: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Deserialize, Debug)]
pub struct SaveReq {
    pub rel: String,
    pub text: String,
    #[serde(default)]
    pub bom: bool,
    /// Hash from `note_open` / the previous save. Required: a save never overwrites blindly.
    pub expected_hash: String,
    /// "Keep mine" after a conflict: overwrite whatever is on disk.
    #[serde(default)]
    pub force: bool,
}

#[derive(Deserialize, Debug)]
pub struct CreateReq {
    pub rel: String,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DeleteOutcome {
    pub rel: String,
    pub ok: bool,
    pub error: Option<String>,
}

// ---- trash seam ------------------------------------------------------------------------------

pub trait Trasher {
    fn trash(&self, path: &Path) -> Result<(), String>;
}

/// The real OS trash. Never a permanent delete.
pub struct OsTrash;

impl Trasher for OsTrash {
    fn trash(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|e| err("trash_unavailable", format!("cannot move to trash: {e}")))
    }
}

// ---- validation ------------------------------------------------------------------------------

fn segments(rel: &str) -> Result<Vec<&str>, String> {
    let segs = fs_ops::split_rel(rel).map_err(from_fs)?;
    if segs.is_empty() || segs.len() > MAX_DEPTH + 1 || rel.starts_with('/') || segs.iter().any(|s| s.contains(':')) {
        return Err(err("invalid_path", "not a relative notes path"));
    }
    Ok(segs)
}

/// A note path: all segments visible and not `node_modules`, the last one a note file name.
fn note_segments(rel: &str) -> Result<Vec<&str>, String> {
    let segs = segments(rel)?;
    if segs.iter().any(|s| s.starts_with('.') || *s == "node_modules") {
        return Err(err("not_note", "hidden files and folders are not part of the Library"));
    }
    let (name, dirs) = segs.split_last().expect("non-empty");
    for d in dirs {
        fs_ops::valid_name(d).map_err(from_fs)?;
    }
    fs_ops::valid_name(name).map_err(from_fs)?;
    if !notes_fs::is_note_name(name) {
        return Err(err("not_note", "a note file ends in .md, .markdown or .txt"));
    }
    Ok(segs)
}

fn join(root: &Path, segs: &[&str]) -> PathBuf {
    let mut p = root.to_path_buf();
    for s in segs {
        p.push(s);
    }
    p
}

fn mtime(m: &std::fs::Metadata) -> i64 {
    notes_fs::mtime_ms(m)
}

/// The entry for `rel` WITHOUT resolving a final symlink: canonical parent (inside the root) +
/// name. Used by rename and delete so a link is moved/trashed itself, never its target.
fn entry_path(root: &Path, segs: &[&str]) -> Result<PathBuf, String> {
    let (name, dirs) = segs.split_last().expect("non-empty");
    let parent = std::fs::canonicalize(join(root, dirs)).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => err("not_found", "folder not found"),
        _ => err("io", format!("cannot resolve folder: {e}")),
    })?;
    if !parent.starts_with(root) {
        return Err(err("outside_root", "path is outside the notes folder"));
    }
    Ok(parent.join(name))
}

// ---- open ------------------------------------------------------------------------------------

/// Reads a whole note for editing.
pub fn open_note(root: &Path, rel: &str) -> Result<OpenedNote, String> {
    note_segments(rel)?;
    let (file, meta) = notes_fs::open_in_root(root, rel)?;
    if meta.len() > EDIT_MAX_BYTES {
        return Err(err("too_large", format!("{} bytes (editing is limited to {EDIT_MAX_BYTES})", meta.len())));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err(err("hardlink", "file has several hard links; refusing to edit it"));
        }
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // `take` bounds the read even if the file grows after fstat.
    file.take(EDIT_MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| err("io", format!("read failed: {e}")))?;
    if bytes.len() as u64 > EDIT_MAX_BYTES {
        return Err(err("too_large", "file grew while reading"));
    }
    let hash = sha_hex(&bytes);
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if bom { &bytes[3..] } else { &bytes[..] };
    let text = std::str::from_utf8(body).map_err(|_| err("not_utf8", "the note is not valid UTF-8 text"))?.to_string();
    Ok(OpenedNote { rel: rel.to_string(), text, hash, bom, size: bytes.len() as u64, mtime_ms: mtime(&meta) })
}

// ---- save / create ---------------------------------------------------------------------------

fn check_text(text: &str) -> Result<(), String> {
    if text.len() as u64 > EDIT_MAX_BYTES {
        return Err(err("too_large", "the note is too large to save from the editor"));
    }
    if text.contains('\0') {
        return Err(err("invalid_path", "a note cannot contain NUL characters"));
    }
    Ok(())
}

fn saved(root: &Path, rel: &str, r: fs_ops::WriteResult) -> SavedNote {
    let _ = root;
    SavedNote { rel: rel.to_string(), hash: r.hash, size: r.size, mtime_ms: r.mtime_ms as i64 }
}

/// Saves an existing note (compare-and-swap on `expected_hash`).
pub fn save_note(root: &Path, req: &SaveReq) -> Result<SavedNote, String> {
    note_segments(&req.rel)?;
    check_text(&req.text)?;
    if req.expected_hash.len() != 64 || !req.expected_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err("invalid_path", "expected_hash must be the hash returned when the note was opened"));
    }
    // The file must exist, be a real downloaded regular file, and be small enough to be a note.
    let (_f, meta) = notes_fs::open_in_root(root, &req.rel)?;
    if meta.len() > EDIT_MAX_BYTES {
        return Err(err("too_large", "the note on disk is too large to edit"));
    }
    drop(_f);
    let r = fs_ops::write_file(
        root,
        &fs_ops::WriteReq {
            path: req.rel.clone(),
            text: req.text.clone(),
            encoding: "utf-8".into(),
            bom: req.bom,
            expected_hash: Some(req.expected_hash.clone()),
            force: req.force,
        },
    )
    .map_err(from_fs)?;
    Ok(saved(root, &req.rel, r))
}

/// Creates the missing folders of `segs[..n-1]` one level at a time, each verified inside `root`.
fn ensure_parents(root: &Path, dirs: &[&str]) -> Result<(), String> {
    let mut cur = root.to_path_buf();
    for d in dirs {
        cur.push(d);
        match std::fs::symlink_metadata(&cur) {
            Ok(m) if m.is_dir() => {}
            Ok(m) if m.file_type().is_symlink() => {
                // An existing link is fine only if it resolves to a folder INSIDE the root.
                let real = std::fs::canonicalize(&cur).map_err(|e| err("io", e))?;
                if !real.starts_with(root) || !real.is_dir() {
                    return Err(err("outside_root", "a folder in the path resolves outside the notes folder"));
                }
            }
            Ok(_) => return Err(err("invalid_path", format!("{d} is a file, not a folder"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&cur).map_err(|e| err("io", format!("cannot create folder: {e}")))?;
            }
            Err(e) => return Err(err("io", e)),
        }
        let real = std::fs::canonicalize(&cur).map_err(|e| err("io", e))?;
        if !real.starts_with(root) {
            return Err(err("outside_root", "a folder in the path resolves outside the notes folder"));
        }
    }
    Ok(())
}

/// Creates a new note; never overwrites (`exists`). Missing folders are created.
pub fn create_note(root: &Path, req: &CreateReq) -> Result<SavedNote, String> {
    let segs = note_segments(&req.rel)?;
    check_text(&req.text)?;
    let (_name, dirs) = segs.split_last().expect("non-empty");
    // Refuse early (and without creating folders) when the note is already there.
    if std::fs::symlink_metadata(join(root, &segs)).is_ok() {
        return Err(err("exists", "a note with that name already exists"));
    }
    ensure_parents(root, dirs)?;
    let r = fs_ops::write_file(
        root,
        &fs_ops::WriteReq { path: req.rel.clone(), text: req.text.clone(), encoding: "utf-8".into(), bom: false, expected_hash: None, force: false },
    )
    .map_err(from_fs)?;
    Ok(saved(root, &req.rel, r))
}

// ---- rename / delete -------------------------------------------------------------------------

/// Renames (or moves, inside the notes folder) one note file. Never overwrites; the extension
/// must stay a note extension.
pub fn rename_note(root: &Path, from: &str, to: &str) -> Result<String, String> {
    let fsegs = note_segments(from)?;
    let tsegs = note_segments(to)?;
    let src = entry_path(root, &fsegs)?;
    let m = std::fs::symlink_metadata(&src).map_err(|_| err("not_found", from))?;
    if !m.is_file() {
        return Err(err("not_regular", "only note files can be renamed here"));
    }
    ensure_parents(root, &tsegs[..tsegs.len() - 1])?;
    fs_ops::rename(root, &fs_ops::RenameReq { from: from.to_string(), to: to.to_string() }).map_err(from_fs)
}

/// Moves one note to the trash through `trasher`.
pub fn delete_note(root: &Path, rel: &str, trasher: &dyn Trasher) -> Result<(), String> {
    let segs = note_segments(rel)?;
    let target = entry_path(root, &segs)?;
    let m = std::fs::symlink_metadata(&target).map_err(|_| err("not_found", rel))?;
    if !m.is_file() && !m.file_type().is_symlink() {
        return Err(err("not_regular", "only note files can be deleted here"));
    }
    trasher.trash(&target)
}

/// Moves up to `BULK_MAX` notes to the trash; one failure does not stop the rest.
pub fn delete_many(root: &Path, rels: &[String], trasher: &dyn Trasher) -> Result<Vec<DeleteOutcome>, String> {
    if rels.len() > BULK_MAX {
        return Err(err("invalid_path", format!("at most {BULK_MAX} notes per call")));
    }
    Ok(rels
        .iter()
        .map(|rel| match delete_note(root, rel, trasher) {
            Ok(()) => DeleteOutcome { rel: rel.clone(), ok: true, error: None },
            Err(e) => DeleteOutcome { rel: rel.clone(), ok: false, error: Some(e) },
        })
        .collect())
}

// ---- commands --------------------------------------------------------------------------------

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let root = notes_fs::canonical_root(&notes_fs::current_root()?)?;
        f(root)
    })
    .await
    .map_err(|e| err("io", format!("notes task failed: {e}")))?
}

#[tauri::command]
pub async fn note_open(rel: String) -> Result<OpenedNote, String> {
    blocking(move |root| open_note(&root, &rel)).await
}

#[tauri::command]
pub async fn note_save(req: SaveReq) -> Result<SavedNote, String> {
    blocking(move |root| save_note(&root, &req)).await
}

#[tauri::command]
pub async fn note_create(req: CreateReq) -> Result<SavedNote, String> {
    blocking(move |root| create_note(&root, &req)).await
}

#[tauri::command]
pub async fn note_rename(from: String, to: String) -> Result<String, String> {
    blocking(move |root| rename_note(&root, &from, &to)).await
}

#[tauri::command]
pub async fn notes_delete_many(rels: Vec<String>) -> Result<Vec<DeleteOutcome>, String> {
    blocking(move |root| delete_many(&root, &rels, &OsTrash)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-nw-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    /// Moves the file into a scratch "trash" folder; the real Trash is never used.
    struct FakeTrash {
        dir: PathBuf,
        calls: RefCell<Vec<PathBuf>>,
        fail: bool,
    }
    impl FakeTrash {
        fn new(dir: &Path) -> Self {
            let d = dir.join("fake-trash");
            fs::create_dir_all(&d).unwrap();
            FakeTrash { dir: d, calls: RefCell::new(vec![]), fail: false }
        }
    }
    impl Trasher for FakeTrash {
        fn trash(&self, p: &Path) -> Result<(), String> {
            self.calls.borrow_mut().push(p.to_path_buf());
            if self.fail {
                return Err(err("trash_unavailable", "no trash here"));
            }
            let n = self.calls.borrow().len();
            fs::rename(p, self.dir.join(format!("{n}-{}", p.file_name().unwrap().to_string_lossy()))).map_err(|e| err("io", e))
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, String>) -> String {
        r.unwrap_err().split(':').next().unwrap().to_string()
    }
    fn create(root: &Path, rel: &str, text: &str) -> SavedNote {
        create_note(root, &CreateReq { rel: rel.into(), text: text.into() }).unwrap()
    }
    fn save(root: &Path, rel: &str, text: &str, hash: &str) -> Result<SavedNote, String> {
        save_note(root, &SaveReq { rel: rel.into(), text: text.into(), bom: false, expected_hash: hash.into(), force: false })
    }

    #[test]
    fn create_open_save_round_trip_is_byte_exact() {
        let root = scratch("rt");
        let text = "---\r\ntitle: Caf\u{e9} \u{65e5}\u{672c}\u{8a9e}\r\nx-unknown: keep\r\n---\r\n\r\nBody \u{1f600}\r\nline2\r\n";
        let c = create(&root, "a/b/n.md", text);
        assert_eq!(fs::read(root.join("a/b/n.md")).unwrap(), text.as_bytes());
        let o = open_note(&root, "a/b/n.md").unwrap();
        assert_eq!(o.text, text, "CRLF and unicode survive the host");
        assert_eq!(o.hash, c.hash);
        assert!(!o.bom);
        let s = save(&root, "a/b/n.md", &format!("{text}more\r\n"), &o.hash).unwrap();
        assert_ne!(s.hash, o.hash);
        assert_eq!(fs::read(root.join("a/b/n.md")).unwrap(), format!("{text}more\r\n").as_bytes());
        // The returned hash is the one the next save must present.
        assert!(save(&root, "a/b/n.md", "x", &s.hash).is_ok());
    }

    #[test]
    fn bom_is_reported_and_restored() {
        let root = scratch("bom");
        fs::write(root.join("n.md"), b"\xEF\xBB\xBFhello\n").unwrap();
        let o = open_note(&root, "n.md").unwrap();
        assert!(o.bom);
        assert_eq!(o.text, "hello\n");
        let s = save_note(&root, &SaveReq { rel: "n.md".into(), text: "hello2\n".into(), bom: true, expected_hash: o.hash, force: false }).unwrap();
        assert_eq!(fs::read(root.join("n.md")).unwrap(), b"\xEF\xBB\xBFhello2\n");
        assert_eq!(s.size, 10);
    }

    #[test]
    fn non_utf8_is_refused_not_corrupted() {
        let root = scratch("bin");
        fs::write(root.join("n.md"), b"ok \xFF\xFE bad\n").unwrap();
        assert_eq!(code(open_note(&root, "n.md")), "not_utf8");
        assert_eq!(fs::read(root.join("n.md")).unwrap(), b"ok \xFF\xFE bad\n");
    }

    #[test]
    fn cas_conflict_and_force() {
        let root = scratch("cas");
        let c = create(&root, "n.md", "one\n");
        fs::write(root.join("n.md"), "changed elsewhere\n").unwrap();
        assert_eq!(code(save(&root, "n.md", "mine\n", &c.hash)), "conflict");
        assert_eq!(fs::read_to_string(root.join("n.md")).unwrap(), "changed elsewhere\n");
        let r = save_note(&root, &SaveReq { rel: "n.md".into(), text: "mine\n".into(), bom: false, expected_hash: c.hash, force: true }).unwrap();
        assert_eq!(fs::read_to_string(root.join("n.md")).unwrap(), "mine\n");
        assert_eq!(r.size, 5);
        // A bad hash is refused up front, not treated as "no hash".
        assert_eq!(code(save(&root, "n.md", "x", "")), "invalid_path");
        assert_eq!(code(save(&root, "n.md", "x", "zz")), "invalid_path");
    }

    #[test]
    fn save_of_a_deleted_note_is_not_found_and_does_not_recreate() {
        let root = scratch("gone");
        let c = create(&root, "n.md", "one\n");
        fs::remove_file(root.join("n.md")).unwrap();
        assert_eq!(code(save(&root, "n.md", "x", &c.hash)), "not_found");
        assert!(!root.join("n.md").exists());
    }

    #[test]
    fn create_never_overwrites() {
        let root = scratch("excl");
        create(&root, "n.md", "one\n");
        assert_eq!(code(create_note(&root, &CreateReq { rel: "n.md".into(), text: "two\n".into() })), "exists");
        assert_eq!(fs::read_to_string(root.join("n.md")).unwrap(), "one\n");
        // Even a dangling symlink at the name counts as "exists".
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("nowhere"), root.join("l.md")).unwrap();
            assert_eq!(code(create_note(&root, &CreateReq { rel: "l.md".into(), text: "x".into() })), "exists");
            assert!(!root.join("nowhere").exists());
        }
    }

    #[test]
    fn traversal_and_non_note_paths_are_refused() {
        let root = scratch("trav");
        for bad in ["../x.md", "a/../b.md", "/etc/x.md", "a//b.md", "a\\b.md", "a\0b.md", "C:/x.md", "a/b:c.md"] {
            assert_eq!(code(create_note(&root, &CreateReq { rel: bad.into(), text: "x".into() })), "invalid_path", "{bad:?}");
            assert_eq!(code(open_note(&root, bad)), "invalid_path", "{bad:?}");
        }
        for bad in ["x.exe", "x", ".hidden.md", "a/.git/x.md", "node_modules/x.md", "x.partial.md", ".md"] {
            let c = code(create_note(&root, &CreateReq { rel: bad.into(), text: "x".into() }));
            assert_eq!(c, "not_note", "{bad:?}");
        }
        assert_eq!(code(create_note(&root, &CreateReq { rel: "a.md".into(), text: "x\0y".into() })), "invalid_path");
        assert!(fs::read_dir(&root).unwrap().next().is_none(), "nothing was created");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escapes_are_refused() {
        let root = scratch("esc");
        let outside = scratch("esc-out");
        fs::write(outside.join("secret.md"), "top secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), root.join("f.md")).unwrap();
        // Folder link out of the root: open, create and mkdir-through all refuse.
        assert_eq!(code(open_note(&root, "link/secret.md")), "outside_root");
        assert_eq!(code(create_note(&root, &CreateReq { rel: "link/new.md".into(), text: "x".into() })), "outside_root");
        assert_eq!(code(create_note(&root, &CreateReq { rel: "link/sub/new.md".into(), text: "x".into() })), "outside_root");
        assert!(!outside.join("new.md").exists() && !outside.join("sub").exists());
        // File link out of the root: cannot be opened or written through.
        assert_eq!(code(open_note(&root, "f.md")), "outside_root");
        let h = sha_hex(b"top secret\n");
        assert!(save(&root, "f.md", "pwned\n", &h).is_err());
        assert_eq!(fs::read_to_string(outside.join("secret.md")).unwrap(), "top secret\n");
        // Rename out through a folder link.
        create(&root, "m.md", "m\n");
        assert_eq!(code(rename_note(&root, "m.md", "link/m.md")), "outside_root");
        assert!(!outside.join("m.md").exists());
        // Delete trashes the LINK, not the target.
        let t = FakeTrash::new(&root);
        delete_note(&root, "f.md", &t).unwrap();
        assert!(outside.join("secret.md").exists());
        assert_eq!(t.calls.borrow()[0], root.join("f.md"));
    }

    #[test]
    fn delete_goes_to_the_injected_trash_and_never_permanently() {
        let root = scratch("del");
        create(&root, "n.md", "x\n");
        let t = FakeTrash::new(&root);
        delete_note(&root, "n.md", &t).unwrap();
        assert!(!root.join("n.md").exists());
        assert_eq!(fs::read_to_string(t.dir.join("1-n.md")).unwrap(), "x\n");
        // Trash unavailable: the file is still there (no permanent-delete fallback).
        create(&root, "k.md", "keep\n");
        let bad = FakeTrash { fail: true, ..FakeTrash::new(&root) };
        assert_eq!(code(delete_note(&root, "k.md", &bad)), "trash_unavailable");
        assert_eq!(fs::read_to_string(root.join("k.md")).unwrap(), "keep\n");
        // Missing, folders and non-notes.
        assert_eq!(code(delete_note(&root, "nope.md", &t)), "not_found");
        fs::create_dir(root.join("dir.md")).unwrap();
        assert_eq!(code(delete_note(&root, "dir.md", &t)), "not_regular");
        assert_eq!(code(delete_note(&root, "../x.md", &t)), "invalid_path");
        assert_eq!(code(delete_note(&root, "x.png", &t)), "not_note");
    }

    #[test]
    fn bulk_delete_isolates_failures_and_is_bounded() {
        let root = scratch("bulk");
        for i in 0..5 {
            create(&root, &format!("n{i}.md"), "x\n");
        }
        let t = FakeTrash::new(&root);
        let rels: Vec<String> = ["n0.md", "missing.md", "n1.md", "../out.md", "n2.md"].iter().map(|s| s.to_string()).collect();
        let out = delete_many(&root, &rels, &t).unwrap();
        assert_eq!(out.iter().map(|o| o.ok).collect::<Vec<_>>(), vec![true, false, true, false, true]);
        assert!(out[1].error.as_deref().unwrap().starts_with("not_found"));
        assert!(root.join("n3.md").exists() && root.join("n4.md").exists());
        let many: Vec<String> = (0..BULK_MAX + 1).map(|i| format!("n{i}.md")).collect();
        assert_eq!(code(delete_many(&root, &many, &t)), "invalid_path");
    }

    #[test]
    fn rename_never_overwrites_and_keeps_note_names() {
        let root = scratch("ren");
        create(&root, "a.md", "A\n");
        create(&root, "b.md", "B\n");
        assert_eq!(code(rename_note(&root, "a.md", "b.md")), "exists");
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "B\n");
        assert_eq!(code(rename_note(&root, "a.md", "a.png")), "not_note");
        assert_eq!(rename_note(&root, "a.md", "sub/dir/c.md").unwrap(), "sub/dir/c.md");
        assert_eq!(fs::read_to_string(root.join("sub/dir/c.md")).unwrap(), "A\n");
        assert_eq!(code(rename_note(&root, "gone.md", "x.md")), "not_found");
        fs::create_dir(root.join("d.md")).unwrap();
        assert_eq!(code(rename_note(&root, "d.md", "e.md")), "not_regular");
    }

    #[test]
    fn size_limits_apply() {
        let root = scratch("big");
        let big = "x".repeat(EDIT_MAX_BYTES as usize + 1);
        assert_eq!(code(create_note(&root, &CreateReq { rel: "b.md".into(), text: big })), "too_large");
        let f = fs::File::create(root.join("huge.md")).unwrap();
        f.set_len(EDIT_MAX_BYTES + 1).unwrap();
        assert_eq!(code(open_note(&root, "huge.md")), "too_large");
    }

    #[cfg(unix)]
    #[test]
    fn hard_linked_notes_are_not_edited() {
        let root = scratch("hl");
        let outside = scratch("hl-out");
        fs::write(outside.join("o.md"), "o\n").unwrap();
        fs::hard_link(outside.join("o.md"), root.join("h.md")).unwrap();
        assert_eq!(code(open_note(&root, "h.md")), "hardlink");
    }
}
