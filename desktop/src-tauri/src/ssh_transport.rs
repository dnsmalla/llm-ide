//! SSH transport for "SSH server" mode: builds the system `ssh` argv for running the desktop core on a
//! Linux server and reaching it through a port forward.
//!
//! This module only builds argv and validates the endpoint. It spawns nothing. Every option here is a
//! deliberate guard: no agent or X11 forwarding, no local commands from the user's ssh config, and host
//! keys pinned to a known_hosts file the app controls, never the user's ~/.ssh/known_hosts.
//!
//! Password auth carries no secret here: [`SshAuth::Password`] holds no data, so a password can never
//! reach an argv or an environment variable from this module.

use std::path::Path;

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::remote::{valid_host, valid_key_path, valid_user, CONNECT_TIMEOUT_SECS};

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
    if let SshAuth::Key { path } = &auth {
        if !valid_key_path(path) {
            return Err(herr("invalid_key_path", "enter an absolute path to the private key file"));
        }
    }
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
pub fn forward_args(ep: &SshEndpoint, known_hosts: &Path, local_port: u16, remote_port: u16) -> Vec<String> {
    let mut args = vec!["-N".to_string(), "-a".to_string(), "-x".to_string()];
    push_option(&mut args, "ForwardAgent=no");
    push_option(&mut args, "PermitLocalCommand=no");
    push_option(&mut args, "ExitOnForwardFailure=yes");
    push_host_key_options(&mut args, known_hosts, "yes");
    push_auth_options(&mut args, ep);
    push_option(&mut args, "ServerAliveInterval=30");
    push_option(&mut args, "ServerAliveCountMax=4");
    args.push("-L".to_string());
    args.push(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
    push_endpoint(&mut args, ep);
    args
}

/// Appends one `-o <value>` pair.
fn push_option(args: &mut Vec<String>, value: &str) {
    args.push("-o".to_string());
    args.push(value.to_string());
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
        let args = forward_args(&key_endpoint(), Path::new(KNOWN), 3457, 3460);
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
}
