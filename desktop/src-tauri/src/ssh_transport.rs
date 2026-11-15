//! SSH transport for "SSH server" mode: builds the system `ssh` argv for running the desktop core on a
//! Linux server and reaching it through a port forward.
//!
//! This module only builds argv and validates the endpoint. It spawns nothing. Every option here is a
//! deliberate guard: no agent or X11 forwarding, no local commands from the user's ssh config, and host
//! keys pinned to a known_hosts file the app controls, never the user's ~/.ssh/known_hosts.
//!
//! Password auth carries no secret here: [`SshAuth::Password`] holds no data, so a password can never
//! reach an argv or an environment variable from this module.

use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};

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
    let mut args = vec!["-v".to_string(), "-a".to_string(), "-x".to_string()];
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
fn push_host_key_options(args: &mut Vec<String>, known_hosts: &Path, strict_value: &str) {
    push_option(args, &format!("StrictHostKeyChecking={strict_value}"));
    push_option(args, &format!("UserKnownHostsFile={}", known_hosts.display()));
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
    fn run(&self, args: &[String], stdin: Option<&[u8]>, askpass: Option<&AskpassGrant>) -> std::io::Result<RawOutput>;

    /// Starts a long-lived child (a port forward) and returns without waiting for it.
    fn spawn_forward(&self, args: &[String], askpass: Option<&AskpassGrant>) -> std::io::Result<Box<dyn ForwardChild>>;
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
    fn run(&self, args: &[String], stdin: Option<&[u8]>, askpass: Option<&AskpassGrant>) -> std::io::Result<RawOutput> {
        run_program("ssh", args, stdin, askpass)
    }

    fn spawn_forward(&self, args: &[String], askpass: Option<&AskpassGrant>) -> std::io::Result<Box<dyn ForwardChild>> {
        Ok(Box::new(spawn_program("ssh", args, askpass)?))
    }
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
    for (key, value) in shell_env(std::env::vars()) {
        command.env(key, value);
    }
    if let Some(grant) = askpass {
        for (key, value) in grant.env() {
            command.env(key, value);
        }
    }
    command
}

/// Runs `program` to completion with `args`, capturing stdout and stderr.
///
/// The stdin bytes are written on a scoped thread while `wait_with_output` drains stdout and stderr, so a
/// child that echoes a large input cannot deadlock on a full stdout pipe. stderr is captured for the
/// caller and never logged here.
fn run_program(
    program: &str,
    args: &[String],
    stdin: Option<&[u8]>,
    askpass: Option<&AskpassGrant>,
) -> std::io::Result<RawOutput> {
    let mut command = child_command(program, args, askpass);
    command
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdin_pipe = child.stdin.take();
    let output = std::thread::scope(|scope| {
        if let (Some(bytes), Some(mut pipe)) = (stdin, stdin_pipe) {
            // A write error (the child exited early) is not ours to report; the exit status says what happened.
            scope.spawn(move || {
                let _ = pipe.write_all(bytes);
            });
        }
        child.wait_with_output()
    })?;
    Ok(RawOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Starts `program` without waiting: no stdin, stdout discarded, stderr drained.
fn spawn_program(program: &str, args: &[String], askpass: Option<&AskpassGrant>) -> std::io::Result<SystemForwardChild> {
    let mut command = child_command(program, args, askpass);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(mut stderr) = child.stderr.take() {
        // Detached on purpose: the thread ends when the child closes stderr. Its bytes are never logged.
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
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
    fn exec_blocks_forwarding() {
        let args = exec_args(&key_endpoint(), Path::new(KNOWN), true, COMMAND);
        for flag in ["-a", "-x"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        for opt in ["ForwardAgent=no", "ClearAllForwardings=yes", "PermitLocalCommand=no"] {
            assert!(has_option(&args, opt), "{opt}");
        }
        assert!(has_option(&args, "GlobalKnownHostsFile=/dev/null"));
        assert!(has_option(&args, &format!("UserKnownHostsFile={KNOWN}")));
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

    #[cfg(unix)]
    mod runner {
        use super::super::{run_program, spawn_program, ForwardChild};
        use crate::ssh_askpass;

        fn sh(script: &str) -> Vec<String> {
            vec!["-c".to_string(), script.to_string()]
        }

        #[test]
        fn stdin_reaches_child() {
            let out = run_program("/bin/sh", &sh("cat"), Some(b"abc"), None).unwrap();
            assert_eq!(out.code, Some(0));
            assert_eq!(out.stdout, "abc");
        }

        #[test]
        fn large_stdin_does_not_deadlock() {
            // The child echoes stdin into a full stdout pipe; writing stdin before reading stdout would hang.
            let payload = vec![b'x'; 512 * 1024];
            let out = run_program("/bin/sh", &sh("cat"), Some(&payload), None).unwrap();
            assert_eq!(out.stdout.len(), payload.len());
        }

        #[test]
        fn env_is_scrubbed() {
            std::env::set_var("ANTHROPIC_API_KEY", "sk-test-do-not-leak");
            let out = run_program("/bin/sh", &sh("env"), None, None).unwrap();
            assert!(!out.stdout.contains("ANTHROPIC_API_KEY"), "the API key reached the ssh child");
            assert!(!out.stdout.contains("sk-test-do-not-leak"));
        }

        #[test]
        fn askpass_env_is_passed() {
            let grant = ssh_askpass::grant("unused-test-secret").unwrap();
            let out = run_program("/bin/sh", &sh("env"), None, Some(&grant)).unwrap();
            for (name, value) in grant.env() {
                let line = format!("{name}={value}");
                assert!(out.stdout.lines().any(|l| l == line), "{name} missing from the child environment");
            }
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
