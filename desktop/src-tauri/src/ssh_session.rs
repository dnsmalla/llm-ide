//! Connects the desktop to a core on a Linux server over the system `ssh`.
//!
//! The steps run in a fixed order: confirmed host key, PROBE, STATUS, INSTALL when the server lacks
//! this release, STOP and START, then a `-L` forward and a `/health` check that must echo the nonce
//! START returned. Every server command is a constant from `ssh_server_scripts`; no step builds a
//! shell command from data.

use std::io::{Read, Write};
#[cfg(not(test))]
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::confirm::herr;
use crate::core_host::{ct_eq, random_nonce};
use crate::fs_ops::FsError;
use crate::remote::RawOutput;
use crate::ssh_askpass::{grant, AskpassGrant};
use crate::ssh_server_scripts::{
    check_probe, glibc_is_below_standard, install_stdin, parse_core_state, parse_install_failure, parse_probe,
    parse_start_failure, parse_stop, start_stdin, valid_version, ClaudeState, CoreState, Probe, INSTALL, PROBE,
    ROLLBACK, START, START_BUSY, STANDARD_GLIBC, STATUS, STOP, UNINSTALL,
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

/// The code `wait_for_core` gives when the forward stayed up and `/health` never answered. `ssh_link` reads it to tell a
/// silent core apart from a local forward that failed.
pub(crate) const NO_ANSWER_CODE: &str = "SSH_START_FAILED";

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
///
/// `nonce` is the core this desktop last started or confirmed. `pending` is the nonce of a START whose reply never
/// came back: the server may be running a core with it, so the next connect accepts that core as ours too. It is
/// absent on records written before it existed, and a successful connect clears it.
#[derive(Serialize, Deserialize)]
struct SessionRecord {
    host: String,
    port: u16,
    user: String,
    nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<String>,
}

impl SessionRecord {
    fn new(endpoint: &SshEndpoint, nonce: &str, pending: Option<&str>) -> Self {
        Self {
            host: endpoint.host.clone(),
            port: endpoint.port,
            user: endpoint.user.clone(),
            nonce: nonce.to_string(),
            pending: pending.map(str::to_string),
        }
    }

    /// Whether the record names `endpoint`. The host name is compared without case, as ssh does.
    fn is_for(&self, endpoint: &SshEndpoint) -> bool {
        self.host.eq_ignore_ascii_case(&endpoint.host) && self.port == endpoint.port && self.user == endpoint.user
    }
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
    // Read locally before any ssh call. Every connect needs it: it decides whether the server's release matches this app.
    let bundle_sha = bundle_sha256(input.bundle)?;
    // Picked before any ssh call, so a machine with no free port changes nothing on the server.
    let local_port = pick_port()
        .ok_or_else(|| herr("SSH_NO_LOCAL_PORT", "no local port in 3456..=3459 is free for the forward"))?;
    let link = Link { exec, endpoint: input.endpoint, known_hosts, password: input.password };

    let probe = parse_probe(&link.run(PROBE, None)?.stdout)?;
    check_probe(&probe)?;
    let status = parse_core_state(&link.run(STATUS, None)?.stdout)?;
    let (core, replacement) = ensure_core(&link, &input, &probe, &status, &bundle_sha)?;

    // Also clears any pending nonce: the core in use is now the one named here, and the connect is past the start.
    // Written before the forward so a later connect can recognise the core even if this connect fails.
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

/// What a replacement changed on the server, and what a failed start has to undo.
struct Replacement {
    /// A core this app started is still running and must be stopped before the start.
    was_running: bool,
    /// The release `current` pointed at before a version change. Set only when the install switched `current` to
    /// another version, which is the only case a failed start has a release to return to.
    previous: Option<String>,
    /// A release of the same version was swapped for a rebuilt bundle. It has no previous release to return to, so
    /// a failed start leaves the core stopped.
    in_place: bool,
}

/// Makes the server run `input.version` from the bundle this app holds, installing and restarting only when it does
/// not already. A release counts as current only when its recorded bundle sha matches `bundle_sha`, so a rebuilt
/// bundle with the same version is installed too. Returns the core and, when this call started one, what that start
/// replaced.
fn ensure_core(
    link: &Link<'_>,
    input: &ConnectInput<'_>,
    probe: &Probe,
    status: &CoreState,
    bundle_sha: &str,
) -> Result<(RunningCore, Option<Replacement>), FsError> {
    let version_matches = probe.current.as_deref() == Some(input.version);
    let release_matches = version_matches && probe.current_sha.as_deref() == Some(bundle_sha);
    if status.running {
        require_ours(status, input.session_file, input.endpoint)?;
    }
    let already_running = status.running && release_matches && status.version.as_deref() == Some(input.version);
    if already_running {
        return Ok((running_core(status)?, None));
    }
    let install_needed = !release_matches;
    // Checked before anything is stopped or uploaded, so an old server is refused with its core left alone.
    if install_needed {
        check_glibc(input.bundle, probe)?;
    }
    let in_place = install_needed && version_matches;
    let mut was_running = status.running;
    // A running core loads files from the release folder of its own version, and INSTALL replaces that folder when
    // the release changes. Such a core is stopped before INSTALL. A core of another version runs from another folder,
    // so it is stopped later, after the install, as a version change always was.
    let folder_in_use = status.running && status.version.as_deref() == Some(input.version);
    if install_needed && folder_in_use {
        stop_core(link)?;
        was_running = false;
    }
    if install_needed {
        install_core(link, input.bundle, input.version, bundle_sha)?;
    }
    let replacement = Replacement {
        was_running,
        previous: if install_needed && !version_matches { probe.current.clone() } else { None },
        in_place,
    };
    let core = replace_core(link, input, &replacement)?;
    Ok((core, Some(replacement)))
}

/// Refuses the standard bundle on a server whose glibc is older than the bundle needs, before any upload. The
/// `-compat` bundle is built for older systems, so it is always allowed. An unknown glibc is not refused.
fn check_glibc(bundle: &Path, probe: &Probe) -> Result<(), FsError> {
    let is_compat = bundle.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.contains("-compat"));
    match &probe.glibc {
        Some(glibc) if !is_compat && glibc_is_below_standard(glibc) => Err(herr(
            "SSH_GLIBC_TOO_OLD",
            format!(
                "This server's system libraries are too old for the standard server bundle (glibc {glibc}; {STANDARD_GLIBC} needed). Build the compatible bundle and try again."
            ),
        )),
        _ => Ok(()),
    }
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
    // Only a version change has a previous release to return to. An in-place replacement has none, and the failed
    // start has already stopped its own core, so there is nothing to undo.
    if matches!(&started, Err(e) if is_start_failure(e)) && replacement.previous.is_some() {
        fail_update(link, input, replacement);
    }
    started
}

/// Undoes a failed update: stop the new core, repoint `current` at the previous release, and when a core was
/// running before, start that release again. Best effort, because the caller reports the start failure.
fn fail_update(link: &Link<'_>, input: &ConnectInput<'_>, replacement: &Replacement) {
    let Some(previous) = replacement.previous.as_deref() else {
        // An in-place replacement whose core started but never answered: the new release is the broken one and
        // there is no other to return to, so the core is left stopped rather than running a release that failed.
        if replacement.in_place {
            let _ = stop_core(link);
        }
        return;
    };
    roll_back(link);
    if replacement.was_running {
        // start_core records the nonce of the restored core itself.
        let _ = start_core(link, input, previous, false);
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
    // Recorded before START is sent. A START whose reply is lost can still leave a core running with this nonce, and
    // the next connect must recognise that core. The record goes back to its earlier state only when START says that
    // it started nothing that is still running. Failing here stops the START before it is sent.
    let before = record_pending(input.session_file, input.endpoint, &nonce)?;
    let stdin = start_stdin(version, &nonce, input.secrets_payload);
    // A transport error or deadline leaves the pending nonce in place: START's answer never came, so the core may be up.
    let output = link.run(START, Some(&stdin))?;
    if let Some((value, log)) = parse_start_failure(&output.stdout) {
        // Each failure marker is printed after START has stopped any core it spawned, so none runs with `nonce`.
        restore_record(input.session_file, before);
        // Another START holds the data folder's lock. It is not a failed start, so no release is rolled back for it.
        if value == START_BUSY {
            return Err(herr("SSH_START_BUSY", "The server is already starting. Try again in a moment."));
        }
        let detail = log.map(|line| format!(": {line}")).unwrap_or_default();
        return Err(herr("SSH_START_FAILED", format!("the server could not start the core ({value}){detail}")));
    }
    if output.code != Some(0) {
        return Err(herr("SSH_START_FAILED", "the server did not start the core"));
    }
    let core = running_core(&parse_core_state(&output.stdout)?)?;
    if expect_our_nonce && !ct_eq(&core.nonce, &nonce) {
        // Another desktop's core answered. The core this START sent never ran, so nothing of it is recorded.
        restore_record(input.session_file, before);
        return Err(herr(FOREIGN_CORE_CODE, FOREIGN_CORE_MESSAGE));
    }
    save_record(input.session_file, &SessionRecord::new(input.endpoint, &core.nonce, None))?;
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

/// Uploads the bundle as `version`, with `sha256_hex` as the checksum in the header. INSTALL verifies the checksum
/// on the server, so a corrupted upload is refused there rather than run.
fn install_core(link: &Link<'_>, bundle: &Path, version: &str, sha256_hex: &str) -> Result<(), FsError> {
    let tarball = std::fs::read(bundle)
        .map_err(|e| herr("SSH_INSTALL_FAILED", format!("could not read the core bundle: {e}")))?;
    let stdin = install_stdin(version, sha256_hex, &tarball);
    let output = link.run(INSTALL, Some(&stdin))?;
    if output.code != Some(0) {
        return Err(install_failure(&output.stdout));
    }
    Ok(())
}

/// Maps the INSTALL script's failure marker to its message. A transport failure never reaches here: it is mapped by
/// `Link::run` first. Causes the user can act on each get their own text; anything else stays generic.
fn install_failure(stdout: &str) -> FsError {
    match parse_install_failure(stdout) {
        Some("checksum") => herr("SSH_INSTALL_FAILED", "The upload was damaged. Try again."),
        Some("unpack") => herr("SSH_INSTALL_FAILED", "The server could not unpack the bundle."),
        Some("disk") => herr(
            "SSH_DISK_LOW",
            "The server ran out of disk space during the install. Free space in the home folder, then try again.",
        ),
        _ => herr("SSH_INSTALL_FAILED", "the server could not install the core"),
    }
}

/// The SHA-256 of the bundle file, read in chunks so a bundle of about 200 MB is not held in memory here.
/// Computed once per connect and used both for the release comparison and as the INSTALL header.
pub(crate) fn bundle_sha256(path: &Path) -> Result<String, FsError> {
    let failed = |e: std::io::Error| herr("SSH_INSTALL_FAILED", format!("could not read the core bundle: {e}"));
    let mut file = std::fs::File::open(path).map_err(failed)?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut chunk).map_err(failed)?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Refuses a running core this desktop did not start. The record must name this endpoint and the nonce
/// STATUS reports; anything else may be someone else's core, and it is left alone. A core that is not running
/// is nobody's, so there is nothing to refuse.
pub(crate) fn require_ours(status: &CoreState, session_file: &Path, endpoint: &SshEndpoint) -> Result<(), FsError> {
    if !status.running {
        return Ok(());
    }
    let record = read_session(session_file);
    // The pending nonce counts too: a START whose reply was lost may have left a core running with it, and that core
    // is ours. STATUS must still report the nonce, so a pending record alone proves nothing.
    let is_ours = record.is_some_and(|r| {
        r.is_for(endpoint)
            && status.nonce.as_deref().is_some_and(|nonce| {
                ct_eq(&r.nonce, nonce) || r.pending.as_deref().is_some_and(|pending| ct_eq(pending, nonce))
            })
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

/// Records the core this desktop started, with no pending START. Written once START has answered with the core's
/// nonce, and again after the connect succeeds, which clears any pending nonce.
pub(crate) fn write_session(path: &Path, endpoint: &SshEndpoint, nonce: &str) -> Result<(), FsError> {
    save_record(path, &SessionRecord::new(endpoint, nonce, None))
}

/// Writes the record as one file, 0600. Its contents are a host, a port, a user and nonces: no secret.
fn save_record(path: &Path, record: &SessionRecord) -> Result<(), FsError> {
    let json = serde_json::to_string(record).map_err(|e| herr("session_record_failed", e.to_string()))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| herr("session_record_failed", format!("could not create the session folder: {e}")))?;
    }
    write_private(path, json.as_bytes())
}

/// Adds `nonce` as the pending START before START is sent, and returns the record as it was. The current nonce of
/// this endpoint is kept. A record for another endpoint, or none, has no current nonce, so the pending one stands in.
fn record_pending(path: &Path, endpoint: &SshEndpoint, nonce: &str) -> Result<Option<SessionRecord>, FsError> {
    let before = read_session(path);
    let current = before
        .as_ref()
        .filter(|record| record.is_for(endpoint))
        .map_or_else(|| nonce.to_string(), |record| record.nonce.clone());
    save_record(path, &SessionRecord::new(endpoint, &current, Some(nonce)))?;
    Ok(before)
}

/// Puts back the record that [`record_pending`] returned, or removes the file when there was none. Best effort: the
/// caller reports the START's own outcome, and a record left with a pending nonce is harmless.
fn restore_record(path: &Path, before: Option<SessionRecord>) {
    match before {
        Some(record) => {
            let _ = save_record(path, &record);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
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
            return Err(herr(NO_ANSWER_CODE, "the core did not answer on the forwarded port"));
        }
        std::thread::sleep(HEALTH_POLL.min(deadline - now));
    }
}

/// Folders that may hold a development bundle, relative to the repository root, in search order.
/// NOTE: `desktop/dist` is Vite's output folder and every web build empties it, so a bundle staged there
/// disappears without warning. `desktop/dist/hub` is read only for one release, for checkouts staged before
/// the move to `desktop/hub-dist`.
const DEV_BUNDLE_FOLDERS: [&str; 3] = ["desktop/resources/hub", "desktop/hub-dist", "desktop/dist/hub"];

/// The first existing `<root>/<folder>/<name>`. Names are the outer loop, so the first name in `names` wins
/// in whichever folder it sits; that is how the compat build is preferred wherever it was staged.
pub(crate) fn search_bundle(root: &Path, names: &[String]) -> Option<PathBuf> {
    names
        .iter()
        .flat_map(|name| DEV_BUNDLE_FOLDERS.iter().map(move |folder| root.join(folder).join(name)))
        .find(|path| path.is_file())
}

/// The development bundle for the first of `names` that exists. The search starts at the repository root so the
/// answer does not depend on the working directory: `npm run tauri dev` runs in `desktop/src-tauri`. With no
/// repository root, the folders are tried relative to the working directory and to its parent.
pub(crate) fn find_dev_bundle(names: &[String]) -> Option<PathBuf> {
    match crate::core_host::repo_root() {
        Ok(root) => search_bundle(&root, names),
        Err(_) => names.iter().find_map(|name| {
            let one = std::slice::from_ref(name);
            search_bundle(Path::new(""), one).or_else(|| search_bundle(Path::new(".."), one))
        }),
    }
}

/// The release bundle for `version`, preferring the compatibility build for older Linux servers.
/// `LLMIDE_HUB_BUNDLE` is honoured first: an explicitly named file wins over any search.
pub fn bundle_for(version: &str) -> Option<String> {
    if let Some(explicit) = crate::remote_deploy::explicit_bundle() {
        return Some(explicit);
    }
    let names = [
        format!("llmide-core-{version}-linux-x64-compat.tar.gz"),
        format!("llmide-core-{version}-linux-x64.tar.gz"),
    ];
    find_dev_bundle(&names).map(|path| path.to_string_lossy().into_owned())
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
        let fake = FakeExec::new(vec![probe_with_release("2.0.0", &bundle_sha()), state_out(3461, OLD, "2.0.0")]);
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

    /// The nonce a record holds as its current one, read from the file so the test sees what is on disk.
    fn record_nonce(scratch: &Scratch) -> Option<String> {
        let value = record_json(scratch)?;
        value.get("nonce")?.as_str().map(str::to_string)
    }

    /// The pending nonce a record holds, if any.
    fn pending_in_record(scratch: &Scratch) -> Option<String> {
        let value = record_json(scratch)?;
        value.get("pending")?.as_str().map(str::to_string)
    }

    fn record_json(scratch: &Scratch) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(&scratch.session).ok()?;
        serde_json::from_str(&text).ok()
    }

    #[test]
    fn a_start_cut_off_by_a_dropped_connection_is_reused_by_the_next_connect() {
        // The reply to START never arrives: a connection reset, then a deadline. The core may still be running with
        // the nonce START was sent, so the record keeps it and the next connect recognises that core.
        let cuts: [(io::Result<RawOutput>, &str); 2] = [
            (Err(io::Error::other("connection reset")), "SSH_UNREACHABLE"),
            (Err(io::Error::new(io::ErrorKind::TimedOut, "deadline")), "SSH_TIMEOUT"),
        ];
        for (cut, code) in cuts {
            let scratch = Scratch::new("cut-start");
            let ep = key_endpoint();
            let first = FakeExec::new(vec![probe_out(""), ok(STOPPED_STATUS), ok(INSTALL_OK), cut]);
            let healthy = started_health(&first);
            let err = expect_err(connect_with(&first, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
            assert_eq!(err.code, code);
            assert_eq!(first.names(), vec!["probe", "status", "install", "start"]);
            let sent = first.started_nonce();
            assert!(!sent.is_empty(), "START was sent a nonce");
            assert_eq!(pending_in_record(&scratch).as_deref(), Some(sent.as_str()), "the record names the cut START's nonce");

            // The server now runs the core that the cut START started, on the release INSTALL put in place.
            let second = FakeExec::new(vec![probe_with_release("2.0.0", &bundle_sha()), state_out(3460, &sent, "2.0.0")]);
            let answering = sent.clone();
            let healthy = move |_: u16| Some(answering.clone());
            let connected = expect_ok(connect_with(&second, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
            assert_eq!(second.names(), vec!["probe", "status", "forward"], "the running core is reused, with no second START");
            assert_eq!(connected.nonce, sent);
            assert_eq!(record_nonce(&scratch).as_deref(), Some(sent.as_str()));
            assert_eq!(pending_in_record(&scratch), None, "a successful connect clears the pending nonce");
        }
    }

    #[test]
    fn a_start_that_reports_a_clean_failure_puts_the_record_back() {
        // START printed `exited` after stopping its own core, so no core runs with the nonce it was sent. The record
        // that an earlier connect wrote must be exactly as it was.
        let scratch = Scratch::new("clean-start-fail");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![probe_out(""), ok(STOPPED_STATUS), ok(INSTALL_OK), start_failed("exited")]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_START_FAILED");
        assert_eq!(fake.names(), vec!["probe", "status", "install", "start"]);
        assert_eq!(record_nonce(&scratch).as_deref(), Some(OLD));
        assert_eq!(pending_in_record(&scratch), None, "the failed START's nonce is not left pending");
    }

    #[test]
    fn a_clean_failed_update_rolls_back_and_records_the_restored_core() {
        // The core of 1.0.0 that this desktop started is still running when 2.0.0 fails cleanly. The rollback starts
        // 1.0.0 again, and the record must name that core.
        let scratch = Scratch::new("clean-update-fail");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_out("1.0.0"),
            state_out(3460, OLD, "1.0.0"),
            ok(INSTALL_OK),
            ok(STOP_OK),
            start_failed("exited"),
            ok(STOP_OK),
            ok(ROLLBACK_OK),
            state_out(3463, RESTORED, "1.0.0"),
        ]);
        let silent = |_: u16| None;
        let err = expect_err(connect_with(&fake, &silent, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_START_FAILED");
        assert_eq!(record_nonce(&scratch).as_deref(), Some(RESTORED));
        assert_eq!(pending_in_record(&scratch), None);
    }

    #[test]
    fn a_start_that_hands_back_a_live_core_of_ours_records_the_nonce_it_returned() {
        // START answers with a core that is already running under a nonce this desktop recorded earlier. The record
        // must end up with the nonce START returned, not the one this call sent.
        // A core of 1.0.0 that this desktop started is running. Connecting to 2.0.0 installs, stops it and starts 2.0.0,
        // and START answers with a live core under RESTORED. That is not a foreign core, because the core was not
        // stopped in place of the one this desktop owns.
        let scratch = Scratch::new("reused-core");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_out("1.0.0"),
            state_out(3461, OLD, "1.0.0"),
            ok(INSTALL_OK),
            ok(STOP_OK),
            state_out(3462, RESTORED, "2.0.0"),
        ]);
        let healthy = |_: u16| Some(RESTORED.to_string());
        let connected = expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(connected.nonce, RESTORED);
        assert_eq!(record_nonce(&scratch).as_deref(), Some(RESTORED));
        assert_eq!(pending_in_record(&scratch), None);
    }

    #[test]
    fn a_record_without_a_pending_nonce_still_loads() {
        // Records written before the pending field existed hold only host, port, user and nonce.
        let scratch = Scratch::new("old-record");
        let ep = key_endpoint();
        std::fs::create_dir_all(scratch.session.parent().unwrap()).unwrap();
        std::fs::write(
            &scratch.session,
            format!("{{\"host\":\"{}\",\"port\":22,\"user\":\"alice\",\"nonce\":\"{OLD}\"}}", ep.host),
        )
        .unwrap();
        let status = parse_core_state(&state_out(3461, OLD, "2.0.0").unwrap().stdout).unwrap();
        require_ours(&status, &scratch.session, &ep).expect("the record's nonce is ours");
    }

    /// Writes a record with a pending nonce for the test endpoint, as a cut START leaves it.
    fn write_record_with_pending(scratch: &Scratch, nonce: &str, pending: &str) {
        std::fs::create_dir_all(scratch.session.parent().unwrap()).unwrap();
        let json = serde_json::json!({
            "host": "example.com", "port": 22, "user": "alice", "nonce": nonce, "pending": pending,
        });
        std::fs::write(&scratch.session, json.to_string()).unwrap();
    }

    #[test]
    fn a_pending_nonce_is_ours_and_another_nonce_is_still_foreign() {
        let scratch = Scratch::new("pending-ours");
        let ep = key_endpoint();
        write_record_with_pending(&scratch, OLD, NEW);
        let pending_core = parse_core_state(&state_out(3461, NEW, "2.0.0").unwrap().stdout).unwrap();
        require_ours(&pending_core, &scratch.session, &ep).expect("the pending nonce is ours");
        let foreign = parse_core_state(&state_out(3461, "foreignnonce0123456", "2.0.0").unwrap().stdout).unwrap();
        let err = require_ours(&foreign, &scratch.session, &ep).expect_err("a stranger's nonce is refused");
        assert_eq!(err.code, FOREIGN_CORE_CODE);
    }

    #[test]
    fn a_foreign_core_is_still_refused_while_a_start_is_pending() {
        let scratch = Scratch::new("pending-foreign");
        let ep = key_endpoint();
        write_record_with_pending(&scratch, OLD, NEW);
        let fake = FakeExec::new(vec![
            probe_with_release("2.0.0", &bundle_sha()),
            state_out(3460, "foreignnonce0123456", "2.0.0"),
        ]);
        let healthy = |_: u16| Some(NEW.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, FOREIGN_CORE_CODE);
        assert_eq!(fake.names(), vec!["probe", "status"], "a foreign core is never stopped or replaced");
    }

    /// The sha of the scratch bundle's bytes, the one the app sends in the INSTALL header.
    fn bundle_sha() -> String {
        Sha256::digest(TARBALL).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// PROBE output that also reports the release's recorded bundle sha.
    pub(crate) fn probe_with_release(current: &str, current_sha: &str) -> io::Result<RawOutput> {
        ok(&format!("{}__LLMIDE_CURRENT_SHA__={current_sha}\n", probe_out(current)?.stdout))
    }

    /// PROBE output that also reports the server's glibc version.
    pub(crate) fn probe_with_glibc(current: &str, glibc: &str) -> io::Result<RawOutput> {
        ok(&format!("{}__LLMIDE_GLIBC__={glibc}\n", probe_out(current)?.stdout))
    }

    /// A START answer that failed with `value`, as the script prints it (exit 1).
    fn start_failed(value: &str) -> io::Result<RawOutput> {
        Ok(RawOutput { code: Some(1), stdout: format!("__LLMIDE_START__={value}\n"), stderr: String::new() })
    }

    /// An INSTALL answer that failed with `marker`, as the script prints it (exit 1).
    fn install_failed(marker: &str) -> io::Result<RawOutput> {
        Ok(RawOutput { code: Some(1), stdout: format!("__LLMIDE_INSTALL__={marker}\n"), stderr: String::new() })
    }

    #[test]
    fn same_version_without_a_recorded_sha_is_replaced_when_our_core_runs() {
        // A release installed before the sha was recorded has no record, so it is never taken as this bundle.
        let scratch = Scratch::new("no-sha-record");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_out("2.0.0"),
            state_out(3461, OLD, "2.0.0"),
            ok(STOP_OK),
            ok(INSTALL_OK),
            started_out(3462, "2.0.0"),
        ]);
        let healthy = started_health(&fake);
        expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(fake.names(), vec!["probe", "status", "stop", "install", "start", "forward"]);
    }

    #[test]
    fn same_version_with_a_new_bundle_installs_then_starts_when_stopped() {
        let scratch = Scratch::new("new-sha-stopped");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![
            probe_with_release("2.0.0", &"0".repeat(64)),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            started_out(3460, "2.0.0"),
        ]);
        let healthy = started_health(&fake);
        expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(fake.names(), vec!["probe", "status", "install", "start", "forward"]);
        let header = format!("2.0.0 {}\n", bundle_sha());
        assert!(fake.calls()[2].stdin.clone().unwrap().starts_with(header.as_bytes()));
    }

    #[test]
    fn same_version_with_a_new_bundle_stops_our_core_before_install_then_starts() {
        let scratch = Scratch::new("new-sha-running");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_with_release("2.0.0", &"0".repeat(64)),
            state_out(3461, OLD, "2.0.0"),
            ok(STOP_OK),
            ok(INSTALL_OK),
            started_out(3462, "2.0.0"),
        ]);
        let healthy = started_health(&fake);
        let connected = expect_ok(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(fake.names(), vec!["probe", "status", "stop", "install", "start", "forward"]);
        assert_eq!(connected.remote_port, 3462);
        assert_eq!(connected.nonce, fake.started_nonce());
    }

    #[test]
    fn same_version_with_a_new_bundle_refuses_a_foreign_core_before_install() {
        let scratch = Scratch::new("new-sha-foreign");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![
            probe_with_release("2.0.0", &"0".repeat(64)),
            state_out(3460, "foreignnonce0123456", "2.0.0"),
        ]);
        let healthy = |_: u16| Some(NEW.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_CORE_FOREIGN");
        assert_eq!(fake.names(), vec!["probe", "status"], "nothing is stopped or uploaded for a foreign core");
    }

    #[test]
    fn same_version_replacement_whose_health_never_answers_leaves_the_core_stopped() {
        let scratch = Scratch::new("new-sha-silent");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_with_release("2.0.0", &"0".repeat(64)),
            state_out(3461, OLD, "2.0.0"),
            ok(STOP_OK),
            ok(INSTALL_OK),
            started_out(3462, "2.0.0"),
            ok(STOP_OK),
        ]);
        let silent = |_: u16| None;
        let err = expect_err(connect_with(&fake, &silent, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_START_FAILED");
        assert_eq!(
            fake.names(),
            vec!["probe", "status", "stop", "install", "start", "forward", "stop"],
            "no previous release exists, so the failed core is stopped and nothing is rolled back"
        );
    }

    #[test]
    fn a_failed_start_after_a_same_version_replacement_does_not_roll_back() {
        let scratch = Scratch::new("new-sha-start-fails");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![
            probe_with_release("2.0.0", &"0".repeat(64)),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            start_failed("timeout"),
        ]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_START_FAILED");
        assert_eq!(fake.names(), vec!["probe", "status", "install", "start"]);
    }

    #[test]
    fn old_glibc_refuses_the_standard_bundle_before_any_upload() {
        let scratch = Scratch::new("glibc-old");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![probe_with_glibc("", "2.31"), ok(STOPPED_STATUS)]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_GLIBC_TOO_OLD");
        assert_eq!(
            err.message,
            "This server's system libraries are too old for the standard server bundle (glibc 2.31; 2.34 needed). \
             Build the compatible bundle and try again."
        );
        assert_eq!(fake.names(), vec!["probe", "status"], "no INSTALL, and no byte of the bundle is uploaded");
    }

    #[test]
    fn old_glibc_is_checked_before_a_running_core_is_stopped() {
        let scratch = Scratch::new("glibc-old-running");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_with_glibc("2.0.0", "2.31"),
            state_out(3461, OLD, "2.0.0"),
        ]);
        let healthy = |_: u16| Some(OLD.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_GLIBC_TOO_OLD");
        assert_eq!(fake.names(), vec!["probe", "status"], "the running core is left alone");
    }

    #[test]
    fn old_glibc_with_the_compat_bundle_installs() {
        let scratch = Scratch::new("glibc-compat");
        let ep = key_endpoint();
        let compat = scratch.dir.join("llmide-core-2.0.0-linux-x64-compat.tar.gz");
        std::fs::write(&compat, TARBALL).unwrap();
        let mut compat_input = input(&ep, &scratch, None);
        compat_input.bundle = compat.as_path();
        let fake = FakeExec::new(vec![
            probe_with_glibc("", "2.31"),
            ok(STOPPED_STATUS),
            ok(INSTALL_OK),
            started_out(3460, "2.0.0"),
        ]);
        let healthy = started_health(&fake);
        expect_ok(connect_with(&fake, &healthy, compat_input, &|| Some(3456)));
        assert_eq!(fake.names(), vec!["probe", "status", "install", "start", "forward"]);
    }

    #[test]
    fn a_busy_start_is_its_own_code_and_triggers_no_rollback() {
        let scratch = Scratch::new("busy-fresh");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![probe_out(""), ok(STOPPED_STATUS), ok(INSTALL_OK), start_failed("busy")]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_START_BUSY");
        assert_eq!(err.message, "The server is already starting. Try again in a moment.");
        assert_eq!(fake.names(), vec!["probe", "status", "install", "start"]);
    }

    #[test]
    fn a_busy_start_during_an_update_does_not_roll_back() {
        let scratch = Scratch::new("busy-update");
        let ep = key_endpoint();
        record_running_core(&scratch, &ep, OLD);
        let fake = FakeExec::new(vec![
            probe_out("1.0.0"),
            state_out(3460, OLD, "1.0.0"),
            ok(INSTALL_OK),
            ok(STOP_OK),
            start_failed("busy"),
        ]);
        let healthy = |_: u16| Some(OLD.to_string());
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_START_BUSY");
        assert_eq!(fake.names(), vec!["probe", "status", "install", "stop", "start"], "no rollback runs");
    }

    #[test]
    fn install_failures_name_their_own_cause() {
        let cases = [
            ("checksum", "SSH_INSTALL_FAILED", "The upload was damaged. Try again."),
            ("unpack", "SSH_INSTALL_FAILED", "The server could not unpack the bundle."),
            (
                "disk",
                "SSH_DISK_LOW",
                "The server ran out of disk space during the install. Free space in the home folder, then try again.",
            ),
            ("layout", "SSH_INSTALL_FAILED", "the server could not install the core"),
            ("failed", "SSH_INSTALL_FAILED", "the server could not install the core"),
        ];
        for (marker, code, message) in cases {
            let scratch = Scratch::new("install-msg");
            let ep = key_endpoint();
            let fake = FakeExec::new(vec![probe_out(""), ok(STOPPED_STATUS), install_failed(marker)]);
            let healthy = started_health(&fake);
            let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
            assert_eq!((err.code, err.message.as_str()), (code, message), "for marker {marker}");
        }
    }

    #[test]
    fn an_install_transport_failure_keeps_its_own_mapping() {
        let scratch = Scratch::new("install-transport");
        let ep = key_endpoint();
        let fake = FakeExec::new(vec![probe_out(""), ok(STOPPED_STATUS), ssh_error(TIMED_OUT)]);
        let healthy = started_health(&fake);
        let err = expect_err(connect_with(&fake, &healthy, input(&ep, &scratch, None), &|| Some(3456)));
        assert_eq!(err.code, "SSH_UNREACHABLE");
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

    /// Serializes the tests that read or set `LLMIDE_HUB_BUNDLE` and `LLMIDE_REPO_ROOT`, which are process-wide.
    /// The `ssh_cmds` bundle test takes it too: an override set by another test would change what `bundle_for` returns.
    pub(crate) static BUNDLE_ENV_TESTS: Mutex<()> = Mutex::new(());

    /// A throwaway repository root (only `extension/server.mjs`), removed on drop.
    struct FakeRepo(PathBuf);

    impl FakeRepo {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let root = std::env::temp_dir().join(format!("llmide-bundle-{label}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(root.join("extension")).unwrap();
            std::fs::write(root.join("extension").join("server.mjs"), b"").unwrap();
            Self(root)
        }

        /// Writes a bundle named `name` into `<root>/<folder>` and returns its path.
        fn put(&self, folder: &str, name: &str) -> PathBuf {
            let dir = self.0.join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(name);
            std::fs::write(&path, b"tarball").unwrap();
            path
        }
    }

    impl Drop for FakeRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Sets (or removes) one environment variable and restores the previous value when dropped.
    struct RestoreEnv {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl RestoreEnv {
        fn new(key: &'static str, value: Option<&std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            Self { key, previous }
        }
    }

    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    const BUNDLE_VERSION: &str = "9.8.7";

    fn compat_name() -> String {
        format!("llmide-core-{BUNDLE_VERSION}-linux-x64-compat.tar.gz")
    }

    fn plain_name() -> String {
        format!("llmide-core-{BUNDLE_VERSION}-linux-x64.tar.gz")
    }

    fn both_names() -> [String; 2] {
        [compat_name(), plain_name()]
    }

    #[test]
    fn bundle_search_finds_the_staged_folder_under_the_repo_root() {
        let repo = FakeRepo::new("staged");
        let staged = repo.put("desktop/hub-dist", &compat_name());
        assert_eq!(search_bundle(&repo.0, &both_names()), Some(staged));
    }

    #[test]
    fn bundle_search_still_reads_the_old_dist_hub_folder() {
        let repo = FakeRepo::new("legacy");
        let legacy = repo.put("desktop/dist/hub", &plain_name());
        assert_eq!(search_bundle(&repo.0, &[plain_name()]), Some(legacy));
    }

    #[test]
    fn bundle_search_prefers_the_compat_name_in_any_folder() {
        let repo = FakeRepo::new("prefer");
        repo.put("desktop/resources/hub", &plain_name());
        let compat = repo.put("desktop/hub-dist", &compat_name());
        assert_eq!(search_bundle(&repo.0, &both_names()), Some(compat));
    }

    #[test]
    fn bundle_search_for_the_hub_ignores_the_compat_name() {
        let repo = FakeRepo::new("hub-plain");
        repo.put("desktop/hub-dist", &compat_name());
        assert_eq!(search_bundle(&repo.0, &[plain_name()]), None);
    }

    #[test]
    fn bundle_search_returns_none_when_nothing_is_staged() {
        let repo = FakeRepo::new("empty");
        assert_eq!(search_bundle(&repo.0, &both_names()), None);
    }

    #[test]
    fn bundle_for_searches_the_repo_root_not_the_working_directory() {
        let _serial = BUNDLE_ENV_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let repo = FakeRepo::new("root");
        let staged = repo.put("desktop/hub-dist", &compat_name());
        let _root = RestoreEnv::new("LLMIDE_REPO_ROOT", Some(repo.0.as_os_str()));
        let _bundle = RestoreEnv::new("LLMIDE_HUB_BUNDLE", None);
        assert_eq!(bundle_for(BUNDLE_VERSION), Some(staged.to_string_lossy().into_owned()));
    }

    #[test]
    fn explicit_hub_bundle_wins_over_a_found_candidate() {
        let _serial = BUNDLE_ENV_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let repo = FakeRepo::new("explicit");
        repo.put("desktop/hub-dist", &compat_name());
        let explicit = repo.put("custom", "chosen.tar.gz");
        let _root = RestoreEnv::new("LLMIDE_REPO_ROOT", Some(repo.0.as_os_str()));
        let _bundle = RestoreEnv::new("LLMIDE_HUB_BUNDLE", Some(explicit.as_os_str()));
        assert_eq!(bundle_for(BUNDLE_VERSION), Some(explicit.to_string_lossy().into_owned()));
    }

    #[test]
    fn missing_explicit_hub_bundle_is_ignored() {
        let _serial = BUNDLE_ENV_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let repo = FakeRepo::new("missing-env");
        let staged = repo.put("desktop/hub-dist", &compat_name());
        let gone = repo.0.join("gone.tar.gz");
        let _root = RestoreEnv::new("LLMIDE_REPO_ROOT", Some(repo.0.as_os_str()));
        let _bundle = RestoreEnv::new("LLMIDE_HUB_BUNDLE", Some(gone.as_os_str()));
        assert_eq!(bundle_for(BUNDLE_VERSION), Some(staged.to_string_lossy().into_owned()));
    }
}
