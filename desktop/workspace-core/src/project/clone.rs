//! Clone one saved repository into a project's `code/` folder, optionally authenticating with a token the user
//! pasted into Settings. Tauri-free: the desktop host and the SSH workspace helper run the same code.
//!
//! The token lives only in git's child environment (the `GIT_CONFIG_*` pair), never in argv, `.git/config`, an
//! error or a log. `Token` redacts itself in `Debug` and `Display` and has no `Serialize`, so it cannot leave by
//! accident. The destination is chosen by the caller's root and is always `<root>/code/<name>`.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Error text of a clone that was stopped by its cancel flag. The desktop and the helper both show it as is.
pub const CANCELLED: &str = "clone cancelled";

/// A clone credential. Its text is reachable only through `expose`, which only the environment builder calls.
#[derive(Deserialize, Clone)]
#[serde(transparent)]
pub struct Token(String);

impl Token {
    /// The raw text. Only `auth_config` may use it, to build git's environment, and the helper's redeem request,
    /// which must send a grant to the core. Nothing else may print or store it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// True when the token is non-blank, at most 512 bytes and free of control characters. An unusable token is
    /// ignored, as the desktop always did, so a clone still runs anonymously.
    pub fn is_usable(&self) -> bool {
        !self.0.trim().is_empty() && self.0.len() <= 512 && !self.0.chars().any(char::is_control)
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl std::fmt::Display for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl From<&str> for Token {
    fn from(raw: &str) -> Self {
        Token(raw.to_string())
    }
}

impl From<String> for Token {
    fn from(raw: String) -> Self {
        Token(raw)
    }
}

/// One clone request as the caller sends it. `url` is `owner/repo` or an https repository URL.
#[derive(Deserialize, Debug)]
pub struct CloneRequest {
    pub provider: String,
    pub url: String,
    pub token: Option<Token>,
    pub folder: Option<String>,
    /// A single-use grant the server helper redeems for the saved provider token. Only the helper reads it, and
    /// only when no typed `token` is set. Absent from requests that come from an older desktop.
    #[serde(default)]
    pub grant: Option<Token>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub path: String,
    pub name: String,
}

/// A validated clone: the https remote, the destination under `code/`, and the provider for the auth header.
#[derive(Debug, Clone, PartialEq)]
pub struct ClonePlan {
    pub remote: String,
    pub dest: PathBuf,
    pub provider: String,
    pub name: String,
}

/// A parsed repository: the full path under the host (`owner/repo`, or a GitLab `group/sub/project`) and its last
/// segment, which names the folder in `code/`.
#[derive(Debug, PartialEq, Clone)]
pub struct RepoRef {
    pub path: String,
    pub name: String,
}

/// Validates a request against `root` and names the destination `<root>/code/<name>`. The caller has already
/// checked `root` (canonical, a directory, not too broad). Errors name the rule that failed, never the token.
pub fn plan(root: &Path, req: &CloneRequest) -> Result<ClonePlan, String> {
    if req.provider != "github" && req.provider != "gitlab" {
        return Err("provider must be github or gitlab".into());
    }
    let repo_ref = parse_repo(&req.url, &req.provider).ok_or_else(|| {
        if req.provider == "gitlab" {
            "enter group/project (nested groups allowed) or an https gitlab.com repository URL".to_string()
        } else {
            "enter owner/repo or an https github.com repository URL".to_string()
        }
    })?;
    let name = target_name(req, &repo_ref)?;
    let dest = destination(root, &name)?;
    Ok(ClonePlan { remote: remote_url(&req.provider, &repo_ref.path), dest, provider: req.provider.clone(), name })
}

/// The folder a request clones into under `code/`: the typed folder, else the repository name.
pub fn target_name(req: &CloneRequest, repo_ref: &RepoRef) -> Result<String, String> {
    match req.folder.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) => folder_name("", f).ok_or_else(|| "invalid folder name".to_string()),
        None => folder_name("", &repo_ref.name).ok_or_else(|| "invalid repository name".to_string()),
    }
}

/// Runs the planned clone with `git`. On a rejected token it retries once anonymously. Setting `cancel` kills git,
/// removes the partial destination and returns `CANCELLED`. Nothing in the error text includes the token.
pub fn run(plan: &ClonePlan, token: Option<&Token>, cancel: &AtomicBool, git: &Path) -> Result<CloneResult, String> {
    let token = token.filter(|t| t.is_usable()).map(Token::expose);
    clone_with_fallback(git, &plan.remote, &plan.dest, &plan.provider, token, cancel, &process_env())?;
    Ok(CloneResult { path: plan.dest.to_string_lossy().into_owned(), name: plan.name.clone() })
}

/// `owner/repo` shorthand or an https github.com / gitlab.com URL, stripped to its path. GitHub is exactly
/// `owner/repo`; GitLab allows nested groups (2 to 20 segments). Rejects any other path shape.
pub fn parse_repo(raw: &str, provider: &str) -> Option<RepoRef> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 500 || t.chars().any(|c| c.is_control()) {
        return None;
    }
    let rest = if let Some(r) = t.strip_prefix("https://github.com/").or_else(|| t.strip_prefix("https://gitlab.com/")) {
        r
    } else if t.starts_with("http://") || t.starts_with("https://") || t.contains(' ') {
        return None;
    } else {
        t
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let segments: Vec<&str> = rest.split('/').collect();
    let max = if provider == "gitlab" { 20 } else { 2 };
    if segments.len() < 2 || segments.len() > max {
        return None;
    }
    let ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if !segments.iter().all(|s| ok(s)) {
        return None;
    }
    Some(RepoRef { path: segments.join("/"), name: segments[segments.len() - 1].to_string() })
}

/// The clone URL for a provider (always https, `.git` suffix).
pub fn remote_url(provider: &str, path: &str) -> String {
    let host = if provider == "gitlab" { "gitlab.com" } else { "github.com" };
    format!("https://{host}/{path}.git")
}

/// The folder name inside `code/`: the repository name, never a path.
pub fn folder_name(_owner: &str, repo: &str) -> Option<String> {
    let name = repo.trim();
    (!name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) && name != "." && name != "..")
        .then(|| name.to_string())
}

/// Minimal base64 for the GitHub Basic header (`x-access-token:<token>`); no external dependency.
pub fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        out.push(T[(b[0] >> 2) as usize] as char);
        out.push(T[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { T[(((b[1] & 0x0f) << 2) | (b[2] >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(b[2] & 0x3f) as usize] as char } else { '=' });
    }
    out
}

/// `http.<scope>.extraHeader` + value for one provider/token; empty when no token.
pub fn auth_config(provider: &str, token: Option<&str>) -> (String, String) {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else { return (String::new(), String::new()) };
    // Git's key is `http.<url>.<variable>`: `http.https://github.com.extraHeader`.
    let scope = if provider == "gitlab" { "https://gitlab.com" } else { "https://github.com" };
    let key = format!("http.{scope}.extraHeader");
    let value = if provider == "gitlab" {
        // GitLab's git endpoint ignores `PRIVATE-TOKEN` (that header is for its REST API): a private repository then
        // fails with "could not read Username". It honours HTTP Basic with the literal user `oauth2` and the token.
        format!("Authorization: Basic {}", base64(format!("oauth2:{token}").as_bytes()))
    } else {
        format!("Authorization: Basic {}", base64(format!("x-access-token:{token}").as_bytes()))
    };
    (key, value)
}

fn code_dir(root: &Path) -> PathBuf {
    root.join("code")
}

/// The destination `code/<repo>`; refuses an existing path and any name that is not one plain component.
pub fn destination(root: &Path, name: &str) -> Result<PathBuf, String> {
    let name = folder_name("", name).ok_or_else(|| "invalid repository name".to_string())?;
    let dest = code_dir(root).join(&name);
    if dest.exists() {
        return Err(format!("code/{name} already exists"));
    }
    Ok(dest)
}

/// True for git errors that mean the supplied credential was rejected (a stale token on a public repository,
/// or a token without access to a private one). The clone then retries anonymously once.
pub fn is_auth_failure(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    ["http basic: access denied", "authentication failed", "could not read username", "invalid username or password", "permission denied (publickey)"]
        .iter()
        .any(|needle| m.contains(needle))
}

/// This process's environment, the one git inherits. Passed down so a test can supply its own.
fn process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}

/// True for the variables that make up git's config-pair list (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
/// `GIT_CONFIG_VALUE_<n>`). These are the only way a header reaches git from the environment.
fn is_git_config_pair(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else { return false };
    name == "GIT_CONFIG_COUNT" || name.starts_with("GIT_CONFIG_KEY_") || name.starts_with("GIT_CONFIG_VALUE_")
}

/// The inherited environment minus any config pair. A pair set in the caller's shell (an `extraHeader`, say) would
/// otherwise reach git on the anonymous retry, which must send no credential at all.
fn inherited_env(parent: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    parent.iter().filter(|(name, _)| !is_git_config_pair(name)).cloned().collect()
}

/// Appends the Homebrew dirs missing from `parent`'s PATH on macOS, so git finds `git-lfs` when the app was launched
/// from Finder. Never reorders the existing entries; `mac` is a parameter for the test.
fn with_git_lfs_dirs(mut env: Vec<(OsString, OsString)>, mac: bool) -> Vec<(OsString, OsString)> {
    if !mac {
        return env;
    }
    let current = env.iter().position(|(name, _)| name == "PATH");
    let mut dirs: Vec<PathBuf> = current.map(|i| std::env::split_paths(&env[i].1).collect()).unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !dirs.iter().any(|d| d == Path::new(extra)) {
            dirs.push(PathBuf::from(extra));
        }
    }
    if let Ok(joined) = std::env::join_paths(dirs) {
        match current {
            Some(i) => env[i].1 = joined,
            None => env.push(("PATH".into(), joined)),
        }
    }
    env
}

fn clone_with_fallback(
    git: &Path,
    remote: &str,
    dest: &Path,
    provider: &str,
    token: Option<&str>,
    cancel: &AtomicBool,
    parent: &[(OsString, OsString)],
) -> Result<(), String> {
    let first = clone_into(git, remote, dest, provider, token, cancel, CLONE_CAP, parent);
    let Err(err) = first else { return first };
    // A cancel that lands while the first attempt is failing is reported as the cancel, not as git's error.
    if cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    if token.is_none() || !is_auth_failure(&err) {
        return Err(err);
    }
    // A stale/expired token must not make a public repository unclonable. Retry with the same URL and no
    // credential; if the repository is private this fails too and we return the original (clearer) error.
    // NOTE: no delete here. The failed attempt already removed the folder it created; deleting `dest` again
    // could remove a concurrent clone that took the path in between.
    match clone_into(git, remote, dest, provider, None, cancel, CLONE_CAP, parent) {
        Ok(()) => Ok(()),
        Err(_) if cancel.load(Ordering::SeqCst) => Err(CANCELLED.into()),
        Err(_) => Err(err),
    }
}

/// A stalled transfer (below 1000 B/s for 60 s) ends by itself; the wall-clock cap below bounds everything else.
const LOW_SPEED_ARGS: [&str; 4] = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];
/// Overall cap for one clone attempt. Generous (large repositories), but finite.
pub const CLONE_CAP: Duration = Duration::from_secs(30 * 60);

/// argv (after the program) and environment of one `git clone`. Pure, so it is testable. The token only ever
/// appears in the environment, never in argv. `windows` is a parameter for the test.
pub(crate) fn clone_invocation(remote: &str, dest: &Path, provider: &str, token: Option<&str>, windows: bool) -> (Vec<String>, Vec<(String, String)>) {
    let mut args: Vec<String> = LOW_SPEED_ARGS.iter().map(|s| s.to_string()).collect();
    args.extend(["clone".into(), "--".into(), remote.to_string(), dest.to_string_lossy().into_owned()]);
    let mut env = vec![("GIT_TERMINAL_PROMPT".to_string(), "0".to_string())];
    // No /usr/bin/true on Windows: there GIT_TERMINAL_PROMPT=0 alone stops the prompt.
    if !windows {
        env.push(("GIT_ASKPASS".into(), "/usr/bin/true".into()));
    }
    let (key, value) = auth_config(provider, token);
    if !key.is_empty() {
        env.push(("GIT_CONFIG_COUNT".into(), "1".into()));
        env.push(("GIT_CONFIG_KEY_0".into(), key));
        env.push(("GIT_CONFIG_VALUE_0".into(), value));
    }
    (args, env)
}

/// Waits for `child` for at most `cap`, or until `cancel` is set; the whole process tree is killed on either.
/// Returns the status and stderr, or the cap / cancel error.
fn wait_capped(mut child: Child, cap: Duration, cancel: &AtomicBool) -> Result<(ExitStatus, String), String> {
    let mut stderr = child.stderr.take();
    // Drained on its own thread: a full pipe would otherwise stall git while we poll.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.take(64 * 1024).read_to_end(&mut buf);
            let _ = std::io::copy(s, &mut std::io::sink());
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let deadline = Instant::now() + cap;
    loop {
        match child.try_wait().map_err(|e| format!("cannot wait for git: {e}"))? {
            Some(status) => return Ok((status, reader.join().unwrap_or_default())),
            None if cancel.load(Ordering::SeqCst) => {
                crate::git::kill_tree(&mut child);
                let _ = child.wait();
                return Err(CANCELLED.into());
            }
            None if Instant::now() >= deadline => {
                crate::git::kill_tree(&mut child);
                let _ = child.wait();
                return Err(format!("git clone timed out after {} minutes", cap.as_secs() / 60));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn clone_into(
    git: &Path,
    remote: &str,
    dest: &Path,
    provider: &str,
    token: Option<&str>,
    cancel: &AtomicBool,
    cap: Duration,
    parent: &[(OsString, OsString)],
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create code/: {e}"))?;
    }
    // Claim the destination atomically. `destination()` checked `exists()` earlier, but another clone of the same
    // repo can win the gap; `create_dir` fails if the path exists, so we never delete a folder we did not create.
    // git clones into an existing EMPTY directory, so the claim does not change what git sees.
    std::fs::create_dir(dest).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("code/{} already exists", dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
        } else {
            format!("cannot create {}: {e}", dest.display())
        }
    })?;
    let (args, env) = clone_invocation(remote, dest, provider, token, cfg!(windows));
    // The child's environment is the inherited one minus config pairs, then the clone's own pair (if a token is set).
    // Set on this child only, never on the process.
    let mut cmd = Command::new(git);
    cmd.args(&args).env_clear().envs(with_git_lfs_dirs(inherited_env(parent), cfg!(target_os = "macos"))).envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Own process group, so the cap and the cancel flag can kill git together with its helpers (kill_tree).
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            // We created `dest` above, so removing it is safe.
            let _ = std::fs::remove_dir_all(dest);
            return Err(format!("cannot run git: {e}"));
        }
    };
    let (status, err) = match wait_capped(child, cap, cancel) {
        Ok(v) => v,
        Err(e) => {
            // A killed clone leaves a partial folder; this call created `dest` (create_dir above), so it is ours to remove.
            let _ = std::fs::remove_dir_all(dest);
            return Err(e);
        }
    };
    if status.success() {
        return Ok(());
    }
    // A failed checkout (e.g. a missing LFS filter) leaves files but no index; this call created `dest`, so removing it cannot touch anyone else's folder.
    let _ = std::fs::remove_dir_all(dest);
    let msg: String = err.chars().filter(|c| !c.is_control()).take(400).collect();
    Err(if msg.trim().is_empty() { "git clone failed".into() } else { format!("git clone failed: {msg}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Owns a scratch folder and removes it on drop, so a failing test leaves nothing behind.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("llmide-clone-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// `ETXTBSY` ("Text file busy") on macOS and Linux. A script written while another test thread forks can still
    /// be open for writing in that child, so its exec fails until the child execs.
    #[cfg(unix)]
    const ETXTBSY: i32 = 26;

    /// Writes an executable `sh` script that stands in for git. `body` runs with git's arguments in `$@`. The file is
    /// synced and closed before any spawn, and a probe run (`--llmide-probe`, which exits at once) is retried on
    /// `ETXTBSY` a bounded number of times, so the first real spawn cannot race another thread's fork.
    #[cfg(unix)]
    fn fake_git(dir: &Path, body: &str) -> PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-git");
        {
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(format!("#!/bin/sh\n[ \"$1\" = --llmide-probe ] && exit 0\n{body}\n").as_bytes()).unwrap();
            file.sync_all().unwrap();
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        for attempt in 1..=50 {
            match Command::new(&path).arg("--llmide-probe").status() {
                Ok(status) => {
                    assert!(status.success(), "the fake git probe exits 0");
                    return path;
                }
                Err(e) if e.raw_os_error() == Some(ETXTBSY) && attempt < 50 => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => panic!("the fake git cannot run: {e}"),
            }
        }
        unreachable!("the last attempt returns or panics")
    }

    fn request(provider: &str, url: &str, token: Option<&str>) -> CloneRequest {
        CloneRequest { provider: provider.into(), url: url.into(), token: token.map(Token::from), folder: None, grant: None }
    }

    #[test]
    fn token_debug_is_redacted() {
        let t = Token::from("ghp_SECRET");
        assert!(!format!("{t:?}").contains("SECRET"));
        assert!(!format!("{t}").contains("SECRET"));
        assert_eq!(t.expose(), "ghp_SECRET");
    }

    #[test]
    fn token_is_read_from_a_json_string() {
        let req: CloneRequest = serde_json::from_str(r#"{"provider":"github","url":"o/r","token":"tok","folder":null}"#).unwrap();
        assert_eq!(req.token.as_ref().map(Token::expose), Some("tok"));
        assert!(serde_json::from_str::<CloneRequest>(r#"{"provider":"github","url":"o/r","token":5}"#).is_err());
    }

    #[test]
    fn a_grant_is_optional_redacted_and_read_from_json() {
        let with: CloneRequest = serde_json::from_str(r#"{"provider":"github","url":"o/r","grant":"g_GRANT_9"}"#).unwrap();
        let grant = with.grant.as_ref().expect("the grant is read");
        assert_eq!(grant.expose(), "g_GRANT_9");
        assert!(!format!("{grant:?}").contains("GRANT_9"), "a grant never shows in Debug");
        let without: CloneRequest = serde_json::from_str(r#"{"provider":"github","url":"o/r"}"#).unwrap();
        assert!(without.grant.is_none(), "an older desktop sends no grant");
    }

    #[test]
    fn errors_never_contain_the_token() {
        let s = Scratch::new("errors");
        let marker = "ghp_SECRET";
        // A bad URL with the token set.
        let bad_url = plan(&s.0, &request("github", "https://evil.com/o/r", Some(marker))).unwrap_err();
        assert!(!bad_url.contains("SECRET"), "{bad_url}");
        // A bad provider with the token set.
        let bad_provider = plan(&s.0, &request("bitbucket", "o/r", Some(marker))).unwrap_err();
        assert!(!bad_provider.contains("SECRET"), "{bad_provider}");
        // A refused clone: the fake git rejects the credential, retries anonymously and fails again. Each run appends
        // the credential header it was given (or "none") to a calls file, so the test can see both attempts.
        #[cfg(unix)]
        {
            let calls = s.0.join("calls.txt");
            // The key is checked too: the test process may inherit unrelated GIT_CONFIG_* variables from its caller.
            let body = format!(
                "if [ \"$GIT_CONFIG_KEY_0\" = http.https://github.com.extraHeader ]; then echo \"$GIT_CONFIG_VALUE_0\" >> '{}'; else echo none >> '{}'; fi; \
                 echo \"fatal: Authentication failed for 'https://github.com/o/r.git/'\" >&2; exit 128",
                calls.display(),
                calls.display()
            );
            let git = fake_git(&s.0, &body);
            let p = plan(&s.0, &request("github", "o/r", Some(marker))).unwrap();
            let refused = run(&p, Some(&Token::from(marker)), &AtomicBool::new(false), &git).unwrap_err();
            let recorded = std::fs::read_to_string(&calls).unwrap();
            let lines: Vec<&str> = recorded.lines().collect();
            assert_eq!(lines.len(), 2, "one tokened attempt and one anonymous retry: {recorded:?}");
            assert_eq!(lines[0], auth_config("github", Some(marker)).1, "the first attempt carries the header");
            assert_eq!(lines[1], "none", "the anonymous retry carries no header");
            let b64 = base64(format!("x-access-token:{marker}").as_bytes());
            assert!(!refused.contains(marker), "{refused}");
            assert!(!refused.contains(&b64), "the encoded token is not in the error: {refused}");
            assert!(refused.contains("Authentication failed"), "the clearer original error is kept: {refused}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn cancel_stops_and_removes_destination() {
        let s = Scratch::new("cancel");
        // The stand-in git creates the destination, as a real clone does, then hangs.
        let git = fake_git(&s.0, "last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"; sleep 30");
        let p = plan(&s.0, &request("github", "o/r", None)).unwrap();
        let cancel = AtomicBool::new(false);
        let seen_dest = AtomicBool::new(false);
        let start = Instant::now();
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                // Cancel only once git has created the destination, so the stop lands during the clone.
                let deadline = Instant::now() + Duration::from_secs(10);
                while !p.dest.exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                seen_dest.store(p.dest.exists(), Ordering::SeqCst);
                cancel.store(true, Ordering::SeqCst);
            });
            run(&p, None, &cancel, &git)
        });
        assert!(seen_dest.load(Ordering::SeqCst), "git created the destination before the cancel");
        assert_eq!(result.unwrap_err(), "clone cancelled");
        assert!(!p.dest.exists(), "the partial destination is removed");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn repository_shapes_are_parsed_strictly() {
        let r = |path: &str, name: &str| Some(RepoRef { path: path.into(), name: name.into() });
        assert_eq!(parse_repo("owner/repo", "github"), r("owner/repo", "repo"));
        assert_eq!(parse_repo("https://github.com/owner/repo.git", "github"), r("owner/repo", "repo"));
        assert_eq!(parse_repo("https://gitlab.com/group/repo/", "gitlab"), r("group/repo", "repo"));
        // GitLab projects live in nested groups; GitHub stays exactly owner/repo.
        assert_eq!(parse_repo("https://gitlab.com/gitlab-org/security-products/analyzers/semgrep.git", "gitlab"), r("gitlab-org/security-products/analyzers/semgrep", "semgrep"));
        assert_eq!(parse_repo("group/sub/project", "gitlab"), r("group/sub/project", "project"));
        assert_eq!(parse_repo("a/b/c", "github"), None);
        for provider in ["github", "gitlab"] {
            for bad in ["", "https://evil.com/o/r", "../r", "a b/c", "https://github.com/o", "o/..", "o//r"] {
                assert_eq!(parse_repo(bad, provider), None, "{provider}: {bad}");
            }
        }
        assert_eq!(parse_repo(&format!("g/{}", vec!["s"; 20].join("/")), "gitlab"), None, "more than 20 segments");
        assert_eq!(remote_url("gitlab", "group/sub/project"), "https://gitlab.com/group/sub/project.git");
        assert_eq!(remote_url("github", "o/r"), "https://github.com/o/r.git");
    }

    #[test]
    fn the_folder_is_one_plain_component_and_destinations_never_exist_twice() {
        assert_eq!(folder_name("o", "repo"), Some("repo".into()));
        assert_eq!(folder_name("o", ".."), None);
        assert_eq!(folder_name("o", "a/b"), None);
        let root = std::env::temp_dir().join(format!("llmide-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("code/repo")).unwrap();
        assert!(destination(&root, "repo").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clone_into_a_local_repository_copies_the_worktree() {
        let base = std::env::temp_dir().join(format!("llmide-clone-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let run_git = |args: &[&str]| {
            let out = Command::new("git").args(["-c", "user.name=Test", "-c", "user.email=t@example.com"]).args(args).current_dir(&base).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        run_git(&["init", "-q"]);
        std::fs::write(base.join("README.md"), "hello").unwrap();
        run_git(&["add", "README.md"]);
        run_git(&["commit", "-qm", "first"]);
        let git = crate::git::git_binary().expect("git on PATH");
        let cancel = AtomicBool::new(false);
        let dest = base.join("dest");
        clone_into(&git, base.to_str().unwrap(), &dest, "github", None, &cancel, CLONE_CAP, &process_env()).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("README.md")).unwrap(), "hello");
        // A token must produce a VALID GIT_CONFIG_KEY_0 even when the local remote needs no auth.
        let dest2 = base.join("dest2");
        clone_into(&git, base.to_str().unwrap(), &dest2, "github", Some("tok"), &cancel, CLONE_CAP, &process_env()).unwrap();
        assert_eq!(std::fs::read_to_string(dest2.join("README.md")).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_clone_invocation_ends_stalls_keeps_the_token_out_of_argv_and_is_os_aware() {
        let dest = Path::new("/p/code/r");
        let (args, env) = clone_invocation("https://github.com/o/r.git", dest, "github", Some("sekret"), false);
        assert_eq!(&args[..4], ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"]);
        assert_eq!(&args[4..], ["clone", "--", "https://github.com/o/r.git", "/p/code/r"]);
        assert!(!args.iter().any(|a| a.contains("sekret")));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("GIT_TERMINAL_PROMPT"), Some("0"));
        assert_eq!(get("GIT_ASKPASS"), Some("/usr/bin/true"));
        assert_eq!(get("GIT_CONFIG_COUNT"), Some("1"));
        let (_, win_env) = clone_invocation("u", dest, "github", None, true);
        assert!(win_env.iter().all(|(n, _)| n != "GIT_ASKPASS"), "no /usr/bin/true on Windows");
        assert!(win_env.iter().any(|(n, v)| n == "GIT_TERMINAL_PROMPT" && v == "0"));
        assert!(win_env.iter().all(|(n, _)| n != "GIT_CONFIG_COUNT"), "no token, no config pair");
    }

    /// A cancel that lands while the first attempt runs wins over the auth error git then reports. The fake git
    /// announces itself, waits for `go`, then fails with an auth error, so the cancel is set before git can fail.
    #[cfg(unix)]
    #[test]
    fn a_cancel_during_the_first_attempt_reports_cancelled_not_the_auth_error() {
        let s = Scratch::new("cancel-first");
        let started = s.0.join("started");
        let go = s.0.join("go");
        let body = format!(
            "touch '{}'; while [ ! -f '{}' ]; do sleep 1; done; echo 'fatal: Authentication failed for x' >&2; exit 128",
            started.display(),
            go.display()
        );
        let git = fake_git(&s.0, &body);
        let p = plan(&s.0, &request("github", "o/r", Some("ghp_X"))).unwrap();
        let cancel = AtomicBool::new(false);
        let result = std::thread::scope(|scope| {
            let worker = scope.spawn(|| clone_with_fallback(&git, &p.remote, &p.dest, &p.provider, Some("ghp_X"), &cancel, &process_env()));
            let deadline = Instant::now() + Duration::from_secs(10);
            while !started.exists() {
                assert!(Instant::now() < deadline, "the fake git never started");
                std::thread::sleep(Duration::from_millis(10));
            }
            cancel.store(true, Ordering::SeqCst);
            std::fs::write(&go, "").unwrap();
            worker.join().unwrap()
        });
        assert_eq!(result.unwrap_err(), CANCELLED);
    }

    /// The anonymous retry must be anonymous even when the caller's environment holds a config pair. The parent
    /// environment here carries `GIT_CONFIG_COUNT`, `KEY_0` and `VALUE_0` (an extraHeader that would be rejected). The
    /// fake git fails whenever a key is set, so the retry only succeeds if the inherited pair was removed. The pair is
    /// set on the child command only, never with a process-wide `set_var`.
    #[cfg(unix)]
    #[test]
    fn the_anonymous_retry_ignores_an_inherited_config_pair() {
        let s = Scratch::new("inherited-pair");
        let git = fake_git(
            &s.0,
            "if [ -n \"$GIT_CONFIG_KEY_0\" ]; then echo 'fatal: Authentication failed for x' >&2; exit 128; fi; last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"",
        );
        let p = plan(&s.0, &request("github", "o/r", Some("ghp_X"))).unwrap();
        let mut parent = process_env();
        parent.extend([
            (OsString::from("GIT_CONFIG_COUNT"), OsString::from("1")),
            (OsString::from("GIT_CONFIG_KEY_0"), OsString::from("http.https://github.com.extraHeader")),
            (OsString::from("GIT_CONFIG_VALUE_0"), OsString::from("Authorization: Basic bm9wZQ==")),
        ]);
        let cancel = AtomicBool::new(false);
        // The first attempt sends the token and fails; the retry must succeed without any header.
        clone_with_fallback(&git, &p.remote, &p.dest, &p.provider, Some("ghp_X"), &cancel, &parent).unwrap();
        assert!(p.dest.is_dir(), "the anonymous retry cloned the repository");
    }

    #[test]
    fn inherited_env_drops_only_the_config_pairs() {
        let parent = vec![
            (OsString::from("PATH"), OsString::from("/usr/bin")),
            (OsString::from("GIT_CONFIG_COUNT"), OsString::from("1")),
            (OsString::from("GIT_CONFIG_KEY_0"), OsString::from("k")),
            (OsString::from("GIT_CONFIG_VALUE_12"), OsString::from("v")),
            (OsString::from("GIT_CONFIG_GLOBAL"), OsString::from("/dev/null")),
        ];
        let names: Vec<String> = inherited_env(&parent).into_iter().map(|(n, _)| n.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["PATH", "GIT_CONFIG_GLOBAL"]);
    }

    #[test]
    fn git_lfs_dirs_are_appended_on_macos_only() {
        let env = |path: &str| vec![(OsString::from("PATH"), OsString::from(path))];
        let path_of = |e: Vec<(OsString, OsString)>| e[0].1.to_string_lossy().into_owned();
        assert_eq!(path_of(with_git_lfs_dirs(env("/usr/bin:/bin"), true)), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
        assert_eq!(path_of(with_git_lfs_dirs(env("/usr/local/bin:/usr/bin"), true)), "/usr/local/bin:/usr/bin:/opt/homebrew/bin");
        assert_eq!(path_of(with_git_lfs_dirs(env("/usr/bin"), false)), "/usr/bin");
        let none = with_git_lfs_dirs(Vec::new(), true);
        assert_eq!(none[0].1.to_string_lossy(), "/opt/homebrew/bin:/usr/local/bin");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_clone_removes_the_partial_destination() {
        let s = Scratch::new("failed");
        let git = fake_git(&s.0, "last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"; echo 'checkout failed' >&2; exit 128");
        let p = plan(&s.0, &request("github", "o/r", None)).unwrap();
        let err = run(&p, None, &AtomicBool::new(false), &git).unwrap_err();
        assert!(err.contains("checkout failed"), "{err}");
        assert!(!p.dest.exists(), "the half-checked-out folder is removed");
    }

    #[cfg(unix)]
    #[test]
    fn a_destination_created_after_plan_is_refused_and_left_untouched() {
        let s = Scratch::new("toctou");
        // Records whether git ran at all: it must not.
        let marker = s.0.join("git-ran");
        let git = fake_git(&s.0, &format!("touch '{}'; exit 128", marker.display()));
        let p = plan(&s.0, &request("github", "o/r", None)).unwrap();
        // A concurrent clone of the same repo wins the gap between plan() and spawn.
        std::fs::create_dir_all(&p.dest).unwrap();
        std::fs::write(p.dest.join("precious.txt"), "keep").unwrap();
        let err = run(&p, None, &AtomicBool::new(false), &git).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(std::fs::read_to_string(p.dest.join("precious.txt")).unwrap(), "keep", "someone else's folder survives");
        assert!(!marker.exists(), "git is never spawned against a folder we did not create");
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_after_this_call_created_the_destination_removes_it() {
        let s = Scratch::new("own-failure");
        let git = fake_git(&s.0, "echo 'boom' >&2; exit 1");
        let p = plan(&s.0, &request("github", "o/r", None)).unwrap();
        let err = run(&p, None, &AtomicBool::new(false), &git).unwrap_err();
        assert!(err.contains("boom"), "{err}");
        assert!(!p.dest.exists(), "the empty folder we created is removed");
    }

    #[cfg(unix)]
    #[test]
    fn a_clone_that_outlives_the_cap_is_killed() {
        let child = Command::new("sleep").arg("30").stderr(Stdio::piped()).spawn().unwrap();
        let start = Instant::now();
        let r = wait_capped(child, Duration::from_millis(300), &AtomicBool::new(false));
        assert!(r.unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn auth_failures_are_recognised_for_anonymous_retry() {
        assert!(is_auth_failure("git clone failed: remote: HTTP Basic: Access denied."));
        assert!(is_auth_failure("fatal: Authentication failed for 'https://github.com/x/y.git/'"));
        assert!(!is_auth_failure("repository not found"));
        assert!(!is_auth_failure("could not resolve host: github.com"));
    }

    #[test]
    fn auth_headers_are_provider_specific_and_never_in_argv() {
        let (k, v) = auth_config("github", Some("tok"));
        assert_eq!(k, "http.https://github.com.extraHeader");
        assert_eq!(v, "Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9r");
        let (k2, v2) = auth_config("gitlab", Some("glpat"));
        assert_eq!(k2, "http.https://gitlab.com.extraHeader");
        assert_eq!(v2, format!("Authorization: Basic {}", base64(b"oauth2:glpat")));
        assert_eq!(base64(b"oauth2:glpat"), "b2F1dGgyOmdscGF0");
        assert_eq!(auth_config("github", None), (String::new(), String::new()));
        assert_eq!(base64(b"x-access-token:tok"), "eC1hY2Nlc3MtdG9rZW46dG9r");
    }
}
