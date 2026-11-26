//! Waiting for a child process under a time cap, with its pipes drained and its whole process tree killed.
//!
//! Three callers used to hand-roll this: the core's git runner (stdout cap), the clone (cancel flag) and the host's
//! credential helper (stdin feed, pipes that a grandchild may hold open). One loop keeps their limits the same.
//!
//! NOTE: the pipes are collected under the SAME deadline as the exit. A grandchild that outlives git and keeps a pipe
//! open therefore ends the wait as `PipesHeld` (and the tree is killed) instead of hanging the caller forever.

use std::io::{self, Read};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use crate::git::kill_tree;

const POLL: Duration = Duration::from_millis(10);
/// How long the pipes get after the child was killed on purpose; the kill closes them, so this is a backstop.
const AFTER_KILL: Duration = Duration::from_secs(2);
/// Minimum time the pipes get after the child exited by itself, so one that exits right at its deadline still has its
/// output read. A grandchild holding a pipe is still cut off after this.
const AFTER_EXIT_GRACE: Duration = Duration::from_secs(2);

/// What to enforce. A pipe that is not piped on the child is simply read as empty.
pub struct Limits<'a> {
    pub timeout: Duration,
    /// When set to true the child is killed and the wait ends as `Cancelled`.
    pub cancel: Option<&'a AtomicBool>,
    /// Bytes of stdout kept; `None` does not take the pipe at all (the child keeps its handle). One byte more is read, to tell that the output was cut.
    pub stdout_cap: Option<usize>,
    /// Bytes of stderr kept. The rest is read and thrown away, so the child never blocks on a full pipe.
    pub stderr_keep: usize,
    /// Kill the child as soon as stdout is done (full or closed). The git runner uses this so a command that fills
    /// the cap is stopped instead of running on.
    pub stop_on_stdout_end: bool,
}

#[derive(Debug)]
pub enum Ending {
    Exited(ExitStatus),
    /// Still running at the deadline; killed.
    TimedOut,
    /// The cancel flag was set; killed.
    Cancelled,
    /// The child exited but something still held a pipe open at the deadline; the tree was killed.
    PipesHeld,
    /// The feed closure failed (stdin write); the child was killed.
    FeedFailed(io::Error),
}

#[derive(Debug)]
pub struct Ran {
    pub ending: Ending,
    pub stdout: Vec<u8>,
    /// More stdout was produced than `stdout_cap`.
    pub stdout_truncated: bool,
    pub stderr: Vec<u8>,
}

/// The stdout drain: its result, and a flag that is set when the drain has ended (full or closed).
struct StdoutDrain {
    rx: Receiver<(Vec<u8>, bool)>,
    ended: Arc<AtomicBool>,
}

fn drain_stdout(stream: Option<impl Read + Send + 'static>, cap: Option<usize>) -> Option<StdoutDrain> {
    let (mut stream, cap) = (stream?, cap?);
    let (tx, rx) = channel();
    let ended = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ended);
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stream).take(cap as u64 + 1).read_to_end(&mut buf);
        let over = buf.len() > cap;
        buf.truncate(cap);
        flag.store(true, Ordering::SeqCst);
        let _ = tx.send((buf, over));
    });
    Some(StdoutDrain { rx, ended })
}

fn drain_stderr(stream: Option<impl Read + Send + 'static>, keep: usize) -> Option<Receiver<Vec<u8>>> {
    let mut stream = stream?;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stream).take(keep as u64).read_to_end(&mut buf);
        let _ = io::copy(&mut stream, &mut io::sink());
        let _ = tx.send(buf);
    });
    Some(rx)
}

/// Waits for `child` under `limits`. `feed` runs once after the pipes are being drained (it writes the child's stdin);
/// a failure kills the child. The child is always reaped before this returns.
pub fn run_capped(child: &mut Child, limits: &Limits<'_>, feed: impl FnOnce(&mut Child) -> io::Result<()>) -> Ran {
    let out = limits.stdout_cap.and_then(|cap| drain_stdout(child.stdout.take(), Some(cap)));
    let err = drain_stderr(child.stderr.take(), limits.stderr_keep);
    let deadline = Instant::now() + limits.timeout;
    let ending = match feed(child) {
        Err(e) => {
            kill_tree(child);
            let _ = child.wait();
            Ending::FeedFailed(e)
        }
        Ok(()) => wait_for_exit(child, limits, deadline, out.as_ref()),
    };
    collect(ending, out, err, deadline, child)
}

fn wait_for_exit(child: &mut Child, limits: &Limits<'_>, deadline: Instant, out: Option<&StdoutDrain>) -> Ending {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ending::Exited(status),
            Err(_) => {
                kill_tree(child);
                let _ = child.wait();
                return Ending::TimedOut;
            }
            Ok(None) => {}
        }
        let kill = if limits.cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            Some(Ending::Cancelled)
        } else if Instant::now() >= deadline {
            Some(Ending::TimedOut)
        } else {
            None
        };
        if let Some(ending) = kill {
            kill_tree(child);
            let _ = child.wait();
            return ending;
        }
        if limits.stop_on_stdout_end && out.is_some_and(|drain| drain.ended.load(Ordering::SeqCst)) {
            kill_tree(child);
            return child.wait().map_or(Ending::TimedOut, Ending::Exited);
        }
        std::thread::sleep(POLL);
    }
}

fn collect(ending: Ending, out: Option<StdoutDrain>, err: Option<Receiver<Vec<u8>>>, deadline: Instant, child: &mut Child) -> Ran {
    let killed = !matches!(ending, Ending::Exited(_));
    let limit = if killed { Instant::now() + AFTER_KILL } else { deadline.max(Instant::now() + AFTER_EXIT_GRACE) };
    let wait = |now: Instant| limit.saturating_duration_since(now);
    let mut ending = ending;
    let (stdout, truncated) = match out {
        Some(drain) => drain.rx.recv_timeout(wait(Instant::now())).unwrap_or_else(|_| {
            pipes_held(&mut ending, child);
            (Vec::new(), false)
        }),
        None => (Vec::new(), false),
    };
    let stderr = match err {
        Some(rx) => rx.recv_timeout(wait(Instant::now())).unwrap_or_else(|_| {
            pipes_held(&mut ending, child);
            Vec::new()
        }),
        None => Vec::new(),
    };
    Ran { ending, stdout, stdout_truncated: truncated, stderr }
}

/// A pipe stayed open past the deadline: whatever holds it is killed with the group.
fn pipes_held(ending: &mut Ending, child: &mut Child) {
    kill_tree(child);
    if matches!(ending, Ending::Exited(_)) {
        *ending = Ending::PipesHeld;
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn shell(script: &str) -> Child {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        cmd.spawn().unwrap()
    }

    fn limits(timeout_ms: u64) -> Limits<'static> {
        Limits { timeout: Duration::from_millis(timeout_ms), cancel: None, stdout_cap: Some(1024), stderr_keep: 16, stop_on_stdout_end: false }
    }

    #[test]
    fn a_finished_child_returns_its_output_and_kept_stderr() {
        let mut child = shell("echo out; echo 0123456789abcdefXYZ >&2; exit 3");
        let ran = run_capped(&mut child, &limits(5000), |_| Ok(()));
        assert!(matches!(ran.ending, Ending::Exited(s) if s.code() == Some(3)));
        assert_eq!(ran.stdout, b"out\n");
        assert_eq!(ran.stderr.len(), 16, "stderr is cut to what the caller keeps");
    }

    #[test]
    fn a_child_past_the_cap_is_killed() {
        let mut child = shell("sleep 30");
        let started = Instant::now();
        let ran = run_capped(&mut child, &limits(200), |_| Ok(()));
        assert!(matches!(ran.ending, Ending::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_set_cancel_flag_kills_the_child() {
        let flag = AtomicBool::new(true);
        let mut child = shell("sleep 30");
        let ran = run_capped(&mut child, &Limits { cancel: Some(&flag), ..limits(5000) }, |_| Ok(()));
        assert!(matches!(ran.ending, Ending::Cancelled));
    }

    #[test]
    fn output_past_the_cap_is_flagged_and_the_child_stopped() {
        let mut child = shell("yes");
        let ran = run_capped(&mut child, &Limits { stop_on_stdout_end: true, ..limits(5000) }, |_| Ok(()));
        assert!(ran.stdout_truncated && ran.stdout.len() == 1024);
        assert!(matches!(ran.ending, Ending::Exited(_)));
    }

    #[test]
    fn a_pipe_held_by_a_grandchild_ends_as_pipes_held() {
        let mut child = shell("sleep 30 & echo done");
        let started = Instant::now();
        let ran = run_capped(&mut child, &limits(300), |_| Ok(()));
        assert!(matches!(ran.ending, Ending::PipesHeld), "{:?}", ran.ending);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_child_exiting_at_the_deadline_still_returns_its_output() {
        let mut child = shell("sleep 0.3; echo late");
        let ran = run_capped(&mut child, &limits(400), |_| Ok(()));
        assert!(matches!(ran.ending, Ending::Exited(s) if s.success()), "{:?}", ran.ending);
        assert_eq!(ran.stdout, b"late\n");
    }

    #[test]
    fn a_failed_feed_kills_the_child() {
        let mut child = shell("sleep 30");
        let ran = run_capped(&mut child, &limits(5000), |_| Err(io::Error::other("no stdin")));
        assert!(matches!(ran.ending, Ending::FeedFailed(_)));
    }
}
