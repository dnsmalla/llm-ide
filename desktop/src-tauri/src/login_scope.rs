//! Which server a saved login belongs to, and the gate that decides whether the app may send it anything.
//!
//! A saved login (`local_login.rs`) is kept per SCOPE: the local core of one data dir, or one SSH server. The
//! keychain account names the scope, so a login saved for server A is never read, overwritten or sent while the app
//! is connected to server B, and saving one scope never touches another.
//!
//! An SSH scope is also bound to the PINNED HOST KEY of the server (a SHA-256 fingerprint). The keychain account
//! stays one slot per server, but the stored id is `<server key>#<fingerprint>` and every read compares it, so after
//! the host key changes the old entry is unreadable whatever the keychain or the forget hooks did (fail closed).
//!
//! TRUST RULE (MUST): a scope is trusted only after the host verified the core behind it RIGHT NOW. Local: the core
//! this app spawned, `/health` echoing this launch's nonce. SSH: a link whose supervisor reports the forward up, that
//! has a pinned host key, and whose forwarded port still echoes that link's nonce; commands that release a credential
//! additionally need STATUS, run over SSH as the SSH user, to report a running core with this link's nonce on the
//! port the forward targets. STATUS reads that user's own 0600 `state.json` and accepts only a process owned by that
//! user, so another account on the same server cannot fake it (`/health` alone could be echoed by a co-tenant who
//! binds the freed port). The server key and fingerprint come from the LIVE link. This is NOT a secret-based proof:
//! a full fix needs a challenge the core answers with a secret `/health` never reveals. The URL is always plain
//! `http://127.0.0.1:<port>`. Hub (remote) mode never has a scope that is trusted.

use crate::confirm::herr;
use crate::core_host::CoreHost;
use crate::fs_ops::FsError;
use crate::prefs::{RemoteServerPrefs, ServerMode};
use crate::secrets::{SecretBackend, ACCOUNT_LOCAL_LOGIN};

const SSH_ACCOUNT_PREFIX: &str = "ssh-login:";

/// Whose login this is. The id is what a stored entry must carry to be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LoginScope {
    /// The local core; the id is the desktop data dir.
    Local { data_dir: String },
    /// One SSH server (`prefs::ssh_server_key`) as seen through one pinned host key. `host_key_fp` is empty when no
    /// key is pinned: such a scope reads nothing, can be forgotten, and is never trusted.
    Ssh { server_key: String, host_key_fp: String },
}

impl LoginScope {
    /// The keychain account of this scope's single slot.
    pub(crate) fn account(&self) -> String {
        match self {
            Self::Local { .. } => ACCOUNT_LOCAL_LOGIN.to_string(),
            Self::Ssh { server_key, .. } => format!("{SSH_ACCOUNT_PREFIX}{server_key}"),
        }
    }

    /// The value a stored entry's `data_dir` must equal for a read to count.
    pub(crate) fn id(&self) -> String {
        match self {
            Self::Local { data_dir } => data_dir.clone(),
            Self::Ssh { server_key, host_key_fp } => format!("{server_key}#{host_key_fp}"),
        }
    }

    pub(crate) fn mode(&self) -> ServerMode {
        match self {
            Self::Local { .. } => ServerMode::Local,
            Self::Ssh { .. } => ServerMode::Ssh,
        }
    }
}

/// The server key of a login target: user as typed, host lower-cased (the key `ssh_saved_password::account` uses).
pub(crate) fn server_key(user: &str, host: &str, port: u16) -> String {
    crate::prefs::ssh_server_key(user.trim(), &host.trim().to_ascii_lowercase(), port)
}

/// Hex SHA-256 over the pinned host key: `<key type>`, a newline, `<key base64>`. Both the live link (from its
/// known_hosts file) and the saved pin in preferences use this one function, so the two always agree.
pub(crate) fn host_key_fp(key_type: &str, key_b64: &str) -> String {
    let mut hash = crate::chat_hash::Sha256::new();
    hash.update(key_type.as_bytes());
    hash.update(b"\n");
    hash.update(key_b64.as_bytes());
    hash.finish_hex()
}

/// A core the host verified just now, with the scope it was verified for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Verified {
    pub(crate) url: String,
    pub(crate) scope: LoginScope,
}

pub(crate) fn untrusted() -> FsError {
    herr("untrusted_core", "The saved login is used only with a core this app started or reached over its own verified connection.")
}

/// Only `http://127.0.0.1:<port>` (the address the spawned core and the SSH forward listen on). `localhost` and
/// `[::1]` are refused: one literal address keeps the trusted surface to exactly what the host binds.
pub(crate) fn is_loopback_core_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else { return false };
    let port = rest.trim_end_matches('/');
    !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit())
}

/// Pure decision for a credential use. `verified` is what the host's live gate returned at this moment. Refuses hub
/// mode, a missing verification, a scope of another mode, and any URL that is not the loopback core address.
pub(crate) fn credential_core(mode: ServerMode, verified: Option<Verified>) -> Result<Verified, FsError> {
    if mode == ServerMode::Remote {
        return Err(untrusted());
    }
    let found = verified.ok_or_else(untrusted)?;
    let unpinned = matches!(&found.scope, LoginScope::Ssh { host_key_fp, .. } if host_key_fp.is_empty());
    if found.scope.mode() != mode || unpinned || !is_loopback_core_url(&found.url) {
        return Err(untrusted());
    }
    Ok(Verified { url: found.url.trim_end_matches('/').to_string(), scope: found.scope })
}

/// A credential read for `expected` may be used only when the core just verified is for that same scope.
pub(crate) fn ensure_same(expected: &LoginScope, verified: &LoginScope) -> Result<(), FsError> {
    if expected == verified { Ok(()) } else { Err(untrusted()) }
}

/// The saved pin's fingerprint for `host:port` in preferences, or empty when none is saved.
fn saved_pin_fp(saved: &RemoteServerPrefs, host: &str, port: u16) -> String {
    let endpoint = format!("{}:{port}", host.trim().to_ascii_lowercase());
    saved
        .ssh_known_hosts
        .iter()
        .filter_map(|entry| crate::prefs::parse_known_host(entry))
        .find(|known| known.endpoint == endpoint)
        .map(|known| host_key_fp(&known.key_type, &known.key_b64))
        .unwrap_or_default()
}

/// The SSH scope a no-trust command (`status`, `forget`) acts on: the live link's server and pin when a link is
/// attached, else the saved server with its saved pin (an empty fingerprint when none). `None` when neither names a
/// server. `link` is the link's (server key, fingerprint).
pub(crate) fn ssh_scope(link: Option<(String, String)>, saved: &RemoteServerPrefs) -> Option<LoginScope> {
    if let Some((server_key, host_key_fp)) = link {
        return Some(LoginScope::Ssh { server_key, host_key_fp });
    }
    if saved.host.trim().is_empty() || saved.user.trim().is_empty() || saved.port == 0 {
        return None;
    }
    Some(LoginScope::Ssh {
        server_key: server_key(&saved.user, &saved.host, saved.port),
        host_key_fp: saved_pin_fp(saved, &saved.host, saved.port),
    })
}

/// The scope of the current mode for the commands that need no trust. Hub mode has none.
pub(crate) fn current_scope(host: &CoreHost) -> Result<Option<LoginScope>, FsError> {
    match host.mode() {
        ServerMode::Local => {
            let dir = crate::fsutil::desktop_data_dir().map_err(|e| herr("io", e))?;
            Ok(Some(LoginScope::Local { data_dir: dir.to_string_lossy().into_owned() }))
        }
        ServerMode::Ssh => Ok(ssh_scope(host.ssh_link_identity(), &crate::prefs::stored().remote_server)),
        ServerMode::Remote => Ok(None),
    }
}

/// Clears the saved login of one SSH server, when there is one. Best effort and silent: it runs where a server's
/// trust ended (host key changed, server removed or uninstalled), and a keychain that refuses must not fail that.
/// The key is read first so an absent login costs no write.
pub(crate) fn forget_server_login(b: &dyn SecretBackend, key: &str) {
    let account = LoginScope::Ssh { server_key: key.to_string(), host_key_fp: String::new() }.account();
    if matches!(b.get(&account), Ok(Some(raw)) if !raw.is_empty()) {
        let _ = b.set(&account, "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    const CORE: &str = "http://127.0.0.1:3456";

    fn ssh(key: &str) -> LoginScope {
        LoginScope::Ssh { server_key: key.into(), host_key_fp: "fp-1".into() }
    }

    fn local() -> LoginScope {
        LoginScope::Local { data_dir: "/data".into() }
    }

    fn verified(url: &str, scope: LoginScope) -> Option<Verified> {
        Some(Verified { url: url.into(), scope })
    }

    #[test]
    fn accounts_are_per_scope() {
        assert_eq!(local().account(), "local-login");
        assert_eq!(ssh("alice@example.com:22").account(), "ssh-login:alice@example.com:22");
        assert_ne!(ssh("a@x:22").account(), ssh("a@x:2222").account());
        assert_eq!(server_key(" alice ", " Example.COM ", 22), "alice@example.com:22");
    }

    #[test]
    fn hub_mode_never_keeps_a_login() {
        for scope in [local(), ssh("a@x:22")] {
            assert_eq!(credential_core(ServerMode::Remote, verified(CORE, scope)).unwrap_err().code, "untrusted_core");
        }
        assert_eq!(credential_core(ServerMode::Remote, None).unwrap_err().code, "untrusted_core");
        assert_eq!(ssh_scope(None, &RemoteServerPrefs::default()), None, "no server named: nothing to act on");
    }

    #[test]
    fn ssh_login_needs_a_verified_forward() {
        // No verified core: a stopped or reconnecting link, a wrong nonce, a squatter.
        assert_eq!(credential_core(ServerMode::Ssh, None).unwrap_err().code, "untrusted_core");
        // Verified: accepted with that server's scope.
        let got = credential_core(ServerMode::Ssh, verified("http://127.0.0.1:41000/", ssh("a@x:22"))).unwrap();
        assert_eq!(got, Verified { url: "http://127.0.0.1:41000".into(), scope: ssh("a@x:22") });
        // A scope of the other mode never passes for this one, in either direction.
        assert!(credential_core(ServerMode::Ssh, verified(CORE, local())).is_err());
        assert!(credential_core(ServerMode::Local, verified(CORE, ssh("a@x:22"))).is_err());
        assert_eq!(credential_core(ServerMode::Local, verified(CORE, local())).unwrap().url, CORE);
        // A non-loopback URL is refused in both modes.
        for url in ["http://localhost:3456", "https://127.0.0.1:3456", "http://192.168.1.5:3456", "http://127.0.0.1:3456@evil.example.com"] {
            assert!(credential_core(ServerMode::Ssh, verified(url, ssh("a@x:22"))).is_err(), "{url}");
            assert!(credential_core(ServerMode::Local, verified(url, local())).is_err(), "{url}");
        }
    }

    #[test]
    fn only_the_literal_loopback_address_counts_as_a_core() {
        assert!(is_loopback_core_url("http://127.0.0.1:3456"));
        assert!(is_loopback_core_url("http://127.0.0.1:3457/"));
        assert!(!is_loopback_core_url("http://[::1]:3456"));
        assert!(!is_loopback_core_url("http://127.0.0.1.example.com:3456"), "a hostname is not loopback");
        assert!(!is_loopback_core_url("http://127.0.0.1:"));
    }

    #[test]
    fn a_credential_is_used_only_for_the_scope_it_was_read_for() {
        assert!(ensure_same(&ssh("a@x:22"), &ssh("a@x:22")).is_ok());
        assert_eq!(ensure_same(&ssh("a@x:22"), &ssh("b@y:22")).unwrap_err().code, "untrusted_core");
        assert!(ensure_same(&local(), &ssh("a@x:22")).is_err());
    }

    #[test]
    fn ssh_scope_prefers_the_live_link_over_preferences() {
        let saved = RemoteServerPrefs { host: "Saved.example.com".into(), user: "bob".into(), port: 22, ..RemoteServerPrefs::default() };
        let live = Some(("alice@live.example.com:22".to_string(), "fp-1".to_string()));
        assert_eq!(ssh_scope(live, &saved), Some(ssh("alice@live.example.com:22")));
        // No pin saved: an empty fingerprint, which reads nothing but can be forgotten.
        let unpinned = LoginScope::Ssh { server_key: "bob@saved.example.com:22".into(), host_key_fp: String::new() };
        assert_eq!(ssh_scope(None, &saved), Some(unpinned));
        // With the saved pin: the scope carries that pin's fingerprint (host spelling does not matter).
        let pin = "saved.example.com:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl".to_string();
        let pinned = RemoteServerPrefs { ssh_known_hosts: vec![pin], ..saved.clone() };
        let expected = LoginScope::Ssh {
            server_key: "bob@saved.example.com:22".into(),
            host_key_fp: host_key_fp("ssh-ed25519", "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"),
        };
        assert_eq!(ssh_scope(None, &pinned), Some(expected));
        assert_eq!(ssh_scope(None, &RemoteServerPrefs { user: String::new(), ..saved }), None);
    }

    #[test]
    fn forgetting_a_server_login_touches_only_that_server() {
        let b = MemoryBackend::default();
        b.set("ssh-login:a@x:22", "{\"v\":1}").unwrap();
        b.set("ssh-login:b@y:22", "{\"v\":1}").unwrap();
        b.set("local-login", "{\"v\":1}").unwrap();
        forget_server_login(&b, "a@x:22");
        assert_eq!(b.get("ssh-login:a@x:22").unwrap().as_deref(), Some(""));
        assert_eq!(b.get("ssh-login:b@y:22").unwrap().as_deref(), Some("{\"v\":1}"));
        assert_eq!(b.get("local-login").unwrap().as_deref(), Some("{\"v\":1}"));
        forget_server_login(&b, "never@saved:22");
        assert_eq!(b.get("ssh-login:never@saved:22").unwrap(), None, "an absent login is not written");
    }

    #[test]
    fn an_unpinned_scope_is_never_trusted_but_can_be_named() {
        let unpinned = LoginScope::Ssh { server_key: "a@x:22".into(), host_key_fp: String::new() };
        assert!(credential_core(ServerMode::Ssh, verified(CORE, unpinned.clone())).is_err());
        assert_eq!(unpinned.account(), "ssh-login:a@x:22");
        assert_ne!(unpinned.id(), ssh("a@x:22").id());
        assert_ne!(host_key_fp("ssh-ed25519", "AAAA"), host_key_fp("ssh-rsa", "AAAA"));
        assert_eq!(host_key_fp("ssh-ed25519", "AAAA").len(), 64);
    }

    fn up(nonce: &'static str) -> impl Fn(u16) -> Option<String> {
        move |_port| Some(nonce.to_string())
    }

    fn confirmed(_input: Option<crate::ssh_link::ConfirmInput>) -> bool {
        true
    }

    #[test]
    fn verified_ssh_core_needs_a_connected_link_and_its_nonce() {
        use crate::ssh_link::{gated_for_test, LinkState};
        let _mode = crate::core_host::process_mode_guard();
        let host = CoreHost::new();
        host.set_mode(ServerMode::Ssh);
        let link = |state: LinkState| gated_for_test(state, "n1", "a@x:22", Some("fp-1"));
        assert_eq!(host.verified_ssh_core_with(up("n1"), confirmed), None, "no link attached");

        host.attach_ssh_link(link(LinkState::Connected));
        let got = host.verified_ssh_core_with(up("n1"), confirmed);
        assert_eq!(got, Some(("http://127.0.0.1:3456".to_string(), "a@x:22".to_string(), "fp-1".to_string())));
        assert_eq!(host.verified_ssh_core_with(up("other"), confirmed), None, "a wrong nonce is a squatter");
        assert_eq!(host.verified_ssh_core_with(|_| None, confirmed), None, "nothing answers on the port");

        for state in [LinkState::Reconnecting { attempt: 1 }, LinkState::NeedsPassword, LinkState::Failed { code: "X", message: String::new() }] {
            host.attach_ssh_link(link(state));
            assert_eq!(host.verified_ssh_core_with(up("n1"), confirmed), None);
        }
        // A link with no pinned host key yields no scope at all.
        host.attach_ssh_link(gated_for_test(LinkState::Connected, "n1", "a@x:22", None));
        assert_eq!(host.verified_ssh_core_with(up("n1"), confirmed), None, "no pin, no trust");
        assert_eq!(host.ssh_link_identity(), Some(("a@x:22".to_string(), String::new())));

        host.attach_ssh_link(link(LinkState::Connected));
        host.detach_ssh_link();
        assert_eq!(host.verified_ssh_core_with(up("n1"), confirmed), None, "a stopped link never qualifies");

        host.attach_ssh_link(link(LinkState::Connected));
        host.set_mode(ServerMode::Local);
        assert_eq!(host.verified_ssh_core_with(up("n1"), confirmed), None, "only SSH mode");
        host.set_mode(ServerMode::Remote);
        assert_eq!(host.verified_ssh_core_with(up("n1"), confirmed), None, "hub mode never");
        host.set_mode(ServerMode::Local);
    }

    #[test]
    fn ssh_gate_needs_status_to_confirm_the_core() {
        use crate::ssh_link::{gated_for_test, status_confirms, LinkState};
        use crate::ssh_server_scripts::CoreState;
        let state = |running: bool, port: Option<u16>, nonce: Option<&str>| CoreState {
            running,
            port,
            pid: Some(1),
            nonce: nonce.map(str::to_string),
            version: None,
        };
        // The pure decision: running, this nonce, this port.
        assert!(status_confirms(&state(true, Some(3460), Some("n1")), "n1", 3460));
        assert!(!status_confirms(&state(false, None, None), "n1", 3460), "no core running");
        assert!(!status_confirms(&state(true, Some(3460), Some("n2")), "n1", 3460), "another nonce");
        assert!(!status_confirms(&state(true, Some(3461), Some("n1")), "n1", 3460), "another port");
        assert!(!status_confirms(&state(true, Some(3460), None), "n1", 3460), "no nonce");

        // The gate: /health echoes the nonce, but a link STATUS cannot confirm is untrusted.
        let _mode = crate::core_host::process_mode_guard();
        let host = CoreHost::new();
        host.set_mode(ServerMode::Ssh);
        host.attach_ssh_link(gated_for_test(LinkState::Connected, "n1", "a@x:22", Some("fp-1")));
        assert_eq!(host.verified_ssh_core_with(up("n1"), |_| false), None, "STATUS says no");
        // The production confirmation cannot run STATUS over a link without a runner: also untrusted.
        assert_eq!(host.verified_ssh_core_with(up("n1"), |input| input.is_some_and(|i| i.confirms())), None);
        assert!(host.verified_ssh_core_with(up("n1"), |_| true).is_some());
        host.set_mode(ServerMode::Local);
    }

    #[test]
    fn the_link_fingerprint_matches_the_saved_pin() {
        use crate::ssh_service::{pinned_dir, Pin};
        use crate::ssh_transport::{prepare_endpoint, SshAuth};
        let endpoint = prepare_endpoint("Saved.Example.com", 22, "bob", SshAuth::Password).unwrap();
        let pin = Pin { key_type: "ssh-ed25519".into(), key_b64: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl".into() };
        // The folder the real writer produces for a link is what `supervise` reads the fingerprint from.
        let held = pinned_dir(&endpoint, &pin).unwrap();
        let from_link = crate::ssh_link::pinned_fingerprint(&held.file);
        assert_eq!(from_link, Some(host_key_fp(&pin.key_type, &pin.key_b64)));
        // The saved pin in preferences gives the same value for the same key.
        let saved = RemoteServerPrefs {
            host: "saved.example.com".into(),
            user: "bob".into(),
            port: 22,
            ssh_known_hosts: vec![format!("saved.example.com:22 {} {}", pin.key_type, pin.key_b64)],
            ..RemoteServerPrefs::default()
        };
        let Some(LoginScope::Ssh { host_key_fp: from_prefs, .. }) = ssh_scope(None, &saved) else { panic!("no scope") };
        assert_eq!(Some(from_prefs), from_link);
    }
}
