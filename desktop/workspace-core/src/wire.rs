//! The wire format between the desktop host and the SSH workspace helper, defined once.
//!
//! One JSON object per line in each direction. Requests are `{"args", "cmd", "confirm"?, "id"}`; answers are
//! `{"id", "ok"}` or `{"err": {code, message}, "id"}`; events are `{"data", "event"}` and carry no id.
//!
//! NOTE: serde_json has no `preserve_order` here, so `json!` objects serialise with sorted keys. The structs below
//! declare their fields in the same sorted order so their bytes equal what both sides sent before this module
//! existed. The golden tests at the bottom pin that. An older deployed helper (protocol 2) must keep working, so
//! no field may be renamed, and a new field must be optional on read and skipped when empty on write.

use std::io::{self, BufRead};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Version of this wire format, reported by `hello`. The host refuses a helper that reports another value, and the
/// helper's build version is deliberately not compared. Bump it when a message changes shape.
pub const PROTOCOL: u64 = 2;

/// The longest line either side accepts. The largest legitimate message is a 64 MB file inside one JSON line.
pub const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Event names (the `event` key).
pub const EVENT_SEARCH: &str = "search";
pub const EVENT_WATCH: &str = "watch";
pub const EVENT_CLONE: &str = "clone";

/// The command that opens a channel; a helper that predates it answers `unsupported` or `bad_request`.
pub const CMD_HELLO: &str = "hello";

/// Codes the two sides must agree on. The desktop branches on each.
pub const ROOT_MISSING_CODE: &str = "root_missing";
pub const ROOT_MISSING_MESSAGE: &str = "This folder is no longer on the server.";
pub const CONFIRM_REQUIRED_CODE: &str = "confirm_required";
pub const BUSY_CODE: &str = "busy";

/// One request. Field order is the sorted-key order the wire has always had.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Request {
    /// The same JSON object the desktop passes to the Tauri command. Absent means no arguments.
    #[serde(default)]
    pub args: Value,
    pub cmd: String,
    /// The question the user answered "yes" to, copied from the desktop's native dialog text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<Value>,
    pub id: u64,
}

impl Request {
    /// The request as one line, with its newline.
    pub fn to_line(&self) -> String {
        format!("{}\n", serde_json::to_string(self).unwrap_or_default())
    }
}

/// The `{code, message}` of an answer's `err`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WireError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

/// `{"id", "ok"}`.
pub fn ok_response(id: u64, value: Value) -> Value {
    json!({"id": id, "ok": value})
}

/// `{"id", "err": {code, message}}`.
pub fn err_response(id: u64, code: &str, message: &str) -> Value {
    json!({"id": id, "err": {"code": code, "message": message}})
}

/// `{"event", "data"}`.
pub fn event(name: &str, data: Value) -> Value {
    json!({"event": name, "data": data})
}

/// The parsed shape of an answer line. `ok` wins when both are present, as the host always read it.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Ok(Value),
    Err(Value),
    /// Neither key: a message this version does not understand.
    Unknown,
}

impl Answer {
    pub fn parse(value: &Value) -> Self {
        if let Some(ok) = value.get("ok") {
            return Self::Ok(ok.clone());
        }
        match value.get("err") {
            Some(err) => Self::Err(err.clone()),
            None => Self::Unknown,
        }
    }
}

/// What `hello` returns. `git` is optional on read: only the field the host needs is required to be right.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Hello {
    #[serde(default)]
    pub git: bool,
    pub protocol: u64,
    #[serde(default)]
    pub version: String,
}

/// The reply of `open`: the folder's name and canonical root. A reply missing either reads as empty, and the host
/// refuses an empty one.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Opened {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub root: String,
}

/// The reply of `mkdir`: the folder it made.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MadeDir {
    pub path: String,
}

/// The reply of `project_create`: the new project's canonical root and its marker identity.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ProjectCreated {
    pub id: String,
    pub name: String,
    pub root: String,
}

/// The reply of `clone_start`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CloneStarted {
    pub id: u64,
    pub started: bool,
}

/// The data of a `clone` event. `ok` decides which of the other fields are present.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CloneEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl CloneEvent {
    pub fn done(id: u64, path: String, name: String) -> Self {
        Self { code: None, id, message: None, name: Some(name), ok: true, path: Some(path) }
    }

    pub fn failed(id: u64, code: &str, message: &str) -> Self {
        Self { code: Some(code.into()), id, message: Some(message.into()), name: None, ok: false, path: None }
    }
}

/// One line read from a peer.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// The stream ended with nothing pending.
    Eof,
    /// A whole line, without its newline.
    Text(Vec<u8>),
    /// The stream ended in the middle of a line (no newline). The helper still handles it; the host treats it as
    /// the end, because a truncated answer is not a message.
    Unterminated(Vec<u8>),
    /// The line went past the cap. Its bytes were discarded up to the newline, so the reader is at the next line.
    TooLong,
}

/// Reads one line without ever holding more than `max` bytes of it.
pub fn read_bounded_line<R: BufRead + ?Sized>(reader: &mut R, max: usize) -> io::Result<Line> {
    let mut buf = Vec::new();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if too_long {
                return Ok(Line::TooLong);
            }
            return Ok(if buf.is_empty() { Line::Eof } else { Line::Unterminated(buf) });
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let used = newline.map_or(available.len(), |i| i + 1);
        if !too_long {
            let chunk = &available[..newline.unwrap_or(available.len())];
            if buf.len() + chunk.len() > max {
                too_long = true;
                buf = Vec::new();
            } else {
                buf.extend_from_slice(chunk);
            }
        }
        reader.consume(used);
        if newline.is_some() {
            return Ok(if too_long { Line::TooLong } else { Line::Text(buf) });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_bytes_match_the_historic_wire() {
        let plain = Request { args: json!({"path": "a"}), cmd: "fs_list".into(), confirm: None, id: 7 };
        assert_eq!(plain.to_line(), "{\"args\":{\"path\":\"a\"},\"cmd\":\"fs_list\",\"id\":7}\n");
        let asked = Request { confirm: Some(json!("Discard?")), ..plain };
        assert_eq!(asked.to_line(), "{\"args\":{\"path\":\"a\"},\"cmd\":\"fs_list\",\"confirm\":\"Discard?\",\"id\":7}\n");
    }

    #[test]
    fn request_without_args_reads_as_null_args() {
        let req: Request = serde_json::from_str(r#"{"id":3,"cmd":"hello"}"#).unwrap();
        assert_eq!((req.id, req.cmd.as_str(), req.args.is_null(), req.confirm), (3, "hello", true, None));
    }

    #[test]
    fn answers_and_events_keep_their_shape() {
        assert_eq!(ok_response(1, json!(2)).to_string(), r#"{"id":1,"ok":2}"#);
        assert_eq!(err_response(0, "bad_request", "x").to_string(), r#"{"err":{"code":"bad_request","message":"x"},"id":0}"#);
        assert_eq!(event(EVENT_WATCH, json!({"n": 1})).to_string(), r#"{"data":{"n":1},"event":"watch"}"#);
        assert_eq!(Answer::parse(&json!({"id": 1, "ok": null})), Answer::Ok(Value::Null));
        assert_eq!(Answer::parse(&json!({"id": 1, "err": {"code": "x"}})), Answer::Err(json!({"code": "x"})));
        assert_eq!(Answer::parse(&json!({"id": 1})), Answer::Unknown);
    }

    #[test]
    fn typed_replies_serialise_to_the_historic_json() {
        let hello = Hello { git: true, protocol: PROTOCOL, version: "1.2.3".into() };
        assert_eq!(serde_json::to_string(&hello).unwrap(), r#"{"git":true,"protocol":2,"version":"1.2.3"}"#);
        let opened = Opened { name: "p".into(), root: "/h/p".into() };
        assert_eq!(serde_json::to_string(&opened).unwrap(), r#"{"name":"p","root":"/h/p"}"#);
        assert_eq!(serde_json::to_string(&MadeDir { path: "/h/x".into() }).unwrap(), r#"{"path":"/h/x"}"#);
        let created = ProjectCreated { id: "i".into(), name: "n".into(), root: "/h/n".into() };
        assert_eq!(serde_json::to_string(&created).unwrap(), r#"{"id":"i","name":"n","root":"/h/n"}"#);
        assert_eq!(serde_json::to_string(&CloneStarted { id: 4, started: true }).unwrap(), r#"{"id":4,"started":true}"#);
        let done = CloneEvent::done(4, "/h/p/code/r".into(), "r".into());
        assert_eq!(serde_json::to_string(&done).unwrap(), r#"{"id":4,"name":"r","ok":true,"path":"/h/p/code/r"}"#);
        let failed = CloneEvent::failed(4, "clone_failed", "boom");
        assert_eq!(serde_json::to_string(&failed).unwrap(), r#"{"code":"clone_failed","id":4,"message":"boom","ok":false}"#);
    }

    #[test]
    fn a_hello_without_git_or_version_still_reads() {
        let hello: Hello = serde_json::from_value(json!({"protocol": 2})).unwrap();
        assert!(!hello.git && hello.version.is_empty());
    }

    #[test]
    fn oversized_line_is_refused_and_next_line_reads() {
        let mut bytes = vec![b'x'; 11];
        bytes.extend_from_slice(b"\nabc\n");
        let mut reader = io::BufReader::new(io::Cursor::new(bytes));
        assert_eq!(read_bounded_line(&mut reader, 10).unwrap(), Line::TooLong);
        assert_eq!(read_bounded_line(&mut reader, 10).unwrap(), Line::Text(b"abc".to_vec()));
        assert_eq!(read_bounded_line(&mut reader, 10).unwrap(), Line::Eof);
    }

    #[test]
    fn a_partial_last_line_is_unterminated_and_an_exact_cap_line_fits() {
        let mut reader = io::Cursor::new(b"abcd\nabc".to_vec());
        assert_eq!(read_bounded_line(&mut reader, 4).unwrap(), Line::Text(b"abcd".to_vec()));
        assert_eq!(read_bounded_line(&mut reader, 4).unwrap(), Line::Unterminated(b"abc".to_vec()));
        let mut long_tail = io::Cursor::new(b"abcdef".to_vec());
        assert_eq!(read_bounded_line(&mut long_tail, 4).unwrap(), Line::TooLong);
    }
}
