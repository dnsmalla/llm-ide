//! SSH server mode, service layer: the plain functions the host commands call.
//!
//! Every function takes its outside pieces through [`Deps`], so tests replace the ssh runner, the key scan,
//! the native dialog and the server bundle. Each server's host key is pinned once, in preferences
//! (`ssh_known_hosts`, one entry per host and port). Each ssh call after that runs with `StrictHostKeyChecking=yes`
//! against a one-line known_hosts file built from that entry, so ssh itself refuses a server whose key has changed.
//!
//! The password is taken per call and handed only to the askpass grant inside `ssh_session::Link`. It is
//! never stored, logged, or placed in an argv, an environment variable, a status or an error. Error messages
//! are fixed text; ssh's stderr is never shown.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::confirm::herr;
use crate::core_host::CoreHost;
use crate::fs_ops::FsError;
use crate::prefs::{self, ServerMode, SshAuthKind};
use crate::remote::{temp_ssh_dir, valid_fingerprint, valid_host_key_type, write_known_hosts, RawOutput};
use crate::host_keys::{fingerprint_for_key_b64, known_hosts_line, parse_scan};
use crate::ssh_link::{supervise, KnownHostsDir, SshLink, SuperviseInput};
use crate::ssh_server_scripts::{parse_core_state, parse_probe, parse_stop, parse_uninstall, ClaudeState, PROBE, STATUS, STOP, UNINSTALL};
use crate::ssh_session::{connect_with, require_ours, ConnectInput, Link};
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

/// Serializes the calls that change the server or the link: open (connect and the startup connector), stop,
/// uninstall and key install. Two of them at once could both see "no core" and both start one, or one could
/// stop a core the other is still checking. Held for the whole call, including the network waits.
///
/// Lock order, outermost first, everywhere in the app:
///   1. `CoreHost::lifecycle` (its `stop` joins the startup thread while holding it),
///   2. this operation lock,
///   3. the `CoreHost` slots (`ssh_link`, then `status`) taken by attach, detach and status reads,
///   4. the preferences lock and this module's `REMEMBERED` and `OBSERVED` slots.
/// The startup connector takes the operation lock with no `CoreHost` lock held (`run_ssh_startup` clones the
/// connector and releases its lock first), so it never runs against the order above. `disconnect` and `status`
/// do not take this lock, so the UI's reads never wait for a connect.
static OPERATION: Mutex<()> = Mutex::new(());

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
    /// The server's glibc version (for example `2.31`), when the server reports one. The UI explains an old
    /// glibc before any upload.
    pub glibc: Option<String>,
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
    /// Whether this build holds the Linux server bundle (the same lookup Connect uses); false means SSH mode cannot connect.
    pub bundle_available: bool,
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
    /// Creates an ed25519 key pair at the private-key path (public key at `<path>.pub`, no passphrase) and
    /// returns the trimmed public line. Production runs the system `ssh-keygen`.
    pub keygen: Arc<dyn Fn(&Path) -> Result<String, FsError> + Send + Sync>,
    pub version: String,
    /// The secrets line the core reads from stdin.
    pub secrets_payload: Arc<dyn Fn() -> Result<String, FsError> + Send + Sync>,
    /// Removes the stored Keychain password of a login (host, port, user). Best effort, never fails the caller.
    pub forget_password: Arc<dyn Fn(&str, u16, &str) + Send + Sync>,
    pub session_file: PathBuf,
}

/// A connected, verified link and what `status` remembers about it. The link owns the known_hosts folder it reads.
pub struct OpenedLink {
    pub link: SshLink,
    pub version: String,
    pub claude: String,
}

/// The confirmed host key: the type and base64 blob exactly as the server offered them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pin {
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
    test_inner(deps, target, password, None)
}

/// [`test`] for a password that is fetched only when it is needed: `resolve` runs after the offered key matched the pin,
/// so a server that is not trusted never makes the app read the Keychain. An untrusted answer needs no password.
pub fn test_lazy(deps: &Deps, target: &SshServerTarget, resolve: &dyn Fn() -> Result<Option<String>, FsError>) -> Result<SshServerTest, FsError> {
    test_inner(deps, target, None, Some(resolve))
}

type PasswordSource<'a> = &'a dyn Fn() -> Result<Option<String>, FsError>;

fn test_inner(deps: &Deps, target: &SshServerTarget, password: Option<&str>, lazy: Option<PasswordSource<'_>>) -> Result<SshServerTest, FsError> {
    let endpoint = if lazy.is_some() { endpoint_shape(target)? } else { target_endpoint(target, password)? };
    let offered = scan_offered(deps, &endpoint)?;
    locked(observed()).insert(endpoint_key(&endpoint), offered.clone());
    match pin_for(&endpoint) {
        Some(pin) if pin.key_type == offered.key_type && pin.key_b64 == offered.key_b64 => {
            let resolved = match lazy {
                Some(resolve) => resolve()?,
                None => password.map(str::to_string),
            };
            with_password(endpoint.clone(), resolved.as_deref())?;
            let result = probe_trusted(deps, &endpoint, &pin, &offered, resolved.as_deref())?;
            // The login worked: keep it in the recent list even if the connect that follows fails.
            remember_login(deps, target);
            Ok(result)
        }
        pin => Ok(base_result(&offered, false, pin.is_some())),
    }
}

/// Whether the key the server offers now is the pinned one. Used before the Keychain is read for a connect: only a
/// server that shows its pinned key may cause a Keychain access.
///
/// Errors: `SSH_HOST_KEY_UNCONFIRMED` (no pin), `SSH_HOST_KEY_CHANGED` (another key), `SSH_UNREACHABLE`.
pub fn require_pinned_key_offered(deps: &Deps, target: &SshServerTarget) -> Result<(), FsError> {
    let endpoint = endpoint_shape(target)?;
    let pin = require_pin(&endpoint)?;
    let offered = scan_offered(deps, &endpoint)?;
    if pin.key_type == offered.key_type && pin.key_b64 == offered.key_b64 {
        return Ok(());
    }
    Err(herr("SSH_HOST_KEY_CHANGED", "The server's host key changed. Test the connection again and confirm the new fingerprint."))
}

/// Puts the login in the recent list at once (the saved server and the mode stay as they are). Best effort: a
/// preference write that fails must not fail the check it follows. A login pushed out of the list takes its stored
/// password with it.
fn remember_login(deps: &Deps, target: &SshServerTarget) {
    // A Test never changes the Keychain: a key login over a login with a saved password would orphan it here, so that
    // switch is left to Connect (`set_remote_ssh_collect`).
    if target.auth == SshAuthKind::Key && prefs::ssh_password_saved(&target.host, target.port, &target.user) {
        return;
    }
    if let Ok(orphaned) = prefs::remember_ssh_server(&target.host, target.port, &target.user, &target.key_path, target.auth) {
        forget_orphaned(deps, &orphaned);
    }
}

/// Forgets the Keychain password of every login in `orphaned` (best effort).
pub(crate) fn forget_orphaned(deps: &Deps, orphaned: &[prefs::SshRecentServer]) {
    for entry in orphaned {
        (deps.forget_password)(&entry.host, entry.port, &entry.user);
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
    // A different key was pinned for this server: the passwords saved for it were meant for that key's server. Their
    // flags go before the new pin is stored, so no later connect can send one to the server behind the new key.
    // No pin at all counts as a replacement too: the pin may have been evicted while a login still holds a password.
    let keeps_same_key = pin_for(&endpoint).is_some_and(|old| old.key_type == offered.key_type && old.key_b64 == offered.key_b64);
    if !keeps_same_key {
        let cleared = prefs::clear_ssh_password_flags_for_endpoint(&endpoint.host, endpoint.port)?;
        for user in &cleared {
            (deps.forget_password)(&endpoint.host, endpoint.port, user);
        }
    }
    let (_, evicted) = prefs::upsert_ssh_known_host_collect(pin_text(&endpoint, &offered))?;
    forget_orphaned(deps, &evicted);
    // The host key is trusted: the login is worth keeping even if the sign-in below fails.
    remember_login(deps, target);
    Ok(base_result(&offered, true, false))
}

/// The end-user sentence for a build that cannot do SSH mode; the UI shows the same words up front.
pub(crate) const NO_BUNDLE_IN_BUILD_TEXT: &str = "This build does not include the server files that SSH mode needs.";

/// The `SSH_BUNDLE_MISSING` developer sentence. It names the command and the folder, because a developer who sees
/// only "no bundle" has to search the repository to learn where the bundle goes.
pub(crate) const BUNDLE_MISSING_TEXT: &str = "This build has no Linux server bundle. Build it with: node desktop/scripts/stage-hub-core.mjs --compat-sqlite <module> (it is written to desktop/hub-dist/).";

/// What the user sees without a bundle. A build with no repository checkout (an installed app, where
/// `LLMIDE_OMIT_SOURCE_ROOT` left no source marker) gets plain words instead of the developer command.
pub(crate) fn bundle_missing_text() -> &'static str {
    if crate::core_host::repo_root().is_ok() || crate::feature_rebuild::source_root().is_some() {
        BUNDLE_MISSING_TEXT
    } else {
        NO_BUNDLE_IN_BUILD_TEXT
    }
}

/// Connects without touching preferences or the core host. Used by [`connect`] and by the startup connector.
///
/// Preconditions: a pin exists for the endpoint, a bundle is available, and a password is given for a
/// password login.
/// Postconditions: on success the link is supervised; on failure no forward and no folder is left.
///
/// Errors:
///     `SSH_PASSWORD_REQUIRED`, `SSH_HOST_KEY_UNCONFIRMED`, `SSH_BUNDLE_MISSING`, plus the codes of
///     `ssh_session::connect_with`.
pub fn open_link(deps: &Deps, target: &SshServerTarget, password: Option<&str>) -> Result<OpenedLink, FsError> {
    let _operation = operation();
    open_link_locked(deps, target, password)
}

/// [`open_link`] without taking the operation lock, for callers that already hold it.
fn open_link_locked(deps: &Deps, target: &SshServerTarget, password: Option<&str>) -> Result<OpenedLink, FsError> {
    let endpoint = target_endpoint(target, password)?;
    let pin = require_pin(&endpoint)?;
    let bundle = (deps.bundle)().ok_or_else(|| {
        herr("SSH_BUNDLE_MISSING", bundle_missing_text())
    })?;
    let secrets = (deps.secrets_payload)()?;
    // Owned here: if the connect fails, dropping it removes the folder before this function returns.
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
        known_hosts: known,
        health: deps.health.clone(),
    };
    Ok(OpenedLink { link: supervise(supervised), version, claude })
}

/// Connects, then saves the server and serves the link when the app is already in SSH mode. Preferences change only
/// after a successful connect. The app's mode is kept: it becomes SSH only through [`switch_mode`], so Cancel on the
/// switch leaves the next start local.
///
/// The operation lock is held from the connect to the attach, so a Stop or Uninstall cannot run between them.
///
/// Errors: the codes of [`open_link`], plus any preference validation error.
#[cfg(test)]
pub fn connect(deps: &Deps, host: &CoreHost, target: &SshServerTarget, password: Option<&str>) -> Result<SshServerStatus, FsError> {
    connect_with_options(deps, host, target, password, false)
}

/// [`connect`], optionally taking over first. `take_over` stops the core that is running on the server account, even
/// when this desktop's session record does not own it, and then continues the same connect. It is the user's explicit
/// answer to `SSH_CORE_FOREIGN`: the caller passes it only after that click.
///
/// Everything else is unchanged: the host key must be pinned, the stop runs over the pinned transport
/// (`StrictHostKeyChecking=yes`), and the stop and the connect run under one operation lock, so no other connect,
/// stop or uninstall can run between them.
///
/// Errors: the codes of [`connect`], plus those of the stop (`SSH_STOP_UNKNOWN`, `SSH_STOP_FAILED`).
pub fn connect_with_options(
    deps: &Deps,
    host: &CoreHost,
    target: &SshServerTarget,
    password: Option<&str>,
    take_over: bool,
) -> Result<SshServerStatus, FsError> {
    let _operation = operation();
    if take_over {
        stop_running_core_locked(deps, target, password)?;
    }
    let opened = open_link_locked(deps, target, password)?;
    let mode = prefs::stored().remote_server.mode;
    let (_, orphaned) = prefs::set_remote_ssh_collect(
        target.host.clone(),
        target.port,
        target.user.clone(),
        target.key_path.clone(),
        target.auth,
        mode,
    )?;
    forget_orphaned(deps, &orphaned);
    Ok(attach_link(host, opened))
}

/// Saves SSH server mode, so the next app start serves the saved server. Changes nothing else and does not restart:
/// the caller restarts the app. A saved server with no pinned host key is refused, because the next start could not
/// connect to it.
///
/// Errors:
///     `invalid_host` when no SSH server is saved; `SSH_HOST_KEY_UNCONFIRMED` when the saved server has no pinned key.
pub fn switch_mode() -> Result<(), FsError> {
    let _operation = operation();
    let saved = prefs::stored().remote_server;
    if saved.host.trim().is_empty() {
        return Err(herr("invalid_host", "Connect to a server before switching to it."));
    }
    let target = SshServerTarget {
        host: saved.host,
        port: saved.port,
        user: saved.user,
        key_path: saved.key_path,
        auth: saved.ssh_auth,
    };
    require_pin(&endpoint_shape(&target)?)?;
    prefs::set_remote_server_mode(ServerMode::Ssh)?;
    Ok(())
}

/// Makes an opened link the one SSH mode serves. Outside SSH mode the link is stopped again, because the mode
/// applies only at the next app start; the status then reports `restart_required`.
pub fn attach_link(host: &CoreHost, opened: OpenedLink) -> SshServerStatus {
    let OpenedLink { link, version, claude } = opened;
    *locked(&REMEMBERED) = Some(Remembered { version, claude });
    if host.mode() == ServerMode::Ssh {
        // Stops the previous link first. Each link owns its own known_hosts folder, so the old one's folder goes
        // with it and no other link can lose its file.
        host.attach_ssh_link(link);
        build_status(host)
    } else {
        drop(link);
        let mut status = build_status(host);
        status.link = "restart_required".to_string();
        status
    }
}

/// The startup connector's entry. Keeps what [`connect`] keeps (the remembered version and Claude state) and
/// leaves attaching to the core host, which is already starting in SSH mode. The returned link owns its folder.
///
/// Errors: the codes of [`open_link`].
pub(crate) fn open_saved_link(deps: &Deps, target: &SshServerTarget) -> Result<SshLink, FsError> {
    let OpenedLink { link, version, claude } = open_link(deps, target, None)?;
    *locked(&REMEMBERED) = Some(Remembered { version, claude });
    Ok(link)
}

/// Stops the forward. The server core keeps running; no ssh call is made. The core host records the user's
/// Disconnect, so the status reads `stopped` rather than a failure.
pub fn disconnect(host: &CoreHost) -> SshServerStatus {
    host.detach_ssh_link();
    forget_session();
    build_status(host)
}

/// The saved server and the link state. Not in SSH mode, the link is `off`.
pub fn status(host: &CoreHost) -> SshServerStatus {
    build_status(host)
}

/// Reads the server's core state with the constant STATUS script over the pinned transport. Read-only: no
/// preference, link or pin changes, so the live check can compare the core before and after a disconnect.
/// Test-only, because nothing in the app needs it; the production path reads state inside connect.
///
/// Errors:
///     `SSH_PASSWORD_REQUIRED`, `SSH_HOST_KEY_UNCONFIRMED`, the transport codes, and the parser's codes for a bad state.
#[cfg(test)]
pub(crate) fn server_core_state(deps: &Deps, password: Option<&str>) -> Result<crate::ssh_server_scripts::CoreState, FsError> {
    let endpoint = saved_endpoint(password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    let output = run_pinned(deps, &endpoint, &pinned, password, crate::ssh_server_scripts::STATUS)?;
    crate::ssh_server_scripts::parse_core_state(&output.stdout)
}

/// Removes every folder the live check created under the server's home folder (`~/llmide-live-<hex>`), with a
/// constant command over the pinned transport. Test-only: the helper cannot delete a project root or open the home
/// folder itself, so the live check needs this to leave the server as it found it.
#[cfg(test)]
pub(crate) fn remove_live_check_folders(deps: &Deps, password: Option<&str>) -> Result<(), FsError> {
    const REMOVE: &str = r#"rm -rf -- "$HOME"/llmide-live-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"#;
    let endpoint = saved_endpoint(password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    run_pinned(deps, &endpoint, &pinned, password, REMOVE).map(|_| ())
}

/// The bundle sha the server's current release was installed from, read with the constant PROBE script over the
/// pinned transport. Test-only, for the live check, which compares it with the bundle this build holds. The
/// production path reads it inside connect.
///
/// Errors:
///     `SSH_PASSWORD_REQUIRED`, `SSH_HOST_KEY_UNCONFIRMED` and the transport codes of the probe.
#[cfg(test)]
pub(crate) fn server_bundle_sha(deps: &Deps, password: Option<&str>) -> Result<Option<String>, FsError> {
    let endpoint = saved_endpoint(password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    let output = run_pinned(deps, &endpoint, &pinned, password, PROBE)?;
    Ok(crate::ssh_server_scripts::parse_current_sha(&output.stdout))
}

/// Stops the forward, then stops the server core named in state.json.
///
/// The target must name the saved server: the dialog shows the host the user typed, and the stop must hit that
/// same server. A core this desktop did not start is refused unless `force` is set, after one STATUS call.
///
/// Errors:
///     `confirm_mismatch` when the target is not the saved server (no ssh call), `SSH_CORE_FOREIGN` for a core
///     another desktop started, then `SSH_PASSWORD_REQUIRED`, `SSH_HOST_KEY_UNCONFIRMED`, the transport codes,
///     `SSH_STOP_UNKNOWN` and `SSH_STOP_FAILED`.
pub fn stop_server(
    deps: &Deps,
    host: &CoreHost,
    target: &SshServerTarget,
    password: Option<&str>,
    force: bool,
) -> Result<SshServerStatus, FsError> {
    let _operation = operation();
    let endpoint = saved_target_endpoint(target, password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    let status = read_state(deps, &endpoint, &pinned, password)?;
    if !force {
        require_ours(&status, &deps.session_file, &endpoint)?;
    }
    host.detach_ssh_link();
    forget_session();
    let output = run_pinned(deps, &endpoint, &pinned, password, STOP)?;
    parse_stop(&output.stdout)?;
    Ok(build_status(host))
}

/// Stops whatever core runs on the target's server account, without the ownership check, for [`connect_with_options`].
/// The target need not be the saved server (a first connect is not saved yet), but its host key must be pinned. The
/// operation lock is held by the caller. A live link is left alone: attaching the new one replaces it.
fn stop_running_core_locked(deps: &Deps, target: &SshServerTarget, password: Option<&str>) -> Result<(), FsError> {
    let endpoint = target_endpoint(target, password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    // STATUS first: it fails clearly (auth, timeout) before STOP, and keeps the same two-call shape as a forced stop.
    read_state(deps, &endpoint, &pinned, password)?;
    let output = run_pinned(deps, &endpoint, &pinned, password, STOP)?;
    parse_stop(&output.stdout)?;
    Ok(())
}

/// Stops the forward and the server core, then removes the releases. Data on the server is kept.
///
/// Errors:
///     `confirm_mismatch` when `confirm_host` is not the saved host name (no ssh call), `SSH_CORE_FOREIGN` for a
///     core another desktop started (unless `force`), then the codes of [`stop_server`].
pub fn uninstall(deps: &Deps, host: &CoreHost, password: Option<&str>, confirm_host: &str, force: bool) -> Result<SshServerStatus, FsError> {
    let _operation = operation();
    let saved_host = prefs::stored().remote_server.host;
    if !confirm_host.trim().eq_ignore_ascii_case(saved_host.trim()) {
        return Err(herr("confirm_mismatch", "Type the server's host name to uninstall."));
    }
    let endpoint = saved_endpoint(password)?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    let status = read_state(deps, &endpoint, &pinned, password)?;
    if !force {
        require_ours(&status, &deps.session_file, &endpoint)?;
    }
    host.detach_ssh_link();
    forget_session();
    let output = run_pinned(deps, &endpoint, &pinned, password, UNINSTALL)?;
    parse_stop(&output.stdout)?;
    parse_uninstall(&output.stdout)?;
    Ok(build_status(host))
}

/// The operation lock. A poisoned lock still guards nothing that can be half-written, so it is taken anyway.
pub(crate) fn operation() -> MutexGuard<'static, ()> {
    locked(&OPERATION)
}

/// Reads the server's core state with STATUS, for the ownership check before a stop or an uninstall.
fn read_state(
    deps: &Deps,
    endpoint: &SshEndpoint,
    pinned: &KnownHostsDir,
    password: Option<&str>,
) -> Result<crate::ssh_server_scripts::CoreState, FsError> {
    let output = run_pinned(deps, endpoint, pinned, password, STATUS)?;
    parse_core_state(&output.stdout)
}

/// The endpoint a stop or uninstall acts on: the saved one, but only when the target names the same host, port
/// and user. Checked before any ssh call, so a mismatched form never reaches the server.
fn saved_target_endpoint(target: &SshServerTarget, password: Option<&str>) -> Result<SshEndpoint, FsError> {
    let shaped = endpoint_shape(target)?;
    let saved = prefs::stored().remote_server;
    let same = shaped.host.eq_ignore_ascii_case(saved.host.trim())
        && shaped.port == saved.port
        && shaped.user == saved.user.trim();
    if !same {
        return Err(herr("confirm_mismatch", "Those are not the saved server's details."));
    }
    saved_endpoint(password)
}

/// Locks a process-wide slot. A poisoned lock still holds valid data, so the guard is taken anyway.
fn locked<T>(slot: &Mutex<T>) -> MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Panic-hook cleanup: drops the known_hosts folder and the remembered state. Only try-locks, because the panicking
/// thread may hold one of these slots and a blocking lock there would hang the exit.
pub(crate) fn forget_for_panic() {
    // The link's known_hosts folder is not here: each link owns it, and `CoreHost::shutdown_from_panic` stops it.
    if let Some(mut slot) = try_locked(&REMEMBERED) {
        *slot = None;
    }
}

/// Non-blocking [`locked`]: `None` when another thread holds the lock. A poisoned lock still holds valid data.
fn try_locked<T>(slot: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match slot.try_lock() {
        Ok(guard) => Some(guard),
        Err(std::sync::TryLockError::Poisoned(e)) => Some(e.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
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
    crate::ssh_session::pick_local_port()
}

#[cfg(test)]
fn forward_port() -> Option<u16> {
    Some(3456)
}

pub(crate) fn target_endpoint(target: &SshServerTarget, password: Option<&str>) -> Result<SshEndpoint, FsError> {
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
        for (key_type, key_b64) in parse_scan(scan) {
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

/// The saved host key for this endpoint, or `None` when no saved key names this host and port. Each saved entry is
/// checked when it is read, so a malformed entry never counts as a pin.
fn pin_for(endpoint: &SshEndpoint) -> Option<Pin> {
    let key = endpoint_key(endpoint);
    prefs::stored()
        .remote_server
        .ssh_known_hosts
        .iter()
        .filter_map(|entry| prefs::parse_known_host(entry))
        .find(|known| known.endpoint == key)
        .map(|known| Pin { key_type: known.key_type, key_b64: known.key_b64 })
}

pub(crate) fn require_pin(endpoint: &SshEndpoint) -> Result<Pin, FsError> {
    pin_for(endpoint).ok_or_else(|| herr("SSH_HOST_KEY_UNCONFIRMED", "Test the connection and confirm the server's host key first."))
}

/// The preference text for a confirmed key: `<host>:<port> <key-type> <key-base64>`, host lower-cased.
fn pin_text(endpoint: &SshEndpoint, offered: &Offered) -> String {
    format!("{}:{} {} {}", endpoint.host.to_ascii_lowercase(), endpoint.port, offered.key_type, offered.key_b64)
}

/// Writes one known_hosts line for the pin into a fresh folder. The folder is owned by the returned value and
/// removed when it drops, including when the write fails.
pub(crate) fn pinned_dir(endpoint: &SshEndpoint, pin: &Pin) -> Result<KnownHostsDir, FsError> {
    // Owned from this line on: a failure below drops `held`, which removes the folder.
    let held = KnownHostsDir::owning(temp_ssh_dir("ssh-server")?);
    // The path goes into a quoted `UserKnownHostsFile` option, which no quoting can carry if it holds a quote or
    // a newline. Such a path is refused rather than handed to ssh half-parsed.
    match held.dir.to_str() {
        Some(path) if !path.contains(['"', '\n']) => {}
        _ => return Err(herr("known_hosts_failed", "the temporary folder path cannot be used for host key checks")),
    }
    let line = known_hosts_line(&endpoint.host.to_ascii_lowercase(), endpoint.port, &pin.key_type, &pin.key_b64);
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
        glibc: None,
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
    result.glibc = probe.glibc;
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
}

/// The status the UI reads: the saved server, the core host's link and the remembered version. The link label
/// comes from the core host, which reports `stopped` after a user Stop or Disconnect. Outside SSH mode it is `off`.
pub(crate) fn build_status(host: &CoreHost) -> SshServerStatus {
    let saved = prefs::stored().remote_server;
    let core = host.status();
    let in_ssh = host.mode() == ServerMode::Ssh;
    let link = match (in_ssh, core.link) {
        (true, Some(label)) => label,
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
        bundle_available: crate::ssh_cmds::bundle_in(crate::core_host::resource_dir().as_deref(), crate::ssh_cmds::VERSION).is_some(),
    }
}

/// Clears the process-wide slots so one test's observed keys and link folder cannot reach the next.
#[cfg(test)]
fn reset_for_tests() {
    locked(observed()).clear();
    forget_session();
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::core_host::tests::mode_guard;
    use crate::prefs::{prefs_guard, set_remote_server_for_test, upsert_ssh_known_host, RemoteServerPrefs};
    use crate::ssh_link::{supervise, KnownHostsDir, SuperviseInput};
    use crate::ssh_key_install::public_key_path;
    use crate::ssh_server_scripts::{ClaudeState, STOP, UNINSTALL};
    use crate::ssh_session::write_session;
    use crate::ssh_session::tests::{
        ok, probe_out, probe_with_glibc, ssh_error, started_out, state_out, FakeExec, NEW, PASSWORD, PERMISSION_DENIED,
        STOPPED_STATUS, TIMED_OUT,
    };
    use crate::ssh_session::Connected;
    use crate::ssh_transport::ForwardChild;
    use base64::Engine as _;
    use crate::ssh_askpass::AskpassGrant;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};

    pub(crate) const HOST: &str = "example.com";
    pub(crate) const KEY_PATH: &str = "/home/alice/.ssh/id_ed25519";
    pub(crate) const PAYLOAD: &str = r#"{"jwtSecret":"j","vaultKey":"v","hostApprovalKey":"a"}"#;
    pub(crate) const INSTALL_OK: &str = "__LLMIDE_INSTALL__=ok\n";
    const STOP_OK: &str = "__LLMIDE_STOP__=stopped\n";
    const UNINSTALL_OK: &str = "__LLMIDE_STOP__=not_running\n__LLMIDE_UNINSTALL__=ok\n";
    const BUNDLE_BYTES: &[u8] = b"fake-tarball-bytes";

    pub(crate) fn key_b64(seed: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(seed.as_bytes())
    }

    /// One scan line. The host column says something else on purpose: the service must ignore it.
    pub(crate) fn scan_of(seed: &str) -> String {
        format!("attacker.example ssh-ed25519 {}\n", key_b64(seed))
    }

    pub(crate) fn pin_text(port: u16, seed: &str) -> String {
        format!("{HOST}:{port} ssh-ed25519 {}", key_b64(seed))
    }

    pub(crate) fn fingerprint_of(seed: &str) -> String {
        fingerprint_for_key_b64(&key_b64(seed)).unwrap()
    }

    pub(crate) fn target(port: u16, auth: SshAuthKind) -> SshServerTarget {
        SshServerTarget { host: HOST.into(), port, user: "alice".into(), key_path: KEY_PATH.into(), auth }
    }

    pub(crate) fn fake(outputs: Vec<io::Result<RawOutput>>) -> Arc<FakeExec> {
        Arc::new(FakeExec::new(outputs))
    }

    /// PROBE, STATUS, INSTALL and START for a fresh server, in the order `ssh_session::connect` runs them.
    fn connect_outputs() -> Vec<io::Result<RawOutput>> {
        vec![probe_out(""), ok(STOPPED_STATUS), ok(INSTALL_OK), started_out(3460, "2.0.0")]
    }

    pub(crate) fn has_option(args: &[String], value: &str) -> bool {
        args.windows(2).any(|w| w[0] == "-o" && w[1] == value)
    }

    pub(crate) fn code<T: std::fmt::Debug>(result: Result<T, FsError>) -> &'static str {
        result.unwrap_err().code
    }

    pub(crate) fn saved_key_block() -> RemoteServerPrefs {
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

    pub(crate) const ADD_KEY_ADDED: &str = "__LLMIDE_ADDKEY__=added\n";
    pub(crate) const KEY_VERIFY_MESSAGE: &str = "The server did not accept the new key. Your password login is unchanged.";

    /// The public line [`fake_keygen`] produces.
    pub(crate) fn generated_line() -> String {
        format!("ssh-ed25519 {} llmide-desktop", key_b64("generated"))
    }

    /// Writes a key pair the way ssh-keygen does and returns the public line. Counted by the Fixture.
    pub(crate) fn fake_keygen(path: &Path) -> Result<String, FsError> {
        std::fs::write(path, "PRIVATE KEY MATERIAL").unwrap();
        std::fs::write(public_key_path(path), format!("{}\n", generated_line())).unwrap();
        Ok(generated_line())
    }

    pub(crate) fn saved_password_block() -> RemoteServerPrefs {
        RemoteServerPrefs {
            mode: ServerMode::Ssh,
            host: HOST.into(),
            port: 22,
            user: "alice".into(),
            ssh_auth: SshAuthKind::Password,
            ..RemoteServerPrefs::default()
        }
    }

    /// Records, for each ssh run, whether it was handed a one-time password grant, then forwards to the fake.
    pub(crate) struct GrantSpy {
        inner: Arc<FakeExec>,
        grants: Mutex<Vec<bool>>,
    }

    impl GrantSpy {
        pub(crate) fn new(inner: Arc<FakeExec>) -> Self {
            Self { inner, grants: Mutex::new(Vec::new()) }
        }

        pub(crate) fn grants(&self) -> Vec<bool> {
            self.grants.lock().unwrap().clone()
        }
    }

    impl SshExec for GrantSpy {
        fn run(
            &self,
            args: &[String],
            stdin: Option<&[u8]>,
            askpass: Option<&AskpassGrant>,
            deadline: Duration,
        ) -> io::Result<RawOutput> {
            self.grants.lock().unwrap().push(askpass.is_some());
            self.inner.run(args, stdin, askpass, deadline)
        }

        fn spawn_forward(&self, args: &[String], askpass: Option<&AskpassGrant>) -> io::Result<Box<dyn ForwardChild>> {
            self.inner.spawn_forward(args, askpass)
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
    pub(crate) struct Fixture {
        /// `user@host:port` of every login whose stored password the service asked to forget.
        pub(crate) forgotten: Arc<Mutex<Vec<String>>>,
        pub(crate) dir: PathBuf,
        pub(crate) host: CoreHost,
        pub(crate) scans: Arc<AtomicUsize>,
        pub(crate) asks: Arc<AtomicUsize>,
        pub(crate) keygens: Arc<AtomicUsize>,
        pub(crate) _prefs: MutexGuard<'static, ()>,
        pub(crate) _mode: MutexGuard<'static, ()>,
    }

    impl Fixture {
        pub(crate) fn new(label: &str) -> Self {
            let prefs = prefs_guard();
            let mode = mode_guard();
            let dir = temp_ssh_dir(label).unwrap();
            let host = CoreHost::new();
            host.set_mode(ServerMode::Local);
            set_remote_server_for_test(RemoteServerPrefs::default());
            reset_for_tests();
            Self {
                forgotten: Arc::default(),
                dir,
                host,
                scans: Arc::default(),
                asks: Arc::default(),
                keygens: Arc::default(),
                _prefs: prefs,
                _mode: mode,
            }
        }

        pub(crate) fn deps(&self, exec: &Arc<FakeExec>, scan: &str, answer: bool, bundle: bool) -> Deps {
            let bundle_path = self.dir.join("llmide-core-2.0.0-linux-x64.tar.gz");
            if bundle {
                std::fs::write(&bundle_path, BUNDLE_BYTES).unwrap();
            }
            let bundle_path = bundle.then_some(bundle_path);
            let scan = scan.to_string();
            let (scans, asks, keygens) = (self.scans.clone(), self.asks.clone(), self.keygens.clone());
            let echo = exec.clone();
            let forgotten = self.forgotten.clone();
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
                keygen: Arc::new(move |path: &Path| {
                    keygens.fetch_add(1, Ordering::SeqCst);
                    fake_keygen(path)
                }),
                health: Arc::new(move |_: u16| Some(echo.started_nonce())),
                bundle: Arc::new(move || bundle_path.clone()),
                version: "2.0.0".into(),
                secrets_payload: Arc::new(|| Ok(PAYLOAD.to_string())),
                forget_password: Arc::new(move |host: &str, port: u16, user: &str| locked(&forgotten).push(format!("{user}@{host}:{port}"))),
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
                known_hosts: KnownHostsDir::owning(self.dir.join("live-link")),
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
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
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
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
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
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
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
    fn trusted_probe_reports_the_glibc_version() {
        let fx = Fixture::new("svc-glibc");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![probe_with_glibc("2.0.0", "2.31")]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let result = test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        assert_eq!(result.glibc.as_deref(), Some("2.31"));
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["glibc"], "2.31", "the UI reads the glibc field by this name");
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
        assert!(prefs::stored().remote_server.ssh_known_hosts.is_empty(), "a declined dialog stores no pin");
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
        assert_eq!(prefs::stored().remote_server.ssh_known_hosts, vec![pin_text(22, "key-a")]);
        assert!(exec.calls().is_empty());
    }

    fn password_login(user: &str) -> SshServerTarget {
        SshServerTarget { user: user.into(), ..target(22, SshAuthKind::Password) }
    }

    #[test]
    fn replacing_a_different_host_key_forgets_the_saved_passwords_of_that_server() {
        let fx = Fixture::new("svc-key-change");
        upsert_ssh_known_host(pin_text(22, "key-old")).unwrap();
        for user in ["alice", "bob"] {
            prefs::remember_ssh_server(HOST, 22, user, "", SshAuthKind::Password).unwrap();
            prefs::set_ssh_password_saved(HOST, 22, user, true).unwrap();
        }
        prefs::remember_ssh_server("elsewhere.example", 22, "alice", "", SshAuthKind::Password).unwrap();
        prefs::set_ssh_password_saved("elsewhere.example", 22, "alice", true).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-new"), true, true);
        let seen = test(&deps, &password_login("alice"), Some("pw")).unwrap();
        assert!(seen.changed && !seen.trusted, "the new key is not trusted yet");
        confirm(&deps, &password_login("alice"), "ssh-ed25519", &fingerprint_of("key-new")).unwrap();
        assert!(!prefs::ssh_password_saved(HOST, 22, "alice") && !prefs::ssh_password_saved(HOST, 22, "bob"), "no flag survives a new key");
        assert!(prefs::ssh_password_saved("elsewhere.example", 22, "alice"), "another server keeps its password");
        let mut forgotten = locked(&fx.forgotten).clone();
        forgotten.sort();
        assert_eq!(forgotten, vec![format!("alice@{HOST}:22"), format!("bob@{HOST}:22")]);
    }

    #[test]
    fn a_same_key_or_a_first_pin_without_a_saved_password_changes_nothing() {
        let fx = Fixture::new("svc-key-same");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        prefs::remember_ssh_server(HOST, 22, "alice", "", SshAuthKind::Password).unwrap();
        prefs::set_ssh_password_saved(HOST, 22, "alice", true).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        // The trusted probe may fail on the fake; it still records the key it saw, which is all confirm needs.
        let _ = test(&deps, &password_login("alice"), Some("pw"));
        confirm(&deps, &password_login("alice"), "ssh-ed25519", &fingerprint_of("key-a")).unwrap();
        assert!(prefs::ssh_password_saved(HOST, 22, "alice"), "re-confirming the same key keeps the password");
        assert!(locked(&fx.forgotten).is_empty());

        let other = Fixture::new("svc-first-pin");
        prefs::remember_ssh_server(HOST, 22, "bob", "", SshAuthKind::Password).unwrap();
        let deps = other.deps(&exec, &scan_of("key-a"), true, true);
        test(&deps, &password_login("bob"), Some("pw")).unwrap();
        confirm(&deps, &password_login("bob"), "ssh-ed25519", &fingerprint_of("key-a")).unwrap();
        assert!(locked(&other.forgotten).is_empty(), "nothing was saved, so nothing is forgotten");
    }

    #[test]
    fn a_first_pin_for_a_login_with_a_saved_password_forgets_it() {
        // The pin was evicted (or never existed) while the login kept its password: it must not reach a key the user
        // trusts only now.
        let fx = Fixture::new("svc-first-pin-saved");
        prefs::remember_ssh_server(HOST, 22, "alice", "", SshAuthKind::Password).unwrap();
        prefs::set_ssh_password_saved(HOST, 22, "alice", true).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        test(&deps, &password_login("alice"), Some("pw")).unwrap();
        confirm(&deps, &password_login("alice"), "ssh-ed25519", &fingerprint_of("key-a")).unwrap();
        assert!(!prefs::ssh_password_saved(HOST, 22, "alice"));
        assert_eq!(*locked(&fx.forgotten), vec![format!("alice@{HOST}:22")]);
    }

    #[test]
    fn evicting_the_oldest_pin_forgets_the_passwords_saved_for_its_host() {
        let fx = Fixture::new("svc-pin-evict");
        upsert_ssh_known_host(pin_text(22, "key-old")).unwrap();
        prefs::remember_ssh_server(HOST, 22, "alice", "", SshAuthKind::Password).unwrap();
        prefs::set_ssh_password_saved(HOST, 22, "alice", true).unwrap();
        let mut cleared = Vec::new();
        for i in 0..prefs::SSH_KNOWN_HOSTS_MAX {
            let pin = format!("h{i}.example:22 ssh-ed25519 {}", key_b64(&format!("k{i}")));
            cleared.extend(prefs::upsert_ssh_known_host_collect(pin).unwrap().1);
        }
        assert_eq!(cleared.len(), 1);
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        forget_orphaned(&deps, &cleared);
        assert!(!prefs::ssh_password_saved(HOST, 22, "alice"), "the login lost its flag with its pin");
        assert_eq!(*locked(&fx.forgotten), vec![format!("alice@{HOST}:22")]);
    }

    #[test]
    fn a_test_with_a_key_never_forgets_a_saved_password() {
        let fx = Fixture::new("svc-test-keeps-keychain");
        prefs::remember_ssh_server(HOST, 22, "alice", "", SshAuthKind::Password).unwrap();
        prefs::set_ssh_password_saved(HOST, 22, "alice", true).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        remember_login(&deps, &target(22, SshAuthKind::Key));
        assert!(prefs::ssh_password_saved(HOST, 22, "alice"), "only Connect switches the login to a key");
        assert!(locked(&fx.forgotten).is_empty());
    }

    #[test]
    fn a_lazy_password_is_not_read_for_a_server_that_is_not_trusted() {
        let fx = Fixture::new("svc-lazy");
        upsert_ssh_known_host(pin_text(22, "key-old")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-new"), true, true);
        let reads = Arc::new(AtomicUsize::new(0));
        let counter = reads.clone();
        let resolve = move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(Some("saved".to_string()))
        };
        let result = test_lazy(&deps, &password_login("alice"), &resolve).unwrap();
        assert!(result.changed && !result.trusted);
        assert_eq!(reads.load(Ordering::SeqCst), 0, "a changed key never makes the app read the keychain");
        assert!(exec.calls().is_empty(), "nothing was logged into");
        assert_eq!(code(require_pinned_key_offered(&deps, &password_login("alice"))), "SSH_HOST_KEY_CHANGED");
    }

    #[test]
    fn a_login_switched_to_a_key_or_pushed_out_of_the_recent_list_forgets_its_password() {
        let fx = Fixture::new("svc-orphans");
        prefs::remember_ssh_server(HOST, 22, "alice", "", SshAuthKind::Password).unwrap();
        prefs::set_ssh_password_saved(HOST, 22, "alice", true).unwrap();
        let (_, orphaned) = prefs::set_remote_ssh_collect(HOST.into(), 22, "alice".into(), KEY_PATH.into(), SshAuthKind::Key, ServerMode::Local).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        forget_orphaned(&deps, &orphaned);
        assert_eq!(*locked(&fx.forgotten), vec![format!("alice@{HOST}:22")]);
        assert!(!prefs::ssh_password_saved(HOST, 22, "alice"), "the key login carries no flag");

        prefs::remember_ssh_server("first.example", 22, "carol", "", SshAuthKind::Password).unwrap();
        prefs::set_ssh_password_saved("first.example", 22, "carol", true).unwrap();
        let mut pushed = Vec::new();
        for i in 0..prefs::SSH_RECENT_SERVERS_MAX {
            pushed.extend(prefs::remember_ssh_server(&format!("h{i}.example"), 22, "dave", "", SshAuthKind::Password).unwrap());
        }
        forget_orphaned(&deps, &pushed);
        assert!(locked(&fx.forgotten).contains(&"carol@first.example:22".to_string()), "the evicted login's password goes with it");
    }

    #[test]
    fn pin_lookup_uses_the_list() {
        let _fx = Fixture::new("svc-two-pins");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        upsert_ssh_known_host(format!("other.example:2222 ssh-ed25519 {}", key_b64("key-b"))).unwrap();
        let first = prepare_endpoint(HOST, 22, "alice", SshAuth::Password).unwrap();
        let second = prepare_endpoint("Other.Example", 2222, "alice", SshAuth::Password).unwrap();
        let elsewhere = prepare_endpoint(HOST, 2222, "alice", SshAuth::Password).unwrap();
        assert_eq!(pin_for(&first).map(|p| p.key_b64), Some(key_b64("key-a")));
        assert_eq!(pin_for(&second).map(|p| p.key_b64), Some(key_b64("key-b")));
        assert_eq!(pin_for(&elsewhere), None, "a pin for another port is not this endpoint's pin");
    }

    #[test]
    fn connect_records_the_recent_server() {
        let fx = Fixture::new("svc-recent");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let good = fake(connect_outputs());
        let deps = fx.deps(&good, "", true, true);
        connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        let recent = prefs::stored().remote_server.ssh_recent_servers;
        assert_eq!(recent.len(), 1);
        assert_eq!((recent[0].host.as_str(), recent[0].port, recent[0].user.as_str()), (HOST, 22, "alice"));
        assert_eq!((recent[0].key_path.as_str(), recent[0].auth), (KEY_PATH, SshAuthKind::Key));
        assert!(recent[0].last_used > 0);
    }

    #[test]
    fn a_pin_for_another_port_is_not_trusted() {
        let fx = Fixture::new("svc-port");
        upsert_ssh_known_host(pin_text(2222, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let result = test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        assert!(!result.trusted);
        assert!(!result.changed, "a pin for another port counts as no pin");
        assert!(exec.calls().is_empty());
    }

    /// Connect saves the server and keeps the app's mode. The user switches to SSH mode with `switch_mode`, so
    /// Cancel on the switch leaves the next start local.
    #[test]
    fn connect_keeps_the_mode_and_switch_mode_saves_it() {
        let fx = Fixture::new("svc-persist");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
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
        assert_eq!(saved.mode, ServerMode::Local, "connecting does not switch the app to SSH mode");
        assert_eq!(saved.host, HOST);
        assert_eq!(saved.port, 22);
        assert_eq!(saved.user, "alice");
        assert_eq!(saved.key_path, KEY_PATH);
        assert_eq!(status.link, "restart_required", "the host is not in SSH mode, so the link waits for a restart");

        switch_mode().unwrap();
        assert_eq!(prefs::stored().remote_server.mode, ServerMode::Ssh, "the switch saves SSH mode");
    }

    #[test]
    fn switch_mode_needs_a_saved_server_and_a_pinned_host_key() {
        let fx = Fixture::new("svc-switch-refuse");
        assert_eq!(code(switch_mode()), "invalid_host", "no server is saved");
        prefs::set_remote_ssh(HOST.into(), 22, "alice".into(), KEY_PATH.into(), SshAuthKind::Key, ServerMode::Local).unwrap();
        assert_eq!(code(switch_mode()), "SSH_HOST_KEY_UNCONFIRMED", "the saved server has no pinned host key");
        assert_eq!(prefs::stored().remote_server.mode, ServerMode::Local, "a refused switch saves nothing");
        drop(fx);
    }

    #[test]
    fn connect_in_ssh_mode_keeps_the_known_hosts_until_disconnect() {
        let fx = Fixture::new("svc-folder");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(connect_outputs());
        let deps = fx.deps(&exec, "", true, true);
        fx.host.set_mode(ServerMode::Ssh);
        let status = connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        assert_eq!(status.link, "connected");
        let known = fx.host.attached_known_hosts().expect("the attached link owns a known_hosts file");
        assert!(known.is_file());
        disconnect(&fx.host);
        assert!(!known.exists(), "disconnect removes the folder");
        assert!(fx.host.attached_known_hosts().is_none());
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
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, false);
        assert_eq!(code(connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None)), "SSH_BUNDLE_MISSING");
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn password_auth_without_a_password_is_refused() {
        let fx = Fixture::new("svc-no-password");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
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
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = uninstall(&deps, &fx.host, None, "other", false).unwrap_err();
        assert_eq!(refused.code, "confirm_mismatch");
        assert_eq!(refused.message, "Type the server's host name to uninstall.");
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn uninstall_with_the_saved_host_runs_the_uninstall_script() {
        let fx = Fixture::new("svc-uninstall-ok");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        fx.host.set_mode(ServerMode::Ssh);
        let exec = fake(vec![ok(STOPPED_STATUS), ok(UNINSTALL_OK)]);
        let deps = fx.deps(&exec, "", true, true);
        let status = uninstall(&deps, &fx.host, None, " EXAMPLE.com ", false).unwrap();
        assert_eq!(status.link, "stopped");
        assert_eq!(exec.names(), vec!["status", "uninstall"]);
        assert_eq!(exec.calls()[1].args.last().map(String::as_str), Some(UNINSTALL));
    }

    #[test]
    fn uninstall_needs_the_removal_marker() {
        let fx = Fixture::new("svc-uninstall-partial");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        fx.host.set_mode(ServerMode::Ssh);
        // The stop ran, but the script never printed its own ok line.
        let exec = fake(vec![ok(STOPPED_STATUS), ok("__LLMIDE_STOP__=not_running\n")]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = uninstall(&deps, &fx.host, None, "example.com", false).unwrap_err();
        assert_eq!(refused.code, "SSH_UNINSTALL_FAILED");
        assert_eq!(refused.message, "The server files could not be removed.");
    }

    #[test]
    fn every_call_is_strict_after_connect_and_stop() {
        let fx = Fixture::new("svc-strict");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let connect_exec = fake(connect_outputs());
        let deps = fx.deps(&connect_exec, "", true, true);
        connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        let stop_exec = fake(vec![ok(STOPPED_STATUS), ok(STOP_OK)]);
        let deps = fx.deps(&stop_exec, "", true, true);
        stop_server(&deps, &fx.host, &target(22, SshAuthKind::Key), None, false).unwrap();
        assert!(!connect_exec.calls().is_empty() && !stop_exec.calls().is_empty());
        for call in connect_exec.calls().iter().chain(stop_exec.calls().iter()) {
            assert!(has_option(&call.args, "StrictHostKeyChecking=yes"), "{} is not strict", call.name);
        }
    }

    #[test]
    fn stop_server_detaches_then_stops() {
        let fx = Fixture::new("svc-stop");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let kills = Arc::new(AtomicUsize::new(0));
        let exec = fake(vec![ok(STOPPED_STATUS), ok(STOP_OK)]);
        fx.attach_live_link(&exec, &kills);
        let deps = fx.deps(&exec, "", true, true);
        let status = stop_server(&deps, &fx.host, &target(22, SshAuthKind::Key), None, false).unwrap();
        assert_eq!(kills.load(Ordering::SeqCst), 1, "the forward is killed");
        assert_eq!(exec.names(), vec!["status", "stop"]);
        assert_eq!(exec.calls()[1].args.last().map(String::as_str), Some(STOP));
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

    /// Writes the session record for an endpoint with a nonce, as a connect by this desktop would have.
    fn record_ours(fx: &Fixture, nonce: &str) {
        let endpoint = crate::ssh_session::tests::key_endpoint();
        write_session(&fx.dir.join("state").join("ssh-session.json"), &endpoint, nonce).unwrap();
    }

    fn foreign_status() -> io::Result<RawOutput> {
        state_out(3460, "foreignnonce0123456", "2.0.0")
    }

    #[test]
    fn stop_refuses_a_core_another_desktop_started() {
        let fx = Fixture::new("svc-stop-foreign");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let kills = Arc::new(AtomicUsize::new(0));
        let exec = fake(vec![foreign_status()]);
        fx.attach_live_link(&exec, &kills);
        let deps = fx.deps(&exec, "", true, true);
        let refused = stop_server(&deps, &fx.host, &target(22, SshAuthKind::Key), None, false).unwrap_err();
        assert_eq!(refused.code, "SSH_CORE_FOREIGN");
        assert_eq!(refused.message, "Another computer started the server on this account.");
        assert_eq!(exec.names(), vec!["status"], "only STATUS ran; the core was not stopped");
        assert_eq!(kills.load(Ordering::SeqCst), 0, "the local link is left alone when the stop is refused");
    }

    #[test]
    fn stop_with_force_stops_a_core_another_desktop_started() {
        let fx = Fixture::new("svc-stop-force");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![foreign_status(), ok(STOP_OK)]);
        let deps = fx.deps(&exec, "", true, true);
        let status = stop_server(&deps, &fx.host, &target(22, SshAuthKind::Key), None, true).unwrap();
        assert_eq!(status.link, "off", "the test host is not in SSH mode");
        assert_eq!(exec.names(), vec!["status", "stop"]);
    }

    #[test]
    fn connect_refuses_a_core_the_session_record_does_not_own() {
        let fx = Fixture::new("svc-connect-foreign");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![probe_out(""), foreign_status()]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap_err();
        assert_eq!(refused.code, "SSH_CORE_FOREIGN");
        assert!(!exec.names().contains(&"stop"), "no stop without the explicit take over");
    }

    #[test]
    fn take_over_stops_the_foreign_core_then_continues_the_same_connect() {
        let fx = Fixture::new("svc-connect-take-over");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let mut outputs = vec![foreign_status(), ok(STOP_OK)];
        outputs.extend(connect_outputs());
        let exec = fake(outputs);
        let deps = fx.deps(&exec, "", true, true);
        let status = connect_with_options(&deps, &fx.host, &target(22, SshAuthKind::Key), None, true).unwrap();
        assert_eq!(status.link, "restart_required", "the test host is not in SSH mode");
        let names = exec.names();
        assert_eq!(&names[..2], ["status", "stop"], "the stop comes first");
        assert_eq!(names[2..], ["probe", "status", "install", "start", "forward"], "then the ordinary connect");
        for call in exec.calls() {
            assert!(has_option(&call.args, "StrictHostKeyChecking=yes"), "{} is not strict", call.name);
        }
    }

    #[test]
    fn take_over_without_a_pinned_host_key_runs_nothing() {
        let fx = Fixture::new("svc-connect-take-over-unpinned");
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = connect_with_options(&deps, &fx.host, &target(22, SshAuthKind::Key), None, true).unwrap_err();
        assert_eq!(refused.code, "SSH_HOST_KEY_UNCONFIRMED");
        assert!(exec.calls().is_empty(), "the host-key check is not skipped by a take over");
    }

    #[test]
    fn take_over_does_not_need_the_server_to_be_the_saved_one() {
        let fx = Fixture::new("svc-connect-take-over-unsaved");
        set_remote_server_for_test(RemoteServerPrefs::default());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let mut outputs = vec![foreign_status(), ok(STOP_OK)];
        outputs.extend(connect_outputs());
        let exec = fake(outputs);
        let deps = fx.deps(&exec, "", true, true);
        connect_with_options(&deps, &fx.host, &target(22, SshAuthKind::Key), None, true).unwrap();
        assert_eq!(&exec.names()[..2], ["status", "stop"]);
    }

    #[test]
    fn a_trusted_test_and_a_confirm_list_the_login_before_any_connect() {
        let fx = Fixture::new("svc-remember-early");
        set_remote_server_for_test(RemoteServerPrefs::default());
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let seen = test(&deps, &target(22, SshAuthKind::Key), None).unwrap();
        assert!(!seen.trusted);
        assert!(prefs::stored().remote_server.ssh_recent_servers.is_empty(), "an untrusted key lists nothing yet");
        confirm(&deps, &target(22, SshAuthKind::Key), &seen.host_key_type, &seen.fingerprint).unwrap();
        let listed = prefs::stored().remote_server.ssh_recent_servers;
        assert_eq!(listed.len(), 1, "listed once the host key is trusted, with no connect");
        assert_eq!((listed[0].host.as_str(), listed[0].user.as_str()), (HOST, "alice"));
        assert!(prefs::stored().remote_server.host.is_empty(), "the saved server is untouched");
    }

    #[test]
    fn stop_proceeds_for_our_own_core() {
        let fx = Fixture::new("svc-stop-ours");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        record_ours(&fx, NEW);
        let exec = fake(vec![state_out(3460, NEW, "2.0.0"), ok(STOP_OK)]);
        let deps = fx.deps(&exec, "", true, true);
        stop_server(&deps, &fx.host, &target(22, SshAuthKind::Key), None, false).unwrap();
        assert_eq!(exec.names(), vec!["status", "stop"]);
    }

    #[test]
    fn stop_on_a_stopped_core_needs_no_force() {
        let fx = Fixture::new("svc-stop-idle");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![ok(STOPPED_STATUS), ok(STOP_OK)]);
        let deps = fx.deps(&exec, "", true, true);
        stop_server(&deps, &fx.host, &target(22, SshAuthKind::Key), None, false).unwrap();
        assert_eq!(exec.names(), vec!["status", "stop"]);
    }

    #[test]
    fn uninstall_refuses_a_foreign_core_unless_forced() {
        let fx = Fixture::new("svc-uninstall-foreign");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![foreign_status()]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = uninstall(&deps, &fx.host, None, "example.com", false).unwrap_err();
        assert_eq!(refused.code, "SSH_CORE_FOREIGN");
        assert_eq!(exec.names(), vec!["status"]);

        let exec = fake(vec![foreign_status(), ok(UNINSTALL_OK)]);
        let deps = fx.deps(&exec, "", true, true);
        uninstall(&deps, &fx.host, None, "example.com", true).unwrap();
        assert_eq!(exec.names(), vec!["status", "uninstall"]);
    }

    #[test]
    fn stop_with_another_host_is_refused_before_any_ssh_call() {
        let fx = Fixture::new("svc-stop-mismatch");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        let other_host = SshServerTarget { host: "other.example".into(), ..target(22, SshAuthKind::Key) };
        let refused = stop_server(&deps, &fx.host, &other_host, None, false).unwrap_err();
        assert_eq!(refused.code, "confirm_mismatch");
        assert_eq!(refused.message, "Those are not the saved server's details.");
        let other_port = target(2222, SshAuthKind::Key);
        assert_eq!(code(stop_server(&deps, &fx.host, &other_port, None, true)), "confirm_mismatch");
        assert!(exec.calls().is_empty(), "no ssh call for a target that is not the saved server");
    }

    #[test]
    fn key_login_survives_disconnect_as_stopped_and_reconnects() {
        let fx = Fixture::new("svc-disconnect-status");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        fx.host.set_mode(ServerMode::Ssh);
        let exec = fake(connect_outputs());
        let deps = fx.deps(&exec, "", true, true);
        assert_eq!(connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap().link, "connected");

        let after = disconnect(&fx.host);
        assert_eq!(after.link, "stopped", "a user Disconnect is not a failure");
        assert_eq!(status(&fx.host).link, "stopped");
        assert_eq!(fx.host.status().link, Some("stopped"));
        assert_eq!(fx.host.status().error, None);

        let exec = fake(connect_outputs());
        let deps = fx.deps(&exec, "", true, true);
        assert_eq!(connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap().link, "connected");
    }

    #[test]
    fn a_timed_out_probe_is_ssh_timeout_from_test() {
        let fx = Fixture::new("svc-timeout-test");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![Err(io::Error::new(io::ErrorKind::TimedOut, "deadline"))]);
        let deps = fx.deps(&exec, &scan_of("key-a"), true, true);
        let err = test(&deps, &target(22, SshAuthKind::Key), None).unwrap_err();
        assert_eq!(err.code, "SSH_TIMEOUT");
    }

    #[test]
    fn a_timed_out_call_is_ssh_timeout_from_connect_and_stop() {
        {
            // Scoped: a Fixture holds process-wide guards, so the second one can only start after this one drops.
            let fx = Fixture::new("svc-timeout-connect");
            upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
            let exec = fake(vec![Err(io::Error::new(io::ErrorKind::TimedOut, "deadline"))]);
            let deps = fx.deps(&exec, "", true, true);
            assert_eq!(code(connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None)), "SSH_TIMEOUT");
        }

        let fx = Fixture::new("svc-timeout-stop");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![Err(io::Error::new(io::ErrorKind::TimedOut, "deadline"))]);
        let deps = fx.deps(&exec, "", true, true);
        let err = stop_server(&deps, &fx.host, &target(22, SshAuthKind::Key), None, false).unwrap_err();
        assert_eq!(err.code, "SSH_TIMEOUT");
        assert_eq!(err.message, "The server did not answer in time.");
    }

    #[test]
    fn two_open_links_never_interleave_their_ssh_calls() {
        // Two connects on two threads. Serialized, each call's end comes before the next call starts.
        let fx = Fixture::new("svc-serial");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let outputs = connect_outputs().into_iter().chain(connect_outputs()).collect();
        let exec = Arc::new(FakeExec::with_delay(outputs, Duration::from_millis(30)));
        let deps = fx.deps(&exec, "", true, true);
        let wanted = target(22, SshAuthKind::Key);
        std::thread::scope(|scope| {
            let first = scope.spawn(|| open_link(&deps, &wanted, None).is_ok());
            let second = scope.spawn(|| open_link(&deps, &wanted, None).is_ok());
            assert!(first.join().unwrap() && second.join().unwrap(), "both connects succeed one after the other");
        });
        let events = exec.events();
        assert_eq!(events.len(), 2 * 2 * 4, "four ssh calls per connect, each with a start and an end");
        for pair in events.chunks(2) {
            let (start, end) = (&pair[0], &pair[1]);
            assert!(start.ends_with(":start") && end == &start.replace(":start", ":end"), "calls overlapped: {events:?}");
        }
    }

    #[test]
    fn a_failed_open_leaves_no_known_hosts_folder() {
        let fx = Fixture::new("svc-open-fail");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![ssh_error(TIMED_OUT)]);
        let deps = fx.deps(&exec, "", true, true);
        let err = open_link(&deps, &target(22, SshAuthKind::Key), None).err().expect("the open fails");
        assert_eq!(err.code, "SSH_UNREACHABLE");
        let file = known_hosts_arg(&exec.calls()[0].args);
        assert!(!file.exists() && !file.parent().unwrap().exists(), "the pinned folder outlived the failed open");
    }

    #[test]
    fn a_replaced_link_takes_its_folder_with_it() {
        let fx = Fixture::new("svc-replace");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        fx.host.set_mode(ServerMode::Ssh);
        let first = fake(connect_outputs());
        let deps = fx.deps(&first, "", true, true);
        connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        let old_file = known_hosts_arg(&first.calls()[0].args);
        assert!(old_file.is_file());

        let second = fake(connect_outputs());
        let deps = fx.deps(&second, "", true, true);
        connect(&deps, &fx.host, &target(22, SshAuthKind::Key), None).unwrap();
        assert!(!old_file.exists(), "the replaced link's folder is removed");
        assert!(fx.host.attached_known_hosts().is_some_and(|file| file.is_file()), "the new link keeps its own folder");
    }

    /// The known_hosts file named by the `UserKnownHostsFile` option of one argv.
    fn known_hosts_arg(args: &[String]) -> PathBuf {
        let value = args
            .iter()
            .find_map(|a| a.strip_prefix("UserKnownHostsFile=\""))
            .and_then(|rest| rest.strip_suffix('"'))
            .expect("the argv names a quoted known_hosts file");
        PathBuf::from(value)
    }
}
