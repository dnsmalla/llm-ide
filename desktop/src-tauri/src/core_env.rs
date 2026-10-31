//! The environment the Node core (and the `claude` probe) is started with.
//!
//! A packaged GUI app inherits a minimal environment (macOS Finder/Dock launch: PATH is
//! `/usr/bin:/bin:/usr/sbin:/sbin`; Windows: no shell profile), and a developer launch
//! inherits everything, including provider API keys. So the child gets `env_clear()` plus:
//! an allowlist of harmless system variables, the two host secrets (added by the caller),
//! the `LLMIDE_*` the server needs, and a PATH widened to the well-known `claude`
//! install dirs (the same list `extension/providers/claude-path.mjs` searches, so the
//! `#!/usr/bin/env node` shebang of an npm-installed `claude` can find a `node`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::fsutil::Os;

/// Exact names (compared case-insensitively on Windows, where env names are).
const ALLOWED: &[&str] = &[
    "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
    // Windows
    "SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "COMSPEC", "PATHEXT", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN",
    // Network: proxies and corporate CA bundles the Claude/Anthropic calls may need.
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    // The only LLMIDE_* taken from the host's own environment.
    "LLMIDE_CLAUDE_PATH", "LLMIDE_FEATURES",
];

fn is_allowed(name: &str, os: Os) -> bool {
    let n = if os == Os::Windows { name.to_ascii_uppercase() } else { name.to_string() };
    // Unix env names are case-sensitive, but proxy vars are conventionally spelled both ways.
    let n_up = n.to_ascii_uppercase();
    if name.starts_with("LC_") && os != Os::Windows {
        return true;
    }
    if ALLOWED.contains(&n.as_str()) {
        return true;
    }
    // Lower-case proxy spellings (`http_proxy`) on unix.
    os != Os::Windows
        && name == name.to_ascii_lowercase()
        && ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].contains(&n_up.as_str())
}

/// Allowlisted variables from `parent`, in order. `PATH` is handled by [`build_path`].
pub fn scrub(parent: &[(String, String)], os: Os) -> Vec<(String, String)> {
    parent
        .iter()
        .filter(|(k, v)| !v.is_empty() && !k.eq_ignore_ascii_case("PATH") && is_allowed(k, os))
        .cloned()
        .collect()
}

/// Mirror of `wellKnownDirs` in `extension/providers/claude-path.mjs`. Keep in step.
pub fn well_known_dirs(os: Os, get: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let var = |k: &str| get(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = var("HOME").or_else(|| var("USERPROFILE"));
    let mut out = Vec::new();
    if os == Os::Windows {
        if let Some(a) = var("APPDATA") {
            out.push(a.join("npm"));
        }
        if let Some(l) = var("LOCALAPPDATA") {
            out.push(l.join("Programs").join("claude"));
            out.push(l.join("Programs"));
        }
        if let Some(h) = &home {
            out.push(h.join(".local").join("bin"));
        }
        return out;
    }
    let Some(home) = home else { return out };
    out.push(home.join(".claude").join("local"));
    out.push(home.join(".local").join("bin"));
    if os == Os::Mac {
        out.push(PathBuf::from("/opt/homebrew/bin"));
    }
    out.push(PathBuf::from("/usr/local/bin"));
    out.push(home.join(".npm-global").join("bin"));
    let nvm = home.join(".nvm").join("versions").join("node");
    if let Ok(rd) = std::fs::read_dir(&nvm) {
        let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
        vers.sort();
        vers.reverse();
        out.extend(vers);
    }
    out
}

/// PATH for the child: the host's own PATH, the well-known `claude` dirs, the OS system
/// dirs, then the bundled node's dir LAST (the user's own `node` wins for an npm-installed
/// `claude`; ours is only the fallback). Relative entries are dropped, duplicates removed.
pub fn build_path(
    os: Os,
    parent_path: &str,
    get: &dyn Fn(&str) -> Option<String>,
    bundled_node_dir: Option<&Path>,
) -> OsString {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(parent_path).collect();
    dirs.extend(well_known_dirs(os, get));
    if os != Os::Windows {
        for d in ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            dirs.push(PathBuf::from(d));
        }
    }
    if let Some(d) = bundled_node_dir {
        dirs.push(d.to_path_buf());
    }
    let mut seen = std::collections::HashSet::new();
    let kept: Vec<PathBuf> = dirs.into_iter().filter(|d| d.is_absolute() && seen.insert(d.clone())).collect();
    std::env::join_paths(kept).unwrap_or_default()
}

/// Origins of the packaged webview: macOS/Linux `tauri://localhost`, Windows `http(s)://tauri.localhost`.
/// Exactly these, never `*`, never a dev server (5173 stays out of the release build).
pub const WEBVIEW_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// `LLMIDE_CORS_ORIGINS` for the core THIS APP SPAWNED. Set only in `core_host::real_launch` (the spawn
/// path), after the nonce handshake design: an adopted server is never launched by us and keeps its own
/// env, and `scrub` never copies the variable from the host's environment, so nothing else can widen it.
pub fn spawned_core_cors_origins() -> String {
    WEBVIEW_ORIGINS.join(",")
}

/// The full environment for a core child, secrets excluded (the caller adds them).
pub fn core_env(
    os: Os,
    parent: &[(String, String)],
    bundled_node_dir: Option<&Path>,
) -> (Vec<(String, String)>, OsString) {
    let get = |k: &str| parent.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let parent_path = parent
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    (scrub(parent, os), build_path(os, &parent_path, &get, bundled_node_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn scrub_keeps_only_the_allowlist() {
        let parent = kv(&[
            ("HOME", "/Users/a"), ("LANG", "en_US.UTF-8"), ("LC_ALL", "C"), ("https_proxy", "http://p:1"),
            ("LLMIDE_CLAUDE_PATH", "/x/claude"), ("LLMIDE_FEATURES", "agent_chat"),
            ("ANTHROPIC_API_KEY", "sk-1"), ("OPENAI_API_KEY", "sk-2"), ("LLMIDE_JWT_SECRET", "j"),
            ("LLMIDE_DB_PATH", "/live/kb/data.db"), ("LLMIDE_DATA_DIR", "/live"), ("LLMIDE_CORE_NONCE", "n"),
            ("NODE_OPTIONS", "--require /evil.js"), ("MEETNOTES_X", "1"), ("GITHUB_TOKEN", "t"),
            ("AWS_SECRET_ACCESS_KEY", "a"), ("PATH", "/usr/bin"), ("EMPTY", ""),
        ]);
        let out: Vec<String> = scrub(&parent, Os::Mac).into_iter().map(|(k, _)| k).collect();
        assert_eq!(out, ["HOME", "LANG", "LC_ALL", "https_proxy", "LLMIDE_CLAUDE_PATH", "LLMIDE_FEATURES"]);
    }

    #[test]
    fn scrub_windows_names_are_case_insensitive() {
        let parent = kv(&[("SystemRoot", "C:\\Windows"), ("LocalAppData", "C:\\L"), ("Path", "C:\\x"), ("NODE_OPTIONS", "x")]);
        let out: Vec<String> = scrub(&parent, Os::Windows).into_iter().map(|(k, _)| k).collect();
        assert_eq!(out, ["SystemRoot", "LocalAppData"]);
    }

    #[cfg(unix)]
    #[test]
    fn path_is_widened_deduped_absolute_only_and_bundled_node_last() {
        let get = |k: &str| (k == "HOME").then(|| "/Users/a".to_string());
        let p = build_path(Os::Mac, "/usr/bin:/bin:relative/bin:/usr/bin", &get, Some(Path::new("/App/core/node")));
        let dirs: Vec<PathBuf> = std::env::split_paths(&p).collect();
        let s: Vec<&str> = dirs.iter().map(|d| d.to_str().unwrap()).collect();
        assert_eq!(&s[..2], ["/usr/bin", "/bin"]);
        assert!(s.contains(&"/Users/a/.local/bin") && s.contains(&"/Users/a/.claude/local"));
        assert!(s.contains(&"/opt/homebrew/bin") && s.contains(&"/usr/local/bin"));
        assert!(!s.contains(&"relative/bin"));
        assert_eq!(s.iter().filter(|d| **d == "/usr/bin").count(), 1);
        assert_eq!(*s.last().unwrap(), "/App/core/node");
    }

    #[cfg(unix)]
    #[test]
    fn well_known_dirs_match_claude_path_mjs_per_os() {
        let linux = well_known_dirs(Os::Linux, &|k| (k == "HOME").then(|| "/home/a".to_string()));
        assert!(linux.contains(&PathBuf::from("/home/a/.npm-global/bin")));
        assert!(!linux.contains(&PathBuf::from("/opt/homebrew/bin")));
        let win = well_known_dirs(Os::Windows, &|k| match k {
            "APPDATA" => Some("C:\\A".into()),
            "LOCALAPPDATA" => Some("C:\\L".into()),
            "USERPROFILE" => Some("C:\\U".into()),
            _ => None,
        });
        assert_eq!(win.len(), 4);
        assert!(win[0].ends_with("npm") && win[1].ends_with("claude"));
    }

    #[test]
    fn cors_origins_are_exactly_the_webview_origins_and_never_inherited() {
        let v = spawned_core_cors_origins();
        assert_eq!(v, "tauri://localhost,http://tauri.localhost,https://tauri.localhost");
        assert!(!v.contains('*') && !v.contains("5173") && !v.contains("127.0.0.1"));
        // the host's own environment cannot inject or widen it
        let parent = kv(&[("LLMIDE_CORS_ORIGINS", "*"), ("HOME", "/h")]);
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            assert!(scrub(&parent, os).iter().all(|(k, _)| k != "LLMIDE_CORS_ORIGINS"));
        }
        let (env, _) = core_env(Os::Mac, &parent, None);
        assert!(env.iter().all(|(k, _)| k != "LLMIDE_CORS_ORIGINS"));
    }

    #[cfg(unix)]
    #[test]
    fn core_env_never_contains_secrets_or_path_entries_twice() {
        let parent = kv(&[("PATH", "/usr/bin"), ("ANTHROPIC_API_KEY", "x"), ("HOME", "/h")]);
        let (env, path) = core_env(Os::Linux, &parent, None);
        assert!(env.iter().all(|(k, _)| k != "ANTHROPIC_API_KEY" && k != "PATH"));
        assert!(path.to_string_lossy().starts_with("/usr/bin"));
    }
}
