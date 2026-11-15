//! Tauri commands for SSH server mode. Each one moves its arguments into a blocking task and returns what
//! `ssh_service` returns; this module adds no decisions of its own.
//!
//! The production [`Deps`] also live here. Their only outside input to `ssh` and `ssh-keyscan` is the validated
//! endpoint, passed as separate argv items. Nothing from the webview becomes part of a shell command.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use crate::confirm::herr;
use crate::core_host::{self, CoreHost, SshConnector};
use crate::fs_ops::FsError;
use crate::fsutil;
use crate::host_approval;
use crate::prefs::RemoteServerPrefs;
use crate::secrets;
use crate::ssh_key_install::{self, KEYGEN_FAILED, KEYGEN_MESSAGE};
use crate::ssh_service::{self, Deps, SshServerStatus, SshServerTarget, SshServerTest};
use crate::ssh_session;
use crate::ssh_transport::{SshEndpoint, SystemSshExec};

/// The native dialog that asks before a new host key is pinned. The text is fixed; only the key facts vary.
const ASK_TITLE: &str = "Trust this SSH host key?";
const ASK_ACCEPT: &str = "Trust host key";
/// Seconds `ssh-keyscan` waits for the server; the same bound the deploy scan uses.
const KEYSCAN_TIMEOUT_SECS: &str = "10";
/// The `/health` nonce check on the forwarded port, matching the local core's probe budget.
const HEALTH_TIMEOUT: Duration = Duration::from_millis(800);
const SESSION_FILE: &str = "ssh-session.json";
/// The folder under the desktop data dir that holds the keys this app creates.
const SSH_KEY_DIR: &str = "ssh";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
pub async fn remote_ssh_server_test(target: SshServerTarget, password: Option<String>) -> Result<SshServerTest, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let deps = production_deps()?;
        ssh_service::test(&deps, &target, password.as_deref())
    })
    .await
    .map_err(|_| herr("internal", "the SSH server test did not finish."))?
}

#[tauri::command]
pub async fn remote_ssh_server_confirm(target: SshServerTarget, host_key_type: String, fingerprint: String) -> Result<SshServerTest, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let deps = production_deps()?;
        ssh_service::confirm(&deps, &target, &host_key_type, &fingerprint)
    })
    .await
    .map_err(|_| herr("internal", "the host-key confirmation did not finish."))?
}

#[tauri::command]
pub async fn remote_ssh_server_connect(
    host: tauri::State<'_, CoreHost>,
    target: SshServerTarget,
    password: Option<String>,
) -> Result<SshServerStatus, FsError> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deps = production_deps()?;
        ssh_service::connect(&deps, &host, &target, password.as_deref())
    })
    .await
    .map_err(|_| herr("internal", "the SSH server connect did not finish."))?
}

#[tauri::command]
pub async fn remote_ssh_server_disconnect(host: tauri::State<'_, CoreHost>) -> Result<SshServerStatus, FsError> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ssh_service::disconnect(&host))
        .await
        .map_err(|_| herr("internal", "the SSH server disconnect did not finish."))
}

#[tauri::command]
pub async fn remote_ssh_server_status(host: tauri::State<'_, CoreHost>) -> Result<SshServerStatus, FsError> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ssh_service::status(&host))
        .await
        .map_err(|_| herr("internal", "the SSH server status did not finish."))
}

/// Stops the saved server's core. `target` must be the saved server; `force` stops a core another desktop started.
#[tauri::command]
pub async fn remote_ssh_server_stop(
    host: tauri::State<'_, CoreHost>,
    target: SshServerTarget,
    password: Option<String>,
    force: Option<bool>,
) -> Result<SshServerStatus, FsError> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deps = production_deps()?;
        ssh_service::stop_server(&deps, &host, &target, password.as_deref(), force.unwrap_or(false))
    })
    .await
    .map_err(|_| herr("internal", "the SSH server stop did not finish."))?
}

#[tauri::command]
pub async fn remote_ssh_server_install_key(host: tauri::State<'_, CoreHost>, password: String) -> Result<SshServerStatus, FsError> {
    let host = host.inner().clone();
    // The password moves into the blocking task and is dropped when the task ends.
    tauri::async_runtime::spawn_blocking(move || {
        let deps = production_deps()?;
        let key_dir = key_dir()?;
        ssh_key_install::install_key(&deps, &host, &key_dir, &password)
    })
    .await
    .map_err(|_| herr("internal", "the SSH key install did not finish."))?
}

/// Stops the core and removes the server's releases. `force` uninstalls even when another desktop started the core.
#[tauri::command]
pub async fn remote_ssh_server_uninstall(
    host: tauri::State<'_, CoreHost>,
    password: Option<String>,
    confirm_host: String,
    force: Option<bool>,
) -> Result<SshServerStatus, FsError> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deps = production_deps()?;
        ssh_service::uninstall(&deps, &host, password.as_deref(), &confirm_host, force.unwrap_or(false))
    })
    .await
    .map_err(|_| herr("internal", "the SSH server uninstall did not finish."))?
}

/// The production [`Deps`]: the system ssh, ssh-keyscan, the native dialog, the loopback health probe, the bundle
/// lookup, the secret store and the session file under the desktop data dir.
pub(crate) fn production_deps() -> Result<Deps, FsError> {
    Ok(Deps {
        exec: Arc::new(SystemSshExec),
        scan: Arc::new(|endpoint: &SshEndpoint| keyscan(endpoint)),
        ask: Arc::new(|shown: &str, key_type: &str, fingerprint: &str| ask_host_key(shown, key_type, fingerprint)),
        health: Arc::new(|port: u16| core_host::health_nonce(port, HEALTH_TIMEOUT)),
        bundle: Arc::new(|| bundle_in(core_host::resource_dir().as_deref(), VERSION)),
        keygen: Arc::new(|path: &Path| keygen(path)),
        version: VERSION.to_string(),
        secrets_payload: Arc::new(secrets_payload),
        session_file: session_file()?,
    })
}

/// The connector the core host calls at startup in SSH mode with key auth. It opens the saved link; attaching
/// and the "Start failed" state stay with the core host.
pub(crate) fn startup_connector() -> SshConnector {
    Arc::new(|saved: &RemoteServerPrefs| {
        let deps = production_deps()?;
        ssh_service::open_saved_link(&deps, &target_from_prefs(saved))
    })
}

/// The saved preferences as the service's target. Every field is copied as stored; the service validates it.
pub(crate) fn target_from_prefs(saved: &RemoteServerPrefs) -> SshServerTarget {
    SshServerTarget {
        host: saved.host.clone(),
        port: saved.port,
        user: saved.user.clone(),
        key_path: saved.key_path.clone(),
        auth: saved.ssh_auth,
    }
}

/// ssh-keyscan argv. The host and port are validated by `prepare_endpoint`, so neither can start with '-'.
pub(crate) fn keyscan_args(endpoint: &SshEndpoint) -> Vec<String> {
    vec![
        "-T".to_string(),
        KEYSCAN_TIMEOUT_SECS.to_string(),
        "-p".to_string(),
        endpoint.port.to_string(),
        endpoint.host.clone(),
    ]
}

/// Runs ssh-keyscan with no stdin and no stderr. Its stdout is the scan text; the service picks the key from it.
fn keyscan(endpoint: &SshEndpoint) -> Result<String, FsError> {
    let output = Command::new("ssh-keyscan")
        .args(keyscan_args(endpoint))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| herr("host_key_unavailable", "Could not run ssh-keyscan."))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The argv for the local `ssh-keygen`: an ed25519 key with no passphrase, a fixed comment, and the private key
/// at `path`. The arguments are separate items and nothing is read from the webview.
pub(crate) fn keygen_args(path: &Path) -> Vec<String> {
    vec![
        "-q".to_string(),
        "-t".to_string(),
        "ed25519".to_string(),
        "-N".to_string(),
        String::new(),
        "-C".to_string(),
        "llmide-desktop".to_string(),
        "-f".to_string(),
        path.to_string_lossy().into_owned(),
    ]
}

/// Creates the key pair with the system `ssh-keygen` and returns its public line. Output is discarded, so
/// nothing from the tool reaches an error or a log.
fn keygen(path: &Path) -> Result<String, FsError> {
    let status = Command::new("ssh-keygen")
        .args(keygen_args(path))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(done) if done.success() => {}
        _ => return Err(herr(KEYGEN_FAILED, KEYGEN_MESSAGE)),
    }
    let line = std::fs::read_to_string(ssh_key_install::public_key_path(path))
        .map_err(|_| herr(KEYGEN_FAILED, KEYGEN_MESSAGE))?;
    Ok(line.trim().to_string())
}

/// The folder for the keys this app creates: `ssh` under the desktop data dir, private to the user.
fn key_dir() -> Result<PathBuf, FsError> {
    fsutil::desktop_data_dir()
        .and_then(|d| fsutil::private_dir(&d))
        .map(|d| d.join(SSH_KEY_DIR))
        .map_err(|_| herr("data_dir_unavailable", "This computer's app data folder is not available."))
}

/// The dialog body. It names the key and the endpoint the user is trusting, and says what happens to any other key.
pub(crate) fn host_key_dialog_text(shown: &str, key_type: &str, fingerprint: &str) -> String {
    format!("Trust {key_type} key {fingerprint} for {shown}? LLM-IDE will refuse any other key for this server.")
}

fn ask_host_key(shown: &str, key_type: &str, fingerprint: &str) -> bool {
    crate::confirm::ask(ASK_TITLE, &host_key_dialog_text(shown, key_type, fingerprint), ASK_ACCEPT, true)
}

/// The Linux server bundle: the compat build first (older servers), then the plain one, both from the app's
/// resource dir. Without either, the same lookup a build without resources uses.
pub(crate) fn bundle_in(resources: Option<&Path>, version: &str) -> Option<PathBuf> {
    if let Some(res) = resources {
        let names = [
            format!("llmide-core-{version}-linux-x64-compat.tar.gz"),
            format!("llmide-core-{version}-linux-x64.tar.gz"),
        ];
        for name in names {
            let candidate = res.join("hub").join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    ssh_session::bundle_for(version).map(PathBuf::from)
}

/// The same two secrets and approval key a local core gets, in the stdin payload the core reads. The error text is
/// fixed: the store's own messages can name keychain internals, so they are dropped here.
fn secrets_payload() -> Result<String, FsError> {
    let unavailable = || herr("secrets_unavailable", "This computer's secret store is not available.");
    let backend = secrets::default_backend().map_err(|_| unavailable())?;
    let stored = secrets::load_or_create(backend.as_ref()).map_err(|_| unavailable())?;
    let approval = host_approval::key_hex().map_err(|_| unavailable())?;
    Ok(core_host::secrets_stdin_payload(&stored.jwt_secret, &stored.vault_key, &approval))
}

fn session_file() -> Result<PathBuf, FsError> {
    let dir = fsutil::desktop_data_dir()
        .and_then(|d| fsutil::private_dir(&d))
        .map_err(|_| herr("data_dir_unavailable", "This computer's app data folder is not available."))?;
    Ok(dir.join(SESSION_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prefs::{RemoteServerPrefs, SshAuthKind};
    use crate::ssh_session::bundle_for;
    use crate::ssh_transport::{prepare_endpoint, SshAuth};
    use std::path::{Path, PathBuf};

    const VERSION: &str = "9.8.7";

    /// A scratch folder with a `hub/` subfolder, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("llmide-ssh-cmds-{label}-{nanos}"));
            std::fs::create_dir_all(dir.join("hub")).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &Path) {
        std::fs::write(path, b"tarball").unwrap();
    }

    #[test]
    fn production_scan_argv_is_fixed() {
        let endpoint = prepare_endpoint("example.com", 2222, "alice", SshAuth::Password).unwrap();
        assert_eq!(keyscan_args(&endpoint), vec!["-T", "10", "-p", "2222", "example.com"]);
    }

    #[test]
    fn ask_text_names_host_type_and_fingerprint() {
        let text = host_key_dialog_text("example.com:2222", "ssh-ed25519", "SHA256:abc123");
        assert_eq!(
            text,
            "Trust ssh-ed25519 key SHA256:abc123 for example.com:2222? LLM-IDE will refuse any other key for this server."
        );
    }

    #[test]
    fn connector_target_comes_from_saved_prefs() {
        let saved = RemoteServerPrefs {
            host: "example.com".into(),
            port: 2222,
            user: "alice".into(),
            key_path: "/home/alice/.ssh/id_ed25519".into(),
            ssh_auth: SshAuthKind::Password,
            ..RemoteServerPrefs::default()
        };
        let target = target_from_prefs(&saved);
        assert_eq!(
            (target.host.as_str(), target.port, target.user.as_str(), target.key_path.as_str(), target.auth),
            ("example.com", 2222, "alice", "/home/alice/.ssh/id_ed25519", SshAuthKind::Password)
        );
    }

    #[test]
    fn bundle_prefers_the_compat_name_in_resources() {
        // Takes the shared env lock: a concurrent LLMIDE_HUB_BUNDLE override would make bundle_for return a file here.
        let _serial = crate::ssh_session::tests::BUNDLE_ENV_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let res = TempDir::new("bundle");
        let compat = res.0.join("hub").join(format!("llmide-core-{VERSION}-linux-x64-compat.tar.gz"));
        let plain = res.0.join("hub").join(format!("llmide-core-{VERSION}-linux-x64.tar.gz"));
        touch(&compat);
        touch(&plain);
        assert_eq!(bundle_in(Some(&res.0), VERSION), Some(compat.clone()));
        std::fs::remove_file(&compat).unwrap();
        assert_eq!(bundle_in(Some(&res.0), VERSION), Some(plain.clone()));
        std::fs::remove_file(&plain).unwrap();
        assert_eq!(bundle_in(Some(&res.0), VERSION), bundle_for(VERSION).map(PathBuf::from));
    }

    #[test]
    fn keygen_argv_is_fixed() {
        let path = Path::new("/home/alice/.llmide/ssh/id_llmide_example.com_22");
        assert_eq!(
            keygen_args(path),
            vec![
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "llmide-desktop",
                "-f",
                "/home/alice/.llmide/ssh/id_llmide_example.com_22",
            ]
        );
    }

    const COMMANDS: [&str; 8] = [
        "remote_ssh_server_test",
        "remote_ssh_server_confirm",
        "remote_ssh_server_connect",
        "remote_ssh_server_disconnect",
        "remote_ssh_server_status",
        "remote_ssh_server_stop",
        "remote_ssh_server_uninstall",
        "remote_ssh_server_install_key",
    ];

    #[test]
    fn every_command_is_registered() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let build = std::fs::read_to_string(root.join("build.rs")).unwrap();
        let grants = std::fs::read_to_string(root.join("capabilities").join("default.json")).unwrap();
        let lib = std::fs::read_to_string(root.join("src").join("lib.rs")).unwrap();
        for name in COMMANDS {
            assert!(build.contains(&format!("\"{name}\"")), "build.rs COMMANDS misses {name}");
            let grant = format!("\"allow-{}\"", name.replace('_', "-"));
            assert!(grants.contains(&grant), "default.json misses {grant}");
            assert!(lib.contains(&format!("ssh_cmds::{name},")), "lib.rs handler list misses {name}");
        }
    }
}
