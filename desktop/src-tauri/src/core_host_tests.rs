use super::*;
use std::io::Write as _;
use std::net::TcpListener;

#[test]
fn host_api_dev_flag_is_debug_only_and_exact() {
    assert!(host_api_dev_env(true, Some("1")));
    assert!(!host_api_dev_env(false, Some("1")), "a release build never passes it");
    assert!(!host_api_dev_env(true, None));
    assert!(!host_api_dev_env(true, Some("true")));
    assert!(!host_api_dev_env(true, Some("")));
}

#[test]
fn host_api_env_passes_only_known_values() {
    assert_eq!(host_api_env("LLMIDE_HOST_API_TLS", Some("1")), Some("1".to_string()));
    assert_eq!(host_api_env("LLMIDE_HOST_API_TLS", Some("true")), None, "only the exact value 1");
    assert_eq!(host_api_env("LLMIDE_HOST_API_TLS", None), None);
    let o = "https://app.example.com,http://127.0.0.1:5180";
    assert_eq!(host_api_env("LLMIDE_HOST_API_WEB_ORIGINS", Some(o)), Some(o.to_string()));
    assert_eq!(host_api_env("LLMIDE_HOST_API_WEB_ORIGINS", Some(&"x".repeat(2049))), None, "bounded");
    assert_eq!(host_api_env("LLMIDE_HOST_API_WEB_ORIGINS", None), None);
    let mut p = crate::prefs::Prefs::default();
    assert!(!host_env_origins_shadowed(&p), "no saved origins: the host env passthrough stays");
    p.host_api_web_origins = vec!["https://llm-ide.com".into()];
    assert!(host_env_origins_shadowed(&p), "saved origins win over the host env");
    assert_eq!(host_api_env("LLMIDE_HOST_API_DEV", Some("1")), None, "the dev flag has its own debug-only gate");
    assert_eq!(host_api_env("LLMIDE_VAULT_KEY", Some("1")), None);
}

/// One-shot-per-connection fake server; `reply` builds the raw HTTP response.
fn fake(reply: impl Fn() -> String + Send + 'static) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let h = Arc::clone(&hits);
    thread::spawn(move || {
        for conn in l.incoming() {
            let Ok(mut c) = conn else { break };
            h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut buf = [0u8; 1024];
            let _ = c.read(&mut buf);
            let _ = c.write_all(reply().as_bytes());
        }
    });
    (port, hits)
}

fn ok_with(header: &str) -> String {
    format!("HTTP/1.1 200 OK\r\n{header}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}")
}

#[test]
fn probe_reads_the_nonce_header() {
    let (port, _) = fake(|| ok_with("x-llmide-nonce: abc123\r\n"));
    match probe(port, Duration::from_secs(2)) {
        Probe::Healthy { nonce } => assert_eq!(nonce.as_deref(), Some("abc123")),
        Probe::Down => panic!("expected healthy"),
    }
}

#[test]
fn a_plain_health_has_no_nonce() {
    let (port, _) = fake(|| ok_with(""));
    match probe(port, Duration::from_secs(2)) {
        Probe::Healthy { nonce } => assert!(nonce.is_none()),
        Probe::Down => panic!("expected healthy"),
    }
}

#[test]
fn redirects_are_not_followed() {
    let (target, target_hits) = fake(|| ok_with("x-llmide-nonce: abc\r\n"));
    let (port, _) = fake(move || {
        format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target}/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    });
    assert!(matches!(probe(port, Duration::from_secs(2)), Probe::Down));
    assert_eq!(target_hits.load(std::sync::atomic::Ordering::SeqCst), 0, "redirect target must not be contacted");
}

#[test]
fn nonce_is_random_hex_and_compared_exactly() {
    let (a, b) = (random_nonce().unwrap(), random_nonce().unwrap());
    assert_eq!(a.len(), 64);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
    assert!(ct_eq(&a, &a));
    assert!(!ct_eq(&a, &b));
    assert!(!ct_eq(&a, &a[..63]));
}

#[test]
fn port_in_use_sees_a_listener() {
    // Other tests bind ephemeral ports concurrently, which can recycle this one the
    // instant it is freed; a fresh port a few times makes that vanishingly unlikely.
    let mut freed_ok = false;
    for _ in 0..5 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(port_in_use(port));
        drop(l);
        if !port_in_use(port) {
            freed_ok = true;
            break;
        }
    }
    assert!(freed_ok);
}

#[test]
fn redaction_masks_literals_pairs_and_opaque_tokens() {
    let secret = "s3cr3t-value-for-jwt".to_string();
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    let line = format!("boot LLMIDE_JWT_SECRET={secret} Authorization: Bearer {jwt} \"apiKey\":\"sk-abc\" port 3457 ok");
    let out = redact_line(&line, std::slice::from_ref(&secret));
    for leak in [&secret, jwt, "sk-abc"] {
        assert!(!out.contains(leak), "leaked {leak}: {out}");
    }
    assert!(out.contains("port 3457 ok"), "{out}");
}

#[test]
fn stop_leaves_stopped_where_shutdown_leaves_ready_so_start_can_run_again() {
    let host = CoreHost::new();
    lock(&host.inner.status).state = Phase::Ready;
    host.shutdown();
    assert!(matches!(lock(&host.inner.status).state, Phase::Ready));
    host.stop().unwrap();
    assert!(matches!(lock(&host.inner.status).state, Phase::Stopped));
}

#[test]
fn failure_message_never_carries_the_raw_tail_and_log_is_private() {
    let host = CoreHost::new();
    let dir = std::env::temp_dir().join(format!("llmide-core-fail-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let dir = fsutil::private_dir(&dir).unwrap();
    *lock(&host.inner.data_dir) = Some(dir.clone());
    lock(&host.inner.literals).push("hunter2hunter2".into());
    lock(&host.inner.log).push_back("password leaked hunter2hunter2 in /Users/me/secret-project".into());
    let msg = host.failure("node exited early (1)".into());
    assert!(!msg.contains("hunter2") && !msg.contains("/Users/me"), "{msg}");
    assert!(msg.contains("core.log"));
    let body = std::fs::read_to_string(dir.join("core.log")).unwrap();
    assert!(!body.contains("hunter2"), "{body}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("core.log")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn a_failure_body_over_the_file_cap_is_truncated_from_the_front_not_dropped() {
    let host = CoreHost::new();
    let dir = std::env::temp_dir().join(format!("llmide-core-longfail-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let dir = fsutil::private_dir(&dir).unwrap();
    *lock(&host.inner.data_dir) = Some(dir.clone());
    for i in 0..ERROR_TAIL_LINES {
        lock(&host.inner.log).push_back(format!("line {i} {}", "x".repeat(8000)));
    }
    lock(&host.inner.log).push_back("THE REAL ERROR \u{3042}".into());
    let msg = host.failure("node exited early (1)".into());
    assert!(msg.contains("core.log"), "the pointer survives a long failure: {msg}");
    let body = std::fs::read_to_string(dir.join("core.log")).unwrap();
    assert!(body.len() <= LOG_FILE_MAX_BYTES);
    assert!(body.starts_with("node exited early (1)") && body.contains("truncated"));
    assert!(body.ends_with("THE REAL ERROR \u{3042}"), "the end of the output is kept");
}

#[test]
fn fit_log_body_is_a_no_op_under_the_cap_and_char_safe_over_it() {
    assert_eq!(fit_log_body("m", "m\nshort", 1024), "m\nshort");
    let body = format!("m\n{}", "\u{3042}".repeat(1000));
    let fitted = fit_log_body("m", &body, 600);
    assert!(fitted.len() <= 600, "{}", fitted.len());
}

#[test]
fn only_a_spawned_verified_core_is_handed_credentials() {
    let (port, _) = fake(|| ok_with("x-llmide-nonce: good\r\n"));
    let url = format!("http://127.0.0.1:{port}");
    // pending: nothing yet
    let host = CoreHost::new();
    assert!(host.verified_url().is_none());
    // adopted (identity unverifiable): never, even though it answers /health
    host.set_ready(url.clone(), true, 1, "adopted_unverified", Some("n".into()));
    assert!(host.verified_url().is_none(), "an adopted core is never verified");
    // spawned with the matching nonce: yes
    host.set_ready(url.clone(), false, 1, "spawned", None);
    lock(&host.inner.status).nonce = Some("good".into());
    assert_eq!(host.verified_url().as_deref(), Some(url.as_str()));
    // the process on the port stopped echoing our nonce (replaced / squatted): no
    lock(&host.inner.status).nonce = Some("other".into());
    assert!(host.verified_url().is_none());
    // not Ready: no
    lock(&host.inner.status).nonce = Some("good".into());
    lock(&host.inner.status).state = Phase::Restarting;
    assert!(host.verified_url().is_none());
}

#[test]
fn a_user_stop_marks_the_core_stopped_and_start_without_a_data_dir_fails() {
    let host = CoreHost::new();
    host.stop().unwrap();
    assert_eq!(host.status().state, Phase::Stopped);
    assert_eq!(host.status().trust, "spawned", "a stopped own core is not a trust warning");
    assert!(host.start().is_err(), "there is no data dir to start against");
}

#[test]
fn source_backend_prefs_select_the_checkout_runtime() {
    let dir = std::env::temp_dir().join(format!("llmide-source-rt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("extension")).unwrap();
    std::fs::write(dir.join("extension/server.mjs"), "//").unwrap();
    let mut p = crate::prefs::Prefs::default();
    p.backend_source = true;
    p.backend_dir = dir.join("extension").to_string_lossy().into_owned();
    p.backend_node = "node".into();
    let rt = runtime_for(&p).unwrap();
    assert_eq!(rt.mode, "source");
    assert_eq!(rt.root, dir);
    assert_eq!(rt.node, PathBuf::from("node"));
    p.backend_dir = dir.join("missing").to_string_lossy().into_owned();
    assert!(runtime_for(&p).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn drain_keeps_reading_past_bad_utf8_and_an_overlong_line() {
    let mut bytes = b"first\n".to_vec();
    bytes.extend_from_slice(&[0xFF, b'\n']);
    bytes.extend(std::iter::repeat(b'a').take(1 << 20));
    bytes.extend_from_slice(b"\nlast\n");
    let log = Arc::new(Mutex::new(VecDeque::new()));
    drain(std::io::Cursor::new(bytes), log.clone(), false);
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end && !lock(&log).iter().any(|l| l == "last") {
        thread::sleep(Duration::from_millis(10));
    }
    let lines: Vec<String> = lock(&log).iter().cloned().collect();
    assert_eq!(lines[0], "first");
    assert_eq!(lines[1], "\u{FFFD}", "invalid UTF-8 is replaced, not fatal");
    assert_eq!(lines[2].len(), LOG_LINE_MAX, "the over-long line is capped");
    assert_eq!(lines.last().map(String::as_str), Some("last"), "reading went on after both");
}

#[test]
fn a_panic_kill_leaves_the_core_failed_not_ready() {
    let host = CoreHost::with(tuning_fast(vec![1]), never_launcher(), no_claude());
    host.set_ready("http://127.0.0.1:1".into(), false, 1, "spawned", None);
    let mut cmd = Command::new("sleep");
    cmd.arg("30").stdin(Stdio::null());
    *lock(&host.inner.child) = Some(ManagedChild::spawn(&mut cmd).unwrap());
    host.shutdown_from_panic();
    let s = host.status();
    assert_eq!(s.state, Phase::Failed);
    assert!(s.error.is_some() && s.pid.is_none());
}

#[test]
fn a_core_on_the_live_port_is_believed_only_if_it_stays() {
    let fast = Duration::from_millis(5);
    // Nothing there: no wait at all.
    let mut calls = 0;
    assert!(!still_healthy_after(Duration::from_millis(200), fast, || { calls += 1; false }));
    assert_eq!(calls, 1);
    // An orphan that is shutting down: healthy at first, gone within the wait. Not someone else's core.
    let mut n = 0;
    let started = Instant::now();
    assert!(!still_healthy_after(Duration::from_secs(5), fast, || { n += 1; n < 4 }));
    assert!(started.elapsed() < Duration::from_secs(2), "the first no ends the wait");
    // A core that really runs there stays healthy for the whole wait.
    let started = Instant::now();
    assert!(still_healthy_after(Duration::from_millis(60), fast, || true));
    assert!(started.elapsed() >= Duration::from_millis(60));
    assert!(still_healthy_after(Duration::ZERO, fast, || true), "tests use a zero wait");
}

#[test]
fn a_panic_shutdown_never_leaves_a_phase_that_ignores_start() {
    for phase in [Phase::Starting, Phase::Restarting] {
        let host = CoreHost::with(tuning_fast(vec![41556]), never_launcher(), no_claude());
        host.mark_stopped(Some(std::env::temp_dir()));
        lock(&host.inner.status).state = phase;
        host.shutdown_from_panic();
        let s = host.status();
        assert_eq!(s.state, Phase::Failed, "no child existed, the phase must still end up startable");
        assert!(s.error.is_some() && s.pid.is_none());
    }
    let host = CoreHost::with(tuning_fast(vec![41556]), never_launcher(), no_claude());
    host.mark_stopped(Some(std::env::temp_dir()));
    host.shutdown_from_panic();
    assert_eq!(host.status().state, Phase::Stopped, "a deliberately stopped core stays stopped");
}

#[test]
fn status_starts_pending_and_unverified_is_distinct() {
    let host = CoreHost::new();
    assert_eq!(host.status().trust, "pending");
    host.set_ready("http://127.0.0.1:3456".into(), true, 1, "adopted_unverified", Some("n".into()));
    let s = host.status();
    assert!(s.adopted && s.trust == "adopted_unverified" && s.notice.is_some());
}

// ---- lifecycle: restart policy, supervision, quit, orphans -------------------------

fn tuning_fast(ports: Vec<u16>) -> Tuning {
    Tuning {
        ports,
        adopt: false,
        live_port: 1,
        ready_deadline: Duration::from_secs(10),
        term_grace: Duration::from_millis(500),
        health_interval: Duration::from_millis(100),
        health_timeout: Duration::from_millis(300),
        health_fails: 2,
        health_busy_budget: Duration::from_millis(1500),
        max_crashes: 3,
        crash_window: Duration::from_secs(60),
        backoff_base: Duration::from_millis(50),
        backoff_cap: Duration::from_millis(200),
        claude_recheck: Duration::from_secs(3600),
    }
}

#[test]
fn restart_policy_backs_off_exponentially_then_goes_fatal() {
    let t = Tuning { max_crashes: 4, crash_window: Duration::from_secs(60), ..Tuning::default() };
    let mut p = RestartPolicy::new(&t);
    let t0 = Instant::now();
    assert_eq!(p.record_crash(t0), Decision::Restart(Duration::from_secs(1)));
    assert_eq!(p.record_crash(t0 + Duration::from_secs(2)), Decision::Restart(Duration::from_secs(2)));
    assert_eq!(p.record_crash(t0 + Duration::from_secs(5)), Decision::Restart(Duration::from_secs(4)));
    assert_eq!(p.record_crash(t0 + Duration::from_secs(10)), Decision::Fatal);
}

#[test]
fn restart_policy_caps_the_delay_and_forgets_old_crashes() {
    let t = Tuning { max_crashes: 100, crash_window: Duration::from_secs(60), ..Tuning::default() };
    let mut p = RestartPolicy::new(&t);
    let t0 = Instant::now();
    let mut last = Duration::ZERO;
    for i in 0..20 {
        if let Decision::Restart(d) = p.record_crash(t0 + Duration::from_secs(i)) {
            last = d;
        }
    }
    assert_eq!(last, t.backoff_cap);
    // Everything above aged out of the window: the budget starts over.
    assert_eq!(p.record_crash(t0 + Duration::from_secs(10_000)), Decision::Restart(t.backoff_base));
}

fn free_ports(n: usize) -> Vec<u16> {
    let ls: Vec<TcpListener> = (0..n).map(|_| TcpListener::bind("127.0.0.1:0").unwrap()).collect();
    ls.iter().map(|l| l.local_addr().unwrap().port()).collect()
}

fn node_on_path() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("node")).find(|c| c.is_file()))
}

/// A stand-in for server.mjs: serves /health with the nonce header, spawns a grandchild
/// `sleep` (pid in `<dir>/child-<run>.pid`), and misbehaves per MODE:
/// `ok`, `crash:K` (exit 1 shortly after ready on the first K runs), `always-crash`,
/// `hang:K` (stop answering after ready on the first K runs), `slow` (listen after 3 s),
/// `slowfirst:MS` (listen after MS ms on the first run only),
/// `busy:MS` (stop answering for MS ms after ready on the first run, but keep listening),
/// `linger:K` (on the first K runs, crash while a detached process keeps the port for 1.5 s).
const FAKE_SERVER: &str = r#"
const http = require('http'), fs = require('fs'), cp = require('child_process'), path = require('path');
const dir = process.env.FAKE_DIR, mode = process.env.FAKE_MODE || 'ok';
const runs = fs.existsSync(path.join(dir, 'runs')) ? fs.readFileSync(path.join(dir, 'runs'), 'utf8').split('\n').filter(Boolean).length : 0;
fs.appendFileSync(path.join(dir, 'runs'), process.pid + '\n');
const child = cp.spawn('sleep', ['300'], { stdio: 'ignore' }); child.on('error', () => {});
fs.writeFileSync(path.join(dir, 'child-' + runs + '.pid'), String(child.pid));
const [kind, kStr] = mode.split(':'); const k = Number(kStr || 0);
let hung = false;
const srv = http.createServer((req, res) => {
  if (hung) return; // never answer
  res.writeHead(200, { 'content-type': 'application/json', 'x-llmide-nonce': process.env.LLMIDE_CORE_NONCE });
  res.end('{"status":"ok"}');
});
const go = () => srv.listen(Number(process.env.LLMIDE_PORT), '127.0.0.1', () => {
  if (kind === 'always-crash' || (kind === 'crash' && runs < k)) setTimeout(() => process.exit(1), 400);
  if (kind === 'hang' && runs < k) setTimeout(() => { hung = true; }, 300);
  // busy:K — on the first run only, stop answering for K ms but keep listening (a long synchronous call).
  if (kind === 'busy' && runs < 1) { setTimeout(() => { hung = true; }, 300); setTimeout(() => { hung = false; }, 300 + k); }
  if (kind === 'linger' && runs < k) setTimeout(linger, 400);
});
function linger() {
  const bound = path.join(dir, 'linger-' + runs);
  const code = "require('http').createServer((q, r) => r.end()).listen(" + process.env.LLMIDE_PORT
+ ", '127.0.0.1', () => { require('fs').writeFileSync(" + JSON.stringify(bound) + ", '1');"
+ " setTimeout(() => process.exit(0), 1500); });";
  srv.close(() => {
cp.spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
const t = setInterval(() => { if (fs.existsSync(bound)) { clearInterval(t); process.exit(1); } }, 10);
  });
}
if (kind === 'slow') setTimeout(go, 3000); else if (kind === 'slowfirst' && runs < 1) setTimeout(go, k); else go();
process.on('SIGTERM', () => process.exit(0));
"#;

struct Fake {
    dir: PathBuf,
    host: CoreHost,
    /// Every port the launcher was asked to spawn on (the only path that hands a core its secrets).
    launched: Arc<Mutex<Vec<u16>>>,
}

impl Fake {
    fn new(tag: &str, mode: &str, tuning: Tuning) -> Option<Fake> {
        let node = node_on_path()?;
        let dir = std::env::temp_dir().join(format!("llmide-fake-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-server.cjs");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        let mode = mode.to_string();
        let fdir = dir.clone();
        let launched = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&launched);
        let launcher: Launcher = Arc::new(move |ctx: &LaunchCtx<'_>| {
            lock(&seen).push(ctx.port);
            let mut cmd = Command::new(&node);
            cmd.arg(&script)
                .env("LLMIDE_PORT", ctx.port.to_string())
                .env("LLMIDE_CORE_NONCE", ctx.nonce)
                .env("FAKE_DIR", &fdir)
                .env("FAKE_MODE", &mode)
                .env("PATH", std::env::var_os("PATH").unwrap_or_default());
            Ok(Launch { cmd, secrets: vec![], stdin_secrets: None })
        });
        let probe: ClaudeProbe = Arc::new(|_, _| ClaudeInfo {
            state: "missing",
            source: None,
            notice: Some("install claude".into()),
        });
        let host = CoreHost::with(tuning, launcher, probe);
        host.start_in_background(Some(dir.clone()));
        Some(Fake { dir, host, launched })
    }

    fn wait_for(&self, what: &str, secs: u64, mut f: impl FnMut(&CoreStatus) -> bool) -> CoreStatus {
        let end = Instant::now() + Duration::from_secs(secs);
        loop {
            let s = self.host.status();
            if f(&s) {
                return s;
            }
            assert!(Instant::now() < end, "timed out waiting for {what}; last status: {s:?}");
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn pids(&self, prefix: &str) -> Vec<i32> {
        let mut v = Vec::new();
        for e in std::fs::read_dir(&self.dir).unwrap().flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with(prefix) && n.ends_with(".pid") {
                v.push(std::fs::read_to_string(e.path()).unwrap().trim().parse().unwrap());
            }
        }
        v
    }

    fn runs(&self) -> Vec<i32> {
        std::fs::read_to_string(self.dir.join("runs"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.parse().ok())
            .collect()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.host.shutdown();
    }
}

fn never_launcher() -> Launcher {
    Arc::new(|_| Err("must not launch".into()))
}

fn no_claude() -> ClaudeProbe {
    Arc::new(|_, _| ClaudeInfo::unknown())
}

#[test]
fn adopt_policy_is_off_in_release_unless_explicit() {
    assert!(!default_adopt(false, None, None), "release default");
    assert!(!default_adopt(false, Some("0"), None));
    assert!(default_adopt(false, Some("1"), None), "explicit opt-in");
    assert!(default_adopt(true, None, None), "debug keeps the dev flow");
    assert!(!default_adopt(true, None, Some("1")), "force-spawn still wins in debug");
    assert!(default_adopt(true, Some("1"), Some("1")));
    assert!(!default_adopt(true, Some("0"), None));
}

#[test]
fn adoption_happens_only_when_enabled() {
    let (port, _) = fake(|| ok_with(""));
    let t = Tuning { live_port: port, adopt: true, ..tuning_fast(vec![1]) };
    let host = CoreHost::with(t, never_launcher(), no_claude());
    host.start_in_background(Some(std::env::temp_dir()));
    let end = Instant::now() + Duration::from_secs(5);
    while host.status().state != Phase::Ready && Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
    let s = host.status();
    assert!(s.adopted && s.trust == "adopted_unverified" && s.foreign_core.is_none(), "{s:?}");
    assert!(host.verified_url().is_none());
}

#[test]
fn a_user_stop_then_start_restarts_a_real_child() {
    let Some(f) = Fake::new("stopstart", "ok", tuning_fast(free_ports(2))) else { return };
    f.wait_for("ready", 5, |s| s.state == Phase::Ready);
    let first = f.host.status().pid;
    f.host.stop().unwrap();
    assert_eq!(f.host.status().state, Phase::Stopped);
    assert!(f.host.status().pid.is_none());
    f.host.start().unwrap();
    let s = f.wait_for("ready after start", 5, |s| s.state == Phase::Ready);
    assert!(s.pid.is_some());
    assert_ne!(s.pid, first, "the user start launched a new child");
    f.host.stop().unwrap();
    assert_eq!(f.host.status().state, Phase::Stopped);
}

#[test]
fn concurrent_starts_launch_exactly_one_core() {
    let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (seen, gate) = (Arc::clone(&launches), Arc::clone(&release));
    // The launcher parks while the first start is in flight, so a second start that got past the
    // guard would show up as a second launch before the gate opens.
    let launcher: Launcher = Arc::new(move |_: &LaunchCtx<'_>| {
        seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        while !gate.load(std::sync::atomic::Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(10));
        }
        Err("test launcher".into())
    });
    let host = CoreHost::with(tuning_fast(free_ports(2)), launcher, no_claude());
    host.mark_stopped(Some(std::env::temp_dir()));
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let callers: Vec<_> = (0..8)
        .map(|_| {
            let (h, b) = (host.clone(), Arc::clone(&barrier));
            thread::spawn(move || {
                b.wait();
                h.start().unwrap();
            })
        })
        .collect();
    for c in callers {
        c.join().unwrap();
    }
    let end = Instant::now() + Duration::from_secs(5);
    while launches.load(std::sync::atomic::Ordering::SeqCst) == 0 && Instant::now() < end {
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(launches.load(std::sync::atomic::Ordering::SeqCst), 1, "two supervisors ran");
    release.store(true, std::sync::atomic::Ordering::SeqCst);
    host.stop().unwrap();
}

#[test]
fn a_user_start_reads_the_stored_prefs_but_a_running_core_keeps_its_own() {
    let stored_port = Arc::new(std::sync::atomic::AtomicU16::new(41001));
    let seen: Arc<Mutex<Vec<u16>>> = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let launcher: Launcher = Arc::new(move |ctx: &LaunchCtx<'_>| {
        lock(&log).push(ctx.prefs.backend_port);
        Err("test launcher".into())
    });
    let source = Arc::clone(&stored_port);
    let host = CoreHost::with(tuning_fast(vec![41555]), launcher, no_claude()).with_prefs_source(Arc::new(
        move || crate::prefs::Prefs { backend_port: source.load(Ordering::SeqCst), ..Default::default() },
    ));
    host.mark_stopped(Some(std::env::temp_dir()));
    assert_eq!(host.run_prefs(), crate::prefs::launch(), "before any user start the launch snapshot applies");

    host.start().unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while lock(&seen).is_empty() && Instant::now() < end {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(lock(&seen).clone(), vec![41001]);

    // A Settings change after the start must not leak into anything the supervisor does by itself.
    stored_port.store(41002, Ordering::SeqCst);
    assert_eq!(host.run_prefs().backend_port, 41001);

    host.restart().unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while lock(&seen).len() < 2 && Instant::now() < end {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(lock(&seen).clone(), vec![41001, 41002], "Kill & Restart picks up the changed prefs");
    host.stop().unwrap();
}

#[test]
fn a_foreign_core_is_ignored_and_our_own_is_started_on_the_next_port() {
    let (live, hits) = fake(|| ok_with(""));
    let ports = free_ports(2);
    let t = Tuning { live_port: live, adopt: false, ..tuning_fast(ports.clone()) };
    let Some(f) = Fake::new("foreign", "ok", t) else { return };
    let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
    assert!(!s.adopted && s.trust == "spawned", "{s:?}");
    assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[0]));
    let fc = s.foreign_core.expect("foreign core is reported");
    assert!(fc.detected && fc.port == live && fc.notice.contains("not used by this app"));
    assert!(hits.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    assert!(f.host.verified_url().is_some(), "only the spawned core gets credentials");
    assert!(s.error_code.is_none());
}

#[test]
fn a_nonce_less_listener_on_the_live_port_is_never_used_and_the_core_spawns_on_the_next() {
    let (live, hits) = fake(|| ok_with(""));
    let mut ports = vec![live];
    ports.extend(free_ports(1));
    let t = Tuning { live_port: ports[0], adopt: false, ..tuning_fast(ports.clone()) };
    let Some(f) = Fake::new("live-squat", "ok", t) else { return };
    let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
    assert!(!s.adopted && s.trust == "spawned", "{s:?}");
    assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[1]), "fell back to the next port");
    assert_eq!(*lock(&f.launched), vec![ports[1]], "no core (and no secret) was ever launched for the squatted port");
    assert_eq!(f.host.verified_url(), Some(format!("http://127.0.0.1:{}", ports[1])), "credentials go to our own core only");
    assert!(hits.load(std::sync::atomic::Ordering::SeqCst) >= 1, "the squatter was probed");
    let fc = s.foreign_core.expect("the squatter is reported");
    assert_eq!(fc.port, ports[0]);
    assert!(!s.extension_reachable, "the extension's port belongs to someone else");
}

#[test]
fn a_free_live_port_gets_our_core_and_the_extension_can_reach_it() {
    let ports = free_ports(2);
    let t = Tuning { live_port: ports[0], adopt: false, ..tuning_fast(ports.clone()) };
    let Some(f) = Fake::new("live-free", "ok", t) else { return };
    let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
    assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[0]));
    assert!(s.foreign_core.is_none(), "{s:?}");
    assert!(s.extension_reachable);
    assert_eq!(serde_json::to_value(&s).unwrap()["extensionReachable"], true);
}

#[cfg(unix)]
#[test]
fn a_supervised_restart_waits_for_the_live_port_instead_of_moving_off_it() {
    let ports = free_ports(2);
    let t = Tuning { live_port: ports[0], adopt: false, ..tuning_fast(ports.clone()) };
    let Some(f) = Fake::new("linger", "linger:1", t) else { return };
    let s = f.wait_for("ready after the crash", 30, |s| s.state == Phase::Ready && s.restarts == 1);
    assert!(f.dir.join("linger-0").exists(), "the port really was still busy at the restart");
    assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[0]), "restarted on the live port");
    assert_eq!(*lock(&f.launched), vec![ports[0], ports[0]]);
    assert!(s.extension_reachable);
}

#[test]
fn all_spawn_ports_busy_fails_with_ports_busy_and_the_ports_tried() {
    let ls: Vec<TcpListener> = (0..3).map(|_| TcpListener::bind("127.0.0.1:0").unwrap()).collect();
    let ports: Vec<u16> = ls.iter().map(|l| l.local_addr().unwrap().port()).collect();
    let t = Tuning { live_port: 1, ..tuning_fast(ports.clone()) };
    let host = CoreHost::with(t, never_launcher(), no_claude());
    host.start_in_background(Some(std::env::temp_dir()));
    let end = Instant::now() + Duration::from_secs(10);
    while host.status().state != Phase::Failed && Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
    let s = host.status();
    assert_eq!(s.state, Phase::Failed, "{s:?}");
    assert_eq!(s.error_code, Some("ports_busy"));
    assert_eq!(s.ports_tried, ports);
    assert!(s.error.unwrap().contains("busy"));
    drop(ls);
}

#[test]
fn core_status_serializes_the_new_fields_additively() {
    let host = CoreHost::with(tuning_fast(vec![1]), never_launcher(), no_claude());
    let v = serde_json::to_value(host.status()).unwrap();
    assert!(v["foreign_core"].is_null() && v["error_code"].is_null() && v["ports_tried"].as_array().unwrap().is_empty());
    assert_eq!(v["extensionReachable"], false);
    host.note_foreign(3456);
    let v = serde_json::to_value(host.status()).unwrap();
    assert_eq!(v["foreign_core"]["port"], 3456);
    assert_eq!(v["foreign_core"]["detected"], true);
}

#[cfg(unix)]
fn all_dead(pids: &[i32]) -> bool {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        // SAFETY: signal 0 is an existence check.
        if pids.iter().all(|p| unsafe { libc::kill(*p, 0) } != 0) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

#[cfg(unix)]
#[test]
fn quit_stops_the_core_and_every_grandchild() {
    let Some(f) = Fake::new("quit", "ok", tuning_fast(free_ports(2))) else { return };
    let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
    assert_eq!(s.trust, "spawned");
    assert!(!s.fatal && s.restarts == 0 && s.restart_in_ms.is_none());
    let leader = s.pid.unwrap() as i32;
    let grandkids = f.pids("child-");
    assert_eq!(grandkids.len(), 1);
    f.host.shutdown();
    let mut all = grandkids;
    all.push(leader);
    assert!(all_dead(&all), "survivors after quit: {all:?}");
    f.host.shutdown(); // idempotent
}

#[test]
fn remote_mode_does_not_spawn_a_local_core() {
    let _mode = mode_guard();
    let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n = launches.clone();
    let host = CoreHost::with(
        tuning_fast(vec![free_ports(1)[0]]),
        Arc::new(move |_| { n.fetch_add(1, Ordering::SeqCst); Err("must not spawn".into()) }),
        Arc::new(|_, _| ClaudeInfo::unknown()),
    );
    host.set_mode(ServerMode::Remote);
    host.start_in_background(Some(std::env::temp_dir()));
    for _ in 0..100 {
        if host.status().state == Phase::Remote { break; }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(launches.load(Ordering::SeqCst), 0);
    let s = host.status();
    assert_eq!(s.mode, "remote");
    assert!(matches!(s.state, Phase::Remote | Phase::Failed), "remote mode never becomes a local child: {s:?}");
    if s.state == Phase::Failed { assert_eq!(s.error_code, Some("REMOTE_UNAVAILABLE")); }
    assert!(host.verified_url().is_none(), "a remote core is never a locally verified spawn");
    host.shutdown();
}

#[test]
fn hub_mode_start_after_stop_returns() {
    let _mode = mode_guard();
    // Empty hub URL: the startup then fails fast with REMOTE_NOT_CONFIGURED and never touches the network.
    let host = CoreHost::with(tuning_fast(vec![free_ports(1)[0]]), never_launcher(), no_claude()).with_prefs_source(Arc::new(|| {
        crate::prefs::Prefs { remote_server: crate::prefs::RemoteServerPrefs { mode: ServerMode::Remote, ..Default::default() }, ..Default::default() }
    }));
    host.set_mode(ServerMode::Remote);
    host.mark_stopped(Some(std::env::temp_dir()));
    let (tx, rx) = std::sync::mpsc::channel();
    let starting = host.clone();
    // On a regression the start thread stays blocked; the test fails here instead of hanging the suite.
    thread::spawn(move || {
        let _ = tx.send(starting.start());
    });
    let returned = rx.recv_timeout(Duration::from_secs(2));
    assert!(returned.is_ok(), "hub-mode Start did not return: the data dir lock is held across start_in_background");
    returned.unwrap().unwrap();
    host.stop().unwrap();
    host.set_mode(ServerMode::Local);
}

// ---- SSH server mode ---------------------------------------------------------------

use crate::prefs::SshAuthKind;
use crate::ssh_link::{supervise, SshLink, SuperviseInput};
use crate::ssh_server_scripts::parse_probe;
use crate::ssh_session::tests::{key_endpoint, probe_out, FakeExec, NEW};
use crate::ssh_session::Connected;
use crate::ssh_transport::ForwardChild;
use std::sync::atomic::AtomicUsize;

/// `MODE` is process-wide (`require_local_mode` reads it), so tests that set it run one at a time.
static MODE_TESTS: Mutex<()> = Mutex::new(());

pub(crate) fn mode_guard() -> MutexGuard<'static, ()> {
    MODE_TESTS.lock().unwrap_or_else(|e| e.into_inner())
}


/// A forward that never exits on its own and counts its kills, so a test can see the link was stopped.
struct StubForward {
    kills: Arc<AtomicUsize>,
}

impl ForwardChild for StubForward {
    fn try_exited(&mut self) -> Option<i32> {
        None
    }

    fn kill(&mut self) {
        self.kills.fetch_add(1, Ordering::SeqCst);
    }
}

/// A real supervised link over a scripted exec. The returned exec records every ssh call it saw.
fn ssh_link_over_fake(kills: &Arc<AtomicUsize>) -> (SshLink, Arc<FakeExec>) {
    ssh_link_on_port(kills, 3456)
}

fn ssh_link_on_port(kills: &Arc<AtomicUsize>, port: u16) -> (SshLink, Arc<FakeExec>) {
    let fake = Arc::new(FakeExec::new(Vec::new()));
    let claude = parse_probe(&probe_out("2.0.0").unwrap().stdout).unwrap().claude;
    let connected = Connected {
        local_url: format!("http://127.0.0.1:{port}"),
        local_port: port,
        remote_port: 3460,
        nonce: NEW.into(),
        version: "2.0.0".into(),
        claude,
        forward: Box::new(StubForward { kills: kills.clone() }),
    };
    let input = SuperviseInput {
        exec: fake.clone(),
        connected,
        endpoint: key_endpoint(),
        password: None,
        known_hosts: crate::ssh_link::KnownHostsDir::owning(crate::remote::temp_ssh_dir("core-host-test").unwrap()),
        health: Arc::new(|_| Some(NEW.to_string())),
    };
    (supervise(input), fake)
}

fn ssh_host(auth: SshAuthKind, launcher: Launcher, connector: SshConnector) -> CoreHost {
    let remote_server = crate::prefs::RemoteServerPrefs { mode: ServerMode::Ssh, ssh_auth: auth, ..Default::default() };
    let host = CoreHost::with(tuning_fast(vec![free_ports(1)[0]]), launcher, no_claude())
        .with_prefs_source(Arc::new(move || crate::prefs::Prefs { remote_server: remote_server.clone(), ..Default::default() }));
    host.set_ssh_connector(connector);
    host.set_mode(ServerMode::Ssh);
    host
}

fn refusing_connector() -> SshConnector {
    Arc::new(|_| Err(crate::fs_ops::FsError { code: "SSH_TEST", message: "no server in this test".into() }))
}

fn wait_until(host: &CoreHost, what: &str, ready: impl Fn(&CoreStatus) -> bool) -> CoreStatus {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let s = host.status();
        if ready(&s) {
            return s;
        }
        assert!(Instant::now() < end, "timed out waiting for {what}; last status: {s:?}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn ssh_mode_spawns_no_local_core() {
    let _mode = mode_guard();
    let spawns = Arc::new(AtomicUsize::new(0));
    let n = spawns.clone();
    let launcher: Launcher = Arc::new(move |_| {
        n.fetch_add(1, Ordering::SeqCst);
        Err("must not spawn".into())
    });
    let host = ssh_host(SshAuthKind::Key, launcher, refusing_connector());
    host.start().unwrap();
    wait_until(&host, "the ssh startup", |s| s.state == Phase::Ssh);
    // Stop joins the startup thread, so the spawn count below is final.
    host.stop().unwrap();
    assert_eq!(spawns.load(Ordering::SeqCst), 0, "SSH mode never starts a local core");
    host.set_mode(ServerMode::Local);
}

#[test]
fn status_reports_ssh() {
    let _mode = mode_guard();
    let host = ssh_host(SshAuthKind::Key, never_launcher(), refusing_connector());
    let kills = Arc::new(AtomicUsize::new(0));
    let (link, _fake) = ssh_link_over_fake(&kills);
    let url = link.url();
    host.attach_ssh_link(link);
    let s = host.status();
    assert_eq!(s.mode, "ssh");
    assert_eq!(s.url, url);
    assert_eq!(s.state, Phase::Ssh);
    assert_eq!(s.link, Some("connected"));
    assert!(host.verified_url().is_none(), "a forwarded core is never handed a local credential");
    host.detach_ssh_link();
    assert_eq!(kills.load(Ordering::SeqCst), 1, "detaching stops the forward");
    host.set_mode(ServerMode::Local);
}

#[test]
fn password_mode_waits() {
    let _mode = mode_guard();
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    let connector: SshConnector = Arc::new(move |_| {
        n.fetch_add(1, Ordering::SeqCst);
        Err(crate::fs_ops::FsError { code: "SSH_TEST", message: "must not connect".into() })
    });
    let host = ssh_host(SshAuthKind::Password, never_launcher(), connector);
    host.start().unwrap();
    let s = wait_until(&host, "the password wait", |s| s.state == Phase::Ssh);
    assert_eq!(s.link, Some("needs_password"));
    host.stop().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no connect attempt before the user gives a password");
    host.set_mode(ServerMode::Local);
}

#[test]
fn key_mode_connects_in_the_background() {
    let _mode = mode_guard();
    let kills = Arc::new(AtomicUsize::new(0));
    let k = kills.clone();
    let connector: SshConnector = Arc::new(move |_| Ok(ssh_link_over_fake(&k).0));
    let host = ssh_host(SshAuthKind::Key, never_launcher(), connector);
    host.start().unwrap();
    let s = wait_until(&host, "the key connect", |s| s.link == Some("connected"));
    assert_eq!(s.url, "http://127.0.0.1:3456");
    host.stop().unwrap();
    assert_eq!(kills.load(Ordering::SeqCst), 1, "stop detaches and stops the connected link");
    host.set_mode(ServerMode::Local);
}

#[test]
fn key_mode_connect_failure_is_reported() {
    let _mode = mode_guard();
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    let connector: SshConnector = Arc::new(move |_| {
        n.fetch_add(1, Ordering::SeqCst);
        Err(crate::fs_ops::FsError { code: "SSH_TEST", message: "could not reach the server".into() })
    });
    let host = ssh_host(SshAuthKind::Key, never_launcher(), connector);
    host.start().unwrap();
    let s = wait_until(&host, "the connect failure", |s| s.error.is_some());
    assert_eq!(s.state, Phase::Ssh);
    assert_eq!(s.link, Some("failed"));
    assert_eq!(s.error.as_deref(), Some("could not reach the server"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    host.stop().unwrap();
    host.set_mode(ServerMode::Local);
}

#[test]
fn stop_detaches_link_only() {
    let _mode = mode_guard();
    let host = ssh_host(SshAuthKind::Key, never_launcher(), refusing_connector());
    let kills = Arc::new(AtomicUsize::new(0));
    let (link, fake) = ssh_link_over_fake(&kills);
    host.attach_ssh_link(link);
    host.stop().unwrap();
    assert_eq!(kills.load(Ordering::SeqCst), 1, "the link is stopped");
    assert!(!fake.names().contains(&"stop"), "the server core keeps running: {:?}", fake.names());
    let s = host.status();
    assert_eq!(s.state, Phase::Stopped);
    assert_eq!(s.link, Some("stopped"), "a stopped host is not a failed one");
    host.set_mode(ServerMode::Local);
}

#[test]
fn a_stopped_host_with_a_connect_flag_reads_stopped() {
    // The flag can outlive a stop by a moment; the stopped phase must win so the UI never reads `connecting` after Stop.
    let view = SshView { url: None, state: None, connecting: true, disconnected: false, password_auth: false };
    let (_, _, label) = ssh_fields(view, Phase::Stopped, None);
    assert_eq!(label, "stopped");
}

#[test]
fn stop_clears_the_connect_flag() {
    let _mode = mode_guard();
    let host = ssh_host(SshAuthKind::Key, never_launcher(), refusing_connector());
    host.set_connecting(true);
    host.stop().unwrap();
    assert!(!lock(&host.inner.ssh_link).connecting, "stop leaves no connect flag behind");
    host.set_mode(ServerMode::Local);
}

#[test]
fn attach_replaces_and_stops_the_old_link() {
    let _mode = mode_guard();
    let host = ssh_host(SshAuthKind::Password, never_launcher(), refusing_connector());
    let old_kills = Arc::new(AtomicUsize::new(0));
    let (old, _f1) = ssh_link_on_port(&old_kills, 3456);
    host.attach_ssh_link(old);
    let new_kills = Arc::new(AtomicUsize::new(0));
    let (new, _f2) = ssh_link_on_port(&new_kills, 3457);
    host.attach_ssh_link(new);
    assert_eq!(old_kills.load(Ordering::SeqCst), 1, "the replaced link is stopped");
    assert_eq!(new_kills.load(Ordering::SeqCst), 0, "the new link is live");
    assert_eq!(host.status().url, "http://127.0.0.1:3457", "status reports the link that replaced the old one");
    host.shutdown();
    assert_eq!(new_kills.load(Ordering::SeqCst), 1, "app shutdown detaches the link");
    host.set_mode(ServerMode::Local);
}

#[test]
fn a_key_connect_shows_connecting_until_it_returns() {
    let _mode = mode_guard();
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let g = gate.clone();
    let kills = Arc::new(AtomicUsize::new(0));
    let k = kills.clone();
    let connector: SshConnector = Arc::new(move |_| {
        let (open, opened) = &*g;
        let mut open = open.lock().unwrap();
        while !*open {
            open = opened.wait(open).unwrap();
        }
        Ok(ssh_link_over_fake(&k).0)
    });
    let host = ssh_host(SshAuthKind::Key, never_launcher(), connector);
    host.start().unwrap();
    let blocked = wait_until(&host, "the connecting state", |s| s.link == Some("connecting") && s.state == Phase::Ssh);
    assert_eq!(blocked.state, Phase::Ssh);
    assert_eq!(blocked.url, "", "no URL before the link exists");
    {
        let (open, opened) = &*gate;
        *open.lock().unwrap() = true;
        opened.notify_all();
    }
    let connected = wait_until(&host, "the connected link", |s| s.link == Some("connected"));
    assert_eq!(connected.url, "http://127.0.0.1:3456");
    host.stop().unwrap();
    assert_eq!(host.status().link, Some("stopped"));
    assert_eq!(kills.load(Ordering::SeqCst), 1, "stop stops the link that connected");
    host.set_mode(ServerMode::Local);
}

#[test]
fn mark_stopped_in_ssh_mode_matches_a_user_stop() {
    let _mode = mode_guard();
    let host = ssh_host(SshAuthKind::Key, never_launcher(), refusing_connector());
    host.mark_stopped(Some(std::env::temp_dir()));
    let s = host.status();
    assert_eq!(s.state, Phase::Stopped);
    assert_eq!(s.trust, "ssh_forward", "an SSH core is never reported as spawned by this app");
    assert_eq!(s.link, Some("stopped"));
    host.set_mode(ServerMode::Local);
}

#[test]
fn require_local_mode_refuses_in_ssh_mode() {
    let _mode = mode_guard();
    let host = ssh_host(SshAuthKind::Key, never_launcher(), refusing_connector());
    let e = crate::core_host::require_local_mode().unwrap_err();
    assert_eq!(e.code, "ssh_mode");
    assert_eq!(e.message, "This action uses the local computer and is unavailable in SSH server mode.");
    host.set_mode(ServerMode::Local);
    assert!(crate::core_host::require_local_mode().is_ok());
}

#[test]
fn local_mode_unchanged() {
    let _mode = mode_guard();
    let host = CoreHost::with(tuning_fast(vec![free_ports(1)[0]]), never_launcher(), no_claude());
    host.set_mode(ServerMode::Local);
    let s = host.status();
    assert_eq!(s.mode, "local");
    assert!(s.link.is_none(), "the link field is SSH-only");
    assert!(host.start().is_err(), "a local start still needs the app data folder");
    assert!(crate::core_host::require_local_mode().is_ok());
}

#[cfg(unix)]
#[test]
fn a_crashed_core_is_restarted_with_backoff_and_leaves_no_orphans() {
    let Some(f) = Fake::new("crash", "crash:2", tuning_fast(free_ports(3))) else { return };
    let mut saw_restarting = false;
    let s = f.wait_for("ready after two restarts", 30, |s| {
        saw_restarting |= s.state == Phase::Restarting;
        s.state == Phase::Ready && s.restarts == 2
    });
    assert!(saw_restarting, "the webview must be able to see a restarting state");
    assert!(!s.fatal && s.error.is_none());
    // The two crashed runs left a sleep child each; the host must have reaped them.
    let runs = f.runs();
    assert_eq!(runs.len(), 3);
    let old_children: Vec<i32> = (0..2)
        .map(|i| std::fs::read_to_string(f.dir.join(format!("child-{i}.pid"))).unwrap().trim().parse().unwrap())
        .collect();
    assert!(all_dead(&old_children), "orphans from crashed runs: {old_children:?}");
    assert!(all_dead(&runs[..2]));
}

#[cfg(unix)]
#[test]
fn a_core_that_keeps_crashing_ends_in_a_fatal_state_and_is_not_restarted_again() {
    let Some(f) = Fake::new("fatal", "always-crash", tuning_fast(free_ports(3))) else { return };
    let s = f.wait_for("fatal", 30, |s| s.fatal);
    assert_eq!(s.state, Phase::Failed);
    assert!(s.error.as_deref().unwrap().contains("not restarted"));
    let n = f.runs().len();
    assert_eq!(n, 3, "max_crashes = 3 means three runs in total");
    thread::sleep(Duration::from_millis(800));
    assert_eq!(f.runs().len(), n, "no restart loop after the fatal state");
    assert!(f.host.status().fatal);
    assert!(all_dead(&f.runs()));
}

#[cfg(unix)]
#[test]
fn a_hung_core_is_detected_by_the_nonce_health_check_and_restarted() {
    let Some(f) = Fake::new("hang", "hang:1", tuning_fast(free_ports(3))) else { return };
    f.wait_for("ready", 15, |s| s.state == Phase::Ready);
    let s = f.wait_for("restarted after hang", 30, |s| s.state == Phase::Ready && s.restarts == 1);
    assert_eq!(s.trust, "spawned");
    let runs = f.runs();
    assert_eq!(runs.len(), 2);
    assert!(all_dead(&runs[..1]), "the hung core must be killed, not leaked");
}

#[cfg(unix)]
#[test]
fn a_core_that_is_alive_but_briefly_unresponsive_is_not_killed() {
    // Needs a local port: cannot run inside the command sandbox.
    let Some(f) = Fake::new("busy", "busy:1000", tuning_fast(free_ports(3))) else { return };
    f.wait_for("ready", 15, |s| s.state == Phase::Ready);
    // Silent for ~1 s: far over health_fails * health_interval (200 ms), under the 1.5 s busy budget.
    thread::sleep(Duration::from_millis(2500));
    let s = f.host.status();
    assert_eq!((s.state, s.restarts), (Phase::Ready, 0), "a busy core must not be restarted: {s:?}");
    assert_eq!(f.runs().len(), 1);
}

#[cfg(unix)]
#[test]
fn a_slow_first_start_is_retried_once_and_then_ready() {
    // Needs a local port: cannot run inside the command sandbox.
    let t = Tuning { ready_deadline: Duration::from_millis(1500), ..tuning_fast(free_ports(3)) };
    let Some(f) = Fake::new("slowfirst", "slowfirst:2500", t) else { return };
    let s = f.wait_for("ready after the retry", 20, |s| s.state == Phase::Ready);
    assert_eq!(s.restarts, 0, "the retry is part of the first start, not a crash restart");
    assert_eq!(f.runs().len(), 2);
    assert!(all_dead(&f.runs()[..1]), "the timed-out core must be killed before the retry");
}

#[cfg(unix)]
#[test]
fn a_first_start_that_times_out_twice_fails_after_exactly_two_spawns() {
    // Needs a local port: cannot run inside the command sandbox.
    let t = Tuning { ready_deadline: Duration::from_millis(800), ..tuning_fast(free_ports(3)) };
    let Some(f) = Fake::new("slowtwice", "slow", t) else { return };
    let s = f.wait_for("failed", 20, |s| s.state == Phase::Failed);
    assert!(s.error.as_deref().unwrap_or("").contains("no /health"), "{s:?}");
    thread::sleep(Duration::from_millis(500));
    assert_eq!(f.runs().len(), 2, "one retry, not a loop");
}

#[test]
fn health_watch_waits_out_a_busy_core_but_not_a_dead_one() {
    let t = tuning_fast(vec![1]);
    let t0 = Instant::now();
    let mut w = HealthWatch::default();
    // Dead (port refuses): killed after health_fails consecutive failures.
    assert!(!w.record(HealthOutcome::Dead, t0, &t));
    assert!(w.record(HealthOutcome::Dead, t0, &t));
    // Busy: not killed inside the budget, killed once it is exhausted.
    let mut w = HealthWatch::default();
    for i in 0..50u64 {
        assert!(!w.record(HealthOutcome::Busy, t0 + Duration::from_millis(i * 20), &t));
    }
    assert!(w.record(HealthOutcome::Busy, t0 + t.health_busy_budget, &t));
    // A healthy answer resets the budget.
    let mut w = HealthWatch::default();
    assert!(!w.record(HealthOutcome::Busy, t0, &t));
    assert!(!w.record(HealthOutcome::Healthy, t0 + Duration::from_millis(900), &t));
    assert!(!w.record(HealthOutcome::Busy, t0 + t.health_busy_budget, &t));
    assert!(Tuning::default().health_busy_budget >= Duration::from_secs(60));
}

#[cfg(unix)]
#[test]
fn quit_while_starting_never_leaves_a_core_behind_or_reports_ready() {
    let Some(f) = Fake::new("qws", "slow", tuning_fast(free_ports(2))) else { return };
    f.wait_for("spawned", 10, |s| s.pid.is_some());
    let end = Instant::now() + Duration::from_secs(10);
    while f.runs().is_empty() && Instant::now() < end {
        thread::sleep(Duration::from_millis(20)); // node has started and holds its grandchild
    }
    let leader = f.host.status().pid.unwrap() as i32;
    f.host.shutdown();
    thread::sleep(Duration::from_millis(500));
    let s = f.host.status();
    assert_ne!(s.state, Phase::Ready);
    assert!(all_dead(&[leader]));
    // The start thread must not spawn again after shutdown.
    thread::sleep(Duration::from_millis(500));
    assert_eq!(f.runs().len(), 1);
}

#[cfg(unix)]
#[test]
fn claude_status_is_exposed_additively_and_never_with_a_path() {
    let Some(f) = Fake::new("claude", "ok", tuning_fast(free_ports(2))) else { return };
    let s = f.wait_for("claude probed", 15, |s| s.claude != "unknown");
    assert_eq!(s.claude, "missing");
    assert_eq!(s.claude_notice.as_deref(), Some("install claude"));
    assert!(s.claude_source.is_none());
    let json = serde_json::to_value(&s).unwrap();
    for k in ["restarts", "restart_in_ms", "fatal", "claude", "claude_source", "claude_notice", "url", "state"] {
        assert!(json.get(k).is_some(), "missing {k}");
    }
    assert_eq!(json["state"], "ready");
}

#[test]
fn restarting_serialises_lowercase() {
    assert_eq!(serde_json::to_value(Phase::Restarting).unwrap(), "restarting");
}

#[test]
fn claude_probe_output_is_parsed_strictly() {
    let found = "noise\nLLMIDE_CLAUDE_PROBE {\"found\":true,\"source\":\"installed\",\"message\":\"m\"}\n";
    let i = parse_claude_probe(found).unwrap();
    assert_eq!((i.state, i.source.as_deref(), i.notice), ("found", Some("installed"), None));
    let missing = "LLMIDE_CLAUDE_PROBE {\"found\":false,\"source\":\"none\",\"message\":\"Install Claude Code\"}";
    let i = parse_claude_probe(missing).unwrap();
    assert_eq!((i.state, i.notice.as_deref()), ("missing", Some("Install Claude Code")));
    // An odd source is dropped; an oversized or multi-line message falls back to ours.
    let weird = "LLMIDE_CLAUDE_PROBE {\"found\":true,\"source\":\"/Users/x/claude\"}";
    assert!(parse_claude_probe(weird).unwrap().source.is_none());
    let long = format!("LLMIDE_CLAUDE_PROBE {{\"found\":false,\"message\":\"{}\"}}", "a".repeat(500));
    assert_eq!(parse_claude_probe(&long).unwrap().notice.as_deref(), Some(CLAUDE_FALLBACK_NOTICE));
    assert!(parse_claude_probe("no marker here").is_none());
    assert!(parse_claude_probe("LLMIDE_CLAUDE_PROBE not-json").is_none());
}

#[test]
fn bundled_core_needs_both_node_and_server() {
    let d = std::env::temp_dir().join(format!("llmide-bundle-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    let core = d.join("core");
    std::fs::create_dir_all(core.join("root/extension")).unwrap();
    std::fs::create_dir_all(core.join("node")).unwrap();
    assert!(bundled_core_dir(&d).is_none());
    std::fs::write(core.join("root/extension/server.mjs"), "").unwrap();
    assert!(bundled_core_dir(&d).is_none());
    std::fs::write(core.join("node").join(NODE_FILE), "").unwrap();
    assert_eq!(bundled_core_dir(&d), Some(core));
}

#[cfg(unix)]
#[test]
fn the_core_command_runs_with_a_cleared_environment_and_explicit_db() {
    let rt = Runtime { mode: "bundled", node: PathBuf::from("/App/core/node/node"), root: PathBuf::from("/App/core/root") };
    let cmd = core_command(&rt, Path::new("/data/core"));
    let envs: std::collections::HashMap<_, _> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string()))).collect();
    assert_eq!(envs["LLMIDE_DATA_DIR"].as_deref(), Some("/data/core"));
    assert_eq!(envs["LLMIDE_DB_PATH"].as_deref(), Some("/data/core/data.db"));
    assert_eq!(envs["LLMIDE_PLUGIN_DIR"].as_deref(), Some("/data/core/addons/plugins"));
    assert!(envs["PATH"].as_deref().unwrap().ends_with("/App/core/node"));
    for leaked in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "LLMIDE_JWT_SECRET", "GITHUB_TOKEN"] {
        assert!(!envs.contains_key(leaked), "{leaked} must not reach the core");
    }
    assert_eq!(cmd.get_current_dir(), Some(Path::new("/App/core/root/extension")));
}

/// Run by hand against a real staging (`node scripts/stage-core.mjs` first):
/// `LLMIDE_KEYCHAIN_BACKEND=memory cargo test --lib real_staged_core -- --ignored --nocapture`.
/// Exercises the production launcher (cleared env, secrets, data layout), the nonce
/// handshake, the claude probe and the tree stop against the real server.
#[cfg(unix)]
#[test]
#[ignore]
fn real_staged_core_starts_reports_claude_and_stops_clean() {
    let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("resources");
    assert!(res.join("core").join("node").join(NODE_FILE).is_file(), "stage the core first");
    set_resource_dir(res.canonicalize().unwrap());
    std::env::set_var("LLMIDE_POC_BUNDLED", "1");
    std::env::set_var("LLMIDE_KEYCHAIN_BACKEND", "memory");
    let dir = std::env::temp_dir().join(format!("llmide-real-core-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let dir = fsutil::private_dir(&dir).unwrap();
    let t = Tuning { ports: free_ports(2), adopt: false, ..Tuning::default() };
    let host = CoreHost::with(t, Arc::new(real_launch), Arc::new(real_claude_probe));
    host.start_in_background(Some(dir.clone()));
    let end = Instant::now() + Duration::from_secs(40);
    let s = loop {
        let s = host.status();
        if (s.state == Phase::Ready && s.claude != "unknown") || s.state == Phase::Failed || Instant::now() > end {
            break s;
        }
        thread::sleep(Duration::from_millis(50));
    };
    println!("status: {s:?}");
    assert_eq!(s.state, Phase::Ready, "{s:?}");
    assert_eq!(s.trust, "spawned");
    assert!(dir.join("core").join("data.db").is_file(), "DB must live in the data dir");
    assert_ne!(s.claude, "unknown");
    let pid = s.pid.unwrap() as i32;
    host.shutdown();
    // SAFETY: existence check only.
    assert!(all_dead(&[pid]), "core survived shutdown");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_spawned_core_holds_extension_captures_for_the_archivist() {
    assert!(SPAWNED_CORE_FLAGS.contains(&("LLMIDE_LIVE_ACK", "1")));
    let host = vec![("LLMIDE_LIVE_ACK".to_string(), "0".to_string())];
    assert!(crate::core_env::scrub(&host, crate::fsutil::Os::Mac).is_empty(), "never taken from the host env");
}
#[test]
fn the_spawned_core_loads_switched_on_catalog_extensions() {
    assert!(SPAWNED_CORE_FLAGS.contains(&("LLMIDE_EXT_ACTIVE_SET", "1")));
    let host = vec![("LLMIDE_EXT_ACTIVE_SET".to_string(), "0".to_string())];
    assert!(crate::core_env::scrub(&host, crate::fsutil::Os::Mac).is_empty(), "never taken from the host env");
}
#[test]
fn the_spawned_core_forces_only_chat_clear_and_leaves_switchable_capabilities_to_prefs() {
    assert!(SPAWNED_CORE_FLAGS.contains(&("LLMIDE_HOST_API_CHAT_CLEAR", "1")));
    // Forcing these would override the Settings switch; prefs::core_env_pairs owns them (default on).
    for key in ["LLMIDE_HOST_API_READ", "LLMIDE_HOST_API_COMPOSE", "LLMIDE_HOST_API_TOOL_APPROVALS"] {
        assert!(!SPAWNED_CORE_FLAGS.iter().any(|(k, _)| *k == key), "{key} must follow the pref");
    }
    let env = crate::prefs::core_env_pairs(&crate::prefs::Prefs::default(), None);
    for key in ["LLMIDE_HOST_API_READ", "LLMIDE_HOST_API_COMPOSE", "LLMIDE_HOST_API_TOOL_APPROVALS"] {
        assert!(env.contains(&(key, "1".to_string())), "{key} is on by default");
    }
}
#[cfg(unix)]
#[test]
fn addons_are_copied_once_from_the_old_app_without_following_symlinks() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("llmide-addons-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let support = root.join("support");
    std::fs::create_dir_all(support.join("llm-ide/plugins/p1")).unwrap();
    std::fs::create_dir_all(support.join("llm-ide/llm-sources")).unwrap();
    std::fs::write(support.join("llm-ide/plugins/p1/a.txt"), "a").unwrap();
    std::fs::write(support.join("llm-ide/llm-sources.json"), "{}").unwrap();
    let outside = root.join("outside.txt");
    std::fs::write(&outside, "secret").unwrap();
    symlink(&outside, support.join("llm-ide/plugins/leak")).unwrap();
    let core = root.join("core");
    std::fs::create_dir_all(&core).unwrap();
    assert!(migrate_addons_from(&core, &support).unwrap());
    assert_eq!(std::fs::read_to_string(core.join("addons/plugins/p1/a.txt")).unwrap(), "a");
    assert!(core.join("addons/llm-sources.json").exists());
    assert!(!core.join("addons/plugins/leak").exists(), "symlinks are not followed");
    assert!(!migrate_addons_from(&core, &support).unwrap(), "second run is a no-op");
    assert!(support.join("llm-ide/plugins/p1/a.txt").exists(), "the old folder is untouched");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn secrets_go_to_stdin_and_never_into_the_environment() {
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    let line = wire_secrets(&mut cmd, "jwt-secret-value-0123456789abcdef", "vault-key-value-0123456789abcdef", "approval-key-value-0123456789abcdef");
    let names: Vec<String> = cmd.get_envs().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    assert!(names.iter().any(|n| n == "LLMIDE_SECRETS_STDIN"), "the core is told to read stdin");
    for k in ["LLMIDE_JWT_SECRET", "LLMIDE_VAULT_KEY", "LLMIDE_HOST_APPROVAL_KEY"] {
        assert!(!names.iter().any(|n| n == k), "{k} must not be in the child environment");
    }
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["jwtSecret"], "jwt-secret-value-0123456789abcdef");
    assert_eq!(v["vaultKey"], "vault-key-value-0123456789abcdef");
    assert_eq!(v["hostApprovalKey"], "approval-key-value-0123456789abcdef");
}

/// A fake child (`cat`) proves the line is readable from stdin and closed by the writer.
#[cfg(unix)]
#[test]
fn a_fake_child_reads_the_secrets_line_from_its_stdin() {
    use std::io::Write;
    let mut cmd = Command::new("/bin/cat");
    let line = wire_secrets(&mut cmd, "jwt-secret-value-0123456789abcdef", "vault-key-value-0123456789abcdef", "approval-key-value-0123456789abcdef");
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(format!("{line}\n").as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), line, "the child read exactly the JSON line");
}

#[test]
fn the_backoff_curve_doubles_and_stops_at_the_cap() {
    let secs = |base: u64, cap: u64, attempt: u32| {
        exponential_backoff(Duration::from_secs(base), Duration::from_secs(cap), attempt).as_secs()
    };
    // The SSH link's curve: 1, 2, 4, 8, then 15 for every later attempt (attempt 0 counts as the first).
    let ssh: Vec<u64> = [0, 1, 2, 3, 4, 5, 6, 20, 64, 65, u32::MAX].iter().map(|a| secs(1, 15, *a)).collect();
    assert_eq!(ssh, vec![1, 1, 2, 4, 8, 15, 15, 15, 15, 15, 15]);
    // A core-restart style curve: 2 s base, 30 s cap.
    let core: Vec<u64> = (1..=6).map(|a| secs(2, 30, a)).collect();
    assert_eq!(core, vec![2, 4, 8, 16, 30, 30]);
}
