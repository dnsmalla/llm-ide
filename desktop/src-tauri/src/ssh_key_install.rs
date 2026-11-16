//! Moves a server from password login to a key this desktop creates, and proves the key works before any
//! preference changes.
//!
//! The password reaches exactly one ssh call (ADD_KEY, which adds the public line). The check that follows logs in
//! with the new key alone. A failure at any step removes the key files again. Lock order: the operation lock is
//! taken first, as in every other `ssh_service` call that changes the server.

use std::path::{Path, PathBuf};

use crate::confirm::herr;
use crate::core_host::CoreHost;
use crate::fs_ops::FsError;
use crate::fsutil;
use crate::prefs::{self, SshAuthKind};
use crate::ssh_link::KnownHostsDir;
use crate::ssh_server_scripts::{parse_add_key, parse_probe, ADD_KEY, PROBE};
use crate::ssh_service::{build_status, operation, pinned_dir, require_pin, target_endpoint, Deps, SshServerStatus, SshServerTarget};
use crate::ssh_session::Link;
use crate::ssh_transport::{prepare_endpoint, SshAuth, SshEndpoint};

/// Creates a dedicated key, adds its public line to the server, checks that the server accepts it, and only
/// then saves key auth. Until the check passes, nothing in preferences changes.
///
/// Preconditions: the saved login is password auth, the host key is pinned, and `password` is non-empty.
/// Postconditions: on success the key pair lives under `key_dir` and preferences hold key auth with its path.
/// The running link is left as it is; the key is used from the next connect. On any failure after the key
/// files were created, both files are removed. The server may keep the public line, which is harmless without
/// the private key.
///
/// Errors:
///     `SSH_KEY_NOT_NEEDED`, `SSH_PASSWORD_REQUIRED`, `SSH_HOST_KEY_UNCONFIRMED`, `SSH_KEYGEN_FAILED`,
///     `SSH_KEY_INVALID`, `SSH_KEY_INSTALL_FAILED`, `SSH_KEY_VERIFY_FAILED`, and the transport codes of the
///     pinned calls.
pub fn install_key(deps: &Deps, host: &CoreHost, key_dir: &Path, password: &str) -> Result<SshServerStatus, FsError> {
    let _operation = operation();
    let saved = prefs::stored().remote_server;
    if saved.ssh_auth != SshAuthKind::Password {
        return Err(herr("SSH_KEY_NOT_NEEDED", "This server already uses a key."));
    }
    let target = SshServerTarget {
        host: saved.host.clone(),
        port: saved.port,
        user: saved.user.clone(),
        key_path: String::new(),
        auth: SshAuthKind::Password,
    };
    let endpoint = target_endpoint(&target, Some(password))?;
    let pin = require_pin(&endpoint)?;
    let pinned = pinned_dir(&endpoint, &pin)?;
    fsutil::private_dir(key_dir).map_err(|_| herr(KEYGEN_FAILED, KEYGEN_MESSAGE))?;
    let key_path = key_file_path(key_dir, &endpoint.host, endpoint.port);
    // A file left by an earlier failed attempt must not block the new key.
    remove_key_files(&key_path);

    let installed = install_and_verify(deps, &endpoint, &pinned, &key_path, password).and_then(|()| {
        let key_text = path_text(&key_path)?;
        prefs::set_remote_ssh(saved.host, saved.port, saved.user, key_text, SshAuthKind::Key, saved.mode)
    });
    if let Err(error) = installed {
        remove_key_files(&key_path);
        return Err(error);
    }
    Ok(build_status(host))
}

// ---- helpers ----------------------------------------------------------------------------------------------

/// Codes and text for a key the local ssh-keygen could not create. Shared with the production keygen.
pub(crate) const KEYGEN_FAILED: &str = "SSH_KEYGEN_FAILED";
pub(crate) const KEYGEN_MESSAGE: &str = "Could not create a key on this computer.";
const KEY_VERIFY_MESSAGE: &str = "The server did not accept the new key. Your password login is unchanged.";
const KEY_REJECTED_MESSAGE: &str = "The new key was not accepted.";

/// The private key file for an endpoint: `<key_dir>/id_llmide_<host>_<port>`. The host is lower-cased and every
/// character outside `[a-z0-9.-]` becomes `_`, so the name holds no path separator whatever the typed host.
fn key_file_path(key_dir: &Path, host: &str, port: u16) -> PathBuf {
    let name: String = host
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    key_dir.join(format!("id_llmide_{name}_{port}"))
}

/// The public half of a key pair: the private path with `.pub` appended, as ssh-keygen names it.
pub(crate) fn public_key_path(private: &Path) -> PathBuf {
    let mut name = private.as_os_str().to_owned();
    name.push(".pub");
    PathBuf::from(name)
}

/// The same shape rule the ADD_KEY script enforces: `ssh-ed25519 <base64> <comment>` with exactly two spaces.
fn valid_public_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("ssh-ed25519 ") else {
        return false;
    };
    let mut parts = rest.split(' ');
    let (Some(base64), Some(comment), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !base64.is_empty()
        && !comment.is_empty()
        && base64.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        && comment.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'@' | b'.' | b'_' | b'-'))
}

fn path_text(path: &Path) -> Result<String, FsError> {
    path.to_str().map(str::to_string).ok_or_else(|| herr(KEYGEN_FAILED, KEYGEN_MESSAGE))
}

/// Removes the private and public key files. Best effort: a missing file is the normal case.
fn remove_key_files(private: &Path) {
    let _ = std::fs::remove_file(private);
    let _ = std::fs::remove_file(public_key_path(private));
}

/// Generates the pair, adds the public line through ADD_KEY (the only call that gets the password), then logs
/// in with the new key alone. Returns `Ok` only after the server accepted the key.
fn install_and_verify(
    deps: &Deps,
    endpoint: &SshEndpoint,
    pinned: &KnownHostsDir,
    key_path: &Path,
    password: &str,
) -> Result<(), FsError> {
    let public_line = (deps.keygen)(key_path)?;
    if !valid_public_line(&public_line) {
        return Err(herr("SSH_KEY_INVALID", KEY_REJECTED_MESSAGE));
    }
    set_private_mode(key_path)?;

    let stdin = format!("{public_line}\n");
    let add = Link { exec: &*deps.exec, endpoint, known_hosts: &pinned.file, password: Some(password) };
    parse_add_key(&add.run(ADD_KEY, Some(stdin.as_bytes()))?.stdout)?;

    let key_endpoint = prepare_endpoint(
        &endpoint.host,
        endpoint.port,
        &endpoint.user,
        SshAuth::Key { path: path_text(key_path)? },
    )?;
    // No password here: the probe must succeed on the key alone, or the key is not in use.
    let verify = Link { exec: &*deps.exec, endpoint: &key_endpoint, known_hosts: &pinned.file, password: None };
    verify
        .run(PROBE, None)
        .and_then(|out| parse_probe(&out.stdout))
        .map_err(|_| herr("SSH_KEY_VERIFY_FAILED", KEY_VERIFY_MESSAGE))?;
    Ok(())
}

/// ssh refuses a private key that other users can read, so the file is set to 0600 before it is used.
fn set_private_mode(path: &Path) -> Result<(), FsError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| herr(KEYGEN_FAILED, KEYGEN_MESSAGE))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::prefs::{set_remote_server_for_test, upsert_ssh_known_host};
    use crate::ssh_server_scripts::{ADD_KEY, PROBE};
    use crate::ssh_service::tests::{
        fake, generated_line, has_option, pin_text, saved_key_block, saved_password_block, Fixture, GrantSpy,
        ADD_KEY_ADDED, HOST, KEY_VERIFY_MESSAGE,
    };
    use crate::ssh_session::tests::{ok, probe_out, ssh_error, FakeExec, PASSWORD, PERMISSION_DENIED};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    #[test]
    fn install_key_switches_auth() {
        let fx = Fixture::new("svc-install-key");
        set_remote_server_for_test(saved_password_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![ok(ADD_KEY_ADDED), probe_out("")]);
        let spy = Arc::new(GrantSpy::new(exec.clone()));
        let mut deps = fx.deps(&exec, "", true, true);
        deps.exec = spy.clone();
        let key_dir = fx.dir.join("keys");
        let status = install_key(&deps, &fx.host, &key_dir, PASSWORD).unwrap();
        assert_eq!(status.host, HOST);

        let key_path = key_file_path(&key_dir, HOST, 22);
        let key_text = key_path.display().to_string();
        let saved = prefs::stored().remote_server;
        assert_eq!(saved.ssh_auth, SshAuthKind::Key);
        assert_eq!(saved.key_path, key_text);
        let recent = &saved.ssh_recent_servers;
        assert_eq!((recent.len(), recent[0].auth, recent[0].key_path.as_str()), (1, SshAuthKind::Key, key_text.as_str()), "the recent entry switches to key auth too");
        assert!(key_path.exists() && public_key_path(&key_path).exists(), "the key pair is kept on success");

        let calls = exec.calls();
        assert_eq!(calls.len(), 2, "one ADD_KEY and one verification probe");
        assert_eq!(calls[0].args.last().map(String::as_str), Some(ADD_KEY));
        let expected_stdin = format!("{}\n", generated_line());
        assert_eq!(calls[0].stdin.as_deref(), Some(expected_stdin.as_bytes()));
        assert_eq!(calls[1].args.last().map(String::as_str), Some(PROBE));
        assert!(calls[1].args.windows(2).any(|w| w[0] == "-i" && w[1] == key_text), "probe uses the new key");
        assert!(has_option(&calls[1].args, "BatchMode=yes"));
        assert_eq!(spy.grants(), vec![true, false], "only ADD_KEY gets the password grant");
    }

    #[test]
    fn install_key_failure_changes_nothing() {
        let cases = [
            ("add-failed", vec![ok("__LLMIDE_ADDKEY__=failed\n")], "SSH_KEY_INSTALL_FAILED"),
            ("probe-refused", vec![ok(ADD_KEY_ADDED), ssh_error(PERMISSION_DENIED)], "SSH_KEY_VERIFY_FAILED"),
        ];
        for (label, outputs, expected) in cases {
            let fx = Fixture::new(label);
            set_remote_server_for_test(saved_password_block());
            upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
            let before = prefs::stored().remote_server;
            let exec = fake(outputs);
            let deps = fx.deps(&exec, "", true, true);
            let key_dir = fx.dir.join("keys");
            let error = install_key(&deps, &fx.host, &key_dir, PASSWORD).unwrap_err();

            assert_eq!(error.code, expected, "{label}");
            assert_eq!(prefs::stored().remote_server, before, "{label}: preferences changed");
            let key_path = key_file_path(&key_dir, HOST, 22);
            assert!(!key_path.exists(), "{label}: private key left behind");
            assert!(!public_key_path(&key_path).exists(), "{label}: public key left behind");
        }
        // The verification failure has its own fixed text, which the UI shows as-is.
        let fx = Fixture::new("svc-verify-text");
        set_remote_server_for_test(saved_password_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![ok(ADD_KEY_ADDED), ssh_error(PERMISSION_DENIED)]);
        let deps = fx.deps(&exec, "", true, true);
        let error = install_key(&deps, &fx.host, &fx.dir.join("keys"), PASSWORD).unwrap_err();
        assert_eq!(error.message, KEY_VERIFY_MESSAGE);
    }

    #[test]
    fn install_key_needs_password_auth() {
        let fx = Fixture::new("svc-install-key-keyed");
        set_remote_server_for_test(saved_key_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        let refused = install_key(&deps, &fx.host, &fx.dir.join("keys"), PASSWORD).unwrap_err();
        assert_eq!(refused.code, "SSH_KEY_NOT_NEEDED");
        assert_eq!(refused.message, "This server already uses a key.");
        assert!(exec.calls().is_empty());
        assert_eq!(fx.keygens.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn install_key_needs_a_pin_and_a_password() {
        let fx = Fixture::new("svc-install-key-gates");
        set_remote_server_for_test(saved_password_block());
        let exec = fake(vec![]);
        let deps = fx.deps(&exec, "", true, true);
        let no_pin = install_key(&deps, &fx.host, &fx.dir.join("keys"), PASSWORD).unwrap_err();
        assert_eq!(no_pin.code, "SSH_HOST_KEY_UNCONFIRMED");
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let empty = install_key(&deps, &fx.host, &fx.dir.join("keys"), "").unwrap_err();
        assert_eq!(empty.code, "SSH_PASSWORD_REQUIRED");
        assert!(exec.calls().is_empty());
        assert_eq!(fx.keygens.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn install_key_never_leaks_the_password() {
        fn record(seen: &mut Vec<String>, exec: &FakeExec) {
            for call in exec.calls() {
                seen.push(call.args.join(" "));
                seen.push(String::from_utf8_lossy(call.stdin.as_deref().unwrap_or_default()).into_owned());
            }
        }
        let mut seen = Vec::new();

        let fx = Fixture::new("svc-key-leak-ok");
        set_remote_server_for_test(saved_password_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![ok(ADD_KEY_ADDED), probe_out("")]);
        let deps = fx.deps(&exec, "", true, true);
        let status = install_key(&deps, &fx.host, &fx.dir.join("keys"), PASSWORD).unwrap();
        seen.push(serde_json::to_string(&status).unwrap());
        record(&mut seen, &exec);
        drop(deps);
        drop(fx);

        let fx = Fixture::new("svc-key-leak-fail");
        set_remote_server_for_test(saved_password_block());
        upsert_ssh_known_host(pin_text(22, "key-a")).unwrap();
        let exec = fake(vec![ok("__LLMIDE_ADDKEY__=failed\n")]);
        let deps = fx.deps(&exec, "", true, true);
        let error = install_key(&deps, &fx.host, &fx.dir.join("keys"), PASSWORD).unwrap_err();
        seen.push(format!("{} {}", error.code, error.message));
        record(&mut seen, &exec);

        let all = seen.join("\n");
        assert!(!all.contains(PASSWORD), "the password reached an argv, stdin, status or error: {all}");
    }
}
