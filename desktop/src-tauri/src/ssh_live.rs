//! Live end-to-end check for SSH server mode. A developer runs it by hand against a real Linux server.
//!
//! The one test is `#[ignore]` and returns at once unless `LLMIDE_LIVE_SSH_HOST` is set, so no CI run reaches a
//! server. The steps call the production service with the production transport: the same ssh argv, pinned
//! known_hosts, forward and `/health` nonce check the app uses. Only these are replaced, so the developer's
//! machine keeps its preferences and secrets: the host-key dialog (always yes, the key is printed), the secrets
//! (three random values, once per run), the session file and key folder (a temp dir), and the preferences
//! (memory only, never saved).
//!
//! ```text
//! LLMIDE_LIVE_SSH_HOST=... LLMIDE_LIVE_SSH_PORT=22 LLMIDE_LIVE_SSH_USER=... LLMIDE_LIVE_SSH_PASSWORD=... \
//!   cargo test --lib ssh_live::live_end_to_end -- --ignored --nocapture
//! ```
//!
//! Optional: `LLMIDE_LIVE_SSH_KEY=<private key path>` uses key auth instead of the password;
//! `LLMIDE_LIVE_SSH_INSTALL_KEY=1` (password auth only) runs step 23; `LLMIDE_LIVE_SSH_UNINSTALL=1` runs step 25.
//!
//! Steps 9 to 22 work in a random folder under the server's home folder and remove it again. The project steps
//! (15 to 21) create their project inside that folder, so the same cleanup removes it. The terminal step shows
//! the app's "Allow terminal access?" dialog once, and waits for your answer: press "Allow terminal". A failed run
//! removes the folder on a best-effort basis.
//!
//! Nothing this module prints includes the password, a token, a generated secret or a nonce.

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody, Response};

use crate::confirm::herr;
use crate::core_env;
use crate::core_host::{self, CoreHost};
use crate::fs_ops::{fs_delete, fs_list_dir, fs_read_file, fs_rename, fs_write_file, FsError};
use crate::fs_watch::{fs_watch_set, fs_watch_start, fs_watch_stop};
use crate::fsutil;
use crate::git::git_status;
use crate::project::project_active;
use crate::project_layout::{project_memory, project_paths, project_rebuild_folders};
use crate::project_search::{project_search_start, Query};
use crate::prefs::{self, prefs_guard, set_remote_server_for_test, RemoteServerPrefs, ServerMode, SshAuthKind};
use crate::remote::temp_ssh_dir;
use crate::repo_clone::repo_clone;
use crate::ssh_cmds;
use crate::ssh_key_install;
use crate::ssh_service::{self, Deps, SshServerTarget, SshServerTest};
use crate::ssh_session;
use crate::ssh_workspace_cmds::{
    remote_ssh_project_create, remote_ssh_workspace_close, remote_ssh_workspace_forget,
    remote_ssh_workspace_list_dirs, remote_ssh_workspace_mkdir, remote_ssh_workspace_open,
    remote_ssh_workspace_recent,
};
use crate::workspace_backend;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
/// The local ports the forward may use, as `ssh_session` picks them.
const LOCAL_PORTS: std::ops::RangeInclusive<u16> = 3456..=3459;
const ORIGIN_UNKNOWN: &str = "https://evil.example";
const BUNDLE_HINT: &str = ssh_service::BUNDLE_MISSING_TEXT;
/// How long each Explorer event, search or terminal exit may take before its step fails.
const EVENT_WAIT: Duration = Duration::from_secs(5);
const SEARCH_WAIT: Duration = Duration::from_secs(10);
const TERMINAL_WAIT: Duration = Duration::from_secs(10);

/// What the developer typed, read once. The login fields change only when step 9 switches to key auth.
struct Live {
    host: String,
    port: u16,
    user: String,
    kind: SshAuthKind,
    password: Option<String>,
    key_path: String,
    install_key: bool,
    uninstall: bool,
}

impl Live {
    /// `Ok(None)` when `LLMIDE_LIVE_SSH_HOST` is unset. Errors name the variable, never its value.
    fn read() -> Result<Option<Self>, String> {
        let Some(host) = env_value("LLMIDE_LIVE_SSH_HOST") else {
            return Ok(None);
        };
        let port = match env_value("LLMIDE_LIVE_SSH_PORT") {
            Some(text) => text.parse::<u16>().map_err(|_| "LLMIDE_LIVE_SSH_PORT is not a port number".to_string())?,
            None => 22,
        };
        let user = env_value("LLMIDE_LIVE_SSH_USER").ok_or("LLMIDE_LIVE_SSH_USER is not set")?;
        let (kind, password, key_path) = match env_value("LLMIDE_LIVE_SSH_KEY") {
            Some(path) => (SshAuthKind::Key, None, path),
            None => {
                let password = env_value("LLMIDE_LIVE_SSH_PASSWORD")
                    .ok_or("set LLMIDE_LIVE_SSH_PASSWORD, or LLMIDE_LIVE_SSH_KEY for key auth")?;
                (SshAuthKind::Password, Some(password), String::new())
            }
        };
        Ok(Some(Self {
            host,
            port,
            user,
            kind,
            password,
            key_path,
            install_key: env_value("LLMIDE_LIVE_SSH_INSTALL_KEY").as_deref() == Some("1"),
            uninstall: env_value("LLMIDE_LIVE_SSH_UNINSTALL").as_deref() == Some("1"),
        }))
    }

    fn target(&self) -> SshServerTarget {
        SshServerTarget {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            key_path: self.key_path.clone(),
            auth: self.kind,
        }
    }

    /// The password for calls that need one. Key auth never sends a password.
    fn password(&self) -> Option<&str> {
        match self.kind {
            SshAuthKind::Password => self.password.as_deref(),
            SshAuthKind::Key => None,
        }
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

/// A failed step: the code and the fixed text the service (or this harness) gives. Never a secret.
struct Failed {
    code: String,
    message: String,
}

impl From<FsError> for Failed {
    fn from(error: FsError) -> Self {
        Self { code: error.code.to_string(), message: error.message }
    }
}

fn failed(code: &str, message: impl Into<String>) -> Failed {
    Failed { code: code.to_string(), message: message.into() }
}

fn expect(ok: bool, code: &str, message: impl Into<String>) -> Result<(), Failed> {
    if ok {
        Ok(())
    } else {
        Err(failed(code, message))
    }
}

/// A throwaway account with a random password. Nothing here is a real credential.
struct Account {
    email: String,
    password: String,
}

enum Outcome {
    Done,
    Skipped(Option<&'static str>),
}

type StepFn = fn(&mut Run) -> Result<Outcome, Failed>;

/// Everything the steps share. Dropping it removes the temp folder that holds the key and the session file.
struct Run {
    live: Live,
    deps: Deps,
    host: CoreHost,
    root: PathBuf,
    local_url: String,
    observed: Option<SshServerTest>,
    before: Option<(Option<u32>, Option<String>)>,
    account: Option<Account>,
    /// Name (under the home folder) of the test folder while it exists on the server.
    test_folder: Option<String>,
    /// Absolute path of the test folder once the helper has opened it.
    folder_root: Option<String>,
}

impl Run {
    fn new(live: Live) -> Result<Self, Failed> {
        let bundle = live_bundle().ok_or_else(|| failed("SSH_BUNDLE_MISSING", BUNDLE_HINT))?;
        // Production wiring for exec, scan, health, keygen and version. Its session file is replaced below.
        // NOTE: production_deps() also creates the app's data folder if it is missing; nothing is written there.
        let mut deps = ssh_cmds::production_deps()?;
        let payload = core_host::secrets_stdin_payload(&random_hex()?, &random_hex()?, &random_hex()?);
        deps.secrets_payload = Arc::new(move || Ok(payload.clone()));
        deps.ask = Arc::new(|shown: &str, key_type: &str, fingerprint: &str| {
            println!("  trusting {key_type} key {fingerprint} for {shown} (live check: answered yes)");
            true
        });
        deps.bundle = Arc::new(move || Some(bundle.clone()));
        let root = temp_ssh_dir("live-check")?;
        // The Explorer path finds the live link through the app's one core host (`crate::CORE`), which the app
        // registers at startup; register this run's host the same way so the workspace steps use its link.
        let host = CoreHost::new();
        let _ = crate::CORE.set(host.clone());
        // Built before the folder is used, so a failure below still removes the folder through Drop.
        let mut run = Self {
            live,
            deps,
            host,
            root,
            local_url: String::new(),
            observed: None,
            before: None,
            account: None,
            test_folder: None,
            folder_root: None,
        };
        std::fs::create_dir_all(run.root.join("state"))
            .map_err(|_| failed("LIVE_SETUP", "could not create the temp folder"))?;
        run.deps.session_file = run.root.join("state").join("ssh-session.json");
        run.host.set_mode(ServerMode::Ssh);
        Ok(run)
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        // Best effort: the folder holds the throwaway private key and the pinned known_hosts line.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The Linux bundle for this version: the app's resource folder first, then the staged folders of the repository.
/// The repository root comes from `CARGO_MANIFEST_DIR`, because `cargo test` runs in `desktop/src-tauri`.
fn live_bundle() -> Option<PathBuf> {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let names = [
        format!("llmide-core-{VERSION}-linux-x64-compat.tar.gz"),
        format!("llmide-core-{VERSION}-linux-x64.tar.gz"),
    ];
    ssh_cmds::bundle_in(Some(&desktop.join("resources")), VERSION)
        .or_else(|| ssh_session::search_bundle(desktop.parent()?, &names))
}

fn random_hex() -> Result<String, FsError> {
    core_host::random_nonce().map_err(|message| herr("LIVE_RANDOM", message))
}

fn new_account() -> Result<Account, FsError> {
    let tag = random_hex()?;
    Ok(Account { email: format!("live-check-{}@example.invalid", &tag[..12]), password: random_hex()? })
}

/// The parts of an HTTP answer the checks read. The body can hold a token, so it is parsed and never printed.
struct Reply {
    status: u16,
    allow_origin: Option<String>,
    body: String,
}

impl Reply {
    fn json(&self) -> Option<Value> {
        serde_json::from_str(&self.body).ok()
    }

    /// The `error.code` of an API error envelope. The message is never shown.
    fn error_code(&self) -> String {
        self.json()
            .and_then(|value| value["error"]["code"].as_str().map(str::to_string))
            .unwrap_or_else(|| "no error code".to_string())
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().redirects(0).timeout(HTTP_TIMEOUT).build()
}

fn send(request: ureq::Request, body: Option<String>) -> Result<Reply, Failed> {
    let sent = match body {
        Some(text) => request.set("Content-Type", "application/json").send_string(&text),
        None => request.call(),
    };
    let response = match sent {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(_)) => return Err(failed("LIVE_HTTP", "the forwarded core did not answer")),
    };
    Ok(Reply {
        status: response.status(),
        allow_origin: response.header("access-control-allow-origin").map(str::to_string),
        body: response.into_string().unwrap_or_default(),
    })
}

fn post_json(url: &str, body: Value) -> Result<Reply, Failed> {
    send(agent().post(url), Some(body.to_string()))
}

fn register(local_url: &str, account: &Account) -> Result<Reply, Failed> {
    post_json(
        &format!("{local_url}/auth/register"),
        json!({ "email": account.email, "password": account.password, "displayName": "Live check" }),
    )
}

/// Signs in the way the desktop UI does and returns the access token. The token is only handed to the caller.
fn sign_in(local_url: &str, account: &Account) -> Result<String, Failed> {
    let reply = post_json(
        &format!("{local_url}/auth/login"),
        json!({ "email": account.email, "password": account.password }),
    )?;
    expect(
        reply.status == 200,
        "LOGIN_FAILED",
        format!("sign-in answered HTTP {} ({})", reply.status, reply.error_code()),
    )?;
    reply
        .json()
        .and_then(|value| value["accessToken"].as_str().map(str::to_string))
        .ok_or_else(|| failed("LOGIN_INVALID", "the sign-in reply had no access token"))
}

fn me(local_url: &str, token: &str) -> Result<(), Failed> {
    let request = agent().get(&format!("{local_url}/auth/me")).set("Authorization", &format!("Bearer {token}"));
    let reply = send(request, None)?;
    expect(
        reply.status == 200,
        "ME_FAILED",
        format!("/auth/me answered HTTP {} ({})", reply.status, reply.error_code()),
    )
}

/// A CORS preflight for GET on `/health`. Returns the origin the core echoed, if it echoed one.
fn preflight(local_url: &str, origin: &str) -> Result<Option<String>, Failed> {
    let request = agent()
        .request("OPTIONS", &format!("{local_url}/health"))
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "GET");
    Ok(send(request, None)?.allow_origin)
}

fn check_local_url(url: &str) -> Result<(), Failed> {
    let port = url.strip_prefix("http://127.0.0.1:").and_then(|text| text.parse::<u16>().ok());
    expect(
        port.is_some_and(|port| LOCAL_PORTS.contains(&port)),
        "LOCAL_URL_UNEXPECTED",
        "the forward is not on 127.0.0.1 in the range 3456 to 3459",
    )
}

fn opt(value: &Option<String>) -> String {
    value.clone().unwrap_or_else(|| "none".to_string())
}

fn step_test(run: &mut Run) -> Result<Outcome, Failed> {
    let seen = ssh_service::test(&run.deps, &run.live.target(), run.live.password())?;
    expect(!seen.trusted, "UNEXPECTED_PIN", "a fresh run found the server's key already trusted")?;
    println!("  host key offered: {} {}", seen.host_key_type, seen.fingerprint);
    run.observed = Some(seen);
    Ok(Outcome::Done)
}

fn step_confirm_and_test(run: &mut Run) -> Result<Outcome, Failed> {
    let seen = run.observed.clone().ok_or_else(|| failed("LIVE_ORDER", "step 1 did not record a host key"))?;
    let confirmed = ssh_service::confirm(&run.deps, &run.live.target(), &seen.host_key_type, &seen.fingerprint)?;
    expect(confirmed.trusted, "CONFIRM_FAILED", "the confirmed key was not saved")?;
    let trusted = ssh_service::test(&run.deps, &run.live.target(), run.live.password())?;
    expect(trusted.trusted && !trusted.changed, "NOT_TRUSTED", "the server's key is still not trusted after confirm")?;
    println!("  os: {}, arch: {}", opt(&trusted.os), opt(&trusted.arch));
    println!("  free disk: {} MB", trusted.free_mb.map_or("unknown".to_string(), |mb| mb.to_string()));
    println!("  installed core version: {}", opt(&trusted.installed_version));
    println!("  claude: {}", opt(&trusted.claude));
    println!("  glibc: {}", opt(&trusted.glibc));
    Ok(Outcome::Done)
}

fn step_connect(run: &mut Run) -> Result<Outcome, Failed> {
    let started = Instant::now();
    let status = ssh_service::connect(&run.deps, &run.host, &run.live.target(), run.live.password())?;
    let took = started.elapsed();
    expect(status.link == "connected", "CONNECT_FAILED", format!("the link is {}, not connected", status.link))?;
    check_local_url(&status.local_url)?;
    println!("  connected in {:.1} s, forward at {}", took.as_secs_f64(), status.local_url);
    run.local_url = status.local_url;
    // The server must now run the bundle this build holds, not just a release with the same version number.
    let local = (run.deps.bundle)().ok_or_else(|| failed("SSH_BUNDLE_MISSING", BUNDLE_HINT))?;
    let local_sha = ssh_session::bundle_sha256(&local)?;
    let server_sha = ssh_service::server_bundle_sha(&run.deps, run.live.password())?.unwrap_or_default();
    println!("  server bundle sha: {} (local {})", short_sha(&server_sha), short_sha(&local_sha));
    expect(
        !server_sha.is_empty() && server_sha == local_sha,
        "BUNDLE_MISMATCH",
        "the server does not run the bundle this build holds",
    )?;
    Ok(Outcome::Done)
}

/// The first 12 hex characters of a bundle sha, enough to tell two bundles apart in a log.
fn short_sha(sha: &str) -> String {
    if sha.is_empty() {
        return "none".to_string();
    }
    sha.chars().take(12).collect()
}

fn step_health(run: &mut Run) -> Result<Outcome, Failed> {
    let reply = send(agent().get(&format!("{}/health", run.local_url)), None)?;
    expect(reply.status == 200, "HEALTH_FAILED", format!("/health answered HTTP {}", reply.status))?;
    let body = reply.json().ok_or_else(|| failed("HEALTH_INVALID", "/health did not return JSON"))?;
    println!("  status: {}", body["status"].as_str().unwrap_or("missing"));
    println!("  checks.db: {}", body["checks"]["db"]);
    println!("  checks.claude: {}", body["checks"]["claude"]);
    Ok(Outcome::Done)
}

fn step_cors(run: &mut Run) -> Result<Outcome, Failed> {
    for origin in core_env::webview_origins(fsutil::current_os()) {
        let echoed = preflight(&run.local_url, origin)?;
        expect(
            echoed.as_deref() == Some(*origin),
            "CORS_NOT_ECHOED",
            format!("{origin} is not echoed in Access-Control-Allow-Origin"),
        )?;
        println!("  {origin}: echoed");
    }
    let refused = preflight(&run.local_url, ORIGIN_UNKNOWN)?;
    expect(refused.is_none(), "CORS_ECHOED_UNKNOWN", format!("{ORIGIN_UNKNOWN} was echoed"))?;
    println!("  {ORIGIN_UNKNOWN}: not echoed");
    Ok(Outcome::Done)
}

fn step_account(run: &mut Run) -> Result<Outcome, Failed> {
    let account = new_account()?;
    let registered = register(&run.local_url, &account)?;
    expect(
        registered.status == 201,
        "REGISTER_FAILED",
        format!("register answered HTTP {} ({})", registered.status, registered.error_code()),
    )?;
    println!("  account registered");
    let token = sign_in(&run.local_url, &account)?;
    me(&run.local_url, &token)?;
    println!("  signed in, /auth/me answered 200");
    run.account = Some(account);

    // Reported, not checked: a later change closes open registration on purpose.
    let second = new_account()?;
    let reply = register(&run.local_url, &second)?;
    let verdict = if reply.status == 201 { "accepted" } else { "refused" };
    println!("  second registration: {verdict} (HTTP {})", reply.status);
    Ok(Outcome::Done)
}

fn step_disconnect_and_check(run: &mut Run) -> Result<Outcome, Failed> {
    let status = ssh_service::disconnect(&run.host);
    expect(status.link == "stopped", "DISCONNECT_FAILED", format!("the link is {}, not stopped", status.link))?;
    let state = ssh_service::server_core_state(&run.deps, run.live.password())?;
    expect(state.running, "CORE_NOT_RUNNING", "the server core stopped when the forward closed")?;
    println!("  server core running, pid {}", state.pid.map_or("unknown".to_string(), |pid| pid.to_string()));
    run.before = Some((state.pid, state.nonce));
    Ok(Outcome::Done)
}

fn step_reconnect(run: &mut Run) -> Result<Outcome, Failed> {
    let status = ssh_service::connect(&run.deps, &run.host, &run.live.target(), run.live.password())?;
    expect(status.link == "connected", "RECONNECT_FAILED", format!("the link is {}, not connected", status.link))?;
    check_local_url(&status.local_url)?;
    run.local_url = status.local_url;
    let state = ssh_service::server_core_state(&run.deps, run.live.password())?;
    let (pid, nonce) = run.before.take().ok_or_else(|| failed("LIVE_ORDER", "step 7 did not record the core"))?;
    let same = pid.is_some() && state.pid == pid && nonce.is_some() && state.nonce == nonce;
    expect(same, "CORE_REPLACED", "the server started a new core instead of reusing the running one")?;
    println!("  same server core reused");
    let account = run.account.as_ref().ok_or_else(|| failed("LIVE_ORDER", "step 6 did not create an account"))?;
    let token = sign_in(&run.local_url, account)?;
    me(&run.local_url, &token)?;
    println!("  sign-in from step 6 still works");
    Ok(Outcome::Done)
}

/// Runs one async service call to completion on the Tauri runtime, the way the app runs its commands.
fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// A request for a service function, built from the same JSON shape the page sends.
fn request<T: DeserializeOwned>(value: Value) -> Result<T, Failed> {
    serde_json::from_value(value).map_err(|_| failed("LIVE_REQUEST", "a live check request did not match its type"))
}

/// A Tauri channel whose batches land in a queue the step reads with a timeout.
fn queue<T>() -> (Channel<T>, mpsc::Receiver<InvokeResponseBody>) {
    let (sender, receiver) = mpsc::channel();
    let sender = Mutex::new(sender);
    let channel = Channel::new(move |body| {
        if let Ok(sender) = sender.lock() {
            let _ = sender.send(body);
        }
        Ok(())
    });
    (channel, receiver)
}

/// The JSON a channel sent, or `None` for a raw batch that is not JSON.
fn json_of(body: InvokeResponseBody) -> Option<Value> {
    match body {
        InvokeResponseBody::Json(text) => serde_json::from_str(&text).ok(),
        InvokeResponseBody::Raw(bytes) => serde_json::from_slice(&bytes).ok(),
    }
}

fn write_text(path: &str, text: &str) -> Result<(), Failed> {
    block(fs_write_file(request(json!({"path": path, "text": text}))?))?;
    Ok(())
}

/// The names in a folder of the open server folder (`""` is its root).
fn listed_names(path: &str) -> Result<Vec<String>, Failed> {
    let reply = block(fs_list_dir(request(json!({"path": path}))?))?;
    Ok(reply["entries"]
        .as_array()
        .map(|entries| entries.iter().filter_map(|entry| entry["name"].as_str().map(str::to_string)).collect())
        .unwrap_or_default())
}

/// The `(path, hit count)` pairs of one search chunk.
fn chunk_files(chunk: &Value) -> Vec<(String, usize)> {
    chunk["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|file| {
            let path = file["path"].as_str().unwrap_or_default().to_string();
            (path, file["hits"].as_array().map_or(0, Vec::len))
        })
        .collect()
}

/// A random folder under the home folder with a `work` folder inside, which is opened as the server folder. The
/// outer folder lets the close step delete `work` through the helper (a project root cannot delete itself); the
/// outer folder is removed by the test-only cleanup command. The name is random, so it cannot collide.
fn step_workspace_open(run: &mut Run) -> Result<Outcome, Failed> {
    let tag: String = random_hex()?.chars().take(8).collect();
    let name = format!("llmide-live-{tag}");
    let made = block(remote_ssh_workspace_mkdir("~".to_string(), name.clone()))?;
    let outer = made["path"]
        .as_str()
        .ok_or_else(|| failed("LIVE_REPLY", "mkdir did not return the new folder's path"))?
        .to_string();
    run.test_folder = Some(outer.clone());
    let home = block(remote_ssh_workspace_list_dirs("~".to_string(), false))?;
    let listed = home["entries"]
        .as_array()
        .is_some_and(|entries| entries.iter().any(|entry| entry["name"].as_str() == Some(name.as_str())));
    expect(listed, "LIST_MISSING", "the new folder is not in the home folder listing")?;
    let work = block(remote_ssh_workspace_mkdir(outer, "work".to_string()))?;
    let path = work["path"]
        .as_str()
        .ok_or_else(|| failed("LIVE_REPLY", "mkdir did not return the work folder's path"))?
        .to_string();
    let info = block(remote_ssh_workspace_open(path))?;
    expect(
        project_active().is_some_and(|active| active.root == info.root),
        "NOT_ACTIVE",
        "project_active does not report the opened folder",
    )?;
    println!("  folder {name} created under the home folder and opened");
    run.folder_root = Some(info.root);
    Ok(Outcome::Done)
}

fn step_files(_run: &mut Run) -> Result<Outcome, Failed> {
    write_text("hello.txt", "hello world\n")?;
    expect(
        listed_names("")?.iter().any(|name| name == "hello.txt"),
        "LIST_MISSING",
        "hello.txt is not in the folder listing",
    )?;
    let read = block(fs_read_file(request(json!({"path": "hello.txt"}))?))?;
    expect(
        read["text"].as_str() == Some("hello world\n"),
        "READ_MISMATCH",
        "the file read back differs from what was written",
    )?;
    block(fs_rename(request(json!({"from": "hello.txt", "to": "greeting.txt"}))?))?;
    let names = listed_names("")?;
    expect(
        names.iter().any(|name| name == "greeting.txt") && !names.iter().any(|name| name == "hello.txt"),
        "RENAME_MISMATCH",
        "the rename is not in the folder listing",
    )?;
    println!("  write, list, read back and rename: ok");
    match block(fs_delete("greeting.txt".to_string())) {
        Ok(_) => println!("  delete: moved to the server Trash"),
        Err(error) if error.code == "trash_unavailable" => {
            println!("  delete: trash_unavailable (expected on servers without a desktop Trash)")
        }
        Err(error) => return Err(error.into()),
    }
    Ok(Outcome::Done)
}

/// The helper's `git_status` must answer `not_a_repo` for a plain folder, which proves the error code survives the
/// channel. Without git on the server the helper reports it and the step is skipped.
fn step_git(_run: &mut Run) -> Result<Outcome, Failed> {
    let available = workspace_backend::remote().helper_git();
    println!("  git: {}", match available {
        Some(true) => "available",
        Some(false) => "missing",
        None => "unknown (no live helper channel)",
    });
    match available {
        Some(true) => {}
        Some(false) => return Ok(Outcome::Skipped(Some("git is not installed on this server"))),
        None => return Err(failed("GIT_UNKNOWN", "the helper channel is not up")),
    }
    write_text("notes.txt", "not a repository\n")?;
    match block(git_status()) {
        Err(error) if error.code == "not_a_repo" => println!("  git_status: not_a_repo"),
        Ok(_) => return Err(failed("GIT_UNEXPECTED", "git_status found a repository above the test folder")),
        Err(error) => return Err(error.into()),
    }
    Ok(Outcome::Done)
}

fn step_search(_run: &mut Run) -> Result<Outcome, Failed> {
    write_text("needle.txt", "findme\n")?;
    let (channel, events) = queue::<Value>();
    let started = block(project_search_start(request::<Query>(json!({"query": "findme"}))?, channel))?;
    let deadline = Instant::now() + SEARCH_WAIT;
    let mut files: Vec<(String, usize)> = Vec::new();
    let done = loop {
        let body = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| failed("SEARCH_TIMEOUT", "the search did not finish within 10 s"))?;
        let Some(event) = json_of(body) else { continue };
        if event["id"].as_u64() != Some(started.id) {
            continue;
        }
        match event["type"].as_str() {
            Some("chunk") => files.extend(chunk_files(&event)),
            Some("done") => break event,
            _ => {}
        }
    };
    expect(done["matches"].as_u64() == Some(1), "SEARCH_COUNT", "the search did not find exactly one match")?;
    expect(
        files == [("needle.txt".to_string(), 1)],
        "SEARCH_FILES",
        "the one match is not in needle.txt",
    )?;
    println!("  search for findme: one match in needle.txt, then done");
    Ok(Outcome::Done)
}

/// Starts the watch, writes a file, and waits for a batch that names it. The watch is stopped on every path.
fn step_watch(_run: &mut Run) -> Result<Outcome, Failed> {
    let (channel, batches) = queue::<Value>();
    block(fs_watch_start(channel))?;
    // Starting a watch watches nothing yet: the Explorer always names the folders next, as here (the root is "").
    block(fs_watch_set(vec![String::new()]))?;
    let result = watch_for_new_file(&batches);
    let _ = block(fs_watch_stop());
    result?;
    println!("  watch: a batch named watched.txt arrived, then the watch stopped");
    Ok(Outcome::Done)
}

fn watch_for_new_file(batches: &mpsc::Receiver<InvokeResponseBody>) -> Result<(), Failed> {
    write_text("watched.txt", "seen\n")?;
    let deadline = Instant::now() + EVENT_WAIT;
    loop {
        let body = batches
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| failed("WATCH_TIMEOUT", "no watch batch named watched.txt within 5 s"))?;
        let Some(batch) = json_of(body) else { continue };
        let named = batch["files"]
            .as_array()
            .is_some_and(|files| files.iter().any(|file| file.as_str() == Some("watched.txt")));
        if named {
            return Ok(());
        }
    }
}

/// Opens a shell through the same launch function `pty_spawn` uses in SSH mode, runs `pwd` and `exit`, and checks
/// the opened folder's path in the output. The folder line is read by the terminal script with echo off.
fn step_terminal(run: &mut Run) -> Result<Outcome, Failed> {
    // NOTE: the terminal asks for consent in a native dialog with no timeout, so an unattended run would hang;
    // the step runs only when someone is there to press "Allow terminal".
    if std::env::var("LLMIDE_LIVE_SSH_TERMINAL").as_deref() != Ok("1") {
        return Ok(Outcome::Skipped(Some("set LLMIDE_LIVE_SSH_TERMINAL=1 and answer the consent dialog")));
    }
    let root = run.folder_root.clone().ok_or_else(|| failed("LIVE_ORDER", "the workspace step did not open a folder"))?;
    let (output_channel, output) = queue::<Response>();
    let (exit_channel, exits) = queue::<Value>();
    let spawned = block(crate::pty_spawn(80, 24, output_channel, exit_channel))
        .map_err(|message| failed("TERMINAL_FAILED", message))?;
    let session = terminal_session(spawned.id, &output, &exits);
    let _ = crate::pty::kill(spawned.id);
    let bytes = session?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    expect(text.contains(&root), "TERMINAL_FOLDER", "the terminal did not print the opened folder")?;
    let echoed = text.find(&root).is_some_and(|at| text.find("pwd").is_none_or(|typed| at < typed));
    println!("  terminal printed the opened folder");
    println!("  folder echo: {}", if echoed { "yes" } else { "no" });
    Ok(Outcome::Done)
}

/// Writes the command, then collects output until the shell reports its exit or the wait runs out.
fn terminal_session(
    id: u32,
    output: &mpsc::Receiver<InvokeResponseBody>,
    exits: &mpsc::Receiver<InvokeResponseBody>,
) -> Result<Vec<u8>, Failed> {
    crate::pty::write(id, "pwd; exit\n").map_err(|message| failed("TERMINAL_WRITE", message))?;
    let deadline = Instant::now() + TERMINAL_WAIT;
    let mut bytes = Vec::new();
    let take = |body: InvokeResponseBody, bytes: &mut Vec<u8>| {
        if let InvokeResponseBody::Raw(batch) = body {
            crate::pty::ack(id, batch.len() as u64);
            bytes.extend(batch);
        }
    };
    loop {
        if exits.try_recv().is_ok() {
            while let Ok(body) = output.try_recv() {
                take(body, &mut bytes);
            }
            return Ok(bytes);
        }
        if Instant::now() >= deadline {
            return Err(failed("TERMINAL_TIMEOUT", "the terminal did not exit within 10 s"));
        }
        if let Ok(body) = output.recv_timeout(Duration::from_millis(100)) {
            take(body, &mut bytes);
        }
    }
}

/// The project the project steps create inside the test folder. It goes away with the test folder.
const LIVE_PROJECT: &str = "live-project";

/// The id the UI registers a project under: `p` and the first 32 hex characters of the SHA-256 of its root. This is
/// `projectIdFor` in the UI (the Doc Gen id), so the core sees the same id the desktop sends.
fn project_id_for(root: &str) -> String {
    let hex: String = Sha256::digest(root.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
    format!("p{}", &hex[..32])
}

/// The root of the open server project, or a failed step when none is open.
fn open_project_root() -> Result<String, Failed> {
    project_active().map(|active| active.root).ok_or_else(|| failed("NOT_ACTIVE", "no project is open"))
}

/// A core call made the way the page makes it: signed in as the step 6 account, with the access token as a bearer.
fn core_post(run: &Run, path: &str, body: Value) -> Result<Reply, Failed> {
    let account = run.account.as_ref().ok_or_else(|| failed("LIVE_ORDER", "step 6 did not create an account"))?;
    let token = sign_in(&run.local_url, account)?;
    send(agent().post(&format!("{}{path}", run.local_url)).set("Authorization", &format!("Bearer {token}")), Some(body.to_string()))
}

/// Step 15: the work folder has no `system/project.json`, so Paths says it is not a project and Rebuild refuses it
/// with `not_a_project`.
fn step_project_plain(_run: &mut Run) -> Result<Outcome, Failed> {
    let paths = block(project_paths()).map_err(|error| failed("PATHS_FAILED", error.message()))?;
    expect(paths["isProject"] == json!(false), "PLAIN_IS_PROJECT", "a folder without system/project.json reports isProject")?;
    // The entry point returns the message text only; the helper's `not_a_project` copy is the one this matches.
    match block(project_rebuild_folders()) {
        Err(error) if error.message().contains("This folder is not an LLM-IDE project.") => {
            println!("  paths: isProject false; rebuild: not_a_project");
        }
        Ok(()) => return Err(failed("REBUILD_PLAIN", "Rebuild ran on a folder that is not a project")),
        Err(error) => return Err(failed("REBUILD_FAILED", error.message())),
    }
    Ok(Outcome::Done)
}

/// Step 16: New project creates `llmide-live-<hex>/live-project` and opens it. The same name again is refused.
fn step_project_create(run: &mut Run) -> Result<Outcome, Failed> {
    let outer = run.test_folder.clone().ok_or_else(|| failed("LIVE_ORDER", "the test folder name is missing"))?;
    let created = block(remote_ssh_project_create(outer.clone(), LIVE_PROJECT.to_string()))?;
    expect(
        created.root.starts_with(&outer) && created.root.ends_with(LIVE_PROJECT),
        "PROJECT_ROOT",
        "New project did not create the folder inside the test folder",
    )?;
    let info = block(remote_ssh_workspace_open(created.root.clone()))?;
    expect(
        project_active().is_some_and(|active| active.root == info.root),
        "NOT_ACTIVE",
        "project_active does not report the new project",
    )?;
    let again = block(remote_ssh_project_create(outer, LIVE_PROJECT.to_string()));
    expect(again.is_err(), "CREATE_TWICE", "New project accepted a name that already exists")?;
    println!("  new project created under the test folder, opened, and a repeat name refused");
    Ok(Outcome::Done)
}

/// Step 17: the new project reports `isProject` and an id, and Memory lists its files.
fn step_project_paths(_run: &mut Run) -> Result<Outcome, Failed> {
    let paths = block(project_paths()).map_err(|error| failed("PATHS_FAILED", error.message()))?;
    expect(paths["isProject"] == json!(true), "PATHS_NOT_PROJECT", "Paths does not report the new project")?;
    let id = paths["id"].as_str().unwrap_or_default();
    expect(!id.is_empty(), "PATHS_NO_ID", "Paths reports no project id")?;
    let memory = block(project_memory()).map_err(|error| failed("MEMORY_FAILED", error.message()))?;
    expect(memory.is_object(), "MEMORY_SHAPE", "Memory did not return an object")?;
    println!("  paths: isProject true with an id; memory: ok");
    Ok(Outcome::Done)
}

/// Step 18: Rebuild missing folders runs write-if-absent, so an edited scaffolded file keeps its text.
fn step_project_rebuild(_run: &mut Run) -> Result<Outcome, Failed> {
    let edited = "edited by the live check\n";
    write_text("CLAUDE.md", edited)?;
    block(project_rebuild_folders()).map_err(|error| failed("REBUILD_FAILED", error.message()))?;
    let read = block(fs_read_file(request(json!({"path": "CLAUDE.md"}))?))?;
    expect(read["text"].as_str() == Some(edited), "REBUILD_OVERWROTE", "Rebuild changed an existing file")?;
    println!("  rebuild missing folders: ok, the edited CLAUDE.md is unchanged");
    Ok(Outcome::Done)
}

/// Step 19: the same register and install-skills calls the welcome page makes, through the forward.
// NOTE: the registration row lives in the server core's database, not in the test folder. The folder cleanup
// (`rm -rf` of llmide-live-<hex>) does not remove it; uninstall (step 25) does. A run that fails before step 25 leaves
// the row behind as a stale project entry on the server.
fn step_project_register(run: &mut Run) -> Result<Outcome, Failed> {
    let root = open_project_root()?;
    let registered = core_post(run, "/kb/projects/register", json!({"id": project_id_for(&root), "root": root}))?;
    expect(
        (200..300).contains(&registered.status),
        "REGISTER_PROJECT",
        format!("register answered HTTP {} ({})", registered.status, registered.error_code()),
    )?;
    let installed = core_post(run, "/kb/project/install-skills", json!({"path": root, "language": "en"}))?;
    let declined = installed.json().and_then(|value| value["ok"].as_bool()) == Some(false);
    expect(
        (200..300).contains(&installed.status) && !declined,
        "INSTALL_SKILLS",
        format!("install-skills answered HTTP {} ({})", installed.status, installed.error_code()),
    )?;
    println!("  register and install-skills: ok");
    Ok(Outcome::Done)
}

/// Step 20: clone the small public repository with no token. The clone lands in `code/Hello-World` of the project.
fn step_project_clone(_run: &mut Run) -> Result<Outcome, Failed> {
    let cloned = block(repo_clone(
        "github".to_string(),
        "https://github.com/octocat/Hello-World".to_string(),
        None,
        None,
        None,
    ))
    .map_err(|error| failed("CLONE_FAILED", error.message()))?;
    expect(cloned.name == "Hello-World", "CLONE_NAME", "the clone is not named Hello-World")?;
    expect(
        listed_names("code/Hello-World")?.iter().any(|name| name == "README"),
        "CLONE_README",
        "code/Hello-World/README is not in the clone",
    )?;
    println!("  clone without a token: code/Hello-World/README is there (server path {})", cloned.path);
    Ok(Outcome::Done)
}

/// Step 21: opens the work folder again, so the close step below runs as before.
fn step_project_back_to_work(run: &mut Run) -> Result<Outcome, Failed> {
    let work = run.folder_root.clone().ok_or_else(|| failed("LIVE_ORDER", "the workspace step did not open a folder"))?;
    block(remote_ssh_workspace_close())?;
    block(remote_ssh_workspace_open(work.clone()))?;
    expect(
        project_active().is_some_and(|active| active.root == work),
        "NOT_ACTIVE",
        "the work folder is not open again after the project steps",
    )?;
    Ok(Outcome::Done)
}

/// Deletes the test folder through the helper: the helper opens the home folder, the test folder is deleted from
/// there, and the folder is closed again. Without a Trash the folder stays and the step says so.
fn step_workspace_close(run: &mut Run) -> Result<Outcome, Failed> {
    let root = run.folder_root.clone().ok_or_else(|| failed("LIVE_ORDER", "the workspace step did not open a folder"))?;
    let outer = run.test_folder.clone().ok_or_else(|| failed("LIVE_ORDER", "the test folder name is missing"))?;
    block(remote_ssh_workspace_close())?;
    block(remote_ssh_workspace_open(outer))?;
    match block(fs_delete("work".to_string())) {
        Ok(_) => println!("  folder work: moved to the server Trash"),
        Err(error) if error.code == "trash_unavailable" => {
            println!("  folder work: trash_unavailable (expected on servers without a desktop Trash)")
        }
        Err(error) => return Err(error.into()),
    }
    block(remote_ssh_workspace_close())?;
    remove_test_folder(run);
    expect(project_active().is_none(), "STILL_ACTIVE", "project_active still reports a folder after close")?;
    expect(
        block(remote_ssh_workspace_recent()).contains(&root),
        "NOT_RECENT",
        "the closed folder is not in the recent folders",
    )?;
    block(remote_ssh_workspace_forget(root.clone()))?;
    expect(
        !block(remote_ssh_workspace_recent()).contains(&root),
        "NOT_FORGOTTEN",
        "forget did not remove the folder from the recent folders",
    )?;
    println!("  close, project_active none, recent list and forget: ok");
    run.folder_root = None;
    Ok(Outcome::Done)
}

/// After a failed run: removes the test folder if a step left it on the server. Best effort; each result is printed.
fn remove_test_folder(run: &mut Run) {
    let Some(outer) = run.test_folder.take() else { return };
    let _ = block(remote_ssh_workspace_close());
    match ssh_service::remove_live_check_folders(&run.deps, run.live.password()) {
        Ok(()) => println!("  cleanup: {outer} removed from the server"),
        Err(error) => println!("cleanup: {outer} may remain on the server ({})", error.code),
    }
}

fn step_install_key(run: &mut Run) -> Result<Outcome, Failed> {
    if !run.live.install_key {
        return Ok(Outcome::Skipped(None));
    }
    if run.live.kind == SshAuthKind::Key {
        return Ok(Outcome::Skipped(Some("key auth is already in use")));
    }
    let password = run
        .live
        .password()
        .map(str::to_string)
        .ok_or_else(|| failed("SSH_PASSWORD_REQUIRED", "the password is needed to install a key"))?;
    let key_dir = run.root.join("keys");
    ssh_key_install::install_key(&run.deps, &run.host, &key_dir, &password)?;
    drop(password);
    let saved = prefs::stored().remote_server;
    expect(saved.ssh_auth == SshAuthKind::Key, "KEY_NOT_SAVED", "the key was not saved as the login")?;
    println!("  key created and accepted, private key at {}", saved.key_path);
    run.live.kind = SshAuthKind::Key;
    run.live.key_path = saved.key_path;
    run.live.password = None;

    ssh_service::disconnect(&run.host);
    let status = ssh_service::connect(&run.deps, &run.host, &run.live.target(), None)?;
    expect(status.link == "connected", "KEY_CONNECT_FAILED", format!("the link is {}, not connected", status.link))?;
    check_local_url(&status.local_url)?;
    run.local_url = status.local_url;
    println!("  connected with the key alone");
    Ok(Outcome::Done)
}

fn step_stop(run: &mut Run) -> Result<Outcome, Failed> {
    let status = ssh_service::stop_server(&run.deps, &run.host, &run.live.target(), run.live.password(), false)?;
    expect(status.link == "stopped", "STOP_FAILED", format!("the link is {}, not stopped", status.link))?;
    let state = ssh_service::server_core_state(&run.deps, run.live.password())?;
    expect(!state.running, "CORE_STILL_RUNNING", "the server still reports a running core after stop")?;
    println!("  server core: not running");
    Ok(Outcome::Done)
}

fn step_uninstall(run: &mut Run) -> Result<Outcome, Failed> {
    if !run.live.uninstall {
        return Ok(Outcome::Skipped(None));
    }
    let host_name = run.live.host.clone();
    ssh_service::uninstall(&run.deps, &run.host, run.live.password(), &host_name, false)?;
    let probed = ssh_service::test(&run.deps, &run.live.target(), run.live.password())?;
    expect(
        probed.installed_version.is_none(),
        "STILL_INSTALLED",
        "the server still reports an installed core after uninstall",
    )?;
    println!("  nothing installed (claude: {})", opt(&probed.claude));
    Ok(Outcome::Done)
}

/// Runs the steps in order. Returns how many passed, or the failing step number with its failure.
fn run_steps(run: &mut Run) -> Result<usize, (usize, Failed)> {
    let steps: [(&str, StepFn); 25] = [
        ("test", step_test),
        ("confirm and test", step_confirm_and_test),
        ("connect", step_connect),
        ("health through the forward", step_health),
        ("CORS", step_cors),
        ("account round trip", step_account),
        ("disconnect and check core", step_disconnect_and_check),
        ("connect again", step_reconnect),
        ("workspace open", step_workspace_open),
        ("files", step_files),
        ("git", step_git),
        ("search", step_search),
        ("watch", step_watch),
        ("terminal", step_terminal),
        ("project plain folder refused", step_project_plain),
        ("project create", step_project_create),
        ("project paths and memory", step_project_paths),
        ("project rebuild keeps edits", step_project_rebuild),
        ("project register and skills", step_project_register),
        ("project clone", step_project_clone),
        ("project back to work folder", step_project_back_to_work),
        ("workspace close", step_workspace_close),
        ("install key", step_install_key),
        ("stop server", step_stop),
        ("uninstall", step_uninstall),
    ];
    let mut passed = 0;
    for (index, (name, step)) in steps.into_iter().enumerate() {
        let number = index + 1;
        match step(run) {
            Ok(Outcome::Done) => {
                println!("STEP {number} {name}: ok");
                passed += 1;
            }
            Ok(Outcome::Skipped(None)) => println!("STEP {number} {name}: skipped"),
            Ok(Outcome::Skipped(Some(reason))) => println!("STEP {number} {name}: skipped ({reason})"),
            Err(failure) => {
                println!("FAILED: {} {}", failure.code, failure.message);
                return Err((number, failure));
            }
        }
    }
    Ok(passed)
}

#[test]
#[ignore = "live: needs a real server; set LLMIDE_LIVE_SSH_HOST (see the module doc)"]
fn live_end_to_end() {
    let live = match Live::read() {
        Ok(Some(live)) => live,
        Ok(None) => {
            println!("SSH live check skipped: LLMIDE_LIVE_SSH_HOST is not set");
            return;
        }
        Err(message) => panic!("SSH live check is not configured: {message}"),
    };
    let _prefs = prefs_guard();
    let _mode = core_host::tests::mode_guard();
    set_remote_server_for_test(RemoteServerPrefs::default());

    let mut run = match Run::new(live) {
        Ok(run) => run,
        Err(failure) => {
            println!("FAILED: {} {}", failure.code, failure.message);
            println!("LIVE CHECK: FAIL at step 0");
            panic!("SSH live check could not start: {}", failure.code);
        }
    };
    let outcome = run_steps(&mut run);
    if outcome.is_err() {
        remove_test_folder(&mut run);
    }
    // Best effort on every path: stops the forward and drops the pinned known_hosts folder. The server keeps its core.
    ssh_service::disconnect(&run.host);
    run.host.set_mode(ServerMode::Local);
    set_remote_server_for_test(RemoteServerPrefs::default());
    match outcome {
        Ok(passed) => println!("LIVE CHECK: PASS ({passed} steps)"),
        Err((number, failure)) => {
            println!("LIVE CHECK: FAIL at step {number}");
            panic!("SSH live check failed at step {number}: {}", failure.code);
        }
    }
}
