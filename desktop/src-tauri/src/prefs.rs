//! Host-persisted preferences (`prefs.json` in the app data dir).
//!
//! What lives here is what the HOST must decide before (or without) a webview: the switches the
//! spawned core reads from its environment at start, the live-then-archive mode, and the Terminal
//! feature toggle. The webview reads and writes them through `get_prefs` / `set_prefs` with a strict
//! typed schema (unknown keys and bad values are refused, nothing is stored as free text).
//!
//! Rules:
//! - `prefs.json` is bounded (1280 KiB, see `MAX_BYTES`), written atomically with 0600 in the private data dir, and an
//!   unreadable, oversized or hand-edited file falls back to the defaults (never a crash, never a
//!   partially trusted value).
//! - A change applies at the NEXT app start. `launch()` is the snapshot taken once at startup and is
//!   what the core environment, the archive policy and the Terminal gate use; `stored()` is what the
//!   file says now. `restartNeeded` is their difference, so Settings can say "applies at next start".
//! - Token-affecting switches (router, cap, compress, learn) default OFF and reach the core only as the
//!   exact value `on` (see `extension/core/router-flags.mjs`); the core's environment is otherwise
//!   scrubbed, so nothing in the host's own environment can turn them on.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::confirm::{herr, RateLimit};
use crate::fs_ops::FsError;

pub const FILE_NAME: &str = "prefs.json";
/// Largest accepted prefs.json, in bytes. Worst case, every SSH list full, the file as pretty JSON (`save_to`):
///   - `ssh_known_hosts`: 32 x (`SSH_HOST_PIN_MAX` 2048 + ~10 JSON) = ~66 KB. Base64 and ASCII host text need no escaping.
///   - `ssh_recent_servers`: 10 x (key path 4096 escaped to 8192 + host 253 + user 64 + ~250 JSON) = ~88 KB.
///     The key path may hold `"` and `\`, which JSON writes as two bytes; control characters are refused.
///   - `ssh_recent_folders`: 100 x (path 4096 escaped to 8192 + server key 324 + ~150 JSON) = ~867 KB.
///   - everything else (current server, labels, URLs, feature flags): under 32 KB.
///   Total about 1,053,000 bytes (a test with every list full and all paths `"` measures 1,022,199 bytes).
///   1280 KiB is the smallest 64 KiB step with about 20 % or more headroom over that worst case (1,310,720 bytes, +24 %).
///   A smaller bound would turn a legitimate file into an "unreadable" one and reset every preference.
pub const MAX_BYTES: usize = 1280 * 1024;

/// The feature keys the server knows (`FEATURE_KEYS` in `extension/core/config.mjs`). Used only to turn
/// "everything except terminal" into an explicit list; a test pins the order and content.
pub(crate) const FEATURE_KEYS: [&str; 8] = [
    "agent_chat", "file_explorer", "code_graph_3d", "gantt_issues", "terminal", "doc_gen", "mobile_sync", "auto_tasks",
];

/// True for a key the server knows (`FEATURE_KEYS`).

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LtaMode {
    #[default]
    Off,
    Shadow,
    On,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    Midnight,
}

/// Settings > Server & Backend > Remote server: where the backend runs. Phase 1 stores the choice and the
/// connection fields and offers an SSH test; it does not deploy or move the core yet.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ServerMode {
    #[default]
    Local,
    Remote,
    /// A core on a Linux server, reached through the system `ssh`. Stored here; the host acts on it in a later step.
    Ssh,
}

/// Which credential the SSH mode uses. Records only the METHOD: a password is typed at connect time and is never
/// stored, so there is deliberately no field for one.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthKind {
    #[default]
    Key,
    Password,
}

/// Longest SSH host-key list, one entry per `host:port`. The oldest entry goes first when a new server is added.
pub(crate) const SSH_KNOWN_HOSTS_MAX: usize = 32;
/// Servers kept in the recent list, most recent first.
pub(crate) const SSH_RECENT_SERVERS_MAX: usize = 10;
/// Folders kept for each server.
pub(crate) const SSH_RECENT_FOLDERS_MAX: usize = 10;
/// Longest folder path in BYTES (`str::len`), the unit the file cap is counted in. A longer path is refused, never cut.
pub(crate) const SSH_FOLDER_PATH_MAX: usize = 4096;

/// A server SSH mode connected to, most recent first. It records the connection's shape and never a password: a
/// password login is `auth: password` with no key path.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SshRecentServer {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
    pub auth: SshAuthKind,
    /// Seconds since the Unix epoch of the last successful connect or key install.
    pub last_used: u64,
}

/// A folder opened on a saved server. `server` is `ssh_server_key` for that server, so a folder is found by the same
/// key as the server it belongs to.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SshRecentFolder {
    pub server: String,
    pub path: String,
    pub last_used: u64,
}

/// Non-secret remote connection settings. The private key PATH is stored; the key's contents never are.
/// Strings are trimmed/capped on the way in, and the SSH test re-validates the shapes before spawning ssh.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RemoteServerPrefs {
    pub mode: ServerMode,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
    pub label: String,
    /// `https://<host>[:port]` of the hub; set by the deploy or typed by the user.
    pub hub_url: String,
    /// Leaf SPKI pin (`sha256:` + 43 base64url). Empty until the user confirms the probe.
    pub tls_pin: String,
    /// The SSH credential method. Absent in files written before SSH mode existed, which reads as `Key`.
    pub ssh_auth: SshAuthKind,
    /// The single host key of the first SSH build. On load it moves into `ssh_known_hosts` and is then kept empty;
    /// the field stays so an older build still loads the file. Never written by this build.
    pub ssh_host_pin: String,
    /// Host keys the user confirmed, one `<host>:<port> <key-type> <key-base64>` line per endpoint, the same public
    /// data a known_hosts line holds. Written only by the host's trust path, never by the webview.
    pub ssh_known_hosts: Vec<String>,
    /// Servers connected to recently, most recent first. Written only by a successful connect or key install.
    pub ssh_recent_servers: Vec<SshRecentServer>,
    /// Folders opened on those servers, most recent first. Written only by the host's folder paths.
    pub ssh_recent_folders: Vec<SshRecentFolder>,
}

impl Default for RemoteServerPrefs {
    fn default() -> Self {
        Self {
            mode: ServerMode::Local, host: String::new(), port: 22, user: String::new(), key_path: String::new(), label: String::new(),
            hub_url: String::new(), tls_pin: String::new(), ssh_auth: SshAuthKind::Key, ssh_host_pin: String::new(),
            ssh_known_hosts: Vec::new(), ssh_recent_servers: Vec::new(), ssh_recent_folders: Vec::new(),
        }
    }
}

/// Longest saved SSH host-key pin, in BYTES (`str::len`). Sized for an 8192-bit RSA key (about 1400 base64
/// characters) with room to spare. A longer pin is refused on write and cleared on load; it is never cut short,
/// because a cut pin could still decode as base64 and would then read as a different key.
pub(crate) const SSH_HOST_PIN_MAX: usize = 2048;

/// The pin if it fits `SSH_HOST_PIN_MAX`, else `None`. Shared by the load path and the writer so both agree.
fn bounded_ssh_host_pin(pin: &str) -> Option<String> {
    let trimmed = pin.trim();
    (trimmed.len() <= SSH_HOST_PIN_MAX).then(|| trimmed.to_string())
}

/// One saved host key, split into the parts the SSH service compares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KnownHost {
    /// `host:port` with the host lower-cased: the key a server is looked up by.
    pub endpoint: String,
    pub key_type: String,
    pub key_b64: String,
}

/// The endpoint text every list is keyed by: `host:port`, host lower-cased, so one server has one spelling.
fn endpoint_text(host: &str, port: u16) -> String {
    format!("{}:{port}", host.to_ascii_lowercase())
}

/// Parses one saved pin with the checks the single pin always had: three fields, a host and a nonzero port, a known
/// key type and a key blob that decodes. Text over `SSH_HOST_PIN_MAX` is refused, never cut, because a cut key could
/// still decode and then name a different key.
pub(crate) fn parse_known_host(entry: &str) -> Option<KnownHost> {
    let text = bounded_ssh_host_pin(entry)?;
    let mut fields = text.split_whitespace();
    let (Some(host_port), Some(key_type), Some(key_b64), None) = (fields.next(), fields.next(), fields.next(), fields.next()) else {
        return None;
    };
    let (host, port) = host_port.rsplit_once(':')?;
    let port: u16 = port.parse().ok().filter(|p| *p != 0)?;
    let shape_ok = crate::remote::valid_host(host) && crate::remote::valid_host_key_type(key_type);
    if !shape_ok || crate::remote_deploy::fingerprint_for_key_b64(key_b64).is_none() {
        return None;
    }
    Some(KnownHost { endpoint: endpoint_text(host, port), key_type: key_type.to_string(), key_b64: key_b64.to_string() })
}

/// Puts `known` in the list in place of any entry for the same endpoint, at the end. The list keeps the newest
/// `SSH_KNOWN_HOSTS_MAX`, so the oldest pin is the one dropped; that only means the user confirms it again.
fn put_known_host(list: &mut Vec<String>, known: &KnownHost) {
    list.retain(|saved| !matches!(parse_known_host(saved), Some(kept) if kept.endpoint == known.endpoint));
    list.push(format!("{} {} {}", known.endpoint, known.key_type, known.key_b64));
    if list.len() > SSH_KNOWN_HOSTS_MAX {
        let extra = list.len() - SSH_KNOWN_HOSTS_MAX;
        list.drain(..extra);
    }
}

/// The list as loaded: entries that fail `parse_known_host` are dropped, and there is one entry per endpoint.
fn normalize_known_hosts(list: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for entry in list {
        if let Some(known) = parse_known_host(entry) {
            put_known_host(&mut out, &known);
        }
    }
    out
}

/// The key a saved server and its folders share: `<user>@<host>:<port>`, host lower-cased. The user is kept as typed
/// because user names are case-sensitive on the server.
pub(crate) fn ssh_server_key(user: &str, host: &str, port: u16) -> String {
    format!("{user}@{}", endpoint_text(host, port))
}

fn recent_key(entry: &SshRecentServer) -> String {
    ssh_server_key(&entry.user, &entry.host, entry.port)
}

/// Puts `entry` first, replacing the same server. Returns the keys of the servers pushed past the cap, so their
/// folders can go with them.
fn put_recent_server(list: &mut Vec<SshRecentServer>, entry: SshRecentServer) -> Vec<String> {
    let key = recent_key(&entry);
    list.retain(|saved| recent_key(saved) != key);
    list.insert(0, entry);
    let mut pushed_out = Vec::new();
    while list.len() > SSH_RECENT_SERVERS_MAX {
        if let Some(old) = list.pop() {
            pushed_out.push(recent_key(&old));
        }
    }
    pushed_out
}

/// A loaded recent entry that passes the writer's shape rules, with the host lower-cased. A password entry keeps no
/// key path, since none is used.
fn clean_recent_server(entry: &SshRecentServer) -> Option<SshRecentServer> {
    let host = entry.host.trim().to_ascii_lowercase();
    let user = entry.user.trim().to_string();
    let key_path = match entry.auth {
        SshAuthKind::Key => entry.key_path.trim().to_string(),
        SshAuthKind::Password => String::new(),
    };
    let key_ok = entry.auth == SshAuthKind::Password || crate::remote::valid_key_path(&key_path);
    let ok = crate::remote::valid_host(&host) && crate::remote::valid_user(&user) && entry.port != 0 && key_ok;
    ok.then(|| SshRecentServer { host, port: entry.port, user, key_path, auth: entry.auth, last_used: entry.last_used })
}

/// The recent list as loaded, in file order (most recent first): invalid entries dropped, one entry per server.
fn normalize_recent_servers(list: &[SshRecentServer]) -> Vec<SshRecentServer> {
    let mut out: Vec<SshRecentServer> = Vec::new();
    for entry in list {
        if out.len() == SSH_RECENT_SERVERS_MAX {
            break;
        }
        let Some(clean) = clean_recent_server(entry) else { continue };
        if !out.iter().any(|kept| recent_key(kept) == recent_key(&clean)) {
            out.push(clean);
        }
    }
    out
}

/// A folder path that is safe to store and to hand to the server side: absolute, bounded in bytes, and with no control
/// character (no line break, NUL or tab). Excluding every control character caps the JSON escaping of a path at two
/// bytes per byte (`"` and `\`), which is what keeps `MAX_BYTES` a real bound.
fn valid_folder_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= SSH_FOLDER_PATH_MAX && !path.chars().any(char::is_control)
}

/// Puts a folder first in its server's list, replacing the same path, and keeps that server's newest folders.
fn put_recent_folder(list: &mut Vec<SshRecentFolder>, server: &str, path: &str, now: u64) {
    list.retain(|folder| !(folder.server == server && folder.path == path));
    list.insert(0, SshRecentFolder { server: server.to_string(), path: path.to_string(), last_used: now });
    let mut kept = 0usize;
    list.retain(|folder| {
        if folder.server != server {
            return true;
        }
        kept += 1;
        kept <= SSH_RECENT_FOLDERS_MAX
    });
}

/// The folder list as loaded: only folders of a server still in the recent list, with valid paths, no duplicates and
/// at most `SSH_RECENT_FOLDERS_MAX` per server.
fn normalize_recent_folders(list: &[SshRecentFolder], servers: &[SshRecentServer]) -> Vec<SshRecentFolder> {
    let keys: Vec<String> = servers.iter().map(recent_key).collect();
    let mut out: Vec<SshRecentFolder> = Vec::new();
    for folder in list {
        let duplicate = out.iter().any(|kept| kept.server == folder.server && kept.path == folder.path);
        let per_server = out.iter().filter(|kept| kept.server == folder.server).count();
        let owned = keys.contains(&folder.server);
        if owned && !duplicate && per_server < SSH_RECENT_FOLDERS_MAX && valid_folder_path(&folder.path) {
            out.push(folder.clone());
        }
    }
    out
}

impl RemoteServerPrefs {
    /// Keeps a hand-edited or hostile prefs.json bounded. The host command still validates the exact shapes.
    pub fn normalized(mut self) -> Self {
        let cap = |s: String, max: usize| s.trim().chars().take(max).collect();
        self.host = cap(self.host, 253);
        self.user = cap(self.user, 64);
        self.key_path = cap(self.key_path, 4096);
        self.label = cap(self.label, 80);
        self.hub_url = cap(self.hub_url, 300);
        self.tls_pin = cap(self.tls_pin, 80);
        // The legacy single pin is migrated after the list is normalised, so on a clash for the same endpoint the
        // migrated key wins. Every load runs this, and the result is the same each time, so the file is not rewritten.
        let legacy_pin = std::mem::take(&mut self.ssh_host_pin);
        self.ssh_known_hosts = normalize_known_hosts(&self.ssh_known_hosts);
        if let Some(known) = parse_known_host(&legacy_pin) {
            put_known_host(&mut self.ssh_known_hosts, &known);
        }
        self.ssh_recent_servers = normalize_recent_servers(&self.ssh_recent_servers);
        self.ssh_recent_folders = normalize_recent_folders(&self.ssh_recent_folders, &self.ssh_recent_servers);
        // Hand-edited prefs or a webview call must not downgrade the hub to plaintext.
        if crate::remote_tls::validate_hub_url(&self.hub_url, cfg!(debug_assertions)).is_err() { self.hub_url.clear(); }
        // Empty is the normal WebPKI case; a non-empty pin must still have the exact shape.
        if !self.tls_pin.is_empty() && !crate::remote_tls::valid_pin(&self.tls_pin) { self.tls_pin.clear(); }
        if self.port == 0 {
            self.port = 22;
        }
        self
    }
}

/// App-wide Loop defaults for loops added to a project the first time. Stored with the other host prefs; read by
/// the Loop screen when it re-adds a missing default loop.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct LoopDefaults {
    pub max_iterations: u32,
    pub consecutive_failure_stop: u32,
    /// 0 = no wall-clock limit.
    pub wall_clock_minutes: u32,
    pub max_repairs_per_stage: u32,
    /// 0 = no pause timeout.
    pub pause_timeout_minutes: u32,
    /// revert | stop | warn | off
    pub protected_path_policy: String,
    pub write_summary_note: bool,
}

impl LoopDefaults {
    /// The same bounds the Settings card and the TypeScript decoder enforce. A hand-edited or hostile
    /// prefs.json cannot hand the Loop engine a zero/absurd budget.
    fn clamped(mut self) -> Self {
        self.max_iterations = self.max_iterations.clamp(1, 100);
        self.consecutive_failure_stop = self.consecutive_failure_stop.clamp(1, 20);
        self.wall_clock_minutes = self.wall_clock_minutes.min(1440);
        self.max_repairs_per_stage = self.max_repairs_per_stage.min(20);
        self.pause_timeout_minutes = self.pause_timeout_minutes.min(240);
        self.protected_path_policy = match self.protected_path_policy.as_str() {
            "stop" => "stop", "warn" => "warn", "off" => "off", _ => "revert",
        }.to_string();
        self
    }
}

impl Default for LoopDefaults {
    fn default() -> Self {
        Self {
            max_iterations: 10,
            consecutive_failure_stop: 2,
            wall_clock_minutes: 0,
            max_repairs_per_stage: 3,
            pause_timeout_minutes: 30,
            protected_path_policy: "revert".to_string(),
            write_summary_note: false,
        }
    }
}

/// Which native notifications the host may show (Settings > General > Notifications). Applies at once.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct NotifyPrefs {
    /// A tool approval in Chat or a bus job (phone, web app, schedule) is waiting.
    pub approvals: bool,
    /// A Loop run, Auto Task, code graph generation or Doc Gen finished or failed.
    pub tasks: bool,
    /// Sync turned itself off or removed a device.
    pub sync: bool,
    /// A signed update is available.
    pub updates: bool,
    /// The backend stopped unexpectedly.
    pub core: bool,
}

impl Default for NotifyPrefs {
    fn default() -> Self { Self { approvals: true, tasks: true, sync: true, updates: true, core: true } }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Prefs {
    pub lta_mode: LtaMode,
    pub router: bool,
    pub cap: bool,
    pub compress: bool,
    pub learn: bool,
    /// Continue an ended chat from a summary (bench-gated, beta): `LLMIDE_V2_CONTINUE_SUMMARY=on` at the next backend start.
    pub continue_summary: bool,
    pub terminal: bool,
    pub theme: Theme,
    /// The feature profile (an explicit subset of `FEATURE_KEYS`; empty = every feature, the historical behaviour).
    pub features: Vec<String>,
    // ---- backend (Server & Backend) ----
    // The three paths below are written only by the native pickers (backend_pick.rs), never by set_prefs.
    /// False = the app's bundled core (the default); true = run the core from a source checkout.
    pub backend_source: bool,
    /// Source-checkout mode only: node binary (empty = auto-detect).
    pub backend_node: String,
    /// Source-checkout mode only: the checkout's `extension` folder (empty = auto-detect).
    pub backend_dir: String,
    /// Source-checkout mode only: loopback port (0 = the app's 3456-3459 range).
    pub backend_port: u16,
    /// Start the core when the app starts (false leaves it stopped until Start).
    pub backend_auto_start: bool,
    /// Where the backend runs (Local desktop vs a remote SSH host). Phase 1 stores the choice and offers a
    /// connection test; the core still runs locally until phase 2 adds deploy.
    pub remote_server: RemoteServerPrefs,
    // ---- Host API v1 (Settings > Phone and browser) ----
    /// Serve the pairing listener (pinned TLS, all interfaces) from the spawned core: `LLMIDE_HOST_API_TLS=1`.
    /// All five apply at the NEXT core start, like every other backend pref; a packaged app used to pass none of
    /// them, so read / compose / push / tool approvals could never be on.
    /// Read, compose and tool approvals default ON (a paired phone gets History, Execute and Auto Tasks with no setup;
    /// each command is still checked against the member's role and project grant) and reach the core as an explicit
    /// `1` or `0`. A file saved before they defaulted on stores `false` for all three (every save wrote every field),
    /// which cannot be told from a deliberate off; the previous build forced them on, so `host_api_caps_migrated`
    /// marks a one-time migration (see `parse`) that turns them on once, after which the user's switches are honoured.
    pub host_api_tls: bool,
    pub host_api_read: bool,
    pub host_api_compose: bool,
    pub host_api_push: bool,
    pub host_api_tool_approvals: bool,
    /// Opt-in, default OFF: serve `files.write` / `git.commit` / `git.push` / `terminal.exec` to paired devices
    /// (`LLMIDE_HOST_API_WORKSPACE_WRITE=1`). A remote edit can change a test script, so this is code execution.
    #[serde(default)]
    pub host_api_workspace_write: bool,
    /// Opt-in, default OFF: serve `terminal.shell` (`LLMIDE_HOST_API_SHELL=1`). Only passed while workspace write is
    /// on, so the core never serves a full shell without the narrower capability.
    #[serde(default)]
    pub host_api_shell: bool,
    /// Set once the three default-on capabilities above were restored for a file that predates this field. A missing
    /// key reads as false (the file is old); `Default` is true (a fresh install needs no migration).
    #[serde(default)]
    pub host_api_caps_migrated: bool,
    /// Browser origins allowed to open the pairing listener directly (`LLMIDE_HOST_API_WEB_ORIGINS`). Normalised on
    /// save by `normalize_web_origins`; empty falls back to the desktop process's own env (dev setups).
    pub host_api_web_origins: Vec<String>,
    /// App-wide defaults for loops added to a newly detected project.
    pub loop_defaults: LoopDefaults,
    /// Minutes between automatic Code Graph refreshes; 0 = off. Values 1-4 are raised to 5.
    pub graph_auto_update_minutes: u32,
    /// Look for a signed update once a day (check only; installing always asks). Applies at once.
    pub update_checks: bool,
    /// Per-category notification switches. Applies at once.
    pub notifications: NotifyPrefs,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            lta_mode: LtaMode::Off, router: false, cap: false, compress: false, learn: false, continue_summary: false, terminal: true, theme: Theme::Dark,
            features: Vec::new(), backend_source: false, backend_node: String::new(), backend_dir: String::new(), backend_port: 0, backend_auto_start: true,
            remote_server: RemoteServerPrefs::default(),
            host_api_tls: false, host_api_read: true, host_api_compose: true, host_api_push: false, host_api_tool_approvals: true, host_api_workspace_write: false, host_api_shell: false, host_api_caps_migrated: true,
            host_api_web_origins: Vec::new(),
            loop_defaults: LoopDefaults::default(), graph_auto_update_minutes: 0, update_checks: true, notifications: NotifyPrefs::default(),
        }
    }
}

/// A partial update: absent fields stay as they are.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefsPatch {
    pub lta_mode: Option<LtaMode>,
    pub router: Option<bool>,
    pub cap: Option<bool>,
    pub compress: Option<bool>,
    pub learn: Option<bool>,
    pub continue_summary: Option<bool>,
    pub terminal: Option<bool>,
    pub theme: Option<Theme>,
    pub features: Option<Vec<String>>,
    /// The toggle only: the node binary and checkout folder are host-picked (`set_backend_paths`), never patched.
    pub backend_source: Option<bool>,
    pub backend_port: Option<u16>,
    pub backend_auto_start: Option<bool>,
    /// Whole non-secret remote connection block (mode, host, port, user, key path, label).
    pub remote_server: Option<RemoteServerPrefs>,
    pub host_api_tls: Option<bool>,
    pub host_api_read: Option<bool>,
    pub host_api_compose: Option<bool>,
    pub host_api_push: Option<bool>,
    pub host_api_tool_approvals: Option<bool>,
    pub host_api_workspace_write: Option<bool>,
    pub host_api_shell: Option<bool>,
    pub host_api_web_origins: Option<Vec<String>>,
    pub loop_defaults: Option<LoopDefaults>,
    pub graph_auto_update_minutes: Option<u32>,
    pub update_checks: Option<bool>,
    pub notifications: Option<NotifyPrefs>,
}

/// An explicit feature list: only keys the server knows, in the canonical order, with `agent_chat` always on.
fn normalize_features(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = FEATURE_KEYS
        .iter()
        .filter(|k| list.iter().any(|x| x == *k))
        .map(|k| (*k).to_string())
        .collect();
    if !out.iter().any(|k| k == "agent_chat") {
        out.insert(0, "agent_chat".to_string());
    }
    out
}

/// At most this many origins, and their comma-joined text at most `MAX_WEB_ORIGINS_CHARS` (core_host's env bound).
const MAX_WEB_ORIGINS: usize = 10;
const MAX_WEB_ORIGINS_CHARS: usize = 2048;

fn port_ok(p: &str) -> bool {
    (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && matches!(p.parse::<u32>(), Ok(1..=65535))
}

fn dns_label_ok(l: &str) -> bool {
    let b = l.as_bytes();
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 63 && edge(b[0]) && edge(b[b.len() - 1]) && b.iter().all(|c| edge(*c) || *c == b'-')
}

/// One Host API web origin, normalised by the same rule as `extension/core/host-api-origins.mjs` (pinned by
/// `schema/host-api/v1/fixtures/security/origins.json`): an exact loopback http origin with a port, or an exact
/// https DNS-name origin (default port dropped). `None` for anything else, including an IP-literal https origin.
pub fn normalize_web_origin(entry: &str) -> Option<String> {
    let e = entry.trim().to_lowercase();
    if let Some(rest) = e.strip_prefix("http://") {
        let (host, port) = rest.rsplit_once(':')?;
        return (matches!(host, "localhost" | "127.0.0.1" | "[::1]") && port_ok(port)).then_some(e);
    }
    let rest = e.strip_prefix("https://")?;
    let (host, port) = match rest.split_once(':') { Some((h, p)) => (h, Some(p)), None => (rest, None) };
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || !labels.iter().all(|l| dns_label_ok(l)) || host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    match port {
        None => Some(e),
        Some(p) if !port_ok(p) => None,
        Some(p) if p.parse::<u32>() == Ok(443) => Some(format!("https://{host}")),
        Some(_) => Some(e),
    }
}

/// The saved list: invalid entries dropped, duplicates removed, bounded by count and total length.
pub fn normalize_web_origins(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut chars = 0usize;
    for entry in list {
        let Some(n) = normalize_web_origin(entry) else { continue };
        if out.contains(&n) { continue; }
        let next = chars + n.len() + usize::from(!out.is_empty());
        if out.len() >= MAX_WEB_ORIGINS || next > MAX_WEB_ORIGINS_CHARS { break; }
        chars = next;
        out.push(n);
    }
    out
}

impl Prefs {
    pub fn patched(&self, p: &PrefsPatch) -> Prefs {
        let mut n = self.clone();
        if let Some(v) = p.lta_mode { n.lta_mode = v; }
        if let Some(v) = p.router { n.router = v; }
        if let Some(v) = p.cap { n.cap = v; }
        if let Some(v) = p.compress { n.compress = v; }
        if let Some(v) = p.learn { n.learn = v; }
        if let Some(v) = p.continue_summary { n.continue_summary = v; }
        if let Some(v) = p.terminal { n.terminal = v; }
        if let Some(v) = p.theme { n.theme = v; }
        if let Some(v) = p.backend_source { n.backend_source = v; }
        if let Some(v) = p.backend_port { n.backend_port = v; }
        if let Some(v) = p.backend_auto_start { n.backend_auto_start = v; }
        if let Some(v) = &p.remote_server {
            // A webview may choose mode/host/user, but the hub URL, the hub pin and every SSH trust or recent list
            // are written only by the host's own paths (`set_remote_pin`, `set_remote_hub`, `upsert_ssh_known_host`,
            // `set_remote_ssh`, the folder and forget writers); keep whatever this host already holds.
            let mut block = v.clone().normalized();
            block.hub_url = n.remote_server.hub_url.clone();
            block.tls_pin = n.remote_server.tls_pin.clone();
            block.ssh_host_pin = n.remote_server.ssh_host_pin.clone();
            block.ssh_known_hosts = n.remote_server.ssh_known_hosts.clone();
            block.ssh_recent_servers = n.remote_server.ssh_recent_servers.clone();
            block.ssh_recent_folders = n.remote_server.ssh_recent_folders.clone();
            n.remote_server = block;
        }
        if let Some(v) = p.host_api_tls { n.host_api_tls = v; }
        if let Some(v) = p.host_api_read { n.host_api_read = v; }
        if let Some(v) = p.host_api_compose { n.host_api_compose = v; }
        if let Some(v) = p.host_api_push { n.host_api_push = v; }
        if let Some(v) = p.host_api_tool_approvals { n.host_api_tool_approvals = v; }
        if let Some(v) = p.host_api_workspace_write { n.host_api_workspace_write = v; }
        if let Some(v) = p.host_api_shell { n.host_api_shell = v; }
        if let Some(v) = &p.host_api_web_origins { n.host_api_web_origins = normalize_web_origins(v); }
        if let Some(v) = &p.loop_defaults {
            n.loop_defaults = v.clone().clamped();
        }
        if let Some(v) = p.graph_auto_update_minutes {
            n.graph_auto_update_minutes = if v == 0 { 0 } else { v.clamp(5, 1440) };
        }
        if let Some(v) = p.notifications {
            n.notifications = v;
        }
        if let Some(v) = p.update_checks {
            n.update_checks = v;
        }
        if let Some(v) = &p.features {
            if v.is_empty() {
                // Empty stays "inherit every feature"; the Terminal flag is left as it was.
                n.features = Vec::new();
            } else {
                n.features = normalize_features(v);
                // An explicit profile owns the Terminal feature; keep the legacy flag in step so both views agree.
                n.terminal = n.features.iter().any(|k| k == "terminal");
            }
        } else if p.terminal.is_some() && !n.features.is_empty() {
            // The legacy Terminal switch (Settings > Workspace > Features) edits the same profile.
            n.features.retain(|k| k != "terminal");
            if n.terminal {
                n.features = normalize_features(&[n.features.clone(), vec!["terminal".to_string()]].concat());
            }
        }
        // Cap and compress only act while the router is on; never store a state that cannot mean what it says.
        if !n.router {
            n.cap = false;
            n.compress = false;
        }
        n
    }
}

/// Parses file text; a file that cannot be read at all (too big, not JSON, wrong type) yields the defaults. Unknown
/// keys are dropped, not fatal: see `try_parse`.
#[cfg(test)]
pub fn parse(text: &str) -> Prefs {
    parse_migrating(text).0
}

/// Like `parse`, plus whether the one-time Host API capability migration ran (the caller persists it). A valid file
/// without `hostApiCapsMigrated` gets read / compose / tool approvals switched on, as the previous build forced them.
#[cfg(test)]
fn parse_migrating(text: &str) -> (Prefs, bool) {
    try_parse(text).unwrap_or_else(|| (Prefs::default(), false))
}

/// Drops every key of `value` that `known` (a serialised default) does not have, recursing into nested objects.
fn prune_unknown_keys(value: &mut serde_json::Value, known: &serde_json::Value) {
    let (Some(obj), Some(known_obj)) = (value.as_object_mut(), known.as_object()) else { return };
    obj.retain(|key, _| known_obj.contains_key(key));
    for (key, child) in obj.iter_mut() {
        if let Some(known_child) = known_obj.get(key) {
            prune_unknown_keys(child, known_child);
        }
    }
}

/// `None` when the text is unusable. Unknown keys are ignored here on purpose: an older build reading a file a newer
/// build wrote (rollback, branch switch) must not reset every preference. The webview-facing `PrefsPatch` stays strict.
fn try_parse(text: &str) -> Option<(Prefs, bool)> {
    if text.len() > MAX_BYTES {
        return None;
    }
    let mut value: serde_json::Value = serde_json::from_str(text).ok()?;
    if let Ok(known) = serde_json::to_value(Prefs::default()) {
        prune_unknown_keys(&mut value, &known);
    }
    let p: Prefs = serde_json::from_value(value).ok()?;
    let migrate = !p.host_api_caps_migrated;
    let mut out = from_stored(&p);
    if migrate {
        out.host_api_read = true;
        out.host_api_compose = true;
        out.host_api_tool_approvals = true;
    }
    out.host_api_caps_migrated = true;
    Some((out, migrate))
}

fn from_stored(p: &Prefs) -> Prefs {
    Some(p).map(|p| {
        let mut out = Prefs::default().patched(&PrefsPatch {
            lta_mode: Some(p.lta_mode), router: Some(p.router), cap: Some(p.cap), compress: Some(p.compress),
            learn: Some(p.learn), continue_summary: Some(p.continue_summary), terminal: Some(p.terminal), theme: Some(p.theme),
            // Empty stays "inherit every feature"; a non-empty list is the explicit profile.
            features: if p.features.is_empty() { None } else { Some(p.features.clone()) },
            backend_source: Some(p.backend_source), backend_port: Some(p.backend_port), backend_auto_start: Some(p.backend_auto_start),
            remote_server: Some(p.remote_server.clone()),
            host_api_tls: Some(p.host_api_tls), host_api_read: Some(p.host_api_read), host_api_compose: Some(p.host_api_compose),
            host_api_push: Some(p.host_api_push), host_api_tool_approvals: Some(p.host_api_tool_approvals),
            host_api_workspace_write: Some(p.host_api_workspace_write), host_api_shell: Some(p.host_api_shell),
            host_api_web_origins: Some(p.host_api_web_origins.clone()),
            loop_defaults: Some(p.loop_defaults.clone()), graph_auto_update_minutes: Some(p.graph_auto_update_minutes),
            update_checks: Some(p.update_checks), notifications: Some(p.notifications),
        });
        out.backend_node = p.backend_node.trim().to_string();
        out.backend_dir = p.backend_dir.trim().to_string();
        // `patched` deliberately keeps the host-verified hub URL/pin across a WEBVIEW patch. On a
        // file read there is no earlier verified value, so the file's own block must win or remote
        // mode would lose its URL (and the keychain binding) on every restart.
        out.remote_server = p.remote_server.clone().normalized();
        out
    }).unwrap_or_default()
}

/// Copies a file we could not use next to it, so the next `set_prefs` (which writes the defaults over it) cannot
/// destroy the user's only copy. Best effort: the load itself must not fail.
fn preserve_unreadable(dir: &Path, path: &Path) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let aside = dir.join(format!("{FILE_NAME}.unreadable-{stamp}"));
    if aside.exists() || std::fs::copy(path, &aside).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&aside, std::fs::Permissions::from_mode(0o600));
    }
    eprintln!("prefs: {} could not be read; kept a copy at {}", path.display(), aside.display());
}

pub fn load_from(dir: &Path) -> Prefs {
    let path = dir.join(FILE_NAME);
    let Ok(meta) = std::fs::metadata(&path) else { return Prefs::default() };
    if !meta.is_file() {
        return Prefs::default();
    }
    let parsed = if meta.len() <= MAX_BYTES as u64 {
        std::fs::read_to_string(&path).ok().and_then(|text| try_parse(&text))
    } else {
        None
    };
    match parsed {
        Some((prefs, migrated)) => {
            // Best effort: if the write fails the migration simply runs again on the next load.
            if migrated {
                let _ = save_to(dir, &prefs);
            }
            prefs
        }
        None => {
            preserve_unreadable(dir, &path);
            Prefs::default()
        }
    }
}

pub fn save_to(dir: &Path, prefs: &Prefs) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    crate::fsutil::write_private_atomic(&dir.join(FILE_NAME), &body, MAX_BYTES)
}

// ---- what the core and the Terminal gate get --------------------------------------------------

/// `LLMIDE_FEATURES` for the core and the Terminal gate: the host's own value, minus `terminal` when
/// the pref turns it off. `None` = leave it unset (every feature on). Unset or empty means all.
#[cfg(test)]
pub fn effective_features(host_env: Option<&str>, terminal: bool) -> Option<String> {
    effective_features_with(host_env, terminal, &[])
}

/// `LLMIDE_FEATURES` for the core: an explicit profile wins over the host's own value. Dependencies are enforced
/// in the UI (the same rule as the Mac's `AppFeature.validated`); here the list is filtered to known keys, chat is
/// kept, and `terminal` follows the Terminal switch. Never an empty value (that would read as "all").
pub fn effective_features_with(host_env: Option<&str>, terminal: bool, features: &[String]) -> Option<String> {
    if !features.is_empty() {
        let mut list: Vec<&str> = FEATURE_KEYS
            .iter()
            .copied()
            .filter(|k| features.iter().any(|x| x == k) && (terminal || *k != "terminal"))
            .collect();
        if !list.contains(&"agent_chat") {
            list.insert(0, "agent_chat");
        }
        return Some(list.join(","));
    }
    let base: Option<Vec<&str>> = host_env.map(str::trim).filter(|v| !v.is_empty()).map(|v| v.split(',').map(str::trim).filter(|k| !k.is_empty()).collect());
    if terminal {
        return host_env.map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    }
    let list: Vec<&str> = base.unwrap_or_else(|| FEATURE_KEYS.to_vec()).into_iter().filter(|k| *k != "terminal").collect();
    Some(if list.is_empty() { "agent_chat".to_string() } else { list.join(",") })
}

/// The `LLMIDE_*` variables the spawned core gets from the prefs: the exact value `on` or `1` (and `0` for the three
/// default-on Host API capabilities, which are always passed).
pub fn core_env_pairs(p: &Prefs, host_features: Option<&str>) -> Vec<(&'static str, String)> {
    let mut v = Vec::new();
    if p.router {
        v.push(("LLMIDE_ROUTER", "on".to_string()));
        if p.cap { v.push(("LLMIDE_ROUTER_CAP", "on".to_string())); }
        if p.compress { v.push(("LLMIDE_ROUTER_COMPRESS", "on".to_string())); }
    }
    if p.learn { v.push(("LLMIDE_ROUTER_LEARN", "on".to_string())); }
    if p.continue_summary { v.push(("LLMIDE_V2_CONTINUE_SUMMARY", "on".to_string())); }
    // Host API v1 capabilities: exact `1`, the value the core reads. A packaged app enables them in Settings; the
    // core only sees them at its next start. The default-on three are always passed as `1` or `0` (the core treats
    // anything but `1` as off), so a switch turned off also wins over a value inherited from the host env.
    let flag = |on: bool| (if on { "1" } else { "0" }).to_string();
    if p.host_api_tls { v.push(("LLMIDE_HOST_API_TLS", "1".to_string())); }
    v.push(("LLMIDE_HOST_API_READ", flag(p.host_api_read)));
    v.push(("LLMIDE_HOST_API_COMPOSE", flag(p.host_api_compose)));
    if p.host_api_push { v.push(("LLMIDE_HOST_API_PUSH", "1".to_string())); }
    v.push(("LLMIDE_HOST_API_TOOL_APPROVALS", flag(p.host_api_tool_approvals)));
    // Default OFF and omitted when off (like push): a stale value in the host env must not be the only thing that
    // decides whether a remote device can write files or run a shell. Shell is gated on workspace write.
    if p.host_api_workspace_write {
        v.push(("LLMIDE_HOST_API_WORKSPACE_WRITE", "1".to_string()));
        if p.host_api_shell { v.push(("LLMIDE_HOST_API_SHELL", "1".to_string())); }
    }
    if !p.host_api_web_origins.is_empty() { v.push(("LLMIDE_HOST_API_WEB_ORIGINS", p.host_api_web_origins.join(","))); }
    if !p.terminal || !p.features.is_empty() {
        if let Some(f) = effective_features_with(host_features, p.terminal, &p.features) { v.push(("LLMIDE_FEATURES", f)); }
    }
    v
}

// ---- process state ----------------------------------------------------------------------------

struct State {
    dir: Option<PathBuf>,
    stored: Prefs,
}

static LAUNCH: OnceLock<Prefs> = OnceLock::new();
static STATE: Mutex<Option<State>> = Mutex::new(None);
static LIMIT: RateLimit = RateLimit::new(50, 120);

fn state() -> std::sync::MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Reads the file once at startup and fixes the launch snapshot. Call before the core is spawned.
pub fn init(dir: Option<PathBuf>) {
    let stored = dir.as_deref().map(load_from).unwrap_or_default();
    let _ = LAUNCH.set(stored.clone());
    *state() = Some(State { dir, stored });
}

/// What this launch runs with (defaults before `init`, e.g. in unit tests).
pub fn launch() -> Prefs {
    LAUNCH.get().cloned().unwrap_or_default()
}

pub fn stored() -> Prefs {
    state().as_ref().map(|s| s.stored.clone()).unwrap_or_default()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrefsView {
    pub stored: Prefs,
    pub launch: Prefs,
    /// True when the stored values differ from what this launch runs with.
    pub restart_needed: bool,
    /// False when there is no data dir to save into (changes last for this session only).
    pub persisted: bool,
}

fn view(stored: Prefs, persisted: bool) -> PrefsView {
    let launch = launch();
    // The theme (and the stored remote choice, which phase 1 does not act on) applies at once; only the others need a restart.
    let restart_needed = Prefs { theme: launch.theme, loop_defaults: launch.loop_defaults.clone(), graph_auto_update_minutes: launch.graph_auto_update_minutes, update_checks: launch.update_checks, notifications: launch.notifications, remote_server: launch.remote_server.clone(), ..stored.clone() } != launch;
    PrefsView { stored, launch, restart_needed, persisted }
}

#[tauri::command]
pub fn get_prefs() -> PrefsView {
    let persisted = state().as_ref().is_some_and(|s| s.dir.is_some());
    view(stored(), persisted)
}

/// Strict typed update. Unknown keys and invalid values fail at deserialisation (before this runs).
#[tauri::command]
pub async fn set_prefs(patch: PrefsPatch) -> Result<PrefsView, FsError> {
    tauri::async_runtime::spawn_blocking(move || set_prefs_now(patch))
        .await
        .map_err(|e| crate::confirm::herr("io", format!("prefs task failed: {e}")))?
}

fn set_prefs_now(patch: PrefsPatch) -> Result<PrefsView, FsError> {
    if !LIMIT.allow() {
        return Err(herr("rate_limited", "too many preference changes"));
    }
    gate_host_api_tls(stored().host_api_tls, patch.host_api_tls, || {
        crate::confirm::ask(
            "Let devices on this network pair with this app?",
            "Let phones and browsers on this network pair with this app? It will listen on your local network.",
            "Allow pairing",
            true,
        )
    })?;
    apply(patch)
}

/// Turning the LAN listener on is a native decision; the webview alone cannot make it. Only the off-to-on change asks.
fn gate_host_api_tls(current: bool, requested: Option<bool>, ask: impl FnOnce() -> bool) -> Result<(), FsError> {
    if !current && requested == Some(true) && !ask() {
        return Err(herr("cancelled", "pairing on the local network was not enabled"));
    }
    Ok(())
}

fn apply(patch: PrefsPatch) -> Result<PrefsView, FsError> {
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let next = st.stored.patched(&patch);
    if let Some(dir) = &st.dir {
        save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?;
    }
    st.stored = next.clone();
    let persisted = st.dir.is_some();
    drop(g);
    Ok(view(next, persisted))
}

/// Host-side writer for the verified hub URL + pin only (never callable from the webview).
pub fn set_remote_pin(hub_url: String, tls_pin: String) -> Result<PrefsView, FsError> {
    let (canonical, _host, _port) = crate::remote_tls::validate_hub_url(&hub_url, cfg!(debug_assertions))?;
    let pin = tls_pin.trim().to_string();
    if !pin.is_empty() && !crate::remote_tls::valid_pin(&pin) {
        return Err(herr("invalid_pin", "the TLS pin is not a sha256 SPKI pin"));
    }
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let mut next = st.stored.clone();
    next.remote_server.hub_url = canonical;
    next.remote_server.tls_pin = pin;
    let next = next;
    if let Some(dir) = &st.dir { save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?; }
    st.stored = next.clone();
    let persisted = st.dir.is_some();
    drop(g);
    Ok(view(next, persisted))
}

/// Host-side writer for the URL-first connection: canonical hub URL, optional pin and mode.
/// The webview cannot call this directly; `remote_hub_login` is the only caller.
pub fn set_remote_hub(hub_url: String, tls_pin: String, mode: ServerMode) -> Result<PrefsView, FsError> {
    let (canonical, _host, _port) = crate::remote_tls::validate_hub_url(&hub_url, cfg!(debug_assertions))?;
    let pin = tls_pin.trim().to_string();
    if !pin.is_empty() && !crate::remote_tls::valid_pin(&pin) {
        return Err(herr("invalid_pin", "the TLS pin is not a sha256 SPKI pin"));
    }
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let mut next = st.stored.clone();
    next.remote_server.hub_url = canonical;
    next.remote_server.tls_pin = pin;
    next.remote_server.mode = mode;
    let next = next;
    if let Some(dir) = &st.dir { save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?; }
    st.stored = next.clone();
    let persisted = st.dir.is_some();
    drop(g);
    Ok(view(next, persisted))
}

/// Host-side writer for the SSH connection block. Validates the same shapes `ssh_transport::prepare_endpoint` checks
/// before any ssh runs, so a bad block is refused here instead of at connect time. The hub URL and TLS pin belong to
/// the hub and are kept as they are. The same write puts the server at the front of the recent list, because the
/// callers reach it only after a successful connect or key install.
///
pub fn set_remote_ssh(host: String, port: u16, user: String, key_path: String, ssh_auth: SshAuthKind, mode: ServerMode) -> Result<PrefsView, FsError> {
    let host = host.trim().to_string();
    if !crate::remote::valid_host(&host) {
        return Err(herr("invalid_host", "enter a hostname or IP address without spaces or a leading '-'"));
    }
    if port == 0 {
        return Err(herr("invalid_port", "the SSH port must be between 1 and 65535"));
    }
    let user = user.trim().to_string();
    if !crate::remote::valid_user(&user) {
        return Err(herr("invalid_user", "enter a plain SSH user name (letters, digits, '.', '_' or '-')"));
    }
    let key_path = key_path.trim().to_string();
    // A password login reads no key file, so the key path is only checked when the key is the method.
    if ssh_auth == SshAuthKind::Key && !crate::remote::valid_key_path(&key_path) {
        return Err(herr("invalid_key_path", "enter an absolute path to the private key file"));
    }
    edit_remote_server(|block| {
        block.host = host;
        block.port = port;
        block.user = user;
        block.key_path = key_path;
        block.ssh_auth = ssh_auth;
        block.mode = mode;
        // The server just worked, so it moves to the front of the recent list. Only key auth keeps a key path.
        let entry = SshRecentServer {
            host: block.host.to_ascii_lowercase(),
            port: block.port,
            user: block.user.clone(),
            key_path: if ssh_auth == SshAuthKind::Key { block.key_path.clone() } else { String::new() },
            auth: ssh_auth,
            last_used: now_secs(),
        };
        let pushed_out = put_recent_server(&mut block.ssh_recent_servers, entry);
        block.ssh_recent_folders.retain(|folder| !pushed_out.contains(&folder.server));
        Ok(())
    })
}

/// Host-side writer for the saved server's mode alone. The SSH service calls it when the user switches to the saved
/// server; the webview cannot change the mode directly.
pub(crate) fn set_remote_server_mode(mode: ServerMode) -> Result<PrefsView, FsError> {
    edit_remote_server(|block| {
        block.mode = mode;
        Ok(())
    })
}

/// Host-side writer for a confirmed SSH host key: replaces any key saved for the same host and port. The webview
/// cannot call it; the SSH service calls it only after a native yes/no dialog. Text that is not a valid pin is refused,
/// so nothing unreadable is stored.
pub(crate) fn upsert_ssh_known_host(pin: String) -> Result<PrefsView, FsError> {
    let known = parse_known_host(&pin)
        .ok_or_else(|| herr("invalid_host_key", "the saved server host key is not in a form that can be stored"))?;
    edit_remote_server(|block| {
        put_known_host(&mut block.ssh_known_hosts, &known);
        Ok(())
    })
}

/// Forgets a saved server: its recent entry and its folders, and its host key unless a saved server still needs it.
/// The stored block (the server SSH mode is switched to) is not changed, so a forgotten server the app is switched to
/// still connects; its key is kept for the same reason. The next connect saves the server again.
pub(crate) fn forget_ssh_server(host: &str, port: u16, user: &str) -> Result<(), FsError> {
    let host = host.trim();
    let user = user.trim();
    let key = ssh_server_key(user, host, port);
    let endpoint = endpoint_text(host, port);
    edit_remote_server(|block| {
        block.ssh_recent_servers.retain(|server| recent_key(server) != key);
        block.ssh_recent_folders.retain(|folder| folder.server != key);
        let switched_here = block.host.trim().eq_ignore_ascii_case(host) && block.port == port;
        let recent_here = block.ssh_recent_servers.iter().any(|server| endpoint_text(&server.host, server.port) == endpoint);
        if !switched_here && !recent_here {
            block.ssh_known_hosts.retain(|saved| !matches!(parse_known_host(saved), Some(kept) if kept.endpoint == endpoint));
        }
        Ok(())
    })
    .map(|_| ())
}

/// Records a folder opened on a saved server. `server` is `ssh_server_key` for that server. A folder is kept only for a
/// server in the recent list, so the recent list's cap bounds the folder list too.
///
/// Errors:
///     `invalid_path` for a path that is not absolute, is over `SSH_FOLDER_PATH_MAX` bytes, or has a control character;
///     `unknown_server` when the server is not in the recent list.
pub(crate) fn record_ssh_recent_folder(server: &str, path: &str) -> Result<(), FsError> {
    if !valid_folder_path(path) {
        return Err(herr("invalid_path", "the folder path must be absolute, at most 4096 bytes, with no control character"));
    }
    edit_remote_server(|block| {
        if !block.ssh_recent_servers.iter().any(|server_entry| recent_key(server_entry) == server) {
            return Err(herr("unknown_server", "Connect to this server before opening a folder on it."));
        }
        put_recent_folder(&mut block.ssh_recent_folders, server, path, now_secs());
        Ok(())
    })
    .map(|_| ())
}

/// The folder paths saved for one server, most recent first.
pub(crate) fn ssh_recent_folders(server: &str) -> Vec<String> {
    stored()
        .remote_server
        .ssh_recent_folders
        .iter()
        .filter(|folder| folder.server == server)
        .map(|folder| folder.path.clone())
        .collect()
}

/// Removes one folder from a server's list. Removing a folder that is not saved is not an error.
pub(crate) fn forget_ssh_recent_folder(server: &str, path: &str) -> Result<(), FsError> {
    edit_remote_server(|block| {
        block.ssh_recent_folders.retain(|folder| !(folder.server == server && folder.path == path));
        Ok(())
    })
    .map(|_| ())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Applies one host-side edit to the stored SSH block and saves it. The edit runs on a copy, so a refused edit or a
/// failed save leaves the stored block as it was. Nothing here is reachable from the webview.
fn edit_remote_server(edit: impl FnOnce(&mut RemoteServerPrefs) -> Result<(), FsError>) -> Result<PrefsView, FsError> {
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let mut next = st.stored.clone();
    edit(&mut next.remote_server)?;
    if let Some(dir) = &st.dir {
        save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?;
    }
    st.stored = next.clone();
    let persisted = st.dir.is_some();
    drop(g);
    Ok(view(next, persisted))
}

/// Host-side writer for the native pickers only: a picked checkout turns source mode on and stores the path.
/// Takes effect at the next app start, like every other backend path (see `launch()`).
pub(crate) fn set_backend_paths(node: Option<String>, folder: Option<String>) -> Result<PrefsView, FsError> {
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let mut next = st.stored.clone();
    next.backend_source = true;
    if let Some(n) = node { next.backend_node = n.trim().to_string(); }
    if let Some(d) = folder { next.backend_dir = d.trim().to_string(); }
    if let Some(dir) = &st.dir {
        save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?;
    }
    st.stored = next.clone();
    let persisted = st.dir.is_some();
    drop(g);
    Ok(view(next, persisted))
}

/// The archive policy this launch uses.
pub fn archive_policy() -> crate::chat_archive::ArchivePolicy {
    use crate::chat_archive::ArchivePolicy as P;
    match launch().lta_mode {
        LtaMode::Off => P::Off,
        LtaMode::Shadow => P::Shadow,
        LtaMode::On => P::On,
    }
}

/// The Terminal feature for this launch: the host's own `LLMIDE_FEATURES` AND the pref.
pub fn terminal_enabled(host_features: Option<&str>) -> bool {
    let launch = launch();
    let eff = effective_features_with(host_features, launch.terminal, &launch.features);
    crate::pty::feature_enabled(eff.as_deref(), "terminal")
}

/// Serialises tests that change the process-wide preferences (`STATE`). Taken by any test that writes them, so
/// two such tests never interleave their reads and restores.
#[cfg(test)]
static PREFS_TESTS: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn prefs_guard() -> std::sync::MutexGuard<'static, ()> {
    PREFS_TESTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Replaces the stored SSH block exactly, without validation or a save. Tests use it to set up a saved server.
#[cfg(test)]
pub(crate) fn set_remote_server_for_test(block: RemoteServerPrefs) {
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    st.stored.remote_server = block;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Owns a temp folder (or marker file) and removes it on drop, so a failing test leaves nothing behind.
    struct TempDirGuard(std::path::PathBuf);

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
            let _ = std::fs::remove_file(&self.0);
        }
    }

    impl std::ops::Deref for TempDirGuard {
        type Target = std::path::Path;
        fn deref(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl AsRef<std::path::Path> for TempDirGuard {
        fn as_ref(&self) -> &std::path::Path {
            &self.0
        }
    }

    fn tmp(tag: &str) -> TempDirGuard {
        let d = std::env::temp_dir().join(format!("llmide-prefs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        TempDirGuard(d)
    }

    const DEFAULT_ON_HOST_API: [&str; 3] = ["LLMIDE_HOST_API_READ", "LLMIDE_HOST_API_COMPOSE", "LLMIDE_HOST_API_TOOL_APPROVALS"];

    /// The core env minus the three always-passed Host API capabilities, for tests about the other switches.
    fn without_host_api(v: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
        v.into_iter().filter(|(k, _)| !DEFAULT_ON_HOST_API.contains(k)).collect()
    }

    #[test]
    fn web_origins_follow_the_shared_fixture_rule() {
        let text = include_str!("../../../schema/host-api/v1/fixtures/security/origins.json");
        let fixture: serde_json::Value = serde_json::from_str(text).unwrap();
        let raw: Vec<String> = fixture["allowlist"].as_str().unwrap().split(',').map(str::to_string).collect();
        let want: Vec<String> = fixture["parsed"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(normalize_web_origins(&raw), want);
    }

    #[test]
    fn web_origins_validate_normalise_and_bound() {
        assert_eq!(normalize_web_origin(" HTTPS://LLM-IDE.com "), Some("https://llm-ide.com".to_string()));
        assert_eq!(normalize_web_origin("https://a.example.com:443"), Some("https://a.example.com".to_string()));
        for bad in ["", "*", "https://localhost", "https://1.2.3.4", "http://example.com", "http://localhost", "http://localhost:0", "https://a.example.com:70000", "https://a.example.com/"] {
            assert_eq!(normalize_web_origin(bad), None, "{bad}");
        }
        let many: Vec<String> = (0..20).map(|i| format!("https://h{i}.example.com")).collect();
        assert_eq!(normalize_web_origins(&many).len(), 10);
        let long: Vec<String> = (0..3).map(|i| format!("https://{}{i}.example.com", "a".repeat(60))).collect();
        assert!(normalize_web_origins(&long).join(",").len() <= 2048);
        let dup = vec!["https://a.example.com".to_string(), "HTTPS://a.example.com".to_string(), "bad".to_string()];
        assert_eq!(normalize_web_origins(&dup), vec!["https://a.example.com".to_string()]);
    }

    #[test]
    fn web_origins_reach_the_core_only_when_set() {
        assert!(!core_env_pairs(&Prefs::default(), None).iter().any(|(k, _)| *k == "LLMIDE_HOST_API_WEB_ORIGINS"));
        let p = Prefs::default().patched(&PrefsPatch {
            host_api_web_origins: Some(vec!["https://llm-ide.com".into(), "http://localhost:5173".into(), "nope".into()]), ..Default::default()
        });
        assert!(core_env_pairs(&p, None).contains(&("LLMIDE_HOST_API_WEB_ORIGINS", "https://llm-ide.com,http://localhost:5173".to_string())));
        assert_eq!(parse(&serde_json::to_string(&p).unwrap()).host_api_web_origins, p.host_api_web_origins);
    }

    #[test]
    fn defaults_are_off_for_every_token_affecting_switch() {
        let d = Prefs::default();
        assert!(!d.router && !d.cap && !d.compress && !d.learn && !d.continue_summary);
        assert!(!d.host_api_tls && !d.host_api_push, "the listener and push stay opt-in");
        assert_eq!(d.lta_mode, LtaMode::Off);
        assert!(d.terminal);
        assert!(without_host_api(core_env_pairs(&d, None)).is_empty(), "defaults pass nothing else to the core");
    }

    #[test]
    fn workspace_write_and_shell_are_opt_in_and_shell_needs_write() {
        let d = Prefs::default();
        assert!(!d.host_api_workspace_write && !d.host_api_shell);
        let keys = |p: &Prefs| core_env_pairs(p, None).into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        assert!(!keys(&d).contains(&"LLMIDE_HOST_API_WORKSPACE_WRITE") && !keys(&d).contains(&"LLMIDE_HOST_API_SHELL"));
        let shell_only = Prefs { host_api_shell: true, ..Prefs::default() };
        assert!(!keys(&shell_only).contains(&"LLMIDE_HOST_API_SHELL"), "shell alone is never passed");
        let write = d.patched(&PrefsPatch { host_api_workspace_write: Some(true), ..Default::default() });
        assert!(core_env_pairs(&write, None).contains(&("LLMIDE_HOST_API_WORKSPACE_WRITE", "1".to_string())));
        assert!(!keys(&write).contains(&"LLMIDE_HOST_API_SHELL"));
        let both = write.patched(&PrefsPatch { host_api_shell: Some(true), ..Default::default() });
        assert!(core_env_pairs(&both, None).contains(&("LLMIDE_HOST_API_SHELL", "1".to_string())));
        let back = parse(&serde_json::to_string(&both).unwrap());
        assert!(back.host_api_workspace_write && back.host_api_shell);
        assert!(!parse(r#"{"terminal":true}"#).host_api_workspace_write, "old files default to off");
    }

    #[test]
    fn host_api_prefs_reach_the_core_as_exactly_one_and_nothing_else() {
        let p = Prefs { host_api_tls: true, host_api_read: true, host_api_compose: true, host_api_push: true, host_api_tool_approvals: true, ..Prefs::default() };
        assert_eq!(core_env_pairs(&p, None), vec![
            ("LLMIDE_HOST_API_TLS", "1".to_string()),
            ("LLMIDE_HOST_API_READ", "1".to_string()),
            ("LLMIDE_HOST_API_COMPOSE", "1".to_string()),
            ("LLMIDE_HOST_API_PUSH", "1".to_string()),
            ("LLMIDE_HOST_API_TOOL_APPROVALS", "1".to_string()),
        ]);
        // A patch turns them back off; each one alone passes only its own key.
        let off = p.patched(&PrefsPatch { host_api_read: Some(false), ..Default::default() });
        assert!(core_env_pairs(&off, None).contains(&("LLMIDE_HOST_API_READ", "0".to_string())));
        let only_push = Prefs { host_api_push: true, ..Prefs::default() };
        assert_eq!(without_host_api(core_env_pairs(&only_push, None)), vec![("LLMIDE_HOST_API_PUSH", "1".to_string())]);
        // A file without the keys (written before they existed) gets the defaults: listener and push off.
        let old: Prefs = serde_json::from_str(r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":true,"theme":"dark"}"#).unwrap();
        assert!(!old.host_api_tls && !old.host_api_push);
    }

    #[test]
    fn read_compose_and_tool_approvals_default_on_and_an_off_switch_is_honoured() {
        let d = Prefs::default();
        assert!(d.host_api_read && d.host_api_compose && d.host_api_tool_approvals);
        let on: Vec<_> = DEFAULT_ON_HOST_API.iter().map(|k| (*k, "1".to_string())).collect();
        assert_eq!(core_env_pairs(&d, None), on, "a paired phone works with no setup");
        // Each switch turned off reaches the core as an explicit 0 (the core enables only the exact value 1).
        let off = d.patched(&PrefsPatch { host_api_read: Some(false), host_api_compose: Some(false), host_api_tool_approvals: Some(false), ..Default::default() });
        let zero: Vec<_> = DEFAULT_ON_HOST_API.iter().map(|k| (*k, "0".to_string())).collect();
        assert_eq!(core_env_pairs(&off, None), zero);
        // The off switch survives a save and a reload.
        let dir = tmp("host-api-off");
        save_to(&dir, &off).unwrap();
        let back = load_from(&dir);
        assert!(!back.host_api_read && !back.host_api_compose && !back.host_api_tool_approvals);
        let _ = std::fs::remove_dir_all(&dir);
        // A file without the keys reads them as on; a stored false is kept once the file carries the migration marker.
        assert!(parse(r#"{"terminal":true}"#).host_api_read);
        let stored = parse(r#"{"hostApiRead":false,"hostApiCompose":true,"hostApiToolApprovals":false,"hostApiCapsMigrated":true}"#);
        assert!(!stored.host_api_read && stored.host_api_compose && !stored.host_api_tool_approvals);
    }

    #[test]
    fn remote_server_prefs_round_trip_normalize_and_never_require_a_restart() {
        let d = Prefs::default();
        assert_eq!(d.remote_server.mode, ServerMode::Local);
        assert_eq!(d.remote_server.port, 22);
        let patched = d.patched(&PrefsPatch {
            remote_server: Some(RemoteServerPrefs {
                mode: ServerMode::Remote,
                host: "  example.com  ".into(),
                port: 0,
                user: " alice ".into(),
                key_path: " /home/alice/.ssh/id_ed25519 ".into(),
                label: " prod ".into(),
                hub_url: " https://hub.example.com ".into(),
                tls_pin: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
                ssh_auth: SshAuthKind::Key,
                ssh_host_pin: String::new(),
                ..RemoteServerPrefs::default()
            }),
            ..Default::default()
        });
        assert_eq!(patched.remote_server.mode, ServerMode::Remote);
        assert_eq!(patched.remote_server.host, "example.com");
        assert_eq!(patched.remote_server.user, "alice");
        assert_eq!(patched.remote_server.key_path, "/home/alice/.ssh/id_ed25519");
        assert_eq!(patched.remote_server.label, "prod");
        assert_eq!(patched.remote_server.port, 22, "a zero port falls back to 22");
        assert!(!view(patched.clone(), true).restart_needed, "phase 1 stores the choice but does not act on it");
        let back = parse(&serde_json::to_string(&patched).unwrap());
        assert_eq!(back.remote_server, patched.remote_server);
        assert_eq!(parse(r#"{"ltaMode":"off"}"#).remote_server, RemoteServerPrefs::default(), "an older file is local");
    }

    #[test]
    fn a_prefs_file_keeps_the_saved_hub_url_and_pin_across_a_restart() {
        let file = r#"{"ltaMode":"off","remoteServer":{"mode":"remote","host":"ssh.example.com","port":22,"user":"deploy","keyPath":"/k","label":"prod","hubUrl":"https://hub.example.com","tlsPin":""}}"#;
        let loaded = parse(file);
        assert_eq!(loaded.remote_server.mode, ServerMode::Remote);
        assert_eq!(loaded.remote_server.hub_url, "https://hub.example.com");
        assert_eq!(loaded.remote_server.tls_pin, "", "public-CA trust keeps an empty pin");
        let pinned = parse(&file.replace(r#""tlsPin":"""#, r#""tlsPin":"sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA""#));
        assert_eq!(pinned.remote_server.tls_pin, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }

    #[test]
    fn a_webpki_hub_keeps_an_empty_pin_and_a_bad_url_is_cleared() {
        let empty = RemoteServerPrefs { hub_url: "https://hub.example.com".into(), tls_pin: String::new(), ..RemoteServerPrefs::default() }.normalized();
        assert_eq!(empty.hub_url, "https://hub.example.com");
        assert_eq!(empty.tls_pin, "", "public-CA trust needs no pin");
        let bad = RemoteServerPrefs { hub_url: "http://hub.example.com".into(), tls_pin: "sha256:short".into(), ..RemoteServerPrefs::default() }.normalized();
        assert_eq!(bad.hub_url, "");
        assert_eq!(bad.tls_pin, "");
        let local = RemoteServerPrefs { hub_url: "https://localhost:3457".into(), ..RemoteServerPrefs::default() }.normalized();
        if cfg!(debug_assertions) { assert_eq!(local.hub_url, "https://localhost:3457"); } else { assert_eq!(local.hub_url, ""); }
    }

    #[test]
    fn a_webview_patch_cannot_inject_a_hub_url_or_pin() {
        let mut base = Prefs::default();
        base.remote_server.hub_url = "https://hub.example.com".into();
        base.remote_server.tls_pin = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into();
        let patched = base.patched(&PrefsPatch {
            remote_server: Some(RemoteServerPrefs {
                mode: ServerMode::Remote, host: "evil.example.com".into(), port: 22, user: "u".into(), key_path: "/k".into(), label: String::new(),
                hub_url: "http://evil.example.com".into(),
                tls_pin: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".into(),
                ssh_auth: SshAuthKind::Key,
                ssh_host_pin: String::new(),
                ..RemoteServerPrefs::default()
            }),
            ..Default::default()
        });
        assert_eq!(patched.remote_server.hub_url, "https://hub.example.com");
        assert_eq!(patched.remote_server.tls_pin, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }

    #[test]
    fn a_webview_patch_cannot_write_the_ssh_pin() {
        let mut base = Prefs::default();
        base.remote_server.ssh_host_pin = "example.com:22 ssh-ed25519 AAAA".into();
        let patched = base.patched(&PrefsPatch {
            remote_server: Some(RemoteServerPrefs {
                mode: ServerMode::Ssh, host: "evil.example.com".into(), port: 22, user: "u".into(), key_path: "/k".into(),
                ssh_host_pin: "evil.example.com:22 ssh-ed25519 BBBB".into(),
                ..RemoteServerPrefs::default()
            }),
            ..Default::default()
        });
        assert_eq!(patched.remote_server.ssh_host_pin, "example.com:22 ssh-ed25519 AAAA");
    }

    /// A 4096-bit RSA pin is about 740 characters; it must survive a save and a load unchanged. The legacy field
    /// moves into the list on load, so the list holds it.
    #[test]
    fn a_long_rsa_pin_round_trips_through_the_file() {
        let d = tmp("pin-long");
        let pin = format!("example.com:22 ssh-rsa {}", (0..740).map(|i| char::from(b'A' + (i % 26) as u8)).collect::<String>());
        let p = Prefs { remote_server: RemoteServerPrefs { ssh_host_pin: pin.clone(), ..RemoteServerPrefs::default() }, ..Prefs::default() };
        save_to(&d, &p).unwrap();
        let back = load_from(&d);
        assert_eq!(back.remote_server.ssh_known_hosts, vec![pin], "a pin longer than 512 characters must not be cut");
        assert_eq!(back.remote_server.ssh_host_pin, "");
    }

    /// Over the cap the pin is cleared, never truncated: a cut pin could still decode and read as another key.
    #[test]
    fn an_over_cap_pin_loads_empty_not_truncated() {
        let d = tmp("pin-over");
        let pin = format!("example.com:22 ssh-rsa {}", "A".repeat(SSH_HOST_PIN_MAX));
        let p = Prefs { remote_server: RemoteServerPrefs { ssh_host_pin: pin, ..RemoteServerPrefs::default() }, ..Prefs::default() };
        save_to(&d, &p).unwrap();
        assert_eq!(load_from(&d).remote_server.ssh_host_pin, "");
    }

    #[test]
    fn upsert_ssh_known_host_refuses_an_over_cap_pin() {
        let _guard = prefs_guard();
        let before = stored().remote_server;
        let too_long = "A".repeat(SSH_HOST_PIN_MAX + 1);
        let err = upsert_ssh_known_host(format!("example.com:22 ssh-rsa {too_long}")).unwrap_err();
        assert_eq!(err.code, "invalid_host_key");
        assert_eq!(stored().remote_server.ssh_known_hosts, before.ssh_known_hosts, "a refused pin stores nothing");
    }

    #[test]
    fn an_old_file_has_no_ssh_pin() {
        let loaded = parse(r#"{"remoteServer":{"mode":"ssh","host":"example.com","port":22,"user":"alice","keyPath":"/k"}}"#);
        assert_eq!(loaded.remote_server.mode, ServerMode::Ssh);
        assert_eq!(loaded.remote_server.ssh_host_pin, "");
    }

    #[test]
    fn the_remote_block_has_no_field_for_key_contents() {
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"remoteServer":{"host":"x","keyContents":"secret"}}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"remoteServer":{"mode":"remote","keyPath":"/tmp/key"}}"#).is_ok());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"remoteServer":{"mode":"elsewhere"}}"#).is_err());
    }

    #[test]
    fn old_prefs_file_still_loads() {
        let loaded = parse(r#"{"ltaMode":"off","remoteServer":{"host":"example.com","port":22,"user":"alice","keyPath":"/k"}}"#);
        assert_eq!(loaded.remote_server.ssh_auth, SshAuthKind::Key);
        assert_eq!(loaded.remote_server.mode, ServerMode::Local);
    }

    #[test]
    fn ssh_mode_round_trips() {
        let d = tmp("ssh");
        let p = Prefs {
            remote_server: RemoteServerPrefs { mode: ServerMode::Ssh, ssh_auth: SshAuthKind::Password, host: "example.com".into(), user: "alice".into(), ..RemoteServerPrefs::default() },
            ..Prefs::default()
        };
        save_to(&d, &p).unwrap();
        let back = load_from(&d);
        assert_eq!(back.remote_server.mode, ServerMode::Ssh);
        assert_eq!(back.remote_server.ssh_auth, SshAuthKind::Password);
        assert_eq!(back, p);
    }

    #[test]
    fn set_remote_ssh_validates() {
        let _guard = prefs_guard();
        let before = stored().remote_server;
        let code = |r: Result<PrefsView, FsError>| r.unwrap_err().code;
        assert_eq!(code(set_remote_ssh("-x".into(), 22, "alice".into(), "/k".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_host");
        assert_eq!(code(set_remote_ssh("example.com".into(), 0, "alice".into(), "/k".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_port");
        assert_eq!(code(set_remote_ssh("example.com".into(), 22, "-l".into(), "/k".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_user");
        assert_eq!(code(set_remote_ssh("example.com".into(), 22, "alice".into(), "".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_key_path");
        // Password auth needs no key file, so an empty key path is saved as is.
        let saved = set_remote_ssh("example.com".into(), 22, "alice".into(), "  ".into(), SshAuthKind::Password, ServerMode::Ssh).unwrap();
        assert_eq!(saved.stored.remote_server.ssh_auth, SshAuthKind::Password);
        assert_eq!(saved.stored.remote_server.mode, ServerMode::Ssh);
        assert_eq!(saved.stored.remote_server.key_path, "");
        // The writer is global state; put back what this test found.
        let _ = apply(PrefsPatch { remote_server: Some(before), ..Default::default() });
    }

    #[test]
    fn no_password_field_exists() {
        let p = Prefs { remote_server: RemoteServerPrefs { ssh_auth: SshAuthKind::Password, ..RemoteServerPrefs::default() }, ..Prefs::default() };
        let value = serde_json::to_value(&p).unwrap();
        fn collect_keys(v: &serde_json::Value, keys: &mut Vec<String>) {
            match v {
                serde_json::Value::Object(map) => {
                    for (k, child) in map {
                        keys.push(k.clone());
                        collect_keys(child, keys);
                    }
                }
                serde_json::Value::Array(items) => items.iter().for_each(|child| collect_keys(child, keys)),
                _ => {}
            }
        }
        let mut keys = Vec::new();
        collect_keys(&value, &mut keys);
        let with_pass: Vec<&String> = keys.iter().filter(|k| k.to_lowercase().contains("pass")).collect();
        assert!(with_pass.is_empty(), "{with_pass:?}");
        assert_eq!(value["remoteServer"]["sshAuth"], "password");
    }

    #[test]
    fn continue_summary_reaches_the_core_as_exactly_on() {
        let p = Prefs { continue_summary: true, ..Prefs::default() };
        assert_eq!(without_host_api(core_env_pairs(&p, None)), vec![("LLMIDE_V2_CONTINUE_SUMMARY", "on".to_string())]);
        let off = p.patched(&PrefsPatch { continue_summary: Some(false), ..Default::default() });
        assert!(without_host_api(core_env_pairs(&off, None)).is_empty());
        let old: Prefs = serde_json::from_str(r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":true,"theme":"dark"}"#).unwrap();
        assert!(!old.continue_summary, "an older prefs file reads as off");
    }

    #[test]
    fn core_env_is_exactly_on_and_cap_compress_need_the_router() {
        let mut p = Prefs { router: true, cap: true, compress: true, learn: true, ..Prefs::default() };
        let v = without_host_api(core_env_pairs(&p, None));
        let names: Vec<&str> = v.iter().map(|(k, _)| *k).collect();
        assert_eq!(names, ["LLMIDE_ROUTER", "LLMIDE_ROUTER_CAP", "LLMIDE_ROUTER_COMPRESS", "LLMIDE_ROUTER_LEARN"]);
        assert!(v.iter().all(|(_, val)| val == "on"));
        p.router = false;
        let v = without_host_api(core_env_pairs(&p, None));
        assert_eq!(v.iter().map(|(k, _)| *k).collect::<Vec<_>>(), ["LLMIDE_ROUTER_LEARN"]);
    }

    #[test]
    fn patching_the_router_off_clears_cap_and_compress() {
        let on = Prefs::default().patched(&PrefsPatch { router: Some(true), cap: Some(true), compress: Some(true), ..Default::default() });
        assert!(on.cap && on.compress);
        let off = on.patched(&PrefsPatch { router: Some(false), ..Default::default() });
        assert!(!off.router && !off.cap && !off.compress);
        let stray = Prefs::default().patched(&PrefsPatch { cap: Some(true), ..Default::default() });
        assert!(!stray.cap, "cap alone cannot be stored while the router is off");
    }

    #[test]
    fn an_explicit_profile_is_normalized_ordered_and_always_keeps_chat() {
        let p = Prefs::default().patched(&PrefsPatch {
            features: Some(vec!["doc_gen".into(), "nope".into(), "agent_chat".into(), "file_explorer".into(), "doc_gen".into()]),
            ..Default::default()
        });
        assert_eq!(p.features, ["agent_chat", "file_explorer", "doc_gen"], "known keys only, canonical order, chat forced");
        assert!(!p.terminal, "an explicit profile without the terminal key turns the legacy flag off");
        let all = Prefs::default().patched(&PrefsPatch { features: Some(vec!["file_explorer".into()]), ..Default::default() });
        assert_eq!(all.features, ["agent_chat", "file_explorer"]);
        let empty = Prefs::default().patched(&PrefsPatch { features: Some(vec![]), ..Default::default() });
        assert!(empty.features.is_empty(), "an empty list stays 'inherit every feature'");
    }

    #[test]
    fn the_terminal_switch_and_the_profile_stay_in_step() {
        let with_terminal = Prefs::default().patched(&PrefsPatch {
            features: Some(vec!["agent_chat".into(), "file_explorer".into(), "terminal".into()]),
            ..Default::default()
        });
        assert!(with_terminal.terminal);
        let off = with_terminal.patched(&PrefsPatch { terminal: Some(false), ..Default::default() });
        assert!(!off.terminal);
        assert!(!off.features.iter().any(|k| k == "terminal"), "turning Terminal off removes it from the profile");
        let back = off.patched(&PrefsPatch { terminal: Some(true), ..Default::default() });
        assert!(back.features.iter().any(|k| k == "terminal"));
    }

    #[test]
    fn an_explicit_profile_sets_llmide_features_for_the_core() {
        let p = Prefs::default().patched(&PrefsPatch {
            features: Some(vec!["agent_chat".into(), "file_explorer".into(), "terminal".into()]),
            ..Default::default()
        });
        let v = without_host_api(core_env_pairs(&p, Some("agent_chat,doc_gen")));
        assert_eq!(v, vec![("LLMIDE_FEATURES", "agent_chat,file_explorer,terminal".to_string())]);
        // Terminal off removes it from the explicit profile too.
        let off = p.patched(&PrefsPatch { terminal: Some(false), ..Default::default() });
        assert_eq!(without_host_api(core_env_pairs(&off, None)), vec![("LLMIDE_FEATURES", "agent_chat,file_explorer".to_string())]);
        // The profile wins over the host's own value.
        let two = effective_features_with(None, true, &["agent_chat".into(), "auto_tasks".into()]).unwrap();
        assert_eq!(two, "agent_chat,auto_tasks");
    }

    #[test]
    fn a_legacy_file_without_features_keeps_its_terminal_setting() {
        let text = r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":false,"theme":"dark"}"#;
        let p = parse(text);
        assert!(!p.terminal);
        assert!(p.features.is_empty());
        assert_eq!(effective_features_with(None, p.terminal, &p.features).unwrap(), "agent_chat,file_explorer,code_graph_3d,gantt_issues,doc_gen,mobile_sync,auto_tasks");
    }

    #[test]
    fn terminal_off_lists_every_other_feature_and_never_empties() {
        assert_eq!(effective_features(None, true), None);
        assert_eq!(effective_features(Some(" "), true), None);
        let all = effective_features(None, false).unwrap();
        assert_eq!(all, "agent_chat,file_explorer,code_graph_3d,gantt_issues,doc_gen,mobile_sync,auto_tasks");
        assert_eq!(effective_features(Some("agent_chat, terminal,file_explorer"), false).unwrap(), "agent_chat,file_explorer");
        assert_eq!(effective_features(Some("terminal"), false).unwrap(), "agent_chat");
        assert_eq!(effective_features(Some("agent_chat,terminal"), true).unwrap(), "agent_chat,terminal");
        let v = without_host_api(core_env_pairs(&Prefs { terminal: false, ..Prefs::default() }, Some("agent_chat,terminal")));
        assert_eq!(v, vec![("LLMIDE_FEATURES", "agent_chat".to_string())]);
    }

    #[test]
    fn feature_keys_match_the_servers_list() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../extension/core/config.mjs")).unwrap();
        let start = src.find("export const FEATURE_KEYS").unwrap();
        let block = &src[start..start + src[start..].find(']').unwrap()];
        let found: Vec<&str> = block.split('\'').skip(1).step_by(2).collect();
        assert_eq!(found, FEATURE_KEYS, "update prefs.rs FEATURE_KEYS to match config.mjs");
    }

    #[test]
    fn an_old_file_without_the_marker_gets_the_three_capabilities_once() {
        let d = tmp("caps-old");
        let old = r#"{"hostApiRead":false,"hostApiCompose":false,"hostApiToolApprovals":false,"hostApiPush":false}"#;
        std::fs::write(d.join(FILE_NAME), old).unwrap();
        let p = load_from(&d);
        assert!(p.host_api_read && p.host_api_compose && p.host_api_tool_approvals && p.host_api_caps_migrated);
        assert!(!p.host_api_push, "push is not part of the migration");
        assert!(std::fs::read_to_string(d.join(FILE_NAME)).unwrap().contains("hostApiCapsMigrated\": true"), "persisted");
        // After the marker a later explicit off is honoured and survives a reload.
        let off = Prefs { host_api_read: false, ..p };
        save_to(&d, &off).unwrap();
        assert!(!load_from(&d).host_api_read);
    }

    #[test]
    fn a_marked_file_is_untouched_and_a_fresh_install_has_the_marker() {
        let marked = parse(r#"{"hostApiRead":false,"hostApiCompose":false,"hostApiToolApprovals":false,"hostApiCapsMigrated":true}"#);
        assert!(!marked.host_api_read && !marked.host_api_compose && !marked.host_api_tool_approvals);
        let d = tmp("caps-fresh");
        let fresh = load_from(&d);
        assert!(fresh.host_api_read && fresh.host_api_caps_migrated);
        assert!(!d.join(FILE_NAME).exists(), "a missing file is not written by load");
        let bad = tmp("caps-bad");
        std::fs::write(bad.join(FILE_NAME), r#"{"router":true,"nope":1}"#).unwrap();
        let loaded = load_from(&bad);
        assert!(loaded.router, "an unknown key no longer resets the known ones");
        assert!(std::fs::read_to_string(bad.join(FILE_NAME)).unwrap().contains("router"), "the file is only rewritten by the one-time migration");
    }

    #[test]
    fn the_webview_cannot_set_the_backend_paths() {
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendNode":"/bin/sh"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendDir":"/tmp"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendSource":true}"#).is_ok());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendPort":3458}"#).is_ok());
    }

    #[test]
    fn strict_schema_refuses_unknown_keys_and_bad_values() {
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"router":true}"#).is_ok());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"routerr":true}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"ltaMode":"always"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"theme":"neon"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"router":"on"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"__proto__":1}"#).is_err());
    }

    #[test]
    fn a_hand_edited_file_never_widens_anything() {
        assert_eq!(parse("not json"), Prefs::default());
        assert!(parse(r#"{"router":true,"extra":1}"#).router, "an unknown key is ignored, the known ones survive");
        assert_eq!(parse(r#"{"cap":true}"#), Prefs::default(), "cap without router is normalised away");
        assert_eq!(parse(&"x".repeat(MAX_BYTES + 1)), Prefs::default());
        let p = parse(r#"{"router":true,"cap":true,"ltaMode":"shadow","terminal":false,"theme":"light"}"#);
        assert!(p.router && p.cap && !p.terminal);
        assert_eq!((p.lta_mode, p.theme), (LtaMode::Shadow, Theme::Light));
    }

    #[test]
    fn saves_atomically_private_and_round_trips() {
        let d = tmp("rt");
        let p = Prefs { router: true, learn: true, lta_mode: LtaMode::On, ..Prefs::default() };
        save_to(&d, &p).unwrap();
        assert_eq!(load_from(&d), p);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(FILE_NAME)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(!d.join("prefs.tmp").exists());
        std::fs::write(d.join(FILE_NAME), vec![b' '; MAX_BYTES + 10]).unwrap();
        assert_eq!(load_from(&d), Prefs::default(), "an oversized file is ignored");
    }

    #[test]
    fn restart_needed_compares_with_the_launch_snapshot_and_ignores_theme() {
        // LAUNCH is the defaults in unit tests.
        let same = view(Prefs { theme: Theme::Light, ..Prefs::default() }, true);
        assert!(!same.restart_needed, "theme applies at once");
        let graph = view(Prefs { graph_auto_update_minutes: 15, ..Prefs::default() }, true);
        assert!(!graph.restart_needed, "the timer reads stored() live");
        let diff = view(Prefs { learn: true, ..Prefs::default() }, true);
        assert!(diff.restart_needed);
    }

    #[test]
    fn enabling_the_lan_listener_needs_a_native_yes_only_on_the_off_to_on_change() {
        assert_eq!(gate_host_api_tls(false, Some(true), || false).unwrap_err().code, "cancelled");
        assert!(gate_host_api_tls(false, Some(true), || true).is_ok());
        assert!(gate_host_api_tls(true, Some(true), || panic!("already on")).is_ok());
        assert!(gate_host_api_tls(true, Some(false), || panic!("turning off")).is_ok());
        assert!(gate_host_api_tls(false, None, || panic!("untouched")).is_ok());
    }

    #[test]
    fn set_prefs_without_a_data_dir_keeps_the_change_for_the_session() {
        let _guard = prefs_guard();
        let v = apply(PrefsPatch { learn: Some(true), ..Default::default() }).unwrap();
        assert!(v.stored.learn && v.restart_needed);
        let _ = apply(PrefsPatch { learn: Some(false), ..Default::default() });
    }

    #[test]
    fn the_terminal_gate_needs_both_the_env_and_the_pref() {
        // `terminal_enabled` reads the launch snapshot (defaults in unit tests: terminal on); the pure part is `effective_features`.
        let on = |env: Option<&str>, pref: bool| crate::pty::feature_enabled(effective_features(env, pref).as_deref(), "terminal");
        assert!(on(None, true));
        assert!(!on(None, false), "the pref turns it off with no env");
        assert!(!on(Some("agent_chat,file_explorer"), true), "the env without terminal keeps it off");
        assert!(!on(Some("agent_chat,terminal"), false), "the pref wins over the env");
        assert!(on(Some("agent_chat,terminal"), true));
        assert!(terminal_enabled(None), "default launch: on");
    }

    #[test]
    fn a_newer_file_with_unknown_keys_keeps_every_known_preference() {
        let d = tmp("newer-file");
        let text = r#"{"router":true,"theme":"light","backendPort":3999,"futureKey":{"a":1},
            "remoteServer":{"hubUrl":"https://hub.example.com:8443","futureNested":1},"notifications":{"tasks":false,"later":true}}"#;
        std::fs::write(d.join(FILE_NAME), text).unwrap();
        let p = load_from(&d);
        assert!(p.router && p.theme == Theme::Light && p.backend_port == 3999);
        assert!(!p.notifications.tasks);
        assert_eq!(p.remote_server.hub_url, "https://hub.example.com:8443");
        assert!(!d.read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("unreadable")));
    }

    #[test]
    fn an_unparseable_file_is_copied_aside_before_defaults_can_overwrite_it() {
        let d = tmp("unreadable");
        let text = r#"{"router":"yes please"}"#;
        std::fs::write(d.join(FILE_NAME), text).unwrap();
        assert_eq!(load_from(&d), Prefs::default());
        let aside: Vec<_> = d.read_dir().unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("prefs.json.unreadable-")).collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), text);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(aside[0].path()).unwrap().permissions().mode() & 0o777, 0o600);
        }
        apply_to_dir_for_test(&d);
        assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), text, "a later save leaves the copy alone");
    }

    fn apply_to_dir_for_test(dir: &Path) {
        save_to(dir, &Prefs::default()).unwrap();
    }
}

#[cfg(test)]
mod loop_default_tests {
    use super::*;

    #[test]
    fn loop_defaults_round_trip_and_clamp_the_policy() {
        let d = LoopDefaults {
            max_iterations: 4, consecutive_failure_stop: 1, wall_clock_minutes: 15,
            max_repairs_per_stage: 0, pause_timeout_minutes: 0,
            protected_path_policy: "bogus".to_string(), write_summary_note: true,
        };
        let p = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(d), ..Default::default() });
        assert_eq!(p.loop_defaults.max_iterations, 4);
        assert_eq!(p.loop_defaults.protected_path_policy, "revert");
        assert!(p.loop_defaults.write_summary_note);
        let back = parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back.loop_defaults, p.loop_defaults);
    }

    #[test]
    fn loop_defaults_clamp_every_bound() {
        let d = LoopDefaults {
            max_iterations: 0, consecutive_failure_stop: 99, wall_clock_minutes: 99_999,
            max_repairs_per_stage: 999, pause_timeout_minutes: 999,
            protected_path_policy: "off".to_string(), write_summary_note: false,
        };
        let p = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(d), ..Default::default() });
        assert_eq!(p.loop_defaults.max_iterations, 1);
        assert_eq!(p.loop_defaults.consecutive_failure_stop, 20);
        assert_eq!(p.loop_defaults.wall_clock_minutes, 1440);
        assert_eq!(p.loop_defaults.max_repairs_per_stage, 20);
        assert_eq!(p.loop_defaults.pause_timeout_minutes, 240);
        assert_eq!(p.loop_defaults.protected_path_policy, "off");
        let high = LoopDefaults { max_iterations: 500, consecutive_failure_stop: 0, ..LoopDefaults::default() };
        let q = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(high), ..Default::default() });
        assert_eq!(q.loop_defaults.max_iterations, 100);
        assert_eq!(q.loop_defaults.consecutive_failure_stop, 1);
    }

    #[test]
    fn update_checks_default_on_patchable_and_never_need_a_restart() {
        assert!(Prefs::default().update_checks);
        let off = Prefs::default().patched(&PrefsPatch { update_checks: Some(false), ..Default::default() });
        assert!(!off.update_checks);
        assert!(!parse(&serde_json::to_string(&off).unwrap()).update_checks);
        // An old file without the key keeps the default.
        assert!(parse(r#"{"ltaMode":"off"}"#).update_checks);
    }

    #[test]
    fn graph_auto_update_is_off_or_between_five_and_a_day() {
        let mut p = Prefs::default();
        assert_eq!(p.graph_auto_update_minutes, 0);
        p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(1), ..Default::default() });
        assert_eq!(p.graph_auto_update_minutes, 5);
        p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(99_999), ..Default::default() });
        assert_eq!(p.graph_auto_update_minutes, 1440);
        p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(0), ..Default::default() });
        assert_eq!(p.graph_auto_update_minutes, 0);
        let back = parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back.graph_auto_update_minutes, 0);
    }

    #[test]
    fn notification_switches_default_on_patch_whole_and_never_need_a_restart() {
        assert_eq!(Prefs::default().notifications, NotifyPrefs::default());
        let d = NotifyPrefs::default(); assert!(d.approvals && d.tasks && d.sync && d.updates && d.core);
        let off = NotifyPrefs { tasks: false, ..NotifyPrefs::default() };
        let p = Prefs::default().patched(&PrefsPatch { notifications: Some(off), ..Default::default() });
        assert_eq!(p.notifications, off);
        assert_eq!(parse(&serde_json::to_string(&p).unwrap()).notifications, off);
        assert!(parse(r#"{"ltaMode":"off"}"#).notifications.approvals, "an old file keeps the defaults");
        assert!(!parse(r#"{"notifications":{"approvals":false,"evil":true}}"#).notifications.approvals, "a nested unknown key is ignored too");
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"notifications":{"approvals":false,"evil":true}}"#).is_err(), "the webview patch stays strict");
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"notifications":{"approvals":"no"}}"#).is_err());
        assert!(!view(Prefs { notifications: off, ..Prefs::default() }, true).restart_needed, "applies at once");
    }
}

#[cfg(test)]
mod ssh_lists_tests {
    use super::*;
    use base64::Engine as _;

    fn b64(seed: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(seed.as_bytes())
    }

    /// The canonical saved pin for a host, port and seed.
    fn pin(host: &str, port: u16, seed: &str) -> String {
        format!("{host}:{port} ssh-ed25519 {}", b64(seed))
    }

    /// Clears the stored SSH block and holds the preferences lock for the whole test.
    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let guard = prefs_guard();
        set_remote_server_for_test(RemoteServerPrefs::default());
        guard
    }

    fn stored_block() -> RemoteServerPrefs {
        stored().remote_server
    }

    /// Switches SSH mode to a server with key auth, the same write a successful connect makes.
    fn switch_to(host: &str, port: u16, user: &str) {
        set_remote_ssh(host.into(), port, user.into(), "/home/u/.ssh/id".into(), SshAuthKind::Key, ServerMode::Ssh).unwrap();
    }

    fn recent(host: &str, user: &str) -> SshRecentServer {
        SshRecentServer { host: host.into(), port: 22, user: user.into(), key_path: String::new(), auth: SshAuthKind::Password, last_used: 5 }
    }

    #[test]
    fn old_single_pin_migrates_into_the_list() {
        let legacy = format!("Example.com:22 ssh-ed25519 {}", b64("key-a"));
        let file = format!(r#"{{"remoteServer":{{"mode":"ssh","host":"example.com","port":22,"user":"alice","keyPath":"/k","sshHostPin":"{legacy}"}}}}"#);
        let loaded = parse(&file);
        assert_eq!(loaded.remote_server.ssh_known_hosts, vec![pin("example.com", 22, "key-a")]);
        assert_eq!(loaded.remote_server.ssh_host_pin, "", "the legacy field is cleared on load");
    }

    #[test]
    fn the_migrated_pin_replaces_a_listed_pin_for_the_same_endpoint() {
        let legacy = format!("example.com:22 ssh-ed25519 {}", b64("new"));
        let file = format!(r#"{{"remoteServer":{{"sshKnownHosts":["{}"],"sshHostPin":"{legacy}"}}}}"#, pin("example.com", 22, "old"));
        let loaded = parse(&file);
        assert_eq!(loaded.remote_server.ssh_known_hosts, vec![legacy], "one pin per host and port, the migrated one wins");
    }

    #[test]
    fn one_pin_per_host_and_port() {
        let _guard = fresh();
        upsert_ssh_known_host(format!("EXAMPLE.com:22 ssh-ed25519 {}", b64("key-a"))).unwrap();
        upsert_ssh_known_host(pin("example.com", 22, "key-b")).unwrap();
        upsert_ssh_known_host(pin("example.com", 2222, "key-a")).unwrap();
        assert_eq!(stored_block().ssh_known_hosts, vec![pin("example.com", 22, "key-b"), pin("example.com", 2222, "key-a")]);
    }

    #[test]
    fn the_list_holds_at_most_32_pins_and_drops_the_oldest() {
        let _guard = fresh();
        for port in 1..=(SSH_KNOWN_HOSTS_MAX as u16 + 1) {
            upsert_ssh_known_host(pin("example.com", port, "key-a")).unwrap();
        }
        let list = stored_block().ssh_known_hosts;
        assert_eq!(list.len(), SSH_KNOWN_HOSTS_MAX);
        assert!(!list.iter().any(|entry| entry.starts_with("example.com:1 ")), "the oldest pin is the one dropped");
        assert!(list.last().unwrap().starts_with("example.com:33 "));
    }

    #[test]
    fn an_invalid_pin_is_refused_on_write() {
        let _guard = fresh();
        assert_eq!(upsert_ssh_known_host("nonsense".into()).unwrap_err().code, "invalid_host_key");
        assert_eq!(upsert_ssh_known_host(pin("example.com", 0, "key-a")).unwrap_err().code, "invalid_host_key");
        assert_eq!(upsert_ssh_known_host("example.com:22 ssh-ed25519 !!!".into()).unwrap_err().code, "invalid_host_key");
        assert!(stored_block().ssh_known_hosts.is_empty());
    }

    #[test]
    fn an_invalid_or_oversized_list_entry_is_dropped_on_load_never_cut() {
        let good = pin("example.com", 22, "key-a");
        let over = format!("example.com:2222 ssh-rsa {}", "A".repeat(SSH_HOST_PIN_MAX));
        let file = serde_json::json!({ "remoteServer": { "sshKnownHosts": [
            good, "not a pin", over, "example.com:0 ssh-ed25519 AAAA", "example.com:3333 ssh-ed25519 !!!", "example.com:4444 bogus AAAA",
        ] } })
        .to_string();
        assert_eq!(parse(&file).remote_server.ssh_known_hosts, vec![good]);
    }

    #[test]
    fn recent_servers_are_capped_ordered_and_keyed_without_case() {
        let _guard = fresh();
        for i in 0..12 {
            switch_to(&format!("host{i}.example.com"), 22, "alice");
        }
        let recent_list = stored_block().ssh_recent_servers;
        assert_eq!(recent_list.len(), SSH_RECENT_SERVERS_MAX);
        assert_eq!(recent_list[0].host, "host11.example.com");
        assert_eq!(recent_list[9].host, "host2.example.com");
        assert!(recent_list.iter().all(|server| server.last_used > 0));

        // The same server typed in capitals moves to the front and is not a second entry.
        switch_to("HOST5.example.com", 22, "alice");
        let recent_list = stored_block().ssh_recent_servers;
        assert_eq!(recent_list.len(), SSH_RECENT_SERVERS_MAX);
        assert_eq!(recent_list[0].host, "host5.example.com");
        assert_eq!(recent_list.iter().filter(|server| server.host == "host5.example.com").count(), 1);

        // Another user on the same host is another server, and the oldest one is pushed out.
        switch_to("host5.example.com", 22, "bob");
        let recent_list = stored_block().ssh_recent_servers;
        assert_eq!(recent_list.len(), SSH_RECENT_SERVERS_MAX);
        assert_eq!(recent_list[0].user, "bob");
        assert_eq!(recent_list.iter().filter(|server| server.host == "host5.example.com").count(), 2);
    }

    #[test]
    fn a_recent_server_has_the_wire_fields_and_no_secret() {
        let value = serde_json::to_value(SshRecentServer {
            host: "example.com".into(), port: 22, user: "alice".into(), key_path: "/k".into(), auth: SshAuthKind::Password, last_used: 7,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({ "host": "example.com", "port": 22, "user": "alice", "keyPath": "/k", "auth": "password", "lastUsed": 7 }));
    }

    #[test]
    fn folders_are_capped_per_server_and_their_paths_checked() {
        let _guard = fresh();
        switch_to("example.com", 22, "alice");
        switch_to("other.example", 22, "alice");
        let first = "alice@example.com:22";
        let second = "alice@other.example:22";
        for i in 0..12 {
            record_ssh_recent_folder(first, &format!("/home/alice/p{i}")).unwrap();
        }
        let paths = ssh_recent_folders(first);
        assert_eq!(paths.len(), SSH_RECENT_FOLDERS_MAX);
        assert_eq!(paths[0], "/home/alice/p11");
        assert_eq!(paths[9], "/home/alice/p2");
        record_ssh_recent_folder(second, "/srv/app").unwrap();
        assert_eq!(ssh_recent_folders(first).len(), SSH_RECENT_FOLDERS_MAX, "another server's folder does not push these out");
        assert_eq!(ssh_recent_folders(second), vec!["/srv/app".to_string()]);

        for bad in ["relative/path", "", "/a\nb", "/a\rb", "/a\0b"] {
            assert_eq!(record_ssh_recent_folder(first, bad).unwrap_err().code, "invalid_path", "{bad:?}");
        }
        let too_long = format!("/{}", "x".repeat(SSH_FOLDER_PATH_MAX));
        assert_eq!(record_ssh_recent_folder(first, &too_long).unwrap_err().code, "invalid_path");
        let longest = format!("/{}", "x".repeat(SSH_FOLDER_PATH_MAX - 1));
        record_ssh_recent_folder(first, &longest).unwrap();
        assert_eq!(ssh_recent_folders(first)[0], longest);
        forget_ssh_recent_folder(first, &longest).unwrap();
        assert!(!ssh_recent_folders(first).contains(&longest), "a forgotten folder is gone");
        assert_eq!(record_ssh_recent_folder("carol@example.com:22", "/x").unwrap_err().code, "unknown_server");
    }

    #[test]
    fn a_server_pushed_out_of_the_recent_list_takes_its_folders() {
        let _guard = fresh();
        switch_to("example.com", 22, "alice");
        record_ssh_recent_folder("alice@example.com:22", "/home/alice/a").unwrap();
        for i in 0..SSH_RECENT_SERVERS_MAX {
            switch_to(&format!("h{i}.example.com"), 22, "alice");
        }
        assert!(ssh_recent_folders("alice@example.com:22").is_empty());
        assert!(stored_block().ssh_recent_folders.is_empty());
    }

    #[test]
    fn forget_keeps_the_pin_while_another_saved_server_uses_it() {
        let _guard = fresh();
        upsert_ssh_known_host(pin("example.com", 22, "key-a")).unwrap();
        switch_to("example.com", 22, "alice");
        switch_to("example.com", 22, "bob");
        record_ssh_recent_folder("alice@example.com:22", "/home/alice/a").unwrap();
        record_ssh_recent_folder("bob@example.com:22", "/home/bob/b").unwrap();

        forget_ssh_server("example.com", 22, "alice").unwrap();
        let block = stored_block();
        assert_eq!(block.ssh_recent_servers.iter().map(|s| s.user.as_str()).collect::<Vec<_>>(), ["bob"]);
        assert!(ssh_recent_folders("alice@example.com:22").is_empty());
        assert_eq!(ssh_recent_folders("bob@example.com:22"), ["/home/bob/b"], "another user's folders stay");
        assert_eq!(block.ssh_known_hosts, vec![pin("example.com", 22, "key-a")], "bob still needs the same host key");
    }

    #[test]
    fn forget_removes_the_pin_and_folders_once_no_saved_server_uses_them() {
        let _guard = fresh();
        upsert_ssh_known_host(pin("example.com", 22, "key-a")).unwrap();
        upsert_ssh_known_host(pin("other.example", 22, "key-b")).unwrap();
        switch_to("example.com", 22, "bob");
        record_ssh_recent_folder("bob@example.com:22", "/home/bob/b").unwrap();
        switch_to("elsewhere.example", 22, "carol");

        forget_ssh_server("example.com", 22, "bob").unwrap();
        let block = stored_block();
        assert_eq!(block.ssh_known_hosts, vec![pin("other.example", 22, "key-b")], "only the unused endpoint's key goes");
        assert!(ssh_recent_folders("bob@example.com:22").is_empty());
        assert_eq!((block.host.as_str(), block.user.as_str()), ("elsewhere.example", "carol"), "the switch is not touched");
    }

    #[test]
    fn forgetting_the_switched_to_server_leaves_the_switch_and_its_key() {
        let _guard = fresh();
        upsert_ssh_known_host(pin("example.com", 22, "key-a")).unwrap();
        switch_to("example.com", 22, "bob");
        forget_ssh_server("example.com", 22, "bob").unwrap();
        let block = stored_block();
        assert_eq!((block.mode, block.host.as_str(), block.user.as_str()), (ServerMode::Ssh, "example.com", "bob"));
        assert!(block.ssh_recent_servers.is_empty());
        assert_eq!(block.ssh_known_hosts, vec![pin("example.com", 22, "key-a")], "the switched-to server still needs its key");
        forget_ssh_server("never.example", 22, "dave").unwrap();
    }

    #[test]
    fn a_webview_patch_cannot_touch_the_three_lists() {
        let mut base = Prefs::default();
        base.remote_server.ssh_known_hosts = vec![pin("example.com", 22, "key-a")];
        base.remote_server.ssh_recent_servers = vec![recent("example.com", "alice")];
        base.remote_server.ssh_recent_folders = vec![SshRecentFolder { server: "alice@example.com:22".into(), path: "/home/alice".into(), last_used: 1 }];
        let patched = base.patched(&PrefsPatch {
            remote_server: Some(RemoteServerPrefs {
                mode: ServerMode::Ssh,
                host: "evil.example.com".into(),
                port: 22,
                user: "u".into(),
                key_path: "/k".into(),
                ssh_known_hosts: vec![pin("evil.example.com", 22, "key-b")],
                ssh_recent_servers: Vec::new(),
                ssh_recent_folders: vec![SshRecentFolder { server: "u@evil.example.com:22".into(), path: "/".into(), last_used: 9 }],
                ..RemoteServerPrefs::default()
            }),
            ..Default::default()
        });
        assert_eq!(patched.remote_server.ssh_known_hosts, base.remote_server.ssh_known_hosts);
        assert_eq!(patched.remote_server.ssh_recent_servers, base.remote_server.ssh_recent_servers);
        assert_eq!(patched.remote_server.ssh_recent_folders, base.remote_server.ssh_recent_folders);
    }

    #[test]
    fn a_full_set_of_lists_is_saved_and_loaded_whole() {
        let _guard = fresh();
        for i in 0..32u16 {
            upsert_ssh_known_host(pin(&format!("h{i}.example.com"), 22, "key-a")).unwrap();
        }
        for i in 0..SSH_RECENT_SERVERS_MAX {
            switch_to(&format!("h{i}.example.com"), 22, "alice");
        }
        for i in 0..SSH_RECENT_SERVERS_MAX {
            let server = format!("alice@h{i}.example.com:22");
            for j in 0..SSH_RECENT_FOLDERS_MAX {
                record_ssh_recent_folder(&server, &format!("/{j:04}{}", "x".repeat(SSH_FOLDER_PATH_MAX - 5))).unwrap();
            }
        }
        let dir = std::env::temp_dir().join(format!("llmide-ssh-lists-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let before = stored().remote_server;
        save_to(&dir, &stored()).unwrap();
        let size = std::fs::metadata(dir.join(FILE_NAME)).unwrap().len();
        let loaded = load_from(&dir).remote_server;
        let _ = std::fs::remove_dir_all(&dir);
        assert!(size > 16 * 1024, "the worst case is larger than the old 16 KB bound");
        assert_eq!(loaded, before, "nothing is dropped at the caps");
    }

    /// The byte caps at their worst: 4-byte characters fill every folder path to the byte cap, and `"` (the
    /// most-escaping allowed character) fills the others, so the file is as large as the caps allow.
    #[test]
    fn a_worst_case_of_non_ascii_and_escaped_text_is_saved_whole() {
        let _guard = fresh();
        let label = "a".repeat(63);
        for i in 0..32u16 {
            // A full-length pin: 2048 bytes of ASCII base64 on one line, the longest the cap admits.
            let head = format!("h{i}.example.com:22 ssh-ed25519 ");
            let blob = "A".repeat((SSH_HOST_PIN_MAX - head.len()) / 4 * 4);
            upsert_ssh_known_host(format!("{head}{blob}")).unwrap();
        }
        for i in 0..SSH_RECENT_SERVERS_MAX {
            // A 253-byte host and a 64-byte user, the longest the validators admit.
            let host = format!("{label}.{label}.{label}.{i:02}{}", "z".repeat(59));
            // A key path of `"` fills the 4096-byte cap; each `"` is escaped to two bytes in the file.
            set_remote_ssh(host.clone(), 22, "a".repeat(64), format!("/{}", "\"".repeat(4095)), SshAuthKind::Key, ServerMode::Ssh).unwrap();
            let server = format!("{}@{host}:22", "a".repeat(64));
            for j in 0..SSH_RECENT_FOLDERS_MAX {
                // Even folders: 4-byte characters (1 + 1023 * 4 + 1 + 2 digits = 4096 bytes). Odd: `"` (4096 bytes).
                let path = if j % 2 == 0 {
                    format!("/{j:02}{}x", "\u{1F600}".repeat(1023))
                } else {
                    format!("/{j:02}{}", "\"".repeat(4093))
                };
                assert_eq!(path.len(), SSH_FOLDER_PATH_MAX, "the test fills the byte cap");
                record_ssh_recent_folder(&server, &path).unwrap();
            }
        }
        // 1024 four-byte characters are 4097 bytes but only 1024 characters: the cap counts bytes.
        let server = format!("{}@{}:22", "a".repeat(64), format!("{label}.{label}.{label}.00{}", "z".repeat(59)));
        assert_eq!(record_ssh_recent_folder(&server, &format!("/{}", "\u{1F600}".repeat(1024))).unwrap_err().code, "invalid_path");
        let dir = std::env::temp_dir().join(format!("llmide-ssh-worst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let before = stored().remote_server;
        save_to(&dir, &stored()).unwrap();
        let size = std::fs::metadata(dir.join(FILE_NAME)).unwrap().len() as usize;
        let loaded = load_from(&dir).remote_server;
        let _ = std::fs::remove_dir_all(&dir);
        assert!(size > 512 * 1024 && size <= MAX_BYTES, "a worst-case file fits the cap: {size} bytes");
        assert_eq!(loaded, before, "nothing is dropped at the byte caps");
    }
}
