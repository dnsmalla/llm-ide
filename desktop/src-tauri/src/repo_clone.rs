//! Clone one saved repository into the active project's `code/` folder, optionally authenticating with a token the
//! user pasted into Settings. The token lives only in this child process's environment (git's `GIT_CONFIG_*` pair),
//! never in argv or `.git/config` — the same rule the Mac's RepoManager follows.
//!
//! The webview supplies a provider + repository URL (owner/repo or an https URL) and an optional token; the
//! destination is host-chosen under the active project's `code/`, so a page can never write elsewhere.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub path: String,
    pub name: String,
}

/// `owner/repo` (GitHub shorthand) or an https GitHub/GitLab URL, stripped to owner/repo. Rejects path shapes.
pub fn parse_repo(raw: &str) -> Option<(String, String)> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 500 || t.chars().any(|c| c.is_control()) {
        return None;
    }
    let rest = if let Some(r) = t.strip_prefix("https://github.com/").or_else(|| t.strip_prefix("https://gitlab.com/")) {
        r
    } else if t.starts_with("http://") || t.starts_with("https://") || t.contains(' ') {
        return None;
    } else {
        t
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    let ok = |s: &str| {
        s.len() <= 100
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    (ok(owner) && ok(repo)).then(|| (owner.to_string(), repo.to_string()))
}

/// The clone URL for a provider (always https, `.git` suffix).
pub fn remote_url(provider: &str, owner: &str, repo: &str) -> String {
    let host = if provider == "gitlab" { "gitlab.com" } else { "github.com" };
    format!("https://{host}/{owner}/{repo}.git")
}

/// The folder name inside `code/`: the repository name, never a path.
pub fn folder_name(_owner: &str, repo: &str) -> Option<String> {
    let name = repo.trim();
    (!name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) && name != "." && name != "..")
        .then(|| name.to_string())
}

/// Minimal base64 for the GitHub Basic header (`x-access-token:<token>`); no external dependency.
pub fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        out.push(T[(b[0] >> 2) as usize] as char);
        out.push(T[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { T[(((b[1] & 0x0f) << 2) | (b[2] >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(b[2] & 0x3f) as usize] as char } else { '=' });
    }
    out
}

/// `http.<scope>.extraHeader` + value for one provider/token; empty when no token.
pub fn auth_config(provider: &str, token: Option<&str>) -> (String, String) {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else { return (String::new(), String::new()) };
    // Git's key is `http.<url>.<variable>`: `http.https://github.com.extraHeader`.
    let scope = if provider == "gitlab" { "https://gitlab.com" } else { "https://github.com" };
    let key = format!("http.{scope}.extraHeader");
    let value = if provider == "gitlab" {
        format!("PRIVATE-TOKEN: {token}")
    } else {
        format!("Authorization: Basic {}", base64(format!("x-access-token:{token}").as_bytes()))
    };
    (key, value)
}

fn code_dir(root: &Path) -> PathBuf {
    root.join("code")
}

/// The destination `code/<repo>`; refuses an existing path and any name that is not one plain component.
pub fn destination(root: &Path, name: &str) -> Result<PathBuf, String> {
    let name = folder_name("", name).ok_or_else(|| "invalid repository name".to_string())?;
    let dest = code_dir(root).join(&name);
    if dest.exists() {
        return Err(format!("code/{name} already exists"));
    }
    Ok(dest)
}

#[tauri::command]
pub async fn repo_clone(provider: String, url: String, token: Option<String>, folder: Option<String>) -> Result<CloneResult, String> {
    if provider != "github" && provider != "gitlab" {
        return Err("provider must be github or gitlab".into());
    }
    let (owner, repo) = parse_repo(&url).ok_or_else(|| "enter owner/repo or an https GitHub/GitLab repository URL".to_string())?;
    let name = match folder.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) => folder_name("", f).ok_or_else(|| "invalid folder name".to_string())?,
        None => folder_name(&owner, &repo).ok_or_else(|| "invalid repository name".to_string())?,
    };
    let root = crate::project::active_root().ok_or_else(|| "open a project before cloning a repository".to_string())?;
    if crate::fs_ops::checked_root(&root).is_err() {
        return Err("the project folder is not usable".into());
    }
    let dest = destination(&root, &name)?;
    let remote = remote_url(&provider, &owner, &repo);
    let token = token.filter(|t| !t.trim().is_empty() && t.len() <= 512 && !t.chars().any(|c| c.is_control()));
    let dest_for_task = dest.clone();
    tauri::async_runtime::spawn_blocking(move || clone_into(&remote, &dest_for_task, &provider, token.as_deref()))
        .await
        .map_err(|e| format!("clone task failed: {e}"))?
        .map(|_| CloneResult { path: dest.to_string_lossy().into_owned(), name })
}

fn clone_into(remote: &str, dest: &Path, provider: &str, token: Option<&str>) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create code/: {e}"))?;
    }
    let mut cmd = Command::new("git");
    cmd.arg("clone").arg("--").arg(remote).arg(dest)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/usr/bin/true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let (key, value) = auth_config(provider, token);
    if !key.is_empty() {
        cmd.env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", key).env("GIT_CONFIG_VALUE_0", value);
    }
    let out = cmd.output().map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let msg: String = err.chars().filter(|c| !c.is_control()).take(400).collect();
    Err(if msg.trim().is_empty() { "git clone failed".into() } else { format!("git clone failed: {msg}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_shapes_are_parsed_strictly() {
        assert_eq!(parse_repo("owner/repo"), Some(("owner".into(), "repo".into())));
        assert_eq!(parse_repo("https://github.com/owner/repo.git"), Some(("owner".into(), "repo".into())));
        assert_eq!(parse_repo("https://gitlab.com/group/repo/"), Some(("group".into(), "repo".into())));
        for bad in ["", "https://evil.com/o/r", "../r", "a/b/c", "a b/c", "https://github.com/o"] {
            assert_eq!(parse_repo(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_folder_is_one_plain_component_and_destinations_never_exist_twice() {
        assert_eq!(folder_name("o", "repo"), Some("repo".into()));
        assert_eq!(folder_name("o", ".."), None);
        assert_eq!(folder_name("o", "a/b"), None);
        let root = std::env::temp_dir().join(format!("llmide-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("code/repo")).unwrap();
        assert!(destination(&root, "repo").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clone_into_a_local_repository_copies_the_worktree() {
        let base = std::env::temp_dir().join(format!("llmide-clone-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").args(["-c", "user.name=Test", "-c", "user.email=t@example.com"]).args(args).current_dir(&base).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        run(&["init", "-q"]);
        std::fs::write(base.join("README.md"), "hello").unwrap();
        run(&["add", "README.md"]);
        run(&["commit", "-qm", "first"]);
        let dest = base.join("dest");
        clone_into(base.to_str().unwrap(), &dest, "github", None).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("README.md")).unwrap(), "hello");
        // A token must produce a VALID GIT_CONFIG_KEY_0 even when the local remote needs no auth.
        let dest2 = base.join("dest2");
        clone_into(base.to_str().unwrap(), &dest2, "github", Some("tok")).unwrap();
        assert_eq!(std::fs::read_to_string(dest2.join("README.md")).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn auth_headers_are_provider_specific_and_never_in_argv() {
        let (k, v) = auth_config("github", Some("tok"));
        assert_eq!(k, "http.https://github.com.extraHeader");
        assert_eq!(v, "Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9r");
        let (k2, v2) = auth_config("gitlab", Some("glpat"));
        assert_eq!(k2, "http.https://gitlab.com.extraHeader");
        assert_eq!(v2, "PRIVATE-TOKEN: glpat");
        assert_eq!(auth_config("github", None), (String::new(), String::new()));
        assert_eq!(base64(b"x-access-token:tok"), "eC1hY2Nlc3MtdG9rZW46dG9r");
    }
}
