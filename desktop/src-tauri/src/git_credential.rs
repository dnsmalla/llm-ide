//! `git_credential_save` / `git_credential_erase`: put the Settings → Repositories token into the machine's git
//! credential store (whatever `credential.helper` the user configured), so clone, pull and push of private repos
//! keep working after an app restart. The vault copy only serves API calls.
//!
//! The token travels on git's STDIN only: never argv, env, a log or an error. `Token::is_usable` rejects control
//! characters, which is what stops a newline from smuggling extra keys into the credential protocol.
//! Local mode only: SSH and hub modes do nothing here (git runs on the server, or not at all).
//!
//! `git credential approve/reject` exit 0 even when the helper failed or none is effective, so every result is
//! verified by reading back with `git credential fill`. The webview chooses the host; that is accepted because the
//! webview supplies the token itself.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use llmide_workspace_core::project::clone::Token;
use serde::Serialize;

use crate::workspace_backend::{self, CommandError};

/// A hung helper or keychain dialog must not freeze Save.
const GIT_CAP: Duration = Duration::from_secs(30);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialResult {
    pub stored: bool,
    pub reason: Option<String>,
}

impl GitCredentialResult {
    fn done() -> Self {
        Self { stored: true, reason: None }
    }
    fn skipped(reason: &str) -> Self {
        Self { stored: false, reason: Some(reason.to_string()) }
    }
}

/// Host and username git should associate with the token. The usernames match `auth_config` in the core's clone.
struct Target {
    host: String,
    username: &'static str,
}

/// Normalizes a base URL to the host text git puts in a credential request for that remote: case-insensitive
/// scheme, lowercase host, no trailing dot, default port dropped. Only https without userinfo is accepted, so a
/// crafted base URL can never aim the credential elsewhere. Keep `credentialHostOf` in repo-config.ts in step.
fn normalize_host(base: &str) -> Result<String, String> {
    let base = base.trim();
    let rest = match base.get(..8) {
        Some(scheme) if scheme.eq_ignore_ascii_case("https://") => &base[8..],
        _ => return Err("the GitLab address must start with https://".into()),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    let host_ok = !host.is_empty()
        && !host.ends_with('.')
        && !host.starts_with(['.', '-'])
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if !host_ok {
        return Err("the GitLab address has an unusable host".into());
    }
    let host = host.to_ascii_lowercase();
    let Some(port) = port else { return Ok(host) };
    match port.parse::<u16>() {
        Ok(443) if port.chars().all(|c| c.is_ascii_digit()) => Ok(host),
        Ok(number) if number > 0 && port.chars().all(|c| c.is_ascii_digit()) => Ok(format!("{host}:{number}")),
        _ => Err("the GitLab address has an unusable port".into()),
    }
}

fn derive_target(provider: &str, base_url: Option<&str>) -> Result<Target, String> {
    match provider {
        "github" => Ok(Target { host: "github.com".into(), username: "x-access-token" }),
        "gitlab" => {
            let base = base_url.map(str::trim).filter(|b| !b.is_empty()).unwrap_or("https://gitlab.com");
            Ok(Target { host: normalize_host(base)?, username: "oauth2" })
        }
        _ => Err("unknown provider".into()),
    }
}

/// The credential-protocol text. `password` is `None` for an erase or a read-back.
fn credential_input(target: &Target, password: Option<&str>) -> String {
    let mut text = format!("protocol=https\nhost={}\nusername={}\n", target.host, target.username);
    if let Some(password) = password {
        text.push_str(&format!("password={password}\n"));
    }
    text.push('\n');
    text
}

/// Where and how git runs. Injected so tests never reach the real keychain or `~/.gitconfig`.
struct GitRun {
    git: PathBuf,
    env: Vec<(OsString, OsString)>,
    /// Neutral directory: a repository's own `.git/config` must not decide which helper runs.
    cwd: PathBuf,
    cap: Duration,
    /// Where LLM-IDE records a SHA-256 of each token it wrote to git (never the token), so Clear removes only
    /// that entry and never a login the user stored themselves. `None`: nothing can be proven, so nothing is erased.
    ledger: Option<PathBuf>,
}

struct GitOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

fn spawn_git(run: &GitRun, args: &[&str]) -> Result<std::process::Child, String> {
    let mut cmd = Command::new(&run.git);
    cmd.args(args).current_dir(&run.cwd).env_clear().envs(run.env.iter().map(|(k, v)| (k, v)));
    // Neither a terminal nor an askpass program may ask for a password: a prompt would hang or leak the request.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", if cfg!(windows) { "" } else { "/usr/bin/false" });
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    cmd.spawn().map_err(|e| format!("could not run git: {e}"))
}

/// Reads a pipe on its own thread and hands the bytes over a channel, so the caller can bound the wait: a helper
/// that leaves a long-lived child holding the pipe open must not hang Save.
fn drain<R: Read + Send + 'static>(stream: Option<R>) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut stream) = stream {
            let _ = stream.by_ref().take(64 * 1024).read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Runs git with `input` on stdin and waits at most `run.cap`, killing the whole process tree on a timeout or a
/// failed stdin write. Errors never include the input.
fn run_git(run: &GitRun, args: &[&str], input: &str) -> Result<GitOutput, String> {
    let mut child = spawn_git(run, args)?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(input.as_bytes()) {
            llmide_workspace_core::git::kill_tree(&mut child);
            let _ = child.wait();
            return Err(format!("could not talk to git: {e}"));
        }
    }
    let deadline = Instant::now() + run.cap;
    let status = loop {
        match child.try_wait().map_err(|e| format!("cannot wait for git: {e}"))? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                llmide_workspace_core::git::kill_tree(&mut child);
                let _ = child.wait();
                return Err(format!("git did not answer within {} seconds", run.cap.as_secs().max(1)));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    // The output counts against the same cap; on a timeout whatever still holds the pipes is killed with the group.
    let collect = |rx: &std::sync::mpsc::Receiver<Vec<u8>>| rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    match (collect(&out), collect(&err)) {
        (Ok(stdout), Ok(stderr)) => Ok(GitOutput { success: status.success(), stdout, stderr: String::from_utf8_lossy(&stderr).into_owned() }),
        _ => {
            llmide_workspace_core::git::kill_tree(&mut child);
            Err(format!("git did not finish within {} seconds", run.cap.as_secs().max(1)))
        }
    }
}

fn credential_step(run: &GitRun, verb: &str, input: &str) -> Result<(), String> {
    let out = run_git(run, &["credential", verb], input)?;
    if out.success {
        return Ok(());
    }
    let first = out.stderr.lines().next().unwrap_or("no details").chars().take(200).collect::<String>();
    Err(format!("git credential {verb} failed: {first}"))
}

/// The password git's helpers would hand out for this target now, if any. The value is compared and dropped by the
/// callers; it never reaches a log or an error.
fn read_back(run: &GitRun, target: &Target) -> Result<Option<String>, String> {
    let out = run_git(run, &["credential", "fill"], &credential_input(target, None))?;
    if !out.success {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().find_map(|line| line.strip_prefix("password=")).map(str::to_string))
}

fn digest(secret: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(secret.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Constant-time over equal-length digests; the values compared are hex digests, never the secrets.
fn same_digest(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.bytes().zip(right.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn ledger_key(target: &Target) -> String {
    format!("{}\n{}", target.host, target.username)
}

fn ledger_read(run: &GitRun) -> serde_json::Map<String, serde_json::Value> {
    let Some(path) = &run.ledger else { return Default::default() };
    let text = std::fs::read_to_string(path).unwrap_or_default();
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => Default::default(),
    }
}

/// Whether LLM-IDE wrote exactly this password for the target.
fn is_ours(run: &GitRun, target: &Target, password: &str) -> bool {
    ledger_read(run).get(&ledger_key(target)).and_then(|v| v.as_str()).is_some_and(|d| same_digest(d, &digest(password)))
}

/// Records (`Some`) or forgets (`None`) the digest. Best effort: a failure only means Clear later leaves the entry.
fn ledger_write(run: &GitRun, target: &Target, token: Option<&str>) {
    let Some(path) = &run.ledger else { return };
    let mut map = ledger_read(run);
    match token {
        Some(token) => map.insert(ledger_key(target), serde_json::Value::String(digest(token))),
        None => map.remove(&ledger_key(target)),
    };
    let Some(dir) = path.parent() else { return };
    if crate::fsutil::private_dir(dir).is_ok() {
        let body = serde_json::Value::Object(map).to_string();
        let _ = crate::fsutil::write_private_atomic(path, body.as_bytes(), 64 * 1024);
    }
}

/// Core of the save command. `stored` is true only when a read-back returns exactly this token. A login the user
/// held before (not written by LLM-IDE, different password) is still replaced, as asked, but reported.
fn save_with(run: &GitRun, provider: &str, base_url: Option<&str>, token: Token) -> Result<GitCredentialResult, String> {
    let target = derive_target(provider, base_url)?;
    if !token.is_usable() {
        return Err("the token is empty, too long or contains control characters".into());
    }
    // A failed pre-read only loses the warning; the save itself goes ahead.
    let existing = read_back(run, &target).unwrap_or(None);
    let was_ours = existing.as_deref().is_some_and(|found| is_ours(run, &target, found));
    let replaced_foreign = existing.as_deref().is_some_and(|found| found != token.expose() && !was_ours);
    let identical_foreign = existing.as_deref() == Some(token.expose()) && !was_ours;
    credential_step(run, "approve", &credential_input(&target, Some(token.expose())))?;
    match read_back(run, &target)? {
        Some(found) if found == token.expose() => {
            // The same token already stored by the user is theirs: do not claim it, or Clear would remove it.
            if !identical_foreign {
                ledger_write(run, &target, Some(token.expose()));
            }
            if replaced_foreign {
                return Ok(GitCredentialResult { stored: true, reason: Some("replaced_existing".into()) });
            }
            Ok(GitCredentialResult::done())
        }
        _ => Ok(GitCredentialResult::skipped("not_stored")),
    }
}

/// `stored: true` means removed. Only the entry LLM-IDE wrote is rejected: when git holds another password for this
/// host and username (the user's own login) it stays and the answer is `left_in_place`.
fn erase_with(run: &GitRun, provider: &str, base_url: Option<&str>) -> Result<GitCredentialResult, String> {
    let target = derive_target(provider, base_url)?;
    let Some(current) = read_back(run, &target)? else {
        ledger_write(run, &target, None);
        return Ok(GitCredentialResult::skipped("not_present"));
    };
    if !is_ours(run, &target, &current) {
        return Ok(GitCredentialResult::skipped("left_in_place"));
    }
    credential_step(run, "reject", &credential_input(&target, Some(&current)))?;
    let removed = read_back(run, &target)?.is_none();
    if removed {
        ledger_write(run, &target, None);
        Ok(GitCredentialResult::done())
    } else {
        Ok(GitCredentialResult::skipped("not_removed"))
    }
}

/// The inherited environment minus what could redirect git's config or repository: a pair set in the caller's
/// shell (`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, ...) or `GIT_DIR` would change which
/// helper runs. Same idea as `inherited_env` in the core's clone.
fn inherited_env(parent: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
    const DROPPED: [&str; 7] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ASKPASS", "GIT_NAMESPACE"];
    let dropped = |name: &OsStr| name.to_str().is_some_and(|n| (n.starts_with("GIT_CONFIG") && n != "GIT_CONFIG_NOSYSTEM") || DROPPED.contains(&n));
    parent.into_iter().filter(|(name, _)| !dropped(name)).collect()
}

fn production_run() -> Option<GitRun> {
    let git = llmide_workspace_core::git::git_binary()?;
    let ledger = crate::fsutil::desktop_data_dir().ok().map(|dir| dir.join("git-credential-ledger.json"));
    Some(GitRun { git, env: inherited_env(std::env::vars_os().collect()), cwd: std::env::temp_dir(), cap: GIT_CAP, ledger })
}

/// Outside local mode git runs elsewhere (SSH) or not at all (hub); report why instead of touching this machine.
fn mode_skip() -> Option<GitCredentialResult> {
    if workspace_backend::is_ssh_mode() {
        return Some(GitCredentialResult::skipped("ssh"));
    }
    crate::core_host::require_local_mode().err().map(|_| GitCredentialResult::skipped("remote"))
}

#[tauri::command]
pub async fn git_credential_save(provider: String, base_url: Option<String>, token: String) -> Result<GitCredentialResult, CommandError> {
    if let Some(skip) = mode_skip() {
        return Ok(skip);
    }
    let outcome = workspace_backend::on_blocking(move || match production_run() {
        Some(run) => save_with(&run, &provider, base_url.as_deref(), Token::from(token)),
        None => Ok(GitCredentialResult::skipped("git_missing")),
    })
    .await?;
    Ok(outcome?)
}

#[tauri::command]
pub async fn git_credential_erase(provider: String, base_url: Option<String>) -> Result<GitCredentialResult, CommandError> {
    if let Some(skip) = mode_skip() {
        return Ok(skip);
    }
    let outcome = workspace_backend::on_blocking(move || match production_run() {
        Some(run) => erase_with(&run, &provider, base_url.as_deref()),
        None => Ok(GitCredentialResult::skipped("git_missing")),
    })
    .await?;
    Ok(outcome?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn host_of(provider: &str, base: Option<&str>) -> Result<String, String> {
        derive_target(provider, base).map(|t| t.host)
    }

    #[test]
    fn derives_hosts() {
        assert_eq!(host_of("github", Some("https://evil")).unwrap(), "github.com");
        assert_eq!(host_of("gitlab", None).unwrap(), "gitlab.com");
        assert_eq!(host_of("gitlab", Some("https://git.example.co.jp:8443/sub/path")).unwrap(), "git.example.co.jp:8443");
        assert_eq!(derive_target("gitlab", None).unwrap().username, "oauth2");
        assert_eq!(derive_target("github", None).unwrap().username, "x-access-token");
    }

    #[test]
    fn normalizes_hosts_like_a_remote_url() {
        assert_eq!(host_of("gitlab", Some("HTTPS://GitLab.Example.COM/g")).unwrap(), "gitlab.example.com");
        assert_eq!(host_of("gitlab", Some("https://gitlab.com:443")).unwrap(), "gitlab.com");
        assert_eq!(host_of("gitlab", Some("https://gitlab.com:1")).unwrap(), "gitlab.com:1");
        assert_eq!(host_of("gitlab", Some("https://gitlab.com:65535")).unwrap(), "gitlab.com:65535");
    }

    #[test]
    fn rejects_bad_hosts() {
        for bad in [
            "https://user@evil.com", "http://gitlab.com", "https://", "https://a b.com", "https://evil.com\nhost=x",
            "https://h:port", "ftp://x.com", "https://exa_mple.com", "https://gitlab.com.", "https://gitlab.com.:8443",
            "https://gitlab.com:0", "https://gitlab.com:70000", "https://gitlab.com:", "https://gitlab.com:+443", "https://.gitlab.com",
        ] {
            assert!(host_of("gitlab", Some(bad)).is_err(), "{bad:?} must be rejected");
        }
        assert!(derive_target("bitbucket", None).is_err());
    }

    #[test]
    fn input_text_is_exact() {
        let target = derive_target("gitlab", None).unwrap();
        assert_eq!(credential_input(&target, Some("tok")), "protocol=https\nhost=gitlab.com\nusername=oauth2\npassword=tok\n\n");
        assert_eq!(credential_input(&target, None), "protocol=https\nhost=gitlab.com\nusername=oauth2\n\n");
    }

    #[test]
    fn inherited_env_drops_config_and_repo_redirects() {
        let parent = ["PATH", "HOME", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_DIR", "GIT_ASKPASS"]
            .map(|name| (OsString::from(name), OsString::from("x")))
            .to_vec();
        let kept: Vec<_> = inherited_env(parent).into_iter().map(|(name, _)| name).collect();
        assert_eq!(kept, vec![OsString::from("PATH"), OsString::from("HOME"), OsString::from("GIT_CONFIG_NOSYSTEM")]);
    }

    struct Sandbox {
        dir: PathBuf,
        run: GitRun,
    }

    impl Sandbox {
        /// `config` is the body of the temp global gitconfig; `{creds}` expands to the temp store file.
        fn new(config: &str) -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let git = llmide_workspace_core::git::git_binary().expect("git");
            let dir = std::env::temp_dir().join(format!("llmide-gitcred-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("gitconfig");
            std::fs::write(&file, config.replace("{creds}", &dir.join("creds").display().to_string())).unwrap();
            let env = vec![
                ("HOME".into(), dir.clone().into()),
                ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_CONFIG_GLOBAL".into(), file.into()),
            ];
            let run = GitRun { git, env, cwd: dir.clone(), cap: Duration::from_secs(20), ledger: Some(dir.join("ledger.json")) };
            Self { dir, run }
        }
        fn with_store() -> Self {
            Self::new("[credential]\n\thelper = store --file {creds}\n")
        }
        fn creds(&self) -> String {
            std::fs::read_to_string(self.dir.join("creds")).unwrap_or_default()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn not_stored() -> GitCredentialResult {
        GitCredentialResult::skipped("not_stored")
    }

    #[test]
    fn rejects_unusable_tokens_without_echoing_them() {
        let sb = Sandbox::with_store();
        for bad in ["tok\nhost=evil.com", "  ", &"x".repeat(513)] {
            let err = save_with(&sb.run, "gitlab", None, Token::from(bad)).unwrap_err();
            assert!(!err.contains("evil.com") && !err.contains("xxxx"));
        }
        assert_eq!(sb.creds(), "");
    }

    #[test]
    fn gitlab_save_then_erase_round_trip() {
        let sb = Sandbox::with_store();
        assert_eq!(save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap(), GitCredentialResult::done());
        assert!(sb.creds().contains("https://oauth2:glpat-abc@gitlab.com"), "creds: {}", sb.creds());
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::done());
        assert!(!sb.creds().contains("gitlab.com"));
    }

    #[test]
    fn github_save_then_erase_round_trip() {
        let sb = Sandbox::with_store();
        assert_eq!(save_with(&sb.run, "github", None, Token::from("ghp_abc")).unwrap(), GitCredentialResult::done());
        assert!(sb.creds().contains("https://x-access-token:ghp_abc@github.com"), "creds: {}", sb.creds());
        assert_eq!(erase_with(&sb.run, "github", None).unwrap(), GitCredentialResult::done());
        assert!(!sb.creds().contains("github.com"));
    }

    #[test]
    fn erase_leaves_another_username_alone() {
        let sb = Sandbox::with_store();
        std::fs::write(sb.dir.join("creds"), "https://alice:secret@gitlab.com\n").unwrap();
        save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap();
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::done());
        let creds = sb.creds();
        assert!(creds.contains("https://alice:secret@gitlab.com") && !creds.contains("oauth2"), "creds: {creds}");
    }

    fn replaced() -> GitCredentialResult {
        GitCredentialResult { stored: true, reason: Some("replaced_existing".into()) }
    }

    #[test]
    fn erase_with_the_token_llmide_wrote_rejects_it() {
        let sb = Sandbox::with_store();
        save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap();
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::done());
        assert!(!sb.creds().contains("oauth2"), "creds: {}", sb.creds());
        assert!(!sb.run.ledger.as_ref().unwrap().exists() || !std::fs::read_to_string(sb.run.ledger.as_ref().unwrap()).unwrap().contains("gitlab.com"));
    }

    #[test]
    fn erase_leaves_the_users_own_credential_in_place() {
        let sb = Sandbox::with_store();
        std::fs::write(sb.dir.join("creds"), "https://oauth2:users-own@gitlab.com\n").unwrap();
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::skipped("left_in_place"));
        assert!(sb.creds().contains("oauth2:users-own@gitlab.com"), "creds: {}", sb.creds());
    }

    #[test]
    fn erase_leaves_a_credential_that_changed_after_llmide_wrote_it() {
        let sb = Sandbox::with_store();
        save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap();
        std::fs::write(sb.dir.join("creds"), "https://oauth2:swapped@gitlab.com\n").unwrap();
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::skipped("left_in_place"));
        assert!(sb.creds().contains("swapped"));
    }

    #[test]
    fn erase_without_a_ledger_cannot_prove_ownership() {
        let mut sb = Sandbox::with_store();
        save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap();
        sb.run.ledger = None;
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::skipped("left_in_place"));
        assert!(sb.creds().contains("glpat-abc"));
    }

    #[test]
    fn erase_with_nothing_stored_touches_nothing() {
        let sb = Sandbox::with_store();
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::skipped("not_present"));
    }

    #[test]
    fn save_over_a_different_existing_credential_reports_the_replacement() {
        let sb = Sandbox::with_store();
        std::fs::write(sb.dir.join("creds"), "https://oauth2:users-own@gitlab.com\n").unwrap();
        assert_eq!(save_with(&sb.run, "gitlab", None, Token::from("glpat-new")).unwrap(), replaced());
        assert!(sb.creds().contains("oauth2:glpat-new@gitlab.com") && !sb.creds().contains("users-own"), "creds: {}", sb.creds());
        // Now LLM-IDE owns it: a later refresh is not a replacement of someone else's login.
        assert_eq!(save_with(&sb.run, "gitlab", None, Token::from("glpat-newer")).unwrap(), GitCredentialResult::done());
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::done());
    }

    #[test]
    fn saving_the_users_identical_token_does_not_claim_it() {
        let sb = Sandbox::with_store();
        std::fs::write(sb.dir.join("creds"), "https://oauth2:same@gitlab.com\n").unwrap();
        assert_eq!(save_with(&sb.run, "gitlab", None, Token::from("same")).unwrap(), GitCredentialResult::done());
        assert_eq!(erase_with(&sb.run, "gitlab", None).unwrap(), GitCredentialResult::skipped("left_in_place"));
        assert!(sb.creds().contains("same"));
    }

    #[test]
    fn no_helper_is_not_stored() {
        let sb = Sandbox::new("");
        assert_eq!(save_with(&sb.run, "github", None, Token::from("ghp_x")).unwrap(), not_stored());
    }

    #[test]
    fn failing_helpers_are_not_stored() {
        for helper in ["!exit 3", "/nonexistent/helper"] {
            let sb = Sandbox::new(&format!("[credential]\n\thelper = {helper}\n"));
            assert_eq!(save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap(), not_stored(), "{helper}");
        }
    }

    #[test]
    fn an_empty_helper_reset_is_not_stored() {
        let sb = Sandbox::new("[credential]\n\thelper = store --file {creds}\n\thelper =\n");
        assert_eq!(save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap(), not_stored());
        assert_eq!(sb.creds(), "");
    }

    #[test]
    fn a_url_scoped_helper_is_stored() {
        let sb = Sandbox::new("[credential \"https://gitlab.com\"]\n\thelper = store --file {creds}\n");
        assert_eq!(save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap(), GitCredentialResult::done());
        assert!(sb.creds().contains("oauth2:glpat-abc@gitlab.com"));
    }

    #[test]
    fn a_stale_entry_does_not_count_as_this_token() {
        // A helper that keeps the first value it saw: the read-back returns another token, so nothing is claimed.
        let sticky = Sandbox::new("[credential]\n\thelper = \"!f() { test \\\"$1\\\" = get && echo password=old; }; f\"\n");
        assert_eq!(save_with(&sticky.run, "gitlab", None, Token::from("new")).unwrap(), not_stored());
    }

    #[test]
    fn a_hung_helper_times_out() {
        let mut sb = Sandbox::new("[credential]\n\thelper = \"!f() { sleep 30; }; f\"\n");
        sb.run.cap = Duration::from_secs(1);
        let started = Instant::now();
        let err = save_with(&sb.run, "gitlab", None, Token::from("glpat-abc")).unwrap_err();
        assert!(err.contains("did not answer") && !err.contains("glpat"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_helper_leaving_a_child_on_the_pipe_does_not_hang_save() {
        let mut sb = Sandbox::new("[credential]\n\thelper = \"!f() { sleep 60 & }; f\"\n");
        sb.run.cap = Duration::from_secs(2);
        let started = Instant::now();
        let result = save_with(&sb.run, "gitlab", None, Token::from("glpat-abc"));
        assert!(started.elapsed() < Duration::from_secs(8), "took {:?}", started.elapsed());
        if let Err(message) = result {
            assert!(!message.contains("glpat"));
        }
    }
}
