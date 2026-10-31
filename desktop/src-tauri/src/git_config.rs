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
        ],
    ),
    ("extensions", false, &["objectformat"]),
    ("user", false, &["name", "email"]),
    ("remote", true, &["url", "pushurl", "fetch", "push", "tagopt", "prune", "prunetags"]),
    ("branch", true, &["remote", "merge", "rebase", "description", "pushremote"]),
    ("submodule", true, &["url", "active"]),
    ("pull", false, &["rebase", "ff"]),
    ("push", false, &["default", "autosetupremote"]),
    ("fetch", false, &["prune"]),
    ("init", false, &["defaultbranch"]),
    ("commit", false, &["gpgsign"]),
];

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
    let Some((_, sub_ok, keys)) = ALLOWED.iter().find(|(n, _, _)| *n == section.0) else {
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
    fn rejects_everything_unknown() {
        for bad in [
            "[core]\n\tfsmonitor = x\n",
            "[core]\n\tworktree = /\n",
            "[core]\n\thookspath = x\n",
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
            "[extensions]\n\tworktreeconfig = true\n",
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
}
