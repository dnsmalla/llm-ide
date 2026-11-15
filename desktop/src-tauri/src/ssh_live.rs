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
//! `LLMIDE_LIVE_SSH_INSTALL_KEY=1` (password auth only) runs step 9; `LLMIDE_LIVE_SSH_UNINSTALL=1` runs step 11.
//!
//! Nothing this module prints includes the password, a token, a generated secret or a nonce.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::confirm::herr;
use crate::core_env;
use crate::core_host::{self, CoreHost};
use crate::fs_ops::FsError;
use crate::fsutil;
use crate::prefs::{self, prefs_guard, set_remote_server_for_test, RemoteServerPrefs, ServerMode, SshAuthKind};
use crate::remote::temp_ssh_dir;
use crate::ssh_cmds;
use crate::ssh_key_install;
use crate::ssh_service::{self, Deps, SshServerTarget, SshServerTest};
use crate::ssh_session;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
/// The local ports the forward may use, as `ssh_session` picks them.
const LOCAL_PORTS: std::ops::RangeInclusive<u16> = 3456..=3459;
const ORIGIN_UNKNOWN: &str = "https://evil.example";
const BUNDLE_HINT: &str =
    "no Linux server bundle for this build. Build one with: node desktop/scripts/stage-hub-core.mjs [--compat-sqlite <file>]";

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
        // Built before the folder is used, so a failure below still removes the folder through Drop.
        let mut run = Self {
            live,
            deps,
            host: CoreHost::new(),
            root,
            local_url: String::new(),
            observed: None,
            before: None,
            account: None,
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

/// The Linux bundle for this version: the app's resource folder first, then the staged `dist/hub` folder.
/// Resolved from `CARGO_MANIFEST_DIR`, because `cargo test` runs in `desktop/src-tauri`, where the relative
/// candidates in `ssh_session::bundle_for` do not point at the staged files.
fn live_bundle() -> Option<PathBuf> {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let names = [
        format!("llmide-core-{VERSION}-linux-x64-compat.tar.gz"),
        format!("llmide-core-{VERSION}-linux-x64.tar.gz"),
    ];
    ssh_cmds::bundle_in(Some(&desktop.join("resources")), VERSION).or_else(|| {
        names
            .into_iter()
            .map(|name| desktop.join("dist").join("hub").join(name))
            .find(|path| path.is_file())
    })
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
    let steps: [(&str, StepFn); 11] = [
        ("test", step_test),
        ("confirm and test", step_confirm_and_test),
        ("connect", step_connect),
        ("health through the forward", step_health),
        ("CORS", step_cors),
        ("account round trip", step_account),
        ("disconnect and check core", step_disconnect_and_check),
        ("connect again", step_reconnect),
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
