//! Adopting a clone that is already in `code/`. A saved repository can lose its recorded clone path (it was removed
//! and added again), and a fresh clone then fails with "already exists". When the folder there is a git clone of the
//! same repository, the desktop records it instead of refusing. A folder holding anything else is still refused.

use std::path::Path;
use std::process::{Command, Stdio};

use super::clone::{parse_repo, target_name, CloneRequest, CloneResult};

/// The existing `code/<name>` clone of the requested repository, or `None` when there is none or it is another
/// repository. Reads only the folder's `remote.origin.url`; runs no hook and never touches the network.
pub fn adopt_existing(root: &Path, req: &CloneRequest, git: &Path) -> Option<CloneResult> {
    let host = provider_host(&req.provider)?;
    let repo_ref = parse_repo(&req.url, &req.provider)?;
    let name = target_name(req, &repo_ref).ok()?;
    // `code` itself may be a link out of the project: look at nothing (not even with git, read-only) beyond the root.
    crate::fs::ensure_writable_inside(root, "code").ok()?;
    let dest = root.join("code").join(&name);
    // A symlink could point the recorded path outside the project; only real directories are adopted, `code/<name>`
    // and its `.git` alike (a `.git` file names a git dir elsewhere), and the folder must resolve inside the root.
    let is_real_dir = |p: &Path| std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false);
    let git_dir = dest.join(".git");
    if !is_real_dir(&dest) || !is_real_dir(&git_dir) {
        return None;
    }
    // `git clone` writes the index last, so a missing one means the checkout failed half-way. A clone of an empty
    // repository has no index either, but also no commit, so only an index-less clone WITH a commit is refused.
    let has_index = std::fs::symlink_metadata(git_dir.join("index")).map(|m| m.is_file()).unwrap_or(false);
    if !has_index && has_commit(&git_dir, git) {
        return None;
    }
    let inside = match (dest.canonicalize(), root.canonicalize()) {
        (Ok(d), Ok(r)) => d.starts_with(r),
        _ => false,
    };
    if !inside {
        return None;
    }
    let origin = origin_url(&git_dir, git)?;
    let (origin_host, origin_path) = split_remote(&origin)?;
    let same = origin_host.eq_ignore_ascii_case(host) && origin_path.eq_ignore_ascii_case(&repo_ref.path);
    same.then(|| CloneResult { path: dest.to_string_lossy().into_owned(), name })
}

fn provider_host(provider: &str) -> Option<&'static str> {
    match provider {
        "github" => Some("github.com"),
        "gitlab" => Some("gitlab.com"),
        _ => None,
    }
}

/// The `remote.origin.url` of exactly `git_dir`'s own config; `None` when git fails or there is no origin. The git
/// dir is pinned and the environment cleared, so a broken `.git` never makes git walk up to a parent repository and
/// no inherited `GIT_DIR` / `GIT_CONFIG_*` can redirect the read.
fn origin_url(git_dir: &Path, git: &Path) -> Option<String> {
    let out = Command::new(git)
        .arg("--git-dir")
        .arg(git_dir)
        .args(["config", "--local", "--get", "remote.origin.url"])
        .env_clear()
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(git_dir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let url = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !url.is_empty()).then_some(url)
}

/// Whether `git_dir`'s HEAD names a commit; pinned and env-cleared like `origin_url`. A git failure counts as a commit,
/// so an unreadable repository is never adopted without an index.
fn has_commit(git_dir: &Path, git: &Path) -> bool {
    Command::new(git)
        .arg("--git-dir")
        .arg(git_dir)
        .args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
        .env_clear()
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(git_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success() || s.code() != Some(1))
        .unwrap_or(true)
}

/// The host and repository path of a remote: `https://[user@]host/path`, `ssh://[user@]host[:port]/path` or
/// `user@host:path`. The path loses a trailing `/` and `.git`.
fn split_remote(url: &str) -> Option<(String, String)> {
    let (host, path) = if let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("ssh://")) {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        (host.split(':').next()?, path)
    } else if !url.contains("://") {
        let (authority, path) = url.split_once(':')?;
        (authority.rsplit('@').next()?, path)
    } else {
        return None;
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_matches('/');
    (!host.is_empty() && !path.is_empty()).then(|| (host.to_string(), path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: &str, url: &str) -> CloneRequest {
        CloneRequest { provider: provider.into(), url: url.into(), token: None, folder: None, grant: None }
    }

    /// A project root holding `code/<name>` as a git repository whose origin is `origin`.
    fn project_with_clone(tag: &str, name: &str, origin: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("llmide-adopt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dest = root.join("code").join(name);
        std::fs::create_dir_all(&dest).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dest).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", origin]);
        root
    }

    fn git() -> std::path::PathBuf {
        crate::git::git_binary().expect("git on PATH")
    }

    #[test]
    fn split_remote_reads_https_ssh_and_scp_forms() {
        let want = Some(("gitlab.com".to_string(), "group/sub/proj".to_string()));
        assert_eq!(split_remote("https://gitlab.com/group/sub/proj.git"), want);
        assert_eq!(split_remote("https://oauth2@gitlab.com/group/sub/proj/"), want);
        assert_eq!(split_remote("ssh://git@gitlab.com:22/group/sub/proj.git"), want);
        assert_eq!(split_remote("git@gitlab.com:group/sub/proj.git"), want);
        assert_eq!(split_remote("file:///tmp/repo"), None);
        assert_eq!(split_remote("https://gitlab.com"), None);
        // Look-alike hosts keep their real host, so the provider check rejects them.
        assert_eq!(split_remote("https://gitlab.com.evil.com/g/p").map(|r| r.0), Some("gitlab.com.evil.com".into()));
        assert_eq!(split_remote("https://gitlab.com@evil.com/g/p").map(|r| r.0), Some("evil.com".into()));
        assert_eq!(split_remote("https://evil.com/@gitlab.com/g/p").map(|r| r.0), Some("evil.com".into()));
        assert_eq!(split_remote("git@evil:gitlab.com/g/p").map(|r| r.0), Some("evil".into()));
    }

    #[cfg(unix)]
    #[test]
    fn adopt_existing_ignores_a_code_link_that_leaves_the_root() {
        let root = project_with_clone("codelink", "app", "https://github.com/o/app.git");
        let outside = std::env::temp_dir().join(format!("llmide-adopt-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::rename(root.join("code"), outside.join("code")).unwrap();
        std::os::unix::fs::symlink(outside.join("code"), root.join("code")).unwrap();
        assert_eq!(adopt_existing(&root, &request("github", "o/app"), &git()), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn refuses_a_clone_whose_checkout_never_finished() {
        let root = project_with_clone("noindex", "app", "https://github.com/o/app.git");
        let dest = root.join("code").join("app");
        let out = Command::new("git")
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"])
            .current_dir(&dest)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(adopt_existing(&root, &request("github", "o/app"), &git()).is_some(), "a healthy clone is adopted");
        std::fs::remove_file(dest.join(".git").join("index")).unwrap();
        assert_eq!(adopt_existing(&root, &request("github", "o/app"), &git()), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn adopts_a_clone_of_an_empty_repository_without_an_index() {
        let root = project_with_clone("emptyrepo", "app", "https://github.com/o/app.git");
        assert!(!root.join("code").join("app").join(".git").join("index").exists());
        assert!(adopt_existing(&root, &request("github", "o/app"), &git()).is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn adopts_a_nested_gitlab_group_and_a_custom_folder() {
        let root = project_with_clone("nested", "mine", "https://gitlab.com/a/b/c.git");
        let mut req = request("gitlab", "a/b/c");
        req.folder = Some("mine".into());
        assert_eq!(adopt_existing(&root, &req, &git()).map(|r| r.name), Some("mine".into()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_broken_git_dir_never_reads_the_parent_repository() {
        // The project root is itself a clone of the same repository; code/app has an empty `.git`.
        let root = project_with_clone("broken", "unused", "https://github.com/o/app.git");
        let parent = |args: &[&str]| Command::new("git").args(args).current_dir(&root).output().unwrap();
        parent(&["init", "-q"]);
        parent(&["remote", "add", "origin", "https://github.com/o/app.git"]);
        std::fs::create_dir_all(root.join("code/app/.git")).unwrap();
        assert_eq!(adopt_existing(&root, &request("github", "o/app"), &git()), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_git_file_pointing_elsewhere() {
        let real = project_with_clone("gitfile-target", "app", "https://github.com/o/app.git");
        let root = std::env::temp_dir().join(format!("llmide-adopt-gitfile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("code/app")).unwrap();
        std::fs::write(root.join("code/app/.git"), format!("gitdir: {}\n", real.join("code/app/.git").display())).unwrap();
        assert_eq!(adopt_existing(&root, &request("github", "o/app"), &git()), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn adopts_a_clone_of_the_same_repository() {
        let root = project_with_clone("same", "smart-input", "git@gitlab.com:Grid/Smart-Input.git");
        let got = adopt_existing(&root, &request("gitlab", "https://gitlab.com/grid/smart-input"), &git());
        let dest = root.join("code/smart-input");
        assert_eq!(got, Some(CloneResult { path: dest.to_string_lossy().into_owned(), name: "smart-input".into() }));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_another_repository_or_host() {
        let root = project_with_clone("other", "app", "https://gitlab.com/someone/app.git");
        assert_eq!(adopt_existing(&root, &request("gitlab", "grid/app"), &git()), None);
        // Same path on the other provider's host is a different repository.
        assert_eq!(adopt_existing(&root, &request("github", "someone/app"), &git()), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_plain_folder_or_a_missing_one() {
        let root = std::env::temp_dir().join(format!("llmide-adopt-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("code/app")).unwrap();
        assert_eq!(adopt_existing(&root, &request("github", "o/app"), &git()), None);
        assert_eq!(adopt_existing(&root, &request("github", "o/missing"), &git()), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_folder() {
        let real = project_with_clone("link-target", "app", "https://github.com/o/app.git");
        let root = std::env::temp_dir().join(format!("llmide-adopt-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("code")).unwrap();
        std::os::unix::fs::symlink(real.join("code/app"), root.join("code/app")).unwrap();
        assert_eq!(adopt_existing(&root, &request("github", "o/app"), &git()), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&real);
    }
}
