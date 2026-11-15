//! Keeps the `-L` forward to a server core alive across connection drops.
//!
//! [`supervise`] takes a connection that [`crate::ssh_session::connect`] verified and watches its forward.
//! When the forward exits (network drop, laptop sleep), it backs off, asks the server for the core's state
//! with the constant STATUS script, and reopens the forward on the same local port. The server core is
//! never stopped, started or replaced from here.
//!
//! The password is held only in [`Shared`], and only as a [`Secret`] that is zeroed on drop. It is never
//! formatted, logged, or placed in an argv or environment variable by this module.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::core_host::ct_eq;
use crate::fs_ops::FsError;
use crate::ssh_server_scripts::{parse_core_state, STATUS};
use crate::ssh_session::{open_forward, wait_for_core, Connected, Link, NO_ANSWER_CODE};
use crate::ssh_transport::{ForwardChild, SshEndpoint, SshExec};

/// The one-line known_hosts folder of one endpoint. Removed when dropped, so it lives exactly as long as the
/// link (or the call) that reads it. Only folders this app created may be owned: dropping removes the folder
/// with everything in it.
pub struct KnownHostsDir {
    pub(crate) dir: PathBuf,
    pub(crate) file: PathBuf,
}

impl KnownHostsDir {
    /// Takes ownership of `dir`, a folder this app created, whose `known_hosts` file the callers read.
    pub(crate) fn owning(dir: PathBuf) -> Self {
        let file = dir.join("known_hosts");
        Self { dir, file }
    }
}

impl Drop for KnownHostsDir {
    fn drop(&mut self) {
        // Best effort: a folder left behind holds only the public pin line.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// How long the forward may take to answer `/health` after a respawn, matching the first connect.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

/// How often a healthy forward is checked for exit.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// The longest pause before a reconnect attempt; backoff doubles from 1 s up to this value.
const MAX_BACKOFF: Duration = Duration::from_secs(15);

/// Granularity of the sleeps, so a stop is noticed within this long.
const WAKE_INTERVAL: Duration = Duration::from_millis(50);

/// How long [`SshLink::stop`] waits for the supervisor thread to finish before it gives up on it.
const STOP_WAIT: Duration = Duration::from_secs(1);

/// Consecutive reattach attempts of one kind that failed, before the link gives up. A forward that fails at once
/// (for example, the local port is taken by another program) fails the same way every time; retrying forever would
/// leave the state at `reconnecting` with no way out. The same limit applies to a forward that stays up while
/// `/health` never answers.
const MAX_FORWARD_FAILURES: u32 = 5;

const STOPPED_CODE: &str = "SSH_LINK_STOPPED";
const CORE_STOPPED_CODE: &str = "SSH_CORE_STOPPED";
const CORE_STOPPED_MESSAGE: &str = "The server core is not running. Connect again to start it.";
const CORE_FOREIGN_CODE: &str = "SSH_CORE_FOREIGN";
const CORE_FOREIGN_MESSAGE: &str = "A different core is running on the server now, so it was left alone.";
const FORWARD_FAILED_CODE: &str = "SSH_FORWARD_FAILED";
const FORWARD_FAILED_MESSAGE: &str = "The local port for this server is in use. Quit the other program and connect again.";
const UNRESPONSIVE_CODE: &str = "SSH_CORE_UNRESPONSIVE";
const UNRESPONSIVE_MESSAGE: &str = "The server core is not answering. Stop the server and connect again.";

/// What the link reports to the app. Carries no secret and no ssh output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkState {
    /// The forward is up and `/health` answered with the nonce of the core it was opened for.
    Connected,
    /// The forward dropped; `attempt` counts the reconnect tries since then, starting at 1.
    Reconnecting { attempt: u32 },
    /// The server refused the login, so the app must ask for the password again.
    NeedsPassword,
    /// Reconnecting cannot succeed without a user action. `code` is a fixed string.
    Failed { code: &'static str, message: String },
}

/// Everything [`supervise`] needs. Owned, because the supervisor thread outlives the caller's stack.
pub struct SuperviseInput {
    pub exec: Arc<dyn SshExec>,
    pub connected: Connected,
    pub endpoint: SshEndpoint,
    pub password: Option<String>,
    /// The known_hosts folder the link reads. The link owns it: it is removed when the link stops or drops.
    pub known_hosts: KnownHostsDir,
    /// Returns the nonce `/health` echoes on a local port, or `None` when nothing answers.
    pub health: Arc<dyn Fn(u16) -> Option<String> + Send + Sync>,
}

/// A supervised forward. Dropping it stops the supervisor and never touches the server core.
pub struct SshLink {
    shared: Arc<Shared>,
    url: String,
    worker: Mutex<Option<JoinHandle<()>>>,
    /// Taken by [`SshLink::stop`] once the supervisor has had its chance to finish, so the folder is removed on
    /// every path that ends the link: disconnect, replace, shutdown, panic cleanup and a failed open.
    known_hosts: Mutex<Option<KnownHostsDir>>,
}

impl SshLink {
    /// The state as last set by the supervisor, or the stopped state after [`SshLink::stop`].
    pub fn state(&self) -> LinkState {
        self.shared.state()
    }

    /// The local URL. Fixed for the life of the link, because every reconnect reuses the same port.
    pub fn url(&self) -> String {
        self.url.clone()
    }

    /// Ends supervision, kills the forward and removes the known_hosts folder. The supervisor thread is given up
    /// to a second to finish, which it normally does within one wake interval. A thread still inside an ssh call
    /// then reads a missing known_hosts, which makes ssh refuse the host (`StrictHostKeyChecking=yes`); the server
    /// core is left running.
    pub fn stop(&self) {
        self.shared.halt();
        wait_briefly(&self.worker);
        // Taken out of the lock first, so the folder is removed without holding it.
        let held = locked(&self.known_hosts).take();
        drop(held);
    }

    /// The known_hosts file this link reads, while the link still owns its folder. Tests use it to check the
    /// folder's lifetime.
    #[cfg(test)]
    pub(crate) fn known_hosts_file(&self) -> Option<PathBuf> {
        locked(&self.known_hosts).as_ref().map(|held| held.file.clone())
    }
}

impl Drop for SshLink {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Starts supervising `input.connected`'s forward on a background thread and returns at once.
///
/// Preconditions: `input.connected` came from a successful connect, so its forward is running.
/// Postconditions: the state is `Connected` until the forward drops. A stop kills the forward.
pub fn supervise(input: SuperviseInput) -> SshLink {
    let SuperviseInput { exec, connected, endpoint, password, known_hosts, health } = input;
    let shared = Arc::new(Shared::new(password));
    let url = connected.local_url.clone();
    let worker_shared = shared.clone();
    let known_file = known_hosts.file.clone();
    let worker = std::thread::spawn(move || {
        let Connected { local_port, nonce, forward, .. } = connected;
        let sup = Supervision {
            exec: &*exec,
            endpoint: &endpoint,
            known_hosts: &known_file,
            health: &*health,
            shared: &worker_shared,
            local_port,
            nonce: &nonce,
            health_timeout: HEALTH_TIMEOUT,
        };
        let mut pause = |pause: Pause| sleep_unless_stopped(&worker_shared, pause);
        supervise_loop(&sup, forward, &mut pause);
    });
    SshLink { shared, url, worker: Mutex::new(Some(worker)), known_hosts: Mutex::new(Some(known_hosts)) }
}

/// One wait the loop asks for. The production waits sleep; tests record them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pause {
    /// Between two checks of a healthy forward.
    Poll,
    /// Before reconnect attempt, so only these count toward the backoff sequence.
    Backoff(Duration),
}

/// The password bytes. Zeroed on drop and deliberately without `Debug` or `Display`.
struct Secret(String);

impl Secret {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // Zero the buffer itself; dropping the String alone would leave the bytes in freed memory.
        let mut bytes = std::mem::take(&mut self.0).into_bytes();
        wipe(&mut bytes);
    }
}

/// State shared between the supervisor thread and the owner of [`SshLink`].
struct Shared {
    state: Mutex<LinkState>,
    /// Set under the `state` lock, so a late `set_state` cannot overwrite the stopped state.
    stopped: AtomicBool,
    password: Mutex<Option<Secret>>,
}

impl Shared {
    fn new(password: Option<String>) -> Self {
        Self {
            state: Mutex::new(LinkState::Connected),
            stopped: AtomicBool::new(false),
            password: Mutex::new(password.map(Secret)),
        }
    }

    fn state(&self) -> LinkState {
        locked(&self.state).clone()
    }

    /// Records `next` unless a stop has already been requested.
    fn set_state(&self, next: LinkState) {
        let mut state = locked(&self.state);
        if !self.stopped.load(Ordering::SeqCst) {
            *state = next;
        }
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Requests a stop and wipes the password. The lock is released before the password is dropped, so
    /// nothing waits on a wipe.
    fn halt(&self) {
        {
            let mut state = locked(&self.state);
            self.stopped.store(true, Ordering::SeqCst);
            *state = LinkState::Failed { code: STOPPED_CODE, message: "The connection was closed.".to_string() };
        }
        let taken = locked(&self.password).take();
        drop(taken);
    }

    /// A copy for one ssh call. The copy is zeroed when the caller drops it.
    fn password_copy(&self) -> Option<Secret> {
        locked(&self.password).as_ref().map(|secret| Secret(secret.0.clone()))
    }
}

/// Everything one supervision run reads. Borrowed, so tests can build it around fakes.
struct Supervision<'a> {
    exec: &'a dyn SshExec,
    endpoint: &'a SshEndpoint,
    known_hosts: &'a std::path::Path,
    health: &'a dyn Fn(u16) -> Option<String>,
    shared: &'a Shared,
    local_port: u16,
    nonce: &'a str,
    health_timeout: Duration,
}

/// Why one reconnect attempt did not reattach. `Retry` tries again after the next backoff. `ForwardRetry` is the
/// same, but the server confirmed its core and the local forward failed (it could not start, exited, or another
/// program answered on the port). `Unresponsive` is also a confirmed core, but the forward stayed up and `/health`
/// never answered with the nonce. Both failure kinds count toward [`MAX_FORWARD_FAILURES`] in one streak.
enum Attempt {
    Retry,
    ForwardRetry,
    Unresponsive,
    Halt(LinkState),
}

/// Watches a forward and reconnects it until a stop or a state that needs the user.
fn supervise_loop(sup: &Supervision<'_>, mut forward: Box<dyn ForwardChild>, pause: &mut dyn FnMut(Pause)) {
    loop {
        if !watch_until_exit(sup, forward.as_mut(), pause) {
            forward.kill();
            return;
        }
        // The exited child is reaped here; a second kill on an exited child is harmless.
        forward.kill();
        let Some(next) = reconnect(sup, pause) else {
            return;
        };
        forward = next;
        sup.shared.set_state(LinkState::Connected);
    }
}

/// Polls a healthy forward. Returns `true` when it exits, `false` when a stop was requested first.
fn watch_until_exit(sup: &Supervision<'_>, forward: &mut dyn ForwardChild, pause: &mut dyn FnMut(Pause)) -> bool {
    loop {
        if sup.shared.is_stopped() {
            return false;
        }
        if forward.try_exited().is_some() {
            return true;
        }
        pause(Pause::Poll);
    }
}

/// Runs reconnect attempts until one reattaches. Returns `None` when a stop was requested or an attempt
/// reached a state that needs the user; in the second case that state is already recorded.
fn reconnect(sup: &Supervision<'_>, pause: &mut dyn FnMut(Pause)) -> Option<Box<dyn ForwardChild>> {
    let mut attempt: u32 = 0;
    // One streak of failed reattaches, of either kind. A streak that mixes the two still ends, so the link never
    // retries forever. An attempt that could not reach the server's STATUS says nothing about the local port or the
    // core, so it starts the streak again. The give-up code is the silent one only when every failure was silent.
    let mut failures: u32 = 0;
    let mut all_silent = true;
    loop {
        if sup.shared.is_stopped() {
            return None;
        }
        attempt = attempt.saturating_add(1);
        sup.shared.set_state(LinkState::Reconnecting { attempt });
        pause(Pause::Backoff(backoff_for(attempt)));
        if sup.shared.is_stopped() {
            return None;
        }
        match try_reattach(sup) {
            Ok(next) => return Some(next),
            Err(Attempt::Retry) => {
                failures = 0;
                all_silent = true;
            }
            Err(failed @ (Attempt::ForwardRetry | Attempt::Unresponsive)) => {
                failures += 1;
                all_silent &= matches!(failed, Attempt::Unresponsive);
                if failures >= MAX_FORWARD_FAILURES {
                    let (code, message) = if all_silent {
                        (UNRESPONSIVE_CODE, UNRESPONSIVE_MESSAGE)
                    } else {
                        (FORWARD_FAILED_CODE, FORWARD_FAILED_MESSAGE)
                    };
                    sup.shared.set_state(LinkState::Failed { code, message: message.to_string() });
                    return None;
                }
            }
            Err(Attempt::Halt(state)) => {
                sup.shared.set_state(state);
                return None;
            }
        }
    }
}

/// One attempt: confirm the core with STATUS, respawn the forward on the same local port to the port
/// STATUS reports, and wait for `/health` to echo the nonce. On any failure after a spawn, the forward is
/// killed before returning.
fn try_reattach(sup: &Supervision<'_>) -> Result<Box<dyn ForwardChild>, Attempt> {
    let secret = sup.shared.password_copy();
    let link = Link {
        exec: sup.exec,
        endpoint: sup.endpoint,
        known_hosts: sup.known_hosts,
        password: secret.as_ref().map(Secret::as_str),
    };
    let remote_port = status_port(&link, sup.nonce)?;
    // Checked after the STATUS call, which can take a while, so a stop never spawns a new forward.
    if sup.shared.is_stopped() {
        return Err(Attempt::Retry);
    }
    let (mut forward, _grant) = open_forward(&link, sup.local_port, remote_port).map_err(|_| Attempt::ForwardRetry)?;
    let mut watched = StopAware { inner: &mut *forward, stop: &sup.shared.stopped };
    let healthy = wait_for_core(&mut watched, sup.health, sup.local_port, sup.nonce, sup.health_timeout);
    match healthy {
        Ok(()) => Ok(forward),
        Err(error) => {
            forward.kill();
            // A timeout with the forward still up means the core did not answer. Any other failure here is the local
            // forward: it exited, or another program answered on the port.
            if error.code == NO_ANSWER_CODE {
                Err(Attempt::Unresponsive)
            } else {
                Err(Attempt::ForwardRetry)
            }
        }
    }
}

/// Reads the core's state through the constant STATUS script and classifies the answer. Only a core that
/// is running with this session's nonce yields a port to reattach to.
fn status_port(link: &Link<'_>, nonce: &str) -> Result<u16, Attempt> {
    let output = link.run(STATUS, None).map_err(classify_transport)?;
    let state = parse_core_state(&output.stdout).map_err(|_| Attempt::Retry)?;
    if !state.running {
        return Err(Attempt::Halt(LinkState::Failed {
            code: CORE_STOPPED_CODE,
            message: CORE_STOPPED_MESSAGE.to_string(),
        }));
    }
    if !state.nonce.as_deref().is_some_and(|seen| ct_eq(seen, nonce)) {
        return Err(Attempt::Halt(LinkState::Failed {
            code: CORE_FOREIGN_CODE,
            message: CORE_FOREIGN_MESSAGE.to_string(),
        }));
    }
    state.port.ok_or(Attempt::Retry)
}

/// Maps a STATUS transport failure to the next step. Only a refused login and a changed host key stop the
/// retries; everything else (unreachable, a timeout) is worth another attempt after the backoff.
fn classify_transport(error: FsError) -> Attempt {
    match error.code {
        "SSH_AUTH_FAILED" => Attempt::Halt(LinkState::NeedsPassword),
        "SSH_HOST_KEY_CHANGED" => {
            Attempt::Halt(LinkState::Failed { code: "SSH_HOST_KEY_CHANGED", message: error.message })
        }
        _ => Attempt::Retry,
    }
}

/// Hides the forward from `wait_for_core` once a stop is requested, so the health wait ends within one
/// poll instead of running out its full timeout. The caller kills the real child afterwards.
struct StopAware<'a> {
    inner: &'a mut dyn ForwardChild,
    stop: &'a AtomicBool,
}

impl ForwardChild for StopAware<'_> {
    fn try_exited(&mut self) -> Option<i32> {
        if self.stop.load(Ordering::SeqCst) {
            return Some(-1);
        }
        self.inner.try_exited()
    }

    fn kill(&mut self) {
        self.inner.kill();
    }
}

/// Seconds to wait before reconnect `attempt` (1-based): 1, 2, 4, 8, then 15 for every later attempt.
fn backoff_for(attempt: u32) -> Duration {
    let secs = 1u64.checked_shl(attempt.saturating_sub(1)).unwrap_or(u64::MAX);
    Duration::from_secs(secs.min(MAX_BACKOFF.as_secs()))
}

/// The production wait. Sleeps in short slices so a stop cuts it short.
fn sleep_unless_stopped(shared: &Shared, pause: Pause) {
    let duration = match pause {
        Pause::Poll => POLL_INTERVAL,
        Pause::Backoff(delay) => delay,
    };
    let deadline = Instant::now() + duration;
    while !shared.is_stopped() {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        std::thread::sleep(WAKE_INTERVAL.min(deadline - now));
    }
}

/// Waits up to [`STOP_WAIT`] for the supervisor thread to finish. A thread still busy after that is left
/// to stop on its own at its next check; it cannot outlive a stop by more than one blocking step.
fn wait_briefly(worker: &Mutex<Option<JoinHandle<()>>>) {
    let deadline = Instant::now() + STOP_WAIT;
    loop {
        let finished = match &*locked(worker) {
            Some(handle) => handle.is_finished(),
            None => return,
        };
        if finished {
            // Taken out first, so the lock is not held while joining.
            let handle = locked(worker).take();
            if let Some(handle) = handle {
                let _ = handle.join();
            }
            return;
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Locks a mutex, recovering the data from a poisoned lock. The guarded values are plain state, so a
/// panic elsewhere cannot leave them half-written in a way that matters here.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Overwrites a buffer with zeros. `black_box` keeps the compiler from removing the stores as dead.
fn wipe(buf: &mut [u8]) {
    buf.fill(0);
    std::hint::black_box(buf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::RawOutput;
    use crate::ssh_server_scripts::parse_probe;
    use crate::ssh_session::tests::{
        key_endpoint, probe_out, ssh_error, state_out, FakeExec, NEW, PASSWORD, PERMISSION_DENIED, TIMED_OUT,
    };
    use crate::ssh_transport::SshAuth;
    use std::sync::atomic::AtomicUsize;

    const LOCAL_PORT: u16 = 3456;
    const REMOTE_PORT: u16 = 3460;
    const LOCAL_URL: &str = "http://127.0.0.1:3456";

    /// A forward whose exit is scripted: `try_exited` reports 255 once `exited` is set.
    struct ScriptedForward {
        exited: Arc<AtomicBool>,
        kills: Arc<AtomicUsize>,
    }

    impl ForwardChild for ScriptedForward {
        fn try_exited(&mut self) -> Option<i32> {
            self.exited.load(Ordering::SeqCst).then_some(255)
        }

        fn kill(&mut self) {
            self.kills.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// One forward plus the flags a test uses to drive it.
    #[derive(Clone)]
    struct Handle {
        exited: Arc<AtomicBool>,
        kills: Arc<AtomicUsize>,
    }

    impl Handle {
        fn new() -> Self {
            Self { exited: Arc::new(AtomicBool::new(false)), kills: Arc::new(AtomicUsize::new(0)) }
        }

        fn forward(&self) -> Box<dyn ForwardChild> {
            Box::new(ScriptedForward { exited: self.exited.clone(), kills: self.kills.clone() })
        }

        fn kill_count(&self) -> usize {
            self.kills.load(Ordering::SeqCst)
        }
    }

    /// What one run of the loop saw at each wait.
    #[derive(Default)]
    struct Observed {
        pauses: Vec<Pause>,
        states: Vec<LinkState>,
        urls: Vec<String>,
    }

    impl Observed {
        fn backoffs(&self) -> Vec<Duration> {
            self.pauses
                .iter()
                .filter_map(|p| match p {
                    Pause::Backoff(d) => Some(*d),
                    Pause::Poll => None,
                })
                .collect()
        }
    }

    fn healthy() -> impl Fn(u16) -> Option<String> {
        |_| Some(NEW.to_string())
    }

    fn connected_with(forward: Box<dyn ForwardChild>) -> Connected {
        let claude = parse_probe(&probe_out("2.0.0").unwrap().stdout).unwrap().claude;
        Connected {
            local_url: LOCAL_URL.to_string(),
            local_port: LOCAL_PORT,
            remote_port: REMOTE_PORT,
            nonce: NEW.to_string(),
            version: "2.0.0".to_string(),
            claude,
            forward,
        }
    }

    /// Runs the real loop on this thread with fake waits. `on_pause` sees each wait after it has been
    /// recorded and may stop the link. After 40 waits the run stops by itself, so a broken loop fails
    /// the test instead of hanging it.
    fn drive(
        fake: &FakeExec,
        password: Option<&str>,
        first: Box<dyn ForwardChild>,
        health: &dyn Fn(u16) -> Option<String>,
        mut on_pause: impl FnMut(&SshLink, &mut Observed),
    ) -> (SshLink, Observed) {
        let shared = Arc::new(Shared::new(password.map(str::to_string)));
        let held = scratch_known_hosts();
        let known_hosts = held.file.clone();
        let link = SshLink {
            shared: shared.clone(),
            url: LOCAL_URL.to_string(),
            worker: Mutex::new(None),
            known_hosts: Mutex::new(Some(held)),
        };
        let endpoint = match password {
            Some(_) => crate::ssh_transport::prepare_endpoint("example.com", 22, "alice", SshAuth::Password).unwrap(),
            None => key_endpoint(),
        };
        let sup = Supervision {
            exec: fake,
            endpoint: &endpoint,
            known_hosts: &known_hosts,
            health,
            shared: &shared,
            local_port: LOCAL_PORT,
            nonce: NEW,
            health_timeout: Duration::ZERO,
        };
        let mut observed = Observed::default();
        let mut waits = 0usize;
        let mut pause = |pause: Pause| {
            waits += 1;
            observed.pauses.push(pause);
            observed.states.push(link.state());
            observed.urls.push(link.url());
            if waits > 40 {
                link.stop();
                return;
            }
            on_pause(&link, &mut observed);
        };
        supervise_loop(&sup, first, &mut pause);
        (link, observed)
    }

    /// A known_hosts folder this test owns; the link removes it when it stops.
    fn scratch_known_hosts() -> KnownHostsDir {
        let dir = crate::remote::temp_ssh_dir("link-test").unwrap();
        let held = KnownHostsDir::owning(dir);
        std::fs::write(&held.file, "pinned line\n").unwrap();
        held
    }

    fn forward_args_for(fake: &FakeExec) -> Vec<Vec<String>> {
        fake.calls().into_iter().filter(|c| c.name == "forward").map(|c| c.args).collect()
    }

    fn contains_pair(args: &[String], value: &str) -> bool {
        args.windows(2).any(|w| w[0] == "-L" && w[1] == value)
    }

    #[test]
    fn exit_triggers_reconnect() {
        let first = Handle::new();
        let second = Handle::new();
        let fake = FakeExec::new(vec![state_out(REMOTE_PORT, NEW, "2.0.0")]);
        fake.queue_forward(second.forward());
        let (_, observed) = drive(&fake, None, first.forward(), &healthy(), |link, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            } else if seen.pauses.len() == 3 {
                // The third wait is the poll on the reattached forward.
                link.stop();
            }
        });
        assert_eq!(
            observed.states,
            vec![LinkState::Connected, LinkState::Reconnecting { attempt: 1 }, LinkState::Connected,]
        );
        assert_eq!(fake.names(), vec!["status", "forward"]);
    }

    #[test]
    fn backoff_sequence() {
        let first = Handle::new();
        let mut outputs: Vec<std::io::Result<RawOutput>> = (0..5).map(|_| ssh_error(TIMED_OUT)).collect();
        outputs.push(state_out(REMOTE_PORT, NEW, "2.0.0"));
        let fake = FakeExec::new(outputs);
        fake.queue_forward(Handle::new().forward());
        let (_, observed) = drive(&fake, None, first.forward(), &healthy(), |_, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(
            observed.backoffs(),
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
                Duration::from_secs(15),
                Duration::from_secs(15),
            ]
        );
    }

    #[test]
    fn auth_failure_during_reconnect_asks_again() {
        let first = Handle::new();
        let fake = FakeExec::new(vec![ssh_error(PERMISSION_DENIED)]);
        let (link, observed) = drive(&fake, Some(PASSWORD), first.forward(), &healthy(), |_, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(link.state(), LinkState::NeedsPassword);
        assert_eq!(observed.backoffs(), vec![Duration::from_secs(1)], "no retry after a refused login");
        assert_eq!(fake.names(), vec!["status"], "no forward is opened with a refused login");
    }

    #[test]
    fn stop_never_stops_core() {
        let first = Handle::new();
        let second = Handle::new();
        let fake = FakeExec::new(vec![state_out(REMOTE_PORT, NEW, "2.0.0")]);
        fake.queue_forward(second.forward());
        let (_, _) = drive(&fake, None, first.forward(), &healthy(), |link, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            } else if seen.pauses.len() == 3 {
                link.stop();
            }
        });
        let names = fake.names();
        assert_eq!(names, vec!["status", "forward"], "only STATUS and the forward ran");
        assert!(
            !names.iter().any(|n| matches!(*n, "stop" | "start" | "install" | "rollback" | "unknown")),
            "the supervisor never runs a core-changing script"
        );
        assert_eq!(second.kill_count(), 1, "stop kills the reattached forward");
        assert_eq!(first.kill_count(), 1, "the dropped forward is reaped once");
    }

    #[test]
    fn same_local_port_after_reconnect() {
        let first = Handle::new();
        let fake = FakeExec::new(vec![state_out(REMOTE_PORT, NEW, "2.0.0")]);
        fake.queue_forward(Handle::new().forward());
        let (_, observed) = drive(&fake, None, first.forward(), &healthy(), |_, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            }
        });
        assert!(observed.urls.iter().all(|url| url == LOCAL_URL), "url() never changes");
        let forwards = forward_args_for(&fake);
        assert_eq!(forwards.len(), 1);
        assert!(contains_pair(&forwards[0], "127.0.0.1:3456:127.0.0.1:3460"), "respawn keeps local port 3456");
    }

    #[test]
    fn password_never_in_args_or_state() {
        let first = Handle::new();
        let outputs = vec![ssh_error(TIMED_OUT), state_out(REMOTE_PORT, NEW, "2.0.0")];
        let fake = FakeExec::new(outputs);
        fake.queue_forward(Handle::new().forward());
        let (link, observed) = drive(&fake, Some("hunter2"), first.forward(), &healthy(), |link, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            } else if seen.pauses.len() == 4 {
                // Poll, backoff 1, backoff 2, then the poll on the reattached forward.
                link.stop();
            }
        });
        for call in fake.calls() {
            assert!(!call.args.iter().any(|a| a.contains("hunter2")), "{} argv holds the password", call.name);
        }
        for state in observed.states.iter().chain(std::iter::once(&link.state())) {
            assert!(!format!("{state:?}").contains("hunter2"), "a LinkState holds the password");
        }
        assert!(observed.states.contains(&LinkState::Reconnecting { attempt: 1 }));
        assert!(observed.states.contains(&LinkState::Reconnecting { attempt: 2 }));
    }

    #[test]
    fn stop_clears_password() {
        let shared = Shared::new(Some("hunter2".to_string()));
        assert!(shared.password_copy().is_some());
        shared.halt();
        assert!(shared.password_copy().is_none(), "stop drops the stored password");
        assert!(shared.is_stopped());
    }

    #[test]
    fn five_forwards_that_exit_at_once_end_with_forward_failed() {
        // The local port is taken by another program: every forward exits before the core can answer.
        let first = Handle::new();
        let fake = FakeExec::new((0..5).map(|_| state_out(REMOTE_PORT, NEW, "2.0.0")).collect());
        let exits: Vec<Handle> = (0..5).map(|_| Handle::new()).collect();
        for handle in &exits {
            handle.exited.store(true, Ordering::SeqCst);
            fake.queue_forward(handle.forward());
        }
        let silent = |_: u16| None;
        let (link, observed) = drive(&fake, None, first.forward(), &silent, |_, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(
            link.state(),
            LinkState::Failed {
                code: "SSH_FORWARD_FAILED",
                message: "The local port for this server is in use. Quit the other program and connect again.".into(),
            }
        );
        assert_eq!(observed.backoffs().len(), 5, "one backoff per attempt, then no sixth attempt");
        let expected: Vec<&str> = (0..5).flat_map(|_| ["status", "forward"]).collect();
        assert_eq!(fake.names(), expected, "no forward is spawned after the fifth failure");
        assert!(exits.iter().all(|handle| handle.kill_count() == 1), "each failed forward is killed once");
    }

    #[test]
    fn five_silent_reattachments_end_as_core_unresponsive() {
        // The forward stays up and STATUS confirms the core, but `/health` never answers with its nonce. The local port
        // is not the problem here, so the message must not blame it.
        let first = Handle::new();
        let fake = FakeExec::new((0..5).map(|_| state_out(REMOTE_PORT, NEW, "2.0.0")).collect());
        let silent = |_: u16| None;
        let (link, observed) = drive(&fake, None, first.forward(), &silent, |_, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(
            link.state(),
            LinkState::Failed {
                code: "SSH_CORE_UNRESPONSIVE",
                message: "The server core is not answering. Stop the server and connect again.".into(),
            }
        );
        assert_eq!(observed.backoffs().len(), 5, "one backoff per attempt, then no sixth attempt");
        let expected: Vec<&str> = (0..5).flat_map(|_| ["status", "forward"]).collect();
        assert_eq!(fake.names(), expected, "no forward is spawned after the fifth failure");
        assert_eq!(fake.kills(), 5, "each silent forward is killed");
    }

    #[test]
    fn a_mixed_streak_of_failed_reattachments_still_ends_as_forward_failed() {
        // Four silent attempts, then a forward that exits: five failed attempts in a row. Not all of them were silent,
        // so the local forward takes the blame. The link must still give up rather than retry forever.
        let first = Handle::new();
        let fake = FakeExec::new((0..5).map(|_| state_out(REMOTE_PORT, NEW, "2.0.0")).collect());
        for _ in 0..4 {
            fake.queue_forward(Handle::new().forward());
        }
        let exited = Handle::new();
        exited.exited.store(true, Ordering::SeqCst);
        fake.queue_forward(exited.forward());
        let silent = |_: u16| None;
        let (link, observed) = drive(&fake, None, first.forward(), &silent, |_, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(
            link.state(),
            LinkState::Failed {
                code: "SSH_FORWARD_FAILED",
                message: "The local port for this server is in use. Quit the other program and connect again.".into(),
            }
        );
        assert_eq!(observed.backoffs().len(), 5, "the fifth failure ends the link, with no sixth attempt");
    }

    #[test]
    fn four_failed_reattachments_then_success_stays_connected() {
        let first = Handle::new();
        let fake = FakeExec::new((0..5).map(|_| state_out(REMOTE_PORT, NEW, "2.0.0")).collect());
        // `/health` misses four times and answers with the nonce on the fifth attempt.
        let answers = AtomicUsize::new(0);
        let late = |_: u16| {
            if answers.fetch_add(1, Ordering::SeqCst) < 4 {
                None
            } else {
                Some(NEW.to_string())
            }
        };
        let (link, observed) = drive(&fake, None, first.forward(), &late, |link, seen| {
            if seen.pauses.len() == 1 {
                first.exited.store(true, Ordering::SeqCst);
            } else if seen.pauses.len() == 7 {
                // Poll, five backoffs, then the poll on the reattached forward.
                link.stop();
            }
        });
        assert_eq!(observed.states[6], LinkState::Connected, "the reattached forward is reported as connected");
        assert_eq!(observed.backoffs().len(), 5);
        assert_eq!(fake.names().iter().filter(|n| **n == "forward").count(), 5, "four failures, one success");
        assert_eq!(link.state(), LinkState::Failed { code: "SSH_LINK_STOPPED", message: "The connection was closed.".into() });
    }

    #[test]
    fn stopping_a_link_removes_its_known_hosts_folder() {
        let handle = Handle::new();
        let exec: Arc<dyn SshExec> = Arc::new(FakeExec::default());
        let held = scratch_known_hosts();
        let (dir, file) = (held.dir.clone(), held.file.clone());
        let input = SuperviseInput {
            exec,
            connected: connected_with(handle.forward()),
            endpoint: key_endpoint(),
            password: None,
            known_hosts: held,
            health: Arc::new(|_| Some(NEW.to_string())),
        };
        let link = supervise(input);
        assert!(file.is_file(), "the folder exists while the link runs");
        link.stop();
        assert!(!dir.exists(), "stop removes the folder");
        assert!(link.known_hosts_file().is_none());
    }

    #[test]
    fn dropping_a_link_removes_its_known_hosts_folder() {
        let handle = Handle::new();
        let exec: Arc<dyn SshExec> = Arc::new(FakeExec::default());
        let held = scratch_known_hosts();
        let dir = held.dir.clone();
        let input = SuperviseInput {
            exec,
            connected: connected_with(handle.forward()),
            endpoint: key_endpoint(),
            password: None,
            known_hosts: held,
            health: Arc::new(|_| Some(NEW.to_string())),
        };
        drop(supervise(input));
        assert!(!dir.exists(), "dropping the link removes the folder");
        assert_eq!(handle.kill_count(), 1);
    }

    #[test]
    fn stop_on_a_live_supervisor_kills_its_forward_promptly() {
        let handle = Handle::new();
        let exec: Arc<dyn SshExec> = Arc::new(FakeExec::default());
        let input = SuperviseInput {
            exec,
            connected: connected_with(handle.forward()),
            endpoint: key_endpoint(),
            password: None,
            known_hosts: scratch_known_hosts(),
            health: Arc::new(|_| Some(NEW.to_string())),
        };
        let link = supervise(input);
        let started = Instant::now();
        link.stop();
        assert!(started.elapsed() < Duration::from_secs(1), "stop returns within a second");
        assert_eq!(handle.kill_count(), 1, "the supervisor thread killed the forward before stop returned");
        assert_eq!(link.url(), LOCAL_URL);
        assert!(matches!(link.state(), LinkState::Failed { code: "SSH_LINK_STOPPED", .. }));
    }

    #[test]
    fn dropping_the_link_kills_its_forward() {
        let handle = Handle::new();
        let exec: Arc<dyn SshExec> = Arc::new(FakeExec::default());
        let input = SuperviseInput {
            exec,
            connected: connected_with(handle.forward()),
            endpoint: key_endpoint(),
            password: None,
            known_hosts: scratch_known_hosts(),
            health: Arc::new(|_| Some(NEW.to_string())),
        };
        drop(supervise(input));
        assert_eq!(handle.kill_count(), 1);
    }
}
