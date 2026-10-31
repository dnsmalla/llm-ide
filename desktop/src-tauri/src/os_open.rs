//! Asking the OS to open a link (`open_external_url`) or to reveal a project entry in the
//! file manager (`reveal_in_os`), without the shell/opener plugin.
//!
//! `open_external_url(url)` threat model: the webview holds the IPC grants and renders model
//! output, so a hostile link must not make the OS open something internal or dangerous.
//! - Only `http`, `https` and `mailto`. Parsed with the `url` crate; the raw string may not
//!   contain whitespace, control characters, backslashes or invisible/bidi format characters
//!   (the parser would silently strip or reinterpret some of them), and is capped at 2048
//!   bytes.
//! - No userinfo (`https://paypal.com@evil.example/`), no empty host.
//! - http(s) hosts must look public: refused are `localhost`, single-label names, the
//!   reserved/intranet suffixes (`.local`, `.internal`, `.lan`, `.home.arpa`, ...), numeric
//!   TLDs, and every IP literal in a loopback, private, link-local, CGNAT, multicast,
//!   documentation, unspecified or reserved range, including IPv4 hidden inside IPv6
//!   (mapped, compatible, NAT64, 6to4, Teredo). The `url` crate normalises decimal, octal and
//!   hex IPv4 forms (`http://2130706433/`) before this check, so those are caught too. A public
//!   name that RESOLVES to a private address (DNS rebinding) cannot be seen without a
//!   lookup the host deliberately does not make; the confirmation below covers that case.
//! - `mailto:` keeps only the `to`/`cc`/`bcc`/`subject`/`body` query keys (an `attach=` key makes
//!   some mail clients attach a local file).
//! - Rate limited (500 ms gap, 30 per minute) and one dialog at a time.
//! - The webview cannot prove a user gesture, so the FIRST open per host per app session shows
//!   a native dialog with the full host and URL (default button Cancel). A host the user
//!   accepted is not asked again until the app restarts.
//!
//! Per-OS opener invocations (fixed program, args array, never a shell, environment scrubbed
//! of secrets, stdio closed, child reaped on a thread):
//! - macOS: `/usr/bin/open <url>` (a validated URL always starts with `http`/`mailto`, so it
//!   cannot be read as an option); reveal is `/usr/bin/open -R <absolute path>`, which selects
//!   the item in Finder.
//! - Windows: `%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler <url>`;
//!   `url` is the `url` crate's serialisation (spaces, quotes and non-ASCII percent-encoded),
//!   and no `cmd.exe` is involved so `&` and `%` are inert. Reveal is
//!   `%SystemRoot%\explorer.exe /select,"<path>"` passed as ONE raw argument (explorer
//!   mis-parses the quoting Rust would add around a path with spaces); the path comes from
//!   canonicalisation (the `\\?\` prefix is stripped) and cannot contain `"` on NTFS.
//! - Linux: the first existing of `/usr/bin/xdg-open`, `/bin/xdg-open`, `/usr/local/bin/xdg-open`
//!   (no PATH search) with `<url>`. Reveal opens the entry's PARENT FOLDER (xdg-open has no
//!   "select"), never the file itself, so it cannot launch a document or executable.
//!
//! `reveal_in_os(rel_path)`: `rel_path` is validated exactly like `fs_ops` (relative to the
//! active project root, no `..`, canonicalised, must stay inside the root); `""` reveals the
//! root itself.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use url::{Host, Url};

use crate::confirm::{ask, herr, RateLimit};
use crate::fs_ops::FsError;
use crate::fsutil::{current_os, Os};

pub const URL_MAX_BYTES: usize = 2048;
const CONFIRMED_MAX: usize = 256;

static URL_LIMIT: RateLimit = RateLimit::new(500, 30);
static REVEAL_LIMIT: RateLimit = RateLimit::new(300, 60);
static CONFIRMED_HOSTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static DIALOG_OPEN: Mutex<bool> = Mutex::new(false);

// ---- URL validation -----------------------------------------------------------------------

/// A URL that passed validation.
#[derive(Debug, PartialEq)]
pub struct Checked {
    /// The `url` crate's canonical serialisation: what is handed to the OS.
    pub url: String,
    /// Key for the per-session confirmation (`mailto` or the lower-case host).
    pub host_key: String,
}

fn refuse<T>(why: &str) -> Result<T, FsError> {
    Err(herr("url_refused", why.to_string()))
}

fn v4_blocked(a: std::net::Ipv4Addr) -> bool {
    let o = a.octets();
    a.is_loopback()
        || a.is_private()
        || a.is_link_local()
        || a.is_unspecified()
        || a.is_broadcast()
        || a.is_multicast()
        || a.is_documentation()
        || o[0] == 0
        || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT 100.64/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
        || o[0] >= 240 // reserved
}

fn v6_blocked(a: std::net::Ipv6Addr) -> bool {
    let s = a.segments();
    if a.is_loopback() || a.is_unspecified() || a.is_multicast() {
        return true;
    }
    if (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xffc0) == 0xfec0 {
        return true; // unique-local, link-local, site-local
    }
    if s[0] == 0x2001 && (s[1] == 0 || s[1] == 0x0db8) {
        return true; // Teredo, documentation
    }
    if s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0 {
        return true; // discard-only 100::/64
    }
    let embedded = |hi: u16, lo: u16| v4_blocked(std::net::Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8));
    if s[..5] == [0, 0, 0, 0, 0] && (s[5] == 0xffff || s[5] == 0) {
        return embedded(s[6], s[7]); // v4-mapped / v4-compatible
    }
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return embedded(s[6], s[7]); // NAT64 64:ff9b::/96
    }
    if s[0] == 0x2002 {
        return embedded(s[1], s[2]); // 6to4
    }
    false
}

const BLOCKED_SUFFIXES: [&str; 20] = [
    "localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "home.arpa", "test",
    "example", "invalid", "onion", "svc", "docker", "k8s", "consul", "ts.net", "cluster.local",
];

fn domain_blocked(d: &str) -> bool {
    let d = d.trim_end_matches('.');
    if !d.contains('.') {
        return true; // single label: intranet / search-domain name
    }
    if BLOCKED_SUFFIXES.iter().any(|s| d == *s || d.ends_with(&format!(".{s}"))) {
        return true;
    }
    d.rsplit('.').next().is_some_and(|tld| !tld.is_empty() && tld.bytes().all(|b| b.is_ascii_digit()))
}

/// Validates a link; see the module docs for the rules.
pub fn check_url(raw: &str) -> Result<Checked, FsError> {
    if raw.is_empty() || raw.len() > URL_MAX_BYTES {
        return refuse("the address is empty or too long");
    }
    if raw.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\' || crate::tray::is_invisible_format(c)) {
        return refuse("the address contains a forbidden character");
    }
    let u = Url::parse(raw).map_err(|_| herr("url_refused", "the address is not a valid URL"))?;
    match u.scheme() {
        "http" | "https" => {
            // The parser drops an empty `:@`, so also look at the raw authority.
            let authority = raw.split_once("://").map(|(_, r)| r.split(['/', '?', '#']).next().unwrap_or("")).unwrap_or("");
            if !u.username().is_empty() || u.password().is_some() || authority.contains('@') {
                return refuse("addresses with a user name or password are not opened");
            }
            let key = match u.host() {
                Some(Host::Domain(d)) => {
                    if domain_blocked(d) {
                        return refuse("that host is not a public website");
                    }
                    d.trim_end_matches('.').to_ascii_lowercase()
                }
                Some(Host::Ipv4(a)) => {
                    if v4_blocked(a) {
                        return refuse("that address is not a public host");
                    }
                    a.to_string()
                }
                Some(Host::Ipv6(a)) => {
                    if v6_blocked(a) {
                        return refuse("that address is not a public host");
                    }
                    a.to_string()
                }
                None => return refuse("the address has no host"),
            };
            Ok(Checked { url: u.as_str().to_string(), host_key: key })
        }
        "mailto" => {
            // A percent-encoded CR/LF smuggles header lines (`Bcc:`) into the message some clients build.
            let low = raw.to_ascii_lowercase();
            if low.contains("%0d") || low.contains("%0a") || low.contains("%00") {
                return refuse("the address contains an encoded line break");
            }
            if u.path().is_empty() && u.query().is_none() {
                return refuse("empty mailto address");
            }
            for (k, _) in u.query_pairs() {
                if !matches!(k.to_ascii_lowercase().as_str(), "to" | "cc" | "bcc" | "subject" | "body") {
                    return refuse("unsupported mailto field");
                }
            }
            Ok(Checked { url: u.as_str().to_string(), host_key: "mailto".to_string() })
        }
        _ => refuse("only http, https and mailto links can be opened"),
    }
}

// ---- OS invocations -----------------------------------------------------------------------

/// A fixed program plus its argument list. `raw` (Windows reveal only) means the single
/// argument is appended verbatim, without Rust's quoting.
#[derive(Debug, PartialEq)]
pub struct Invocation {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub raw: bool,
}

fn sysroot() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").filter(|s| !s.is_empty()).unwrap_or_else(|| "C:\\Windows".into()))
}

fn xdg_open() -> PathBuf {
    ["/usr/bin/xdg-open", "/bin/xdg-open", "/usr/local/bin/xdg-open"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("/usr/bin/xdg-open"))
}

/// Strips the `\\?\` verbatim prefix canonicalisation adds on Windows.
fn plain_windows_path(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

pub fn open_url_invocation(os: Os, url: &str) -> Invocation {
    match os {
        Os::Mac => Invocation { program: "/usr/bin/open".into(), args: vec![url.into()], raw: false },
        Os::Windows => Invocation {
            program: sysroot().join("System32").join("rundll32.exe"),
            args: vec!["url.dll,FileProtocolHandler".into(), url.into()],
            raw: false,
        },
        Os::Linux => Invocation { program: xdg_open(), args: vec![url.into()], raw: false },
    }
}

/// `abs` is canonical and inside the project root; `is_root` is true for the root itself.
pub fn reveal_invocation(os: Os, abs: &Path, is_root: bool) -> Result<Invocation, FsError> {
    let s = abs.to_string_lossy().into_owned();
    match os {
        Os::Mac => Ok(Invocation { program: "/usr/bin/open".into(), args: vec!["-R".into(), s], raw: false }),
        Os::Windows => {
            let p = plain_windows_path(&s);
            if p.contains('"') {
                return Err(herr("invalid_path", "path contains a forbidden character"));
            }
            Ok(Invocation { program: sysroot().join("explorer.exe"), args: vec![format!("/select,\"{p}\"")], raw: true })
        }
        Os::Linux => {
            let target = if is_root { abs } else { abs.parent().unwrap_or(abs) };
            Ok(Invocation { program: xdg_open(), args: vec![target.to_string_lossy().into_owned()], raw: false })
        }
    }
}

/// Starts the opener detached: scrubbed environment, no stdio, reaped on a thread. A failed
/// spawn is an error; the opener's own exit status is not awaited.
fn spawn(inv: &Invocation) -> Result<(), FsError> {
    let mut c = Command::new(&inv.program);
    c.env_clear().envs(crate::pty::scrubbed_env(std::env::vars())).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        if inv.raw {
            for a in &inv.args {
                c.raw_arg(a);
            }
        } else {
            c.args(&inv.args);
        }
    }
    #[cfg(not(windows))]
    c.args(&inv.args);
    let mut child = c.spawn().map_err(|_| herr("open_failed", "the system could not open it"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// ---- open_external_url --------------------------------------------------------------------

fn host_confirmed(key: &str) -> bool {
    CONFIRMED_HOSTS.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|s| s.contains(key))
}

fn remember_host(key: &str) {
    let mut g = CONFIRMED_HOSTS.lock().unwrap_or_else(|p| p.into_inner());
    let set = g.get_or_insert_with(HashSet::new);
    if set.len() >= CONFIRMED_MAX {
        set.clear();
    }
    set.insert(key.to_string());
}

/// The dialog body for a link: fixed wording, the host and the (truncated) full address.
pub(crate) fn url_dialog_text(c: &Checked) -> String {
    let shown: String = c.url.chars().take(300).collect();
    let ellipsis = if c.url.chars().count() > 300 { "..." } else { "" };
    format!(
        "LLM-IDE wants to open a link in your default app.\n\nSite: {}\nAddress: {shown}{ellipsis}\n\nOnly open it if you just clicked this link.",
        c.host_key
    )
}

/// Opens an http/https/mailto link with the OS. Returns `true` if it was opened, `false` if the
/// user declined the first-use dialog. Never opens an internal address.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<bool, FsError> {
    let checked = check_url(&url)?;
    if !URL_LIMIT.allow() {
        return Err(herr("rate_limited", "too many links opened"));
    }
    if !host_confirmed(&checked.host_key) {
        {
            let mut open = DIALOG_OPEN.lock().unwrap_or_else(|p| p.into_inner());
            if *open {
                return Err(herr("busy", "a confirmation is already open"));
            }
            *open = true;
        }
        let text = url_dialog_text(&checked);
        let yes = tauri::async_runtime::spawn_blocking(move || ask("Open link?", &text, "Open", false)).await;
        *DIALOG_OPEN.lock().unwrap_or_else(|p| p.into_inner()) = false;
        if !yes.map_err(|e| herr("io", format!("task failed: {e}")))? {
            return Ok(false);
        }
        remember_host(&checked.host_key);
    }
    spawn(&open_url_invocation(current_os(), &checked.url))?;
    Ok(true)
}

// ---- reveal_in_os -------------------------------------------------------------------------

/// Canonical path of `rel` inside `root` (existing entry), plus whether it is the root.
pub fn resolve_reveal(root: &Path, rel: &str) -> Result<(PathBuf, bool), FsError> {
    let abs = crate::fs_ops::resolve_existing(root, rel)?;
    Ok((abs.clone(), abs == root))
}

/// Shows a project entry in the OS file manager (Finder / Explorer / the parent folder).
#[tauri::command]
pub async fn reveal_in_os(rel_path: String) -> Result<(), FsError> {
    if !REVEAL_LIMIT.allow() {
        return Err(herr("rate_limited", "too many requests"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::fs_ops::active_root()?;
        let (abs, is_root) = resolve_reveal(&root, &rel_path)?;
        spawn(&reveal_invocation(current_os(), &abs, is_root)?)
    })
    .await
    .map_err(|e| herr("io", format!("task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(u: &str) -> Checked {
        check_url(u).unwrap_or_else(|e| panic!("{u}: {e:?}"))
    }
    fn bad(u: &str) {
        assert!(check_url(u).is_err(), "should refuse {u:?}");
    }

    #[test]
    fn accepts_public_http_https_and_mailto() {
        assert_eq!(ok("https://Example.com/a?b=c#d").host_key, "example.com");
        assert_eq!(ok("http://docs.rs/").url, "http://docs.rs/");
        assert_eq!(ok("https://8.8.8.8/").host_key, "8.8.8.8");
        assert_eq!(ok("https://[2606:4700:4700::1111]/").host_key, "2606:4700:4700::1111");
        assert_eq!(ok("https://example.com./").host_key, "example.com");
        assert_eq!(ok("mailto:a@example.com?subject=Hi&body=x").host_key, "mailto");
        // Non-ASCII hosts are shown and checked in their punycode form.
        assert!(ok("https://b\u{fc}cher.example.org/").host_key.starts_with("xn--"));
    }

    #[test]
    fn refuses_other_schemes_and_malformed_input() {
        for u in [
            "", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "ftp://example.com/", "vscode://x",
            "tel:123", "ssh://example.com", "//example.com/", "example.com", "https:///x", "https://",
            "https://example.com/ a", "https://exa mple.com/", "https://example.com/\n", "https://example.com/\t",
            "https://example.com\\@evil.com/", "https://example.com/\u{202E}x", "https://exa\u{200B}mple.com/",
            "\u{0}https://example.com/",
        ] {
            bad(u);
        }
        bad(&format!("https://example.com/{}", "a".repeat(URL_MAX_BYTES)));
    }

    #[test]
    fn refuses_userinfo() {
        bad("https://user@example.com/");
        bad("https://user:pw@example.com/");
        bad("https://paypal.com@evil.example/");
        bad("https://:@example.com/");
    }

    #[test]
    fn refuses_loopback_private_and_internal_hosts() {
        for u in [
            "http://localhost/", "http://LOCALHOST:3456/", "http://foo.localhost/", "http://localhost./",
            "http://127.0.0.1:3456/health", "http://127.1/", "http://0.0.0.0/", "http://10.0.0.1/",
            "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/", "http://224.0.0.1/", "http://255.255.255.255/", "http://240.0.0.1/", "http://192.0.2.1/",
            "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://017700000001/",
            "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd12:3456::1]/",
            "http://[ff02::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::127.0.0.1]/",
            "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://[2001:db8::1]/", "http://[2001::1]/",
            "http://intranet/", "http://router/", "http://printer.local/", "http://nas.lan/", "http://x.internal/",
            "http://x.home.arpa/", "http://corp/", "http://1.2.3.4.5/", "http://example.test/",
        ] {
            bad(u);
        }
    }

    #[test]
    fn public_ranges_next_to_blocked_ones_pass() {
        for u in ["http://172.15.0.1/", "http://172.32.0.1/", "http://100.63.0.1/", "http://100.128.0.1/", "http://11.0.0.1/"] {
            ok(u);
        }
        ok("http://[::ffff:8.8.8.8]/");
    }

    #[test]
    fn mailto_refuses_encoded_line_breaks() {
        for b in [
            "mailto:a@example.com?subject=x%0d%0aBcc:evil@example.com",
            "mailto:a@example.com?subject=x%0D%0ABcc:evil@example.com",
            "mailto:a@example.com%0abcc:evil@example.com",
            "mailto:a@example.com?body=line%0aline",
            "mailto:a@example.com?subject=x%00y",
        ] {
            bad(b);
        }
        ok("mailto:a@example.com?subject=100%25%20done");
    }

    #[test]
    fn service_mesh_and_vpn_names_are_not_public_sites() {
        for b in [
            "https://api.default.svc/", "https://redis.docker/", "https://foo.k8s/", "https://web.service.consul/", "https://host.tail1234.ts.net/",
            "https://a.b.cluster.local/", "https://x.default.svc.cluster.local/",
        ] {
            bad(b);
        }
        ok("https://example.com/");
        ok("https://svc.example.com/");
    }

    #[test]
    fn mailto_allows_only_plain_fields() {
        ok("mailto:a@example.com,b@example.com?cc=c@example.com&subject=x");
        bad("mailto:a@example.com?attach=/etc/passwd");
        bad("mailto:a@example.com?Attachment=/etc/passwd");
        bad("mailto:");
        bad("mailto:a@example.com?subject=x&foo=y");
    }

    #[test]
    fn dialog_text_shows_host_and_truncates_the_address() {
        let c = ok("https://example.com/path");
        let t = url_dialog_text(&c);
        assert!(t.contains("Site: example.com") && t.contains("Address: https://example.com/path"));
        let long = ok(&format!("https://example.com/{}", "a".repeat(600)));
        assert!(url_dialog_text(&long).contains("..."));
    }

    #[test]
    fn opener_invocations_are_fixed_and_shell_free() {
        let u = "https://example.com/a?b=1&c=2";
        let m = open_url_invocation(Os::Mac, u);
        assert_eq!((m.program.to_str(), m.args.as_slice(), m.raw), (Some("/usr/bin/open"), &[u.to_string()][..], false));
        let w = open_url_invocation(Os::Windows, u);
        assert!(w.program.ends_with("rundll32.exe") && w.program.to_string_lossy().contains("System32"));
        assert_eq!(w.args, vec!["url.dll,FileProtocolHandler".to_string(), u.to_string()]);
        let l = open_url_invocation(Os::Linux, u);
        assert!(l.program.to_string_lossy().ends_with("xdg-open") && l.program.is_absolute());
        assert_eq!(l.args, vec![u.to_string()]);
    }

    #[test]
    fn reveal_invocations_per_os() {
        let abs = Path::new("/p/src/main.rs");
        let m = reveal_invocation(Os::Mac, abs, false).unwrap();
        assert_eq!((m.program.to_str(), m.args), (Some("/usr/bin/open"), vec!["-R".to_string(), "/p/src/main.rs".to_string()]));
        let l = reveal_invocation(Os::Linux, abs, false).unwrap();
        assert_eq!(l.args, vec!["/p/src".to_string()], "Linux opens the parent folder, never the file");
        let lr = reveal_invocation(Os::Linux, Path::new("/p"), true).unwrap();
        assert_eq!(lr.args, vec!["/p".to_string()]);
        let w = reveal_invocation(Os::Windows, Path::new(r"\\?\C:\proj\a b.txt"), false).unwrap();
        assert!(w.raw && w.program.ends_with("explorer.exe"));
        assert_eq!(w.args, vec![r#"/select,"C:\proj\a b.txt""#.to_string()]);
        let wu = reveal_invocation(Os::Windows, Path::new(r"\\?\UNC\srv\share\x"), false).unwrap();
        assert_eq!(wu.args, vec![r#"/select,"\\srv\share\x""#.to_string()]);
        assert!(reveal_invocation(Os::Windows, Path::new(r#"C:\a"b"#), false).is_err());
    }

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("llmide-osopen-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(&p).unwrap()
    }

    #[test]
    fn reveal_is_confined_to_the_project_root() {
        let root = scratch("reveal");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/f.txt"), b"x").unwrap();
        let outside = scratch("reveal-outside");
        std::fs::write(outside.join("secret"), b"s").unwrap();

        let (p, is_root) = resolve_reveal(&root, "sub/f.txt").unwrap();
        assert_eq!((p, is_root), (root.join("sub/f.txt"), false));
        assert!(resolve_reveal(&root, "").unwrap().1, "empty path is the root");

        for bad in ["../x", "sub/../../x", "/etc/passwd", "sub//f.txt", "sub\\f.txt", "./sub", "sub/f.txt\0", "missing"] {
            assert!(resolve_reveal(&root, bad).is_err(), "{bad:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            std::os::unix::fs::symlink(outside.join("secret"), root.join("flink")).unwrap();
            assert_eq!(resolve_reveal(&root, "link").unwrap_err().code, "outside_root");
            assert_eq!(resolve_reveal(&root, "flink").unwrap_err().code, "outside_root");
            assert_eq!(resolve_reveal(&root, "link/secret").unwrap_err().code, "outside_root");
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
