//! Local SSE replay server for the chat bench (Phase 0 T7).
//!
//! `sse_replay_start` binds `127.0.0.1:0` (an OS-chosen port) and serves
//! `GET /stream` as `text/event-stream`, replaying the recorded v2 events one
//! `data: <json>\n\n` frame per write, flushed, optionally paced by `delay_ms`.
//! Each connection replays the whole list from the start. The webview never talks to
//! it directly: `sse_channel_stream` reads the stream from Rust and forwards each event
//! through a Tauri `Channel`, which is the transport the real app uses (the core's CORS
//! allowlist does not admit the webview origin, and CSP keeps `connect-src` off the
//! loopback port). The reader accepts only the port this server bound.

use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::ipc::Channel;

/// Largest events payload accepted from the webview (the long fixture is ~1 MB).
const EVENTS_MAX_BYTES: usize = 16 * 1024 * 1024;
/// Largest number of events in one replay.
const EVENTS_MAX_COUNT: usize = 100_000;
/// Largest pause the replay may insert between events.
const DELAY_MAX_MS: u64 = 1_000;
/// Socket timeouts on the replay server's accepted connections.
const SERVER_READ_TIMEOUT: Duration = Duration::from_secs(5);
const SERVER_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Client timeouts on the reader.
const CLIENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest single SSE line the reader accepts.
const SSE_LINE_MAX_BYTES: usize = 1024 * 1024;

/// What the server replays: the event lines and the pause between them.
struct Served {
    events: Vec<String>,
    delay: Option<Duration>,
}

struct Replay {
    port: u16,
    stop: Arc<AtomicBool>,
}

/// The running replay server, if any. One at a time: a new start replaces the old.
static REPLAY: Mutex<Option<Replay>> = Mutex::new(None);

/// Parses the events array and re-serialises each event as one compact JSON line,
/// so a frame can never contain a raw newline.
fn compact_events(events_json: &str) -> Result<Vec<String>, String> {
    if events_json.len() > EVENTS_MAX_BYTES {
        return Err(format!("events payload exceeds {EVENTS_MAX_BYTES} bytes"));
    }
    let value: serde_json::Value =
        serde_json::from_str(events_json).map_err(|e| format!("events is not JSON: {e}"))?;
    let serde_json::Value::Array(items) = value else {
        return Err("events must be a JSON array".into());
    };
    if items.len() > EVENTS_MAX_COUNT {
        return Err(format!("more than {EVENTS_MAX_COUNT} events"));
    }
    items
        .iter()
        .map(|v| serde_json::to_string(v).map_err(|e| e.to_string()))
        .collect()
}

/// Writes the response head and every event, one flushed write per event.
fn serve_stream(mut stream: TcpStream, served: &Served) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Content-Type: text/event-stream\r\n\
          Cache-Control: no-cache\r\n\
          Connection: close\r\n\r\n",
    )?;
    stream.flush()?;
    for (i, event) in served.events.iter().enumerate() {
        if i > 0 {
            if let Some(delay) = served.delay {
                thread::sleep(delay);
            }
        }
        let frame = format!("data: {event}\n\n");
        stream.write_all(frame.as_bytes())?;
        stream.flush()?;
    }
    stream.shutdown(Shutdown::Write)
}

/// Answers one connection: `GET /stream` replays, anything else is a 404.
fn handle(stream: TcpStream, served: &Served) {
    if stream.set_read_timeout(Some(SERVER_READ_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(SERVER_WRITE_TIMEOUT)).is_err()
    {
        return;
    }
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(_) => return,
    };
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    // Drain the headers; the replay ignores them.
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line == "\r\n" || line == "\n" => break,
            Ok(_) => {}
            Err(_) => return,
        }
    }
    let mut stream = stream;
    if request_line.starts_with("GET /stream ") {
        let _ = serve_stream(stream, served);
    } else {
        let _ = stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    }
}

/// Accept loop on a non-blocking listener, so `stop` takes effect within ~5 ms.
fn accept_loop(listener: TcpListener, served: Arc<Served>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let served = Arc::clone(&served);
                thread::spawn(move || handle(stream, &served));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => thread::sleep(Duration::from_millis(5)),
        }
    }
}

/// Stops the running replay server, if any. Safe to call when none is running.
pub fn stop() {
    if let Ok(mut guard) = REPLAY.lock() {
        if let Some(replay) = guard.take() {
            replay.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// The port the running replay server bound, if any.
fn bound_port() -> Option<u16> {
    REPLAY.lock().ok()?.as_ref().map(|r| r.port)
}

/// Starts (or restarts) the replay server with the given events; returns its port.
/// `delay_ms` (0..=1000) is the pause between events; 0 replays at full speed.
#[tauri::command]
pub fn sse_replay_start(events_json: String, delay_ms: Option<u64>) -> Result<u16, String> {
    let delay_ms = delay_ms.unwrap_or(0);
    if delay_ms > DELAY_MAX_MS {
        return Err(format!("delay_ms must be at most {DELAY_MAX_MS}"));
    }
    let served = Arc::new(Served {
        events: compact_events(&events_json)?,
        delay: (delay_ms > 0).then(|| Duration::from_millis(delay_ms)),
    });
    stop();
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let loop_flag = Arc::clone(&stop_flag);
    thread::spawn(move || accept_loop(listener, served, loop_flag));
    let mut guard = REPLAY.lock().map_err(|_| "replay state poisoned".to_string())?;
    *guard = Some(Replay { port, stop: stop_flag });
    Ok(port)
}

/// Stops the replay server.
#[tauri::command]
pub fn sse_replay_stop() {
    stop();
}

/// Reads `http://127.0.0.1:<port>/stream` and forwards every SSE event's `data`
/// payload (one JSON string per event) over `on_event`. Returns the event count.
/// Only the port the running replay server bound is accepted; the host is fixed.
#[tauri::command]
pub async fn sse_channel_stream(port: u16, on_event: Channel<String>) -> Result<u32, String> {
    match bound_port() {
        Some(bound) if bound == port => {}
        Some(_) => return Err("port is not the running replay server's".into()),
        None => return Err("no replay server is running".into()),
    }
    tauri::async_runtime::spawn_blocking(move || read_stream(port, &on_event))
        .await
        .map_err(|e| format!("stream task failed: {e}"))?
}

/// Reads one line without its terminator (a trailing CR is dropped), at most `max` bytes.
/// `Ok(None)` at end of stream. A longer line is an error, not a truncation.
fn read_capped_line(reader: &mut impl BufRead, max: usize) -> Result<Option<String>, String> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|e| format!("replay read failed: {e}"))?;
        if available.is_empty() {
            return Ok(if buf.is_empty() { None } else { Some(finish_line(buf)) });
        }
        let (take, done) = match available.iter().position(|&b| b == b'\n') {
            Some(pos) => (pos, true),
            None => (available.len(), false),
        };
        if buf.len() + take > max {
            return Err(format!("SSE line exceeds {max} bytes"));
        }
        buf.extend_from_slice(&available[..take]);
        let consumed = if done { take + 1 } else { take };
        reader.consume(consumed);
        if done {
            return Ok(Some(finish_line(buf)));
        }
    }
}

fn finish_line(mut buf: Vec<u8>) -> String {
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Per the SSE spec: `data` lines of one event join with newlines and a blank line
/// dispatches it; a bare `data` line is an empty data field; an event the stream ends
/// inside (no blank line) is discarded.
fn read_stream(port: u16, on_event: &Channel<String>) -> Result<u32, String> {
    let url = format!("http://127.0.0.1:{port}/stream");
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(CLIENT_CONNECT_TIMEOUT)
        .timeout_read(CLIENT_READ_TIMEOUT)
        .build();
    let response = agent
        .get(&url)
        .call()
        .map_err(|e| format!("replay connect failed: {e}"))?;
    let mut reader = BufReader::new(response.into_reader());
    let mut count: u32 = 0;
    let mut data = String::new();
    let mut has_data = false;
    while let Some(line) = read_capped_line(&mut reader, SSE_LINE_MAX_BYTES)? {
        if line.is_empty() {
            if has_data {
                on_event
                    .send(std::mem::take(&mut data))
                    .map_err(|e| format!("channel send failed: {e}"))?;
                count += 1;
                has_data = false;
            }
            continue;
        }
        if line.starts_with(':') {
            continue; // comment
        }
        let (field, value) = match line.find(':') {
            Some(i) => (&line[..i], line[i + 1..].strip_prefix(' ').unwrap_or(&line[i + 1..])),
            None => (line.as_str(), ""),
        };
        if field == "data" {
            if has_data {
                data.push('\n');
            }
            data.push_str(value);
            has_data = true;
        }
    }
    Ok(count)
}
