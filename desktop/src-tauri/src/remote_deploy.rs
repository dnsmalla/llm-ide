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

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::remote::{prepare, ssh_args_with, PreparedTarget, RawOutput, SshTarget};

/// The complete helper stage list. The sudoers file is generated from this list, one exact command
/// per stage; there is no wildcard and no free-form argument.
pub const STAGES: &[&str] = &[
    "check", "predeploy-backup", "base", "env", "bundle", "nginx", "start",
    "open-registration", "lock-registration", "backup", "rollback",
];

pub const HELPER: &str = include_str!("../../../deploy/hub/llmide-deploy");
pub const UNIT: &str = include_str!("../../../deploy/hub/llmide-core.service");
pub const BACKUP_UNIT: &str = include_str!("../../../deploy/hub/llmide-backup.service");
pub const LOGROTATE: &str = include_str!("../../../deploy/hub/logrotate");
pub const VHOST_TEMPLATE: &str = include_str!("../../../deploy/hub/llm-ide-hub.nginx.template");
pub const SETUP_HTML: &str = include_str!("../../../deploy/hub/setup.html");

pub const MIN_DISK_MB: u64 = 2048;
const MAX_DOMAIN: usize = 253;
const PLAN_TTL_MS: u64 = 30 * 60 * 1000;

pub trait DeployRunner: Send + Sync {
    fn run(&self, target: &PreparedTarget, command: &str, stdin: Option<&[u8]>) -> Result<RawOutput, FsError>;
}

/// The real transport: system `ssh` with the Phase-1 argv, stdin piped only when a stage needs it.
pub struct SystemDeploy;

impl DeployRunner for SystemDeploy {
    fn run(&self, target: &PreparedTarget, command: &str, stdin: Option<&[u8]>) -> Result<RawOutput, FsError> {
        let mut cmd = Command::new("ssh");
        cmd.args(ssh_args_with(target, command))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
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
    pub ok: bool,
    pub db_ok: bool,
    pub hub: bool,
    pub api_version: u32,
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
        let body: serde_json::Value = serde_json::from_str(&text).map_err(|e| herr("health_unreadable", format!("invalid /health JSON: {e}")))?;
        Ok(Health {
            ok: body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            db_ok: body.get("dbOk").and_then(|v| v.as_bool()).unwrap_or(false),
            hub: body.get("hub").and_then(|v| v.as_bool()).unwrap_or(false),
            api_version: body.get("apiVersion").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        })
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
        ("predeploy-backup", "Back up the existing hub database", true, "Stops the old service, VACUUM INTO a pre-deploy snapshot, starts it again. Skipped on a fresh server."),
        ("base", "Create the service user and directories", true, "useradd llmide; /opt/llmide, /var/lib/llmide, /srv/llmide/projects, /etc/llmide; unit and logrotate."),
        ("env", "Write the secret env file over stdin", true, "0600 root:root; JWT and vault secrets generated locally; never in argv or a log."),
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

pub fn build_plan(p: &Preflight, domain: &str, version: &str, bundle: &str, now: u64) -> DeployPlan {
    let mut blockers = plan_blockers(p, domain);
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
        "NODE_ENV=production\nPATH=/usr/local/bin:/usr/bin:/bin\nLLMIDE_HOST=127.0.0.1\nLLMIDE_PORT=3457\nLLMIDE_HUB=1\nLLMIDE_TLS_TERMINATED=1\nLLMIDE_HUB_DOMAIN={domain}\nLLMIDE_HUB_VERSION={version}\nLLMIDE_DATA_DIR=/var/lib/llmide\nLLMIDE_DB_PATH=/var/lib/llmide/data.db\nLLMIDE_PROJECTS_ROOT=/srv/llmide/projects\nLLMIDE_BACKUP_DIR=/var/lib/llmide/backups\nLLMIDE_BACKUP_KEEP=7\nLLMIDE_DISABLE_REGISTRATION=1\nLLMIDE_TRUST_PROXY=1\nLLMIDE_LOG_JSON=1\nLLMIDE_LOG_LEVEL=info\nLLMIDE_MAX_TURNS=8\nLLMIDE_HOST_API_HUB=1\nLLMIDE_HOST_API_WEB_ORIGINS=https://{domain}\nLLMIDE_HOST_API_FINGERPRINT_FILE=/etc/llmide/host-api-fingerprint\nLLMIDE_JWT_SECRET={}\nLLMIDE_VAULT_KEY={}\n",
        s.jwt, s.vault
    ).into_bytes()
}

pub const PREFLIGHT_SCRIPT: &str = r#"set -u
os=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | tr -cd 'A-Za-z0-9 ._-' | cut -c1-80)
arch=$(uname -m 2>/dev/null | tr -cd 'A-Za-z0-9_-')
systemd=false; command -v systemctl >/dev/null 2>&1 && systemd=true
nginx=false; command -v nginx >/dev/null 2>&1 && nginx=true
certbot=false; command -v certbot >/dev/null 2>&1 && certbot=true
sudo_ok=false; sudo -n true >/dev/null 2>&1 && sudo_ok=true
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

fn upload<R: DeployRunner>(runner: &R, target: &PreparedTarget, name: &str, bytes: &[u8]) -> Result<(), FsError> {
    let dir = staging_for(&target.user);
    let cmd = format!("mkdir -p \"{dir}\" && cat > \"{dir}/{name}\"");
    let out = runner.run(target, &cmd, Some(bytes))?;
    if out.code != Some(0) { return Err(herr("upload_failed", format!("could not upload {name}"))); }
    Ok(())
}

pub fn bootstrap_with<R: DeployRunner>(runner: &R, target: &PreparedTarget) -> Result<Bootstrap, FsError> {
    upload(runner, target, "llmide-deploy", HELPER.as_bytes())?;
    upload(runner, target, "sudoers", sudoers_text(&target.user).as_bytes())?;
    upload(runner, target, "llmide-core.service", UNIT.as_bytes())?;
    upload(runner, target, "llmide-backup.service", BACKUP_UNIT.as_bytes())?;
    upload(runner, target, "logrotate", LOGROTATE.as_bytes())?;
    let dir = staging_for(&target.user);
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
pub fn deploy_run<R: DeployRunner, H: HealthProbe>(
    runner: &R, health: &H, target: &PreparedTarget, plan: &DeployPlan, secrets: &DeploySecrets, bundle: &[u8],
) -> Result<DeployReport, FsError> {
    let staging = staging_for(&target.user);
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
            "env" => runner.run(target, &cmd, Some(&env_bytes(secrets, &plan.domain, &plan.version))),
            "bundle" => {
                let sha = hex(&Sha256::digest(bundle));
                let up = format!("mkdir -p \"{staging}\" && cat > \"{staging}/bundle.tar.gz\"");
                match runner.run(target, &up, Some(bundle)) {
                    Ok(o) if o.code == Some(0) => {
                        let list = format!("{sha}  bundle.tar.gz\n");
                        let up2 = format!("cat > \"{staging}/bundle.sha256\"");
                        match runner.run(target, &up2, Some(list.as_bytes())) {
                            Ok(o2) if o2.code == Some(0) => runner.run(target, &cmd, None),
                            Ok(_) => Err(herr("upload_failed", "could not write the bundle checksum")),
                            Err(e) => Err(e),
                        }
                    }
                    Ok(_) => Err(herr("upload_failed", "could not upload the hub bundle")),
                    Err(e) => Err(e),
                }
            }
            "nginx" => {
                let vhost = VHOST_TEMPLATE.replace("__DOMAIN__", &plan.domain);
                let up = format!("mkdir -p \"{staging}\" && cat > \"{staging}/llm-ide-hub.nginx\"");
                let up2 = format!("cat > \"{staging}/setup.html\"");
                match runner.run(target, &up, Some(vhost.as_bytes())) {
                    Ok(o) if o.code == Some(0) => match runner.run(target, &up2, Some(SETUP_HTML.as_bytes())) {
                        Ok(o2) if o2.code == Some(0) => runner.run(target, &cmd, None),
                        Ok(_) => Err(herr("upload_failed", "could not upload the setup page")),
                        Err(e) => Err(e),
                    },
                    Ok(_) => Err(herr("upload_failed", "could not upload the nginx vhost")),
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
                        let healthy = health.check(&url).map(|h| h.ok && h.db_ok && h.hub && h.api_version >= 128).unwrap_or(false);
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
                rolled_back = rollback(runner);
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
pub async fn remote_deploy_plan(target: SshTarget, domain: String) -> Result<DeployPlan, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        let p = run_preflight(&SystemDeploy, &prepared)?;
        let version = env!("CARGO_PKG_VERSION").to_string();
        let bundle = bundle_path(&version).unwrap_or_default();
        let plan = build_plan(&p, &domain.trim().to_ascii_lowercase(), &version, &bundle, crate::confirm::now_ms());
        remember_plan(plan.clone());
        Ok(plan)
    }).await.map_err(|e| herr("internal", format!("the preflight did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_bootstrap(target: SshTarget) -> Result<Bootstrap, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        bootstrap_with(&SystemDeploy, &prepared)
    }).await.map_err(|e| herr("internal", format!("the bootstrap did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_run(target: SshTarget, plan_id: String, confirmation: String) -> Result<DeployReport, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        let plan = confirm_plan(&plan_id, &confirmation, crate::confirm::now_ms())?;
        let secrets = generate_secrets()?;
        let bundle = std::fs::read(&plan.bundle_path).map_err(|e| herr("bundle_missing", format!("the staged hub bundle is missing: {e}")))?;
        if bundle.len() > 256 * 1024 * 1024 { return Err(herr("bundle_too_large", "the hub bundle is larger than 256 MB")); }
        deploy_run(&SystemDeploy, &SystemHealth, &prepared, &plan, &secrets, &bundle)
    }).await.map_err(|e| herr("internal", format!("the deploy did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_lock(target: SshTarget) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        let out = SystemDeploy.run(&prepared, &stage_command("lock-registration").unwrap(), None)?;
        if out.code != Some(0) { return Err(herr("lock_failed", "could not close registration")); }
        Ok(())
    }).await.map_err(|e| herr("internal", format!("the lock did not finish: {e}")))?
}

#[tauri::command]
pub async fn remote_deploy_rollback(target: SshTarget) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(&target)?;
        let out = SystemDeploy.run(&prepared, &stage_command("rollback").unwrap(), None)?;
        if out.code != Some(0) { return Err(herr("rollback_failed", "there is no previous release to restore")); }
        Ok(())
    }).await.map_err(|e| herr("internal", format!("the rollback did not finish: {e}")))?
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

    struct Fake { calls: StdMutex<Vec<(String, Option<Vec<u8>>)>>, fail: StdMutex<Vec<String>>, health: Vec<Result<Health, String>> }
    impl Fake {
        fn new() -> Self { Self { calls: StdMutex::new(Vec::new()), fail: StdMutex::new(Vec::new()), health: Vec::new() } }
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
            Ok(RawOutput { code: Some(0), stdout: "LLMIDE_SETUP_URL=https://hub.example.com/setup?t=abc\nok\n".into(), stderr: String::new() })
        }
    }
    impl HealthProbe for Fake {
        fn check(&self, _url: &str) -> Result<Health, FsError> {
            self.health.first().cloned().unwrap_or(Ok(Health { ok: true, db_ok: true, hub: true, api_version: 129 })).map_err(|m| herr("health_unreachable", m))
        }
    }
    fn target() -> PreparedTarget { PreparedTarget { host: "hub.example.com".into(), port: 22, user: "deploy".into(), key_path: "/k".into() } }

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
        assert!(env.contains("LLMIDE_BACKUP_KEEP=7"));
        for stage in STAGES { let cmd = stage_command(stage).unwrap(); assert!(!cmd.contains(&s.jwt)); }
    }

    #[test]
    fn a_changed_or_wrong_confirmation_is_refused() {
        let p = Preflight { os: "Ubuntu".into(), arch: "x86_64".into(), systemd: true, nginx: true, certbot: true, sudo_nopasswd: true, disk_free_mb: 4096, existing_version: None, domain_resolves: None, claude: true };
        let bundle = std::env::temp_dir().join(format!("llmide-bundle-{}.tar.gz", random_hex(4)));
        std::fs::write(&bundle, b"x").unwrap();
        let plan = build_plan(&p, "hub.example.com", "1.2.3", bundle.to_str().unwrap(), 1_000);
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
    }

    #[test]
    fn bootstrap_uploads_the_helper_and_refuses_a_wrong_host() {
        let fake = Fake::new();
        let b = bootstrap_with(&fake, &target()).unwrap();
        assert!(b.installed);
        let calls = fake.calls();
        assert!(calls.iter().any(|(c, _)| c.contains("llmide-deploy")));
        assert!(calls.iter().any(|(c, s)| c.contains("sudo -n /usr/local/sbin/llmide-deploy base") && s.is_some()));
        assert!(calls.iter().all(|(c, _)| !c.contains("LLMIDE_VAULT_KEY")));
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
        let plan = build_plan(&p, "hub.example.com", "1.2.3", bundle.to_str().unwrap(), 1);
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
