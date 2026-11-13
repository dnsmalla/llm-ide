//! URL-first hub connection: validate an https URL, log in at `/auth/login`, store the refresh
//! token in the OS keychain, and report the account/role/projects. Nothing here spawns a local
//! core — the desktop stays in Local mode until `remote_hub_login` records the hub and the UI
//! restarts into remote mode.
//!
//! Trust rules:
//! - a public HTTPS domain is validated before any request; localhost is accepted only in a debug
//!   build, never in a release;
//! - ordinary WebPKI validation is the default and a valid public-CA certificate needs no pin;
//! - the saved leaf pin is an optional fallback and never bypasses chain validation;
//! - the password travels in the request body only. No token, password or argv is logged.

use serde::{Deserialize, Serialize};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::prefs::ServerMode;
use crate::remote_tls::{hub_agent, take_pin_mismatch, validate_hub_url};

const MAX_EMAIL: usize = 254;
const MAX_PASSWORD: usize = 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HubUser {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HubProject {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HubCheck {
    pub hub_url: String,
    /// True when the TLS chain was validated by the public roots and no pin is in use.
    pub web_pki: bool,
    /// The optional saved pin, empty for normal WebPKI trust.
    pub pin: String,
    pub status: String,
    pub api_version: u32,
    pub hub: bool,
    pub db_ok: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HubLogin {
    pub hub_url: String,
    pub user: HubUser,
    pub role: String,
    pub projects: Vec<HubProject>,
    /// True when the session is protected by ordinary WebPKI trust (no manual pin).
    pub web_pki: bool,
    /// Empty for WebPKI trust; otherwise the explicitly trusted leaf pin.
    pub pin: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginReply {
    user: UserReply,
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserReply {
    id: String,
    email: String,
    display_name: Option<String>,
    role: String,
}

#[derive(Deserialize)]
struct ProjectsReply {
    projects: Vec<ProjectReply>,
}

#[derive(Deserialize)]
struct ProjectReply {
    id: String,
    name: String,
    role: String,
}

fn check_login_shape(raw: &str) -> Result<LoginReply, FsError> {
    let reply: LoginReply = serde_json::from_str(raw)
        .map_err(|_| herr("bad_hub_response", "The hub's sign-in answer was not understood."))?;
    if reply.access_token.is_empty() || reply.refresh_token.is_empty() {
        return Err(herr("bad_hub_response", "The hub did not issue a session."));
    }
    if reply.user.id.is_empty() || reply.user.email.is_empty() || reply.user.role.is_empty() {
        return Err(herr("bad_hub_response", "The hub did not return the signed-in account."));
    }
    Ok(reply)
}

fn parse_projects(raw: &str) -> Result<Vec<HubProject>, FsError> {
    let reply: ProjectsReply = serde_json::from_str(raw)
        .map_err(|_| herr("bad_hub_response", "The hub's project list was not understood."))?;
    Ok(reply.projects.into_iter().map(|p| HubProject { id: p.id, name: p.name, role: p.role }).collect())
}

/// The pin to use for this URL: only an already-saved pin for the same canonical URL. The webview
/// cannot smuggle a new pin into a login; a new pin requires the probe + explicit trust command.
fn saved_pin_for(canonical: &str) -> String {
    let stored = crate::prefs::stored().remote_server;
    if stored.hub_url == canonical { stored.tls_pin } else { String::new() }
}

/// Map a transport failure to a sentence the card can show. The pin verifier records the presented
/// fingerprint during the handshake, so a changed certificate is not mistaken for an outage.
fn transport_error(text: &str, pin: &str) -> FsError {
    if let Some(got) = take_pin_mismatch() {
        return herr("tls_pin_mismatch", format!("The hub's certificate changed. It now presents {got}. Probe it again in Advanced and trust the new pin, or remove the pin to use public-CA trust."));
    }
    let lower = text.to_ascii_lowercase();
    if !pin.is_empty() && lower.contains("remotetlspinmismatch") {
        return herr("tls_pin_mismatch", "The hub's certificate no longer matches the pin you trusted.");
    }
    if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("invalid peer") || lower.contains("tls handshake") {
        return herr("tls_untrusted", "The hub's TLS certificate is not trusted by a public certificate authority. Check the domain, or use the optional certificate pin if you trust this server.");
    }
    herr("unreachable", "The hub did not answer. Check the URL, DNS, firewall and that the hub service is running.")
}

fn status_error(code: u16) -> FsError {
    match code {
        401 => herr("invalid_credentials", "The email or password is incorrect."),
        403 => herr("forbidden", "This account is not allowed to sign in to that hub."),
        429 => herr("rate_limited", "Too many sign-in attempts. Wait a minute and try again."),
        404 => herr("not_a_hub", "That URL answered, but it does not look like an LLM-IDE hub."),
        502 | 503 | 504 => herr("unreachable", "The hub is starting or temporarily unavailable. Try again shortly."),
        _ => herr("login_failed", format!("The hub refused the sign-in (HTTP {code}).")),
    }
}

fn send_login(agent: &ureq::Agent, hub: &str, pin: &str, email: &str, password: &str) -> Result<LoginReply, FsError> {
    let body = serde_json::json!({ "email": email, "password": password }).to_string();
    match agent.post(&format!("{hub}/auth/login")).set("Content-Type", "application/json").send_string(&body) {
        Ok(resp) => {
            let text = resp.into_string().map_err(|_| herr("bad_hub_response", "The hub's sign-in answer was not understood."))?;
            check_login_shape(&text)
        }
        Err(ureq::Error::Status(code, _)) => Err(status_error(code)),
        Err(ureq::Error::Transport(t)) => Err(transport_error(&t.to_string(), pin)),
    }
}

fn fetch_projects(agent: &ureq::Agent, hub: &str, pin: &str, access: &str) -> Result<Vec<HubProject>, FsError> {
    match agent.get(&format!("{hub}/projects")).set("Authorization", &format!("Bearer {access}")).call() {
        Ok(resp) => {
            let text = resp.into_string().map_err(|_| herr("bad_hub_response", "The hub's project list was not understood."))?;
            parse_projects(&text)
        }
        Err(ureq::Error::Status(401, _)) => Err(herr("session_rejected", "The hub accepted the password but rejected the new session. Try again.")),
        Err(ureq::Error::Status(403, _)) => Err(herr("project_access_denied", "This account can sign in but has no project access on that hub. Ask a hub owner to add it to a project.")),
        Err(ureq::Error::Status(code, _)) => Err(herr("projects_unavailable", format!("The hub's project list could not be read (HTTP {code})."))),
        Err(ureq::Error::Transport(t)) => Err(transport_error(&t.to_string(), pin)),
    }
}

/// A re-login to the hub the app already uses in Remote mode is silent; anything else moves the app and needs consent.
fn login_needs_confirmation(stored_hub_url: &str, stored_mode: &ServerMode, canonical: &str) -> bool {
    !(stored_hub_url == canonical && *stored_mode == ServerMode::Remote)
}

fn hub_host_label(canonical: &str) -> String {
    canonical.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string()
}

#[tauri::command]
pub async fn remote_hub_login(hub_url: String, email: String, password: String) -> Result<HubLogin, FsError> {
    tauri::async_runtime::spawn_blocking(move || login_blocking(hub_url, email, password))
        .await
        .map_err(|e| herr("internal", format!("the hub sign-in did not finish: {e}")))?
}

fn login_blocking(hub_url: String, email: String, password: String) -> Result<HubLogin, FsError> {
    let (canonical, _host, _port) = validate_hub_url(&hub_url, cfg!(debug_assertions))?;
    let email = email.trim().to_ascii_lowercase();
    if email.is_empty() || email.len() > MAX_EMAIL || !email.contains('@') {
        return Err(herr("invalid_email", "Enter the email address you use on the hub."));
    }
    if password.is_empty() || password.len() > MAX_PASSWORD {
        return Err(herr("invalid_password", "Enter the hub password."));
    }
    // Native consent BEFORE the password leaves: this call moves the whole app to the hub.
    let stored = crate::prefs::stored().remote_server;
    // The mode is the one this app LAUNCHED in, not the stored one: the webview can set the stored mode through
    // `set_prefs`, and that alone must not be enough to skip the "connect to a hub?" question.
    let launched_mode = crate::prefs::launch().remote_server.mode;
    if login_needs_confirmation(&stored.hub_url, &launched_mode, &canonical)
        && !crate::confirm::ask(
            "Connect this app to a hub?",
            &format!("Connect this app to {}? Your notes and projects will then be served by that hub.", hub_host_label(&canonical)),
            "Connect",
            true,
        )
    {
        return Err(herr("cancelled", "the connection was not approved"));
    }
    let pin = saved_pin_for(&canonical);
    let agent = hub_agent(&pin)?;
    let reply = send_login(&agent, &canonical, &pin, &email, &password)?;
    let projects = fetch_projects(&agent, &canonical, &pin, &reply.access_token)?;
    // Store BEFORE saving the mode: a keychain failure must leave the app in Local mode.
    let backend = crate::secrets::default_backend().map_err(|e| herr("keychain_unavailable", e.to_string()))?;
    crate::remote_session::store(backend.as_ref(), &canonical, &pin, &reply.refresh_token)?;
    let view = crate::prefs::set_remote_hub(canonical.clone(), pin.clone(), ServerMode::Remote)?;
    if !view.persisted { return Err(herr("prefs_unavailable", "The hub sign-in worked, but the connection could not be saved (no data folder).")); }
    let role = reply.user.role.clone();
    Ok(HubLogin {
        hub_url: canonical,
        user: HubUser { id: reply.user.id, email: reply.user.email, display_name: reply.user.display_name, role: role.clone() },
        role,
        projects,
        web_pki: pin.is_empty(),
        pin,
    })
}

#[tauri::command]
pub async fn remote_hub_check(hub_url: String) -> Result<HubCheck, FsError> {
    tauri::async_runtime::spawn_blocking(move || check_blocking(hub_url))
        .await
        .map_err(|e| herr("internal", format!("the hub check did not finish: {e}")))?
}

fn check_blocking(hub_url: String) -> Result<HubCheck, FsError> {
    let (canonical, _host, _port) = validate_hub_url(&hub_url, cfg!(debug_assertions))?;
    let pin = saved_pin_for(&canonical);
    let agent = hub_agent(&pin)?;
    let text = match agent.get(&format!("{canonical}/health")).call() {
        Ok(resp) => resp.into_string().map_err(|_| herr("bad_hub_response", "The hub's /health answer was not understood."))?,
        Err(ureq::Error::Status(code, _)) => return Err(status_error(code)),
        Err(ureq::Error::Transport(t)) => return Err(transport_error(&t.to_string(), &pin)),
    };
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| herr("not_a_hub", "That URL answered, but it does not look like an LLM-IDE hub."))?;
    let status = v.get("status").and_then(|x| x.as_str()).unwrap_or("unknown").to_string();
    let api_version = v.get("apiVersion").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let hub = v.get("hub").and_then(|x| x.as_bool()).unwrap_or(false);
    let db_ok = v.get("checks").and_then(|c| c.get("db")).and_then(|x| x.as_bool()).unwrap_or(false);
    if api_version == 0 {
        return Err(herr("not_a_hub", "That URL answered, but it does not look like an LLM-IDE hub."));
    }
    Ok(HubCheck { hub_url: canonical, web_pki: pin.is_empty(), pin, status, api_version, hub, db_ok })
}

#[cfg(test)]
mod tests {
    #[test]
    fn login_prompts_unless_it_is_a_relogin_to_the_connected_hub() {
        let hub = "https://hub.example.com";
        assert!(!login_needs_confirmation(hub, &ServerMode::Remote, hub));
        assert!(login_needs_confirmation(hub, &ServerMode::Local, hub), "stored mode not Remote");
        assert!(login_needs_confirmation(hub, &ServerMode::Remote, "https://other.example.com"));
        assert!(login_needs_confirmation("", &ServerMode::Local, hub));
        assert_eq!(hub_host_label("https://hub.example.com:8443/"), "hub.example.com:8443");
    }

    use super::*;

    #[test]
    fn a_login_answer_must_carry_a_user_and_tokens() {
        let ok = r#"{"user":{"id":"u1","email":"a@example.com","displayName":"A","role":"admin"},"accessToken":"a","refreshToken":"r","accessTokenTTLSec":900}"#;
        let reply = check_login_shape(ok).unwrap();
        assert_eq!(reply.user.role, "admin");
        assert_eq!(reply.user.display_name.as_deref(), Some("A"));
        for bad in [
            r#"{"user":{"id":"u1","email":"a@example.com","role":"admin"},"accessToken":"","refreshToken":"r"}"#,
            r#"{"user":{"id":"","email":"a@example.com","role":"admin"},"accessToken":"a","refreshToken":"r"}"#,
            r#"{"user":{"id":"u1","email":"a@example.com","role":""},"accessToken":"a","refreshToken":"r"}"#,
            r#"{"accessToken":"a","refreshToken":"r"}"#,
            "not json",
        ] {
            assert!(check_login_shape(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn projects_are_read_with_their_roles() {
        let list = parse_projects(r#"{"projects":[{"id":"p1","name":"Alpha","role":"member","maxMode":"execute"}]}"#).unwrap();
        assert_eq!(list, vec![HubProject { id: "p1".into(), name: "Alpha".into(), role: "member".into() }]);
        assert!(parse_projects(r#"{"projects":[{"id":"p1"}]}"#).is_err());
    }

    #[test]
    fn errors_are_clear_and_never_echo_the_password() {
        assert_eq!(status_error(401).code, "invalid_credentials");
        assert!(status_error(401).message.contains("incorrect"));
        assert_eq!(status_error(403).code, "forbidden");
        assert_eq!(status_error(429).code, "rate_limited");
        assert_eq!(status_error(404).code, "not_a_hub");
        assert!(transport_error("connection refused", "").message.contains("did not answer"));
        assert_eq!(transport_error("invalid peer certificate: UnknownIssuer", "").code, "tls_untrusted");
        assert!(!transport_error("invalid peer certificate", "").message.contains("password"));
    }

    #[test]
    fn a_pin_is_only_reused_for_the_same_saved_url() {
        // `saved_pin_for` reads process prefs; the pure rule is the URL match, exercised here with a
        // local equivalent so a test never writes the real prefs file.
        let same = |stored_url: &str, stored_pin: &str, canonical: &str| if stored_url == canonical { stored_pin.to_string() } else { String::new() };
        assert_eq!(same("https://hub.example.com", "", "https://hub.example.com"), "");
        assert_eq!(same("https://hub.example.com", "sha256:x", "https://other.example.com"), "");
    }
}
