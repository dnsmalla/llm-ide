//! The wire format: one JSON object per line in each direction.
//!
//! Requests are `{"id", "cmd", "args", "confirm"?}`. Responses are `{"id", "ok"}` or `{"id", "err": {code, message}}`.
//! Events are `{"event", "data"}` and carry no id. Every line is written under one lock, so a response and an event
//! from two threads never share a line. The input is untrusted: a line is read with a cap, and a line that cannot be
//! parsed gets an answer with id 0 instead of ending the process.

use std::io::{self, Write};
use std::sync::Mutex;

use serde_json::Value;

// A last line with no newline arrives as `Line::Unterminated`; `main` handles it like a whole line, so a client that
// closes its input right after a request is still answered.
pub use llmide_workspace_core::wire::{err_response, event, ok_response, read_bounded_line, Line, Request, MAX_LINE_BYTES, PROTOCOL};

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

pub use llmide_workspace_core::commands::{arg, arg_or_false};

/// The writer for the one stdout (or a test buffer). Each message is serialised first, then written and flushed
/// under the lock as a single line.
pub struct Out {
    sink: Mutex<Box<dyn Write + Send>>,
    /// True for the real stdout: the desktop has gone away, so there is nobody left to answer and the process
    /// ends quietly instead of reporting a broken pipe.
    exit_on_failure: bool,
    /// Runs before the process exits on a failed write, so a running clone is stopped first and git does not outlive
    /// the helper. It runs after the sink lock is released, because a clone's own event needs that lock.
    before_exit: Option<Box<dyn Fn() + Send + Sync>>,
}

impl Out {
    /// A writer over any sink, for the tests. The process uses `stdout`.
    #[cfg(test)]
    pub fn new(sink: Box<dyn Write + Send>, exit_on_failure: bool) -> Self {
        Self { sink: Mutex::new(sink), exit_on_failure, before_exit: None }
    }

    /// The real stdout. A failed write runs `before_exit`, then ends the process.
    pub fn stdout(before_exit: Box<dyn Fn() + Send + Sync>) -> Self {
        Self { sink: Mutex::new(Box::new(io::stdout())), exit_on_failure: true, before_exit: Some(before_exit) }
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
                if let Some(before_exit) = &self.before_exit {
                    before_exit();
                }
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
        assert!(matches!(read_bounded_line(&mut reader, 10).unwrap(), Line::Unterminated(t) if t == b"abc"));
        assert!(matches!(read_bounded_line(&mut reader, 10).unwrap(), Line::Eof));
    }
}
