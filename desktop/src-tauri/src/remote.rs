//! Phase 1 of remote server support: validate an SSH target and test it with the system `ssh`.
//!
//! What this module deliberately does NOT do yet: copy/install anything on the remote host, start a
//! service, or change where the desktop's core runs. Phase 2 adds deploy; until then "Remote server"
//! is a stored choice plus a connection check.
//!
//! Security rules:
//! - the target is validated before a child process exists: hostnames/IPs, user names and private-key
//!   paths have strict shapes and none may start with `-` (so a value cannot become an ssh option);
//! - the ssh command is built as an argv array with no shell (`Command::new("ssh")` + `.args`), remote
//!   command included as one fixed literal — nothing from the webview is interpolated into a shell;
//! - key files only, never passwords: `BatchMode=yes` and `IdentitiesOnly=yes` stop prompts and agent
//!   keys; `StrictHostKeyChecking=accept-new` learns a new host key but refuses one that changed;
//! - only the key PATH is handled. The file is checked for existence/regular-file shape, never read,
//!   and neither its contents nor the ssh argv/stderr are logged.
//!
//! R-034 #7: a test only REPORTS the host key. Deploy, update and uninstall refuse until the user has
//! confirmed that fingerprint for this app session; they then connect with `StrictHostKeyChecking=yes`
//! and a temporary known_hosts holding only that key (never the user's ~/.ssh/known_hosts).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::confirm::herr;
use crate::fs_ops::FsError;

pub const DEFAULT_SSH_PORT: u16 = 22;
pub const CONNECT_TIMEOUT_SECS: u32 = 10;
pub const MAX_HOST_LEN: usize = 253;
pub const MAX_USER_LEN: usize = 64;
pub const MAX_KEY_PATH_LEN: usize = 4096;
const MAX_ERROR_CHARS: usize = 400;
const MAX_REMOTE_CHARS: usize = 300;

/// The webview's connection fields. `port` defaults to 22 so an older page that omits it still works.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshTarget {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub key_path: String,
}

fn default_port() -> u16 {
    DEFAULT_SSH_PORT
}

/// What a successful test reports. `fingerprint` is the host key OpenSSH printed during the handshake;
/// the UI shows it so the user can compare it with what the server operator published.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub host_key_type: String,
    pub fingerprint: String,
    pub uname: String,
    pub node: bool,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
}

/// Raw child output, kept platform independent so the runner (and its fake) has no `ExitStatus`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// The host key the user confirmed in THIS app session (R-034 #7). Keyed by `host:port`; never written
/// to disk. A new app session starts empty, so a deploy after a restart needs a fresh Test + confirm.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedHostKey {
    pub key_type: String,
    pub fingerprint: String,
}

fn confirmations() -> &'static Mutex<HashMap<String, ConfirmedHostKey>> {
    static CONFIRMED: OnceLock<Mutex<HashMap<String, ConfirmedHostKey>>> = OnceLock::new();
    CONFIRMED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The host key the last successful Test SSH actually saw per host:port. A confirm is accepted only for
/// this value, so the webview cannot confirm a fingerprint the host never observed.
fn observed() -> &'static Mutex<HashMap<String, ConfirmedHostKey>> {
    static OBSERVED: OnceLock<Mutex<HashMap<String, ConfirmedHostKey>>> = OnceLock::new();
    OBSERVED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_observed(target: &PreparedTarget, key_type: &str, fingerprint: &str) {
    let key = ConfirmedHostKey { key_type: key_type.to_string(), fingerprint: fingerprint.to_string() };
    observed().lock().unwrap_or_else(|e| e.into_inner()).insert(confirm_key(target), key);
}

fn confirm_key(target: &PreparedTarget) -> String {
    format!("{}:{}", target.host.to_ascii_lowercase(), target.port)
}

/// True for the OpenSSH SHA256 fingerprint shape this app shows: `SHA256:` + base64url-ish, no padding.
pub fn valid_fingerprint(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("SHA256:") else { return false; };
    !rest.is_empty()
        && rest.len() <= 128
        && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_' | '='))
}

/// True for an ssh host-key algorithm name; it becomes an `ssh-keyscan -t` argument, so it is a shape
/// check, never free text.
pub fn valid_host_key_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && (value.starts_with("ssh-") || value.starts_with("ecdsa-"))
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '@' | '.'))
}

/// Record the fingerprint the user confirmed. The host command is the authority on what the host
/// offered; this only remembers the choice for the session.
pub fn confirm_host_key(target: &PreparedTarget, key_type: &str, fingerprint: &str) -> Result<ConfirmedHostKey, FsError> {
    if !valid_host_key_type(key_type) {
        return Err(herr("invalid_host_key", "the host key type is not a known SSH key type"));
    }
    if !valid_fingerprint(fingerprint) {
        return Err(herr("invalid_fingerprint", "the fingerprint is not an SSH SHA256 fingerprint"));
    }
    let key = ConfirmedHostKey { key_type: key_type.to_string(), fingerprint: fingerprint.to_string() };
    check_observed(target, key_type, fingerprint)?;
    confirmations().lock().unwrap_or_else(|e| e.into_inner()).insert(confirm_key(target), key.clone());
    Ok(key)
}

/// The confirmed key for this host:port, or a refusal. Every mutating remote command calls this.
pub fn require_confirmed_host_key(target: &PreparedTarget) -> Result<ConfirmedHostKey, FsError> {
    confirmations()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&confirm_key(target))
        .cloned()
        .ok_or_else(|| herr("host_key_unconfirmed", "Test SSH and confirm the server's host-key fingerprint before deploying"))
}

/// Drop one confirmation (tests and a changed target use this; production clears at app exit).
#[cfg(test)]
pub fn forget_confirmation(target: &PreparedTarget) {
    confirmations().lock().unwrap_or_else(|e| e.into_inner()).remove(&confirm_key(target));
}

pub trait Runner {
    fn run(&self, args: &[String]) -> std::io::Result<RawOutput>;
}

/// Lets a test pass a plain closure (or function) as the runner; production uses `SystemSsh`.
impl<F> Runner for F
where
    F: Fn(&[String]) -> std::io::Result<RawOutput>,
{
    fn run(&self, args: &[String]) -> std::io::Result<RawOutput> {
        self(args)
    }
}

/// The real system `ssh`, found through PATH like every other host tool.
pub struct SystemSsh;

impl Runner for SystemSsh {
    fn run(&self, args: &[String]) -> std::io::Result<RawOutput> {
        let output = Command::new("ssh")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;
        Ok(RawOutput {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// The fixed remote command. It is one argv element for ssh, so OpenSSH hands this exact text to the
/// remote login shell; no webview value is part of it. Markers make parsing independent of shell rc noise.
pub const REMOTE_COMMAND: &str = concat!(
    "printf '__LLMIDE_UNAME__=%s\\n' \"$(uname -srm 2>/dev/null)\"; ",
    "printf '__LLMIDE_NODE__=%s\\n' \"$(command -v node 2>/dev/null || true)\"; ",
    "printf '__LLMIDE_NODE_VERSION__=%s\\n' \"$(node --version 2>/dev/null || true)\"",
);

/// True for a DNS hostname (RFC 1123 shape) or an IPv4/IPv6 literal. Rejects option-like values,
/// whitespace, control characters and anything that could change the meaning of `user@host`.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LEN || host.starts_with('-') || host.ends_with('.') {
        return false;
    }
    if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    if host.parse::<std::net::Ipv4Addr>().is_ok() || host.parse::<std::net::Ipv6Addr>().is_ok() {
        return true;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

/// A plain user name: letters/digits plus `.`, `_`, `-`; never option-like, empty or leading-dot.
pub fn valid_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= MAX_USER_LEN
        && !user.starts_with('-')
        && !user.starts_with('.')
        && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Cross-platform absolute path shape (Unix `/`, Windows drive prefix or UNC). Existence is checked only
/// by the command, so this stays a pure validation the UI and tests can share.
pub fn valid_key_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_KEY_PATH_LEN || path.starts_with('-') {
        return false;
    }
    if path.chars().any(|c| c == '\0' || c.is_control()) {
        return false;
    }
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/'))
}

/// Pure shape validation. The command's errors are fixed codes; the UI maps them to clear sentences.
pub fn prepare(target: &SshTarget) -> Result<PreparedTarget, FsError> {
    let host = target.host.trim();
    if !valid_host(host) {
        return Err(herr("invalid_host", "enter a hostname or IP address without spaces or a leading '-'"));
    }
    let user = target.user.trim();
    if !valid_user(user) {
        return Err(herr("invalid_user", "enter a plain SSH user name (letters, digits, '.', '_' or '-')"));
    }
    let key_path = target.key_path.trim();
    if !valid_key_path(key_path) {
        return Err(herr("invalid_key_path", "enter an absolute path to the private key file"));
    }
    if target.port == 0 {
        return Err(herr("invalid_port", "the SSH port must be between 1 and 65535"));
    }
    Ok(PreparedTarget {
        host: host.to_string(),
        port: target.port,
        user: user.to_string(),
        key_path: key_path.to_string(),
    })
}

/// The argv after `ssh`: a fixed option list, then `user@host`, then one remote command. No shell.
#[cfg(test)]
pub fn ssh_args_with(target: &PreparedTarget, command: &str) -> Vec<String> {
    vec![
        "-v".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "IdentitiesOnly=yes".to_string(),
        "-p".to_string(),
        target.port.to_string(),
        "-i".to_string(),
        target.key_path.clone(),
        format!("{}@{}", target.user, target.host),
        command.to_string(),
    ]
}

/// The argv for the fixed Phase-1 probe. Deploy uses [`ssh_args_with`] with a constant stage command.
#[cfg(test)]
pub fn ssh_args(target: &PreparedTarget) -> Vec<String> {
    ssh_args_with(target, REMOTE_COMMAND)
}

/// The deploy/update/uninstall argv (R-034 #7): `StrictHostKeyChecking=yes` against ONE temporary
/// known_hosts file that holds only the confirmed key. `GlobalKnownHostsFile` is neutralised so a
/// system-wide entry cannot broaden what is trusted. `accept_new` is only for the initial Test SSH,
/// which never sends a secret.
pub fn ssh_args_known(target: &PreparedTarget, command: &str, known_hosts: &Path, accept_new: bool) -> Vec<String> {
    vec![
        "-v".to_string(),
        // Nothing from the user's ssh config may forward an agent, X11, ports or run a local command.
        "-a".to_string(),
        "-x".to_string(),
        "-o".to_string(),
        "ForwardAgent=no".to_string(),
        "-o".to_string(),
        "ClearAllForwardings=yes".to_string(),
        "-o".to_string(),
        "PermitLocalCommand=no".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "-o".to_string(),
        if accept_new { "StrictHostKeyChecking=accept-new".to_string() } else { "StrictHostKeyChecking=yes".to_string() },
        "-o".to_string(),
        format!("UserKnownHostsFile={}", known_hosts.display()),
        "-o".to_string(),
        format!("GlobalKnownHostsFile={}", if cfg!(windows) { "NUL" } else { "/dev/null" }),
        "-o".to_string(),
        "IdentitiesOnly=yes".to_string(),
        "-p".to_string(),
        target.port.to_string(),
        "-i".to_string(),
        target.key_path.clone(),
        format!("{}@{}", target.user, target.host),
        command.to_string(),
    ]
}

/// A private temp directory for one SSH child (a known_hosts file, never secrets). Best effort mode
/// 0700 on Unix; the file itself carries no secret (it is a public host key).
pub fn temp_ssh_dir(label: &str) -> Result<PathBuf, FsError> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("llmide-{label}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| herr("temp_dir_failed", format!("could not create a temporary SSH directory: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Write a one-line known_hosts file (0600) for the confirmed host key.
pub fn write_known_hosts(dir: &Path, line: &str) -> Result<PathBuf, FsError> {
    let path = dir.join("known_hosts");
    std::fs::write(&path, format!("{line}\n"))
        .map_err(|e| herr("known_hosts_failed", format!("could not write the temporary known_hosts: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

/// Checks the user-supplied key path without reading the file. A directory, FIFO or missing path is refused
/// with a clear error before ssh runs; ssh itself still enforces its own key/permission rules.
pub fn check_key_file(path: &str) -> Result<(), FsError> {
    match std::fs::metadata(Path::new(path)) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(herr("invalid_key_path", "the private key path is not a regular file")),
        Err(_) => Err(herr("key_not_found", "no private key file was found at that path")),
    }
}

/// Runs the test through an injected runner. Tests use a fake; production uses `SystemSsh`.
pub fn execute<R: Runner>(target: &PreparedTarget, runner: &R) -> Result<SshTestResult, FsError> {
    // R-034 #7: accept-new writes only into a throwaway known_hosts, never the user's ~/.ssh file.
    let dir = temp_ssh_dir("ssh-test")?;
    let known = dir.join("known_hosts");
    let args = ssh_args_known(target, REMOTE_COMMAND, &known, true);
    let output = runner
        .run(&args)
        .map_err(|e| herr("ssh_missing", format!("could not run the system ssh command: {e}")));
    let _ = std::fs::remove_dir_all(&dir);
    let output = output?;
    if output.code != Some(0) {
        return Err(herr("ssh_failed", failure_message(&output)));
    }
    let (host_key_type, fingerprint) = parse_host_key(&output.stderr).ok_or_else(|| {
        herr("no_host_key", "SSH connected but did not report the server's host key fingerprint")
    })?;
    record_observed(target, &host_key_type, &fingerprint);
    let uname = marker(&output.stdout, "__LLMIDE_UNAME__=")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| herr("no_uname", "the remote shell did not report its uname"))?;
    let node_path = marker(&output.stdout, "__LLMIDE_NODE__=").filter(|v| !v.is_empty());
    let node_version = marker(&output.stdout, "__LLMIDE_NODE_VERSION__=").filter(|v| !v.is_empty());
    Ok(SshTestResult {
        host: target.host.clone(),
        port: target.port,
        user: target.user.clone(),
        host_key_type,
        fingerprint,
        uname: uname.to_string(),
        node: node_path.is_some() || node_version.is_some(),
        node_path: node_path.map(str::to_string),
        node_version: node_version.map(str::to_string),
    })
}

/// Host key line from `ssh -v`: `debug1: Server host key: ssh-ed25519 SHA256:...`.
fn parse_host_key(stderr: &str) -> Option<(String, String)> {
    for line in stderr.lines().rev() {
        let Some(rest) = line.split_once("Server host key:").map(|(_, rhs)| rhs.trim()) else {
            continue;
        };
        let mut parts = rest.split_whitespace();
        let key_type = parts.next().unwrap_or("");
        let fingerprint = parts.next().unwrap_or("");
        let looks_like_fingerprint = fingerprint.contains(':') && fingerprint.len() <= 160
            && fingerprint.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '+' | '/' | '=' | '-'));
        if !key_type.is_empty() && looks_like_fingerprint {
            return Some((key_type.to_string(), fingerprint.to_string()));
        }
    }
    None
}

/// Last `marker` line, single-line and bounded: remote output is untrusted text but never rendered as HTML.
fn marker<'a>(stdout: &'a str, prefix: &str) -> Option<&'a str> {
    stdout
        .lines()
        .rev()
        .find_map(|line| line.trim_end_matches('\r').strip_prefix(prefix))
        .map(|v| v.trim())
        .map(|v| {
            let end = v.char_indices().nth(MAX_REMOTE_CHARS).map(|(i, _)| i).unwrap_or(v.len());
            &v[..end]
        })
}

/// One useful non-debug stderr line, bounded and stripped of control characters. Never the argv, never key bytes.
fn failure_message(output: &RawOutput) -> String {
    let detail = output
        .stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("debug") && !line.starts_with("Warning: Permanently added"))
        .last()
        .map(|line| {
            line.chars()
                .filter(|c| !c.is_control())
                .take(MAX_ERROR_CHARS)
                .collect::<String>()
        })
        .unwrap_or_default();
    match output.code {
        Some(255) if detail.is_empty() => "SSH could not connect. Check the host, port, user and private key.".to_string(),
        Some(255) => format!("SSH could not connect: {detail}"),
        Some(code) => {
            if detail.is_empty() {
                format!("the remote command failed (exit {code})")
            } else {
                format!("the remote command failed (exit {code}): {detail}")
            }
        }
        None => "SSH ended without an exit status (the process was killed)".to_string(),
    }
}

#[tauri::command]
pub async fn remote_ssh_test(target: SshTarget) -> Result<SshTestResult, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        check_key_file(&prepared.key_path)?;
        execute(&prepared, &SystemSsh)
    })
    .await
    .map_err(|e| herr("internal", format!("the SSH test did not finish: {e}")))?
}

/// R-034 #7: remember the host-key fingerprint the user confirmed after a Test SSH. Deploy, update and
/// uninstall refuse until this is called for the same host:port in this app session.
#[tauri::command]
pub async fn remote_ssh_confirm(target: SshTarget, host_key_type: String, fingerprint: String) -> Result<ConfirmedHostKey, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        // Check against what Test SSH observed BEFORE bothering the user with a dialog about a value that cannot be accepted.
        confirm_host_key_with(&prepared, &host_key_type, &fingerprint, |host, key_type, fp| {
            crate::confirm::ask(
                "Trust this SSH host key?",
                &format!("Trust {key_type} key {fp} for {host}? Deploys to this server will refuse any other key."),
                "Trust host key",
                true,
            )
        })
    })
    .await
    .map_err(|e| herr("internal", format!("the host-key confirmation did not finish: {e}")))?
}

/// `confirm_host_key` plus a consent step; `ask` is the native dialog in production and a closure in tests.
pub fn confirm_host_key_with(
    target: &PreparedTarget,
    key_type: &str,
    fingerprint: &str,
    ask: impl FnOnce(&str, &str, &str) -> bool,
) -> Result<ConfirmedHostKey, FsError> {
    check_observed(target, key_type, fingerprint)?;
    if !ask(&format!("{}:{}", target.host, target.port), key_type, fingerprint) {
        return Err(herr("cancelled", "the host key was not trusted"));
    }
    confirm_host_key(target, key_type, fingerprint)
}

fn check_observed(target: &PreparedTarget, key_type: &str, fingerprint: &str) -> Result<(), FsError> {
    let seen = observed().lock().unwrap_or_else(|e| e.into_inner()).get(&confirm_key(target)).cloned();
    match seen {
        Some(k) if k.key_type == key_type && k.fingerprint == fingerprint => Ok(()),
        _ => Err(herr("host_key_not_observed", "that host key was not the one Test SSH saw for this server; run Test SSH again")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str, user: &str, key_path: &str) -> SshTarget {
        SshTarget { host: host.into(), port: 22, user: user.into(), key_path: key_path.into() }
    }

    fn ok(stderr: &str, stdout: &str) -> RawOutput {
        RawOutput { code: Some(0), stdout: stdout.into(), stderr: stderr.into() }
    }

    const HANDSHAKE: &str = "debug1: Server host key: ssh-ed25519 SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff\n";
    const REMOTE: &str = "__LLMIDE_UNAME__=Linux 6.8.0 x86_64\n__LLMIDE_NODE__=/usr/bin/node\n__LLMIDE_NODE_VERSION__=v22.11.0\n";

    fn fake_run(args: &[String]) -> std::io::Result<RawOutput> {
        assert!(args.contains(&"BatchMode=yes".to_string()));
        Ok(ok(HANDSHAKE, REMOTE))
    }

    #[test]
    fn the_webview_target_uses_camel_case_and_defaults_the_port() {
        let t: SshTarget = serde_json::from_str(r#"{"host":"example.com","user":"alice","keyPath":"/tmp/key"}"#).unwrap();
        assert_eq!(t.port, 22, "an omitted port is the standard 22");
        let t: SshTarget = serde_json::from_str(r#"{"host":"example.com","port":2222,"user":"alice","keyPath":"/tmp/key"}"#).unwrap();
        assert_eq!(t.port, 2222);
        assert!(serde_json::from_str::<SshTarget>(r#"{"host":"example.com","user":"alice","keyPath":"/tmp/key","keyContents":"secret"}"#).is_err());
    }

    #[test]
    fn rejects_option_injection_in_host_and_user_before_running_ssh() {
        for host in ["-oProxyCommand=touch /tmp/pwned", "-h", "-", "-o"] {
            let err = prepare(&target(host, "alice", "/home/alice/.ssh/id_ed25519")).unwrap_err();
            assert_eq!(err.code, "invalid_host", "{host}");
        }
        for user in ["-l", "-oProxyCommand=x", "--"] {
            let err = prepare(&target("example.com", user, "/home/alice/.ssh/id_ed25519")).unwrap_err();
            assert_eq!(err.code, "invalid_user", "{user}");
        }
        // A key path that starts with '-' cannot be handed to -i as an option-looking value.
        let err = prepare(&target("example.com", "alice", "-oProxyCommand=x")).unwrap_err();
        assert_eq!(err.code, "invalid_key_path");
    }

    #[test]
    fn host_shapes_are_strict() {
        for host in ["example.com", "example", "10.0.0.5", "::1", "2001:db8::1", "a-b.example.co.uk"] {
            assert!(valid_host(host), "{host} should be accepted");
        }
        for host in [
            "", " example.com", "example.com ", "exa mple.com", "example.com\n", "user@example.com",
            "example.com/", "example.com:22", "-example.com", "example..com", ".example.com",
            "example.com.", "under_score.example.com", "exa$mple.com",
        ] {
            assert!(!valid_host(host), "{host:?} should be refused");
        }
        assert!(!valid_host(&"a".repeat(MAX_HOST_LEN + 1)));
    }

    #[test]
    fn user_shapes_are_strict() {
        for user in ["alice", "deploy_bot", "a.b-c", "root"] {
            assert!(valid_user(user), "{user} should be accepted");
        }
        for user in ["", "-alice", ".alice", "alice@example.com", "al ice", "ali:ce", "ali/ce", &"a".repeat(65)] {
            assert!(!valid_user(user), "{user:?} should be refused");
        }
    }

    #[test]
    fn key_paths_must_be_absolute_and_plain() {
        for path in ["/home/alice/.ssh/id_ed25519", "/tmp/key", "C:\\Users\\alice\\.ssh\\id_ed25519", "\\\\server\\share\\key"] {
            assert!(valid_key_path(path), "{path} should be accepted");
        }
        for path in ["", "-key", "relative/key", "./key", "../key", "/tmp/key\nrm -rf /", "/tmp/key\0"] {
            assert!(!valid_key_path(path), "{path:?} should be refused");
        }
    }

    #[test]
    fn argv_is_an_array_with_the_required_ssh_options_and_no_shell() {
        let prepared = prepare(&SshTarget { port: 2222, ..target("example.com", "alice", "/home/alice/.ssh/id_ed25519") }).unwrap();
        let args = ssh_args(&prepared);
        assert!(!args.iter().any(|a| a.contains("sh -c") || a.contains("; rm")));
        assert_eq!(args[0], "-v");
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == "BatchMode=yes"));
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == "ConnectTimeout=10"));
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == "StrictHostKeyChecking=accept-new"));
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == "IdentitiesOnly=yes"));
        assert!(args.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"));
        assert!(args.windows(2).any(|w| w[0] == "-i" && w[1] == "/home/alice/.ssh/id_ed25519"));
        assert!(args.contains(&"alice@example.com".to_string()));
        assert_eq!(args.last().map(String::as_str), Some(REMOTE_COMMAND));
    }

    #[test]
    fn r034_a_confirmed_fingerprint_is_required_and_session_scoped() {
        let prepared = prepare(&target("example.com", "alice", "/home/alice/.ssh/id_ed25519")).unwrap();
        forget_confirmation(&prepared);
        assert_eq!(require_confirmed_host_key(&prepared).unwrap_err().code, "host_key_unconfirmed");
        assert!(!valid_fingerprint("SHA256:"));
        assert!(!valid_fingerprint("MD5:aa:bb"));
        assert!(!valid_fingerprint("SHA256:bad space"));
        assert!(!valid_host_key_type("-oProxyCommand=x"));
        // A confirm for a key Test SSH never saw is refused, whatever its shape.
        assert_eq!(confirm_host_key(&prepared, "ssh-ed25519", "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff").unwrap_err().code, "host_key_not_observed");
        execute(&prepared, &fake_run).unwrap();
        assert_eq!(confirm_host_key(&prepared, "ssh-ed25519", "SHA256:other0000").unwrap_err().code, "host_key_not_observed");
        let declined = confirm_host_key_with(&prepared, "ssh-ed25519", "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", |_, _, _| false);
        assert_eq!(declined.unwrap_err().code, "cancelled");
        assert_eq!(require_confirmed_host_key(&prepared).unwrap_err().code, "host_key_unconfirmed", "a declined dialog stores nothing");
        confirm_host_key_with(&prepared, "ssh-ed25519", "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", |host, _, _| host == "example.com:22").unwrap();
        assert_eq!(require_confirmed_host_key(&prepared).unwrap().key_type, "ssh-ed25519");
        // Same host on another port is a different key entry.
        let other = prepare(&SshTarget { port: 2222, ..target("example.com", "alice", "/home/alice/.ssh/id_ed25519") }).unwrap();
        assert_eq!(require_confirmed_host_key(&other).unwrap_err().code, "host_key_unconfirmed");
        forget_confirmation(&prepared);
        assert_eq!(require_confirmed_host_key(&prepared).unwrap_err().code, "host_key_unconfirmed");
    }

    #[test]
    fn r034_the_test_argv_uses_a_throwaway_known_hosts_file() {
        let prepared = prepare(&target("example.com", "alice", "/home/alice/.ssh/id_ed25519")).unwrap();
        let path = std::path::Path::new("/tmp/llmide-known-hosts-test");
        let args = ssh_args_known(&prepared, REMOTE_COMMAND, path, false);
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == "StrictHostKeyChecking=yes"));
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1].starts_with("UserKnownHostsFile=/tmp/llmide-known-hosts-test")));
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1].starts_with("GlobalKnownHostsFile=")));
        for flag in ["-a", "-x"] { assert!(args.contains(&flag.to_string()), "{flag}"); }
        for opt in ["ForwardAgent=no", "ClearAllForwardings=yes", "PermitLocalCommand=no"] {
            assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == opt), "{opt}");
        }
    }

    #[test]
    fn a_successful_test_reports_fingerprint_uname_and_node_presence() {
        let prepared = prepare(&target("example.com", "alice", "/home/alice/.ssh/id_ed25519")).unwrap();
        let result = execute(&prepared, &fake_run).unwrap();
        assert_eq!(result.host_key_type, "ssh-ed25519");
        assert_eq!(result.fingerprint, "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff");
        assert_eq!(result.uname, "Linux 6.8.0 x86_64");
        assert!(result.node);
        assert_eq!(result.node_path.as_deref(), Some("/usr/bin/node"));
        assert_eq!(result.node_version.as_deref(), Some("v22.11.0"));
    }

    #[test]
    fn node_absence_is_false_not_an_error() {
        let prepared = prepare(&target("example.com", "alice", "/home/alice/.ssh/id_ed25519")).unwrap();
        let out = ok(HANDSHAKE, "__LLMIDE_UNAME__=Darwin 24.0.0 arm64\n__LLMIDE_NODE__=\n__LLMIDE_NODE_VERSION__=\n");
        let result = execute(&prepared, &|_: &[String]| Ok(out.clone())).unwrap();
        assert!(!result.node);
        assert_eq!(result.node_path, None);
        assert_eq!(result.node_version, None);
    }

    #[test]
    fn a_failed_connection_returns_a_clear_error_without_the_argv() {
        let prepared = prepare(&target("example.com", "alice", "/home/alice/.ssh/id_ed25519")).unwrap();
        let out = RawOutput { code: Some(255), stdout: String::new(), stderr: "Warning: Permanently added 'example.com' (ED25519) to the list of known hosts.\nPermission denied (publickey).\n".into() };
        let err = execute(&prepared, &|_: &[String]| Ok(out.clone())).unwrap_err();
        assert_eq!(err.code, "ssh_failed");
        assert!(err.message.contains("Permission denied (publickey)."));
        assert!(!err.message.contains("id_ed25519"), "the key path is not echoed in an error");
    }

    #[test]
    fn a_success_without_a_host_key_fingerprint_is_refused() {
        let prepared = prepare(&target("example.com", "alice", "/home/alice/.ssh/id_ed25519")).unwrap();
        let err = execute(&prepared, &|_: &[String]| Ok(ok("debug1: Authenticated to example.com\n", REMOTE))).unwrap_err();
        assert_eq!(err.code, "no_host_key");
    }

    #[test]
    fn a_missing_ssh_binary_is_reported_as_such() {
        let prepared = prepare(&target("example.com", "alice", "/home/alice/.ssh/id_ed25519")).unwrap();
        let err = execute(&prepared, &|_: &[String]| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no ssh"))).unwrap_err();
        assert_eq!(err.code, "ssh_missing");
    }

    #[test]
    fn key_file_check_never_reads_the_file() {
        let dir = std::env::temp_dir().join(format!("llmide-remote-key-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("id_ed25519");
        std::fs::write(&file, "not a real key").unwrap();
        assert!(check_key_file(file.to_str().unwrap()).is_ok());
        assert_eq!(check_key_file(dir.to_str().unwrap()).unwrap_err().code, "invalid_key_path");
        assert_eq!(check_key_file(dir.join("missing").to_str().unwrap()).unwrap_err().code, "key_not_found");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
