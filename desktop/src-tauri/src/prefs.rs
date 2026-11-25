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
        self.max_iterations = self.max_iterations.clamp(1, 3);
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
            max_iterations: 3,
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
    /// Host-owned, default OFF: `bypass_confirm_signed` signs without its dialog. Never in `PrefsPatch`, so only
    /// `confirm::bypass_skip_confirm_set` (which shows its own dialog to turn it on) can write it. Applies at once.
    pub bypass_skip_confirm: bool,
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
            bypass_skip_confirm: false,
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
        // Not patchable from the webview, so a read from the file must carry it over explicitly.
        out.bypass_skip_confirm = p.bypass_skip_confirm;
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

/// The mode this launch runs in, for the host to act on. SSH is per session: a launch in SSH mode runs in SSH, and
/// the saved mode goes back to `Local` at once, so the next start (also one after a crash) opens the local Welcome.
/// Call once, after `init`. Hub (`Remote`) and local launches change nothing.
pub fn take_launch_mode() -> ServerMode {
    end_ssh_session_at_launch(launch().remote_server.mode)
}

/// Saves `Local` as the start mode when `mode` is SSH, and returns `mode`. Only the mode field is written, so the
/// saved server (host, port, user, key path, pins, recents) stays as it was. A failed save is logged and does not
/// stop this session: it still runs in SSH, and the next start may come back to SSH.
fn end_ssh_session_at_launch(mode: ServerMode) -> ServerMode {
    if mode == ServerMode::Ssh {
        if let Err(e) = set_remote_server_mode(ServerMode::Local) {
            eprintln!("prefs: could not save the local start mode after an SSH session ({}); the next start may open SSH", e.code);
        }
    }
    mode
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
    let restart_needed = Prefs { theme: launch.theme, loop_defaults: launch.loop_defaults.clone(), graph_auto_update_minutes: launch.graph_auto_update_minutes, update_checks: launch.update_checks, notifications: launch.notifications, bypass_skip_confirm: launch.bypass_skip_confirm, remote_server: launch.remote_server.clone(), ..stored.clone() } != launch;
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

/// True while the host-owned "don't ask before Bypass" pref is on (default false).
pub(crate) fn bypass_skip_confirm() -> bool {
    stored().bypass_skip_confirm
}

/// Host-side writer for `bypass_skip_confirm` only. Not reachable from `set_prefs` (`PrefsPatch` has no such field);
/// its one caller is `confirm::bypass_skip_confirm_set`, which has already shown the dialog when turning it on.
pub(crate) fn set_bypass_skip_confirm(value: bool) -> Result<PrefsView, FsError> {
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let mut next = st.stored.clone();
    next.bypass_skip_confirm = value;
    if let Some(dir) = &st.dir { save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?; }
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
#[path = "prefs_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "prefs_loop_default_tests.rs"]
mod loop_default_tests;

#[cfg(test)]
#[path = "prefs_ssh_lists_tests.rs"]
mod ssh_lists_tests;
