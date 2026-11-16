//! Client for the server's `llmide-workspace` helper: one long-lived `ssh` channel that carries the
//! Explorer's file, git, search and watch commands as JSON lines.
//!
//! [`WorkspaceClient::connect`] starts the helper with the constant [`WORKSPACE`] command, checks its
//! version with `hello`, and then answers each request by its id on one reader thread. Events go to the
//! subscribers of their kind. Every spawn takes its own one-time password grant, so a reconnect never
//! reuses an answered grant.
//!
//! NOTE: nothing calls this module yet. Task 7 (the Explorer commands over the helper) wires it in; until
//! then the module-wide allowance keeps the build free of dead-code warnings.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{self, BufRead, Read};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::ssh_askpass::AskpassGrant;
use crate::ssh_server_scripts::WORKSPACE;
use crate::ssh_transport::{exec_args, SshEndpoint, SshExec, StdioChild};

/// The protocol version the helper must report in `hello`. Bumped together with the helper's `PROTOCOL`.
const PROTOCOL: u64 = 1;

/// How long a call waits for its answer. A silent helper must not leave the Explorer spinning forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// The longest answer line accepted: the same 64 MB cap the helper puts on its requests. A large file read
/// is the biggest legitimate answer.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// How long `close` waits for the reader thread once the child is killed.
const READER_WAIT: Duration = Duration::from_secs(1);

const HELLO: &str = "hello";
const LOST_CODE: &str = "lost_connection";
const LOST_MESSAGE: &str = "The connection to the server was lost.";
const TIMEOUT_CODE: &str = "SSH_TIMEOUT";
const TIMEOUT_MESSAGE: &str = "The server did not answer in time.";
const VERSION_CODE: &str = "workspace_version";
const VERSION_MESSAGE: &str = "The server part is a different version. Connect again to update it.";
const CHANNEL_CODE: &str = "SSH_CHANNEL_FAILED";
const CHANNEL_MESSAGE: &str = "The connection to the server could not be opened.";
const BAD_ANSWER_CODE: &str = "bad_response";
const BAD_ANSWER_MESSAGE: &str = "The server sent an answer this app does not understand.";
const REMOTE_CODE: &str = "remote_error";

/// Error codes the helper and the core send. A code outside this list becomes [`REMOTE_CODE`], because
/// `FsError::code` is a static string and a server-chosen string must never be stored as one.
const KNOWN_CODES: &[&str] = &[
    "bad_request",
    "changed_since_confirm",
    "confirm_required",
    "conflict",
    "conflicts",
    "dirty_conflict",
    "dirty_stash",
    "exists",
    "git_missing",
    "git_unavailable",
    "internal",
    "invalid_path",
    "invalid_query",
    "io",
    "no_home",
    "no_project",
    "no_watch",
    "not_a_directory",
    "not_found",
    "outside_home",
    "outside_root",
    "too_large",
    "trash_unavailable",
    "unsupported",
    "untrusted_repo_config",
    "would_overwrite",
];

/// The kinds of helper events. The wire names are `search` and `watch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    Search,
    Watch,
}

impl EventKind {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "search" => Some(Self::Search),
            "watch" => Some(Self::Watch),
            _ => None,
        }
    }
}

/// Receives the `data` of each event of one kind. Runs on the reader thread, so it must not block or call back
/// into the client.
pub type EventSink = Box<dyn Fn(Value) + Send>;

/// A call waiting for its answer.
type Waiter = Sender<Result<Value, FsError>>;

/// What the reader thread and the callers share.
#[derive(Default)]
struct Shared {
    pending: Mutex<PendingState>,
    subscribers: Mutex<Vec<(EventKind, EventSink)>>,
}

/// The calls waiting for an answer. `closed` lives under the same lock, so a call that registers after the
/// channel closed is refused rather than left waiting for an answer that cannot come.
#[derive(Default)]
struct PendingState {
    calls: HashMap<u64, Waiter>,
    closed: bool,
}

impl Shared {
    /// Registers a call. Refused once the channel is closed.
    fn register(&self, id: u64, waiter: Waiter) -> Result<(), FsError> {
        let mut state = locked(&self.pending);
        if state.closed {
            return Err(lost());
        }
        state.calls.insert(id, waiter);
        Ok(())
    }

    /// Removes a call that gave up waiting. A late answer for it then matches nothing and is ignored.
    fn forget(&self, id: u64) {
        locked(&self.pending).calls.remove(&id);
    }

    /// Marks the channel closed and fails every waiting call.
    fn fail_all(&self) {
        let mut state = locked(&self.pending);
        state.closed = true;
        for (_, waiter) in state.calls.drain() {
            let _ = waiter.send(Err(lost()));
        }
    }

    /// Hands one line from the helper to its waiter, or to the subscribers of its event kind.
    fn route(&self, value: Value) {
        if let Some(name) = value.get("event").and_then(Value::as_str) {
            let data = value.get("data").cloned().unwrap_or(Value::Null);
            self.emit(name, data);
            return;
        }
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            return;
        };
        // An id that matches nothing is a call that already timed out, so the answer is dropped.
        let waiter = locked(&self.pending).calls.remove(&id);
        if let Some(waiter) = waiter {
            let _ = waiter.send(parse_answer(&value));
        }
    }

    fn emit(&self, name: &str, data: Value) {
        let Some(kind) = EventKind::from_name(name) else {
            return;
        };
        for (subscribed, sink) in locked(&self.subscribers).iter() {
            if *subscribed == kind {
                sink(data.clone());
            }
        }
    }
}

/// A connection to one server's helper. One reader thread routes the answers and events; calls write their
/// request lines under the child lock, so each line reaches the helper whole.
pub struct WorkspaceClient {
    child: Arc<Mutex<Box<dyn StdioChild>>>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    git: bool,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl WorkspaceClient {
    /// Starts the helper over ssh, checks its version and returns the connected client.
    ///
    /// Preconditions: `grant` is a fresh grant for this spawn (`None` for key auth). The grant is held until
    /// `hello` answers, because ssh asks for the password before the channel opens.
    /// Errors: `workspace_version` when the helper speaks another protocol or version (the child is killed);
    /// `SSH_CHANNEL_FAILED` when ssh cannot start; any error the `hello` call returns.
    pub fn connect(
        exec: &dyn SshExec,
        endpoint: &SshEndpoint,
        known_hosts: &Path,
        grant: Option<AskpassGrant>,
    ) -> Result<Self, FsError> {
        let args = exec_args(endpoint, known_hosts, true, WORKSPACE);
        let child = exec
            .spawn_stdio(&args, grant.as_ref())
            .map_err(|_| herr(CHANNEL_CODE, CHANNEL_MESSAGE))?;
        let mut client = Self::start(child);
        let git = client.call_with_timeout(HELLO, json!({}), None, CALL_TIMEOUT).and_then(|v| check_hello(&v));
        drop(grant);
        match git {
            Ok(git) => {
                client.git = git;
                Ok(client)
            }
            Err(error) => {
                client.close();
                Err(error)
            }
        }
    }

    /// Takes the child's stdout and starts the reader thread. The child is shared with the reader, which kills it
    /// when the channel breaks.
    fn start(mut child: Box<dyn StdioChild>) -> Self {
        let stdout = child.take_stdout();
        let child = Arc::new(Mutex::new(child));
        let shared = Arc::new(Shared::default());
        let reader = {
            let (shared, child) = (shared.clone(), child.clone());
            std::thread::spawn(move || read_loop(stdout, &shared, &child))
        };
        Self {
            child,
            shared,
            next_id: AtomicU64::new(1),
            git: false,
            reader: Mutex::new(Some(reader)),
        }
    }

    /// Sends one request and waits up to 60 s for its answer.
    ///
    /// Errors: the helper's own `{code, message}`; `lost_connection` when the channel is gone; `SSH_TIMEOUT`
    /// when no answer came in time.
    pub fn call(&self, cmd: &str, args: Value, confirm: Option<&str>) -> Result<Value, FsError> {
        self.call_with_timeout(cmd, args, confirm, CALL_TIMEOUT)
    }

    fn call_with_timeout(
        &self,
        cmd: &str,
        args: Value,
        confirm: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, FsError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (waiter, answer) = mpsc::channel();
        self.shared.register(id, waiter)?;
        let line = request_line(id, cmd, args, confirm);
        if write_line(&self.child, &line).is_err() {
            break_channel(&self.shared, &self.child);
            return Err(lost());
        }
        match answer.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.shared.forget(id);
                Err(herr(TIMEOUT_CODE, TIMEOUT_MESSAGE))
            }
            Err(RecvTimeoutError::Disconnected) => Err(lost()),
        }
    }

    /// Registers `sink` for every event of `kind`. The sink runs on the reader thread.
    pub fn subscribe(&self, kind: EventKind, sink: EventSink) {
        locked(&self.shared.subscribers).push((kind, sink));
    }

    /// Whether the helper reported git in `hello`.
    pub fn git_available(&self) -> bool {
        self.git
    }

    /// Whether the channel has ended. Every call on a closed client fails with `lost_connection`.
    pub fn is_closed(&self) -> bool {
        locked(&self.shared.pending).closed
    }

    /// Ends the channel: the waiting calls fail, the child is killed and the reader thread is joined. Calling
    /// it again changes nothing.
    pub fn close(&self) {
        break_channel(&self.shared, &self.child);
        let reader = locked(&self.reader).take();
        if let Some(handle) = reader {
            join_briefly(handle);
        }
    }
}

impl Drop for WorkspaceClient {
    fn drop(&mut self) {
        self.close();
    }
}

/// The reader thread: routes every line until the channel ends, then fails the waiting calls and kills the child.
///
/// A line that is not JSON, or one over the cap, ends the loop: a channel that sends such lines cannot be
/// trusted to keep its answers in order. The stdout pipe is dropped before the kill, so a helper still writing
/// gets a broken pipe instead of blocking on a full one.
fn read_loop(mut stdout: Box<dyn BufRead + Send>, shared: &Shared, child: &Mutex<Box<dyn StdioChild>>) {
    loop {
        match read_capped_line(&mut *stdout, MAX_LINE_BYTES) {
            Ok(Line::Text(bytes)) if bytes.is_empty() => {}
            Ok(Line::Text(bytes)) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => shared.route(value),
                Err(_) => break,
            },
            Ok(Line::Eof | Line::TooLong) | Err(_) => break,
        }
    }
    drop(stdout);
    break_channel(shared, child);
}

/// Marks the channel closed, fails the waiting calls and kills the child. Shared by close, the reader and a
/// failed write, so every way out of the channel leaves the same state.
fn break_channel(shared: &Shared, child: &Mutex<Box<dyn StdioChild>>) {
    shared.fail_all();
    locked(child).kill();
}

/// Writes one request line under the child lock. A write blocks while the helper does not read its stdin; a
/// blocked write therefore delays `close` as well, which is the trade-off of a single writer.
fn write_line(child: &Mutex<Box<dyn StdioChild>>, line: &str) -> io::Result<()> {
    let mut guard = locked(child);
    let stdin = guard.stdin();
    stdin.write_all(line.as_bytes())?;
    stdin.flush()
}

/// One request as a single JSON line. `confirm` is sent only when the user answered a dialog.
fn request_line(id: u64, cmd: &str, args: Value, confirm: Option<&str>) -> String {
    let mut request = Map::new();
    request.insert("id".to_string(), json!(id));
    request.insert("cmd".to_string(), json!(cmd));
    request.insert("args".to_string(), args);
    if let Some(answer) = confirm {
        request.insert("confirm".to_string(), json!(answer));
    }
    format!("{}\n", Value::Object(request))
}

/// Reads the answer to `hello`: the protocol and version must match this build, and `git` is optional.
fn check_hello(value: &Value) -> Result<bool, FsError> {
    let version = value.get("version").and_then(Value::as_str);
    let protocol = value.get("protocol").and_then(Value::as_u64);
    if protocol != Some(PROTOCOL) || version != Some(env!("CARGO_PKG_VERSION")) {
        return Err(herr(VERSION_CODE, VERSION_MESSAGE));
    }
    Ok(value.get("git").and_then(Value::as_bool).unwrap_or(false))
}

/// Turns one helper answer into the call's result: `ok` is the value, `err` is the helper's error.
fn parse_answer(value: &Value) -> Result<Value, FsError> {
    if let Some(ok) = value.get("ok") {
        return Ok(ok.clone());
    }
    if let Some(err) = value.get("err") {
        let code = err.get("code").and_then(Value::as_str).unwrap_or_default();
        let message = err.get("message").and_then(Value::as_str).unwrap_or("The server reported an error.");
        return Err(FsError { code: known_code(code), message: message.to_string() });
    }
    Err(herr(BAD_ANSWER_CODE, BAD_ANSWER_MESSAGE))
}

/// The static form of a server error code, or [`REMOTE_CODE`] when the code is not one this build knows.
fn known_code(code: &str) -> &'static str {
    KNOWN_CODES.iter().find(|known| **known == code).copied().unwrap_or(REMOTE_CODE)
}

fn lost() -> FsError {
    herr(LOST_CODE, LOST_MESSAGE)
}

/// One line read from the helper.
#[derive(Debug, PartialEq, Eq)]
enum Line {
    /// The stream ended, or ended in the middle of a line.
    Eof,
    /// A whole line, without its newline.
    Text(Vec<u8>),
    /// The line is longer than the cap. Its remainder is not read: the caller closes the channel.
    TooLong,
}

/// Reads one newline-terminated line of at most `max` bytes. At most `max + 1` bytes are buffered, so a
/// hostile line cannot grow the buffer without limit.
fn read_capped_line(reader: &mut dyn BufRead, max: usize) -> io::Result<Line> {
    let mut buf = Vec::new();
    (&mut *reader).take(max as u64 + 1).read_until(b'\n', &mut buf)?;
    if buf.last() != Some(&b'\n') {
        return Ok(if buf.len() > max { Line::TooLong } else { Line::Eof });
    }
    buf.pop();
    Ok(Line::Text(buf))
}

/// Waits briefly for a finished reader thread and joins it. A reader still busy after the wait is left to end on
/// its own: it exits as soon as its pipe closes, and nothing waits for it.
fn join_briefly(handle: JoinHandle<()>) {
    let until = Instant::now() + READER_WAIT;
    while !handle.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
    if handle.is_finished() {
        let _ = handle.join();
    }
}

/// Locks a mutex, recovering the data from a poisoned lock. The guarded values are plain state.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_transport::{prepare_endpoint, ForwardChild, SshAuth};
    use crate::remote::RawOutput;
    use std::collections::VecDeque;
    use std::io::{BufReader, Cursor, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::AtomicUsize;

    const KNOWN: &str = "/var/llmide-test/known_hosts";
    const KEY: &str = "/home/alice/.ssh/id_ed25519";
    const VERSION_MESSAGE: &str = "The server part is a different version. Connect again to update it.";

    type Behave = Box<dyn FnMut(&Value) -> Vec<String> + Send>;

    fn reply(id: &Value, body: Value) -> String {
        json!({"id": id, "ok": body}).to_string()
    }

    fn hello_reply(id: &Value, git: bool) -> String {
        reply(id, json!({"version": env!("CARGO_PKG_VERSION"), "protocol": 1, "git": git}))
    }

    fn event(name: &str, data: Value) -> String {
        json!({"event": name, "data": data}).to_string()
    }

    /// Answers `hello` and echoes the arguments of every other request.
    fn echo() -> Behave {
        Box::new(|request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec![reply(&request["id"], request["args"].clone())],
        })
    }

    /// What a test sees of one fake helper: the requests it received and a way to break its channel.
    struct Remote {
        requests: mpsc::Receiver<Value>,
        answers: Arc<UnixStream>,
        kills: Arc<AtomicUsize>,
    }

    impl Remote {
        fn next_request(&self) -> Value {
            self.requests.recv_timeout(Duration::from_secs(5)).expect("the helper received a request")
        }

        /// Closes the helper's answer pipe, which is what a dropped connection looks like to the client.
        fn hang_up(&self) {
            let _ = self.answers.shutdown(Shutdown::Write);
        }

        fn kills(&self) -> usize {
            self.kills.load(Ordering::SeqCst)
        }
    }

    /// An in-memory helper child. Requests travel on one socket pair and answers on another; a thread plays the
    /// server, so a test can hold a reply and release it later.
    struct FakeStdio {
        stdin: UnixStream,
        stdout: Option<UnixStream>,
        answers: Arc<UnixStream>,
        kills: Arc<AtomicUsize>,
        stopped: bool,
    }

    impl FakeStdio {
        fn new(behave: Behave) -> (Self, Remote) {
            let (desk_in, server_in) = UnixStream::pair().unwrap();
            let (server_out, desk_out) = UnixStream::pair().unwrap();
            let answers = Arc::new(server_out.try_clone().unwrap());
            let (seen, requests) = mpsc::channel();
            std::thread::spawn(move || serve(server_in, server_out, behave, seen));
            let kills = Arc::new(AtomicUsize::new(0));
            let remote = Remote { requests, answers: answers.clone(), kills: kills.clone() };
            (Self { stdin: desk_in, stdout: Some(desk_out), answers, kills, stopped: false }, remote)
        }
    }

    /// The server side of a fake helper. It ends when the client closes the request pipe.
    fn serve(input: UnixStream, mut output: UnixStream, mut behave: Behave, seen: mpsc::Sender<Value>) {
        for line in BufReader::new(input).lines() {
            let Ok(line) = line else { return };
            let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
            let _ = seen.send(request.clone());
            for answer in behave(&request) {
                if output.write_all(format!("{answer}\n").as_bytes()).is_err() {
                    return;
                }
            }
        }
    }

    impl StdioChild for FakeStdio {
        fn stdin(&mut self) -> &mut dyn Write {
            &mut self.stdin
        }

        fn take_stdout(&mut self) -> Box<dyn BufRead + Send> {
            match self.stdout.take() {
                Some(pipe) => Box::new(BufReader::new(pipe)),
                None => Box::new(io::empty()),
            }
        }

        fn kill(&mut self) {
            if self.stopped {
                return;
            }
            self.stopped = true;
            self.kills.fetch_add(1, Ordering::SeqCst);
            let _ = self.stdin.shutdown(Shutdown::Both);
            let _ = self.answers.shutdown(Shutdown::Write);
        }

        fn try_exited(&mut self) -> Option<i32> {
            self.stopped.then_some(0)
        }
    }

    /// Hands out the queued fake helpers in order, and records each spawn's argv and whether it got a grant.
    struct FakeExec {
        children: Mutex<VecDeque<FakeStdio>>,
        spawns: Mutex<Vec<(Vec<String>, bool)>>,
    }

    impl FakeExec {
        fn with(children: Vec<FakeStdio>) -> Self {
            Self { children: Mutex::new(children.into()), spawns: Mutex::new(Vec::new()) }
        }

        fn spawns(&self) -> Vec<(Vec<String>, bool)> {
            self.spawns.lock().unwrap().clone()
        }
    }

    impl SshExec for FakeExec {
        fn run(
            &self,
            _args: &[String],
            _stdin: Option<&[u8]>,
            _askpass: Option<&AskpassGrant>,
            _deadline: Duration,
        ) -> io::Result<RawOutput> {
            Err(io::Error::other("the helper channel tests run no one-shot command"))
        }

        fn spawn_forward(
            &self,
            _args: &[String],
            _askpass: Option<&AskpassGrant>,
        ) -> io::Result<Box<dyn ForwardChild>> {
            Err(io::Error::other("the helper channel tests open no forward"))
        }

        fn spawn_stdio(&self, args: &[String], askpass: Option<&AskpassGrant>) -> io::Result<Box<dyn StdioChild>> {
            self.spawns.lock().unwrap().push((args.to_vec(), askpass.is_some()));
            let next = self.children.lock().unwrap().pop_front();
            next.map(|child| Box::new(child) as Box<dyn StdioChild>)
                .ok_or_else(|| io::Error::other("no fake helper left"))
        }
    }

    fn endpoint() -> SshEndpoint {
        prepare_endpoint("example.com", 22, "alice", SshAuth::Key { path: KEY.into() }).unwrap()
    }

    fn exec_with(behave: Behave) -> (FakeExec, Remote) {
        let (child, remote) = FakeStdio::new(behave);
        (FakeExec::with(vec![child]), remote)
    }

    /// Connects through one fake helper and consumes the `hello` from its request log.
    fn connect_ok(behave: Behave) -> (WorkspaceClient, Remote) {
        let (exec, remote) = exec_with(behave);
        let client = WorkspaceClient::connect(&exec, &endpoint(), Path::new(KNOWN), None).unwrap();
        remote.next_request();
        (client, remote)
    }

    fn pending_len(client: &WorkspaceClient) -> usize {
        locked(&client.shared.pending).calls.len()
    }

    #[test]
    fn hello_version_mismatch_refused() {
        let behave: Behave = Box::new(|request: &Value| {
            vec![reply(&request["id"], json!({"version": "0.0.1-other-build", "protocol": 1, "git": true}))]
        });
        let (exec, remote) = exec_with(behave);
        let error = WorkspaceClient::connect(&exec, &endpoint(), Path::new(KNOWN), None).err().expect("refused");
        assert_eq!(error.code, "workspace_version");
        assert_eq!(error.message, VERSION_MESSAGE);
        assert_eq!(remote.kills(), 1, "the refused helper is killed");
    }

    #[test]
    fn hello_protocol_mismatch_refused() {
        let behave: Behave = Box::new(|request: &Value| {
            vec![reply(&request["id"], json!({"version": env!("CARGO_PKG_VERSION"), "protocol": 2, "git": true}))]
        });
        let (exec, remote) = exec_with(behave);
        let error = WorkspaceClient::connect(&exec, &endpoint(), Path::new(KNOWN), None).err().expect("refused");
        assert_eq!(error.code, "workspace_version");
        assert_eq!(remote.kills(), 1);
    }

    #[test]
    fn hello_reports_git_availability() {
        let (client, _remote) = connect_ok(echo());
        assert!(client.git_available());
        let behave: Behave = Box::new(|request: &Value| vec![hello_reply(&request["id"], false)]);
        let (client, _remote) = connect_ok(behave);
        assert!(!client.git_available());
    }

    #[test]
    fn responses_routed_by_id() {
        let mut held: Option<String> = None;
        let behave: Behave = Box::new(move |request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            Some("first") => {
                held = Some(reply(&request["id"], json!("first")));
                vec![]
            }
            Some("second") => {
                let mut answers = vec![reply(&request["id"], json!("second"))];
                answers.extend(held.take());
                answers
            }
            _ => vec![],
        });
        let (client, remote) = connect_ok(behave);
        let client = Arc::new(client);
        let first = {
            let client = client.clone();
            std::thread::spawn(move || client.call("first", json!({}), None))
        };
        remote.next_request();
        let second = client.call("second", json!({}), None).unwrap();
        assert_eq!(second, json!("second"));
        assert_eq!(first.join().unwrap().unwrap(), json!("first"));
    }

    #[test]
    fn events_reach_subscriber() {
        let behave: Behave = Box::new(|request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec![
                event("search", json!({"hit": 1})),
                event("watch", json!({"batch": 2})),
                reply(&request["id"], json!({"id": 7})),
            ],
        });
        let (client, _remote) = connect_ok(behave);
        let (search_tx, search_rx) = mpsc::channel();
        let (watch_tx, watch_rx) = mpsc::channel();
        client.subscribe(EventKind::Search, Box::new(move |data: Value| {
            let _ = search_tx.send(data);
        }));
        client.subscribe(EventKind::Watch, Box::new(move |data: Value| {
            let _ = watch_tx.send(data);
        }));
        assert_eq!(client.call("start", json!({}), None).unwrap(), json!({"id": 7}));
        assert_eq!(search_rx.try_recv().unwrap(), json!({"hit": 1}));
        assert_eq!(watch_rx.try_recv().unwrap(), json!({"batch": 2}));
        assert!(search_rx.try_recv().is_err(), "a watch event never reaches the search subscriber");
    }

    #[test]
    fn channel_loss_fails_pending_calls() {
        // The helper answers hello and never answers the call, so the call is still pending when the channel drops.
        let silent: Behave = Box::new(|request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec![],
        });
        let (client, remote) = connect_ok(silent);
        let client = Arc::new(client);
        let hanging = {
            let client = client.clone();
            std::thread::spawn(move || client.call("hang", json!({}), None))
        };
        remote.next_request();
        remote.hang_up();
        let error = hanging.join().unwrap().err().expect("the pending call fails");
        assert_eq!(error.code, "lost_connection");
        assert_eq!(error.message, "The connection to the server was lost.");
        assert!(client.is_closed());
        let later = client.call("status", json!({}), None).err().expect("later calls fail too");
        assert_eq!(later.code, "lost_connection");
    }

    #[test]
    fn password_grant_per_spawn() {
        let link = crate::ssh_link::held_for_test(Some("hunter2"));
        let keyed = crate::ssh_link::held_for_test(None);
        let children: Vec<FakeStdio> = (0..3).map(|_| FakeStdio::new(echo()).0).collect();
        let exec = FakeExec::with(children);
        let password_endpoint = prepare_endpoint("example.com", 22, "alice", SshAuth::Password).unwrap();
        let first = link.grant().unwrap();
        let second = link.grant().unwrap();
        let key_grant = keyed.grant().unwrap();
        for grant in [first, second, key_grant] {
            let client = WorkspaceClient::connect(&exec, &password_endpoint, Path::new(KNOWN), grant).unwrap();
            client.close();
        }
        let granted: Vec<bool> = exec.spawns().iter().map(|(_, has_grant)| *has_grant).collect();
        assert_eq!(granted, vec![true, true, false], "each password spawn gets its own grant, key auth none");
        for (args, _) in exec.spawns() {
            assert!(args.iter().all(|arg| !arg.contains("hunter2")), "the password never reaches argv");
        }
    }

    #[test]
    fn workspace_argv_is_strict_and_quiet() {
        let (exec, _remote) = exec_with(echo());
        let client = WorkspaceClient::connect(&exec, &endpoint(), Path::new(KNOWN), None).unwrap();
        client.close();
        let (args, _) = exec.spawns().remove(0);
        assert!(args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"), "host keys are strict");
        assert!(!args.iter().any(|arg| arg == "-v"), "no ssh debug output");
        assert_eq!(args.last().map(String::as_str), Some(WORKSPACE), "the remote command is the constant");
        assert!(WORKSPACE.contains("llmide-workspace\" --stdio"));
        assert!(WORKSPACE.starts_with("exec \"$HOME/.llmide-server/current/core/bin/llmide-workspace\""));
    }

    #[test]
    fn timeout_removes_pending_entry_and_late_answer_is_ignored() {
        let mut slow_id = Value::Null;
        let behave: Behave = Box::new(move |request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            Some("slow") => {
                slow_id = request["id"].clone();
                vec![]
            }
            Some("after") => vec![reply(&slow_id, json!("late")), reply(&request["id"], json!("after"))],
            _ => vec![],
        });
        let (client, _remote) = connect_ok(behave);
        let error = client
            .call_with_timeout("slow", json!({}), None, Duration::from_millis(50))
            .err()
            .expect("the call times out");
        assert_eq!(error.code, "SSH_TIMEOUT");
        assert_eq!(error.message, "The server did not answer in time.");
        assert_eq!(pending_len(&client), 0, "the timed-out entry is removed");
        assert_eq!(client.call("after", json!({}), None).unwrap(), json!("after"));
        assert_eq!(pending_len(&client), 0, "the late answer for the timed-out id matched nothing");
        assert!(!client.is_closed(), "a late answer does not break the channel");
    }

    #[test]
    fn over_long_line_closes_client() {
        let behave: Behave = Box::new(|request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec!["x".repeat(MAX_LINE_BYTES + 1)],
        });
        let (client, remote) = connect_ok(behave);
        let error = client.call("big", json!({}), None).err().expect("the pending call fails");
        assert_eq!(error.code, "lost_connection");
        assert!(client.is_closed());
        client.close();
        assert_eq!(remote.kills(), 1, "the broken helper is killed once");
    }

    #[test]
    fn invalid_json_line_closes_client() {
        let behave: Behave = Box::new(|request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec!["this is not json".to_string()],
        });
        let (client, _remote) = connect_ok(behave);
        let error = client.call("junk", json!({}), None).err().expect("the pending call fails");
        assert_eq!(error.code, "lost_connection");
        assert!(client.is_closed());
    }

    #[test]
    fn confirm_sent_only_when_given() {
        let (client, remote) = connect_ok(echo());
        client.call("discard", json!({"path": "a"}), None).unwrap();
        client.call("discard", json!({"path": "a"}), Some("Discard changes?")).unwrap();
        let plain = remote.next_request();
        let confirmed = remote.next_request();
        assert!(plain.get("confirm").is_none(), "no confirm field without an answer");
        assert_eq!(confirmed["confirm"], json!("Discard changes?"));
        assert_eq!(confirmed["cmd"], json!("discard"));
    }

    #[test]
    fn two_threads_get_their_own_answers() {
        let (client, _remote) = connect_ok(echo());
        let client = Arc::new(client);
        let workers: Vec<_> = (0..2)
            .map(|n| {
                let client = client.clone();
                std::thread::spawn(move || (n, client.call("echo", json!({"n": n}), None)))
            })
            .collect();
        for worker in workers {
            let (n, answer) = worker.join().unwrap();
            assert_eq!(answer.unwrap(), json!({"n": n}));
        }
    }

    #[test]
    fn server_error_keeps_known_code_and_maps_unknown() {
        let behave: Behave = Box::new(|request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            Some("escape") => vec![json!({"id": request["id"], "err": {"code": "outside_home", "message": "m"}}).to_string()],
            _ => vec![json!({"id": request["id"], "err": {"code": "made_up_by_server", "message": "x"}}).to_string()],
        });
        let (client, _remote) = connect_ok(behave);
        let known = client.call("escape", json!({}), None).err().expect("an error");
        assert_eq!(known.code, "outside_home");
        assert_eq!(known.message, "m");
        let unknown = client.call("other", json!({}), None).err().expect("an error");
        assert_eq!(unknown.code, "remote_error", "an unknown server code never becomes a static code");
    }

    #[test]
    fn close_kills_child_and_joins_reader() {
        let (client, remote) = connect_ok(echo());
        client.close();
        assert_eq!(remote.kills(), 1);
        assert!(client.is_closed());
        assert!(locked(&client.reader).is_none(), "the reader thread was taken and joined");
        client.close();
        assert_eq!(remote.kills(), 1, "a second close changes nothing");
    }

    #[test]
    fn workspace_command_is_the_fixed_literal() {
        assert_eq!(
            WORKSPACE,
            "exec \"$HOME/.llmide-server/current/core/bin/llmide-workspace\" --stdio"
        );
    }

    #[test]
    fn capped_line_reads_lines_and_flags_long_ones() {
        let mut reader = BufReader::new(Cursor::new(b"abc\nxxxxxxxx\nz".to_vec()));
        assert!(matches!(read_capped_line(&mut reader, 4).unwrap(), Line::Text(text) if text == b"abc"));
        assert!(matches!(read_capped_line(&mut reader, 4).unwrap(), Line::TooLong));
        let mut partial = BufReader::new(Cursor::new(b"z".to_vec()));
        assert!(matches!(read_capped_line(&mut partial, 4).unwrap(), Line::Eof), "a partial last line is not a message");
    }
}
