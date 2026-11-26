//! Strict ALLOWLIST check of a repository's git config (untrusted: a cloned project, or
//! anything a compromised webview could have written).
//!
//! The previous scanner was a line-based denylist and had holes (a UTF-8 BOM, invalid UTF-8
//! read as empty, dotted `[filter.x]` subsections, `config.worktree`). This parser is the
//! opposite: it refuses the file unless EVERY byte is understood, and only a small set of
//! plain-data keys is accepted. Anything that can name a program (`core.fsmonitor`,
//! `core.hooksPath`, `filter.*`, `diff.*.textconv`, `merge.*.driver`, `credential.*`,
//! `alias.*`, `include*`, `url.*.insteadOf`, `submodule.*.update`, `protocol.*`, `http.*`,
//! `gpg.*`, `extensions.*`, `core.worktree`, ...) is simply not in the table.

/// Largest config file we will look at.
pub const MAX_CONFIG_BYTES: usize = 256 * 1024;

/// (section, subsection allowed, accepted keys). Keys and sections are compared lower-case.
const ALLOWED: &[(&str, bool, &[&str])] = &[
    (
        "core",
        false,
        &[
            "repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks",
            "autocrlf", "eol", "safecrlf", "longpaths", "sparsecheckout", "sparsecheckoutcone", "quotepath", "whitespace",
            "trustctime", "checkstat", "protecthfs", "protectntfs", "abbrev", "commentchar", "untrackedcache",
            // Husky and other hook managers write this into most JavaScript repositories. It names a folder of
            // programs, but it can never take effect here: the runner passes `-c core.hooksPath=<null device>` on
            // every call (`git::base_args`), and a command-line value always wins over the repository's. Refusing
            // the whole repository over a key that is already switched off locked Source Control for no gain.
            "hookspath",
        ],
    ),
    // `worktreeconfig` makes git also read `config.worktree`. That is safe only because `git::check_git_dir` scans
    // `config.worktree` through this same allowlist for every git dir it validates (the repo's own, the linked
    // worktree's and the common one), whether or not the key is set. Do not add a path that skips that scan.
    ("extensions", false, &["objectformat", "worktreeconfig"]),
    ("user", false, &["name", "email"]),
    ("remote", true, &["url", "pushurl", "fetch", "push", "tagopt", "prune", "prunetags"]),
    // `vscode-merge-base` is a branch name VS Code records; plain data.
    ("branch", true, &["remote", "merge", "rebase", "description", "pushremote", "vscode-merge-base"]),
    // Plain data. `[merge "<driver>"]` (a subsection, which can name a program) stays refused.
    ("merge", false, &["conflictstyle", "ff"]),
    ("rerere", false, &["enabled", "autoupdate"]),
    ("submodule", true, &["url", "active"]),
    ("pull", false, &["rebase", "ff"]),
    ("push", false, &["default", "autosetupremote"]),
    ("fetch", false, &["prune"]),
    ("init", false, &["defaultbranch"]),
    ("commit", false, &["gpgsign"]),
    // Plain data git-lfs writes; git never reads `lfs.*`, and the program-running half (`filter.lfs.*`) stays refused.
    ("lfs", false, &["repositoryformatversion"]),
    ("lfs", true, &["access", "locksverify"]),
    // LLM-IDE's own Factory ship records `factory.patchid-<commit> = <sha256>` (the reviewed diff's id) in the shared
    // config. Git never reads [factory]; its lines are judged by `factory_patch_id_line`, never by a key list.
    ("factory", false, &[]),
];

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `patchid-<40 or 64 lowercase hex> = <64 lowercase hex>` and nothing else (no quotes, comments or other text).
fn factory_patch_id_line(line: &str) -> bool {
    let Some((key, value)) = line.split_once('=') else { return false };
    let Some(commit) = key.trim().strip_prefix("patchid-") else { return false };
    (is_lower_hex(commit, 40) || is_lower_hex(commit, 64)) && is_lower_hex(value.trim(), 64)
}

fn key_ok(k: &str) -> bool {
    let mut cs = k.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_alphabetic()) && cs.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Parses `[name]` or `[name "sub"]` at the start of `line` (which starts with `[`).
/// Returns (name, subsection, rest-of-line).
fn parse_header(line: &str) -> Result<(String, Option<String>, &str), String> {
    let body = &line[1..];
    let name_end = body.find(|c: char| c == ']' || c.is_whitespace()).ok_or("unterminated section header")?;
    let name = &body[..name_end];
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        // Includes dotted `[filter.x]` / `[includeif.gitdir:/]` sections.
        return Err(format!("unsupported section name [{name}"));
    }
    let after = &body[name_end..];
    if let Some(rest) = after.strip_prefix(']') {
        return Ok((name.to_ascii_lowercase(), None, rest));
    }
    let q = after.trim_start().strip_prefix('"').ok_or("malformed section header")?;
    let mut sub = String::new();
    let mut it = q.char_indices();
    while let Some((i, c)) = it.next() {
        match c {
            '\\' => match it.next() {
                Some((_, e)) if e != '\n' => sub.push(e),
                _ => return Err("bad escape in section header".into()),
            },
            '"' => {
                let rest = q[i + 1..].strip_prefix(']').ok_or("malformed section header")?;
                return Ok((name.to_ascii_lowercase(), Some(sub), rest));
            }
            c => sub.push(c),
        }
    }
    Err("unterminated subsection".into())
}

/// Checks one `key [= value]` line; returns the raw value when the key is `core.worktree`
/// (only reachable when `allow_worktree`).
fn check_key_line(section: &(String, bool), line: &str, allow_worktree: bool) -> Result<Option<String>, String> {
    let key = line.split(['=', ' ', '\t']).next().unwrap_or("");
    if !key_ok(key) {
        return Err(format!("unsupported line {line:.40}"));
    }
    let lk = key.to_ascii_lowercase();
    if section.0 == "factory" {
        return if !section.1 && factory_patch_id_line(line) {
            Ok(None)
        } else {
            Err("[factory] may hold only factory.patchid-<commit> = <sha256> records".into())
        };
    }
    // A section may carry one rule per form (with and without a subsection); prefer the one matching this header.
    let rule = ALLOWED.iter().find(|(n, s, _)| *n == section.0 && *s == section.1).or_else(|| ALLOWED.iter().find(|(n, _, _)| *n == section.0));
    let Some((_, sub_ok, keys)) = rule else {
        return Err(format!("section [{}] is not allowed", section.0));
    };
    if section.1 && !sub_ok {
        return Err(format!("subsection of [{}] is not allowed", section.0));
    }
    if !sub_ok && section.1 {
        return Err("subsection not allowed".into());
    }
    if *sub_ok && !section.1 {
        return Err(format!("[{}] needs a subsection", section.0));
    }
    if allow_worktree && section.0 == "core" && lk == "worktree" {
        let v = line.split_once('=').map_or("", |(_, v)| v).trim().trim_matches('"').to_string();
        return Ok(Some(v));
    }
    if !keys.contains(&lk.as_str()) {
        return Err(format!("{}.{} is not an allowed setting", section.0, lk));
    }
    Ok(None)
}

/// `bytes` without the settings a local Git LFS setup writes (`git lfs install --local`, a custom `lfs.url`), for a
/// caller that works in LFS repositories. Only the exact standard commands are dropped: they run the user's own
/// `git-lfs`, as a global install would. The `[filter "lfs"]` header becomes `[lfs]`, so any other line under it
/// (a different program) is still judged, and refused, by `check_config_ex`.
pub fn without_standard_lfs(bytes: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else { return bytes.to_vec() };
    let mut out = String::with_capacity(text.len());
    let mut section: Option<(String, Option<String>)> = None;
    for raw in text.split('\n') {
        let line = raw.trim_matches(|c: char| c == ' ' || c == '\t' || c == '\r');
        if line.starts_with('[') {
            section = None;
            if let Ok((name, sub, rest)) = parse_header(line) {
                let plain_filter_lfs = name == "filter" && sub.as_deref() == Some("lfs") && rest.trim().is_empty();
                section = Some((name, sub));
                if plain_filter_lfs {
                    out.push_str("[lfs]\n");
                    continue;
                }
            }
        } else if let Some((name, sub)) = &section {
            let (key, value) = line.split_once('=').map_or((String::new(), ""), |(k, v)| (k.trim().to_ascii_lowercase(), v.trim().trim_matches('"')));
            let standard = match (name.as_str(), sub.as_deref()) {
                ("filter", Some("lfs")) => matches!(
                    (key.as_str(), value),
                    ("clean", "git-lfs clean -- %f")
                        | ("smudge", "git-lfs smudge -- %f" | "git-lfs smudge --skip -- %f")
                        | ("process", "git-lfs filter-process" | "git-lfs filter-process --skip")
                        | ("required", "true" | "false")
                ),
                ("lfs", None) => key == "url" && !value.is_empty() && !value.ends_with('\\'),
                _ => false,
            };
            if standard {
                continue;
            }
        }
        out.push_str(raw);
        out.push('\n');
    }
    out.into_bytes()
}

/// `Ok(())` only when `bytes` is a config made solely of allowed, plain-data settings.
#[allow(dead_code)] // the unit tests and external callers use the strict form without a worktree allowance
pub fn check_config(bytes: &[u8]) -> Result<(), String> {
    check_config_ex(bytes, false).map(|_| ())
}

/// Like `check_config`; with `allow_worktree` a `core.worktree` value is tolerated and returned
/// (the caller must verify it points at the project; a submodule's git dir carries one).
pub fn check_config_ex(bytes: &[u8], allow_worktree: bool) -> Result<Option<String>, String> {
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("git config is unusually large".into());
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err("git config starts with a byte-order mark".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "git config is not valid UTF-8".to_string())?;
    if text.contains('\0') {
        return Err("git config contains a NUL byte".into());
    }
    let normalised = text.replace("\r\n", "\n");
    if normalised.contains('\r') {
        return Err("git config contains a bare carriage return".into());
    }
    let mut section: Option<(String, bool)> = None;
    let mut worktree = None;
    for raw in normalised.split('\n') {
        let line = raw.trim_matches(|c: char| c == ' ' || c == '\t');
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        // A trailing backslash continues the value on the next line and could hide a header.
        if line.ends_with('\\') {
            return Err("git config uses a line continuation".into());
        }
        let mut rest = line;
        if line.starts_with('[') {
            let (name, sub, r) = parse_header(line)?;
            if !ALLOWED.iter().any(|(n, _, _)| *n == name) {
                return Err(format!("section [{name}] is not allowed"));
            }
            section = Some((name, sub.is_some()));
            rest = r.trim_matches(|c: char| c == ' ' || c == '\t');
            if rest.is_empty() || rest.starts_with('#') || rest.starts_with(';') {
                continue;
            }
            if rest.starts_with('[') {
                return Err("several sections on one line".into());
            }
        }
        let Some(sec) = &section else {
            return Err("setting outside any section".into());
        };
        if let Some(w) = check_key_line(sec, rest, allow_worktree)? {
            worktree = Some(w);
        }
    }
    Ok(worktree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_configs() {
        let ok = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote \"origin\"]\n\turl = https://x\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n# c\n; c\n\n[user] name = A\n[CORE]\n\tBare = false\n";
        check_config(ok.as_bytes()).unwrap();
        check_config(b"").unwrap();
        check_config(b"[core]\r\n\tbare = false\r\n").unwrap();
    }

    #[test]
    fn accepts_the_data_keys_git_lfs_writes_and_nothing_else_under_lfs() {
        let lfs = "[core]\n\tbare = false\n[lfs]\n\trepositoryformatversion = 0\n[lfs \"https://gitlab.com/g/p.git/info/lfs\"]\n\taccess = basic\n\tlocksverify = false\n";
        check_config(lfs.as_bytes()).unwrap();
        for bad in [
            "[lfs]\n\taccess = basic\n",
            "[lfs]\n\turl = https://evil\n",
            "[lfs]\n\tstandalonetransferagent = x\n",
            "[lfs \"u\"]\n\trepositoryformatversion = 0\n",
            "[lfs \"customtransfer.x\"]\n\tpath = /bin/sh\n",
            "[lfs.customtransfer.x]\n\tpath = /bin/sh\n",
            "[filter \"lfs\"]\n\tprocess = git-lfs filter-process\n",
        ] {
            assert!(check_config(bad.as_bytes()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn accepts_only_the_exact_patch_id_records_a_factory_ship_writes() {
        let sha1 = "dddba5b9cc68ba1600f8f3dea1ee60a79b63183e";
        let sha256 = "a98681f4b6a688a573f9629fa268dced15355d999fe408ecd7c39be9d0b14188";
        let real = format!("[core]\n\tbare = false\n[lfs]\n\trepositoryformatversion = 0\n[factory]\n\tpatchid-{sha1} = {sha256}\n");
        check_config(real.as_bytes()).unwrap();
        check_config(format!("[factory]\n\tpatchid-{sha256} = {sha256}\n\tpatchid-{sha1} = {sha256}\n").as_bytes()).unwrap();
        for bad in [
            format!("[factory \"x\"]\n\tpatchid-{sha1} = {sha256}\n"),
            format!("[factory]\n\tother = {sha256}\n"),
            format!("[factory]\n\tpatchid-{sha1}\n"),
            format!("[factory]\n\tpatchid-{} = {sha256}\n", &sha1[..39]),
            format!("[factory]\n\tpatchid-{} = {sha256}\n", sha1.to_uppercase()),
            format!("[factory]\n\tpatchid-{sha1} = {}\n", &sha256[..63]),
            format!("[factory]\n\tpatchid-{sha1} = {sha256} ; x\n"),
            format!("[factory]\n\tpatchid-{sha1} = \"{sha256}\"\n"),
            format!("[factory]\n\tpatchid-{sha1} = !sh -c x\n"),
        ] {
            assert!(check_config(bad.as_bytes()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn accepts_the_common_keys_that_cannot_run_anything_here() {
        for ok in [
            "[core]\n\thooksPath = .husky/_\n",
            "[branch \"main\"]\n\tvscode-merge-base = origin/main\n",
            "[merge]\n\tconflictstyle = zdiff3\n\tff = only\n",
            "[rerere]\n\tenabled = true\n",
        ] {
            assert!(check_config(ok.as_bytes()).is_ok(), "{ok:?}");
        }
        // The hook folder a repository names is never used: the runner overrides it on every call.
        let args = crate::git::base_args();
        let at = args.iter().position(|a| a.starts_with("core.hooksPath=")).expect("the override is always passed");
        assert_eq!(args[at - 1], "-c");
        assert!(args[at] == "core.hooksPath=/dev/null" || args[at] == "core.hooksPath=NUL");
    }

    #[test]
    fn accepts_worktree_config_in_the_config_file() {
        check_config(b"[extensions]\n\tworktreeConfig = true\n").unwrap();
        check_config(b"[extensions]\n\tworktreeconfig = false\n").unwrap();
    }

    #[test]
    fn rejects_everything_unknown() {
        for bad in [
            "[core]\n\tfsmonitor = x\n",
            "[core]\n\tworktree = /\n",
            "[core]\n\tsshcommand = x\n",
            "[core]\n\tpager = x\n",
            "[core]\n\teditor = x\n",
            "[core]\n\tgitproxy = x\n",
            "[filter \"x\"]\n\tclean = x\n",
            "[filter.x]\n\tclean = x\n",
            "[diff \"x\"]\n\ttextconv = x\n",
            "[merge \"x\"]\n\tdriver = x\n",
            "[credential]\n\thelper = x\n",
            "[alias]\n\ta = !x\n",
            "[include]\n\tpath = x\n",
            "[includeIf \"gitdir:/\"]\n\tpath = x\n",
            "[url \"x\"]\n\tinsteadOf = y\n",
            "[http]\n\tproxy = x\n",
            "[gpg]\n\tprogram = x\n",
            "[submodule]\n\trecurse = true\n",
            "[submodule \"s\"]\n\tupdate = !x\n",
            "[protocol \"ext\"]\n\tallow = always\n",
            "[extensions]\n\trelativeworktrees = true\n",
            "[extensions]\n\tpreciousobjects = true\n",
            "[remote \"o\"]\n\tuploadpack = x\n",
            "[remote \"o\"]\n\tvcs = x\n",
            "[core \"sub\"]\n\tbare = false\n",
            "[remote]\n\turl = x\n",
            "bare = false\n",
            "[core]\n\tbare = false \\\n[filter \"x\"]\n",
            "[core]\n[core\n",
            "[core] [filter \"x\"]\n",
            "[remote \"a]\n",
            "[remote \"o\"\n",
            "[core]\n\tbare\r= false\n",
            "[core]\n\t=x\n",
        ] {
            assert!(check_config(bad.as_bytes()).is_err(), "{bad:?}");
        }
        assert!(check_config(&[0xef, 0xbb, 0xbf, b'[', b'c', b'o', b'r', b'e', b']', b'\n']).is_err());
        assert!(check_config(&[0xff, 0xfe]).is_err());
        assert!(check_config(b"[core]\n\tbare = false\0").is_err());
        assert!(check_config(&vec![b'#'; MAX_CONFIG_BYTES + 1]).is_err());
    }

    #[test]
    fn quoted_subsection_may_contain_brackets_and_escapes() {
        check_config(b"[remote \"a]b\\\"c\"]\n\turl = x\n").unwrap();
        // ... but a header hidden after a quoted bracket is still parsed as one.
        assert!(check_config(b"[remote \"a]\"]\n[filter \"x\"]\n\tclean = x\n").is_err());
    }
    #[test]
    fn standard_lfs_settings_are_dropped_and_anything_else_under_them_is_still_refused() {
        let local = "[core]\n\tbare = false\n[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n[lfs]\n\turl = http://127.0.0.1:9/\n\trepositoryformatversion = 0\n";
        assert!(check_config(local.as_bytes()).is_err(), "the strict check still refuses it");
        check_config(&without_standard_lfs(local.as_bytes())).unwrap();
        for evil in [
            "[filter \"lfs\"]\n\tclean = touch /tmp/x\n",
            "[filter \"lfs\"]\n\tprocess = git-lfs filter-process; touch /tmp/x\n",
            "[filter \"lfs\"]\n\tsmudge = git-lfs smudge -- %f\n\ttextconv = touch /tmp/x\n",
            "[filter \"other\"]\n\tclean = git-lfs clean -- %f\n",
            "[filter \"lfs\"] clean = touch /tmp/x\n",
        ] {
            assert!(check_config(&without_standard_lfs(evil.as_bytes())).is_err(), "{evil:?}");
        }
    }

}
