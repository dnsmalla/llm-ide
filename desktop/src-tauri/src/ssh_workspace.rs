//! Client for the server's `llmide-workspace` helper: one long-lived `ssh` channel that carries the
//! Explorer's file, git, search and watch commands as JSON lines.
//!
//! [`WorkspaceClient::connect`] starts the helper with the constant [`WORKSPACE`] command, checks its
//! protocol with `hello`, and then answers each request by its id on one reader thread. Events go to the
//! subscribers of their kind. Every spawn takes its own one-time password grant, so a reconnect never
//! reuses an answered grant.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use llmide_workspace_core::wire::{
    read_bounded_line, Answer, Hello, Line, Request, CMD_HELLO, EVENT_CLONE, EVENT_SEARCH, EVENT_WATCH, MAX_LINE_BYTES, PROTOCOL,
};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::ssh_askpass::AskpassGrant;
use crate::ssh_server_scripts::WORKSPACE;
use crate::ssh_transport::{exec_args, SshEndpoint, SshExec, StdioChild};

/// How long a call waits for its answer. A silent helper must not leave the Explorer spinning forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// The longest request body (the line without its newline) this client sends. It is the helper's own cap, so a
/// larger request would only be answered by the helper with an id-0 error that nothing waits for.
const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const TOO_LARGE_CODE: &str = "too_large";
const TOO_LARGE_MESSAGE: &str = "This change is too large to send to the server.";

/// How long `close` waits for the reader thread once the child is killed.
const READER_WAIT: Duration = Duration::from_secs(1);

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

/// The longest server message kept. The message is shown to the user, so a broken or hostile helper cannot flood it.
const MAX_MESSAGE_CHARS: usize = 2_000;

/// The longest server error code kept. Codes are short lowercase words. Anything else is replaced before the
/// shared decoder interns it, so a hostile helper cannot fill the process-wide code table with junk.
const MAX_CODE_CHARS: usize = 40;

/// Shown when a server error has no usable message.
const NO_MESSAGE: &str = "The server reported an error.";

/// The kinds of helper events. The wire names are `search`, `watch` and `clone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    Search,
    Watch,
    Clone,
}

impl EventKind {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            EVENT_SEARCH => Some(Self::Search),
            EVENT_WATCH => Some(Self::Watch),
            EVENT_CLONE => Some(Self::Clone),
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

/// A connection to one server's helper. A writer thread owns the child's stdin and a reader thread owns its
/// stdout. Calls hand their request lines to the writer over a queue, so no caller waits on a pipe, and the child
/// lock is held only for a kill, which therefore never waits on a write.
pub struct WorkspaceClient {
    child: Arc<Mutex<Box<dyn StdioChild>>>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    git: bool,
    /// The request queue. Taken by `close`, which ends the writer once the queue drains.
    outbound: Mutex<Option<Sender<String>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
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
        let git = client
            .call_with_timeout(CMD_HELLO, json!({}), None, CALL_TIMEOUT)
            .map_err(refused_hello)
            .and_then(|value| check_hello(&value));
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
        let stdin = child.take_stdin();
        let stdout = child.take_stdout();
        let child = Arc::new(Mutex::new(child));
        let shared = Arc::new(Shared::default());
        let (outbound, lines) = mpsc::channel();
        let writer = {
            let (shared, child) = (shared.clone(), child.clone());
            std::thread::spawn(move || write_loop(stdin, lines, &shared, &child))
        };
        let reader = {
            let (shared, child) = (shared.clone(), child.clone());
            std::thread::spawn(move || read_loop(stdout, &shared, &child))
        };
        Self {
            child,
            shared,
            next_id: AtomicU64::new(1),
            git: false,
            outbound: Mutex::new(Some(outbound)),
            writer: Mutex::new(Some(writer)),
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
        let line = request_line(id, cmd, args, confirm);
        // Refused before anything is registered or sent, so the channel stays up. The line ends with its newline,
        // which the helper's cap does not count.
        if line.len().saturating_sub(1) > MAX_REQUEST_BYTES {
            return Err(herr(TOO_LARGE_CODE, TOO_LARGE_MESSAGE));
        }
        let (waiter, answer) = mpsc::channel();
        self.shared.register(id, waiter)?;
        // Registered and queued before the wait starts, so the timeout also covers a write that never completes.
        let queued = locked(&self.outbound).as_ref().is_some_and(|queue| queue.send(line).is_ok());
        if !queued {
            break_channel(&self.shared, &self.child);
            return Err(lost());
        }
        match answer.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.shared.forget(id);
                // The helper may still be working on this request and would answer late, out of step with the
                // calls after it. The channel is ended, so the next call starts a fresh helper.
                break_channel(&self.shared, &self.child);
                Err(herr(TIMEOUT_CODE, TIMEOUT_MESSAGE))
            }
            Err(RecvTimeoutError::Disconnected) => Err(lost()),
        }
    }

    /// Registers `sink` for every event of `kind`. The sink runs on the reader thread.
    pub fn subscribe(&self, kind: EventKind, sink: EventSink) {
        locked(&self.shared.subscribers).push((kind, sink));
    }

    /// Whether the helper reported git in `hello`. Only the tests and the live check read it.
    #[cfg(test)]
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
        // Killing first is what unblocks a writer stuck in a write; dropping the queue then ends it.
        break_channel(&self.shared, &self.child);
        drop(locked(&self.outbound).take());
        let handles = [locked(&self.writer).take(), locked(&self.reader).take()];
        for handle in handles.into_iter().flatten() {
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
        match read_bounded_line(&mut *stdout, MAX_LINE_BYTES) {
            Ok(Line::Text(bytes)) if bytes.is_empty() => {}
            Ok(Line::Text(bytes)) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => shared.route(value),
                Err(_) => break,
            },
            // A partial last line is not a message, and an over-long one ends the channel (see above).
            Ok(Line::Eof | Line::Unterminated(_) | Line::TooLong) | Err(_) => break,
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

/// The writer thread: writes queued request lines in order. A write that fails, or a queue that is closed, ends
/// the channel the same way the reader does. A write that blocks is ended by the kill in `break_channel`.
fn write_loop(
    mut stdin: Box<dyn Write + Send>,
    lines: Receiver<String>,
    shared: &Shared,
    child: &Mutex<Box<dyn StdioChild>>,
) {
    for line in lines {
        if stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush()).is_err() {
            break;
        }
    }
    drop(stdin);
    break_channel(shared, child);
}

/// One request as a single JSON line. `confirm` is sent only when the user answered a dialog.
fn request_line(id: u64, cmd: &str, args: Value, confirm: Option<&str>) -> String {
    Request { args, cmd: cmd.to_string(), confirm: confirm.map(|answer| json!(answer)), id }.to_line()
}

/// Reads the answer to `hello`: the protocol must match this build, and `git` is optional. The helper's `version`
/// is left out of the check on purpose; it is kept in the reply for logs.
fn check_hello(value: &Value) -> Result<bool, FsError> {
    match serde_json::from_value::<Hello>(value.clone()) {
        Ok(hello) if hello.protocol == PROTOCOL => Ok(hello.git),
        _ => Err(herr(VERSION_CODE, VERSION_MESSAGE)),
    }
}

/// Turns one helper answer into the call's result: `ok` is the value, `err` is the helper's error.
fn parse_answer(value: &Value) -> Result<Value, FsError> {
    match Answer::parse(value) {
        Answer::Ok(ok) => Ok(ok),
        Answer::Err(err) => Err(decode_error(&err)),
        Answer::Unknown => Err(herr(BAD_ANSWER_CODE, BAD_ANSWER_MESSAGE)),
    }
}

/// Rebuilds the helper's `{code, message}` as an [`FsError`] through the shared crate's deserializer, which
/// interns the code into the same table the desktop's own errors use. The code is checked for shape first; a
/// code that fails the check becomes [`REMOTE_CODE`]. The message is capped, not replaced.
pub(crate) fn decode_error(err: &Value) -> FsError {
    let raw_code = err.get("code").and_then(Value::as_str).unwrap_or_default();
    let code = if is_wire_code(raw_code) { raw_code } else { REMOTE_CODE };
    let message: String = err
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(NO_MESSAGE)
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect();
    serde_json::from_value::<FsError>(json!({"code": code, "message": message}))
        .unwrap_or_else(|_| FsError { code: REMOTE_CODE, message: NO_MESSAGE.to_string() })
}

/// A server code this client will carry: 1 to [`MAX_CODE_CHARS`] lowercase ASCII letters or underscores.
fn is_wire_code(code: &str) -> bool {
    (1..=MAX_CODE_CHARS).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// A helper that predates `hello` answers an unknown command, so a refused `hello` with these codes means the
/// server part is too old, not that the channel is broken.
fn refused_hello(error: FsError) -> FsError {
    if matches!(error.code, "unsupported" | "bad_request") {
        return herr(VERSION_CODE, VERSION_MESSAGE);
    }
    error
}

pub(crate) fn lost() -> FsError {
    herr(LOST_CODE, LOST_MESSAGE)
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

// The fake helper below talks over Unix socket pairs, so the whole test module is Unix-only. The build on Windows
// still compiles without it, which is what the desktop's Windows CI needs.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::ssh_transport::{prepare_endpoint, ForwardChild, SshAuth};
    use crate::remote::RawOutput;
    use std::collections::VecDeque;
    use std::io::{self, BufReader, Write};
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
        reply(id, json!({"version": env!("CARGO_PKG_VERSION"), "protocol": 2, "git": git}))
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
        stdin: Option<UnixStream>,
        stdout: Option<UnixStream>,
        /// The helper's end of the request pipe. Kept here so a silent helper's pipe stays open, and shut down
        /// on kill, which fails a blocked write from the client the way a dead ssh does.
        server_in: Arc<UnixStream>,
        answers: Arc<UnixStream>,
        kills: Arc<AtomicUsize>,
        stopped: bool,
    }

    impl FakeStdio {
        fn new(behave: Behave) -> (Self, Remote) {
            Self::build(Some(behave))
        }

        /// A helper that never reads its stdin and never answers. A write to it blocks once the pipe is full.
        fn silent() -> (Self, Remote) {
            Self::build(None)
        }

        fn build(behave: Option<Behave>) -> (Self, Remote) {
            let (desk_in, server_in) = UnixStream::pair().unwrap();
            let (server_out, desk_out) = UnixStream::pair().unwrap();
            let server_in = Arc::new(server_in);
            let answers = Arc::new(server_out.try_clone().unwrap());
            let (seen, requests) = mpsc::channel();
            if let Some(behave) = behave {
                let input = server_in.try_clone().unwrap();
                std::thread::spawn(move || serve(input, server_out, behave, seen));
            }
            let kills = Arc::new(AtomicUsize::new(0));
            let remote = Remote { requests, answers: answers.clone(), kills: kills.clone() };
            let child = Self {
                stdin: Some(desk_in),
                stdout: Some(desk_out),
                server_in,
                answers,
                kills,
                stopped: false,
            };
            (child, remote)
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
        fn take_stdin(&mut self) -> Box<dyn Write + Send> {
            match self.stdin.take() {
                Some(pipe) => Box::new(pipe),
                None => Box::new(io::sink()),
            }
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
            let _ = self.server_in.shutdown(Shutdown::Both);
            let _ = self.answers.shutdown(Shutdown::Write);
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

    /// The version is shown in logs, not compared: the release copies the helper from the same bundle as the app,
    /// and the bundle's sha check already guarantees the helper is the shipped one. Comparing versions would make
    /// every release that moves the desktop's version refuse its own helper.
    #[test]
    fn hello_version_is_not_compared() {
        let behave: Behave = Box::new(|request: &Value| {
            vec![reply(&request["id"], json!({"version": "9.9.9", "protocol": 2, "git": true}))]
        });
        let (exec, remote) = exec_with(behave);
        let client = WorkspaceClient::connect(&exec, &endpoint(), Path::new(KNOWN), None).expect("the protocol matches");
        assert!(client.git_available());
        assert_eq!(remote.kills(), 0, "an accepted helper is kept");
    }

    #[test]
    fn hello_protocol_mismatch_refused() {
        let behave: Behave = Box::new(|request: &Value| {
            vec![reply(&request["id"], json!({"version": env!("CARGO_PKG_VERSION"), "protocol": 3, "git": true}))]
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
    fn timeout_ends_the_channel_so_the_next_call_reconnects() {
        // The helper may still be working on the timed-out request, and its answer would then match nothing. A
        // channel that timed out cannot be trusted to still be in step, so it is ended, not reused.
        let silent: Behave = Box::new(|request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec![],
        });
        let (client, remote) = connect_ok(silent);
        let error = client
            .call_with_timeout("slow", json!({}), None, Duration::from_millis(50))
            .err()
            .expect("the call times out");
        assert_eq!(error.code, "SSH_TIMEOUT");
        assert_eq!(error.message, "The server did not answer in time.");
        assert_eq!(pending_len(&client), 0, "the timed-out entry is removed");
        assert!(client.is_closed(), "the timed-out channel is ended");
        assert_eq!(remote.kills(), 1, "its helper is killed");
        let later = client.call("after", json!({}), None).err().expect("a later call on this client fails");
        assert_eq!(later.code, "lost_connection");
    }

    #[test]
    fn request_over_the_helper_cap_is_refused_before_it_is_sent() {
        let (client, remote) = connect_ok(echo());
        let big = "x".repeat(MAX_REQUEST_BYTES);
        let error = client.call("big", json!({"data": big}), None).err().expect("refused");
        assert_eq!(error.code, "too_large");
        assert!(!client.is_closed(), "nothing was sent, so the channel stays up");
        assert!(client.call("small", json!({}), None).is_ok());
        assert_eq!(remote.requests.try_iter().filter(|request| request["cmd"] == "big").count(), 0);
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
            _ => vec![json!({"id": request["id"], "err": {"code": "Made-Up!", "message": "x"}}).to_string()],
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

    /// A helper that answers `hello` normally and every other request with the given error code.
    fn failing_with(code: &str) -> Behave {
        let code = code.to_string();
        Box::new(move |request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec![json!({"id": request["id"], "err": {"code": code, "message": "m"}}).to_string()],
        })
    }

    /// A helper that refuses every request, `hello` included, with the given error code.
    fn refusing_everything(code: &str) -> Behave {
        let code = code.to_string();
        Box::new(move |request: &Value| vec![json!({"id": request["id"], "err": {"code": code, "message": "m"}}).to_string()])
    }

    #[test]
    fn ui_branch_codes_survive_the_round_trip() {
        let codes = [
            "not_a_repo",
            "identity_missing",
            "nothing_staged",
            "confirm_required",
            "conflict",
            "git_missing",
            "root_missing",
            "outside_home",
            "root_too_broad",
        ];
        for code in codes {
            let (client, _remote) = connect_ok(failing_with(code));
            let error = client.call("fail", json!({}), None).err().expect("an error");
            assert_eq!(error.code, code, "the UI branches on this code, so it must not change");
        }
    }

    #[test]
    fn malformed_or_long_codes_become_remote_error() {
        let too_long = "a".repeat(41);
        for code in ["Bad-Code!", too_long.as_str()] {
            let (client, _remote) = connect_ok(failing_with(code));
            let error = client.call("fail", json!({}), None).err().expect("an error");
            assert_eq!(error.code, "remote_error", "{code} is not a wire code");
        }
    }

    #[test]
    fn long_server_message_is_capped_not_replaced() {
        let long = "w".repeat(10_000);
        let behave: Behave = Box::new(move |request: &Value| match request["cmd"].as_str() {
            Some("hello") => vec![hello_reply(&request["id"], true)],
            _ => vec![json!({"id": request["id"], "err": {"code": "conflict", "message": long}}).to_string()],
        });
        let (client, _remote) = connect_ok(behave);
        let error = client.call("fail", json!({}), None).err().expect("an error");
        assert_eq!(error.message.chars().count(), 2_000);
        assert!(error.message.chars().all(|c| c == 'w'));
    }

    #[test]
    fn hello_refused_by_an_older_helper_is_a_version_mismatch() {
        for code in ["unsupported", "bad_request"] {
            let (exec, _remote) = exec_with(refusing_everything(code));
            let error = WorkspaceClient::connect(&exec, &endpoint(), Path::new(KNOWN), None).err().expect("refused");
            assert_eq!(error.code, "workspace_version", "an old helper answers hello with {code}");
            assert_eq!(error.message, VERSION_MESSAGE);
        }
    }

    #[test]
    fn stdin_that_never_drains_does_not_hold_up_close() {
        let (child, _remote) = FakeStdio::silent();
        let client = Arc::new(WorkspaceClient::start(Box::new(child)));
        let big = "x".repeat(8 * 1024 * 1024);
        let waiting = {
            let client = client.clone();
            std::thread::spawn(move || client.call_with_timeout("big", json!({"data": big}), None, Duration::from_secs(30)))
        };
        std::thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        client.close();
        assert!(started.elapsed() < Duration::from_secs(2), "close returned while a write was blocked");
        let error = waiting.join().unwrap().err().expect("the blocked call fails");
        assert_eq!(error.code, "lost_connection");
        assert!(client.is_closed());
    }

    #[test]
    fn a_write_that_never_completes_times_out() {
        let (child, _remote) = FakeStdio::silent();
        let client = WorkspaceClient::start(Box::new(child));
        let big = "x".repeat(8 * 1024 * 1024);
        let error = client
            .call_with_timeout("big", json!({"data": big}), None, Duration::from_millis(200))
            .err()
            .expect("the call times out");
        assert_eq!(error.code, "SSH_TIMEOUT", "the 60 s budget covers the write, not only the wait for the answer");
        assert_eq!(pending_len(&client), 0);
        let started = Instant::now();
        client.close();
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
