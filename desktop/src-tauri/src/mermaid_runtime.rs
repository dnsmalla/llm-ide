//! Optional Mermaid runtime: a user-initiated, pinned, verified, one-time download.
//!
//! The diagram renderer (mermaid.min.js, 3.4 MB, MIT) is not shipped. When a Doc Gen / Visual result holds a
//! ```mermaid fence the user may click "Install diagram renderer"; only then does the host download ONE artifact:
//!
//! - the URL is a constant from `resources/mermaid.pin.json` (embedded at build time), never from the webview;
//!   it must be `https://cdn.jsdelivr.net/npm/mermaid@<version>/dist/mermaid.min.js` (host allowlist, no port, no
//!   userinfo, version matches the pin);
//! - a native dialog (Cancel first, fixed text naming the host, version and size) must be accepted;
//! - the transfer is `curl` with `--proto =https --tlsv1.2 --max-redirs 0 --max-filesize --max-time`, a scrubbed
//!   environment and no config file (the crate set has no TLS stack, and adding one needs a dependency decision);
//!   a redirect, a non-200 status or an oversize body is an error;
//! - the bytes are verified against the SHA-256 committed in the pin BEFORE anything is stored (fail closed);
//! - stored atomically with 0600 as `<data dir>/runtime/mermaid-<version>.js`; other versions are pruned;
//! - the host NEVER executes or interprets the file. `mermaid_runtime_read` returns the bytes, re-verified against the
//!   pin on EVERY read and size-capped, to the main window only (capability `windows: ["main"]`).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::confirm::{ask, herr, OpenFlag, RateLimit};
use crate::fs_ops::FsError;

const PIN_JSON: &str = include_str!("../resources/mermaid.pin.json");
/// Hard cap for a download and for a read (the real file is ~3.4 MB).
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const ALLOWED_HOST: &str = "cdn.jsdelivr.net";
const CONNECT_TIMEOUT_S: &str = "15";
const TOTAL_TIMEOUT_S: &str = "120";
static INSTALL_LIMIT: RateLimit = RateLimit::new(2_000, 6);
static INSTALL_OPEN: OpenFlag = OpenFlag::new();

#[derive(Deserialize, Clone, Debug)]
pub struct Pin {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub bytes: usize,
}

impl Pin {
    pub fn embedded() -> Result<Pin, String> {
        Self::parse(PIN_JSON)
    }

    pub fn parse(json: &str) -> Result<Pin, String> {
        let pin: Pin = serde_json::from_str(json).map_err(|e| format!("bad mermaid pin: {e}"))?;
        pin.validate()?;
        Ok(pin)
    }

    pub fn validate(&self) -> Result<(), String> {
        let v_ok = !self.version.is_empty()
            && self.version.len() <= 32
            && self.version.chars().all(|c| c.is_ascii_digit() || c == '.')
            && self.version.split('.').count() == 3
            && self.version.split('.').all(|p| !p.is_empty());
        if !v_ok {
            return Err("pin: version must be exact x.y.z".into());
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err("pin: sha256 must be 64 lowercase hex digits".into());
        }
        if self.bytes == 0 || self.bytes > MAX_BYTES {
            return Err("pin: bytes out of range".into());
        }
        validate_url(&self.url, &self.version)
    }

    pub fn file_name(&self) -> String {
        format!("mermaid-{}.js", self.version)
    }
}

/// The only URL shape the host will fetch.
pub fn validate_url(url: &str, version: &str) -> Result<(), String> {
    let expected = format!("https://{ALLOWED_HOST}/npm/mermaid@{version}/dist/mermaid.min.js");
    if url != expected {
        return Err(format!("url must be exactly {expected}"));
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    Redirect(u16),
    Status(String),
    TooLarge,
    Transport(String),
}

impl FetchError {
    fn code(&self) -> &'static str {
        match self {
            FetchError::Redirect(_) => "redirect_refused",
            FetchError::Status(_) => "http_status",
            FetchError::TooLarge => "too_large",
            FetchError::Transport(_) => "download_failed",
        }
    }
}

/// The network seam. Contract: returns the COMPLETE body of a 200 response of at most `max` bytes, or an error;
/// never a partial body, never follows a redirect. The bytes are untrusted: the caller verifies them.
pub trait Fetcher {
    fn fetch(&self, url: &str, max: usize, scratch_dir: &Path) -> Result<Vec<u8>, FetchError>;
}

/// Interprets curl's `--write-out %{http_code}` output and exit status. Pure, so it is testable.
pub fn interpret_curl(exit_ok: bool, exit_code: Option<i32>, http_code: &str) -> Result<(), FetchError> {
    let code: u16 = http_code.trim().parse().unwrap_or(0);
    if (300..400).contains(&code) {
        return Err(FetchError::Redirect(code));
    }
    if exit_code == Some(63) {
        return Err(FetchError::TooLarge);
    }
    if !exit_ok {
        return Err(FetchError::Transport(format!("curl exit {}", exit_code.map_or("signal".into(), |c| c.to_string()))));
    }
    if code != 200 {
        return Err(FetchError::Status(http_code.trim().chars().take(8).collect()));
    }
    Ok(())
}

pub struct CurlFetcher;

fn curl_path() -> PathBuf {
    if cfg!(windows) {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        PathBuf::from(root).join("System32").join("curl.exe")
    } else {
        PathBuf::from("/usr/bin/curl")
    }
}

impl Fetcher for CurlFetcher {
    fn fetch(&self, url: &str, max: usize, scratch_dir: &Path) -> Result<Vec<u8>, FetchError> {
        let pin = Pin::embedded().map_err(FetchError::Transport)?;
        if url != pin.url {
            return Err(FetchError::Transport("url is not the pinned url".into()));
        }
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let part = scratch_dir.join(format!(".dl-{}-{nanos}.part", std::process::id()));
        let out = Command::new(curl_path())
            // -q first: ignore any ~/.curlrc.
            .args(["-q", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--max-redirs", "0"])
            .args(["--connect-timeout", CONNECT_TIMEOUT_S, "--max-time", TOTAL_TIMEOUT_S])
            .args(["--max-filesize", &max.to_string(), "--write-out", "%{http_code}", "--output"])
            .arg(&part)
            .arg("--")
            .arg(url)
            .env_clear()
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let result = (|| {
            let out = out.map_err(|e| FetchError::Transport(format!("cannot run curl: {e}")))?;
            interpret_curl(out.status.success(), out.status.code(), &String::from_utf8_lossy(&out.stdout))?;
            let f = std::fs::File::open(&part).map_err(|e| FetchError::Transport(e.to_string()))?;
            let mut body = Vec::new();
            f.take(max as u64 + 1).read_to_end(&mut body).map_err(|e| FetchError::Transport(e.to_string()))?;
            if body.len() > max {
                return Err(FetchError::TooLarge);
            }
            Ok(body)
        })();
        let _ = std::fs::remove_file(&part);
        result
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub version: String,
    pub size_bytes: usize,
    pub host: String,
}

fn runtime_dir(data: &Path) -> PathBuf {
    data.join("runtime")
}

/// Reads and verifies the installed file. `Ok(None)` when absent; `Err("integrity ...")` when present but wrong.
pub fn read_verified(data: &Path, pin: &Pin) -> Result<Option<Vec<u8>>, FsError> {
    let path = runtime_dir(data).join(pin.file_name());
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(herr("io", e.to_string())),
    };
    if !meta.file_type().is_file() {
        return Err(herr("integrity", "the installed runtime is not a regular file"));
    }
    if meta.len() as usize > MAX_BYTES {
        return Err(herr("integrity", "the installed runtime is too large"));
    }
    let mut body = Vec::new();
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    opts.open(&path)
        .and_then(|f| f.take(MAX_BYTES as u64 + 1).read_to_end(&mut body))
        .map_err(|e| herr("io", e.to_string()))?;
    if body.len() > MAX_BYTES || sha256_hex(&body) != pin.sha256 {
        return Err(herr("integrity", "the installed runtime does not match the pinned checksum"));
    }
    Ok(Some(body))
}

pub fn status(data: &Path, pin: &Pin) -> Status {
    let body = read_verified(data, pin).ok().flatten();
    Status { installed: body.is_some(), version: pin.version.clone(), size_bytes: body.map_or(pin.bytes, |b| b.len()), host: ALLOWED_HOST.into() }
}

/// Writes verified `body` as the runtime file: temp file (0600) in the same directory, fsync, rename. Any failure
/// removes the temp file and leaves the previous file untouched.
fn store(dir: &Path, pin: &Pin, body: &[u8]) -> Result<(), FsError> {
    use std::io::Write;
    let target = dir.join(pin.file_name());
    let tmp = dir.join(format!(".{}.part", pin.file_name()));
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write = opts.open(&tmp).and_then(|mut f| f.write_all(body).and_then(|()| f.sync_all()));
    let renamed = write.and_then(|()| std::fs::rename(&tmp, &target));
    if let Err(e) = renamed {
        let _ = std::fs::remove_file(&tmp);
        return Err(herr("io", format!("cannot store the runtime: {e}")));
    }
    // Drop other versions: nothing can load them (read only looks for the pinned file name).
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n != pin.file_name() && n.starts_with("mermaid-") && n.ends_with(".js") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

/// Download (through `fetcher`), verify, store. On any error nothing at the target changed.
pub fn install_with(data: &Path, pin: &Pin, fetcher: &dyn Fetcher) -> Result<Status, FsError> {
    pin.validate().map_err(|e| herr("bad_pin", e))?;
    let dir = crate::fsutil::private_dir(&runtime_dir(data)).map_err(|e| herr("io", e))?;
    let body = fetcher.fetch(&pin.url, MAX_BYTES, &dir).map_err(|e| herr(e.code(), format!("{e:?}")))?;
    if body.len() > MAX_BYTES {
        return Err(herr("too_large", "download larger than the cap"));
    }
    let actual = sha256_hex(&body);
    if actual != pin.sha256 {
        return Err(herr("integrity", "the downloaded file did not match the pinned checksum and was discarded"));
    }
    store(&dir, pin, &body)?;
    Ok(status(data, pin))
}

/// Fixed dialog text: host, version and size come from the embedded pin, nothing from the webview.
pub fn confirm_text(pin: &Pin) -> String {
    format!(
        "Install the diagram renderer?\n\nThis downloads Mermaid {} (about {} KB, MIT licence) once from {} over HTTPS and \
         stores it in the app's data folder. Its checksum is verified before it is saved; a file that does not match is discarded. \
         It runs only inside a locked-down frame, never in the app itself.",
        pin.version,
        pin.bytes.div_ceil(1024),
        ALLOWED_HOST
    )
}

fn data_dir() -> Result<PathBuf, FsError> {
    crate::fsutil::desktop_data_dir().map_err(|e| herr("io", e))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, FsError> + Send + 'static) -> Result<T, FsError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| herr("io", format!("task failed: {e}")))?
}

#[tauri::command]
pub async fn mermaid_runtime_status() -> Result<Status, FsError> {
    let data = data_dir()?;
    blocking(move || {
        let pin = Pin::embedded().map_err(|e| herr("bad_pin", e))?;
        Ok(status(&data, &pin))
    })
    .await
}

/// Asks the user (native dialog, Cancel first), then downloads, verifies and stores the pinned runtime.
/// Returns the new status; a declined dialog returns the unchanged status.
#[tauri::command]
pub async fn mermaid_runtime_install() -> Result<Status, FsError> {
    let data = data_dir()?;
    let pin = Pin::embedded().map_err(|e| herr("bad_pin", e))?;
    if !INSTALL_LIMIT.allow() {
        return Err(herr("rate_limited", "too many install requests"));
    }
    let _open = INSTALL_OPEN.acquire().ok_or_else(|| herr("busy", "an install is already in progress"))?;
    let text = confirm_text(&pin);
    let accepted = tauri::async_runtime::spawn_blocking(move || ask("Install diagram renderer?", &text, "Download and install", false))
        .await
        .map_err(|e| herr("io", format!("task failed: {e}")))?;
    blocking(move || if accepted { install_with(&data, &pin, &CurlFetcher) } else { Ok(status(&data, &pin)) }).await
}

/// The verified runtime bytes (UTF-8 JavaScript) for the main window to place in a sandboxed frame.
/// Re-verified against the pin on every call. The host never executes it.
#[tauri::command]
pub async fn mermaid_runtime_read() -> Result<tauri::ipc::Response, FsError> {
    let data = data_dir()?;
    blocking(move || {
        let pin = Pin::embedded().map_err(|e| herr("bad_pin", e))?;
        read_verified(&data, &pin)?.map(tauri::ipc::Response::new).ok_or_else(|| herr("not_installed", "the diagram renderer is not installed"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        body: Result<Vec<u8>, FetchError>,
        calls: RefCell<Vec<String>>,
    }
    impl Fake {
        fn ok(b: &[u8]) -> Fake {
            Fake { body: Ok(b.to_vec()), calls: RefCell::new(vec![]) }
        }
        fn err(e: FetchError) -> Fake {
            Fake { body: Err(e), calls: RefCell::new(vec![]) }
        }
    }
    impl Fetcher for Fake {
        fn fetch(&self, url: &str, _max: usize, _d: &Path) -> Result<Vec<u8>, FetchError> {
            self.calls.borrow_mut().push(url.to_string());
            match &self.body {
                Ok(b) => Ok(b.clone()),
                Err(FetchError::Redirect(c)) => Err(FetchError::Redirect(*c)),
                Err(FetchError::TooLarge) => Err(FetchError::TooLarge),
                Err(FetchError::Status(s)) => Err(FetchError::Status(s.clone())),
                Err(FetchError::Transport(s)) => Err(FetchError::Transport(s.clone())),
            }
        }
    }

    fn pin_for(body: &[u8]) -> Pin {
        Pin { version: "9.9.9".into(), url: "https://cdn.jsdelivr.net/npm/mermaid@9.9.9/dist/mermaid.min.js".into(), sha256: sha256_hex(body), bytes: body.len().max(1) }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-mermaid-{name}-{}-{}", std::process::id(), crate::confirm::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn files(data: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(data.join("runtime")).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        v.sort();
        v
    }

    #[test]
    fn the_embedded_pin_is_valid_and_matches_the_expected_url_shape() {
        let pin = Pin::embedded().unwrap();
        assert_eq!(pin.url, format!("https://cdn.jsdelivr.net/npm/mermaid@{}/dist/mermaid.min.js", pin.version));
        assert_eq!(pin.sha256.len(), 64);
    }

    #[test]
    fn url_validation_is_exact() {
        let v = "11.17.2";
        assert!(validate_url("https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js", v).is_ok());
        for bad in [
            "http://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js",
            "https://cdn.jsdelivr.net.evil.com/npm/mermaid@11.17.2/dist/mermaid.min.js",
            "https://evil.com/npm/mermaid@11.17.2/dist/mermaid.min.js",
            "https://cdn.jsdelivr.net:8443/npm/mermaid@11.17.2/dist/mermaid.min.js",
            "https://user@cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js",
            "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
            "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js?x=1",
            "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/../mermaid.min.js",
        ] {
            assert!(validate_url(bad, v).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_malformed_pin_is_refused() {
        let mut p = pin_for(b"x");
        p.sha256 = "ABC".into();
        assert!(p.validate().is_err());
        let mut p = pin_for(b"x");
        p.version = "latest".into();
        assert!(p.validate().is_err());
        let mut p = pin_for(b"x");
        p.bytes = MAX_BYTES + 1;
        assert!(p.validate().is_err());
    }

    #[test]
    fn a_good_artifact_installs_reads_back_and_is_private() {
        let data = tmp("ok");
        let body = b"console.log('mermaid')";
        let pin = pin_for(body);
        let f = Fake::ok(body);
        let st = install_with(&data, &pin, &f).unwrap();
        assert!(st.installed);
        assert_eq!(f.calls.borrow().as_slice(), [pin.url.clone()]);
        assert_eq!(read_verified(&data, &pin).unwrap().unwrap(), body);
        assert_eq!(files(&data), ["mermaid-9.9.9.js"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(data.join("runtime/mermaid-9.9.9.js")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_tampered_artifact_is_refused_and_nothing_is_written() {
        let data = tmp("tamper");
        let pin = pin_for(b"genuine");
        let e = install_with(&data, &pin, &Fake::ok(b"genuinX")).unwrap_err();
        assert_eq!(e.code, "integrity");
        assert!(files(&data).is_empty());
        assert!(!status(&data, &pin).installed);
    }

    #[test]
    fn an_oversize_artifact_is_refused() {
        let data = tmp("big");
        let pin = pin_for(b"small");
        let e = install_with(&data, &pin, &Fake::err(FetchError::TooLarge)).unwrap_err();
        assert_eq!(e.code, "too_large");
        let huge = vec![b'a'; MAX_BYTES + 1];
        let e = install_with(&data, &pin_for(&huge), &Fake::ok(&huge)).unwrap_err();
        assert!(e.code == "too_large" || e.code == "bad_pin", "{}", e.code);
        assert!(files(&data).is_empty());
    }

    #[test]
    fn a_redirect_or_bad_status_is_refused() {
        let data = tmp("redir");
        let pin = pin_for(b"x");
        assert_eq!(install_with(&data, &pin, &Fake::err(FetchError::Redirect(302))).unwrap_err().code, "redirect_refused");
        assert_eq!(install_with(&data, &pin, &Fake::err(FetchError::Status("404".into()))).unwrap_err().code, "http_status");
        assert_eq!(install_with(&data, &pin, &Fake::err(FetchError::Transport("x".into()))).unwrap_err().code, "download_failed");
        assert!(files(&data).is_empty());
    }

    #[test]
    fn curl_outcomes_are_interpreted_fail_closed() {
        assert_eq!(interpret_curl(true, Some(0), "200"), Ok(()));
        assert_eq!(interpret_curl(true, Some(0), "301"), Err(FetchError::Redirect(301)));
        assert_eq!(interpret_curl(false, Some(0), "302"), Err(FetchError::Redirect(302)));
        assert_eq!(interpret_curl(false, Some(63), "200"), Err(FetchError::TooLarge));
        assert!(matches!(interpret_curl(false, Some(35), "000"), Err(FetchError::Transport(_))));
        assert!(matches!(interpret_curl(false, None, ""), Err(FetchError::Transport(_))));
        assert!(matches!(interpret_curl(true, Some(0), "404"), Err(FetchError::Status(_))));
        assert!(matches!(interpret_curl(true, Some(0), ""), Err(FetchError::Status(_))));
        assert!(matches!(interpret_curl(true, Some(0), "200; rm"), Err(FetchError::Status(_))));
    }

    #[test]
    fn a_failed_write_cleans_up_its_partial_file_and_keeps_the_old_one() {
        let data = tmp("partial");
        let old = b"old good";
        let pin = pin_for(old);
        install_with(&data, &pin, &Fake::ok(old)).unwrap();
        // Make the rename fail: a directory now sits where the target should be replaced.
        let dir = data.join("runtime");
        std::fs::remove_file(dir.join("mermaid-9.9.9.js")).unwrap();
        std::fs::create_dir(dir.join("mermaid-9.9.9.js")).unwrap();
        let e = install_with(&data, &pin, &Fake::ok(old)).unwrap_err();
        assert_eq!(e.code, "io");
        assert_eq!(files(&data), ["mermaid-9.9.9.js"], "no .part file left behind");
    }

    #[test]
    fn a_later_install_replaces_atomically_and_prunes_other_versions() {
        let data = tmp("replace");
        let a = b"version a";
        let pa = Pin { version: "1.0.0".into(), url: "https://cdn.jsdelivr.net/npm/mermaid@1.0.0/dist/mermaid.min.js".into(), sha256: sha256_hex(a), bytes: a.len() };
        install_with(&data, &pa, &Fake::ok(a)).unwrap();
        let b = b"version b";
        let pb = Pin { version: "1.0.1".into(), url: "https://cdn.jsdelivr.net/npm/mermaid@1.0.1/dist/mermaid.min.js".into(), sha256: sha256_hex(b), bytes: b.len() };
        install_with(&data, &pb, &Fake::ok(b)).unwrap();
        assert_eq!(files(&data), ["mermaid-1.0.1.js"]);
        // A tampered re-install leaves the good file in place.
        assert!(install_with(&data, &pb, &Fake::ok(b"nope")).is_err());
        assert_eq!(read_verified(&data, &pb).unwrap().unwrap(), b);
    }

    #[test]
    fn the_hash_is_re_verified_at_every_read() {
        let data = tmp("reread");
        let body = b"genuine runtime";
        let pin = pin_for(body);
        install_with(&data, &pin, &Fake::ok(body)).unwrap();
        let path = data.join("runtime/mermaid-9.9.9.js");
        std::fs::write(&path, b"edited on disk").unwrap();
        assert_eq!(read_verified(&data, &pin).unwrap_err().code, "integrity");
        assert!(!status(&data, &pin).installed);
        std::fs::write(&path, vec![b'a'; MAX_BYTES + 5]).unwrap();
        assert_eq!(read_verified(&data, &pin).unwrap_err().code, "integrity");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_runtime_file_is_refused() {
        let data = tmp("link");
        let body = b"genuine runtime";
        let pin = pin_for(body);
        install_with(&data, &pin, &Fake::ok(body)).unwrap();
        let real = data.join("elsewhere.js");
        std::fs::write(&real, body).unwrap();
        let path = data.join("runtime/mermaid-9.9.9.js");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&real, &path).unwrap();
        assert_eq!(read_verified(&data, &pin).unwrap_err().code, "integrity");
    }

    #[test]
    fn absent_runtime_is_not_installed_and_read_is_none() {
        let data = tmp("absent");
        let pin = pin_for(b"x");
        assert!(read_verified(&data, &pin).unwrap().is_none());
        assert!(!status(&data, &pin).installed);
    }

    #[test]
    fn the_dialog_text_names_host_version_and_size_from_the_pin() {
        let pin = Pin::embedded().unwrap();
        let t = confirm_text(&pin);
        assert!(t.contains("cdn.jsdelivr.net") && t.contains(&pin.version) && t.contains("once") && t.contains("data folder"));
        assert!(t.contains(&format!("{} KB", pin.bytes.div_ceil(1024))));
    }

    #[test]
    fn curl_fetcher_refuses_any_url_but_the_pinned_one() {
        let d = tmp("curl");
        assert!(matches!(CurlFetcher.fetch("https://evil.example/x.js", 10, &d), Err(FetchError::Transport(_))));
    }
}
