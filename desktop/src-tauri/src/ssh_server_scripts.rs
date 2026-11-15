//! Constant POSIX `sh` scripts that run on the SSH server, and the parsers for what they print.
//!
//! Each script is a compile-time constant that `ssh` receives as one command string. Variable data
//! (release version, checksum, nonce, the tarball, the secrets payload) arrives only on stdin, so no
//! caller text is ever spliced into a shell command. Scripts print results as
//! `__LLMIDE_<NAME>__=<value>` lines; the parsers read only those, so login banners and rc-file noise
//! are harmless.

use serde::Deserialize;

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::remote_deploy::MIN_DISK_MB;

const PROBE_FAILED: &str = "SSH_PROBE_FAILED";
const STATE_FAILED: &str = "SSH_STATE_FAILED";
const STATE_INVALID: &str = "SSH_STATE_INVALID";
const PORT_MIN: u16 = 3460;
const PORT_MAX: u16 = 3479;
const CLAUDE_VERSION_MAX_CHARS: usize = 64;

/// Shell helpers shared by the scripts. Validation mirrors [`valid_version`] and friends so the
/// server rejects the same inputs the app rejects.
macro_rules! sh_validators {
    () => {
        r##"valid_version() {
  case "$1" in
    ''|.*|-*|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ "${#1}" -le 64 ]
}
valid_nonce() {
  case "$1" in
    ''|*[!A-Za-z0-9]*) return 1 ;;
  esac
  [ "${#1}" -ge 16 ] && [ "${#1}" -le 128 ]
}
valid_sha() {
  case "$1" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}
"##
    };
}

/// Helpers that read `state.json` and identify the core process. Identification goes through
/// `/proc/<pid>/cmdline` and the pid recorded by this tool, never a pattern-based kill.
macro_rules! sh_state_helpers {
    () => {
        r##"state_field() {
  [ -f "$STATE" ] || return 0
  sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" "$STATE" | head -n 1
}
is_core() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  # The script's own shell carries this script text (which names server.mjs) in its command
  # line, so its own pid is excluded explicitly.
  [ "$1" != "$$" ] || return 1
  [ -r "/proc/$1/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$1/cmdline" | grep -F -q server.mjs
}
is_alive() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  # A zombie still answers kill -0 until its parent reaps it, so where /proc exists its state is read.
  if [ -r "/proc/$1/stat" ]; then
    S=$(sed 's/^.*) //' "/proc/$1/stat" | cut -c1)
    [ "$S" != Z ] || return 1
  fi
  return 0
}
"##
    };
}

/// Stops the core recorded in `state.json`: TERM, up to 5 s grace, then KILL.
macro_rules! sh_stop_core {
    () => {
        r##"stop_core() {
  PID=$(state_field pid)
  # state.json is the only record of the core, so it is deleted only when the pid is provably
  # gone or after a kill succeeded. A live pid that cannot be confirmed as the core is left alone.
  if ! is_alive "$PID"; then
    rm -f "$STATE"
    printf '__LLMIDE_STOP__=not_running\n'
    return 0
  fi
  if ! is_core "$PID"; then
    printf '__LLMIDE_STOP__=unknown\n'
    return 1
  fi
  kill -TERM "$PID" 2>/dev/null || true
  i=0
  while is_alive "$PID" && [ "$i" -lt 5 ]; do
    sleep 1
    i=$((i + 1))
  done
  if is_alive "$PID"; then
    kill -KILL "$PID" 2>/dev/null || true
    sleep 1
  fi
  if is_alive "$PID"; then
    printf '__LLMIDE_STOP__=unknown\n'
    return 1
  fi
  rm -f "$STATE"
  printf '__LLMIDE_STOP__=stopped\n'
}
"##
    };
}

/// The directories the Claude CLI commonly installs to, as `LLMIDE_PATH_PREFIX`. PROBE uses it for the
/// `claude` lookup and START puts it in front of the core's PATH, so the probe and the core find the same
/// `claude`. The login PATH of a non-interactive ssh session often misses these directories.
macro_rules! sh_path_prefix {
    () => {
        r##"LLMIDE_PATH_PREFIX="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:/usr/local/bin"
"##
    };
}

/// Reports the server's OS, disk, installed releases and Claude CLI. Never fails on a missing
/// tool: every probe degrades to an empty or zero value so the app can explain what is missing.
pub const PROBE: &str = concat!(
    r##"set -u
umask 077
LC_ALL=C
export LC_ALL
printf '\n'
printf '__LLMIDE_UNAME__=%s\n' "$(uname -s) $(uname -m)"
FREE_KB=$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$FREE_KB" in ''|*[!0-9]*) FREE_KB=0 ;; esac
printf '__LLMIDE_FREE_MB__=%s\n' "$((FREE_KB / 1024))"
INSTALLED=$(ls -1 "$HOME/.llmide-server/releases" 2>/dev/null | tr '\n' ' ')
printf '__LLMIDE_INSTALLED__=%s\n' "${INSTALLED% }"
CUR=$(readlink "$HOME/.llmide-server/current" 2>/dev/null || true)
printf '__LLMIDE_CURRENT__=%s\n' "${CUR##*/}"
"##,
    sh_path_prefix!(),
    r##"# The output is filtered because the server controls it: only plain text survives, so it cannot carry
# a marker.
CLAUDE_LINE=$(PATH="$LLMIDE_PATH_PREFIX:$PATH" claude --version 2>/dev/null | head -n 1 | tr -cd 'A-Za-z0-9 ._()-' || true)
printf '__LLMIDE_CLAUDE__=%s\n' "$CLAUDE_LINE"
"##,
);

/// Unpacks a release. Stdin is `<version> <sha256>\n` followed by the raw `.tar.gz`.
///
/// The header is read with the `read` builtin: dash and bash both consume non-seekable input one
/// byte at a time for `read`, so the tarball after the newline is not swallowed. A read-ahead
/// tool such as `head` would take tarball bytes with it and fail the checksum.
pub const INSTALL: &str = concat!(
    r##"set -eu
umask 077
LC_ALL=C
export LC_ALL
ROOT="${HOME:?}/.llmide-server"
"##,
    sh_validators!(),
    r##"DONE_MARK=0
PART=""
STAGE=""
mark() {
  DONE_MARK=1
  printf '__LLMIDE_INSTALL__=%s\n' "$1"
}
# Any failure removes the partial files. The generic failed marker is printed only when no specific
# marker was, so a checksum or unpack failure keeps its precise name.
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -n "$PART" ]; then rm -rf "$PART"; fi
    if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi
    if [ "$DONE_MARK" -eq 0 ]; then printf '__LLMIDE_INSTALL__=failed\n'; fi
  fi
}
trap on_exit EXIT
IFS= read -r HEADER || HEADER=""
case "$HEADER" in
  *" "*) ;;
  *) mark invalid; exit 1 ;;
esac
VERSION=${HEADER%% *}
SHA=${HEADER#* }
if ! valid_version "$VERSION" || ! valid_sha "$SHA"; then
  mark invalid
  exit 1
fi
mkdir -p "$ROOT/releases" "$ROOT/data"
chmod 700 "$ROOT" "$ROOT/releases" "$ROOT/data"
REL="$ROOT/releases/$VERSION"
PART="$ROOT/releases/.$VERSION.part"
STAGE="$ROOT/releases/.$VERSION.stage"
rm -rf "$PART" "$STAGE"
cat > "$PART"
ACTUAL=$(sha256sum "$PART" | awk '{ print $1 }')
if [ "$ACTUAL" != "$SHA" ]; then
  rm -f "$PART"
  mark checksum
  exit 1
fi
mkdir "$STAGE"
# GNU tar warns about extended headers in bundles built on macOS; the warnings are harmless, so
# stderr is dropped, but the exit status still decides success.
if ! tar -xzf "$PART" -C "$STAGE" 2>/dev/null; then
  rm -rf "$PART" "$STAGE"
  mark unpack
  exit 1
fi
rm -f "$PART"
if [ ! -f "$STAGE/core/node/node" ] || [ ! -f "$STAGE/core/root/extension/server.mjs" ]; then
  rm -rf "$STAGE"
  mark layout
  exit 1
fi
chmod 700 "$STAGE"
# A release is immutable once installed: a core that is still running may load files from it, so
# re-installing an existing version keeps the old directory and only repoints current.
if [ -e "$REL" ]; then
  rm -rf "$STAGE"
else
  mv "$STAGE" "$REL"
fi
touch "$REL"
ln -sfn "$REL" "$ROOT/.current.tmp"
mv -T "$ROOT/.current.tmp" "$ROOT/current"
mark ok
"##,
);

/// Starts the core from `current`. Stdin is `<version> <nonce>\n` followed by the secrets payload,
/// which is handed to the core's stdin untouched.
pub const START: &str = concat!(
    r##"set -eu
umask 077
LC_ALL=C
export LC_ALL
ROOT="${HOME:?}/.llmide-server"
STATE="$ROOT/state.json"
"##,
    sh_validators!(),
    sh_state_helpers!(),
    r##"IFS= read -r HEADER || HEADER=""
case "$HEADER" in
  *" "*) ;;
  *) printf '__LLMIDE_START__=invalid\n'; exit 1 ;;
esac
VERSION=${HEADER%% *}
NONCE=${HEADER#* }
if ! valid_version "$VERSION" || ! valid_nonce "$NONCE"; then
  printf '__LLMIDE_START__=invalid\n'
  exit 1
fi
if [ -f "$STATE" ]; then
  OLD_PID=$(state_field pid)
  if is_core "$OLD_PID"; then
    printf '__LLMIDE_STATE__=%s\n' "$(tr -d '\n' < "$STATE")"
    exit 0
  fi
  rm -f "$STATE"
fi
TARGET=$(readlink "$ROOT/current" 2>/dev/null || true)
if [ "${TARGET##*/}" != "$VERSION" ] || [ ! -f "$ROOT/current/core/node/node" ]; then
  printf '__LLMIDE_START__=version-mismatch\n'
  exit 1
fi
# No ss or netstat on minimal servers, and /dev/tcp is bash-only, so the bundled node does the
# bind test. It is the same node that will run the core, so the check uses the real runtime.
PORT=$("$ROOT/current/core/node/node" -e 'const net = require("net");
let port = 3460;
const next = () => {
  if (port > 3479) { process.stdout.write("none"); return; }
  const srv = net.createServer();
  srv.once("error", () => { port += 1; next(); });
  srv.listen(port, "127.0.0.1", () => srv.close(() => process.stdout.write(String(port))));
};
next();') || PORT=""
case "$PORT" in
  ''|*[!0-9]*) printf '__LLMIDE_START__=no-port\n'; exit 1 ;;
esac
"##,
    sh_path_prefix!(),
    r##"mkdir -p "$ROOT/data/addons/plugins"
chmod 700 "$ROOT/data"
# The local spawn writes the Chrome extension pin into the core's data dir before it starts, and the core
# reads the pin once at boot. Without the file the core echoes CORS for any chrome-extension:// origin. The
# bytes are the ones core_env::pin_extension_ids writes (serde_json, no trailing newline). The file is renamed
# into place, so the core never reads a half-written pin. A failed write stops the start: a core without the
# pin would accept any extension.
PIN="$ROOT/data/extension-ids.json"
printf '%s' '{"ids":["ecojclccfoegmlffpiahbcenmkfhadlk"]}' > "$PIN.tmp" || { printf '__LLMIDE_START__=pin-failed\n'; exit 1; }
chmod 600 "$PIN.tmp" || { printf '__LLMIDE_START__=pin-failed\n'; exit 1; }
mv "$PIN.tmp" "$PIN" || { printf '__LLMIDE_START__=pin-failed\n'; exit 1; }
# The core gets the same PATH the PROBE lookup uses, so the core finds the same `claude`. The local spawn
# sets the core's CORS allow-list to the webview origins of every desktop OS, because one server core can be
# reached from any of them. Registration is single-owner: the core refuses a sign-up once an owner exists.
# The core is started without a parent-pid variable so it outlives this SSH session.
# A non-interactive shell gives a background job /dev/null as stdin, so the payload is first
# duplicated onto fd 3 and then handed to the core as its stdin. fd 3 is closed in the core so
# it does not keep the pipe open.
exec 3<&0
PATH="$LLMIDE_PATH_PREFIX:$PATH" LLMIDE_SECRETS_STDIN=1 LLMIDE_PORT="$PORT" LLMIDE_CORE_NONCE="$NONCE" \
  LLMIDE_DATA_DIR="$ROOT/data" LLMIDE_DB_PATH="$ROOT/data/data.db" \
  LLMIDE_PLUGIN_DIR="$ROOT/data/addons/plugins" \
  LLMIDE_CORS_ORIGINS='tauri://localhost,http://tauri.localhost,https://tauri.localhost' \
  LLMIDE_REGISTRATION_SINGLE_OWNER=1 \
  LLMIDE_EXT_ACTIVE_SET=1 \
  setsid nohup "$ROOT/current/core/node/node" "$ROOT/current/core/root/extension/server.mjs" \
  <&3 3<&- >>"$ROOT/core.log" 2>&1 &
PID=$!
exec 3<&-
i=0
until curl -s --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
  # A core that dies at boot is reported at once, with the last log line, instead of after 20 s.
  if ! is_alive "$PID"; then
    LOG_LINE=$(tail -n 1 "$ROOT/core.log" 2>/dev/null | tr -cd 'A-Za-z0-9 ._()-' | cut -c1-300)
    printf '__LLMIDE_START__=exited\n'
    printf '__LLMIDE_LOG__=%s\n' "$LOG_LINE"
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 20 ]; then
    kill -TERM "$PID" 2>/dev/null || true
    j=0
    while is_alive "$PID" && [ "$j" -lt 5 ]; do
      sleep 1
      j=$((j + 1))
    done
    if is_alive "$PID"; then
      kill -KILL "$PID" 2>/dev/null || true
    fi
    printf '__LLMIDE_START__=timeout\n'
    exit 1
  fi
  sleep 1
done
printf '{"running":true,"port":%s,"pid":%s,"nonce":"%s","version":"%s"}\n' "$PORT" "$PID" "$NONCE" "$VERSION" > "$STATE.tmp"
chmod 600 "$STATE.tmp"
mv "$STATE.tmp" "$STATE"
printf '__LLMIDE_STATE__=%s\n' "$(tr -d '\n' < "$STATE")"
"##,
);

/// Reports whether the core recorded in `state.json` is alive.
pub const STATUS: &str = concat!(
    r##"set -u
umask 077
LC_ALL=C
export LC_ALL
ROOT="${HOME:?}/.llmide-server"
STATE="$ROOT/state.json"
"##,
    sh_state_helpers!(),
    r##"if [ ! -f "$STATE" ]; then
  printf '__LLMIDE_STATE__={"running":false}\n'
  exit 0
fi
if is_core "$(state_field pid)"; then
  printf '__LLMIDE_STATE__=%s\n' "$(tr -d '\n' < "$STATE")"
else
  printf '__LLMIDE_STATE__={"running":false}\n'
fi
"##,
);

/// Stops the core recorded in `state.json`.
pub const STOP: &str = concat!(
    r##"set -u
umask 077
LC_ALL=C
export LC_ALL
ROOT="${HOME:?}/.llmide-server"
STATE="$ROOT/state.json"
"##,
    sh_state_helpers!(),
    sh_stop_core!(),
    "stop_core || exit 1\n",
);

/// Repoints `current` at the newest release other than the one it points at now.
pub const ROLLBACK: &str = concat!(
    r##"set -eu
umask 077
LC_ALL=C
export LC_ALL
ROOT="${HOME:?}/.llmide-server"
CUR=$(readlink "$ROOT/current" 2>/dev/null || true)
CUR=${CUR##*/}
TARGET=""
# INSTALL touches each release when it lands, so ls -t orders releases by install time.
for NAME in $(ls -1t "$ROOT/releases" 2>/dev/null || true); do
  if [ "$NAME" != "$CUR" ] && [ -d "$ROOT/releases/$NAME" ]; then
    TARGET=$NAME
    break
  fi
done
if [ -z "$TARGET" ]; then
  printf '__LLMIDE_ROLLBACK__=none\n'
  exit 0
fi
ln -sfn "$ROOT/releases/$TARGET" "$ROOT/.current.tmp"
mv -T "$ROOT/.current.tmp" "$ROOT/current"
printf '__LLMIDE_ROLLBACK__=%s\n' "$TARGET"
"##,
);

/// Stops the core and removes releases and `current`. The `data` directory is kept on purpose: it
/// holds the user's database and survives a reinstall.
pub const UNINSTALL: &str = concat!(
    r##"set -u
umask 077
LC_ALL=C
export LC_ALL
ROOT="${HOME:?}/.llmide-server"
STATE="$ROOT/state.json"
"##,
    sh_state_helpers!(),
    sh_stop_core!(),
    r##"stop_core || exit 1
rm -rf "$ROOT/releases" "$ROOT/current"
printf '__LLMIDE_UNINSTALL__=ok\n'
"##,
);

/// Appends one public key to `~/.ssh/authorized_keys`. Stdin is exactly one line,
/// `ssh-ed25519 <base64> <comment>`, and nothing else is accepted: no options prefix, no second line,
/// no other key type. The check runs here as well as in the app, because this script is the last
/// thing that can refuse a line before it reaches the server's sshd.
///
/// Prints `added` or `present`, or `invalid` (nothing changed) or `failed`. Only the marker is printed,
/// never the key. Runs under dash, so no bash-only syntax.
pub const ADD_KEY: &str = r##"set -u
umask 077
LC_ALL=C
export LC_ALL
fail() {
  printf '__LLMIDE_ADDKEY__=failed\n'
  exit 1
}
invalid() {
  printf '__LLMIDE_ADDKEY__=invalid\n'
  exit 1
}
# Count the lines as they are read, so a second line is refused instead of silently dropped.
LINES=0
LINE=""
while IFS= read -r ADDKEY_IN || [ -n "$ADDKEY_IN" ]; do
  LINES=$((LINES + 1))
  LINE=$ADDKEY_IN
done
[ "$LINES" -eq 1 ] || invalid
case "$LINE" in
  'ssh-ed25519 '*) ;;
  *) invalid ;;
esac
REST=${LINE#ssh-ed25519 }
case "$REST" in
  *' '*' '*) invalid ;;
  *' '*) ;;
  *) invalid ;;
esac
KEY_B64=${REST%% *}
KEY_COMMENT=${REST#* }
case "$KEY_B64" in
  ''|*[!A-Za-z0-9+/=]*) invalid ;;
esac
case "$KEY_COMMENT" in
  ''|*[!A-Za-z0-9@._-]*) invalid ;;
esac
[ -n "${HOME:-}" ] || fail
SSH_DIR="$HOME/.ssh"
AUTH="$SSH_DIR/authorized_keys"
# An existing ~/.ssh keeps its mode: only a folder this script creates gets 0700.
if [ ! -d "$SSH_DIR" ]; then
  mkdir -m 700 "$SSH_DIR" || fail
fi
if [ ! -e "$AUTH" ]; then
  : > "$AUTH" || fail
fi
[ -f "$AUTH" ] || fail
grep -qxF -- "$LINE" "$AUTH"
case $? in
  0) printf '__LLMIDE_ADDKEY__=present\n'; exit 0 ;;
  1) ;;
  *) fail ;;
esac
# A file that does not end in a newline would join its last line with the new key.
if [ -s "$AUTH" ]; then
  NL=$(printf '\n.')
  NL=${NL%.}
  LAST=$(tail -c 1 "$AUTH"; printf '.')
  LAST=${LAST%.}
  if [ "$LAST" != "$NL" ]; then
    printf '\n' >> "$AUTH" || fail
  fi
fi
printf '%s\n' "$LINE" >> "$AUTH" || fail
printf '__LLMIDE_ADDKEY__=added\n'
"##;

/// The Probe result the app decides on before uploading anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    pub os: String,
    pub arch: String,
    pub free_mb: u64,
    pub installed: Vec<String>,
    pub current: Option<String>,
    pub claude: ClaudeState,
}

/// Whether the Claude CLI exists on the server, and its reported version when it does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaudeState {
    Missing,
    Installed { version: String },
}

/// What `state.json` says about the core, after the pid and the port have been checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreState {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub nonce: Option<String>,
    pub version: Option<String>,
}

#[derive(Deserialize)]
struct RawCoreState {
    running: bool,
    port: Option<u16>,
    pid: Option<u32>,
    nonce: Option<String>,
    version: Option<String>,
}

/// Returns the value of the last `__LLMIDE_<name>__=` marker, so a value printed later wins.
/// A marker counts only at the start of a line: a marker inside a value or a banner is text, not a
/// result, so the server cannot spoof one by echoing it.
fn marker<'a>(stdout: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("__LLMIDE_{name}__=");
    stdout.lines().rev().find_map(|line| {
        line.trim_end_matches('\r').strip_prefix(prefix.as_str()).map(str::trim)
    })
}

fn required<'a>(stdout: &'a str, name: &str, code: &'static str) -> Result<&'a str, FsError> {
    marker(stdout, name)
        .ok_or_else(|| herr(code, format!("the server did not print __LLMIDE_{name}__")))
}

/// Parses the output of [`PROBE`]. Every marker is required, so truncated output is an error.
pub fn parse_probe(stdout: &str) -> Result<Probe, FsError> {
    let uname = required(stdout, "UNAME", PROBE_FAILED)?;
    let mut words = uname.split_whitespace();
    let (Some(os), Some(arch)) = (words.next(), words.next()) else {
        return Err(herr(PROBE_FAILED, "the server printed an incomplete uname line"));
    };
    let free_mb = required(stdout, "FREE_MB", PROBE_FAILED)?
        .parse::<u64>()
        .map_err(|_| herr(PROBE_FAILED, "the server printed a non-numeric free space"))?;
    let installed = required(stdout, "INSTALLED", PROBE_FAILED)?
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let current = Some(required(stdout, "CURRENT", PROBE_FAILED)?)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let claude_raw = required(stdout, "CLAUDE", PROBE_FAILED)?;
    let claude = if claude_raw.is_empty() {
        ClaudeState::Missing
    } else {
        // Control characters are dropped before truncating so a hostile banner cannot inject
        // escape sequences into the UI.
        let version: String = claude_raw
            .chars()
            .filter(|c| !c.is_control())
            .take(CLAUDE_VERSION_MAX_CHARS)
            .collect();
        ClaudeState::Installed { version }
    };
    Ok(Probe {
        os: os.to_string(),
        arch: arch.to_string(),
        free_mb,
        installed,
        current,
        claude,
    })
}

/// Refuses a server the desktop cannot install onto: non-Linux, non-x86_64, or short on disk.
pub fn check_probe(p: &Probe) -> Result<(), FsError> {
    if p.os != "Linux" {
        return Err(herr(
            "SSH_UNSUPPORTED_OS",
            format!("the server runs {}; only Linux is supported", p.os),
        ));
    }
    if p.arch != "x86_64" {
        return Err(herr(
            "SSH_UNSUPPORTED_ARCH",
            format!("the server is {}; only x86_64 is supported", p.arch),
        ));
    }
    if p.free_mb < MIN_DISK_MB {
        return Err(herr(
            "SSH_DISK_LOW",
            format!(
                "only {} MB free on the server; at least {} MB are needed",
                p.free_mb, MIN_DISK_MB
            ),
        ));
    }
    Ok(())
}

/// Parses the `__LLMIDE_STATE__` line printed by [`STATUS`] and [`START`].
pub fn parse_core_state(stdout: &str) -> Result<CoreState, FsError> {
    let json = required(stdout, "STATE", STATE_FAILED)?;
    let raw: RawCoreState = serde_json::from_str(json)
        .map_err(|_| herr(STATE_INVALID, "the server printed a state that is not valid JSON"))?;
    if let Some(port) = raw.port {
        if !(PORT_MIN..=PORT_MAX).contains(&port) {
            return Err(herr(STATE_INVALID, format!("port {port} is outside 3460..=3479")));
        }
    }
    if raw.pid == Some(0) {
        return Err(herr(STATE_INVALID, "the recorded pid is 0"));
    }
    if raw.running && (raw.port.is_none() || raw.pid.is_none()) {
        return Err(herr(STATE_INVALID, "a running core must record its port and pid"));
    }
    if let Some(nonce) = &raw.nonce {
        if !valid_nonce(nonce) {
            return Err(herr(STATE_INVALID, "the recorded nonce has an invalid shape"));
        }
    }
    if let Some(version) = &raw.version {
        if !valid_version(version) {
            return Err(herr(STATE_INVALID, "the recorded version has an invalid shape"));
        }
    }
    Ok(CoreState {
        running: raw.running,
        port: raw.port,
        pid: raw.pid,
        nonce: raw.nonce,
        version: raw.version,
    })
}

/// Reads a failed START: the `__LLMIDE_START__` value (`timeout`, `exited`, `invalid`, ...) and, for
/// `exited`, the last line of `core.log` that the script attached. Returns None when START printed
/// no START marker, which is the success case.
pub fn parse_start_failure(stdout: &str) -> Option<(String, Option<String>)> {
    let value = marker(stdout, "START")?;
    let log = marker(stdout, "LOG")
        .filter(|line| !line.is_empty())
        .map(|line| line.chars().take(300).collect());
    Some((value.to_string(), log))
}

/// Parses the `__LLMIDE_STOP__` marker printed by STOP and UNINSTALL. `unknown` means a live pid
/// could not be confirmed as the core, so state.json was kept and nothing was removed.
pub fn parse_stop(stdout: &str) -> Result<&'static str, FsError> {
    match marker(stdout, "STOP") {
        Some("stopped") => Ok("stopped"),
        Some("not_running") => Ok("not_running"),
        Some("unknown") => Err(herr(
            "SSH_STOP_UNKNOWN",
            "a live process could not be confirmed as the core, so it was left running and state.json was kept",
        )),
        _ => Err(herr("SSH_STOP_FAILED", "the server did not report a stop result")),
    }
}

/// Parses the `__LLMIDE_UNINSTALL__` marker that UNINSTALL prints only after the releases and `current` were
/// removed. The caller reads the STOP marker first; this confirms the removal itself ran to the end.
pub fn parse_uninstall(stdout: &str) -> Result<(), FsError> {
    match marker(stdout, "UNINSTALL") {
        Some("ok") => Ok(()),
        _ => Err(herr("SSH_UNINSTALL_FAILED", "The server files could not be removed.")),
    }
}

/// Parses the `__LLMIDE_ADDKEY__` marker printed by ADD_KEY. `invalid` means the script refused the line and
/// changed nothing; any other value, or no marker, means the key could not be added.
pub fn parse_add_key(stdout: &str) -> Result<&'static str, FsError> {
    match marker(stdout, "ADDKEY") {
        Some("added") => Ok("added"),
        Some("present") => Ok("present"),
        Some("invalid") => Err(herr("SSH_KEY_INVALID", "The new key was not accepted.")),
        _ => Err(herr("SSH_KEY_INSTALL_FAILED", "The key could not be added on the server.")),
    }
}

/// A release name: 1 to 64 of `[A-Za-z0-9._-]`, not starting with `.` or `-`. The same rule is
/// enforced by the INSTALL and START scripts, so a name cannot escape the releases directory.
pub fn valid_version(v: &str) -> bool {
    (1..=64).contains(&v.len())
        && !v.starts_with('.')
        && !v.starts_with('-')
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn valid_nonce(n: &str) -> bool {
    (16..=128).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Stdin for [`START`]: the header line, then the secrets payload exactly as given.
pub fn start_stdin(version: &str, nonce: &str, secrets_payload: &[u8]) -> Vec<u8> {
    let mut out = format!("{version} {nonce}\n").into_bytes();
    out.extend_from_slice(secrets_payload);
    out
}

/// Stdin for [`INSTALL`]: the header line, then the raw tarball exactly as given.
pub fn install_stdin(version: &str, sha256_hex: &str, tarball: &[u8]) -> Vec<u8> {
    let mut out = format!("{version} {sha256_hex}\n").into_bytes();
    out.extend_from_slice(tarball);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_env::{webview_origins, EXTENSION_ID, EXTENSION_IDS_FILE};
    use crate::fsutil::Os;

    const PROBE_OUTPUT: &str = "Welcome to the server\n\
        Last login: Mon Nov 10 09:00:00\n\
        __LLMIDE_UNAME__=Linux x86_64\n\
        __LLMIDE_FREE_MB__=5000\n\
        __LLMIDE_INSTALLED__=1.0.0 2.0.0\n\
        __LLMIDE_CURRENT__=2.0.0\n\
        __LLMIDE_CLAUDE__=2.1.0 (Claude Code)\n\
        bye\n";

    const VALID_NONCE: &str = "abcdefgh12345678";

    fn all_scripts() -> [(&'static str, &'static str); 8] {
        [
            ("PROBE", PROBE),
            ("INSTALL", INSTALL),
            ("START", START),
            ("STATUS", STATUS),
            ("STOP", STOP),
            ("ROLLBACK", ROLLBACK),
            ("UNINSTALL", UNINSTALL),
            ("ADD_KEY", ADD_KEY),
        ]
    }

    #[test]
    fn probe_ignores_noise() {
        let probe = parse_probe(PROBE_OUTPUT).expect("probe parses");
        assert_eq!(probe.os, "Linux");
        assert_eq!(probe.arch, "x86_64");
        assert_eq!(probe.free_mb, 5000);
        assert_eq!(probe.installed, vec!["1.0.0".to_string(), "2.0.0".to_string()]);
        assert_eq!(probe.current.as_deref(), Some("2.0.0"));
        assert_eq!(
            probe.claude,
            ClaudeState::Installed { version: "2.1.0 (Claude Code)".to_string() }
        );
        assert!(check_probe(&probe).is_ok());
    }

    #[test]
    fn marker_takes_last_occurrence() {
        let out = "__LLMIDE_UNAME__=Darwin arm64\n__LLMIDE_FREE_MB__=1\n\
                   __LLMIDE_INSTALLED__=\n__LLMIDE_CURRENT__=\n__LLMIDE_CLAUDE__=\n\
                   __LLMIDE_UNAME__=Linux x86_64\n";
        let probe = parse_probe(out).expect("probe parses");
        assert_eq!(probe.os, "Linux");
        assert_eq!(probe.claude, ClaudeState::Missing);
        assert_eq!(probe.current, None);
        assert!(probe.installed.is_empty());
    }

    #[test]
    fn probe_rejects_arm() {
        let out = PROBE_OUTPUT.replace("x86_64", "aarch64");
        let probe = parse_probe(&out).expect("probe parses");
        let err = check_probe(&probe).expect_err("arm is refused");
        assert_eq!(err.code, "SSH_UNSUPPORTED_ARCH");
    }

    #[test]
    fn probe_rejects_low_disk() {
        let out = PROBE_OUTPUT.replace("__LLMIDE_FREE_MB__=5000", "__LLMIDE_FREE_MB__=1500");
        let probe = parse_probe(&out).expect("probe parses");
        let err = check_probe(&probe).expect_err("low disk is refused");
        assert_eq!(err.code, "SSH_DISK_LOW");
        assert!(err.message.contains("1500"), "{}", err.message);
        assert!(err.message.contains("2048"), "{}", err.message);
    }

    #[test]
    fn probe_rejects_other_os() {
        let out = PROBE_OUTPUT.replace("Linux x86_64", "Darwin x86_64");
        let probe = parse_probe(&out).expect("probe parses");
        let err = check_probe(&probe).expect_err("non-Linux is refused");
        assert_eq!(err.code, "SSH_UNSUPPORTED_OS");
    }

    #[test]
    fn probe_missing_marker() {
        let out = "motd only\n__LLMIDE_FREE_MB__=5000\n";
        let err = parse_probe(out).expect_err("no uname marker");
        assert_eq!(err.code, "SSH_PROBE_FAILED");
    }

    #[test]
    fn state_parses() {
        let out = format!(
            "noise\n__LLMIDE_STATE__={{\"running\":true,\"port\":3461,\"pid\":77,\"nonce\":\"{VALID_NONCE}\",\"version\":\"1.2.3\",\"extra\":1}}\n"
        );
        let state = parse_core_state(&out).expect("state parses");
        assert_eq!(
            state,
            CoreState {
                running: true,
                port: Some(3461),
                pid: Some(77),
                nonce: Some(VALID_NONCE.to_string()),
                version: Some("1.2.3".to_string()),
            }
        );
    }

    #[test]
    fn state_not_running() {
        let state = parse_core_state("__LLMIDE_STATE__={\"running\":false}\n").expect("parses");
        assert!(!state.running);
        assert_eq!(state.port, None);
        assert_eq!(state.pid, None);
    }

    #[test]
    fn state_rejects_bad_port() {
        let out = format!(
            "__LLMIDE_STATE__={{\"running\":true,\"port\":80,\"pid\":77,\"nonce\":\"{VALID_NONCE}\",\"version\":\"1.2.3\"}}\n"
        );
        assert!(parse_core_state(&out).is_err());
    }

    #[test]
    fn state_rejects_bad_nonce_and_version() {
        let bad_nonce = "__LLMIDE_STATE__={\"running\":true,\"port\":3461,\"pid\":77,\"nonce\":\"short\",\"version\":\"1.2.3\"}\n";
        assert!(parse_core_state(bad_nonce).is_err());
        let bad_version = format!(
            "__LLMIDE_STATE__={{\"running\":true,\"port\":3461,\"pid\":77,\"nonce\":\"{VALID_NONCE}\",\"version\":\"../x\"}}\n"
        );
        assert!(parse_core_state(&bad_version).is_err());
    }

    #[test]
    fn state_missing_marker_is_error() {
        assert!(parse_core_state("nothing here\n").is_err());
    }

    #[test]
    fn scripts_are_constant_and_safe() {
        for (name, script) in all_scripts() {
            assert!(!script.contains("sudo"), "{name} uses sudo");
            assert!(!script.contains("LLMIDE_PARENT_PID"), "{name} sets the parent pid");
            assert!(!script.contains("0.0.0.0"), "{name} binds all interfaces");
            assert!(!script.contains("pkill"), "{name} uses pkill");
            assert!(!script.contains("pgrep"), "{name} uses pgrep");
            assert!(!script.contains("[["), "{name} uses bash-only [[");
            assert!(!script.contains("<("), "{name} uses process substitution");
        }
        assert!(START.contains("127.0.0.1"));
    }

    /// The one `PATH` prefix line PROBE and START both include. Changing it here changes both scripts.
    const PATH_PREFIX_LINE: &str =
        r#"LLMIDE_PATH_PREFIX="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:/usr/local/bin""#;
    /// `LLMIDE_CORS_ORIGINS` as START exports it: every webview origin, on every desktop OS.
    const START_CORS_VALUE: &str = "tauri://localhost,http://tauri.localhost,https://tauri.localhost";

    #[test]
    fn probe_and_start_share_the_path_prefix() {
        assert!(PROBE.contains(PATH_PREFIX_LINE), "PROBE lacks the shared prefix");
        assert!(START.contains(PATH_PREFIX_LINE), "START lacks the shared prefix");
        assert!(START.contains(r#"PATH="$LLMIDE_PATH_PREFIX:$PATH" "#), "START does not use the prefix");
    }

    #[test]
    fn start_cors_value_covers_every_webview_origin() {
        assert!(START.contains(&format!("LLMIDE_CORS_ORIGINS='{START_CORS_VALUE}' ")));
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            for origin in webview_origins(os) {
                assert!(
                    START_CORS_VALUE.split(',').any(|o| o == *origin),
                    "START's CORS value lacks the webview origin {origin}"
                );
            }
        }
        assert!(!START_CORS_VALUE.contains('*'));
    }

    #[test]
    fn start_pins_the_extension_origin_like_the_local_spawn() {
        assert_eq!(EXTENSION_IDS_FILE, "extension-ids.json");
        assert_eq!(EXTENSION_ID, "ecojclccfoegmlffpiahbcenmkfhadlk");
        // The local pin writes serde_json of the one ID with no trailing newline; START writes the same bytes.
        let expected = serde_json::json!({ "ids": [EXTENSION_ID] }).to_string();
        assert!(START.contains(&format!("printf '%s' '{expected}' > ")), "START writes another pin");
        assert!(START.contains(&format!("/data/{EXTENSION_IDS_FILE}\"")), "START pins another file name");
        assert!(START.contains("chmod 600 \"$PIN.tmp\""));
        assert!(START.contains("mv \"$PIN.tmp\" \"$PIN\""));
    }

    #[test]
    fn start_passes_the_extension_switches_the_desktop_library_writes() {
        // Without this the core ignores the switches made in Library -> Extensions, and in SSH mode
        // the desktop's webview is served only by this core.
        assert!(START.contains("LLMIDE_EXT_ACTIVE_SET=1 "));
    }

    #[test]
    fn start_enables_single_owner_registration_only_on_the_core() {
        assert!(START.contains("LLMIDE_REGISTRATION_SINGLE_OWNER=1 "));
        assert!(!PROBE.contains("LLMIDE_REGISTRATION_SINGLE_OWNER"));
    }

    #[test]
    fn install_stdin_header() {
        let sha = "ab".repeat(32);
        let out = install_stdin("1.2.3", &sha, b"T");
        let expected_head = format!("1.2.3 {sha}\n");
        assert!(out.starts_with(expected_head.as_bytes()));
        assert!(out.ends_with(b"T"));
        assert_eq!(out.len(), expected_head.len() + 1);
    }

    #[test]
    fn start_stdin_header_then_payload() {
        let out = start_stdin("1.2.3", VALID_NONCE, b"{\"k\":1}\n");
        assert_eq!(out, format!("1.2.3 {VALID_NONCE}\n{{\"k\":1}}\n").into_bytes());
    }

    #[test]
    fn valid_version_pattern() {
        assert!(valid_version("1.2.3"));
        assert!(valid_version("v_2-rc.1"));
        assert!(valid_version(&"a".repeat(64)));
        assert!(!valid_version(""));
        assert!(!valid_version(".hidden"));
        assert!(!valid_version("-rf"));
        assert!(!valid_version("a/b"));
        assert!(!valid_version("a b"));
        assert!(!valid_version(&"a".repeat(65)));
    }

    #[cfg(unix)]
    #[test]
    fn scripts_pass_sh_syntax() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        for (name, script) in all_scripts() {
            let mut child = Command::new("sh")
                .arg("-n")
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn sh");
            child
                .stdin
                .take()
                .expect("stdin")
                .write_all(script.as_bytes())
                .expect("write script");
            let out = child.wait_with_output().expect("wait sh");
            assert!(
                out.status.success(),
                "{name} fails sh -n: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    // ---- Real script runs against a temporary HOME (unix only) ----

    #[cfg(unix)]
    fn unique_dir(tag: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "llmide-server-scripts-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Runs one script the way ssh does: `sh -c <script>` with the payload on stdin.
    /// On macOS the BSD `mv` has no `-T`, so a shim maps `mv -T` to `mv -fh`; Linux
    /// (the real target) uses GNU `mv -T` unchanged.
    #[cfg(unix)]
    fn run_sh(script: &str, home: &std::path::Path, stdin: &[u8]) -> (bool, String) {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let path = path_with_shims(home);
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("HOME", home)
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        {
            let mut pipe = child.stdin.take().expect("stdin");
            // A script that exits early closes the pipe; that is a result, not a test error.
            let _ = pipe.write_all(stdin);
        }
        let out = child.wait_with_output().expect("wait sh");
        (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())
    }

    #[cfg(unix)]
    fn path_with_shims(home: &std::path::Path) -> String {
        let inherited = std::env::var("PATH").unwrap_or_default();
        // Stub commands a test put under home/stubs (a fake curl or claude) go first.
        let mut front: Vec<String> = Vec::new();
        let stubs = home.join("stubs");
        if stubs.is_dir() {
            front.push(stubs.display().to_string());
        }
        if !cfg!(target_os = "macos") {
            front.push(inherited);
            return front.join(":");
        }
        let shim_dir = home.with_extension("shims");
        std::fs::create_dir_all(&shim_dir).expect("shim dir");
        let mv_shim = shim_dir.join("mv");
        std::fs::write(
            &mv_shim,
            "#!/bin/sh\nif [ \"$1\" = \"-T\" ]; then shift; exec /bin/mv -fh \"$@\"; fi\nexec /bin/mv \"$@\"\n",
        )
        .expect("write mv shim");
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&mv_shim, std::fs::Permissions::from_mode(0o755))
                .expect("chmod shim");
        }
        front.push(shim_dir.display().to_string());
        front.push(inherited);
        front.join(":")
    }

    /// Builds a `.tar.gz` shaped like the real bundle: `VERSION` and `core/` with a stub Node.
    #[cfg(unix)]
    fn make_bundle(base: &std::path::Path, version: &str) -> Vec<u8> {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;
        let src = base.join(format!("bundle-{version}"));
        let node_dir = src.join("core/node");
        let ext_dir = src.join("core/root/extension");
        std::fs::create_dir_all(&node_dir).expect("node dir");
        std::fs::create_dir_all(&ext_dir).expect("ext dir");
        std::fs::write(src.join("VERSION"), format!("{version}\n")).expect("VERSION");
        let node = node_dir.join("node");
        std::fs::write(&node, "#!/bin/sh\nexit 0\n").expect("node stub");
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        std::fs::write(ext_dir.join("server.mjs"), "// stub core\n").expect("server stub");
        let tarball = base.join(format!("bundle-{version}.tar.gz"));
        let status = Command::new("tar")
            .env("COPYFILE_DISABLE", "1")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(&src)
            .args(["VERSION", "core"])
            .status()
            .expect("run tar");
        assert!(status.success(), "tar failed");
        std::fs::read(&tarball).expect("read tarball")
    }

    #[cfg(unix)]
    fn sha_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn install_then_rollback_in_temp_home() {
        let base = unique_dir("install");
        let home = base.join("home");
        std::fs::create_dir_all(&home).expect("home");
        let root = home.join(".llmide-server");
        let bundle_v1 = make_bundle(&base, "1.0.0");
        let bundle_v2 = make_bundle(&base, "2.0.0");

        // A path-like version is refused before anything is written.
        let (ok, out) =
            run_sh(INSTALL, &home, &install_stdin("../evil", &sha_hex(&bundle_v1), &bundle_v1));
        assert!(!ok);
        assert!(out.contains("__LLMIDE_INSTALL__=invalid"), "{out}");

        // A wrong checksum removes the part file and reports checksum.
        let (ok, out) =
            run_sh(INSTALL, &home, &install_stdin("1.0.0", &"0".repeat(64), &bundle_v1));
        assert!(!ok);
        assert!(out.contains("__LLMIDE_INSTALL__=checksum"), "{out}");
        assert!(!root.join("releases/.1.0.0.part").exists());

        for (version, bundle) in [("1.0.0", &bundle_v1), ("2.0.0", &bundle_v2)] {
            let stdin = install_stdin(version, &sha_hex(bundle), bundle);
            let (ok, out) = run_sh(INSTALL, &home, &stdin);
            assert!(ok, "install {version}: {out}");
            assert!(out.contains("__LLMIDE_INSTALL__=ok"), "{out}");
        }
        assert_eq!(
            std::fs::read_link(root.join("current")).expect("current link"),
            root.join("releases/2.0.0")
        );
        assert!(root.join("releases/2.0.0/core/node/node").is_file());
        assert_eq!(mode_of(&root), 0o700);
        assert_eq!(mode_of(&root.join("releases")), 0o700);
        assert_eq!(mode_of(&root.join("data")), 0o700);

        // PROBE reports both releases and the current one.
        let (ok, out) = run_sh(PROBE, &home, b"");
        assert!(ok, "{out}");
        let probe = parse_probe(&out).expect("real probe output parses");
        assert_eq!(probe.installed, vec!["1.0.0".to_string(), "2.0.0".to_string()]);
        assert_eq!(probe.current.as_deref(), Some("2.0.0"));

        // ROLLBACK moves current to the other release.
        let (ok, out) = run_sh(ROLLBACK, &home, b"");
        assert!(ok, "{out}");
        assert!(out.contains("__LLMIDE_ROLLBACK__=1.0.0"), "{out}");
        assert_eq!(
            std::fs::read_link(root.join("current")).expect("current link"),
            root.join("releases/1.0.0")
        );

        // STATUS with no state file, and STOP with nothing running.
        let (ok, out) = run_sh(STATUS, &home, b"");
        assert!(ok, "{out}");
        assert!(out.contains("__LLMIDE_STATE__={\"running\":false}"), "{out}");
        let (ok, out) = run_sh(STOP, &home, b"");
        assert!(ok, "{out}");
        assert!(out.contains("__LLMIDE_STOP__=not_running"), "{out}");

        // UNINSTALL removes releases and current but keeps data.
        let (ok, out) = run_sh(UNINSTALL, &home, b"");
        assert!(ok, "{out}");
        assert!(out.contains("__LLMIDE_UNINSTALL__=ok"), "{out}");
        assert!(!root.join("releases").exists());
        assert!(std::fs::symlink_metadata(root.join("current")).is_err());
        assert!(root.join("data").is_dir());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn start_rejects_bad_header_and_wrong_release() {
        let base = unique_dir("start");
        let home = base.join("home");
        let root = home.join(".llmide-server");
        std::fs::create_dir_all(root.join("releases/2.0.0/core/node")).expect("release");
        std::os::unix::fs::symlink(root.join("releases/2.0.0"), root.join("current"))
            .expect("current link");

        let (ok, out) = run_sh(START, &home, format!("../x {VALID_NONCE}\n").as_bytes());
        assert!(!ok);
        assert!(out.contains("__LLMIDE_START__=invalid"), "{out}");

        let (ok, out) = run_sh(START, &home, format!("1.0.0 short\n").as_bytes());
        assert!(!ok);
        assert!(out.contains("__LLMIDE_START__=invalid"), "{out}");

        // Asking for 1.0.0 while current points at 2.0.0 must not start anything.
        let (ok, out) = run_sh(START, &home, format!("1.0.0 {VALID_NONCE}\n").as_bytes());
        assert!(!ok);
        assert!(out.contains("__LLMIDE_START__=version-mismatch"), "{out}");
        assert!(!root.join("state.json").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn marker_must_start_the_line() {
        let out = "__LLMIDE_UNAME__=Linux x86_64\n__LLMIDE_FREE_MB__=5000\n\
                   __LLMIDE_INSTALLED__=\n__LLMIDE_CURRENT__=\n__LLMIDE_CLAUDE__=\n\
                   noise __LLMIDE_FREE_MB__=999999\n";
        let probe = parse_probe(out).expect("probe parses");
        assert_eq!(probe.free_mb, 5000);

        let only_mid_line = "__LLMIDE_UNAME__=Linux x86_64\nnoise __LLMIDE_FREE_MB__=999999\n\
                             __LLMIDE_INSTALLED__=\n__LLMIDE_CURRENT__=\n__LLMIDE_CLAUDE__=\n";
        let err = parse_probe(only_mid_line).expect_err("a mid-line marker is not a result");
        assert_eq!(err.code, PROBE_FAILED);
    }

    #[test]
    fn claude_text_cannot_spoof() {
        let out = "__LLMIDE_UNAME__=Darwin arm64\n__LLMIDE_FREE_MB__=5000\n\
                   __LLMIDE_INSTALLED__=\n__LLMIDE_CURRENT__=\n\
                   __LLMIDE_CLAUDE__=2.1.0 __LLMIDE_UNAME__=Linux x86_64\n";
        let probe = parse_probe(out).expect("probe parses");
        assert_eq!(probe.os, "Darwin");
        assert_eq!(probe.arch, "arm64");
        assert_eq!(
            probe.claude,
            ClaudeState::Installed { version: "2.1.0 __LLMIDE_UNAME__=Linux x86_64".to_string() }
        );
    }

    #[test]
    fn start_failure_exited_carries_the_log_line() {
        let out = "__LLMIDE_START__=exited\n__LLMIDE_LOG__=Error: listen EADDRINUSE\n";
        let (value, log) = parse_start_failure(out).expect("a failure");
        assert_eq!(value, "exited");
        assert_eq!(log.as_deref(), Some("Error: listen EADDRINUSE"));
    }

    #[test]
    fn start_failure_timeout_has_no_log() {
        let (value, log) = parse_start_failure("__LLMIDE_START__=timeout\n").expect("a failure");
        assert_eq!(value, "timeout");
        assert_eq!(log, None);
        let invalid = parse_start_failure("__LLMIDE_START__=invalid\n").expect("a failure");
        assert_eq!(invalid.0, "invalid");
    }

    #[test]
    fn start_success_is_not_a_failure() {
        let out = "__LLMIDE_STATE__={\"running\":true,\"port\":3461,\"pid\":77,\"nonce\":\"abcdefgh12345678\",\"version\":\"1.2.3\"}\n";
        assert!(parse_start_failure(out).is_none());
    }

    #[test]
    fn parse_stop_maps_the_three_results() {
        assert_eq!(parse_stop("__LLMIDE_STOP__=stopped\n").expect("ok"), "stopped");
        assert_eq!(parse_stop("__LLMIDE_STOP__=not_running\n").expect("ok"), "not_running");
        let unknown = parse_stop("__LLMIDE_STOP__=unknown\n").expect_err("unknown is an error");
        assert_eq!(unknown.code, "SSH_STOP_UNKNOWN");
        let missing = parse_stop("nothing\n").expect_err("no marker is an error");
        assert_eq!(missing.code, "SSH_STOP_FAILED");
    }

    #[test]
    fn stop_and_uninstall_never_delete_state_without_a_result() {
        // Guards the rule in text: the only removal of state.json sits after a verified exit.
        let stop = STOP;
        assert!(stop.contains("state.json is the only record"));
        assert!(stop.contains("__LLMIDE_STOP__=unknown"));
        assert!(UNINSTALL.contains("stop_core || exit 1"));
    }

    #[cfg(unix)]
    #[test]
    fn install_failure_leaves_no_partial_release() {
        let base = unique_dir("truncated");
        let home = base.join("home");
        std::fs::create_dir_all(&home).expect("home");
        let root = home.join(".llmide-server");
        let bundle = make_bundle(&base, "3.0.0");

        // Header matches the real bundle but the body is cut short: the checksum refuses it.
        let cut = &bundle[..bundle.len() / 2];
        let (ok, out) = run_sh(INSTALL, &home, &install_stdin("3.0.0", &sha_hex(&bundle), cut));
        assert!(!ok);
        assert!(out.contains("__LLMIDE_INSTALL__=checksum"), "{out}");

        // Garbage whose checksum matches the header: tar refuses it.
        let garbage = b"not a tarball".to_vec();
        let stdin = install_stdin("3.0.0", &sha_hex(&garbage), &garbage);
        let (ok, out) = run_sh(INSTALL, &home, &stdin);
        assert!(!ok);
        assert!(out.contains("__LLMIDE_INSTALL__=unpack"), "{out}");

        assert!(!root.join("releases/.3.0.0.part").exists());
        assert!(!root.join("releases/.3.0.0.stage").exists());
        assert!(!root.join("releases/3.0.0").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn install_failure_without_a_marker_prints_failed() {
        let base = unique_dir("blocked");
        let home = base.join("home");
        let root = home.join(".llmide-server");
        std::fs::create_dir_all(&root).expect("root");
        // A file where the releases directory must go makes INSTALL fail before any marker.
        std::fs::write(root.join("releases"), b"in the way").expect("blocker");
        let bundle = make_bundle(&base, "3.0.0");
        let (ok, out) = run_sh(INSTALL, &home, &install_stdin("3.0.0", &sha_hex(&bundle), &bundle));
        assert!(!ok);
        assert!(out.contains("__LLMIDE_INSTALL__=failed"), "{out}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn probe_finds_claude_in_local_bin_and_filters_it() {
        use std::os::unix::fs::PermissionsExt;
        let base = unique_dir("claude");
        let home = base.join("home");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).expect("local bin");
        let claude = bin.join("claude");
        // The stub's output carries a marker-looking text; the filter must keep it from being one.
        std::fs::write(&claude, "#!/bin/sh\necho '2.9.9 __LLMIDE_UNAME__=Linux x86_64'\n").expect("stub");
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let (ok, out) = run_sh(PROBE, &home, b"");
        assert!(ok, "{out}");
        let probe = parse_probe(&out).expect("probe parses");
        assert_eq!(
            probe.claude,
            ClaudeState::Installed { version: "2.9.9 __LLMIDE_UNAME__Linux x86_64".to_string() }
        );
        let uname = std::process::Command::new("uname").arg("-s").output().expect("uname");
        assert_eq!(probe.os, String::from_utf8_lossy(&uname.stdout).trim());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Writes the seven constants to `LLMIDE_DUMP_SCRIPTS_DIR` for a manual smoke test on a Linux
    /// host. Ignored by default and a no-op when the variable is unset.
    #[test]
    #[ignore = "writes the scripts for a manual Linux smoke test; set LLMIDE_DUMP_SCRIPTS_DIR"]
    fn dump_scripts() {
        let Some(dir) = std::env::var_os("LLMIDE_DUMP_SCRIPTS_DIR") else {
            return;
        };
        for (name, body) in all_scripts() {
            std::fs::write(std::path::Path::new(&dir).join(format!("{name}.sh")), body)
                .expect("write script");
        }
    }

    // ---- Core launch tests (unix). The stop and reuse tests need /proc, so they stay Linux-only ----

    #[cfg(unix)]
    static LINUX_CORE_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(unix)]
    fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
        let paths = std::env::var_os("PATH")?;
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    }

    /// A home with one release whose `node` stays alive as a stand-in core. It runs the real node
    /// only for the port probe. A `curl` stub answers `/health`. Returns None when there is no node
    /// to borrow, so the test is skipped rather than failed.
    #[cfg(unix)]
    fn live_home(tag: &str) -> Option<std::path::PathBuf> {
        use std::os::unix::fs::PermissionsExt;
        let real_node = find_on_path("node")?;
        let base = unique_dir(tag);
        let home = base.join("home");
        let root = home.join(".llmide-server");
        let release = root.join("releases/1.0.0");
        std::fs::create_dir_all(release.join("core/node")).expect("node dir");
        std::fs::create_dir_all(release.join("core/root/extension")).expect("extension dir");
        std::fs::write(release.join("core/root/extension/server.mjs"), "").expect("server");
        let node = release.join("core/node/node");
        // The core's own invocation (not the port probe, which is `-e`) records the environment it
        // was started with, so a test can check what START exported.
        let body = format!(
            "#!/bin/sh\nif [ \"$1\" = \"-e\" ]; then exec '{real}' \"$@\"; fi\n\
             env > \"$HOME/core-env.tmp\" && mv \"$HOME/core-env.tmp\" \"$HOME/core-env.txt\"\n\
             exec '{real}' -e 'setInterval(function () {{}}, 1000)' \"$@\"\n",
            real = real_node.display()
        );
        std::fs::write(&node, body).expect("node stub");
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        std::os::unix::fs::symlink(&release, root.join("current")).expect("current");
        let stubs = home.join("stubs");
        std::fs::create_dir_all(&stubs).expect("stubs");
        let curl = stubs.join("curl");
        std::fs::write(&curl, "#!/bin/sh\nexit 0\n").expect("curl stub");
        std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        Some(home)
    }

    /// Kills whatever core the home's state.json recorded and removes the temp tree, even when the
    /// test panicked part way through.
    #[cfg(unix)]
    struct CoreCleanup(std::path::PathBuf);

    #[cfg(unix)]
    impl Drop for CoreCleanup {
        fn drop(&mut self) {
            let state_path = self.0.join("home/.llmide-server/state.json");
            if let Ok(raw) = std::fs::read_to_string(&state_path) {
                if let Ok(state) = parse_core_state(&format!("__LLMIDE_STATE__={}", raw.trim())) {
                    if let Some(pid) = state.pid {
                        let _ = std::process::Command::new("kill")
                            .args(["-KILL", &pid.to_string()])
                            .status();
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Puts a `setsid` stub on the test PATH when the host has none (macOS). The stub only execs its
    /// arguments, so START's launch line runs unchanged. Linux uses the real `setsid`.
    #[cfg(unix)]
    fn ensure_setsid(home: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        if find_on_path("setsid").is_some() {
            return;
        }
        let stubs = home.join("stubs");
        std::fs::create_dir_all(&stubs).expect("stubs");
        let stub = stubs.join("setsid");
        std::fs::write(&stub, "#!/bin/sh\nexec \"$@\"\n").expect("setsid stub");
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    /// The core is started with the environment the local spawn gives it, and the extension pin is
    /// written before the launch. Runs on macOS and Linux.
    #[cfg(unix)]
    #[test]
    fn start_launches_the_core_with_the_local_environment() {
        let _guard = LINUX_CORE_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(home) = live_home("env") else {
            eprintln!("skipped: no node on PATH to borrow");
            return;
        };
        let _cleanup = CoreCleanup(home.parent().expect("base").to_path_buf());
        ensure_setsid(&home);
        let (ok, out) = run_sh(START, &home, &start_stdin("1.0.0", VALID_NONCE, b"{}\n"));
        assert!(ok, "{out}");

        // The curl stub answers at once, so START can return before the background stub has run `env`.
        let env_file = home.join("core-env.txt");
        let mut waited = 0;
        while !env_file.exists() && waited < 100 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            waited += 1;
        }
        let env_text = std::fs::read_to_string(&env_file).expect("the stub saw the core's environment");
        let env: std::collections::HashMap<&str, &str> =
            env_text.lines().filter_map(|line| line.split_once('=')).collect();
        let home_text = home.display().to_string();
        let path_head = format!(
            "{home_text}/.local/bin:{home_text}/.npm-global/bin:{home_text}/.claude/local:/usr/local/bin:"
        );
        assert!(env["PATH"].starts_with(&path_head), "PATH was {}", env["PATH"]);
        assert_eq!(env.get("LLMIDE_CORS_ORIGINS"), Some(&START_CORS_VALUE));
        assert_eq!(env.get("LLMIDE_REGISTRATION_SINGLE_OWNER"), Some(&"1"));
        assert_eq!(env.get("LLMIDE_EXT_ACTIVE_SET"), Some(&"1"));
        assert!(!env.contains_key("LLMIDE_PARENT_PID"), "the server core must outlive the desktop");

        let data = home.join(".llmide-server/data");
        let pin = data.join(EXTENSION_IDS_FILE);
        let expected = serde_json::json!({ "ids": [EXTENSION_ID] }).to_string();
        assert_eq!(std::fs::read_to_string(&pin).expect("pin file"), expected);
        assert_eq!(mode_of(&pin), 0o600);
        assert!(!data.join(format!("{EXTENSION_IDS_FILE}.tmp")).exists(), "no temp file left");
    }

    #[cfg(target_os = "linux")]
    fn pid_is_running(pid: u32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => {
                let state = stat.rsplit(')').next().and_then(|rest| rest.trim_start().chars().next());
                state.is_some() && state != Some('Z')
            }
            Err(_) => false,
        }
    }

    #[cfg(target_os = "linux")]
    fn started_pid(out: &str) -> u32 {
        parse_core_state(out).expect("state parses").pid.expect("pid")
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn start_happy_path_writes_state() {
        let _guard = LINUX_CORE_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(home) = live_home("happy") else {
            eprintln!("skipped: no node on PATH to borrow");
            return;
        };
        let _cleanup = CoreCleanup(home.parent().expect("base").to_path_buf());
        let (ok, out) = run_sh(START, &home, &start_stdin("1.0.0", VALID_NONCE, b"{}\n"));
        assert!(ok, "{out}");
        let state = parse_core_state(&out).expect("START prints a state line");
        assert!(state.running);
        let port = state.port.expect("port");
        assert!((3460..=3479).contains(&port), "port {port}");
        assert_eq!(mode_of(&home.join(".llmide-server/state.json")), 0o600);

        let (ok, status) = run_sh(STATUS, &home, b"");
        assert!(ok, "{status}");
        assert!(parse_core_state(&status).expect("status parses").running, "{status}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn start_reuses_a_live_core() {
        let _guard = LINUX_CORE_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(home) = live_home("reuse") else {
            eprintln!("skipped: no node on PATH to borrow");
            return;
        };
        let _cleanup = CoreCleanup(home.parent().expect("base").to_path_buf());
        let (ok, first) = run_sh(START, &home, &start_stdin("1.0.0", VALID_NONCE, b"{}\n"));
        assert!(ok, "{first}");
        let (ok, second) = run_sh(START, &home, &start_stdin("1.0.0", VALID_NONCE, b"{}\n"));
        assert!(ok, "{second}");
        // The same pid comes back, so no second core was started.
        assert_eq!(started_pid(&second), started_pid(&first));
        assert_eq!(second.trim(), first.trim());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stop_kills_and_reports_stopped() {
        let _guard = LINUX_CORE_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(home) = live_home("stop") else {
            eprintln!("skipped: no node on PATH to borrow");
            return;
        };
        let _cleanup = CoreCleanup(home.parent().expect("base").to_path_buf());
        let (ok, started) = run_sh(START, &home, &start_stdin("1.0.0", VALID_NONCE, b"{}\n"));
        assert!(ok, "{started}");
        let pid = started_pid(&started);

        let (ok, stop) = run_sh(STOP, &home, b"");
        assert!(ok, "{stop}");
        assert_eq!(parse_stop(&stop).expect("stopped"), "stopped");
        assert!(!pid_is_running(pid), "pid {pid} still running");

        let (ok, status) = run_sh(STATUS, &home, b"");
        assert!(ok, "{status}");
        assert!(!parse_core_state(&status).expect("status parses").running, "{status}");
    }

    // ---- ADD_KEY: the one public line that switches a password login to a key (unix only) ----

    const ADD_KEY_LINE: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderKeyBody llmide-desktop";

    #[cfg(unix)]
    fn add_key_home(tag: &str) -> std::path::PathBuf {
        let base = unique_dir(tag);
        let home = base.join("home");
        std::fs::create_dir_all(&home).expect("create home");
        home
    }

    #[cfg(unix)]
    #[test]
    fn add_key_is_idempotent() {
        let home = add_key_home("addkey-idem");
        let stdin = format!("{ADD_KEY_LINE}\n");
        let (ok, out) = run_sh(ADD_KEY, &home, stdin.as_bytes());
        assert!(ok, "{out}");
        assert!(out.contains("__LLMIDE_ADDKEY__=added"), "{out}");
        let (ok, out) = run_sh(ADD_KEY, &home, stdin.as_bytes());
        assert!(ok, "{out}");
        assert!(out.contains("__LLMIDE_ADDKEY__=present"), "{out}");

        let auth = home.join(".ssh").join("authorized_keys");
        assert_eq!(std::fs::read_to_string(&auth).expect("read"), stdin);
        assert_eq!(mode_of(&auth), 0o600);
        assert_eq!(mode_of(&home.join(".ssh")), 0o700);
        let _ = std::fs::remove_dir_all(home.parent().expect("base"));
    }

    #[cfg(unix)]
    #[test]
    fn add_key_rejects_multiline() {
        let home = add_key_home("addkey-reject");
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(&ssh).expect("create .ssh");
        let auth = ssh.join("authorized_keys");
        let before = "ssh-rsa AAAAOLDKEY old-laptop\n";
        std::fs::write(&auth, before).expect("seed");
        let cases = [
            format!("{ADD_KEY_LINE}\n{ADD_KEY_LINE}\n"),
            format!("{ADD_KEY_LINE}\nssh-ed25519 AAAAsecond second\n"),
            "ssh-rsa AAAAB3NzaC1yc2E llmide-desktop\n".to_string(),
            format!("command=\"echo x\" {ADD_KEY_LINE}\n"),
            "ssh-ed25519 AAAAC3NzaC1 my key\n".to_string(),
            "ssh-ed25519 AAAAC3NzaC1 comment\textra\n".to_string(),
            "ssh-ed25519 AAAAC3NzaC1 bad$comment\n".to_string(),
        ];
        for stdin in cases {
            let (ok, out) = run_sh(ADD_KEY, &home, stdin.as_bytes());
            assert!(!ok, "accepted {stdin:?}: {out}");
            assert!(out.contains("__LLMIDE_ADDKEY__=invalid"), "{stdin:?}: {out}");
            assert_eq!(std::fs::read_to_string(&auth).expect("read"), before, "{stdin:?} changed the file");
        }
        let _ = std::fs::remove_dir_all(home.parent().expect("base"));
    }

    #[cfg(unix)]
    #[test]
    fn add_key_keeps_existing_lines() {
        let home = add_key_home("addkey-keep");
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(&ssh).expect("create .ssh");
        let auth = ssh.join("authorized_keys");
        // No trailing newline: the new key must start on its own line.
        std::fs::write(&auth, "ssh-rsa AAAAOLDKEY old-laptop").expect("seed");
        let stdin = format!("{ADD_KEY_LINE}\n");
        let (ok, out) = run_sh(ADD_KEY, &home, stdin.as_bytes());
        assert!(ok, "{out}");
        assert!(out.contains("__LLMIDE_ADDKEY__=added"), "{out}");
        assert_eq!(
            std::fs::read_to_string(&auth).expect("read"),
            format!("ssh-rsa AAAAOLDKEY old-laptop\n{ADD_KEY_LINE}\n")
        );
        let _ = std::fs::remove_dir_all(home.parent().expect("base"));
    }

    #[test]
    fn parse_add_key_maps_results() {
        assert_eq!(parse_add_key("__LLMIDE_ADDKEY__=added\n").expect("added"), "added");
        assert_eq!(parse_add_key("banner\n__LLMIDE_ADDKEY__=present\n").expect("present"), "present");
        let invalid = parse_add_key("__LLMIDE_ADDKEY__=invalid\n").unwrap_err();
        assert_eq!(invalid.code, "SSH_KEY_INVALID");
        assert_eq!(invalid.message, "The new key was not accepted.");
        for out in ["__LLMIDE_ADDKEY__=failed\n", "", "noise __LLMIDE_ADDKEY__=added\n"] {
            let err = parse_add_key(out).unwrap_err();
            assert_eq!(err.code, "SSH_KEY_INSTALL_FAILED", "{out:?}");
            assert_eq!(err.message, "The key could not be added on the server.");
        }
    }
}

#[cfg(test)]
mod uninstall_marker_tests {
    use super::*;

    #[test]
    fn uninstall_needs_its_own_ok_marker() {
        assert!(parse_uninstall("__LLMIDE_STOP__=not_running\n__LLMIDE_UNINSTALL__=ok\n").is_ok());
        // The STOP line alone means the core was stopped and the removal never ran.
        let stop_only = parse_uninstall("__LLMIDE_STOP__=stopped\n").unwrap_err();
        assert_eq!(stop_only.code, "SSH_UNINSTALL_FAILED");
        assert_eq!(stop_only.message, "The server files could not be removed.");
        // A marker must start its line.
        assert!(parse_uninstall("noise __LLMIDE_UNINSTALL__=ok\n").is_err());
    }
}
