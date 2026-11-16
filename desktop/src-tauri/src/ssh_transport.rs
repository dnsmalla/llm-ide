//! SSH transport for "SSH server" mode: builds the system `ssh` argv for running the desktop core on a
//! Linux server and reaching it through a port forward.
//!
//! This module only builds argv and validates the endpoint. It spawns nothing. Every option here is a
//! deliberate guard: no agent or X11 forwarding, no local commands from the user's ssh config, and host
//! keys pinned to a known_hosts file the app controls, never the user's ~/.ssh/known_hosts.
//!
//! Password auth carries no secret here: [`SshAuth::Password`] holds no data, so a password can never
//! reach an argv or an environment variable from this module.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::pty::shell_env;
use crate::remote::{valid_host, valid_key_path, valid_user, RawOutput, CONNECT_TIMEOUT_SECS};
use crate::ssh_askpass::AskpassGrant;

/// How the ssh child authenticates. Key auth is non-interactive; password auth lets ssh prompt the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SshAuth {
    /// A private key file. `path` is validated as an absolute path but never read here.
    Key { path: String },
    /// Password or keyboard-interactive login. No secret is stored or passed by this module.
    Password,
}

/// A validated SSH endpoint. Only [`prepare_endpoint`] builds one, so every field is already shape-checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshEndpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

/// Validate the raw endpoint fields before any child process exists.
///
/// Values are checked with the same rules as `remote::prepare`, so an option-like host, user or key path
/// can never become an ssh option.
///
/// Args:
///     host: Hostname or IP literal, trimmed before validation.
///     port: SSH port; 0 is refused.
///     user: Plain user name, trimmed before validation.
///     auth: Key file path (validated) or password (no data to check).
///
/// Returns:
///     The endpoint with trimmed host and user.
///
/// Errors:
///     `invalid_host`, `invalid_port`, `invalid_user` or `invalid_key_path`, each with a fixed code.
pub fn prepare_endpoint(host: &str, port: u16, user: &str, auth: SshAuth) -> Result<SshEndpoint, FsError> {
    let host = host.trim();
    if !valid_host(host) {
        return Err(herr("invalid_host", "enter a hostname or IP address without spaces or a leading '-'"));
    }
    if port == 0 {
        return Err(herr("invalid_port", "the SSH port must be between 1 and 65535"));
    }
    let user = user.trim();
    if !valid_user(user) {
        return Err(herr("invalid_user", "enter a plain SSH user name (letters, digits, '.', '_' or '-')"));
    }
    // Trimmed the same way as `remote::prepare`, and the trimmed value is what gets stored and handed to -i.
    let auth = match auth {
        SshAuth::Key { path } => {
            let path = path.trim().to_string();
            if !valid_key_path(&path) {
                return Err(herr("invalid_key_path", "enter an absolute path to the private key file"));
            }
            SshAuth::Key { path }
        }
        SshAuth::Password => SshAuth::Password,
    };
    Ok(SshEndpoint { host: host.to_string(), port, user: user.to_string(), auth })
}

/// The argv after `ssh` for one remote command: a fixed option list, `user@host`, then the command.
///
/// Forwarding and local commands are switched off, so an ssh config entry cannot open a tunnel or run a
/// program on this machine. `strict` picks the host-key policy: `true` requires the key already in
/// `known_hosts`, `false` learns a new key on first use (for the first contact only).
///
/// Args:
///     ep: A validated endpoint from [`prepare_endpoint`].
///     known_hosts: The app-owned known_hosts file. Its global counterpart is disabled.
///     strict: `true` for `StrictHostKeyChecking=yes`, `false` for `accept-new`.
///     command: A fixed remote command literal. No webview text may reach it.
///
/// Returns:
///     The argv, to be passed to `Command::new("ssh").args(...)` with no shell.
pub fn exec_args(ep: &SshEndpoint, known_hosts: &Path, strict: bool, command: &'static str) -> Vec<String> {
    exec_args_with(ep, known_hosts, strict, command, false)
}

/// The same argv as [`exec_args`] with `-tt`, for a remote command that needs a pty (the SSH terminal).
///
/// Why a separate function: the helper channel is a plain pipe, and a pty on it would turn the JSON lines into
/// echoed, line-edited text. Everything else is identical, so the terminal keeps the same host-key and auth rules.
pub fn exec_args_tty(ep: &SshEndpoint, known_hosts: &Path, strict: bool, command: &'static str) -> Vec<String> {
    exec_args_with(ep, known_hosts, strict, command, true)
}

fn exec_args_with(ep: &SshEndpoint, known_hosts: &Path, strict: bool, command: &'static str, tty: bool) -> Vec<String> {
    // No `-v`: nothing reads ssh's debug output, and it would only add noise to a captured stderr.
    let mut args = vec!["-a".to_string(), "-x".to_string()];
    if tty {
        args.push("-tt".to_string());
    }
    push_option(&mut args, "ForwardAgent=no");
    push_option(&mut args, "ClearAllForwardings=yes");
    push_option(&mut args, "PermitLocalCommand=no");
    push_no_connection_sharing(&mut args);
    push_host_key_options(&mut args, known_hosts, if strict { "yes" } else { "accept-new" });
    push_auth_options(&mut args, ep);
    // Long remote Loop runs sit silent for minutes; keepalives stop idle timeouts and fail a dead link.
    push_option(&mut args, "ServerAliveInterval=30");
    push_option(&mut args, "ServerAliveCountMax=4");
    push_endpoint(&mut args, ep);
    args.push(command.to_string());
    args
}

/// The argv for a background `-L` port forward that runs no remote command.
///
/// The host key is always `StrictHostKeyChecking=yes`: a forward is opened only after the host key is
/// confirmed. `ExitOnForwardFailure=yes` makes a busy local port fail loudly instead of silently
/// forwarding nothing. The forward binds to loopback only.
///
/// Args:
///     ep: A validated endpoint from [`prepare_endpoint`].
///     known_hosts: The app-owned known_hosts file, holding the confirmed key.
///     local_port: Loopback port on this machine.
///     remote_port: Loopback port on the server that the forward targets.
///
/// Returns:
///     The argv after `ssh`. It contains `-N` and no remote command.
///
/// Errors:
///     `invalid_port` when either port is 0. Port 0 would ask ssh for a random port, which the app could
///     not reach or report.
pub fn forward_args(
    ep: &SshEndpoint,
    known_hosts: &Path,
    local_port: u16,
    remote_port: u16,
) -> Result<Vec<String>, FsError> {
    if local_port == 0 || remote_port == 0 {
        return Err(herr("invalid_port", "forward ports must be between 1 and 65535"));
    }
    let mut args = vec!["-N".to_string(), "-a".to_string(), "-x".to_string()];
    push_option(&mut args, "ForwardAgent=no");
    push_option(&mut args, "PermitLocalCommand=no");
    push_no_connection_sharing(&mut args);
    push_option(&mut args, "ExitOnForwardFailure=yes");
    push_host_key_options(&mut args, known_hosts, "yes");
    push_auth_options(&mut args, ep);
    push_option(&mut args, "ServerAliveInterval=30");
    push_option(&mut args, "ServerAliveCountMax=4");
    args.push("-L".to_string());
    args.push(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
    push_endpoint(&mut args, ep);
    Ok(args)
}

/// Appends one `-o <value>` pair.
fn push_option(args: &mut Vec<String>, value: &str) {
    args.push("-o".to_string());
    args.push(value.to_string());
}

/// Turns off connection multiplexing. A `ControlPath` in the user's ssh config would let this command
/// reuse another session's connection, which skips the pinned known_hosts file and the password prompt.
fn push_no_connection_sharing(args: &mut Vec<String>) {
    push_option(args, "ControlMaster=no");
    push_option(args, "ControlPath=none");
}

/// Host-key policy and known_hosts files. The global file is neutralised so a system-wide entry cannot
/// widen what is trusted.
///
/// The path is double-quoted because OpenSSH splits a `UserKnownHostsFile` value on whitespace unless it is
/// quoted; a user name with a space (common on Windows) would otherwise split the path. The caller must not
/// pass a path containing `"` or a newline, which no quoting can carry; `ssh_service::pinned_dir` refuses one.
fn push_host_key_options(args: &mut Vec<String>, known_hosts: &Path, strict_value: &str) {
    push_option(args, &format!("StrictHostKeyChecking={strict_value}"));
    push_option(args, &format!("UserKnownHostsFile=\"{}\"", known_hosts.display()));
    push_option(args, &format!("GlobalKnownHostsFile={}", if cfg!(windows) { "NUL" } else { "/dev/null" }));
    push_option(args, &format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"));
}

/// Key auth stays non-interactive and uses only the named key. Password auth turns the key path off and
/// lets ssh prompt once, so an agent or default key never answers in its place.
fn push_auth_options(args: &mut Vec<String>, ep: &SshEndpoint) {
    match &ep.auth {
        SshAuth::Key { path } => {
            push_option(args, "BatchMode=yes");
            push_option(args, "IdentitiesOnly=yes");
            args.push("-i".to_string());
            args.push(path.clone());
        }
        SshAuth::Password => {
            push_option(args, "BatchMode=no");
            push_option(args, "PreferredAuthentications=password,keyboard-interactive");
            push_option(args, "PubkeyAuthentication=no");
            push_option(args, "NumberOfPasswordPrompts=1");
        }
    }
}

/// Port and `user@host`, the last positional part before any remote command.
fn push_endpoint(args: &mut Vec<String>, ep: &SshEndpoint) {
    args.push("-p".to_string());
    args.push(ep.port.to_string());
    args.push(format!("{}@{}", ep.user, ep.host));
}

/// Runs the system `ssh` for one call, or a fake in tests. Argv always comes from [`exec_args`] or
/// [`forward_args`]; this trait never builds argv itself.
pub trait SshExec: Send + Sync {
    /// Runs the child to completion and captures its output. `stdin` bytes are written and the pipe is
    /// closed; `None` gives the child a null stdin. `askpass` adds the one-time password helper variables.
    /// Every call is bounded by `deadline`. When it expires the child is killed and reaped, and the error kind
    /// is `TimedOut`; a caller maps that to `SSH_TIMEOUT`.
    fn run(
        &self,
        args: &[String],
        stdin: Option<&[u8]>,
        askpass: Option<&AskpassGrant>,
        deadline: Duration,
    ) -> std::io::Result<RawOutput>;

    /// Starts a long-lived child (a port forward) and returns without waiting for it.
    fn spawn_forward(&self, args: &[String], askpass: Option<&AskpassGrant>) -> std::io::Result<Box<dyn ForwardChild>>;

    /// Starts the helper channel: a child with piped stdin and stdout, for the request and answer lines of
    /// `llmide-workspace`. Runners that only serve one-shot calls keep this default, which refuses.
    fn spawn_stdio(&self, _args: &[String], _askpass: Option<&AskpassGrant>) -> std::io::Result<Box<dyn StdioChild>> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "this runner has no helper channel"))
    }
}

/// A child with piped stdin and stdout. Only [`SshExec::spawn_stdio`] builds one.
pub trait StdioChild: Send {
    /// The child's stdin, handed out once so a writer thread can own it. A write blocks while the child does not
    /// read it; killing the child makes that write fail, so nothing that kills waits on the writer. A second call
    /// returns an empty sink.
    fn take_stdin(&mut self) -> Box<dyn Write + Send>;

    /// The child's stdout. It is handed out once; a second call returns an empty reader.
    fn take_stdout(&mut self) -> Box<dyn BufRead + Send>;

    /// Stops the child and waits for it, so no process is left behind. Calling it again is harmless.
    fn kill(&mut self);
}

/// A running forward. Dropping it stops the child.
pub trait ForwardChild: Send {
    /// The exit code once the child has ended, `None` while it still runs.
    fn try_exited(&mut self) -> Option<i32>;

    /// Stops the child and waits for it, so no zombie process remains. Calling it again is harmless.
    fn kill(&mut self);
}

/// Production runner: the system `ssh`, found through PATH like the existing key-only runner.
pub struct SystemSshExec;

impl SshExec for SystemSshExec {
    fn run(
        &self,
        args: &[String],
        stdin: Option<&[u8]>,
        askpass: Option<&AskpassGrant>,
        deadline: Duration,
    ) -> std::io::Result<RawOutput> {
        run_program("ssh", args, stdin, askpass, deadline)
    }

    fn spawn_forward(&self, args: &[String], askpass: Option<&AskpassGrant>) -> std::io::Result<Box<dyn ForwardChild>> {
        Ok(Box::new(spawn_program("ssh", args, askpass)?))
    }

    fn spawn_stdio(&self, args: &[String], askpass: Option<&AskpassGrant>) -> std::io::Result<Box<dyn StdioChild>> {
        Ok(Box::new(spawn_stdio_program("ssh", args, askpass)?))
    }
}

/// The production helper channel: the system `ssh` with stdin and stdout piped. Its stderr is drained and
/// dropped, because ssh's error text can carry server output and must never reach a message or a log.
struct SystemStdioChild {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
}

impl StdioChild for SystemStdioChild {
    fn take_stdin(&mut self) -> Box<dyn Write + Send> {
        match self.stdin.take() {
            Some(pipe) => Box::new(pipe),
            None => Box::new(std::io::sink()),
        }
    }

    fn take_stdout(&mut self) -> Box<dyn BufRead + Send> {
        match self.stdout.take() {
            Some(pipe) => Box::new(BufReader::new(pipe)),
            None => Box::new(std::io::empty()),
        }
    }

    fn kill(&mut self) {
        // An error here means the child has already exited, which is the state `kill` is meant to reach.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for SystemStdioChild {
    fn drop(&mut self) {
        StdioChild::kill(self);
    }
}

/// Starts `program` with piped stdin and stdout for the helper channel. Stderr is drained by a detached thread.
fn spawn_stdio_program(
    program: &str,
    args: &[String],
    askpass: Option<&AskpassGrant>,
) -> std::io::Result<SystemStdioChild> {
    let mut command = child_command(program, args, askpass);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(stderr) = child.stderr.take() {
        drain_to_sink(stderr);
    }
    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(std::io::Error::other("the ssh child has no stdin pipe"));
    };
    let stdout = child.stdout.take();
    Ok(SystemStdioChild { child, stdin: Some(stdin), stdout })
}

/// Reads a pipe to its end on a detached thread and discards the bytes, so the child never blocks on a full pipe.
/// The thread ends when the child closes the pipe. The bytes are never logged.
fn drain_to_sink(mut pipe: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut pipe, &mut std::io::sink());
    });
}

/// The production forward child. Its stderr is drained by a detached thread so ssh never blocks on a full pipe.
struct SystemForwardChild {
    child: Child,
}

impl ForwardChild for SystemForwardChild {
    fn try_exited(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(exit_code(status)),
            Ok(None) => None,
            // An unreadable status means the child can no longer be watched; report it as gone, not alive.
            Err(_) => Some(-1),
        }
    }

    fn kill(&mut self) {
        // An error here means the child has already exited, which is the state `kill` is meant to reach.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for SystemForwardChild {
    fn drop(&mut self) {
        ForwardChild::kill(self);
    }
}

/// One number for an exit status. A death by signal has no exit code, so it becomes `128 + signal`, the
/// shell convention, which keeps it distinct from "still running".
fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    -1
}

/// Builds the child command with a scrubbed environment. `env_clear` first, then only the terminal
/// shell's allowlist (no API keys, no loader or start-up hooks), then the askpass variables. The
/// askpass variables come last because they are the only ones this module adds on purpose.
fn child_command(program: &str, args: &[String], askpass: Option<&AskpassGrant>) -> Command {
    let mut command = Command::new(program);
    command.args(args).env_clear();
    for (key, value) in ssh_child_env(askpass) {
        command.env(key, value);
    }
    command
}

/// The environment of every ssh child: the terminal allowlist of the host's environment, then the askpass
/// variables of one grant. The SSH terminal reuses it, so both paths scrub the same way.
pub(crate) fn ssh_child_env(askpass: Option<&AskpassGrant>) -> Vec<(String, String)> {
    let mut env = shell_env(inherited_env());
    if let Some(grant) = askpass {
        env.extend(grant.env());
    }
    env
}

/// The inherited environment as UTF-8 pairs. `std::env::vars()` panics on the first entry that is not UTF-8.
/// Such an entry cannot be an allowlisted terminal setting anyway, so it is dropped instead.
fn inherited_env() -> impl Iterator<Item = (String, String)> {
    std::env::vars_os().filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
}

/// How long `run_program` waits for the child's output pipes after the child has exited. A pipe held open by a
/// grandchild would otherwise keep a finished call alive.
const DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Pause between `try_wait` polls while a child runs.
const WAIT_POLL: Duration = Duration::from_millis(10);

/// Runs `program` to completion with `args`, capturing stdout and stderr, and gives up at `deadline`.
///
/// Why not `wait_with_output`: a child that never reads its stdin, or keeps stdout open after it exits, would
/// block the caller forever (a stuck remote command holds the ssh channel open). The pipes are drained by
/// reader threads, the child is polled against the deadline, and on expiry it is killed and reaped, so no ssh
/// process is left behind. stderr is captured for the caller and never logged here.
fn run_program(
    program: &str,
    args: &[String],
    stdin: Option<&[u8]>,
    askpass: Option<&AskpassGrant>,
    deadline: Duration,
) -> std::io::Result<RawOutput> {
    let mut command = child_command(program, args, askpass);
    command
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Detached on purpose: a write blocked on a child that never reads ends with an error once the child is
        // killed and its pipe closes. A write error is not ours to report; the exit status says what happened.
        let payload = bytes.to_vec();
        std::thread::spawn(move || {
            let _ = pipe.write_all(&payload);
        });
    }
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);
    let status = wait_until(&mut child, deadline)?;
    let stdout = collect(stdout)?;
    let stderr = collect(stderr)?;
    Ok(RawOutput {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Reads one pipe to its end on a detached thread and sends the bytes back. The thread ends when the pipe closes.
fn drain<R: Read + Send + 'static>(mut pipe: R) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    receiver
}

/// The bytes of one drained pipe. A pipe that does not close within [`DRAIN_GRACE`] is a timeout.
fn collect(receiver: Option<mpsc::Receiver<Vec<u8>>>) -> std::io::Result<Vec<u8>> {
    let Some(receiver) = receiver else {
        return Ok(Vec::new());
    };
    receiver.recv_timeout(DRAIN_GRACE).map_err(|_| timed_out())
}

/// Polls the child until it exits. At `deadline` the child is killed and reaped, and `TimedOut` is returned.
fn wait_until(child: &mut Child, deadline: Duration) -> std::io::Result<ExitStatus> {
    let until = Instant::now() + deadline;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        let now = Instant::now();
        if now >= until {
            // The kill fails only when the child has just exited, which is the state wanted here; wait reaps it.
            let _ = child.kill();
            let _ = child.wait();
            return Err(timed_out());
        }
        std::thread::sleep(WAIT_POLL.min(until - now));
    }
}

fn timed_out() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, "the ssh call did not finish before its deadline")
}

/// Starts `program` without waiting: no stdin, stdout discarded, stderr drained.
fn spawn_program(program: &str, args: &[String], askpass: Option<&AskpassGrant>) -> std::io::Result<SystemForwardChild> {
    let mut command = child_command(program, args, askpass);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(stderr) = child.stderr.take() {
        drain_to_sink(stderr);
    }
    Ok(SystemForwardChild { child })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &str = "/tmp/llmide-known-hosts-test";
    const KEY: &str = "/home/alice/.ssh/id_ed25519";
    const COMMAND: &str = "echo ok";

    fn key_endpoint() -> SshEndpoint {
        prepare_endpoint("example.com", 2222, "alice", SshAuth::Key { path: KEY.into() }).unwrap()
    }

    fn password_endpoint() -> SshEndpoint {
        prepare_endpoint("example.com", 22, "alice", SshAuth::Password).unwrap()
    }

    fn has_option(args: &[String], value: &str) -> bool {
        args.windows(2).any(|w| w[0] == "-o" && w[1] == value)
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn key_auth_is_batch_mode() {
        let args = exec_args(&key_endpoint(), Path::new(KNOWN), true, COMMAND);
        assert!(has_option(&args, "BatchMode=yes"));
        assert!(has_option(&args, "IdentitiesOnly=yes"));
        assert!(has_pair(&args, "-i", KEY));
        assert!(!has_option(&args, "BatchMode=no"));
    }

    #[test]
    fn password_auth_never_batch() {
        let args = exec_args(&password_endpoint(), Path::new(KNOWN), true, COMMAND);
        assert!(has_option(&args, "BatchMode=no"));
        assert!(has_option(&args, "PreferredAuthentications=password,keyboard-interactive"));
        assert!(has_option(&args, "PubkeyAuthentication=no"));
        assert!(has_option(&args, "NumberOfPasswordPrompts=1"));
        assert!(!args.iter().any(|a| a == "-i"), "password auth must not name a key file");
        assert!(!has_option(&args, "BatchMode=yes"));
    }

    #[test]
    fn exec_args_tty_adds_only_the_tty_flags() {
        // The terminal runs ssh with a pty, so it needs `-tt`; every other option is the helper's own, unchanged.
        let plain = exec_args(&key_endpoint(), Path::new(KNOWN), true, COMMAND);
        let tty = exec_args_tty(&key_endpoint(), Path::new(KNOWN), true, COMMAND);
        assert!(!plain.iter().any(|a| a == "-tt"), "the helper channel must not ask for a pty");
        assert!(tty.iter().any(|a| a == "-tt"));
        assert!(!tty.iter().any(|a| a == "-T"));
        let without_tt: Vec<String> = tty.iter().filter(|a| *a != "-tt").cloned().collect();
        assert_eq!(without_tt, plain, "apart from -tt the terminal argv is the strict helper argv");
        assert_eq!(tty.last().map(String::as_str), Some(COMMAND));
    }

    #[test]
    fn exec_blocks_forwarding() {
        let args = exec_args(&key_endpoint(), Path::new(KNOWN), true, COMMAND);
        for flag in ["-a", "-x"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        for opt in ["ForwardAgent=no", "ClearAllForwardings=yes", "PermitLocalCommand=no"] {
            assert!(has_option(&args, opt), "{opt}");
        }
        assert!(has_option(&args, "GlobalKnownHostsFile=/dev/null"));
        assert!(has_option(&args, &format!("UserKnownHostsFile=\"{KNOWN}\"")));
        assert_eq!(args.last().map(String::as_str), Some(COMMAND));
        assert_eq!(args[args.len() - 2], "alice@example.com");
    }

    #[test]
    fn strict_flag() {
        let strict = exec_args(&key_endpoint(), Path::new(KNOWN), true, COMMAND);
        assert!(has_option(&strict, "StrictHostKeyChecking=yes"));
        assert!(!has_option(&strict, "StrictHostKeyChecking=accept-new"));
        let learning = exec_args(&key_endpoint(), Path::new(KNOWN), false, COMMAND);
        assert!(has_option(&learning, "StrictHostKeyChecking=accept-new"));
        assert!(!has_option(&learning, "StrictHostKeyChecking=yes"));
    }

    #[test]
    fn forward_args_shape() {
        let args = forward_args(&key_endpoint(), Path::new(KNOWN), 3457, 3460).unwrap();
        assert!(args.iter().any(|a| a == "-N"));
        assert!(has_pair(&args, "-L", "127.0.0.1:3457:127.0.0.1:3460"));
        assert!(has_option(&args, "ExitOnForwardFailure=yes"));
        assert!(has_option(&args, "ServerAliveInterval=30"));
        assert!(has_option(&args, "ServerAliveCountMax=4"));
        assert!(has_option(&args, "StrictHostKeyChecking=yes"));
        assert!(has_option(&args, "BatchMode=yes"));
        assert!(has_pair(&args, "-i", KEY));
        assert!(!has_option(&args, "ClearAllForwardings=yes"), "a forward must not clear its own -L");
        assert_eq!(args.last().map(String::as_str), Some("alice@example.com"), "no remote command after the target");
    }

    #[test]
    fn rejects_option_like_values() {
        let key = || SshAuth::Key { path: KEY.into() };
        assert_eq!(prepare_endpoint("-oProxyCommand=x", 22, "alice", key()).unwrap_err().code, "invalid_host");
        assert_eq!(prepare_endpoint("example.com", 22, "-l", key()).unwrap_err().code, "invalid_user");
        assert_eq!(prepare_endpoint("example.com", 0, "alice", key()).unwrap_err().code, "invalid_port");
        assert_eq!(
            prepare_endpoint("example.com", 22, "alice", SshAuth::Key { path: "-oProxyCommand=x".into() })
                .unwrap_err()
                .code,
            "invalid_key_path"
        );
    }

    #[test]
    fn no_connection_sharing() {
        // A ControlMaster in the user's ssh config could hand this connection to another session and skip
        // the pinned known_hosts file and the password prompt, so both builders switch it off.
        let key = key_endpoint();
        let password = password_endpoint();
        for ep in [&key, &password] {
            let exec = exec_args(ep, Path::new(KNOWN), true, COMMAND);
            let forward = forward_args(ep, Path::new(KNOWN), 3457, 3460).unwrap();
            for args in [&exec, &forward] {
                assert!(has_option(args, "ControlMaster=no"));
                assert!(has_option(args, "ControlPath=none"));
            }
        }
    }

    #[test]
    fn forward_rejects_port_zero() {
        let ep = key_endpoint();
        assert_eq!(forward_args(&ep, Path::new(KNOWN), 0, 3460).unwrap_err().code, "invalid_port");
        assert_eq!(forward_args(&ep, Path::new(KNOWN), 3457, 0).unwrap_err().code, "invalid_port");
    }

    #[test]
    fn key_path_is_trimmed() {
        let ep = prepare_endpoint("example.com", 22, "alice", SshAuth::Key { path: format!(" {KEY} ") }).unwrap();
        let args = exec_args(&ep, Path::new(KNOWN), true, COMMAND);
        assert!(has_pair(&args, "-i", KEY), "the trimmed path must be the one handed to -i");
        // Trimming must not let an option-like value through after the spaces are removed.
        let err = prepare_endpoint("example.com", 22, "alice", SshAuth::Key { path: " -oProxyCommand=x ".into() });
        assert_eq!(err.unwrap_err().code, "invalid_key_path");
    }

    /// Sets an environment variable for one test and restores the previous value on drop, so no test leaves
    /// state behind for the others in the same process.
    struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn no_verbose_flag_in_any_argv() {
        // `-v` makes ssh write its debug log to stderr; nothing reads it, and it would bloat a captured error.
        let key = key_endpoint();
        let password = password_endpoint();
        for ep in [&key, &password] {
            let exec = exec_args(ep, Path::new(KNOWN), true, COMMAND);
            let forward = forward_args(ep, Path::new(KNOWN), 3457, 3460).unwrap();
            for args in [&exec, &forward] {
                assert!(!args.iter().any(|a| a == "-v"), "-v found in {args:?}");
            }
        }
    }

    #[test]
    fn known_hosts_path_with_a_space_is_one_option_value() {
        // OpenSSH splits an unquoted `UserKnownHostsFile` value on whitespace, so the quotes keep the path whole.
        let path = Path::new("/tmp/llmide spaced dir/known_hosts");
        let args = exec_args(&key_endpoint(), path, true, COMMAND);
        let values: Vec<&String> = args.iter().filter(|a| a.starts_with("UserKnownHostsFile=")).collect();
        assert_eq!(values.len(), 1, "exactly one UserKnownHostsFile option");
        assert_eq!(values[0], "UserKnownHostsFile=\"/tmp/llmide spaced dir/known_hosts\"");
    }

    #[cfg(unix)]
    #[test]
    fn ssh_parses_a_quoted_known_hosts_path_with_a_space() {
        // `ssh -G` prints the parsed configuration without connecting. An unquoted or mis-quoted value fails here.
        let path = Path::new("/tmp/llmide spaced dir/known_hosts");
        let mut argv = vec!["-G".to_string()];
        let args = exec_args(&key_endpoint(), path, true, COMMAND);
        argv.extend(args[..args.len() - 1].iter().cloned());
        let Ok(output) = std::process::Command::new("ssh").args(&argv).stdin(Stdio::null()).output() else {
            eprintln!("ssh is not installed; the parse check is skipped");
            return;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "ssh -G rejected the argv: {}", String::from_utf8_lossy(&output.stderr));
        assert!(
            stdout.lines().any(|l| l == "userknownhostsfile /tmp/llmide spaced dir/known_hosts"),
            "ssh did not keep the path whole: {stdout}"
        );
    }

    #[cfg(unix)]
    mod runner {
        use super::super::{run_program, spawn_program, spawn_stdio_program, ForwardChild, StdioChild};
        use std::io::BufRead;
        use super::EnvGuard;
        use crate::ssh_askpass;
        use std::os::unix::ffi::OsStrExt;
        use std::time::{Duration, Instant};

        const LONG: Duration = Duration::from_secs(60);

        fn sh(script: &str) -> Vec<String> {
            vec!["-c".to_string(), script.to_string()]
        }

        #[test]
        fn stdin_reaches_child() {
            let out = run_program("/bin/sh", &sh("cat"), Some(b"abc"), None, LONG).unwrap();
            assert_eq!(out.code, Some(0));
            assert_eq!(out.stdout, "abc");
        }

        #[test]
        fn large_stdin_does_not_deadlock() {
            // The child echoes stdin into a full stdout pipe; writing stdin before reading stdout would hang.
            let payload = vec![b'x'; 512 * 1024];
            let out = run_program("/bin/sh", &sh("cat"), Some(&payload), None, LONG).unwrap();
            assert_eq!(out.stdout.len(), payload.len());
        }

        #[test]
        fn env_is_scrubbed() {
            let _key = EnvGuard::set("ANTHROPIC_API_KEY", "sk-test-do-not-leak");
            let out = run_program("/bin/sh", &sh("env"), None, None, LONG).unwrap();
            assert!(!out.stdout.contains("ANTHROPIC_API_KEY"), "the API key reached the ssh child");
            assert!(!out.stdout.contains("sk-test-do-not-leak"));
        }

        #[test]
        fn non_utf8_env_does_not_panic_and_is_not_passed() {
            // `LC_` names pass the allowlist, so only the UTF-8 check keeps the bad value out of the child.
            let bad = std::ffi::OsStr::from_bytes(b"\xff\xfe");
            let _bad = EnvGuard::set("LC_LLMIDE_BAD", bad);
            let _good = EnvGuard::set("LC_LLMIDE_OK", "yes");
            let out = run_program("/bin/sh", &sh("env"), None, None, LONG).unwrap();
            assert!(!out.stdout.contains("LC_LLMIDE_BAD"), "a non-UTF-8 value reached the child");
            assert!(out.stdout.lines().any(|l| l == "LC_LLMIDE_OK=yes"), "a valid allowlisted value was dropped");
        }

        #[test]
        fn askpass_env_is_passed() {
            let grant = ssh_askpass::grant("unused-test-secret").unwrap();
            let out = run_program("/bin/sh", &sh("env"), None, Some(&grant), LONG).unwrap();
            for (name, value) in grant.env() {
                let line = format!("{name}={value}");
                assert!(out.stdout.lines().any(|l| l == line), "{name} missing from the child environment");
            }
        }

        #[test]
        fn child_that_outlives_its_deadline_is_killed_and_reported_as_timed_out() {
            // The script records its own pid first; `exec` makes that pid the sleep itself, so the pid tells us
            // whether the process is still there after the call returns.
            let dir = crate::remote::temp_ssh_dir("timeout-test").unwrap();
            let pid_file = dir.join("pid");
            let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());
            let started = Instant::now();
            let err = run_program("/bin/sh", &sh(&script), None, None, Duration::from_millis(1500)).unwrap_err();
            assert!(started.elapsed() < Duration::from_secs(5), "the call did not return at its deadline");
            assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
            let pid = std::fs::read_to_string(&pid_file).expect("the child wrote its pid before the deadline");
            let alive = std::process::Command::new("/bin/kill")
                .args(["-0", pid.trim()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(!alive, "the timed-out child is still running");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn stdin_ignored_child_is_bounded_too() {
            // A child that never reads a large stdin would block a plain write forever.
            let payload = vec![b'x'; 8 * 1024 * 1024];
            let started = Instant::now();
            let err = run_program("/bin/sh", &sh("exec sleep 30"), Some(&payload), None, Duration::from_millis(300))
                .unwrap_err();
            assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        #[test]
        fn stdio_child_carries_lines_and_dies_on_kill() {
            let mut child = spawn_stdio_program("/bin/sh", &sh("cat"), None).unwrap();
            let mut stdin = child.take_stdin();
            stdin.write_all(b"ping\n").unwrap();
            let mut stdout = child.take_stdout();
            let mut line = String::new();
            stdout.read_line(&mut line).unwrap();
            assert_eq!(line, "ping\n");
            child.kill();
            // The child is dead once its stdout reaches end of file, so nothing is left reading or writing.
            let mut rest = String::new();
            assert_eq!(stdout.read_line(&mut rest).unwrap(), 0, "the child closed its stdout");
            child.kill();
        }

        #[test]
        fn forward_child_kill() {
            let mut child = spawn_program("/bin/sh", &sh("exec sleep 30"), None).unwrap();
            assert_eq!(child.try_exited(), None);
            child.kill();
            assert!(child.try_exited().is_some());
        }
    }
}
