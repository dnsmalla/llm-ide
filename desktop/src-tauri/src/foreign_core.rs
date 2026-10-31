//! Best-effort description of a server this app did NOT start that holds the live port
//! (:3456). The host never adopts it in a release build, never sends it credentials and
//! never stops it: this module only READS who is listening so the UI can explain it.
//!
//! macOS: `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` (fixed absolute path, args
//! array, cleared environment, 2 s budget). Other systems: detected, no pid. A lookup that
//! times out is abandoned (its thread finishes on its own); nothing is ever signalled.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

pub const LSOF: &str = "/usr/sbin/lsof";
const LSOF_TIMEOUT: Duration = Duration::from_secs(2);
/// Output beyond this is ignored (a hostile or broken lsof cannot make us buffer without bound).
const MAX_OUTPUT: usize = 64 * 1024;
const MAX_COMMAND_CHARS: usize = 48;

/// Additive `core_status.foreign_core`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ForeignCore {
    pub port: u16,
    pub detected: bool,
    pub pid: Option<u32>,
    pub command: Option<String>,
    /// Plain-language explanation (no paths, no secrets).
    pub notice: String,
}

impl ForeignCore {
    pub fn detected(port: u16) -> Self {
        Self { port, detected: true, pid: None, command: None, notice: notice(port, None) }
    }

    pub fn with_owner(mut self, pid: Option<u32>, command: Option<String>) -> Self {
        self.pid = pid;
        self.command = command;
        self.notice = notice(self.port, pid);
        self
    }
}

fn notice(port: u16, pid: Option<u32>) -> String {
    match pid {
        Some(p) => format!("Another LLM-IDE server is running on port {port} (pid {p}). It is not used by this app."),
        None => format!("Another server is running on port {port}. It is not used by this app."),
    }
}

/// Parses `lsof -Fpc` output: `p<pid>` then `c<command>` lines. The first valid pid wins; the
/// command is the `c` line of that same process. Control characters are stripped, lengths are
/// capped, and anything unparsable is ignored.
pub fn parse_lsof(out: &str) -> (Option<u32>, Option<String>) {
    let mut pid: Option<u32> = None;
    let mut command: Option<String> = None;
    for line in out.lines().take(512) {
        let mut chars = line.chars();
        let Some(tag) = chars.next() else { continue };
        let rest = chars.as_str();
        match tag {
            'p' => {
                if pid.is_some() {
                    break; // a second process: keep the first one only
                }
                // Digits only, short: rejects signs, spaces, huge numbers.
                if !rest.is_empty() && rest.len() <= 10 && rest.bytes().all(|b| b.is_ascii_digit()) {
                    pid = rest.parse::<u32>().ok().filter(|p| *p > 0);
                }
            }
            'c' if pid.is_some() && command.is_none() => {
                let clean: String = rest
                    .chars()
                    .filter(|c| !c.is_control() && *c != '\u{202e}' && *c != '\u{2066}' && *c != '\u{2067}' && *c != '\u{2068}')
                    .take(MAX_COMMAND_CHARS)
                    .collect();
                let clean = clean.trim().to_string();
                if !clean.is_empty() {
                    command = Some(clean);
                }
            }
            _ => {}
        }
    }
    if pid.is_none() {
        command = None;
    }
    (pid, command)
}

/// Looks up the listener on `port`. `None` when unavailable (non-macOS, lsof missing, timeout).
pub fn lookup_owner(port: u16) -> Option<(Option<u32>, Option<String>)> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let child = Command::new(LSOF)
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpc"])
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            let _ = tx.send(None);
            return;
        };
        let mut buf = Vec::new();
        if let Some(out) = child.stdout.take() {
            let _ = out.take(MAX_OUTPUT as u64).read_to_end(&mut buf);
        }
        let _ = child.wait();
        let _ = tx.send(Some(String::from_utf8_lossy(&buf).into_owned()));
    });
    match rx.recv_timeout(LSOF_TIMEOUT) {
        Ok(Some(text)) => Some(parse_lsof(&text)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pid_and_command() {
        assert_eq!(parse_lsof("p4242\ncnode\n"), (Some(4242), Some("node".into())));
    }

    #[test]
    fn first_process_only_and_junk_ignored() {
        let (p, c) = parse_lsof("p12\ncnode\np99\ncother\n");
        assert_eq!((p, c), (Some(12), Some("node".into())));
        assert_eq!(parse_lsof("garbage\n\nzzz"), (None, None));
        assert_eq!(parse_lsof("pabc\ncnode"), (None, None));
        assert_eq!(parse_lsof("p-5\ncx"), (None, None));
        assert_eq!(parse_lsof("p0\ncx"), (None, None));
        assert_eq!(parse_lsof("p99999999999\ncx"), (None, None));
    }

    #[test]
    fn hostile_output_is_scrubbed_and_capped() {
        let (p, c) = parse_lsof("p7\nc\u{1b}[31mno\u{0}de\u{202e}\r\n");
        assert_eq!(p, Some(7));
        let c = c.unwrap();
        assert!(!c.chars().any(|ch| ch.is_control() || ch == '\u{202e}'), "{c:?}");
        let huge = format!("p8\nc{}\n", "a".repeat(1_000_000));
        let (_, c) = parse_lsof(&huge);
        assert_eq!(c.unwrap().chars().count(), MAX_COMMAND_CHARS);
        let many = "x\n".repeat(100_000);
        assert_eq!(parse_lsof(&many), (None, None));
    }

    #[test]
    fn notice_names_the_pid_but_never_offers_to_stop() {
        let f = ForeignCore::detected(3456).with_owner(Some(31), Some("node".into()));
        assert!(f.notice.contains("pid 31") && f.notice.contains("not used by this app"));
        assert!(!f.notice.to_lowercase().contains("kill"));
        assert!(ForeignCore::detected(3456).pid.is_none());
    }

    #[test]
    fn this_module_never_signals_a_process() {
        let src = include_str!("foreign_core.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for banned in ["kill", "libc", "SIGTERM", "SIGKILL", "killpg", "nix::"] {
            // Doc comments may say "never signalled"; code must not call anything of the kind.
            let hit = code.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.contains(banned));
            assert!(!hit, "foreign_core.rs must not use {banned}");
        }
    }
}
