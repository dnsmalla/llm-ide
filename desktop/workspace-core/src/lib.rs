//! Tauri-free file logic shared by the desktop host and the SSH workspace helper.
//!
//! The Explorer's file, path and trash rules live here so the desktop's Tauri commands and the static Linux
//! helper that serves a remote folder run the SAME code. This crate must not depend on `tauri`, a GUI crate or
//! the desktop's own modules. The host keeps what is specific to it: the active project root and the command
//! wrappers.
//!
//! - `fs`: list, read, write, create, rename, copy and delete inside one root (see that module's docs).
//! - `paths`: root validation, the "too broad" rule, the real-path check of an open descriptor and the Windows
//!   verbatim-prefix rule that git and cmd.exe need.
//! - `project`: the New project scaffold, the project marker, the Paths/Memory layout, repository clone and the
//!   graph-file read of a project root.
//! - `git`, `git_config`: the hardened git runner, status, diff and stage; `scm`: the Changes actions (discard, commit,
//!   branches, stash, merge, amend) and `confirm_spec`, the one table of their native dialog wording.
//! - `text`: single-line sanitising for text the user reads.
//! - `trash`: the only removal path. It moves to the OS trash and never deletes permanently.

pub mod fs;
pub mod git;
pub mod git_config;
pub mod scm;
pub mod paths;
pub mod project;
pub mod search;
pub mod text;
pub mod trash;
pub mod watch;

use std::sync::Mutex;

use serde::{Deserialize, Deserializer, Serialize};

/// The error every file command returns. The UI reads `{ code, message }`, and `code` is a stable token it
/// branches on, so the serialized shape must not change.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FsError {
    /// `&'static str` because every code is a literal at its call site. Deserialization goes through
    /// `static_str`, so an error from a peer can be rebuilt without changing the field type.
    #[serde(deserialize_with = "static_str")]
    pub code: StaticStr,
    pub message: String,
}

/// A `&'static str` that serde does not treat as borrowed. Serde would otherwise require `'de: 'static` for every
/// struct holding one, which makes it impossible to deserialize the result types. The alias is transparent.
pub type StaticStr = &'static str;

pub type R<T> = Result<T, FsError>;

/// Fails with a stable `code` and a message.
pub fn err<T>(code: &'static str, message: impl Into<String>) -> R<T> {
    Err(FsError { code, message: message.into() })
}

/// Maps an I/O failure to the code the UI expects: `not_found`, `exists`, `permission_denied`, otherwise `io`.
pub fn io_err(what: &str, e: std::io::Error) -> FsError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "not_found",
        std::io::ErrorKind::AlreadyExists => "exists",
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        _ => "io",
    };
    FsError { code, message: format!("{what}: {e}") }
}

/// Code given to a peer's code that is too long or past the intern cap.
const UNKNOWN_CODE: &str = "unknown_code";

/// Deserializes a `&'static str` field from the wire (used by `FsError::code` and by the result types).
///
/// NOTE: Interning is a deliberate deviation from the brief's `Cow` plan. `Cow` would have forced edits to about
/// 60 `FsError { code: "..." }` literals across the desktop crate, and the rest of the crate must compile
/// unchanged. The cost is a process-lifetime leak per distinct code, so the table is capped at 256 codes of at
/// most 64 bytes; anything beyond that maps to `unknown_code`. Codes come from our own core, so the cap is a
/// backstop against a misbehaving peer, not an expected limit.
pub fn static_str<'de, D: Deserializer<'de>>(deserializer: D) -> Result<StaticStr, D::Error> {
    let raw = String::deserialize(deserializer)?;
    Ok(intern(&raw))
}

/// The optional form of `static_str`, for a field such as a search's `truncated` reason that may be null.
pub fn opt_static_str<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<StaticStr>, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.map(|raw| intern(&raw)))
}

/// Each distinct code is leaked once so it can be `&'static str`. The table is capped: a misbehaving peer
/// must not grow memory without bound, so anything past the cap reads as `UNKNOWN_CODE`.
fn intern(raw: &str) -> StaticStr {
    const MAX_CODES: usize = 256;
    const MAX_CODE_LEN: usize = 64;
    static SEEN: Mutex<Vec<StaticStr>> = Mutex::new(Vec::new());
    let Ok(mut seen) = SEEN.lock() else {
        return UNKNOWN_CODE;
    };
    if let Some(known) = seen.iter().copied().find(|c| *c == raw) {
        return known;
    }
    if seen.len() >= MAX_CODES || raw.len() > MAX_CODE_LEN {
        return UNKNOWN_CODE;
    }
    let leaked: StaticStr = Box::leak(raw.to_owned().into_boxed_str());
    seen.push(leaked);
    leaked
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::Entry;

    #[test]
    fn error_serializes_to_code_and_message_only() {
        let e = FsError { code: "not_found", message: "no such file or folder".into() };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"code":"not_found","message":"no such file or folder"}"#);
    }

    #[test]
    fn error_round_trips_through_json() {
        let e: FsError = serde_json::from_str(r#"{"code":"conflict","message":"changed"}"#).unwrap();
        assert_eq!(e, FsError { code: "conflict", message: "changed".into() });
    }

    #[test]
    fn wire_codes_are_interned_once_and_long_ones_are_capped() {
        let long = "x".repeat(65);
        let e: FsError = serde_json::from_str(&format!(r#"{{"code":"{long}","message":""}}"#)).unwrap();
        assert_eq!(e.code, UNKNOWN_CODE);
        let a = intern("a_code_seen_once");
        assert!(std::ptr::eq(a, intern("a_code_seen_once")), "the same code is leaked once");
    }

    #[test]
    fn result_types_with_static_fields_deserialize() {
        let json = r#"{"name":"a","path":"a","kind":"file","symlink":false,"hidden":false,"ignored":false,"size":1,"mtime_ms":2}"#;
        let entry: Entry = serde_json::from_str(json).unwrap();
        assert_eq!((entry.kind, entry.size), ("file", 1));
    }
}
