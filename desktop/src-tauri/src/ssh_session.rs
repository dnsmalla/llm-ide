//! Connects the desktop to a core on a Linux server over the system `ssh`.
//!
//! The steps run in a fixed order: confirmed host key, PROBE, STATUS, INSTALL when the server lacks
//! this release, STOP and START, then a `-L` forward and a `/health` check that must echo the nonce
//! START returned. Every server command is a constant from `ssh_server_scripts`; no step builds a
//! shell command from data.

use std::io::Write;
#[cfg(not(test))]
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::confirm::herr;
use crate::core_host::{ct_eq, random_nonce};
use crate::fs_ops::FsError;
use crate::remote::RawOutput;
use crate::ssh_askpass::{grant, AskpassGrant};
use crate::ssh_server_scripts::{
    check_probe, install_stdin, parse_core_state, parse_probe, parse_start_failure, parse_stop, start_stdin,
    valid_version, ClaudeState, CoreState, Probe, INSTALL, PROBE, ROLLBACK, START, STATUS, STOP, UNINSTALL,
};
use crate::ssh_transport::{forward_args, exec_args, ForwardChild, SshAuth, SshEndpoint, SshExec};

/// The local ports the forward may use. 3456 is the local core's port; the others let a connect proceed
/// while the local core is running.
#[cfg(not(test))]
const LOCAL_PORTS: std::ops::RangeInclusive<u16> = 3456..=3459;

/// The message for a running core that this desktop did not start. Shared with `ssh_service`, which shows it
/// on Stop and Uninstall, so the wording the user sees is the same in every path.
pub(crate) const FOREIGN_CORE_CODE: &str = "SSH_CORE_FOREIGN";
pub(crate) const FOREIGN_CORE_MESSAGE: &str = "Another computer started the server on this account.";

/// Time limit per remote script. Most scripts are quick. START waits for the core's own health check, UNINSTALL
/// removes releases on a disk that may be slow, and INSTALL uploads a bundle of about 200 MB over a slow link.
const SCRIPT_DEADLINE: Duration = Duration::from_secs(60);
const START_DEADLINE: Duration = Duration::from_secs(90);
const UNINSTALL_DEADLINE: Duration = Duration::from_secs(120);
const INSTALL_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// The time limit for one remote script, by its constant.
fn deadline_for(command: &str) -> Duration {
    match command {
        INSTALL => INSTALL_DEADLINE,
        START => START_DEADLINE,
        UNINSTALL => UNINSTALL_DEADLINE,
        _ => SCRIPT_DEADLINE,
    }
}

/// How often `/health` is polled through the forward while the core starts.
const HEALTH_POLL: Duration = Duration::from_millis(250);

/// Everything `connect` needs. Borrowed, because the caller owns the secrets and the bundle path.
pub struct ConnectInput<'a> {
    pub endpoint: &'a SshEndpoint,
    pub password: Option<&'a str>,
    pub bundle: &'a Path,
    pub version: &'a str,
    pub secrets_payload: &'a [u8],
    /// The pinned one-key known_hosts file. `None` means the host key was never confirmed.
    pub known_hosts: Option<&'a Path>,
    /// The desktop's last-session record (`ssh-session.json`).
    pub session_file: &'a Path,
    pub health_timeout: Duration,
}

/// A running, verified connection. Dropping `forward` does not stop it; call `kill` first.
pub struct Connected {
    pub local_url: String,
    pub local_port: u16,
    /// Read by the tests that check the port came from STATUS; the service never needs it.
    #[cfg(test)]
    pub remote_port: u16,
    pub nonce: String,
    pub version: String,
    pub claude: ClaudeState,
    pub forward: Box<dyn ForwardChild>,
}

/// The core as the server reported it, after START or STATUS.
struct RunningCore {
    port: u16,
    nonce: String,
    version: String,
}

/// The desktop's record of the core it started. Stored 0600; the nonce is the only proof of ownership.
#[derive(Serialize, Deserialize)]
struct SessionRecord {
    host: String,
    port: u16,
    user: String,
    nonce: String,
}

/// One remote command at a time, with the ssh arguments and askpass decided in one place.
pub(crate) struct Link<'a> {
    pub(crate) exec: &'a dyn SshExec,
    pub(crate) endpoint: &'a SshEndpoint,
    pub(crate) known_hosts: &'a Path,
    pub(crate) password: Option<&'a str>,
}

impl Link<'_> {
    /// Runs one fixed remote command with strict host-key checking, bounded by [`deadline_for`].
    pub(crate) fn run(&self, command: &'static str, stdin: Option<&[u8]>) -> Result<RawOutput, FsError> {
        let args = exec_args(self.endpoint, self.known_hosts, true, command);
        let grant = self.askpass()?;
        let output = self
            .exec
            .run(&args, stdin, grant.as_ref(), deadline_for(command))
            .map_err(transport_error)?;
        transport_check(output)
    }

    /// A fresh one-time grant per ssh process, because each grant answers exactly one prompt.
    fn askpass(&self) -> Result<Option<AskpassGrant>, FsError> {
        match (&self.endpoint.auth, self.password) {
            (SshAuth::Password, Some(secret)) => grant(secret)
                .map(Some)
                .map_err(|e| herr("SSH_AUTH_FAILED", format!("could not prepare the password prompt: {e}"))),
            _ => Ok(None),
        }
    }
}

/// [`connect`] with the local port chooser injected, so tests do not depend on this machine's ports.
pub(crate) fn connect_with(
    exec: &dyn SshExec,
    health: &dyn Fn(u16) -> Option<String>,
    input: ConnectInput<'_>,
    pick_port: &dyn Fn() -> Option<u16>,
) -> Result<Connected, FsError> {
    let known_hosts = input
        .known_hosts
        .ok_or_else(|| herr("SSH_HOST_KEY_UNCONFIRMED", "confirm the server's host key before connecting"))?;
    check_inputs(&input)?;
    // Picked before any ssh call, so a machine with no free port changes nothing on the server.
    let local_port = pick_port()
        .ok_or_else(|| herr("SSH_NO_LOCAL_PORT", "no local port in 3456..=3459 is free for the forward"))?;
    let link = Link { exec, endpoint: input.endpoint, known_hosts, password: input.password };

    let probe = parse_probe(&link.run(PROBE, None)?.stdout)?;
    check_probe(&probe)?;
    let status = parse_core_state(&link.run(STATUS, None)?.stdout)?;
    let (core, replacement) = ensure_core(&link, &input, &probe, &status)?;

    write_session(input.session_file, input.endpoint, &core.nonce)?;
    let (mut forward, _grant) = open_forward(&link, local_port, core.port)?;
    if let Err(e) = wait_for_core(&mut *forward, health, local_port, &core.nonce, input.health_timeout) {
        forward.kill();
        if let Some(replacement) = replacement.as_ref().filter(|_| is_start_failure(&e)) {
            fail_update(&link, &input, replacement);
        }
        return Err(e);
    }
    Ok(Connected {
        local_url: format!("http://127.0.0.1:{local_port}"),
        local_port,
        #[cfg(test)]
        remote_port: core.port,
        nonce: core.nonce,
        version: core.version,
        claude: probe.claude,
        forward,
    })
}

/// What a replacement changed on the server. `previous` is the release `current` pointed at before the
/// install. It is set only when the install switched `current` away from it, which is the only case a
/// failed start has to undo.
struct Replacement {
    was_running: bool,
    previous: Option<String>,
}

/// Makes the server run `input.version`, installing and restarting only when it does not already. Returns
/// the core and, when this call started one, what that start replaced.
fn ensure_core(
    link: &Link<'_>,
    input: &ConnectInput<'_>,
    probe: &Probe,
    status: &CoreState,
) -> Result<(RunningCore, Option<Replacement>), FsError> {
    let already_running = status.running && status.version.as_deref() == Some(input.version);
    if status.running {
        require_ours(status, input.session_file, input.endpoint)?;
    }
    let previous = install_if_needed(link, input, probe)?;
    if already_running {
        return Ok((running_core(status)?, None));
    }
    let replacement = Replacement { was_running: status.running, previous };
    let core = replace_core(link, input, &replacement)?;
    Ok((core, Some(replacement)))
}

/// Uploads the release when `current` is another version. Returns the release `current` pointed at before,
/// which is `None` when nothing was switched away from.
fn install_if_needed(link: &Link<'_>, input: &ConnectInput<'_>, probe: &Probe) -> Result<Option<String>, FsError> {
    if probe.current.as_deref() == Some(input.version) {
        return Ok(None);
    }
    install_core(link, input.bundle, input.version)?;
    Ok(probe.current.clone())
}

/// Only a core that never answered (`SSH_START_FAILED`) is grounds for rolling back. A forward or ssh
/// failure is a local problem, and reverting a working release over it would be wrong.
fn is_start_failure(error: &FsError) -> bool {
    error.code == "SSH_START_FAILED"
}

/// Refuses inputs that would otherwise reach ssh or the server in a useless state.
fn check_inputs(input: &ConnectInput<'_>) -> Result<(), FsError> {
    if !valid_version(input.version) {
        return Err(herr("invalid_version", "the core version is not a valid release name"));
    }
    // Without a grant, ssh would try a terminal prompt that the desktop app does not have.
    if matches!(input.endpoint.auth, SshAuth::Password) && input.password.is_none() {
        return Err(herr("SSH_AUTH_FAILED", "enter the server password to connect"));
    }
    Ok(())
}

/// Maps a failure to run ssh: a deadline expiry is its own code, anything else means ssh could not be started or
/// was cut off.
fn transport_error(error: std::io::Error) -> FsError {
    if error.kind() == std::io::ErrorKind::TimedOut {
        herr("SSH_TIMEOUT", "The server did not answer in time.")
    } else {
        herr("SSH_UNREACHABLE", format!("could not start ssh: {error}"))
    }
}

/// Maps an ssh transport failure (exit 255, or no exit code) to a fixed error. Other exit codes belong
/// to the remote script, which the caller reads through its markers.
fn transport_check(output: RawOutput) -> Result<RawOutput, FsError> {
    match output.code {
        Some(255) | None => {
            if output.stderr.contains("Host key verification failed")
                || output.stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
            {
                // Checked first: a changed key also exits 255, and must not read as an unreachable server.
                Err(herr(
                    "SSH_HOST_KEY_CHANGED",
                    "The server's host key changed. Test the connection again and confirm the new fingerprint.",
                ))
            } else if output.stderr.contains("Permission denied") {
                // The exact sentence is part of the contract; stderr is never shown, as it can echo the login.
                Err(herr("SSH_AUTH_FAILED", "The server refused this login."))
            } else {
                Err(herr("SSH_UNREACHABLE", "could not reach the server over ssh"))
            }
        }
        Some(_) => Ok(output),
    }
}

/// The first free local port in `LOCAL_PORTS`. The probe listener is dropped at once, so the port is
/// free only as a best guess; the forward's own bind is what decides.
#[cfg(not(test))]
pub(crate) fn pick_local_port() -> Option<u16> {
    LOCAL_PORTS.clone().find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

/// Stops the running core when a new release replaces it, then starts the new one. A failed start with an
/// install behind it is undone, so `current` points at the release that worked before.
fn replace_core(link: &Link<'_>, input: &ConnectInput<'_>, replacement: &Replacement) -> Result<RunningCore, FsError> {
    if replacement.was_running {
        stop_core(link)?;
    }
    let started = start_core(link, input, input.version, !replacement.was_running);
    if matches!(&started, Err(e) if is_start_failure(e)) {
        fail_update(link, input, replacement);
    }
    started
}

/// Undoes a failed update: stop the new core, repoint `current` at the previous release, and when a core was
/// running before, start that release again. Best effort, because the caller reports the start failure.
fn fail_update(link: &Link<'_>, input: &ConnectInput<'_>, replacement: &Replacement) {
    let Some(previous) = replacement.previous.as_deref() else {
        return;
    };
    roll_back(link);
    if replacement.was_running {
        if let Ok(core) = start_core(link, input, previous, false) {
            let _ = write_session(input.session_file, input.endpoint, &core.nonce);
        }
    }
}

/// Starts `version` with a fresh nonce. START may hand back a core that was already live, so the port and
/// version are taken from what START printed, never from what was sent.
///
/// `expect_our_nonce` is set when the STATUS before this call said no core was running. Then the core START
/// answers must carry the nonce just sent. A different nonce means another desktop started a core between
/// STATUS and START, and that core is refused rather than adopted as ours.
fn start_core(
    link: &Link<'_>,
    input: &ConnectInput<'_>,
    version: &str,
    expect_our_nonce: bool,
) -> Result<RunningCore, FsError> {
    let nonce = random_nonce().map_err(|e| herr("SSH_START_FAILED", e))?;
    let stdin = start_stdin(version, &nonce, input.secrets_payload);
    let output = link.run(START, Some(&stdin))?;
    if let Some((value, log)) = parse_start_failure(&output.stdout) {
        let detail = log.map(|line| format!(": {line}")).unwrap_or_default();
        return Err(herr("SSH_START_FAILED", format!("the server could not start the core ({value}){detail}")));
    }
    if output.code != Some(0) {
        return Err(herr("SSH_START_FAILED", "the server did not start the core"));
    }
    let core = running_core(&parse_core_state(&output.stdout)?)?;
    if expect_our_nonce && !ct_eq(&core.nonce, &nonce) {
        return Err(herr(FOREIGN_CORE_CODE, FOREIGN_CORE_MESSAGE));
    }
    Ok(core)
}

/// The port, nonce and version of a running core. Anything less is not a core this app can connect to.
fn running_core(state: &CoreState) -> Result<RunningCore, FsError> {
    match (state.running, state.port, &state.nonce, &state.version) {
        (true, Some(port), Some(nonce), Some(version)) => Ok(RunningCore {
            port,
            nonce: nonce.clone(),
            version: version.clone(),
        }),
        _ => Err(herr("SSH_START_FAILED", "the server did not report a running core")),
    }
}

/// Uploads the release when the server's `current` is another version. INSTALL verifies the checksum
/// on the server, so a corrupted upload is refused there rather than run.
fn install_core(link: &Link<'_>, bundle: &Path, version: &str) -> Result<(), FsError> {
    let tarball = std::fs::read(bundle)
        .map_err(|e| herr("SSH_INSTALL_FAILED", format!("could not read the core bundle: {e}")))?;
    let stdin = install_stdin(version, &hex_sha256(&tarball), &tarball);
    let output = link.run(INSTALL, Some(&stdin))?;
    if output.code != Some(0) {
        return Err(herr("SSH_INSTALL_FAILED", "the server could not install the core"));
    }
    Ok(())
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Refuses a running core this desktop did not start. The record must name this endpoint and the nonce
/// STATUS reports; anything else may be someone else's core, and it is left alone. A core that is not running
/// is nobody's, so there is nothing to refuse.
pub(crate) fn require_ours(status: &CoreState, session_file: &Path, endpoint: &SshEndpoint) -> Result<(), FsError> {
    if !status.running {
        return Ok(());
    }
    let record = read_session(session_file);
    let is_ours = record.is_some_and(|r| {
        r.host.eq_ignore_ascii_case(&endpoint.host)
            && r.port == endpoint.port
            && r.user == endpoint.user
            && status.nonce.as_deref().is_some_and(|nonce| ct_eq(&r.nonce, nonce))
    });
    if is_ours {
        Ok(())
    } else {
        Err(herr(FOREIGN_CORE_CODE, FOREIGN_CORE_MESSAGE))
    }
}

fn stop_core(link: &Link<'_>) -> Result<(), FsError> {
    parse_stop(&link.run(STOP, None)?.stdout).map(|_| ())
}

/// Best effort after a failed replacement. The caller already reports the start failure, so an error
/// here must not replace it.
fn roll_back(link: &Link<'_>) {
    let _ = stop_core(link);
    let _ = link.run(ROLLBACK, None);
}

/// Records the core this desktop started. Written after START so the nonce is the one the core runs
/// with, and before the forward so a later connect can recognise the core even if this one fails.
pub(crate) fn write_session(path: &Path, endpoint: &SshEndpoint, nonce: &str) -> Result<(), FsError> {
    let record = SessionRecord {
        host: endpoint.host.clone(),
        port: endpoint.port,
        user: endpoint.user.clone(),
        nonce: nonce.to_string(),
    };
    let json = serde_json::to_string(&record).map_err(|e| herr("session_record_failed", e.to_string()))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| herr("session_record_failed", format!("could not create the session folder: {e}")))?;
    }
    write_private(path, json.as_bytes())
}

fn read_session(path: &Path) -> Option<SessionRecord> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Writes a file readable by this user only. The mode is set on the open handle too, so a file that
/// already existed with looser permissions is tightened.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), FsError> {
    let failed = |e: std::io::Error| herr("session_record_failed", format!("could not write the session record: {e}"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(failed)?;
    }
    file.write_all(bytes).map_err(failed)
}

/// Starts the `-L` forward. The returned grant must outlive the password prompt, so the caller holds it
/// until `/health` answers.
pub(crate) fn open_forward(
    link: &Link<'_>,
    local_port: u16,
    remote_port: u16,
) -> Result<(Box<dyn ForwardChild>, Option<AskpassGrant>), FsError> {
    let args = forward_args(link.endpoint, link.known_hosts, local_port, remote_port)?;
    let grant = link.askpass()?;
    let child = link
        .exec
        .spawn_forward(&args, grant.as_ref())
        .map_err(|e| herr("SSH_FORWARD_FAILED", format!("could not start the port forward: {e}")))?;
    Ok((child, grant))
}

/// Polls `/health` through the forward until it answers with the started nonce, the forward exits, or
/// `timeout` passes.
pub(crate) fn wait_for_core(
    forward: &mut dyn ForwardChild,
    health: &dyn Fn(u16) -> Option<String>,
    local_port: u16,
    nonce: &str,
    timeout: Duration,
) -> Result<(), FsError> {
    let deadline = Instant::now() + timeout;
    loop {
        if forward.try_exited().is_some() {
            return Err(herr("SSH_FORWARD_FAILED", "the port forward to the server stopped"));
        }
        if let Some(seen) = health(local_port) {
            // A different nonce means something else owns the local port, not the core we started.
            return if ct_eq(&seen, nonce) {
                Ok(())
            } else {
                Err(herr("SSH_FORWARD_FAILED", "the local port answered with a different core"))
            };
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(herr("SSH_START_FAILED", "the core did not answer on the forwarded port"));
        }
        std::thread::sleep(HEALTH_POLL.min(deadline - now));
    }
}

/// The release bundle for `version`, preferring the compatibility build for older Linux servers.
pub fn bundle_for(version: &str) -> Option<String> {
    let name = format!("llmide-core-{version}-linux-x64-compat.tar.gz");
    [
        format!("desktop/resources/hub/{name}"),
        format!("desktop/dist/hub/{name}"),
        format!("../desktop/resources/hub/{name}"),
    ]
    .into_iter()
    .find(|p| Path::new(p).is_file())
    .or_else(|| crate::remote_deploy::bundle_path(version))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::remote::temp_ssh_dir;
    use crate::ssh_server_scripts::{INSTALL, PROBE, ROLLBACK, START, STATUS, STOP};
    use crate::ssh_transport::{prepare_endpoint, ForwardChild, SshExec};
    use sha2::{Digest, Sha256};
    use std::collections::VecDeque;
    use std::io;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    pub(crate) const KNOWN: &str = "/home/alice/.ssh/llmide_known_hosts";
    pub(crate) const KEY: &str = "/home/alice/.ssh/id_ed25519";
    const OLD: &str = "oldnonce0123456789";
    pub(crate) const NEW: &str = "newnonce0123456789";
    const RESTORED: &str = "restorednonce012345";
    const PAYLOAD: &[u8] = b"{\"jwtSecret\":\"j\",\"vaultKey\":\"v\",\"hostApprovalKey\":\"a\"}";
    const TARBALL: &[u8] = b"fake-tarball-bytes";
    pub(crate) const PASSWORD: &str = "hunter2";
    pub(crate) const PERMISSION_DENIED: &str = "alice@example.com: Permission denied (password).";
    pub(crate) const TIMED_OUT: &str = "ssh: connect to host example.com port 22: Connection timed out";
    pub(crate) const STOPPED_STATUS: &str = "__LLMIDE_STATE__={\"running\":false}\n";
    const INSTALL_OK: &str = "__LLMIDE_INSTALL__=ok\n";
    const STOP_OK: &str = "__LLMIDE_STOP__=stopped\n";
    const ROLLBACK_OK: &str = "__LLMIDE_ROLLBACK__=1.0.0\n";

    #[derive(Clone, Debug)]
    pub(crate) struct Call {
        pub(crate) name: &'static str,
        pub(crate) args: Vec<String>,
        pub(crate) stdin: Option<Vec<u8>>,
        pub(crate) deadline: Option<Duration>,
    }

    /// Placeholder nonce in a queued state line. `FakeExec::run` replaces it with the nonce START was sent, which
    /// is what a real core does: it echoes the nonce it was started with.
    pub(crate) const ECHO_NONCE: &str = "@sent-nonce@";

    /// Scripted `SshExec`: each `run` pops the next queued output and records argv, stdin and deadline.
    #[derive(Default)]
    pub(crate) struct FakeExec {
        queue: Mutex<VecDeque<io::Result<RawOutput>>>,
        calls: Mutex<Vec<Call>>,
        kills: Arc<AtomicUsize>,
        /// Forwards handed out by `spawn_forward` before the default never-exiting one.
        forwards: Mutex<VecDeque<Box<dyn ForwardChild>>>,
        /// The nonce the last START call sent, read from the first line of its stdin.
        started: Mutex<String>,
        /// `name:start` and `name:end` for each run, in order, so a test can see whether calls overlapped.
        events: Mutex<Vec<String>>,
        /// How long each run sleeps between its start and end events.
        delay: Duration,
    }

    impl FakeExec {
        pub(crate) fn new(outputs: Vec<io::Result<RawOutput>>) -> Self {
            Self { queue: Mutex::new(outputs.into()), ..Default::default() }
        }

        /// A fake whose every run takes `delay`, so overlapping calls from two threads show in `events`.
        pub(crate) fn with_delay(outputs: Vec<io::Result<RawOutput>>, delay: Duration) -> Self {
            Self { delay, ..Self::new(outputs) }
        }

        /// The nonce the last START sent, or an empty string when no START has run.
        pub(crate) fn started_nonce(&self) -> String {
            self.started.lock().unwrap().clone()
        }

        pub(crate) fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        /// Queues the next forward `spawn_forward` returns, so a test can script when it exits.
        pub(crate) fn queue_forward(&self, forward: Box<dyn ForwardChild>) {
            self.forwards.lock().unwrap().push_back(forward);
        }

        pub(crate) fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }

        pub(crate) fn names(&self) -> Vec<&'static str> {
            self.calls().iter().map(|c| c.name).collect()
        }

        pub(crate) fn kills(&self) -> usize {
            self.kills.load(Ordering::SeqCst)
        }
    }

    fn run_name(command: &str) -> &'static str {
        if command == PROBE {
            "probe"
        } else if command == STATUS {
            "status"
        } else if command == INSTALL {
            "install"
        } else if command == START {
            "start"
        } else if command == STOP {
            "stop"
        } else if command == ROLLBACK {
            "rollback"
        } else if command == UNINSTALL {
            "uninstall"
        } else {
            "unknown"
        }
    }

    impl SshExec for FakeExec {
        fn run(
            &self,
            args: &[String],
            stdin: Option<&[u8]>,
            _askpass: Option<&AskpassGrant>,
            deadline: Duration,
        ) -> io::Result<RawOutput> {
            let name = run_name(args.last().map_or("", String::as_str));
            let stdin = stdin.map(<[u8]>::to_vec);
            if name == "start" {
                let line = stdin.as_deref().and_then(|bytes| bytes.split(|b| *b == b'\n').next()).unwrap_or_default();
                let nonce = String::from_utf8_lossy(line).split_whitespace().nth(1).unwrap_or_default().to_string();
                *self.started.lock().unwrap() = nonce;
            }
            self.calls.lock().unwrap().push(Call {
                name,
                args: args.to_vec(),
                stdin,
                deadline: Some(deadline),
            });
            self.events.lock().unwrap().push(format!("{name}:start"));
            if !self.delay.is_zero() {
                std::thread::sleep(self.delay);
            }
            self.events.lock().unwrap().push(format!("{name}:end"));
            let next = self.queue.lock().unwrap().pop_front();
            match next {
                Some(Ok(mut output)) => {
                    if output.stdout.contains(ECHO_NONCE) {
                        let sent = self.started.lock().unwrap().clone();
                        output.stdout = output.stdout.replace(ECHO_NONCE, &sent);
                    }
                    Ok(output)
                }
                Some(Err(error)) => Err(error),
                None => Err(io::Error::other("no scripted output left")),
            }
        }

        fn spawn_forward(&self, args: &[String], _askpass: Option<&AskpassGrant>) -> io::Result<Box<dyn ForwardChild>> {
            self.calls.lock().unwrap().push(Call { name: "forward", args: args.to_vec(), stdin: None, deadline: None });
            let queued = self.forwards.lock().unwrap().pop_front();
            Ok(queued.unwrap_or_else(|| Box::new(FakeForward { kills: self.kills.clone() })))
        }
    }

    /// Records `kill` so a test can prove the forward was stopped on a failure path.
    struct FakeForward {
        kills: Arc<AtomicUsize>,
    }

    impl ForwardChild for FakeForward {
        fn try_exited(&mut self) -> Option<i32> {
            None
        }

        fn kill(&mut self) {
            self.kills.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// A scratch directory with a bundle file, removed on drop.
    struct Scratch {
        dir: PathBuf,
        bundle: PathBuf,
        session: PathBuf,
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = temp_ssh_dir(label).unwrap();
            let bundle = dir.join("llmide-core-2.0.0-linux-x64.tar.gz");
            std::fs::write(&bundle, TARBALL).unwrap();
            let session = dir.join("state").join("ssh-session.json");
            Self { dir, bundle, session }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    pub(crate) fn ok(stdout: &str) -> io::Result<RawOutput> {
        Ok(RawOutput { code: Some(0), stdout: stdout.to_string(), stderr: String::new() })
    }

    pub(crate) fn ssh_error(stderr: &str) -> io::Result<RawOutput> {
        Ok(RawOutput { code: Some(255), stdout: String::new(), stderr: stderr.to_string() })
    }

    pub(crate) fn probe_out(current: &str) -> io::Result<RawOutput> {
        ok(&format!(
            "__LLMIDE_UNAME__=Linux x86_64\n__LLMIDE_FREE_MB__=5000\n__LLMIDE_INSTALLED__={current}\n\
             __LLMIDE_CURRENT__={current}\n__LLMIDE_CLAUDE__=2.1.0 (Claude Code)\n"
        ))
    }

    pub(crate) fn state_out(port: u16, nonce: &str, version: &str) -> io::Result<RawOutput> {
        ok(&format!(
            "__LLMIDE_STATE__={{\"running\":true,\"port\":{port},\"pid\":4242,\"nonce\":\"{nonce}\",\"version\":\"{version}\"}}\n"
        ))
    }

    /// A `/health` answer that echoes the nonce the last START sent, the way a freshly started core does.
    pub(crate) fn started_health(fake: &FakeExec) -> impl Fn(u16) -> Option<String> + '_ {
        move |_| Some(fake.started_nonce())
    }

    /// The START answer of a fresh core: the state line echoes the nonce START was sent.
    pub(crate) fn started_out(port: u16, version: &str) -> io::Result<RawOutput> {
        state_out(port, ECHO_NONCE, version)
    }

    pub(crate) fn key_endpoint() -> SshEndpoint {
        prepare_endpoint("example.com", 22, "alice", SshAuth::Key { path: KEY.into() }).unwrap()
    }

    pub(crate) fn password_endpoint() -> SshEndpoint {
        prepare_endpoint("example.com", 22, "alice", SshAuth::Password).unwrap()
    }

    fn input<'a>(ep: &'a SshEndpoint, scratch: &'a Scratch, password: Option<&'a str>) -> ConnectInput<'a> {
        ConnectInput {
            endpoint: ep,
            password,
            bundle: &scratch.bundle,
            version: "2.0.0",
            secrets_payload: PAYLOAD,
            known_hosts: Some(Path::new(KNOWN)),
            session_file: &scratch.session,
            health_timeout: Duration::from_millis(5),
        }
    }

    fn expect_ok(result: Result<Connected, FsError>) -> Connected {
        match result {
            Ok(connected) => connected,
            Err(e) => panic!("connect failed with {}: {}", e.code, e.message),
        }
    }

    fn expect_err(result: Result<Connected, FsError>) -> FsError {
        match result {
            Ok(_) => panic!("connect unexpectedly succeeded"),
            Err(e) => e,
        }
    }

    fn record_running_core(scratch: &Scratch, ep: &SshEndpoint, nonce: &str) {
        write_session(&scratch.session, ep, nonce).unwrap();
    }

    #[test]
    fn fresh_server_installs_starts_forwards() {
        let fake = FakeExec::new(vec![
            probe_out(""),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            started_out(3460, "2.0.0"),
        ]);
        let scratch = Scratch::new("fresh");
        let ep = key_endpoint();
        let healthy = started_health(&fake);
        let connected = expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(fake.names(), vec!["probe", "status", "install", "start", "forward"]);
        let calls = fake.calls();
        let install_stdin = calls[2].stdin.clone().unwrap();
        let digest: String = Sha256::digest(TARBALL).iter().map(|b| format!("{b:02x}")).collect();
        let header = format!("2.0.0 {digest}\n");
        assert!(install_stdin.starts_with(header.as_bytes()), "install header carries the tarball checksum");
        assert_eq!(install_stdin.len(), header.len() + TARBALL.len());
        let start_stdin = calls[3].stdin.clone().unwrap();
        assert!(start_stdin.starts_with(b"2.0.0 "), "start header names the version");
        assert!(start_stdin.ends_with(PAYLOAD), "the secrets payload follows the start header unchanged");
        assert!(connected.local_url.starts_with("http://127.0.0.1:"));
        assert_eq!(connected.local_url, "http://127.0.0.1:3456");
        assert_eq!(connected.local_port, 3456);
        assert_eq!(connected.remote_port, 3460);
        let started = fake.started_nonce();
        assert!(!started.is_empty(), "START was sent a nonce");
        assert_eq!(connected.nonce, started, "the nonce comes from the state START returned");
        assert!(
            std::fs::read_to_string(&scratch.session).unwrap().contains(&started),
            "session record holds the started nonce"
        );
    }

    #[test]
    fn running_same_version_skips_install_and_start() {
        let scratch = Scratch::new("same");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![probe_out("2.0.0"), state_out(3461, OLD, "2.0.0")]);
        let healthy = |_: u16| Some(OLD.to_string());
        let connected = expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(fake.names(), vec!["probe", "status", "forward"]);
        assert_eq!(connected.remote_port, 3461, "the port comes from STATUS");
        assert_eq!(connected.version, "2.0.0");
    }

    #[test]
    fn outdated_version_installs_then_restarts() {
        let scratch = Scratch::new("outdated");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_out("1.0.0"),
            state_out(3460, OLD, "1.0.0"),
            ok(INSTALL_OK),
            ok(STOP_OK),
            state_out(3462, NEW, "2.0.0"),
        ]);
        let healthy = |_: u16| Some(NEW.to_string());
        let connected = expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(fake.names(), vec!["probe", "status", "install", "stop", "start", "forward"]);
        assert_eq!(connected.version, "2.0.0");
        assert_eq!(connected.nonce, NEW);
    }

    #[test]
    fn failed_health_after_update_rolls_back() {
        let scratch = Scratch::new("rollback");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_out("1.0.0"),
            state_out(3460, OLD, "1.0.0"),
            ok(INSTALL_OK),
            ok(STOP_OK),
            state_out(3462, NEW, "2.0.0"),
            ok(STOP_OK),
            ok(ROLLBACK_OK),
            state_out(3463, RESTORED, "1.0.0"),
        ]);
        let silent = |_: u16| None;
        let err = expect_err(connect_with(&fake, &silent, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_START_FAILED");
        assert_eq!(
            fake.names(),
            vec!["probe", "status", "install", "stop", "start", "forward", "stop", "rollback", "start"]
        );
        assert_eq!(fake.kills(), 1, "the forward is killed before the rollback");
        assert!(
            std::fs::read_to_string(&scratch.session).unwrap().contains(RESTORED),
            "the session record holds the restored core's nonce"
        );
    }

    #[test]
    fn failed_health_after_update_on_a_stopped_core_rolls_back_without_a_restart() {
        let scratch = Scratch::new("stopped-rollback");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![
            probe_out("1.0.0"),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            started_out(3462, "2.0.0"),
            ok(STOP_OK),
            ok(ROLLBACK_OK),
        ]);
        let silent = |_: u16| None;
        let err = expect_err(connect_with(&fake, &silent, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_START_FAILED");
        assert_eq!(
            fake.names(),
            vec!["probe", "status", "install", "start", "forward", "stop", "rollback"],
            "current is switched back even though no core was running"
        );
    }

    #[test]
    fn forward_mismatch_after_update_keeps_the_new_release() {
        let scratch = Scratch::new("mismatch-update");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_out("1.0.0"),
            state_out(3460, OLD, "1.0.0"),
            ok(INSTALL_OK),
            ok(STOP_OK),
            state_out(3462, NEW, "2.0.0"),
        ]);
        let other = |_: u16| Some("someoneelsesnonce0".to_string());
        let err = expect_err(connect_with(&fake, &other, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_FORWARD_FAILED");
        assert_eq!(
            fake.names(),
            vec!["probe", "status", "install", "stop", "start", "forward"],
            "a local forward problem must not stop or revert the new release"
        );
    }

    #[test]
    fn host_key_change_is_not_unreachable() {
        for stderr in [
            "Host key verification failed.",
            "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@",
        ] {
            let scratch = Scratch::new("hostkey");
            let ep = key_endpoint();
            let fake = FakeExec::new(vec![ssh_error(stderr)]);
            let healthy = |_: u16| Some(NEW.to_string());
            let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

            assert_eq!(err.code, "SSH_HOST_KEY_CHANGED", "for {stderr}");
            assert_eq!(
                err.message,
                "The server's host key changed. Test the connection again and confirm the new fingerprint."
            );
            assert_eq!(fake.names(), vec!["probe"]);
        }
    }

    #[test]
    fn wrong_password_is_auth_failed() {
        let scratch = Scratch::new("auth");
        let ep = password_endpoint();
        let fake = FakeExec::new(vec![ssh_error(PERMISSION_DENIED)]);
        let healthy = |_: u16| Some(NEW.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, Some(PASSWORD)), &|| Some(3456)));

        assert_eq!(err.code, "SSH_AUTH_FAILED");
        assert_eq!(err.message, "The server refused this login.");
        assert_eq!(fake.names(), vec!["probe"]);
    }

    #[test]
    fn unreachable() {
        let scratch = Scratch::new("unreachable");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![ssh_error(TIMED_OUT)]);
        let healthy = |_: u16| Some(NEW.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_UNREACHABLE");
        assert_eq!(fake.names(), vec!["probe"]);
    }

    #[test]
    fn foreign_core_is_refused() {
        let scratch = Scratch::new("foreign");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![probe_out("2.0.0"), state_out(3460, "foreignnonce0123456", "2.0.0")]);
        let healthy = |_: u16| Some(NEW.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_CORE_FOREIGN");
        let names = fake.names();
        assert!(!names.contains(&"stop") && !names.contains(&"start"), "a foreign core is never stopped or replaced");
    }

    #[test]
    fn unconfirmed_host_key() {
        let scratch = Scratch::new("unconfirmed");
        let ep = key_endpoint();
        let fake = FakeExec::default();
        let healthy = |_: u16| Some(NEW.to_string());
        let mut unconfirmed = input(&ep, &scratch, None);
        unconfirmed.known_hosts = None;
        let err = expect_err(connect_with(&fake, &healthy, unconfirmed, &|| Some(3456)));

        assert_eq!(err.code, "SSH_HOST_KEY_UNCONFIRMED");
        assert!(fake.calls().is_empty(), "no ssh call happens before the host key is confirmed");
    }

    #[test]
    fn password_never_in_args_or_errors() {
        let ep = password_endpoint();
        let scratch = Scratch::new("secret-success");
        let fake = FakeExec::new(vec![
            probe_out(""),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            started_out(3460, "2.0.0"),
        ]);
        let healthy = started_health(&fake);
        expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, Some(PASSWORD)), &|| Some(3456)));
        for call in fake.calls() {
            assert!(!call.args.iter().any(|a| a.contains(PASSWORD)), "{} argv holds the password", call.name);
        }

        let failing_scratch = Scratch::new("secret-failure");
        let failing = FakeExec::new(vec![ssh_error(PERMISSION_DENIED)]);
        let err = expect_err(connect_with(&failing, &healthy, input(&ep, &failing_scratch, Some(PASSWORD)), &|| Some(3456)));
        assert!(!err.message.contains(PASSWORD), "the error message holds the password");
        assert!(!err.code.contains(PASSWORD));
        for call in failing.calls() {
            assert!(!call.args.iter().any(|a| a.contains(PASSWORD)), "{} argv holds the password", call.name);
        }
    }

    #[test]
    fn nonce_mismatch_through_forward() {
        let scratch = Scratch::new("mismatch");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![
            probe_out(""),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            started_out(3460, "2.0.0"),
        ]);
        let other = |_: u16| Some("someoneelsesnonce0".to_string());
        let err = expect_err(connect_with(&fake, &other, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_FORWARD_FAILED");
        assert_eq!(fake.kills(), 1, "the forward is killed when the nonce does not match");
    }

    #[test]
    fn no_free_local_port_stops_before_any_ssh_call() {
        let scratch = Scratch::new("no-port");
        let ep = key_endpoint();
        let fake = FakeExec::default();
        let healthy = |_: u16| Some(NEW.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| None));

        assert_eq!(err.code, "SSH_NO_LOCAL_PORT");
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn start_answer_with_a_foreign_nonce_is_refused() {
        // STATUS said nothing was running, but START answers with a nonce this desktop did not send: another
        // desktop started a core in between. That core is refused, not adopted, and no forward or record follows.
        let scratch = Scratch::new("start-foreign");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![
            probe_out(""),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            state_out(3460, "foreignnonce0123456", "2.0.0"),
        ]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_CORE_FOREIGN");
        assert_eq!(err.message, FOREIGN_CORE_MESSAGE);
        assert_eq!(fake.names(), vec!["probe", "status", "install", "start"], "no forward after a foreign start");
        assert!(!scratch.session.exists(), "the foreign core is not recorded as ours");
    }

    #[test]
    fn foreign_core_message_is_the_shared_text() {
        let scratch = Scratch::new("foreign-text");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![probe_out("2.0.0"), state_out(3460, "foreignnonce0123456", "2.0.0")]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_CORE_FOREIGN");
        assert_eq!(err.message, "Another computer started the server on this account.");
    }

    #[test]
    fn a_timed_out_call_is_ssh_timeout() {
        let scratch = Scratch::new("timeout");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![Err(io::Error::new(io::ErrorKind::TimedOut, "deadline"))]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));

        assert_eq!(err.code, "SSH_TIMEOUT");
        assert_eq!(err.message, "The server did not answer in time.");
        assert_eq!(fake.names(), vec!["probe"], "nothing runs after a timed-out probe");
    }

    #[test]
    fn each_script_gets_its_own_deadline() {
        let scratch = Scratch::new("deadlines");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![
            probe_out(""),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            started_out(3460, "2.0.0"),
        ]);
        let healthy = started_health(&fake);
        expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        let deadlines: Vec<(&str, Option<Duration>)> = fake.calls().iter().map(|c| (c.name, c.deadline)).collect();
        assert_eq!(
            deadlines,
            vec![
                ("probe", Some(Duration::from_secs(60))),
                ("status", Some(Duration::from_secs(60))),
                ("install", Some(Duration::from_secs(30 * 60))),
                ("start", Some(Duration::from_secs(90))),
                ("forward", None),
            ]
        );
    }
}
