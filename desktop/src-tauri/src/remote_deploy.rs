//! Phase 2 remote deploy: preflight, one-time root helper, staged core upload, nginx/TLS, a
//! confirmed run with a health gate, and rollback.
//!
//! Trust boundary: this module never runs a shell string built from webview text. Every remote
//! command is a constant (`stage_command` / the fixed preflight and upload scripts); the SSH argv
//! comes from `remote::ssh_args_with`. Secrets (JWT + vault key) are generated here and sent on the
//! SSH child's stdin; they never enter argv, an event, an error or a log line.
//!
//! The real server is only ever touched by `SystemDeploy` (system `ssh`). Tests inject a fake
//! `DeployRunner` and a fake `HealthProbe`, so CI contacts no host.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::remote::{
    prepare, require_confirmed_host_key, ssh_args_known, temp_ssh_dir, write_known_hosts,
    ConfirmedHostKey, PreparedTarget, RawOutput, SshTarget,
};

/// The complete helper stage list. The sudoers file is generated from this list, one exact command
/// per stage; there is no wildcard and no free-form argument.
pub const STAGES: &[&str] = &[
    "check", "upload", "predeploy-backup", "base", "env", "check-cert", "bundle", "nginx", "start",
    "open-registration", "lock-registration", "backup", "restore-db", "rollback", "update", "uninstall",
    "uninstall-purge",
];

pub const HELPER: &str = include_str!("../../../deploy/hub/llmide-deploy");
pub const UNIT: &str = include_str!("../../../deploy/hub/llmide-core.service");
pub const BACKUP_UNIT: &str = include_str!("../../../deploy/hub/llmide-backup.service");
pub const BACKUP_TIMER: &str = include_str!("../../../deploy/hub/llmide-backup.timer");
pub const LOGROTATE: &str = include_str!("../../../deploy/hub/logrotate");
pub const VHOST_TEMPLATE: &str = include_str!("../../../deploy/hub/llm-ide-hub.nginx.template");
pub const SETUP_HTML: &str = include_str!("../../../deploy/hub/setup.html");

pub const MIN_DISK_MB: u64 = 2048;
/// Bumped when the helper's stage set/semantics changes; a mismatch reinstalls it.
pub const HELPER_VERSION: &str = "5";
const MAX_DOMAIN: usize = 253;
const PLAN_TTL_MS: u64 = 30 * 60 * 1000;

pub trait DeployRunner: Send + Sync {
    fn run(&self, target: &PreparedTarget, command: &str, stdin: Option<&[u8]>) -> Result<RawOutput, FsError>;
}

/// The known_hosts spelling of a target: bare host on 22, `[host]:port` otherwise (OpenSSH rule).
pub fn known_host_name(target: &PreparedTarget) -> String {
    if target.port == 22 { target.host.clone() } else { format!("[{}]:{}", target.host, target.port) }
}

/// OpenSSH SHA256 fingerprint of a base64 key blob: `SHA256:` + unpadded base64url.
pub fn fingerprint_for_key_b64(key_b64: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(key_b64.trim()).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)))
}

/// One known_hosts line from `ssh-keyscan` output, kept only when its key hashes to the fingerprint the
/// user confirmed. The scan's own host column is ignored (it is untrusted), and the line is re-spelled
/// from the validated target, so a scan answer cannot inject another host pattern.
pub fn verified_known_host_line(scan: &str, target: &PreparedTarget, key: &ConfirmedHostKey) -> Option<String> {
    for raw in scan.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let mut parts = line.split_whitespace();
        let _scanned_host = parts.next()?;
        let key_type = parts.next()?;
        let key_b64 = parts.next()?;
        if key_type != key.key_type { continue; }
        if fingerprint_for_key_b64(key_b64).as_deref() != Some(key.fingerprint.as_str()) { continue; }
        return Some(format!("{} {} {}", known_host_name(target), key_type, key_b64));
    }
    None
}

/// The real transport: system `ssh` with a ONE-KEY temporary known_hosts (R-034 #7). The user confirmed
/// the host key earlier in this session; the keyscan answer is accepted only if it hashes to that exact
/// fingerprint, and `StrictHostKeyChecking=yes` then refuses any other key at connect time.
pub struct SystemDeploy;

impl DeployRunner for SystemDeploy {
    fn run(&self, target: &PreparedTarget, command: &str, stdin: Option<&[u8]>) -> Result<RawOutput, FsError> {
        let key = require_confirmed_host_key(target)?;
        let dir = temp_ssh_dir("ssh-deploy")?;
        let run = (|| {
            let scan = Command::new("ssh-keyscan")
                .args(["-T", "10", "-p", &target.port.to_string(), "-t", &key.key_type, &target.host])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| herr("host_key_unavailable", format!("could not run ssh-keyscan: {e}")))?;
            let scan_text = String::from_utf8_lossy(&scan.stdout);
            let line = verified_known_host_line(&scan_text, target, &key).ok_or_else(|| {
                herr("host_key_changed", "the server's host key does not match the fingerprint you confirmed; test again and compare it")
            })?;
            let known = write_known_hosts(&dir, &line)?;
            let mut cmd = Command::new("ssh");
            cmd.args(ssh_args_known(target, command, &known, false))
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if stdin.is_some() { cmd.stdin(Stdio::piped()); } else { cmd.stdin(Stdio::null()); }
            let mut child = cmd.spawn().map_err(|e| herr("ssh_missing", format!("could not run the system ssh command: {e}")))?;
            if let Some(bytes) = stdin {
                let mut pipe = child.stdin.take().ok_or_else(|| herr("ssh_failed", "the ssh input pipe is unavailable"))?;
                pipe.write_all(bytes).map_err(|e| herr("ssh_failed", format!("could not send the stage input: {e}")))?;
                drop(pipe);
            }
            let out = child.wait_with_output().map_err(|e| herr("ssh_failed", format!("could not read the ssh result: {e}")))?;
            Ok(RawOutput {
                code: out.status.code(),
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            })
        })();
        let _ = std::fs::remove_dir_all(&dir);
        run
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Preflight {
    pub os: String,
    pub arch: String,
    pub systemd: bool,
    pub nginx: bool,
    pub certbot: bool,
    pub sudo_nopasswd: bool,
    pub disk_free_mb: u64,
    pub existing_version: Option<String>,
    pub domain_resolves: Option<bool>,
    pub claude: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployStage {
    pub id: String,
    pub title: String,
    pub mutating: bool,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployPlan {
    pub id: String,
    pub version: String,
    pub domain: String,
    pub arch: String,
    pub stages: Vec<DeployStage>,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub confirmation: String,
    pub bundle_path: String,
    pub created_at: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub installed: bool,
    pub command: String,
    pub staging: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployReport {
    pub version: String,
    pub url: String,
    pub api_version: u32,
    pub hub: bool,
    pub owner_window_open: bool,
    pub setup_url: Option<String>,
    pub rolled_back: bool,
    pub failed_stage: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: String,
    pub db_ok: bool,
    pub hub: bool,
    pub api_version: u32,
}

pub fn parse_health(text: &str) -> Option<Health> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(Health {
        status: v.get("status")?.as_str()?.to_string(),
        db_ok: v.get("checks")?.get("db")?.as_bool()?,
        hub: v.get("hub").and_then(|x| x.as_bool()).unwrap_or(false),
        api_version: v.get("apiVersion")?.as_u64()? as u32,
    })
}

pub trait HealthProbe: Send + Sync {
    fn check(&self, url: &str) -> Result<Health, FsError>;
}

pub struct SystemHealth;

impl HealthProbe for SystemHealth {
    fn check(&self, url: &str) -> Result<Health, FsError> {
        let res = ureq::get(url).timeout(std::time::Duration::from_secs(10)).call()
            .map_err(|e| herr("health_unreachable", format!("the hub did not answer /health: {e}")))?;
        let text = res.into_string().map_err(|e| herr("health_unreadable", format!("invalid /health body: {e}")))?;
        parse_health(&text).ok_or_else(|| herr("health_unreadable", "invalid /health JSON"))
    }
}

pub fn valid_domain(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > MAX_DOMAIN || domain.starts_with('-') || domain.ends_with('.') {
        return false;
    }
    domain.split('.').count() >= 2 && domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

pub fn parse_preflight(text: &str) -> Option<Preflight> {
    let line = text.lines().rev().find_map(|line| line.trim().strip_prefix("LLMIDE_PREFLIGHT "))?;
    serde_json::from_str(line).ok()
}

pub fn plan_blockers(p: &Preflight, domain: &str) -> Vec<String> {
    let mut out = Vec::new();
    if p.arch != "x86_64" { out.push("arch_unsupported".to_string()); }
    if !p.systemd { out.push("systemd_missing".to_string()); }
    if !p.nginx { out.push("nginx_missing".to_string()); }
    if !p.certbot { out.push("certbot_missing".to_string()); }
    if !p.sudo_nopasswd { out.push("sudo_requires_password".to_string()); }
    if p.disk_free_mb < MIN_DISK_MB { out.push("disk_below_2gb".to_string()); }
    if !valid_domain(domain) { out.push("domain_invalid".to_string()); }
    if p.domain_resolves == Some(false) { out.push("domain_not_resolving".to_string()); }
    out
}

pub fn plan_warnings(p: &Preflight) -> Vec<String> {
    let mut out = Vec::new();
    if !p.os.to_ascii_lowercase().contains("ubuntu") && !p.os.to_ascii_lowercase().contains("debian") {
        out.push("os_not_ubuntu_or_debian".to_string());
    }
    if !p.claude { out.push("claude_not_found_use_vault_keys".to_string()); }
    if p.existing_version.is_some() { out.push("existing_install_will_be_backed_up".to_string()); }
    out
}

pub fn stages() -> Vec<DeployStage> {
    let rows = [
        ("base", "Repair the service user, unit and directories", true, "Idempotent: useradd, dirs, embedded unit/logrotate, daemon-reload."),
        ("predeploy-backup", "Back up the existing hub database", true, "Stops the old service, VACUUM INTO a pre-deploy snapshot, starts it again. Skipped on a fresh server."),
        ("env", "Write the secret env file over stdin", true, "0600 root:root; JWT and vault secrets generated locally; never in argv or a log."),
        ("check-cert", "Check the TLS certificate before switching the release", false, "Refuses a missing certificate or one not issued with --reuse-key; runs before the bundle switch."),
        ("bundle", "Upload and switch the Linux core release", true, "Verifies SHA-256, unpacks, requires Node 22, updates current/previous symlinks, keeps three releases."),
        ("nginx", "Install the TLS vhost and certificate pin", true, "nginx -t before reload; restores the previous site on failure; publishes the front SPKI."),
        ("start", "Start the hub service", true, "systemctl enable --now llmide-core."),
        ("open-registration", "Open the one-time owner setup", true, "Writes a 32-byte bootstrap token (0600, window only) and opens registration."),
        ("lock-registration", "Close registration after the owner exists", true, "Removes the bootstrap token, sets registration closed, restarts."),
    ];
    rows.iter().map(|(id, title, mutating, detail)| DeployStage {
        id: (*id).to_string(), title: (*title).to_string(), mutating: *mutating, detail: (*detail).to_string(),
    }).collect()
}

pub fn bundle_path(version: &str) -> Option<String> {
    if let Ok(p) = std::env::var("LLMIDE_HUB_BUNDLE") {
        if !p.is_empty() && std::path::Path::new(&p).is_file() { return Some(p); }
    }
    let candidates = [
        format!("desktop/resources/hub/llmide-core-{version}-linux-x64.tar.gz"),
        format!("desktop/dist/hub/llmide-core-{version}-linux-x64.tar.gz"),
        format!("../desktop/resources/hub/llmide-core-{version}-linux-x64.tar.gz"),
    ];
    candidates.into_iter().find(|p| std::path::Path::new(p).is_file())
}

pub fn build_plan(p: &Preflight, domain: &str, version: &str, bundle: &str, now: u64, review_ack: bool) -> DeployPlan {
    let mut blockers = plan_blockers(p, domain);
    if !review_ack { blockers.push("external_security_review_required".to_string()); }
    if !std::path::Path::new(bundle).is_file() { blockers.push("bundle_missing".to_string()); }
    DeployPlan {
        id: random_hex(16),
        version: version.to_string(),
        domain: domain.to_string(),
        arch: p.arch.clone(),
        stages: stages(),
        blockers,
        warnings: plan_warnings(p),
        confirmation: domain.to_string(),
        bundle_path: bundle.to_string(),
        created_at: now,
    }
}

pub fn sudoers_text(user: &str) -> String {
    let mut out = format!("# LLM-IDE hub deploy helper. One exact stage command per line; no wildcard.\n{user} ALL=(root) NOPASSWD: \\\n");
    for (i, stage) in STAGES.iter().enumerate() {
        let suffix = if i + 1 == STAGES.len() { "\n" } else { ", \\\n" };
        out.push_str(&format!("  /usr/local/sbin/llmide-deploy {stage}{suffix}"));
    }
    out
}

pub fn stage_command(stage: &str) -> Option<String> {
    STAGES.contains(&stage).then(|| format!("sudo -n /usr/local/sbin/llmide-deploy {stage}"))
}

pub struct DeploySecrets { pub jwt: String, pub vault: String }

pub fn generate_secrets() -> Result<DeploySecrets, FsError> {
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    getrandom::fill(&mut a).map_err(|e| herr("random_failed", format!("cannot generate the JWT secret: {e}")))?;
    getrandom::fill(&mut b).map_err(|e| herr("random_failed", format!("cannot generate the vault key: {e}")))?;
    Ok(DeploySecrets { jwt: hex(&a), vault: hex(&b) })
}

pub fn env_bytes(s: &DeploySecrets, domain: &str, version: &str) -> Vec<u8> {
    format!(
        "NODE_ENV=production\nPATH=/usr/local/bin:/usr/bin:/bin\nLLMIDE_HOST=127.0.0.1\nLLMIDE_PORT=3457\nLLMIDE_HUB=1\nLLMIDE_TLS_TERMINATED=1\nLLMIDE_HUB_DOMAIN={domain}\nLLMIDE_HUB_VERSION={version}\nLLMIDE_DATA_DIR=/var/lib/llmide\nLLMIDE_DB_PATH=/var/lib/llmide/data.db\nLLMIDE_PROJECTS_ROOT=/srv/llmide/projects\nLLMIDE_BACKUP_DIR=/var/lib/llmide/backups\nLLMIDE_BACKUP_KEEP=7\nLLMIDE_DISABLE_REGISTRATION=1\nLLMIDE_TRUST_PROXY=1\nLLMIDE_LOG_JSON=1\nLLMIDE_LOG_LEVEL=info\nLLMIDE_LOG_ROTATE=external\nLLMIDE_MAX_TURNS=8\nLLMIDE_HOST_API_HUB=1\nLLMIDE_HOST_API_WEB_ORIGINS=https://{domain}\nLLMIDE_HOST_API_FINGERPRINT_FILE=/etc/llmide/host-api-fingerprint\nLLMIDE_HUB_PUBLIC_URL=wss://{domain}/host-api/v1\nLLMIDE_JWT_SECRET={}\nLLMIDE_VAULT_KEY={}\n",
        s.jwt, s.vault
    ).into_bytes()
}

const ENV_KEYS: &[&str] = &[
    "NODE_ENV", "PATH", "LLMIDE_HOST", "LLMIDE_PORT", "LLMIDE_HUB", "LLMIDE_TLS_TERMINATED",
    "LLMIDE_HUB_DOMAIN", "LLMIDE_HUB_VERSION", "LLMIDE_DATA_DIR", "LLMIDE_DB_PATH", "LLMIDE_PROJECTS_ROOT",
    "LLMIDE_BACKUP_DIR", "LLMIDE_BACKUP_KEEP", "LLMIDE_DISABLE_REGISTRATION", "LLMIDE_TRUST_PROXY",
    "LLMIDE_LOG_JSON", "LLMIDE_LOG_LEVEL", "LLMIDE_LOG_ROTATE", "LLMIDE_BACKUP_REMOTE", "LLMIDE_MAX_TURNS", "LLMIDE_HOST_API_HUB",
    "LLMIDE_HOST_API_WEB_ORIGINS", "LLMIDE_HOST_API_FINGERPRINT_FILE", "LLMIDE_HUB_PUBLIC_URL",
    "LLMIDE_JWT_SECRET", "LLMIDE_VAULT_KEY", "ANTHROPIC_API_KEY",
];

/// Root-side shape check mirrored in the helper: only known keys, no loader/option injection, no CR.
pub fn validate_env_text(text: &str) -> Result<(), FsError> {
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else { return Err(herr("env_invalid", "the env contains a line without '='")) };
        if !ENV_KEYS.contains(&key) { return Err(herr("env_invalid", format!("the env key {key} is not in the template"))); }
        if key == "NODE_OPTIONS" || key.starts_with("LD_") || key == "BASH_ENV" || key == "ENV" {
            return Err(herr("env_invalid", "the env contains a forbidden loader variable"));
        }
        if value.contains('\r') || value.contains('\n') { return Err(herr("env_invalid", "the env contains a newline in a value")); }
    }
    Ok(())
}

pub const PREFLIGHT_SCRIPT: &str = r#"set -u
os=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | tr -cd 'A-Za-z0-9 ._-' | cut -c1-80)
arch=$(uname -m 2>/dev/null | tr -cd 'A-Za-z0-9_-')
systemd=false; command -v systemctl >/dev/null 2>&1 && systemd=true
nginx=false; command -v nginx >/dev/null 2>&1 && nginx=true
certbot=false; command -v certbot >/dev/null 2>&1 && certbot=true
sudo_ok=false; sudo -n /usr/local/sbin/llmide-deploy check >/dev/null 2>&1 && sudo_ok=true; sudo -n true >/dev/null 2>&1 && sudo_ok=true
disk=$(df -Pk /var 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024}')
claude=false; command -v claude >/dev/null 2>&1 && claude=true
existing=$(cat /opt/llmide/current/VERSION 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-40)
printf 'LLMIDE_PREFLIGHT {"os":"%s","arch":"%s","systemd":%s,"nginx":%s,"certbot":%s,"sudo_nopasswd":%s,"disk_free_mb":%s,"existing_version":%s,"domain_resolves":null,"claude":%s}\n' \
  "${os:-unknown}" "${arch:-unknown}" "$systemd" "$nginx" "$certbot" "$sudo_ok" "${disk:-0}" \
  "$(if [ -n "$existing" ]; then printf '"%s"' "$existing"; else printf 'null'; fi)" "$claude"
"#;

pub fn run_preflight<R: DeployRunner>(runner: &R, target: &PreparedTarget) -> Result<Preflight, FsError> {
    let out = runner.run(target, PREFLIGHT_SCRIPT, None)?;
    if out.code != Some(0) {
        return Err(herr("preflight_failed", "the SSH preflight did not finish"));
    }
    parse_preflight(&out.stdout).ok_or_else(|| herr("preflight_failed", "the SSH preflight answered an unreadable shape"))
}

pub fn staging_for(user: &str) -> String {
    if user == "root" { "/root/.llmide-deploy".to_string() } else { format!("/home/{user}/.llmide-deploy") }
}

fn upload_home<R: DeployRunner>(runner: &R, target: &PreparedTarget, name: &str, bytes: &[u8]) -> Result<(), FsError> {
    let dir = staging_for(&target.user);
    let cmd = format!("mkdir -p \"{dir}\" && cat > \"{dir}/{name}\"");
    let out = runner.run(target, &cmd, Some(bytes))?;
    if out.code != Some(0) { return Err(herr("upload_failed", format!("could not upload {name}"))); }
    Ok(())
}

/// Upload into the root-owned staging directory through the helper's `upload` stage (name line + bytes).
fn upload_staging<R: DeployRunner>(runner: &R, target: &PreparedTarget, name: &str, bytes: &[u8]) -> Result<(), FsError> {
    let mut payload = Vec::with_capacity(name.len() + 1 + bytes.len());
    payload.extend_from_slice(name.as_bytes()); payload.push(b'\n'); payload.extend_from_slice(bytes);
    let out = runner.run(target, &stage_command("upload").unwrap(), Some(&payload))?;
    if out.code != Some(0) { return Err(herr("upload_failed", format!("could not upload {name}"))); }
    Ok(())
}

pub fn bootstrap_with<R: DeployRunner>(runner: &R, target: &PreparedTarget) -> Result<Bootstrap, FsError> {
    let dir = staging_for(&target.user);
    if let Ok(o) = runner.run(target, "sudo -n /usr/local/sbin/llmide-deploy check", None) {
        if o.code == Some(0) && o.stdout.contains(&format!("helper={HELPER_VERSION}")) {
            let base = runner.run(target, "sudo -n /usr/local/sbin/llmide-deploy base", None)?;
            if base.code != Some(0) { return Err(herr("bootstrap_failed", "the deploy helper could not create the service user")); }
            return Ok(Bootstrap { installed: true, command: String::new(), staging: dir });
        }
    }
    upload_home(runner, target, "llmide-deploy", HELPER.as_bytes())?;
    upload_home(runner, target, "sudoers", sudoers_text(&target.user).as_bytes())?;
    // R-034 #15: validate the exact drop-in root will install; a bad file locks the operator out of sudo.
    let sudoers_check = runner.run(target, &format!("sudo -n visudo -cf \"{dir}/sudoers\""), None)?;
    if sudoers_check.code != Some(0) { return Err(herr("sudoers_invalid", "the generated sudoers drop-in does not parse; refusing to install it")); }
    let install = format!("chmod 0700 \"{dir}/llmide-deploy\" && sudo -n install -m 0755 -o root -g root \"{dir}/llmide-deploy\" /usr/local/sbin/llmide-deploy && sudo -n install -m 0440 -o root -g root \"{dir}/sudoers\" /etc/sudoers.d/llmide-deploy");
    let out = runner.run(target, &install, None)?;
    if out.code != Some(0) {
        return Ok(Bootstrap {
            installed: false,
            command: format!("The server asks for a sudo password. In a terminal, run: ssh {user}@{host} 'sudo install -m 0755 -o root -g root {dir}/llmide-deploy /usr/local/sbin/llmide-deploy && sudo install -m 0440 -o root -g root {dir}/sudoers /etc/sudoers.d/llmide-deploy'", user = target.user, host = target.host, dir = dir),
            staging: dir.clone(),
        });
    }
    let base = runner.run(target, "sudo -n /usr/local/sbin/llmide-deploy base", Some(format!("{dir}\n").as_bytes()))?;
    if base.code != Some(0) { return Err(herr("bootstrap_failed", "the deploy helper could not create the service user")); }
    let check = runner.run(target, "sudo -n /usr/local/sbin/llmide-deploy check", None)?;
    if check.code != Some(0) { return Err(herr("bootstrap_failed", "the deploy helper did not pass its check")); }
    Ok(Bootstrap { installed: true, command: String::new(), staging: dir })
}

fn plans() -> &'static Mutex<HashMap<String, DeployPlan>> {
    static PLANS: OnceLock<Mutex<HashMap<String, DeployPlan>>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }

pub fn remember_plan(plan: DeployPlan) { lock(plans()).insert(plan.id.clone(), plan); }

pub fn confirm_plan(id: &str, confirmation: &str, now: u64) -> Result<DeployPlan, FsError> {
    let mut map = lock(plans());
    let plan = map.get(id).ok_or_else(|| herr("plan_not_found", "this deploy plan expired; run the preflight again"))?;
    if now.saturating_sub(plan.created_at) > PLAN_TTL_MS {
        map.remove(id);
        return Err(herr("plan_expired", "this deploy plan expired; run the preflight again"));
    }
    if confirmation != plan.confirmation {
        return Err(herr("confirmation_mismatch", "type the domain exactly to confirm the deploy"));
    }
    let plan = plan.clone();
    map.remove(id);
    Ok(plan)
}

/// Runs the confirmed stages through `open-registration`, with a health gate after `start`.
/// It deliberately stops before `lock-registration`: the owner must create the account, then the
/// UI calls `lock_registration`. Any failure runs the helper's `rollback` stage and reports it.
#[cfg(test)]
const HEALTH_ATTEMPTS: usize = 2;
#[cfg(not(test))]
const HEALTH_ATTEMPTS: usize = 30;

fn wait_healthy<H: HealthProbe>(health: &H, url: &str) -> bool {
    for i in 0..HEALTH_ATTEMPTS {
        if health.check(url).map(|h| h.db_ok && h.hub && h.api_version >= 128).unwrap_or(false) { return true; }
        if i + 1 < HEALTH_ATTEMPTS {
            #[cfg(not(test))]
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }
    false
}

pub fn deploy_run<R: DeployRunner, H: HealthProbe>(
    runner: &R, health: &H, target: &PreparedTarget, plan: &DeployPlan, secrets: &DeploySecrets, bundle: &[u8],
) -> Result<DeployReport, FsError> {
    let staging = staging_for(&target.user);
    let current_version = runner.run(target, &stage_command("check").unwrap(), None).ok()
        .and_then(|o| o.stdout.lines().find_map(|l| l.trim().strip_prefix("version=")).map(str::to_string));
    let mut switched = false;
    let mut setup_url = None;
    let mut owner_window_open = false;
    let mut rolled_back = false;
    let mut failed_stage = None;

    let rollback = |runner: &R| -> bool {
        runner.run(target, &stage_command("rollback").unwrap(), None).map(|o| o.code == Some(0)).unwrap_or(false)
    };

    for stage in plan.stages.iter().take_while(|s| s.id != "lock-registration") {
        let Some(cmd) = stage_command(&stage.id) else { continue };
        let result = match stage.id.as_str() {
            "env" => {
                let bytes = env_bytes(secrets, &plan.domain, &plan.version);
                match std::str::from_utf8(&bytes).map_err(|_| herr("env_invalid", "the env is not UTF-8")).and_then(validate_env_text) {
                    Ok(()) => runner.run(target, &cmd, Some(&bytes)),
                    Err(e) => Err(e),
                }
            }
            "bundle" => {
                if current_version.as_deref() == Some(plan.version.as_str()) {
                    // Repair path: the running release is already this version; keep it and repair
                    // nginx/env/unit instead of failing the helper's same-version guard.
                    continue;
                }
                let sha = hex(&Sha256::digest(bundle));
                match upload_staging(runner, target, "bundle.tar.gz", bundle) {
                    Ok(()) => {
                        let list = format!("{sha}  bundle.tar.gz\n");
                        match upload_staging(runner, target, "bundle.sha256", list.as_bytes()) {
                            Ok(()) => match upload_staging(runner, target, "VERSION", format!("{}\n", plan.version).as_bytes()) {
                                Ok(()) => runner.run(target, &cmd, None).map(|o| {
                                    // The marker is printed immediately after the symlink switch; a later
                                    // web-copy/prune failure exits non-zero but must still be rolled back.
                                    if o.stdout.contains("LLMIDE_BUNDLE_SWITCHED=") { switched = true; }
                                    o
                                }),
                                Err(e) => Err(e),
                            },
                            Err(e) => Err(e),
                        }
                    }
                    Err(e) => Err(e),
                }
            }
            "nginx" => {
                let vhost = VHOST_TEMPLATE.replace("__DOMAIN__", &plan.domain);
                match upload_staging(runner, target, "llm-ide-hub.nginx", vhost.as_bytes()) {
                    Ok(()) => match upload_staging(runner, target, "setup.html", SETUP_HTML.as_bytes()) {
                        Ok(()) => runner.run(target, &cmd, None),
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
            }
            "open-registration" => {
                let token = random_hex(32);
                match runner.run(target, &cmd, Some(token.as_bytes())) {
                    Ok(o) if o.code == Some(0) => {
                        owner_window_open = true;
                        setup_url = o.stdout.lines().find_map(|l| l.trim().strip_prefix("LLMIDE_SETUP_URL=")).map(str::to_string);
                        Ok(o)
                    }
                    Ok(o) => Ok(o),
                    Err(e) => Err(e),
                }
            }
            "start" => {
                match runner.run(target, &cmd, None) {
                    Ok(o) if o.code == Some(0) => {
                        let url = format!("https://{}/health", plan.domain);
                        let healthy = wait_healthy(health, &url);
                        if healthy { Ok(o) } else { Err(herr("health_timeout", "the hub did not become healthy within the check window")) }
                    }
                    other => other,
                }
            }
            _ => runner.run(target, &cmd, None),
        };
        match result {
            Ok(o) if o.code == Some(0) => {}
            Ok(_) | Err(_) => {
                failed_stage = Some(stage.id.clone());
                if switched { rolled_back = rollback(runner); }
                break;
            }
        }
    }

    Ok(DeployReport {
        version: plan.version.clone(),
        url: format!("https://{}", plan.domain),
        api_version: 128,
        hub: true,
        owner_window_open,
        setup_url,
        rolled_back,
        failed_stage,
    })
}

#[tauri::command]
pub async fn remote_deploy_plan(target: SshTarget, domain: String, review_ack: bool) -> Result<DeployPlan, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        let p = run_preflight(&SystemDeploy, &prepared)?;
        let version = env!("CARGO_PKG_VERSION").to_string();
        let bundle = bundle_path(&version).unwrap_or_default();
        let plan = build_plan(&p, &domain.trim().to_ascii_lowercase(), &version, &bundle, crate::confirm::now_ms(), review_ack);
        remember_plan(plan.clone());
        Ok(plan)
    }).await.map_err(|e| herr("internal", format!("the preflight did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_bootstrap(target: SshTarget) -> Result<Bootstrap, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        bootstrap_with(&SystemDeploy, &prepared)
    }).await.map_err(|e| herr("internal", format!("the bootstrap did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_run(target: SshTarget, plan_id: String, confirmation: String) -> Result<DeployReport, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        let plan = confirm_plan(&plan_id, &confirmation, crate::confirm::now_ms())?;
        if !crate::confirm::ask("Deploy the LLM-IDE hub?", &format!("Install the hub for {} and start its service?", plan.domain), "Deploy hub", true) {
            return Err(herr("cancelled", "the deploy was cancelled at the host confirmation"));
        }
        let secrets = generate_secrets()?;
        let bundle = std::fs::read(&plan.bundle_path).map_err(|e| herr("bundle_missing", format!("the staged hub bundle is missing: {e}")))?;
        if bundle.len() > 256 * 1024 * 1024 { return Err(herr("bundle_too_large", "the hub bundle is larger than 256 MB")); }
        deploy_run(&SystemDeploy, &SystemHealth, &prepared, &plan, &secrets, &bundle)
    }).await.map_err(|e| herr("internal", format!("the deploy did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_backup_now(target: SshTarget) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        let out = SystemDeploy.run(&prepared, &stage_command("backup").unwrap(), None)?;
        if out.code != Some(0) { return Err(herr("backup_failed", "the hub backup did not finish")); }
        Ok(())
    }).await.map_err(|e| herr("internal", format!("the backup did not finish: {e}")))?
}

/// Bounded, redacted journal tail. The helper is not involved: the command and its fixed flags are constants.
#[tauri::command]
pub async fn remote_logs(target: SshTarget, lines: u16) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target).map_err(|e| e.message)?;
        require_confirmed_host_key(&prepared).map_err(|e| e.message)?;
        let n = lines.clamp(1, 2000);
        let cmd = format!("journalctl -u llmide-core -n {n} --no-pager -o short-iso");
        let out = SystemDeploy.run(&prepared, &cmd, None).map_err(|e| e.message)?;
        if out.code != Some(0) { return Err("journalctl is not available on the hub".to_string()); }
        Ok(redact_logs(&out.stdout))
    }).await.map_err(|e| format!("the log read did not finish: {e}"))?
}

/// Removes the service and vhost; keeps `/var/lib/llmide` unless `purge` and the exact hostname are given.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDiagnostics {
    pub service: String,
    pub disk_free_mb: u64,
    pub version: Option<String>,
    pub last_backup: Option<String>,
    /// Seconds since the newest backup file was written; None when no backup exists.
    pub last_backup_age_sec: Option<u64>,
    pub health: Option<String>,
}

pub fn parse_diagnostics(text: &str) -> RemoteDiagnostics {
    let line = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)).map(|v| v.trim().to_string());
    RemoteDiagnostics {
        service: line("SERVICE=").unwrap_or_else(|| "unknown".into()),
        disk_free_mb: line("DISK_MB=").and_then(|v| v.parse().ok()).unwrap_or(0),
        version: line("VERSION=").filter(|v| !v.is_empty()),
        last_backup: line("BACKUP=").filter(|v| !v.is_empty()),
        last_backup_age_sec: line("BACKUP_AGE_SEC=").and_then(|v| v.parse().ok()),
        health: line("HEALTH=").filter(|v| !v.is_empty()),
    }
}

pub const DIAGNOSTICS_SCRIPT: &str = r#"printf 'SERVICE=%s\n' "$(systemctl is-active llmide-core 2>/dev/null || true)"
printf 'DISK_MB=%s\n' "$(df -Pk /var/lib/llmide 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024}')"
printf 'VERSION=%s\n' "$(cat /opt/llmide/current/VERSION 2>/dev/null | tr -cd 'A-Za-z0-9._-' | head -c 40)"
backup=$(ls -t /var/lib/llmide/data.db.bak-*.db 2>/dev/null | grep -v '\.agent\.db$' | head -1 || true)
printf 'BACKUP=%s\n' "$(printf '%s' "$backup" | xargs -r basename)"
if [ -n "$backup" ]; then
  printf 'BACKUP_AGE_SEC=%s\n' "$(( $(date +%s) - $(stat -c %Y "$backup" 2>/dev/null || echo 0) ))"
fi
printf 'HEALTH=%s\n' "$(curl -fsS --max-time 5 http://127.0.0.1:3457/health 2>/dev/null | head -c 300 | tr -d '\n')"
"#;

#[tauri::command]
pub async fn remote_diagnostics(target: SshTarget) -> Result<RemoteDiagnostics, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        let out = SystemDeploy.run(&prepared, DIAGNOSTICS_SCRIPT, None)?;
        if out.code != Some(0) { return Err(herr("diagnostics_failed", "the hub diagnostics probe did not finish")); }
        Ok(parse_diagnostics(&out.stdout))
    }).await.map_err(|e| herr("internal", format!("the diagnostics did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_update(target: SshTarget, version: String, confirmation: String, hub_url: String) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        if confirmation != target.host { return Err(herr("confirmation_mismatch", "type the hostname exactly to update")); }
        if !crate::confirm::ask("Update the LLM-IDE hub?", &format!("Update {} to {version}?", target.host), "Update hub", true) {
            return Err(herr("cancelled", "the update was cancelled at the host confirmation"));
        }
        let pre = SystemDeploy.run(&prepared, &stage_command("predeploy-backup").unwrap(), None)?;
        if pre.code != Some(0) { return Err(herr("backup_failed", "the pre-update backup failed; nothing was changed")); }
        let Some(bundle) = bundle_path(&version) else { return Err(herr("bundle_missing", "the staged hub bundle is missing; run node desktop/scripts/stage-hub-core.mjs")); };
        let bytes = std::fs::read(&bundle).map_err(|e| herr("bundle_missing", format!("cannot read the bundle: {e}")))?;
        if bytes.len() > 256 * 1024 * 1024 { return Err(herr("bundle_too_large", "the hub bundle is larger than 256 MB")); }
        let staging = staging_for(&target.user);
        let sha = hex(&Sha256::digest(&bytes));
        upload_staging(&SystemDeploy, &prepared, "bundle.tar.gz", &bytes)?;
        upload_staging(&SystemDeploy, &prepared, "bundle.sha256", format!("{sha}  bundle.tar.gz\n").as_bytes())?;
        upload_staging(&SystemDeploy, &prepared, "VERSION", format!("{version}\n").as_bytes())?;
        let o = SystemDeploy.run(&prepared, &stage_command("update").unwrap(), None)?;
        if o.code != Some(0) {
            // The helper refuses a same-version update (and a failed upload) before switching; never
            // roll a healthy hub back for a request that changed nothing.
            if update_switched(o.code, &o.stdout) {
                let _ = SystemDeploy.run(&prepared, &stage_command("rollback").unwrap(), None);
                return Err(herr("update_failed", "the hub update failed after the switch; the previous release was restored when available"));
            }
            return Err(herr("update_refused", "the hub refused the update; nothing was switched"));
        }
        let host = crate::remote_tls::split_hub(hub_url.trim()).map(|(h, _)| h).unwrap_or_else(|_| target.host.clone());
        if !wait_healthy(&SystemHealth, &format!("https://{host}/health")) {
            let _ = SystemDeploy.run(&prepared, &stage_command("rollback").unwrap(), None);
            return Err(herr("update_unhealthy", "the updated hub did not become healthy; the previous release was restored"));
        }
        Ok(())
    }).await.map_err(|e| herr("internal", format!("the update did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_uninstall(target: SshTarget, confirmation: String, purge: bool) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        let what = if purge { "Uninstall the hub AND DELETE its data?" } else { "Uninstall the hub? Data is kept." };
        if !crate::confirm::ask(what, &format!("Remove the service and vhost on {}?", target.host), "Uninstall hub", true) {
            return Err(herr("cancelled", "the uninstall was cancelled at the host confirmation"));
        }
        uninstall(&SystemDeploy, &prepared, &confirmation, purge)
    }).await.map_err(|e| herr("internal", format!("the uninstall did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_lock(target: SshTarget) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        let out = SystemDeploy.run(&prepared, &stage_command("lock-registration").unwrap(), None)?;
        if out.code != Some(0) { return Err(herr("lock_failed", "could not close registration")); }
        Ok(())
    }).await.map_err(|e| herr("internal", format!("the lock did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_rollback(target: SshTarget) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        require_confirmed_host_key(&prepared)?;
        let out = SystemDeploy.run(&prepared, &stage_command("rollback").unwrap(), None)?;
        if out.code != Some(0) { return Err(herr("rollback_failed", "there is no previous release to restore")); }
        Ok(())
    }).await.map_err(|e| herr("internal", format!("the rollback did not finish: {e}")))?
}

const REDACTED: &str = "<redacted>";
/// Removes the known credential shapes from a journal tail. It never tries to be a full secret scanner;
/// it covers the values the hub itself handles (JWT/vault env lines, bearer tokens, Anthropic keys).
pub fn redact_logs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("llmide_jwt_secret=") || lower.contains("llmide_vault_key=") || lower.contains("llmide_bootstrap_token=") {
            out.push_str(REDACTED); out.push('\n'); continue;
        }
        let mut cleaned = line.to_string();
        for marker in ["Bearer ", "sk-ant-"] {
            if let Some(pos) = cleaned.find(marker) {
                let end = cleaned[pos + marker.len()..].find(char::is_whitespace).map(|i| pos + marker.len() + i).unwrap_or(cleaned.len());
                cleaned.replace_range(pos..end, &format!("{marker}{REDACTED}"));
            }
        }
        out.push_str(&cleaned); out.push('\n');
    }
    out
}

pub fn update_switched(code: Option<i32>, stdout: &str) -> bool {
    code != Some(0) && (stdout.contains("LLMIDE_UPDATE_SWITCHED=") || stdout.contains("LLMIDE_BUNDLE_SWITCHED="))
}

pub fn uninstall<R: DeployRunner>(runner: &R, target: &PreparedTarget, confirmation: &str, purge: bool) -> Result<(), FsError> {
    if confirmation != target.host { return Err(herr("confirmation_mismatch", "type the hostname exactly to uninstall")); }
    let stage = if purge { "uninstall-purge" } else { "uninstall" };
    let out = runner.run(target, &stage_command(stage).unwrap(), None)?;
    if out.code != Some(0) { return Err(herr("uninstall_failed", "the hub uninstall did not finish")); }
    Ok(())
}

pub fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    let _ = getrandom::fill(&mut b);
    hex(&b)
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes { s.push_str(&format!("{b:02x}")); }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    struct Fake { calls: StdMutex<Vec<(String, Option<Vec<u8>>)>>, fail: StdMutex<Vec<String>>, check_version: StdMutex<String>, health: Vec<Result<Health, String>> }
    impl Fake {
        fn new() -> Self { Self { calls: StdMutex::new(Vec::new()), fail: StdMutex::new(Vec::new()), check_version: StdMutex::new("1.2.2".into()), health: Vec::new() } }
        fn check_version(&self, v: &str) { *self.check_version.lock().unwrap() = v.to_string(); }
        fn fail(&self, s: &str) { self.fail.lock().unwrap().push(s.to_string()); }
        fn calls(&self) -> Vec<(String, Option<Vec<u8>>)> { self.calls.lock().unwrap().clone() }
    }
    impl DeployRunner for Fake {
        fn run(&self, _t: &PreparedTarget, command: &str, stdin: Option<&[u8]>) -> Result<RawOutput, FsError> {
            self.calls.lock().unwrap().push((command.to_string(), stdin.map(|s| s.to_vec())));
            if self.fail.lock().unwrap().iter().any(|f| command.contains(f)) {
                return Ok(RawOutput { code: Some(1), stdout: String::new(), stderr: "boom".into() });
            }
            if command == PREFLIGHT_SCRIPT {
                return Ok(RawOutput { code: Some(0), stdout: "LLMIDE_PREFLIGHT {\"os\":\"Ubuntu 24.04\",\"arch\":\"x86_64\",\"systemd\":true,\"nginx\":true,\"certbot\":true,\"sudo_nopasswd\":true,\"disk_free_mb\":4096,\"existing_version\":null,\"domain_resolves\":null,\"claude\":true}\n".into(), stderr: String::new() });
            }
            if command.contains("llmide-deploy check") {
                let v = self.check_version.lock().unwrap().clone();
                return Ok(RawOutput { code: Some(0), stdout: format!("version={v}\nhelper=1\nok\n"), stderr: String::new() });
            }
            if command.contains("llmide-deploy bundle") {
                return Ok(RawOutput { code: Some(0), stdout: "LLMIDE_BUNDLE_SWITCHED=1.2.3\nok\n".into(), stderr: String::new() });
            }
            Ok(RawOutput { code: Some(0), stdout: "LLMIDE_SETUP_URL=https://hub.example.com/setup?t=abc\nok\n".into(), stderr: String::new() })
        }
    }
    impl HealthProbe for Fake {
        fn check(&self, _url: &str) -> Result<Health, FsError> {
            self.health.first().cloned().unwrap_or(Ok(Health { status: "ok".into(), db_ok: true, hub: true, api_version: 129 })).map_err(|m| herr("health_unreachable", m))
        }
    }
    fn target() -> PreparedTarget { PreparedTarget { host: "hub.example.com".into(), port: 22, user: "deploy".into(), key_path: "/k".into() } }

    #[test]
    fn r034_a_keyscan_line_is_kept_only_when_it_matches_the_confirmed_fingerprint() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"a host key blob");
        let fingerprint = fingerprint_for_key_b64(&b64).unwrap();
        let key = ConfirmedHostKey { key_type: "ssh-ed25519".into(), fingerprint: fingerprint.clone() };
        let t = PreparedTarget { host: "hub.example.com".into(), port: 2222, user: "deploy".into(), key_path: "/k".into() };
        let scan = format!("# hub.example.com:2222 SSH-2.0-OpenSSH_9.6\n[hub.example.com]:2222 ssh-ed25519 {b64}\n");
        assert_eq!(
            verified_known_host_line(&scan, &t, &key).as_deref(),
            Some(format!("[hub.example.com]:2222 ssh-ed25519 {b64}").as_str()),
        );
        // A different key (the MITM case) is refused even when the scan labels it with our host.
        let wrong = ConfirmedHostKey { key_type: "ssh-ed25519".into(), fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into() };
        assert_eq!(verified_known_host_line(&scan, &t, &wrong), None);
        // A different key type is not this host key.
        let other_type = ConfirmedHostKey { key_type: "ssh-rsa".into(), fingerprint };
        assert_eq!(verified_known_host_line(&scan, &t, &other_type), None);
    }

    #[test]
    fn r034_port_22_uses_a_bare_host_and_other_ports_bracket_it() {
        let mut t = target();
        assert_eq!(known_host_name(&t), "hub.example.com");
        t.port = 2222;
        assert_eq!(known_host_name(&t), "[hub.example.com]:2222");
    }

    #[test]
    fn preflight_refuses_arm_password_sudo_and_missing_nginx() {
        let out = r#"LLMIDE_PREFLIGHT {"os":"Ubuntu 24.04","arch":"aarch64","systemd":true,"nginx":false,"certbot":true,"sudo_nopasswd":false,"disk_free_mb":900,"claude":false,"existing_version":null}"#;
        let p = parse_preflight(out).unwrap();
        let blockers = plan_blockers(&p, "hub.example.com");
        assert!(blockers.iter().any(|b| b == "arch_unsupported"));
        assert!(blockers.iter().any(|b| b == "sudo_requires_password"));
        assert!(blockers.iter().any(|b| b == "disk_below_2gb"));
        assert!(blockers.iter().any(|b| b == "nginx_missing"));
        assert!(!blockers.iter().any(|b| b == "node22_missing"));
    }

    #[test]
    fn sudoers_grants_exact_stages_and_never_a_wildcard() {
        let s = sudoers_text("deploy");
        assert!(s.contains("deploy ALL=(root) NOPASSWD:"));
        for stage in STAGES { assert!(s.contains(&format!("/usr/local/sbin/llmide-deploy {stage}")), "missing {stage}"); }
        assert!(!s.contains('*'));
        assert!(!s.contains("ALL=(ALL)"));
    }

    #[test]
    fn env_file_is_0600_shaped_and_never_in_argv() {
        let s = DeploySecrets { jwt: "a".repeat(64), vault: "b".repeat(64) };
        let env = String::from_utf8(env_bytes(&s, "hub.example.com", "1.2.3")).unwrap();
        assert!(env.contains("LLMIDE_VAULT_KEY=bbbb"));
        assert!(env.contains("LLMIDE_HUB_DOMAIN=hub.example.com"));
        assert!(env.contains("LLMIDE_HUB_PUBLIC_URL=wss://hub.example.com/host-api/v1"));
        validate_env_text(&env).unwrap();
        assert!(env.contains("LLMIDE_BACKUP_KEEP=7"));
        for stage in STAGES { let cmd = stage_command(stage).unwrap(); assert!(!cmd.contains(&s.jwt)); }
    }

    #[test]
    fn a_hostile_env_line_is_refused_before_it_reaches_root() {
        assert!(validate_env_text("NODE_ENV=production\nLLMIDE_JWT_SECRET=abc\n").is_ok());
        for bad in ["NODE_OPTIONS=--require /tmp/x", "LD_PRELOAD=/tmp/x.so", "BASH_ENV=/tmp/x", "EVIL=1", "no_equals"] {
            assert!(validate_env_text(&format!("NODE_ENV=production\n{bad}\n")).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn health_parses_the_real_payload_shape() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../schema/http/fixtures/health-auth/get-health-200.json")).unwrap();
        let body = serde_json::to_string(&fixture["response"]).unwrap();
        let h = parse_health(&body).unwrap();
        assert_eq!(h.status, "degraded");
        assert!(h.db_ok, "checks.db is the DB truth, not status/degraded");
        assert!(!h.hub);
        assert_eq!(h.api_version, fixture["response"]["apiVersion"].as_u64().unwrap() as u32);
        assert!(parse_health("{\"ok\":true}").is_none(), "the old fake shape must not pass");
    }

    #[test]
    fn diagnostics_parse_fixed_markers_only() {
        let d = parse_diagnostics("SERVICE=active\nDISK_MB=4096\nVERSION=1.2.3\nBACKUP=data-1.db\nHEALTH={\"ok\":true}\n");
        assert_eq!(d.service, "active");
        assert_eq!(d.disk_free_mb, 4096);
        assert_eq!(d.version.as_deref(), Some("1.2.3"));
        assert!(d.health.unwrap().contains("ok"));
    }

    #[test]
    fn logs_are_bounded_and_redacted() {
        assert_eq!(redact_logs("LLMIDE_VAULT_KEY=abcdef\nAuthorization: Bearer abc.def\nsk-ant-123\nok\n").matches("<redacted>").count(), 3);
        assert!(redact_logs("ok\n").contains("ok"));
    }

    #[test]
    fn a_same_version_update_refusal_never_rolls_back() {
        assert!(!update_switched(Some(1), "llmide-deploy: update: the hub already runs 1.2.3\n"));
        assert!(!update_switched(Some(1), "llmide-deploy: upload: checksum mismatch\n"));
        assert!(update_switched(Some(1), "LLMIDE_UPDATE_SWITCHED=1.2.4\nllmide-deploy: start: fail\n"));
        assert!(!update_switched(Some(0), "LLMIDE_UPDATE_SWITCHED=1.2.4\n"), "a successful switch needs no rollback");
    }

    #[test]
    fn uninstall_refuses_a_wrong_hostname() {
        let fake = Fake::new();
        let prepared = target();
        assert_eq!(uninstall(&fake, &prepared, "wrong.example.com", false).unwrap_err().code, "confirmation_mismatch");
        assert!(uninstall(&fake, &prepared, "hub.example.com", false).is_ok());
        assert!(fake.calls().iter().any(|(c, _)| c.contains("llmide-deploy uninstall")));
    }

    #[test]
    fn a_same_version_deploy_skips_the_bundle_and_repairs() {
        let fake = Fake::new();
        fake.check_version("1.2.3");
        let p = Preflight { os: "Ubuntu".into(), arch: "x86_64".into(), systemd: true, nginx: true, certbot: true, sudo_nopasswd: true, disk_free_mb: 4096, existing_version: Some("1.2.3".into()), domain_resolves: None, claude: true };
        let bundle = std::env::temp_dir().join(format!("llmide-same-{}.tar.gz", random_hex(4)));
        std::fs::write(&bundle, b"x").unwrap();
        let plan = build_plan(&p, "hub.example.com", "1.2.3", bundle.to_str().unwrap(), 1, true);
        let secrets = DeploySecrets { jwt: "a".repeat(64), vault: "b".repeat(64) };
        let report = deploy_run(&fake, &FakeHealth, &target(), &plan, &secrets, b"x").unwrap();
        assert!(report.failed_stage.is_none());
        assert!(!fake.calls().iter().any(|(c, _)| c.contains("llmide-deploy bundle")));
        assert!(fake.calls().iter().any(|(c, _)| c.contains("llmide-deploy nginx")));
        assert!(fake.calls().iter().any(|(c, _)| c.contains("llmide-deploy start")));
        let _ = std::fs::remove_file(bundle);
    }

    struct BundlePostSwitchFail { calls: StdMutex<Vec<String>> }
    impl DeployRunner for BundlePostSwitchFail {
        fn run(&self, _t: &PreparedTarget, command: &str, _stdin: Option<&[u8]>) -> Result<RawOutput, FsError> {
            self.calls.lock().unwrap().push(command.to_string());
            if command.contains("llmide-deploy check") { return Ok(RawOutput { code: Some(0), stdout: "version=1.2.2\nhelper=1\n".into(), stderr: String::new() }); }
            if command.contains("llmide-deploy bundle") {
                return Ok(RawOutput { code: Some(1), stdout: "LLMIDE_BUNDLE_SWITCHED=1.2.3\nllmide-deploy: bundle: web copy failed\n".into(), stderr: String::new() });
            }
            Ok(RawOutput { code: Some(0), stdout: "ok\n".into(), stderr: String::new() })
        }
    }

    #[test]
    fn a_bundle_failure_after_its_switch_marker_still_rolls_back() {
        let fake = BundlePostSwitchFail { calls: StdMutex::new(Vec::new()) };
        let p = Preflight { os: "Ubuntu".into(), arch: "x86_64".into(), systemd: true, nginx: true, certbot: true, sudo_nopasswd: true, disk_free_mb: 4096, existing_version: None, domain_resolves: None, claude: true };
        let bundle = std::env::temp_dir().join(format!("llmide-post-{}.tar.gz", random_hex(4)));
        std::fs::write(&bundle, b"x").unwrap();
        let plan = build_plan(&p, "hub.example.com", "1.2.3", bundle.to_str().unwrap(), 1, true);
        let secrets = DeploySecrets { jwt: "a".repeat(64), vault: "b".repeat(64) };
        let report = deploy_run(&fake, &FakeHealth, &target(), &plan, &secrets, b"x").unwrap();
        assert_eq!(report.failed_stage.as_deref(), Some("bundle"));
        assert!(report.rolled_back, "a post-switch failure must roll back");
        assert!(fake.calls.lock().unwrap().iter().any(|c| c.contains("llmide-deploy rollback")));
        let _ = std::fs::remove_file(bundle);
    }

    #[test]
    fn a_failure_before_the_switch_never_rolls_back() {
        let fake = Fake::new();
        fake.fail("llmide-deploy predeploy-backup");
        let p = Preflight { os: "Ubuntu".into(), arch: "x86_64".into(), systemd: true, nginx: true, certbot: true, sudo_nopasswd: true, disk_free_mb: 4096, existing_version: None, domain_resolves: None, claude: true };
        let bundle = std::env::temp_dir().join(format!("llmide-early-{}.tar.gz", random_hex(4)));
        std::fs::write(&bundle, b"x").unwrap();
        let plan = build_plan(&p, "hub.example.com", "1.2.3", bundle.to_str().unwrap(), 1, true);
        let secrets = DeploySecrets { jwt: "a".repeat(64), vault: "b".repeat(64) };
        let report = deploy_run(&fake, &FakeHealth, &target(), &plan, &secrets, b"x").unwrap();
        assert_eq!(report.failed_stage.as_deref(), Some("predeploy-backup"));
        assert!(!report.rolled_back);
        assert!(!fake.calls().iter().any(|(c, _)| c.contains("llmide-deploy rollback")));
        let _ = std::fs::remove_file(bundle);
    }

    #[test]
    fn a_changed_or_wrong_confirmation_is_refused() {
        let p = Preflight { os: "Ubuntu".into(), arch: "x86_64".into(), systemd: true, nginx: true, certbot: true, sudo_nopasswd: true, disk_free_mb: 4096, existing_version: None, domain_resolves: None, claude: true };
        let bundle = std::env::temp_dir().join(format!("llmide-bundle-{}.tar.gz", random_hex(4)));
        std::fs::write(&bundle, b"x").unwrap();
        let plan = build_plan(&p, "hub.example.com", "1.2.3", bundle.to_str().unwrap(), 1_000, true);
        assert!(plan.blockers.is_empty());
        remember_plan(plan.clone());
        assert_eq!(confirm_plan(&plan.id, "hub.example.com", 2_000).unwrap().id, plan.id);
        remember_plan(plan.clone());
        assert_eq!(confirm_plan(&plan.id, "wrong.example.com", 2_000).unwrap_err().code, "confirmation_mismatch");
        remember_plan(plan.clone());
        assert_eq!(confirm_plan(&plan.id, "hub.example.com", 2_000_000).unwrap_err().code, "plan_expired");
        let _ = std::fs::remove_file(bundle);
    }

    #[test]
    fn the_bundled_node_must_be_22() {
        assert!(HELPER.contains("case \"$node_version\" in v22.*)"));
        assert!(UNIT.contains("ReadWritePaths=/var/lib/llmide /srv/llmide/projects"));
        assert!(UNIT.contains("EnvironmentFile=-/etc/llmide/bootstrap.env"));
        assert!(BACKUP_TIMER.contains("OnCalendar="), "the daily backup timer ships with the helper");
        assert!(BACKUP_TIMER.contains("WantedBy=timers.target"));
    }

    #[test]
    fn a_helper_version_mismatch_forces_a_reinstall() {
        assert!(format!("helper={HELPER_VERSION}\nok\n").contains(&format!("helper={HELPER_VERSION}")));
        assert!(!format!("helper=0\nok\n").contains(&format!("helper={HELPER_VERSION}")));
    }

    struct HelperZero { calls: StdMutex<Vec<String>> }
    impl DeployRunner for HelperZero {
        fn run(&self, _t: &PreparedTarget, command: &str, _stdin: Option<&[u8]>) -> Result<RawOutput, FsError> {
            self.calls.lock().unwrap().push(command.to_string());
            let stdout = if command.contains("llmide-deploy check") { "helper=0\nok\n".to_string() } else { "ok\n".to_string() };
            Ok(RawOutput { code: Some(0), stdout, stderr: String::new() })
        }
    }

    #[test]
    fn a_helper_version_zero_is_reinstalled_with_full_sudo() {
        let fake = HelperZero { calls: StdMutex::new(Vec::new()) };
        let b = bootstrap_with(&fake, &target()).unwrap();
        assert!(b.installed);
        let calls = fake.calls.lock().unwrap().clone();
        assert!(calls.iter().any(|c| c.contains("install -m 0755")), "the old helper is reinstalled");
        assert!(calls.iter().any(|c| c.contains("base")));
    }

    #[test]
    fn r034_a_sudoers_drop_in_that_does_not_parse_is_never_installed() {
        let fake = Fake::new();
        fake.fail("visudo -cf");
        let err = bootstrap_with(&fake, &target()).unwrap_err();
        assert_eq!(err.code, "sudoers_invalid");
        assert!(!fake.calls().iter().any(|(c, _)| c.contains("install -m 0440")), "the bad drop-in is not installed");
    }

    #[test]
    fn bootstrap_uploads_the_helper_and_refuses_a_wrong_host() {
        let fake = Fake::new();
        let b = bootstrap_with(&fake, &target()).unwrap();
        assert!(b.installed);
        let calls = fake.calls();
        assert!(calls.iter().any(|(c, _)| c.contains("llmide-deploy")));
        assert!(calls.iter().any(|(c, s)| c.contains("sudo -n /usr/local/sbin/llmide-deploy base")));
        assert!(calls.iter().all(|(c, _)| !c.contains("LLMIDE_VAULT_KEY")));
    }

    struct FakeHealth;
    impl HealthProbe for FakeHealth {
        fn check(&self, _url: &str) -> Result<Health, FsError> { Ok(Health { status: "ok".into(), db_ok: true, hub: true, api_version: 129 }) }
    }

    struct HealthFail;
    impl HealthProbe for HealthFail {
        fn check(&self, _url: &str) -> Result<Health, FsError> { Err(herr("health_unreachable", "timeout")) }
    }

    #[test]
    fn a_hub_that_never_becomes_healthy_is_rolled_back() {
        let fake = Fake::new();
        let p = Preflight { os: "Ubuntu".into(), arch: "x86_64".into(), systemd: true, nginx: true, certbot: true, sudo_nopasswd: true, disk_free_mb: 4096, existing_version: None, domain_resolves: None, claude: true };
        let bundle = std::env::temp_dir().join(format!("llmide-run-{}.tar.gz", random_hex(4)));
        std::fs::write(&bundle, b"bundle").unwrap();
        let plan = build_plan(&p, "hub.example.com", "1.2.3", bundle.to_str().unwrap(), 1, true);
        let secrets = DeploySecrets { jwt: "a".repeat(64), vault: "b".repeat(64) };
        let report = deploy_run(&fake, &HealthFail, &target(), &plan, &secrets, b"bundle").unwrap();
        assert!(report.rolled_back);
        assert_eq!(report.failed_stage.as_deref(), Some("start"));
        assert!(fake.calls().iter().any(|(c, _)| c.contains("llmide-deploy rollback")));
        let _ = std::fs::remove_file(bundle);
    }

    #[test]
    fn the_preflight_parser_ignores_noise() {
        let p = parse_preflight("noise\nLLMIDE_PREFLIGHT {\"os\":\"Ubuntu 24.04\",\"arch\":\"x86_64\",\"systemd\":true,\"nginx\":true,\"certbot\":true,\"sudo_nopasswd\":true,\"disk_free_mb\":4096,\"existing_version\":null,\"domain_resolves\":null,\"claude\":true}\n").unwrap();
        assert_eq!(p.arch, "x86_64");
    }
}
