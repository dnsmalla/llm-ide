//! The environment of the user's interactive login shell (`$SHELL -ilc`), for the Loop's shell stages.
//! A Finder/Dock launch gives the app a minimal environment, and `/bin/sh -lc` never reads `~/.zshrc`, where conda,
//! pyenv, nvm and Homebrew set themselves up. This reads PATH plus a fixed list of tool variables (JAVA_HOME,
//! VIRTUAL_ENV, CONDA_*, proxies, …) once, so a stage command finds the same tools as in the user's terminal.
//! Unix only (Windows keeps its own environment). Nothing read here is ever logged: values can carry user names.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const START: &str = "__LLMIDE_ENV_START__";
const END: &str = "__LLMIDE_ENV_END__";
const TIMEOUT: Duration = Duration::from_secs(5);
/// A failed read is tried again at most this often, so one slow shell start does not stick for the whole app run.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// The variables taken from the login shell besides PATH: where language tools and their settings live. A fixed list:
/// nothing else (tokens, keys) is ever copied from the user's shell.
pub const TOOL_VARS: &[&str] = &[
    "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME",
    "PYENV_ROOT", "PYENV_VERSION", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "CONDA_EXE",
    "CONDA_PYTHON_EXE", "NVM_DIR", "NODE_PATH", "VOLTA_HOME", "BUN_INSTALL", "PNPM_HOME", "GEM_HOME", "GEM_PATH",
    "RBENV_ROOT", "SDKMAN_DIR", "DOTNET_ROOT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
];

/// What a stage takes from the user's login shell.
#[derive(Debug, Clone, PartialEq)]
pub struct UserShellEnv {
    pub path: String,
    pub vars: Vec<(String, String)>,
}

static CACHE: Mutex<Option<(Instant, Option<UserShellEnv>)>> = Mutex::new(None);

/// The login shell's PATH and tool variables, or None when `$SHELL` is not an absolute executable or the shell did
/// not answer in time. A success is kept for the app run; a failure is retried after `RETRY_AFTER`.
pub fn user_shell_env() -> Option<UserShellEnv> {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, value)) = cache.as_ref() {
        if value.is_some() || at.elapsed() < RETRY_AFTER {
            return value.clone();
        }
    }
    let shell = std::env::var("SHELL").ok().filter(|s| is_executable_file(s));
    let found = shell.and_then(|s| resolve_with_shell(&s));
    if found.is_none() {
        eprintln!("llmide: could not read the login shell environment; Loop stages keep the app's");
    }
    *cache = Some((Instant::now(), found.clone()));
    found
}

fn is_executable_file(path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    Path::new(path).is_absolute()
        && std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The script the login shell runs: PATH, then each set tool variable, one `NAME=value` per line, between markers.
/// The names are fixed constants, so the `eval` only ever reads `$NAME`.
fn script() -> String {
    let names = TOOL_VARS.join(" ");
    format!(
        "printf '{START}'; printf 'PATH=%s\\n' \"$PATH\"; for v in {names}; do eval \"x=\\${{$v-}}\"; \
         [ -n \"$x\" ] && printf '%s=%s\\n' \"$v\" \"$x\"; done; printf '{END}'"
    )
}

/// Runs `<shell> -ilc <script>` and returns what it printed, validated. Not cached: `user_shell_env` caches.
fn resolve_with_shell(shell: &str) -> Option<UserShellEnv> {
    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(script())
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Read on a thread so a chatty rc file cannot fill the pipe and stall the child until the timeout.
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let stdout = rx.recv_timeout(Duration::from_millis(500)).ok()?;
    parse_env(&parse_marked(&stdout)?)
}

/// The text between the LAST start marker and the end marker after it; banners printed before it are ignored.
fn parse_marked(stdout: &str) -> Option<String> {
    let start = stdout.rfind(START)? + START.len();
    let rest = &stdout[start..];
    let end = rest.find(END)?;
    Some(rest[..end].to_string())
}

/// `NAME=value` lines: PATH must be present and valid; a tool variable is kept only when its name is in `TOOL_VARS`
/// and its value is non-empty with no NUL. Anything else is dropped.
fn parse_env(body: &str) -> Option<UserShellEnv> {
    let mut path = None;
    let mut vars = Vec::new();
    for line in body.lines() {
        let Some((name, value)) = line.split_once('=') else { continue };
        if name == "PATH" {
            path = validate_path(value);
        } else if TOOL_VARS.contains(&name) && !value.is_empty() && !value.contains('\0') {
            vars.push((name.to_string(), value.to_string()));
        }
    }
    Some(UserShellEnv { path: path?, vars })
}

/// Every entry must be a non-empty absolute path with no NUL; an empty entry would mean the current directory.
fn validate_path(path: &str) -> Option<String> {
    if path.is_empty() || path.contains('\0') {
        return None;
    }
    path.split(':').all(|e| e.starts_with('/')).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marked(body: &str) -> String {
        format!("{START}{body}{END}")
    }

    #[test]
    fn parse_skips_banner_noise_and_takes_the_last_marker_pair() {
        let out = format!("Welcome!\n{}\nnoise {}", marked("PATH=/old\n"), marked("PATH=/usr/bin:/bin\n"));
        assert_eq!(parse_marked(&out).as_deref(), Some("PATH=/usr/bin:/bin\n"));
        assert_eq!(parse_marked(&format!("{START}PATH=/usr/bin")), None);
        assert_eq!(parse_marked("no markers at all"), None);
    }

    #[test]
    fn env_keeps_path_and_listed_tool_vars_only() {
        let env = parse_env("PATH=/opt/conda/bin:/usr/bin\nJAVA_HOME=/jdk\nAWS_SECRET_ACCESS_KEY=x\nVIRTUAL_ENV=\nnoline\n").unwrap();
        assert_eq!(env.path, "/opt/conda/bin:/usr/bin");
        assert_eq!(env.vars, vec![("JAVA_HOME".to_string(), "/jdk".to_string())], "unlisted and empty vars are dropped");
        assert_eq!(parse_env("JAVA_HOME=/jdk\n"), None, "no PATH, nothing");
        assert_eq!(parse_env("PATH=/usr/bin:bin\n"), None, "a relative PATH entry is refused");
    }

    #[test]
    fn validate_rejects_relative_empty_and_nul_entries() {
        assert_eq!(validate_path("/usr/bin:/opt/x/bin").as_deref(), Some("/usr/bin:/opt/x/bin"));
        assert_eq!(validate_path("/usr/bin:bin"), None);
        assert_eq!(validate_path("/usr/bin::/bin"), None);
        assert_eq!(validate_path("/usr/bin:"), None);
        assert_eq!(validate_path(""), None);
        assert_eq!(validate_path("/usr/\0bin"), None);
    }

    #[test]
    fn a_real_login_shell_answers_with_its_path_and_tool_vars() {
        let env = resolve_with_shell("/bin/sh").expect("/bin/sh should print a valid PATH");
        assert!(!env.path.is_empty());
        let mut c = Command::new("/bin/sh");
        c.arg("-ilc").arg(script()).env("TERM", "dumb").env("JAVA_HOME", "/test/jdk").stdin(Stdio::null());
        let out = String::from_utf8_lossy(&c.output().unwrap().stdout).into_owned();
        let env = parse_env(&parse_marked(&out).unwrap()).unwrap();
        assert!(env.vars.contains(&("JAVA_HOME".to_string(), "/test/jdk".to_string())), "a set tool variable is carried");
    }
}
