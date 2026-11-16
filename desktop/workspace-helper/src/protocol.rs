//! The wire format: one JSON object per line in each direction.
//!
//! Requests are `{"id", "cmd", "args", "confirm"?}`. Responses are `{"id", "ok"}` or `{"id", "err": {code, message}}`.
//! Events are `{"event", "data"}` and carry no id. Every line is written under one lock, so a response and an event
//! from two threads never share a line. The input is untrusted: a line is read with a cap, and a line that cannot be
//! parsed gets an answer with id 0 instead of ending the process.

use std::io::{self, BufRead, Write};
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

/// Version of this wire format, reported by `hello`. Bump it when a message changes shape.
pub const PROTOCOL: u64 = 2;

/// The longest request line accepted. The largest legitimate request is a write of a 64 MB file; the cap is the
/// line size, so a JSON-escaped write near that size can be refused (see the report's concerns).
pub const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Deserialize, Debug)]
pub struct Request {
    pub id: u64,
    pub cmd: String,
    /// The same JSON object the desktop passes to the Tauri command. Absent means no arguments.
    #[serde(default)]
    pub args: Value,
    /// The user's answer to a confirmation, copied from the desktop's native dialog text.
    #[serde(default)]
    pub confirm: Option<Value>,
}

/// One line read from stdin.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    Eof,
    Text(Vec<u8>),
    /// The line went past the cap. Its bytes were discarded up to the newline.
    TooLong,
}

/// Reads one line without ever holding more than `max` bytes of it. An oversized line is consumed to its newline so
/// the reader is positioned at the next request.
pub fn read_bounded_line<R: BufRead>(reader: &mut R, max: usize) -> io::Result<Line> {
    let mut buf = Vec::new();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if buf.is_empty() && !too_long {
                return Ok(Line::Eof);
            }
            break;
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
            break;
        }
    }
    Ok(if too_long { Line::TooLong } else { Line::Text(buf) })
}

/// Parses one request line. A line that is not a request answers with id 0, or with its own id when the JSON has
/// one, and the caller keeps reading.
pub fn parse_request(bytes: &[u8]) -> Result<Request, Value> {
    match serde_json::from_slice::<Request>(bytes) {
        Ok(req) => Ok(req),
        Err(e) => {
            let id = serde_json::from_slice::<Value>(bytes).ok().and_then(|v| v.get("id").and_then(Value::as_u64));
            Err(err_response(id.unwrap_or(0), "bad_request", &format!("the request is not valid: {e}")))
        }
    }
}

pub fn ok_response(id: u64, value: Value) -> Value {
    json!({"id": id, "ok": value})
}

pub fn err_response(id: u64, code: &str, message: &str) -> Value {
    json!({"id": id, "err": {"code": code, "message": message}})
}

pub fn event(name: &str, data: Value) -> Value {
    json!({"event": name, "data": data})
}

/// Decodes the named argument. A missing key counts as `null`, so an optional field is `Option<T>`.
pub fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, llmide_workspace_core::FsError> {
    let raw = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(raw).map_err(|e| llmide_workspace_core::FsError {
        code: "bad_request",
        message: format!("the argument `{key}` is missing or invalid: {e}"),
    })
}

/// Like `arg`, for a boolean that defaults to `false` when the key is absent.
pub fn arg_or_false(args: &Value, key: &str) -> Result<bool, llmide_workspace_core::FsError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(_) => arg(args, key),
    }
}

/// The writer for the one stdout (or a test buffer). Each message is serialised first, then written and flushed
/// under the lock as a single line.
pub struct Out {
    sink: Mutex<Box<dyn Write + Send>>,
    /// True for the real stdout: the desktop has gone away, so there is nobody left to answer and the process
    /// ends quietly instead of reporting a broken pipe.
    exit_on_failure: bool,
}

impl Out {
    pub fn new(sink: Box<dyn Write + Send>, exit_on_failure: bool) -> Self {
        Self { sink: Mutex::new(sink), exit_on_failure }
    }

    /// Writes one message as one line. Returns `false` when the write failed.
    pub fn send(&self, value: &Value) -> bool {
        let mut line = value.to_string();
        line.push('\n');
        let mut sink = self.sink.lock().unwrap_or_else(|p| p.into_inner());
        let written = sink.write_all(line.as_bytes()).and_then(|_| sink.flush());
        if written.is_err() {
            drop(sink);
            if self.exit_on_failure {
                std::process::exit(0);
            }
            return false;
        }
        true
    }
}

/// A test sink that appends to a shared buffer, so a test can read back what the helper wrote.
#[cfg(test)]
pub struct Capture(pub std::sync::Arc<Mutex<Vec<u8>>>);

#[cfg(test)]
impl Write for Capture {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_line_is_refused_and_next_line_reads() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES + 1];
        bytes.extend_from_slice(b"\n{\"id\":3,\"cmd\":\"hello\"}\n");
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
        assert!(matches!(read_bounded_line(&mut reader, MAX_LINE_BYTES).unwrap(), Line::TooLong));
        match read_bounded_line(&mut reader, MAX_LINE_BYTES).unwrap() {
            Line::Text(text) => assert_eq!(text, b"{\"id\":3,\"cmd\":\"hello\"}"),
            _ => panic!("the line after an oversized one must be read"),
        }
        assert!(matches!(read_bounded_line(&mut reader, MAX_LINE_BYTES).unwrap(), Line::Eof));
    }

    #[test]
    fn bad_json_gets_bad_request_with_id_zero() {
        let err = parse_request(b"{not json").unwrap_err();
        assert_eq!(err["id"], 0);
        assert_eq!(err["err"]["code"], "bad_request");
    }

    #[test]
    fn responses_and_events_never_interleave() {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let out = std::sync::Arc::new(Out::new(Box::new(Capture(buf.clone())), false));
        let handles: Vec<_> = (0..4)
            .map(|t| {
                let out = out.clone();
                std::thread::spawn(move || {
                    for i in 0..300 {
                        let payload = "p".repeat(1000 + i);
                        out.send(&serde_json::json!({"event": "watch", "data": {"t": t, "i": i, "p": payload}}));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let text = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1200);
        for line in lines {
            let value: serde_json::Value = serde_json::from_str(line).expect("every line is one whole JSON object");
            assert_eq!(value["event"], "watch");
        }
    }

    #[test]
    fn line_without_newline_at_eof_is_still_read() {
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(b"abc".to_vec()));
        assert!(matches!(read_bounded_line(&mut reader, 10).unwrap(), Line::Text(t) if t == b"abc"));
        assert!(matches!(read_bounded_line(&mut reader, 10).unwrap(), Line::Eof));
    }
}
