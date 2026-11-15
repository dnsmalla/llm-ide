//! SSH server mode, service layer: the plain functions the host commands call.
//!
//! Every function takes its outside pieces through [`Deps`], so tests replace the ssh runner, the key scan,
//! the native dialog and the server bundle. The server's host key is pinned once, in preferences
//! (`ssh_host_pin`). Each ssh call after that runs with `StrictHostKeyChecking=yes` against a one-line
//! known_hosts file built from the pin, so ssh itself refuses a server whose key has changed.
//!
//! The password is taken per call and handed only to the askpass grant inside `ssh_session::Link`. It is
//! never stored, logged, or placed in an argv, an environment variable, a status or an error. Error messages
//! are fixed text; ssh's stderr is never shown.

// NOTE: no production code calls this module yet; Task 9b wraps these functions in Tauri commands and removes this allow.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::confirm::herr;
use crate::core_host::CoreHost;
use crate::fs_ops::FsError;
use crate::prefs::{self, ServerMode, SshAuthKind};
use crate::remote::{temp_ssh_dir, valid_fingerprint, valid_host_key_type, write_known_hosts, PreparedTarget, RawOutput};
use crate::remote_deploy::{fingerprint_for_key_b64, known_host_name};
use crate::ssh_link::{supervise, SshLink, SuperviseInput};
use crate::ssh_server_scripts::{parse_probe, parse_stop, parse_uninstall, ClaudeState, PROBE, STOP, UNINSTALL};
use crate::ssh_session::{connect_with, pick_local_port, ConnectInput, Link};
use crate::ssh_transport::{prepare_endpoint, SshAuth, SshEndpoint, SshExec};

/// Key types in the order a scan is searched. The first one the server offers is the one pinned.
const KEY_PREFERENCE: [&str; 7] = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
];

/// How long `/health` may take through the forward on connect, matching the first connect of the session.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

/// Host keys the user has seen in this session, keyed by `host:port`. A confirm is accepted only for a key
/// the last Test saw, so the webview cannot confirm a key the server never offered.
static OBSERVED: OnceLock<Mutex<HashMap<String, Offered>>> = OnceLock::new();

/// The version and Claude state of the last connect that succeeded. Cleared by disconnect, stop and uninstall.
static REMEMBERED: Mutex<Option<Remembered>> = Mutex::new(None);

/// The known_hosts folder the attached link reads. Replaced on attach; removed on disconnect and stop.
static LIVE_DIR: Mutex<Option<KnownHostsDir>> = Mutex::new(None);

/// What the UI sends. No secret field; unknown fields are refused.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshServerTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
    pub auth: SshAuthKind,
}

/// The result of Test. The probe fields are filled only when the key is trusted.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshServerTest {
    pub host_key_type: String,
    pub fingerprint: String,
    /// True when this exact key is the pinned one for this host and port.
    pub trusted: bool,
    /// True when a pin exists for this host and port but the server now offers another key.
    pub changed: bool,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub free_mb: Option<u64>,
    pub installed_version: Option<String>,
    /// `missing` or the installed CLI version text.
    pub claude: Option<String>,
}

/// The saved server and whether SSH mode serves it. Nothing secret, and no ssh output.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshServerStatus {
    /// Same values as `CoreStatus.link`, or `off` when the app is not in SSH mode.
    pub link: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub local_url: String,
    pub version: String,
    pub claude: String,
    pub error: Option<String>,
}

/// Everything the service needs from outside, so tests can replace it.
pub struct Deps {
    pub exec: Arc<dyn SshExec>,
    /// `ssh-keyscan` output for an endpoint (production runs `ssh-keyscan -T 10 -p <port> <host>`).
    pub scan: Arc<dyn Fn(&SshEndpoint) -> Result<String, FsError> + Send + Sync>,
    /// Native yes/no dialog: (host:port, key type, fingerprint) -> trusted?
    pub ask: Arc<dyn Fn(&str, &str, &str) -> bool + Send + Sync>,
    /// Nonce that `/health` echoes on a local port.
    pub health: Arc<dyn Fn(u16) -> Option<String> + Send + Sync>,
    /// The Linux core bundle for this app version, if one is available.
    pub bundle: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    pub version: String,
    /// The secrets line the core reads from stdin.
    pub secrets_payload: Arc<dyn Fn() -> Result<String, FsError> + Send + Sync>,
    pub session_file: PathBuf,
}

/// A connected, verified link and what `status` remembers about it. `known_hosts` must outlive `link`,
/// which is why the struct drops `link` first (declaration order).
pub struct OpenedLink {
    pub link: SshLink,
    pub version: String,
    pub claude: String,
    pub known_hosts: KnownHostsDir,
}

/// The one-line known_hosts folder for an endpoint. Removed when dropped, so it lives exactly as long as
/// the link or call that reads it.
pub struct KnownHostsDir {
    dir: PathBuf,
    file: PathBuf,
}

impl Drop for KnownHostsDir {
    fn drop(&mut self) {
        // Best effort: a folder left behind holds only the public pin line.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The confirmed host key: the type and base64 blob exactly as the server offered them.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Pin {
    key_type: String,
    key_b64: String,
}

/// A key a scan offered, with its fingerprint computed once.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Offered {
    key_type: String,
    key_b64: String,
    fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Remembered {
    version: String,
    claude: String,
}

/// Tests the server's host key. Logs in only when the key already matches the pin.
///
/// Preconditions: `target` is shape-checked by `prepare_endpoint`; a password login has a password.
/// Postconditions: the offered key is remembered for `confirm`. The password is offered to ssh only when
/// the key is trusted; an untrusted server is never logged into.
///
/// Errors:
///     `SSH_PASSWORD_REQUIRED`, `SSH_UNREACHABLE` (no usable key offered), `SSH_AUTH_FAILED` and the
///     transport codes of the probe.
pub fn test(deps: &Deps, target: &SshServerTarget, password: Option<&str>) -> Result<SshServerTest, FsError> {
    let endpoint = target_endpoint(target, password)?;
    let offered = scan_offered(deps, &endpoint)?;
    locked(observed()).insert(endpoint_key(&endpoint), offered.clone());
    match pin_for(&endpoint) {
        Some(pin) if pin.key_type == offered.key_type && pin.key_b64 == offered.key_b64 => {
            probe_trusted(deps, &endpoint, &pin, &offered, password)
        }
        pin => Ok(base_result(&offered, false, pin.is_some())),
    }
}

/// Pins the host key the last Test saw, after the native dialog says yes. Never logs in.
///
/// Errors:
///     `invalid_host_key` and `invalid_fingerprint` for a bad shape, `host_key_not_observed` when no Test saw
///     this key, `cancelled` when the dialog says no (nothing is stored).
pub fn confirm(deps: &Deps, target: &SshServerTarget, key_type: &str, fingerprint: &str) -> Result<SshServerTest, FsError> {
    // No password here: confirm never logs in, and the UI runs Test again before any login.
    let endpoint = endpoint_shape(target)?;
    if !valid_host_key_type(key_type) {
        return Err(herr("invalid_host_key", "the host key type is not a known SSH key type"));
    }
    if !valid_fingerprint(fingerprint) {
        return Err(herr("invalid_fingerprint", "the fingerprint is not an SSH SHA256 fingerprint"));
    }
    let offered = locked(observed())
        .get(&endpoint_key(&endpoint))
        .cloned()
        .filter(|seen| seen.key_type == key_type && seen.fingerprint == fingerprint)
        .ok_or_else(|| herr("host_key_not_observed", "Test the connection again before trusting this key."))?;
    let shown = format!("{}:{}", endpoint.host, endpoint.port);
    if !(deps.ask)(&shown, &offered.key_type, &offered.fingerprint) {
        return Err(herr("cancelled", "The server's host key was not trusted, so nothing was saved."));
    }
    prefs::set_ssh_host_pin(pin_text(&endpoint, &offered))?;
    Ok(base_result(&offered, true, false))
}

/// Connects without touching preferences or the core host. Used by [`connect`] and by the startup connector.
///
/// Preconditions: a pin exists for the endpoint, a bundle is available, and a password is given for a
/// password login.
/// Postconditions: on success the link is supervised; on failure no forward and no folder is left.
///
/// Errors:
///     `SSH_PASSWORD_REQUIRED`, `SSH_HOST_KEY_UNCONFIRMED`, `SSH_BUNDLE_MISSING`, plus the codes of
///     `ssh_session::connect`.
pub fn open_link(deps: &Deps, target: &SshServerTarget, password: Option<&str>) -> Result<OpenedLink, FsError> {
    let endpoint = target_endpoint(target, password)?;
    let pin = require_pin(&endpoint)?;
    let bundle = (deps.bundle)().ok_or_else(|| {
        herr("SSH_BUNDLE_MISSING", "This build has no Linux server bundle. Build it with desktop/scripts/stage-hub-core.mjs.")
    })?;
    let secrets = (deps.secrets_payload)()?;
    let known = pinned_dir(&endpoint, &pin)?;
    let input = ConnectInput {
        endpoint: &endpoint,
        password,
        bundle: bundle.as_path(),
        version: &deps.version,
        secrets_payload: secrets.as_bytes(),
        known_hosts: Some(known.file.as_path()),
        session_file: deps.session_file.as_path(),
        health_timeout: HEALTH_TIMEOUT,
    };
    let connected = connect_with(&*deps.exec, &*deps.health, input, &forward_port)?;
    let version = connected.version.clone();
    let claude = claude_text(&connected.claude);
    // A key login never needs the password again; a password login keeps it for reconnects, in the link only.
    let link_password = match endpoint.auth {
        SshAuth::Password => password.map(str::to_string),
        SshAuth::Key { .. } => None,
    };
    let supervised = SuperviseInput {
        exec: deps.exec.clone(),
        connected,
        endpoint,
        password: link_password,
        known_hosts: known.file.clone(),
        health: deps.health.clone(),
    };
    Ok(OpenedLink { link: supervise(supervised), version, claude, known_hosts: known })
}

/// Connects, then saves SSH mode and serves the link. Preferences change only after a successful connect.
///
/// Errors: the codes of [`open_link`], plus any preference validation error.
pub fn connect(deps: &Deps, host: &CoreHost, target: &SshServerTarget, password: Option<&str>) -> Result<SshServerStatus, FsError> {
    let opened = open_link(deps, target, password)?;
    prefs::set_remote_ssh(
        target.host.clone(),
        target.port,
        target.user.clone(),
        target.key_path.clone(),
        target.auth,
        ServerMode::Ssh,
    )?;
    Ok(attach_link(host, opened))
}

/// Makes an opened link the one SSH mode serves. Outside SSH mode the link is stopped again, because the mode
/// applies only at the next app start; the status then reports `restart_required`.
pub fn attach_link(host: &CoreHost, opened: OpenedLink) -> SshServerStatus {
    let OpenedLink { link, version, claude, known_hosts } = opened;
    *locked(&REMEMBERED) = Some(Remembered { version, claude });
    if host.mode() == ServerMode::Ssh {
        // Stops the previous link first; its folder is replaced only after that link has stopped reading it.
        host.attach_ssh_link(link);
        *locked(&LIVE_DIR) = Some(known_hosts);
        build_status(host, None)
    } else {
        drop(link);
        drop(known_hosts);
        build_status(host, Some("restart_required"))
    }
}

/// Stops the forward. The server core keeps running; no ssh call is made.
pub fn disconnect(host: &CoreHost) -> SshServerStatus {
    host.detach_ssh_link();
    forget_session();
    build_status(host, Some(stopped_label(host)))
}

/// The saved server and the link state. Not in SSH mode, the link is `off`.
pub fn status(host: &CoreHost) -> SshServerStatus {
    build_status(host, None)
}

/// Stops the forward, then stops the server core named in state.json.
///
/// Errors:
///     `SSH_PASSWORD_REQUIRED`, `SSH_HOST_KEY_UNCONFIRMED`, the transport codes, `SSH_STOP_UNKNOWN` and
///     `SSH_STOP_FAILED`.
pub fn stop_server(deps: &Deps, host: &CoreHost, password: Option<&str>) -> Result<SshServerStatus, FsError> {
    let endpoint = saved_endpoint(password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    host.detach_ssh_link();
    forget_session();
    let output = run_pinned(deps, &endpoint, &pinned, password, STOP)?;
    parse_stop(&output.stdout)?;
    Ok(build_status(host, Some(stopped_label(host))))
}

/// Stops the forward and the server core, then removes the releases. Data on the server is kept.
///
/// Errors:
///     `confirm_mismatch` when `confirm_host` is not the saved host name (no ssh call), then the codes of
///     [`stop_server`].
pub fn uninstall(deps: &Deps, host: &CoreHost, password: Option<&str>, confirm_host: &str) -> Result<SshServerStatus, FsError> {
    let saved_host = prefs::stored().remote_server.host;
    if !confirm_host.trim().eq_ignore_ascii_case(saved_host.trim()) {
        return Err(herr("confirm_mismatch", "Type the server's host name to uninstall."));
    }
    let endpoint = saved_endpoint(password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    host.detach_ssh_link();
    forget_session();
    let output = run_pinned(deps, &endpoint, &pinned, password, UNINSTALL)?;
    parse_stop(&output.stdout)?;
    parse_uninstall(&output.stdout)?;
    Ok(build_status(host, Some(stopped_label(host))))
}

// ---- helpers ----------------------------------------------------------------------------------------------

/// Locks a process-wide slot. A poisoned lock still holds valid data, so the guard is taken anyway.
fn locked<T>(slot: &Mutex<T>) -> MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

fn observed() -> &'static Mutex<HashMap<String, Offered>> {
    OBSERVED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The pin is per `host:port`, lower-cased, so a case change in the typed host does not make a new pin.
fn endpoint_key(endpoint: &SshEndpoint) -> String {
    format!("{}:{}", endpoint.host.to_ascii_lowercase(), endpoint.port)
}

fn endpoint_shape(target: &SshServerTarget) -> Result<SshEndpoint, FsError> {
    let auth = match target.auth {
        SshAuthKind::Key => SshAuth::Key { path: target.key_path.clone() },
        SshAuthKind::Password => SshAuth::Password,
    };
    prepare_endpoint(&target.host, target.port, &target.user, auth)
}

/// A password login needs a non-empty password before any process starts.
fn with_password(endpoint: SshEndpoint, password: Option<&str>) -> Result<SshEndpoint, FsError> {
    if endpoint.auth == SshAuth::Password && !matches!(password, Some(p) if !p.is_empty()) {
        return Err(herr("SSH_PASSWORD_REQUIRED", "Enter the password for this server."));
    }
    Ok(endpoint)
}

/// The loopback port the forward binds. Tests fix one, so they never depend on which ports this machine uses.
#[cfg(not(test))]
fn forward_port() -> Option<u16> {
    pick_local_port()
}

#[cfg(test)]
fn forward_port() -> Option<u16> {
    Some(3456)
}

fn target_endpoint(target: &SshServerTarget, password: Option<&str>) -> Result<SshEndpoint, FsError> {
    with_password(endpoint_shape(target)?, password)
}

/// The endpoint saved in preferences, for the calls that take no target (stop, uninstall, and the link).
fn saved_endpoint(password: Option<&str>) -> Result<SshEndpoint, FsError> {
    let saved = prefs::stored().remote_server;
    let target = SshServerTarget {
        host: saved.host,
        port: saved.port,
        user: saved.user,
        key_path: saved.key_path,
        auth: saved.ssh_auth,
    };
    target_endpoint(&target, password)
}

/// The first key the scan offers that this app understands, in [`KEY_PREFERENCE`] order. The scan's host
/// column is ignored: it is untrusted, and the key is tied only to the endpoint the user typed.
fn pick_offered(scan: &str) -> Option<Offered> {
    for wanted in KEY_PREFERENCE {
        for raw in scan.lines() {
            let mut fields = raw.split_whitespace();
            let (Some(_scanned_host), Some(key_type), Some(key_b64)) = (fields.next(), fields.next(), fields.next()) else {
                continue;
            };
            if key_type != wanted {
                continue;
            }
            if let Some(fingerprint) = fingerprint_for_key_b64(key_b64) {
                return Some(Offered { key_type: key_type.to_string(), key_b64: key_b64.to_string(), fingerprint });
            }
        }
    }
    None
}

fn scan_offered(deps: &Deps, endpoint: &SshEndpoint) -> Result<Offered, FsError> {
    let scan = (deps.scan)(endpoint)?;
    pick_offered(&scan).ok_or_else(|| herr("SSH_UNREACHABLE", "Could not reach the server."))
}

/// The pin for this endpoint, or `None` when the saved pin names another host or port or is malformed.
fn pin_for(endpoint: &SshEndpoint) -> Option<Pin> {
    let saved = prefs::stored().remote_server.ssh_host_pin;
    let mut fields = saved.split_whitespace();
    let (Some(host_port), Some(key_type), Some(key_b64), None) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return None;
    };
    let (host, port) = host_port.rsplit_once(':')?;
    if host != endpoint.host.to_ascii_lowercase() || port.parse::<u16>().ok() != Some(endpoint.port) {
        return None;
    }
    if !valid_host_key_type(key_type) || fingerprint_for_key_b64(key_b64).is_none() {
        return None;
    }
    Some(Pin { key_type: key_type.to_string(), key_b64: key_b64.to_string() })
}

fn require_pin(endpoint: &SshEndpoint) -> Result<Pin, FsError> {
    pin_for(endpoint).ok_or_else(|| herr("SSH_HOST_KEY_UNCONFIRMED", "Test the connection and confirm the server's host key first."))
}

/// The preference text for a confirmed key: `<host>:<port> <key-type> <key-base64>`, host lower-cased.
fn pin_text(endpoint: &SshEndpoint, offered: &Offered) -> String {
    format!("{}:{} {} {}", endpoint.host.to_ascii_lowercase(), endpoint.port, offered.key_type, offered.key_b64)
}

/// Writes one known_hosts line for the pin into a fresh folder. The folder is owned by the returned value and
/// removed when it drops, including when the write fails.
fn pinned_dir(endpoint: &SshEndpoint, pin: &Pin) -> Result<KnownHostsDir, FsError> {
    let dir = temp_ssh_dir("ssh-server")?;
    let held = KnownHostsDir { file: dir.join("known_hosts"), dir };
    let target = PreparedTarget {
        host: endpoint.host.to_ascii_lowercase(),
        port: endpoint.port,
        user: endpoint.user.clone(),
        key_path: String::new(),
    };
    let line = format!("{} {} {}", known_host_name(&target), pin.key_type, pin.key_b64);
    write_known_hosts(&held.dir, &line)?;
    Ok(held)
}

fn base_result(offered: &Offered, trusted: bool, changed: bool) -> SshServerTest {
    SshServerTest {
        host_key_type: offered.key_type.clone(),
        fingerprint: offered.fingerprint.clone(),
        trusted,
        changed,
        os: None,
        arch: None,
        free_mb: None,
        installed_version: None,
        claude: None,
    }
}

/// Logs in with the pinned known_hosts and reads the server's state. Used only for a trusted key.
fn probe_trusted(
    deps: &Deps,
    endpoint: &SshEndpoint,
    pin: &Pin,
    offered: &Offered,
    password: Option<&str>,
) -> Result<SshServerTest, FsError> {
    let pinned = pinned_dir(endpoint, pin)?;
    let link = Link { exec: &*deps.exec, endpoint, known_hosts: &pinned.file, password };
    let probe = parse_probe(&link.run(PROBE, None)?.stdout)?;
    let mut result = base_result(offered, true, false);
    result.os = Some(probe.os);
    result.arch = Some(probe.arch);
    result.free_mb = Some(probe.free_mb);
    result.installed_version = probe.current;
    result.claude = Some(claude_text(&probe.claude));
    Ok(result)
}

/// Runs one fixed script over the pinned known_hosts, with the password when the endpoint needs one.
fn run_pinned(
    deps: &Deps,
    endpoint: &SshEndpoint,
    pinned: &KnownHostsDir,
    password: Option<&str>,
    script: &'static str,
) -> Result<RawOutput, FsError> {
    let link = Link { exec: &*deps.exec, endpoint, known_hosts: &pinned.file, password };
    link.run(script, None)
}

fn claude_text(state: &ClaudeState) -> String {
    match state {
        ClaudeState::Missing => "missing".to_string(),
        ClaudeState::Installed { version } => version.clone(),
    }
}

fn forget_session() {
    *locked(&REMEMBERED) = None;
    *locked(&LIVE_DIR) = None;
}

/// The label for a link that was just stopped by this app. SSH mode reads `stopped`; any other mode has no link.
fn stopped_label(host: &CoreHost) -> &'static str {
    if host.mode() == ServerMode::Ssh { "stopped" } else { "off" }
}

fn build_status(host: &CoreHost, link_override: Option<&'static str>) -> SshServerStatus {
    let saved = prefs::stored().remote_server;
    let core = host.status();
    let in_ssh = host.mode() == ServerMode::Ssh;
    let link = match (link_override, in_ssh, core.link) {
        (Some(label), _, _) => label,
        (None, true, Some(label)) => label,
        _ => "off",
    };
    let remembered = locked(&REMEMBERED)
        .clone()
        .unwrap_or_else(|| Remembered { version: String::new(), claude: "unknown".to_string() });
    SshServerStatus {
        link: link.to_string(),
        host: saved.host,
        port: saved.port,
        user: saved.user,
        local_url: if in_ssh { core.url } else { String::new() },
        version: remembered.version,
        claude: remembered.claude,
        error: if in_ssh { core.error } else { None },
    }
}

/// The folder the live link reads, for tests that check it lives as long as the link.
#[cfg(test)]
pub(crate) fn live_known_hosts() -> Option<PathBuf> {
    locked(&LIVE_DIR).as_ref().map(|held| held.file.clone())
}

/// Clears the process-wide slots so one test's observed keys and link folder cannot reach the next.
#[cfg(test)]
fn reset_for_tests() {
    locked(observed()).clear();
    forget_session();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_host::tests::mode_guard;
    use crate::prefs::{prefs_guard, set_remote_server_for_test, set_ssh_host_pin, RemoteServerPrefs};
    use crate::ssh_link::{supervise, SuperviseInput};
    use crate::ssh_server_scripts::{ClaudeState, STOP, UNINSTALL};
    use crate::ssh_session::tests::{
        ok, probe_out, ssh_error, state_out, FakeExec, NEW, PASSWORD, PERMISSION_DENIED, STOPPED_STATUS, TIMED_OUT,
    };
    use crate::ssh_session::Connected;
    use crate::ssh_transport::ForwardChild;
    use base64::Engine as _;
    use std::io;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, MutexGuard};

    const HOST: &str = "example.com";
    const KEY_PATH: &str = "/home/alice/.ssh/id_ed25519";
    const PAYLOAD: &str = r#"{"jwtSecret":"j","vaultKey":"v","hostApprovalKey":"a"}"#;
    const INSTALL_OK: &str = "__LLMIDE_INSTALL__=ok\n";
    const STOP_OK: &str = "__LLMIDE_STOP__=stopped\n";
    const UNINSTALL_OK: &str = "__LLMIDE_STOP__=not_running\n__LLMIDE_UNINSTALL__=ok\n";
    const BUNDLE_BYTES: &[u8] = b"fake-tarball-bytes";

    fn key_b64(seed: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(seed.as_bytes())
    }

    /// One scan line. The host column says something else on purpose: the service must ignore it.
    fn scan_of(seed: &str) -> String {
        format!("attacker.example ssh-ed25519 {}\n", key_b64(seed))
    }

    fn pin_text(port: u16, seed: &str) -> String {
        format!("{HOST}:{port} ssh-ed25519 {}", key_b64(seed))
    }

    fn fingerprint_of(seed: &str) -> String {
        fingerprint_for_key_b64(&key_b64(seed)).unwrap()
    }

    fn target(port: u16, auth: SshAuthKind) -> SshServerTarget {
        SshServerTarget { host: HOST.into(), port, user: "alice".into(), key_path: KEY_PATH.into(), auth }
    }

    fn fake(outputs: Vec<io::Result<RawOutput>>) -> Arc<FakeExec> {
        Arc::new(FakeExec::new(outputs))
    }

    /// PROBE, STATUS, INSTALL and START for a fresh server, in the order `ssh_session::connect` runs them.
    fn connect_outputs() -> Vec<io::Result<RawOutput>> {
        vec![probe_out(""), ok(STOPPED_STATUS), ok(INSTALL_OK), state_out(3460, NEW, "2.0.0")]
    }

    fn has_option(args: &[String], value: &str) -> bool {
        args.windows(2).any(|w| w[0] == "-o" && w[1] == value)
    }

    fn code<T: std::fmt::Debug>(result: Result<T, FsError>) -> &'static str {
        result.unwrap_err().code
    }

    fn saved_key_block() -> RemoteServerPrefs {
        RemoteServerPrefs {
            mode: ServerMode::Ssh,
            host: HOST.into(),
            port: 22,
            user: "alice".into(),
            key_path: KEY_PATH.into(),
            ssh_auth: SshAuthKind::Key,
            ..RemoteServerPrefs::default()
        }
    }

    /// Forward that never exits on its own and counts its kills.
    struct CountingForward {
        kills: Arc<AtomicUsize>,
    }

    impl ForwardChild for CountingForward {
        fn try_exited(&mut self) -> Option<i32> {
            None
        }

        fn kill(&mut self) {
            self.kills.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Process-wide state a test may change, held for the whole test. Preferences are taken before the
    /// CoreHost mode, always in that order. Everything is put back on drop.
    struct Fixture {
        dir: PathBuf,
        host: CoreHost,
        scans: Arc<AtomicUsize>,
        asks: Arc<AtomicUsize>,
        _prefs: MutexGuard<'static, ()>,
        _mode: MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let prefs = prefs_guard();
            let mode = mode_guard();
            let dir = temp_ssh_dir(label).unwrap();
            let host = CoreHost::new();
            host.set_mode(ServerMode::Local);
            set_remote_server_for_test(RemoteServerPrefs::default());
            reset_for_tests();
            Self { dir, host, scans: Arc::default(), asks: Arc::default(), _prefs: prefs, _mode: mode }
        }

        fn deps(&self, exec: &Arc<FakeExec>, scan: &str, answer: bool, bundle: bool) -> Deps {
            let bundle_path = self.dir.join("llmide-core-2.0.0-linux-x64.tar.gz");
            if bundle {
                std::fs::write(&bundle_path, BUNDLE_BYTES).unwrap();
            }
            let bundle_path = bundle.then_some(bundle_path);
            let scan = scan.to_string();
            let (scans, asks) = (self.scans.clone(), self.asks.clone());
            Deps {
                exec: exec.clone(),
                scan: Arc::new(move |_: &SshEndpoint| {
                    scans.fetch_add(1, Ordering::SeqCst);
                    Ok(scan.clone())
                }),
                ask: Arc::new(move |_: &str, _: &str, _: &str| {
                    asks.fetch_add(1, Ordering::SeqCst);
                    answer
                }),
                health: Arc::new(|_: u16| Some(NEW.to_string())),
                bundle: Arc::new(move || bundle_path.clone()),
                version: "2.0.0".into(),
                secrets_payload: Arc::new(|| Ok(PAYLOAD.to_string())),
                session_file: self.dir.join("state").join("ssh-session.json"),
            }
        }

        /// Attaches a real supervised link whose forward counts its kills, and puts the host in SSH mode.
        fn attach_live_link(&self, exec: &Arc<FakeExec>, kills: &Arc<AtomicUsize>) {
            let connected = Connected {
                local_url: "http://127.0.0.1:3456".into(),
                local_port: 3456,
                remote_port: 3460,
                nonce: NEW.into(),
                version: "2.0.0".into(),
                claude: ClaudeState::Missing,
                forward: Box::new(CountingForward { kills: kills.clone() }),
            };
            let input = SuperviseInput {
                exec: exec.clone(),
                connected,
                endpoint: crate::ssh_session::tests::key_endpoint(),
                password: None,
                known_hosts: self.dir.join("known_hosts"),
                health: Arc::new(|_: u16| Some(NEW.to_string())),
            };
            self.host.set_mode(ServerMode::Ssh);
            self.host.attach_ssh_link(supervise(input));
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.host.detach_ssh_link();
            self.host.set_mode(ServerMode::Local);
            set_remote_server_for_test(RemoteServerPrefs::default());
            reset_for_tests();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn status_serializes_without_secrets() {
        let fx = Fixture::new("svc-secrets");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let mut seen = Vec::new();

        let good = fake(connect_outputs());
        let deps = fx.deps(&good, "", true, true);
        let status = connect(&deps, &fx.host, &target(22, SshAuthKind::Password), Some(PASSWORD)).unwrap();
        seen.push(serde_json::to_string(&status).unwrap());

        let refused = fake(vec![ssh_error(PERMISSION_DENIED)]);
        let deps = fx.deps(&refused, "", true, true);
        let error = connect(&deps, &fx.host, &target(22, SshAuthKind::Password), Some(PASSWORD)).unwrap_err();
        seen.push(format!("{} {}", error.code, error.message));

        for call in good.calls().iter().chain(refused.calls().iter()) {
            seen.push(call.args.join(" "));
        }
        let all = seen.join("\n");
        assert!(!all.contains(PASSWORD), "the password reached a status, an argv or an error: {all}");
    }

    #[test]
    fn target_rejects_unknown_fields() {
        let valid = r#"{"host":"example.com","port":22,"user":"alice","keyPath":"/k","auth":"key"}"#;
        assert!(serde_json::from_str::<SshServerTarget>(valid).is_ok());
        let with_password = r#"{"host":"example.com","port":22,"user":"alice","keyPath":"/k","auth":"key","password":"hunter2"}"#;
        assert!(serde_json::from_str::<SshServerTarget>(with_password).is_err());
    }

    #[test]
    fn test_untrusted_key_makes_no_login() {
        let fx = Fixture::new("svc-untrusted");
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let result = test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        assert!(!result.trusted);
        assert!(!result.changed);
        assert_eq!(result.host_key_type, "ssh-ed25519");
        assert_eq!(result.fingerprint, fingerprint_of("key-a"));
        assert_eq!(result.os, None);
        assert!(exec.calls().is_empty(), "an unconfirmed server is never logged into");
    }

    #[test]
    fn test_changed_key_is_flagged() {
        let fx = Fixture::new("svc-changed");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-b"), true, true);
        let result = test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        assert!(result.changed);
        assert!(!result.trusted);
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn test_trusted_key_runs_probe() {
        let fx = Fixture::new("svc-trusted");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![probe_out("2.0.0")]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let result = test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        assert!(result.trusted && !result.changed);
        assert_eq!(exec.names(), vec!["probe"]);
        assert!(has_option(&exec.calls()[0].args, "StrictHostKeyChecking=yes"));
        assert_eq!(result.os.as_deref(), Some("Linux"));
        assert_eq!(result.arch.as_deref(), Some("x86_64"));
        assert_eq!(result.free_mb, Some(5000));
        assert_eq!(result.installed_version.as_deref(), Some("2.0.0"));
        assert_eq!(result.claude.as_deref(), Some("2.1.0 (Claude Code)"));
    }

    #[test]
    fn confirm_needs_an_observed_key() {
        let fx = Fixture::new("svc-unobserved");
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let result = confirm(&deps, &target(22, SshAuthKind::Key), "ssh-ed25519", &fingerprint_of("key-a"));
        assert_eq!(code(result), "host_key_not_observed");
        assert_eq!(fx.asks.load(Ordering::SeqCst), 0, "the dialog is never shown for a key the host did not offer");
    }

    #[test]
    fn confirm_declined_stores_nothing() {
        let fx = Fixture::new("svc-declined");
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), false, true);
        test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        let result = confirm(&deps, &target(22, SshAuthKind::Key), "ssh-ed25519", &fingerprint_of("key-a"));
        assert_eq!(code(result), "cancelled");
        assert_eq!(fx.asks.load(Ordering::SeqCst), 1);
        assert_eq!(prefs::stored().remote_server.ssh_host_pin, "", "a declined dialog stores no pin");
    }

    #[test]
    fn confirm_stores_the_pin() {
        let fx = Fixture::new("svc-confirm");
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        let result = confirm(&deps, &target(22, SshAuthKind::Key), "ssh-ed25519", &fingerprint_of("key-a")).unwrap();
        assert!(result.trusted);
        assert_eq!(result.os, None, "confirm never logs in, so the probe fields stay empty");
        assert_eq!(prefs::stored().remote_server.ssh_host_pin, pin_text(22, "key-a"));
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn a_pin_for_another_port_is_not_trusted() {
        let fx = Fixture::new("svc-port");
        set_ssh_host_pin(pin_text(2222, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let result = test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        assert!(!result.trusted);
        assert!(!result.changed, "a pin for another port counts as no pin");
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn connect_persists_mode_only_on_success() {
        let fx = Fixture::new("svc-persist");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let failing = fake(vec![ssh_error(TIMED_OUT)]);
        let deps = fx.deps(&failing, "", true, true);
        assert_eq!(code(connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None)), "SSH_UNREACHABLE");
        let after_failure = prefs::stored().remote_server;
        assert_eq!(after_failure.mode, ServerMode::Local);
        assert_eq!(after_failure.host, "");

        let good = fake(connect_outputs());
        let deps = fx.deps(&good, "", true, true);
        let status = connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        let saved = prefs::stored().remote_server;
        assert_eq!(saved.mode, ServerMode::Ssh);
        assert_eq!(saved.host, HOST);
        assert_eq!(saved.port, 22);
        assert_eq!(saved.user, "alice");
        assert_eq!(saved.key_path, KEY_PATH);
        assert_eq!(status.link, "restart_required", "the host is not in SSH mode, so the link waits for a restart");
    }

    #[test]
    fn connect_in_ssh_mode_keeps_the_known_hosts_until_disconnect() {
        let fx = Fixture::new("svc-folder");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let exec = fake(connect_outputs());
        let deps = fx.deps(&exec, "", true, true);
        fx.host.set_mode(ServerMode::Ssh);
        let status = connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        assert_eq!(status.link, "connected");
        let known = live_known_hosts().expect("the known_hosts folder lives as long as the link");
        assert!(known.is_file());
        disconnect(&fx.host);
        assert!(!known.exists(), "disconnect removes the folder");
        assert!(live_known_hosts().is_none());
    }

    #[test]
    fn pinned_folder_is_removed_with_its_guard() {
        let endpoint = crate::ssh_session::tests::key_endpoint();
        let pin = Pin { key_type: "ssh-ed25519".into(), key_b64: key_b64("key-a") };
        let held = pinned_dir(&endpoint, &pin).unwrap();
        let file = held.file.clone();
        assert!(file.is_file());
        drop(held);
        assert!(!file.exists());
    }

    #[test]
    fn connect_without_a_pin_is_refused() {
        let fx = Fixture::new("svc-no-pin");
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        assert_eq!(code(connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None)), "SSH_HOST_KEY_UNCONFIRMED");
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn connect_without_a_bundle_is_refused() {
        let fx = Fixture::new("svc-no-bundle");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, false);
        assert_eq!(code(connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None)), "SSH_BUNDLE_MISSING");
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn password_auth_without_a_password_is_refused() {
        let fx = Fixture::new("svc-no-password");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let password_target = target(22, SshAuthKind::Password);
        let refused = test(&deps, &password_target, None).unwrap_err();
        assert_eq!(refused.code, "SSH_PASSWORD_REQUIRED");
        assert_eq!(refused.message, "Enter the password for this server.");
        assert_eq!(code(test(&deps, &password_target, Some(""))), "SSH_PASSWORD_REQUIRED");
        assert_eq!(code(connect(&deps, &fx.host, &password_target, None)), "SSH_PASSWORD_REQUIRED");
        assert_eq!(fx.scans.load(Ordering::SeqCst), 0, "no scan before the password is checked");
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn uninstall_needs_matching_host() {
        let fx = Fixture::new("svc-uninstall");
        set_remote_server_for_test(saved_key_block());
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = uninstall(&deps, &fx.host, None, "other").unwrap_err();
        assert_eq!(refused.code, "confirm_mismatch");
        assert_eq!(refused.message, "Type the server's host name to uninstall.");
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn uninstall_with_the_saved_host_runs_the_uninstall_script() {
        let fx = Fixture::new("svc-uninstall-ok");
        set_remote_server_for_test(saved_key_block());
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        fx.host.set_mode(ServerMode::Ssh);
        let exec = fake(vec![ok(UNINSTALL_OK)]);
        let deps = fx.deps(&exec, "", true, true);
        let status = uninstall(&deps, &fx.host, None, " EXAMPLE.com ").unwrap();
        assert_eq!(status.link, "stopped");
        assert_eq!(exec.calls().len(), 1);
        assert_eq!(exec.calls()[0].args.last().map(String::as_str), Some(UNINSTALL));
    }

    #[test]
    fn uninstall_needs_the_removal_marker() {
        let fx = Fixture::new("svc-uninstall-partial");
        set_remote_server_for_test(saved_key_block());
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        fx.host.set_mode(ServerMode::Ssh);
        // The stop ran, but the script never printed its own ok line.
        let exec = fake(vec![ok("__LLMIDE_STOP__=not_running\n")]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = uninstall(&deps, &fx.host, None, "example.com").unwrap_err();
        assert_eq!(refused.code, "SSH_UNINSTALL_FAILED");
        assert_eq!(refused.message, "The server files could not be removed.");
    }

    #[test]
    fn every_call_is_strict_after_connect_and_stop() {
        let fx = Fixture::new("svc-strict");
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let connect_exec = fake(connect_outputs());
        let deps = fx.deps(&connect_exec, "", true, true);
        connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        let stop_exec = fake(vec![ok(STOP_OK)]);
        let deps = fx.deps(&stop_exec, "", true, true);
        stop_server(&deps, &fx.host, None).unwrap();
        assert!(!connect_exec.calls().is_empty() && !stop_exec.calls().is_empty());
        for call in connect_exec.calls().iter().chain(stop_exec.calls().iter()) {
            assert!(has_option(&call.args, "StrictHostKeyChecking=yes"), "{} is not strict", call.name);
        }
    }

    #[test]
    fn stop_server_detaches_then_stops() {
        let fx = Fixture::new("svc-stop");
        set_remote_server_for_test(saved_key_block());
        set_ssh_host_pin(pin_text(22, "key-a")).unwrap();
        let kills = Arc::new(AtomicUsize::new(0));
        let exec = fake(vec![ok(STOP_OK)]);
        fx.attach_live_link(&exec, &kills);
        let deps = fx.deps(&exec, "", true, true);
        let status = stop_server(&deps, &fx.host, None).unwrap();
        assert_eq!(kills.load(Ordering::SeqCst), 1, "the forward is killed");
        assert_eq!(exec.calls().len(), 1);
        assert_eq!(exec.calls()[0].args.last().map(String::as_str), Some(STOP));
        assert_eq!(status.link, "stopped");
    }

    #[test]
    fn disconnect_makes_no_ssh_call() {
        let fx = Fixture::new("svc-disconnect");
        let kills = Arc::new(AtomicUsize::new(0));
        let exec = fake(vec![]);
        fx.attach_live_link(&exec, &kills);
        let status = disconnect(&fx.host);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert!(exec.calls().is_empty());
        assert_eq!(status.link, "stopped");
    }
}
