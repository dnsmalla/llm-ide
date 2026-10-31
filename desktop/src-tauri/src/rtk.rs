//! The Mac app's "Token Saving" card: is `rtk` installed, and the Homebrew install button.
//!
//! rtk is a third-party CLI that shrinks shell output before Claude Code reads it. The host only detects it
//! (a short `rtk --version`) and, after a native confirmation, runs `brew install rtk`. Nothing here is on the
//! request path, and the webview never supplies a path, an argument or a command.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Version output is tiny; anything larger is cut.
const MAX_OUTPUT: usize = 8 * 1024;
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RtkStatus {
    pub installed: bool,
    pub version: Option<String>,
    /// Homebrew is present, so the install button can do something.
    pub can_install: bool,
}

/// The directories a user-installed CLI can live in, in order: PATH first, then the usual Homebrew and
/// user-local places (a Finder-launched app's PATH is minimal).
pub fn candidate_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        out.push(PathBuf::from(d));
    }
    if let Some(home) = std::env::var_os("HOME") {
        out.push(PathBuf::from(home).join(".local/bin"));
    }
    out
}

fn is_executable_file(p: &Path) -> bool {
    let Ok(md) = std::fs::metadata(p) else { return false };
    if !md.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    }
}

pub fn find_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| is_executable_file(p))
}

pub fn find_rtk() -> Option<PathBuf> {
    find_in(&candidate_dirs(), "rtk")
}

pub fn find_brew() -> Option<PathBuf> {
    find_in(
        &[
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
        ],
        "brew",
    )
}

/// The first non-empty line of a `--version` answer, cleaned and capped; None when unusable.
pub fn version_line(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let clean: String = line.chars().filter(|c| !c.is_control()).take(120).collect();
    let clean = clean.trim();
    if clean.is_empty() {
        None
    } else {
        Some(clean.to_string())
    }
}

/// Runs a short command with a timeout, capturing stdout+stderr (bounded). Killing on timeout is deliberate:
/// a hung binary must not freeze the detection.
pub fn run_bounded(program: &Path, args: &[&str], timeout: Duration) -> Result<(bool, String), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run {}: {e}", program.display()))?;
    let out = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    // Drain stdout on its own thread and stderr on another: a child that fills the pipe we are not reading
    // would otherwise block until the timeout (Homebrew does this on a slow download).
    let out_thread = out.map(|p| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = p.take(MAX_OUTPUT as u64).read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    });
    let err_thread = err_pipe.take().map(|p| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = p.take(MAX_OUTPUT as u64).read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|e| format!("cannot wait for {}: {e}", program.display()))? {
            Some(status) => {
                let a = out_thread.and_then(|t| t.join().ok()).unwrap_or_default();
                let b = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
                return Ok((status.success(), format!("{a}{b}")));
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the command took too long and was stopped".into());
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// Current status: presence, version (best effort) and whether Homebrew can install it.
pub fn status() -> RtkStatus {
    let can_install = find_brew().is_some();
    match find_rtk() {
        None => RtkStatus { installed: false, version: None, can_install },
        Some(p) => {
            let version = run_bounded(&p, &["--version"], VERSION_TIMEOUT).ok().and_then(|(_, out)| version_line(&out));
            RtkStatus { installed: true, version, can_install }
        }
    }
}

#[tauri::command]
pub async fn rtk_status() -> Result<RtkStatus, String> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|e| format!("task failed: {e}"))
}

/// Asks the user (native dialog, Cancel first), then runs `brew install rtk`. Off the request path either way.
#[tauri::command]
pub async fn rtk_install() -> Result<RtkStatus, String> {
    let Some(brew) = find_brew() else {
        return Err("Homebrew is not installed (looked in /opt/homebrew/bin and /usr/local/bin)".into());
    };
    let text = "Install rtk with Homebrew?\n\nThis runs `brew install rtk`, downloads the package from Homebrew's \
                servers and may take a minute or two. rtk is a separate tool: after installing it, run `rtk init -g` \
                in Terminal to turn it on for your own Claude Code sessions.";
    let accepted = tauri::async_runtime::spawn_blocking(move || crate::confirm::ask("Install rtk?", text, "Install", false))
        .await
        .map_err(|e| format!("task failed: {e}"))?;
    if !accepted {
        return Ok(status());
    }
    let brew = brew.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_bounded(&brew, &["install", "rtk"], INSTALL_TIMEOUT))
        .await
        .map_err(|e| format!("task failed: {e}"))?;
    match result {
        Ok((true, _)) => Ok(status()),
        Ok((false, out)) => {
            let tail: String = out.chars().rev().take(400).collect::<String>().chars().rev().collect();
            Err(format!("Homebrew could not install rtk: {}", tail.trim()))
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-rtk-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn version_lines_are_cleaned_and_capped() {
        assert_eq!(version_line("rtk 0.4.2\n(rustc build)"), Some("rtk 0.4.2".to_string()));
        assert_eq!(version_line("\n\n  rtk 1.0 \r\n"), Some("rtk 1.0".to_string()));
        assert_eq!(version_line(""), None);
        assert_eq!(version_line("   \n \t"), None);
        assert_eq!(version_line(&"x".repeat(300)).unwrap().len(), 120);
        assert!(!version_line("a\u{1}b").unwrap().contains('\u{1}'));
    }

    #[test]
    fn find_in_requires_an_executable_regular_file() {
        let d = scratch("find");
        let tool = d.join("rtk");
        std::fs::write(&tool, "#!/bin/sh\necho rtk 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(find_in(&[d.clone()], "rtk"), Some(tool.clone()));
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(find_in(&[d.clone()], "rtk"), None, "a non-executable file does not count");
        }
        #[cfg(not(unix))]
        assert_eq!(find_in(&[d.clone()], "rtk"), None);
        assert_eq!(find_in(&[d.clone()], "absent"), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn run_bounded_reports_success_and_kills_a_hung_command() {
        #[cfg(unix)]
        {
            let d = scratch("run");
            let ok = d.join("ok.sh");
            std::fs::write(&ok, "#!/bin/sh\necho hello\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&ok, std::fs::Permissions::from_mode(0o755)).unwrap();
            let (success, out) = run_bounded(&ok, &[], Duration::from_secs(3)).unwrap();
            assert!(success);
            assert!(out.contains("hello"));

            let hang = d.join("hang.sh");
            std::fs::write(&hang, "#!/bin/sh\nsleep 30\n").unwrap();
            std::fs::set_permissions(&hang, std::fs::Permissions::from_mode(0o755)).unwrap();
            let started = Instant::now();
            let e = run_bounded(&hang, &[], Duration::from_millis(300)).unwrap_err();
            assert!(e.contains("too long"));
            assert!(started.elapsed() < Duration::from_secs(5), "killed promptly");
            let _ = std::fs::remove_dir_all(&d);
        }
    }
}
