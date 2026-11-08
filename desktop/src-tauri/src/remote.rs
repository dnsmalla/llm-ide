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

use std::path::Path;
use std::process::{Command, Stdio};

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

/// The argv after `ssh`: a fixed option list, then `user@host`, then the fixed remote command. No shell.
pub fn ssh_args(target: &PreparedTarget) -> Vec<String> {
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
        REMOTE_COMMAND.to_string(),
    ]
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
    let args = ssh_args(target);
    let output = runner
        .run(&args)
        .map_err(|e| herr("ssh_missing", format!("could not run the system ssh command: {e}")))?;
    if output.code != Some(0) {
        return Err(herr("ssh_failed", failure_message(&output)));
    }
    let (host_key_type, fingerprint) = parse_host_key(&output.stderr).ok_or_else(|| {
        herr("no_host_key", "SSH connected but did not report the server's host key fingerprint")
    })?;
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
