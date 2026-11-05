//! Desktop sign-in to the public account service: OAuth 2.0 Authorization Code + PKCE in the system
//! browser, loopback callback, token/profile kept in the OS secret store. The webview never sees a
//! token and never supplies the account origin or a redirect URI.
//!
//! The account service is not public yet; `LLMIDE_ACCOUNTS_ORIGIN` exists so a local service can be
//! tested. Production defaults to https://accounts.llm-ide.com.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
use p256::SecretKey;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::secrets::{default_backend, SecretBackend};

const TOKENS_ACCOUNT: &str = "account-tokens";
const PROFILE_ACCOUNT: &str = "account-profile";
const DEVICE_KEYS_ACCOUNT: &str = "account-device-keys";
const DEFAULT_ORIGIN: &str = "https://accounts.llm-ide.com";
const CLIENT_ID: &str = "llmide-desktop";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Profile {
    email: String,
}

/// What Settings may see: no token, no refresh token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AccountStatus {
    pub signed_in: bool,
    pub email: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The configured account origin. https anywhere; http only for a loopback development service.
pub fn account_origin(raw: Option<&str>) -> Result<Url, String> {
    let text = raw.map(str::trim).filter(|v| !v.is_empty()).unwrap_or(DEFAULT_ORIGIN);
    let url = Url::parse(text).map_err(|_| "LLMIDE_ACCOUNTS_ORIGIN is not a valid URL".to_string())?;
    if !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("LLMIDE_ACCOUNTS_ORIGIN must be a bare origin".into());
    }
    let loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("LLMIDE_ACCOUNTS_ORIGIN must use https (http is allowed only for loopback development)".into());
    }
    Ok(url)
}

fn origin() -> Result<Url, String> {
    account_origin(std::env::var("LLMIDE_ACCOUNTS_ORIGIN").ok().as_deref())
}

fn random_urlsafe(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("cannot generate random values: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn store() -> Result<Box<dyn SecretBackend>, String> {
    default_backend().map_err(|e| e.to_string())
}

fn load_tokens(backend: &dyn SecretBackend) -> Result<Option<Tokens>, String> {
    match backend.get(TOKENS_ACCOUNT).map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw).map(Some).map_err(|_| "stored account tokens are unreadable".to_string()),
    }
}

fn load_profile(backend: &dyn SecretBackend) -> Result<Option<Profile>, String> {
    match backend.get(PROFILE_ACCOUNT).map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw).map(Some).map_err(|_| "stored account profile is unreadable".to_string()),
    }
}

fn status_from(backend: &dyn SecretBackend) -> Result<AccountStatus, String> {
    let signed_in = load_tokens(backend)?.is_some();
    let email = if signed_in { load_profile(backend)?.map(|p| p.email) } else { None };
    Ok(AccountStatus { signed_in, email })
}

/// Open the authorize URL and wait for the exact loopback callback.
fn authorize_and_wait(origin: &Url) -> Result<(String, String, String), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("cannot open the sign-in callback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/auth/callback");
    let state = random_urlsafe(32)?;
    let verifier = random_urlsafe(48)?;
    let challenge = pkce_challenge(&verifier);
    let mut auth = origin.clone();
    auth.set_path("/v1/oauth/authorize");
    auth.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    crate::os_open::spawn_url(auth.as_str()).map_err(|e| e.message)?;

    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    let mut stream: TcpStream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("The sign-in window timed out. Try again.".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("the sign-in callback failed: {e}")),
        }
    };
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).map_err(|e| format!("cannot read the sign-in callback: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("/");
    let callback = Url::parse(&format!("http://127.0.0.1{path}")).map_err(|_| "the sign-in callback was invalid".to_string())?;
    let mut got_state = None;
    let mut code = None;
    for (k, v) in callback.query_pairs() {
        if k == "state" { got_state = Some(v.into_owned()); }
        else if k == "code" { code = Some(v.into_owned()); }
    }
    let ok = got_state.as_deref() == Some(state.as_str()) && code.is_some();
    let body = if ok { "LLM-IDE sign-in complete. You can close this window." } else { "LLM-IDE sign-in failed. You can close this window." };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    if !ok { return Err("The sign-in callback did not match this request.".into()); }
    Ok((redirect, code.expect("checked above"), verifier))
}

fn exchange(origin: &Url, code: &str, verifier: &str, redirect: &str) -> Result<Tokens, String> {
    let response = ureq::post(&format!("{origin}v1/oauth/token"))
        .set("content-type", "application/x-www-form-urlencoded")
        .send_form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("redirect_uri", redirect),
            ("code_verifier", verifier),
        ]);
    let body = match response {
        Ok(r) => r.into_string().map_err(|e| format!("cannot read the account reply: {e}"))?,
        Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(),
        Err(e) => return Err(format!("cannot reach the account service: {e}")),
    };
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|_| "the account service returned an invalid reply".to_string())?;
    let access = parsed.get("access_token").and_then(|v| v.as_str()).ok_or_else(|| "the account service did not return an access token".to_string())?;
    let refresh = parsed.get("refresh_token").and_then(|v| v.as_str()).ok_or_else(|| "the account service did not return a refresh token".to_string())?;
    let expires_in = parsed.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(900);
    Ok(Tokens { access_token: access.into(), refresh_token: refresh.into(), expires_at: now_secs() + expires_in })
}

fn fetch_email(origin: &Url, tokens: &Tokens) -> Result<String, String> {
    let response = ureq::get(&format!("{origin}v1/account"))
        .set("authorization", &format!("Bearer {}", tokens.access_token))
        .call();
    let body = match response {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(),
        Err(e) => return Err(format!("cannot reach the account service: {e}")),
    };
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|_| "the account service returned an invalid profile".to_string())?;
    parsed.get("email").and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| "the account service returned no email".into())
}

fn sign_in_blocking() -> Result<AccountStatus, String> {
    let origin = origin()?;
    let (redirect, code, verifier) = authorize_and_wait(&origin)?;
    let tokens = exchange(&origin, &code, &verifier, &redirect)?;
    let email = fetch_email(&origin, &tokens)?;
    let backend = store()?;
    backend.set(TOKENS_ACCOUNT, &serde_json::to_string(&tokens).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    backend.set(PROFILE_ACCOUNT, &serde_json::to_string(&Profile { email: email.clone() }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(AccountStatus { signed_in: true, email: Some(email) })
}


#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceKeys {
    signing_secret: String,
    ecdh_secret: String,
    signing_public: String,
    ecdh_public: String,
}

fn b64(bytes: &[u8]) -> String { URL_SAFE_NO_PAD.encode(bytes) }

/// Generate once, keep the private halves only in the OS store. The public halves go to the account
/// service; the relay will use the private halves for signed wraps later.
fn device_keys(backend: &dyn SecretBackend) -> Result<DeviceKeys, String> {
    if let Some(raw) = backend.get(DEVICE_KEYS_ACCOUNT).map_err(|e| e.to_string())? {
        return serde_json::from_str(&raw).map_err(|_| "stored desktop keys are unreadable".to_string());
    }
    let signing = SecretKey::random(&mut OsRng);
    let ecdh = SecretKey::random(&mut OsRng);
    let keys = DeviceKeys {
        signing_secret: b64(signing.to_pkcs8_der().map_err(|e| e.to_string())?.as_bytes()),
        ecdh_secret: b64(ecdh.to_pkcs8_der().map_err(|e| e.to_string())?.as_bytes()),
        signing_public: b64(signing.public_key().to_public_key_der().map_err(|e| e.to_string())?.as_bytes()),
        ecdh_public: b64(ecdh.public_key().to_public_key_der().map_err(|e| e.to_string())?.as_bytes()),
    };
    backend.set(DEVICE_KEYS_ACCOUNT, &serde_json::to_string(&keys).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(keys)
}

fn access_token(origin: &Url, backend: &dyn SecretBackend) -> Result<String, String> {
    let mut tokens = load_tokens(backend)?.ok_or_else(|| "Sign in to LLM-IDE first.".to_string())?;
    if tokens.expires_at > now_secs() + 60 {
        return Ok(tokens.access_token);
    }
    let response = ureq::post(&format!("{origin}v1/oauth/token"))
        .set("content-type", "application/x-www-form-urlencoded")
        .send_form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", &tokens.refresh_token),
        ]);
    let body = match response {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(_, r)) => return Err(r.into_string().unwrap_or_else(|_| "Your LLM-IDE session expired. Sign in again.".into())),
        Err(e) => return Err(format!("cannot reach the account service: {e}")),
    };
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|_| "the account service returned an invalid reply".to_string())?;
    let access = parsed.get("access_token").and_then(|v| v.as_str()).ok_or_else(|| "Your LLM-IDE session expired. Sign in again.".to_string())?;
    let refresh = parsed.get("refresh_token").and_then(|v| v.as_str()).ok_or_else(|| "Your LLM-IDE session expired. Sign in again.".to_string())?;
    let expires_in = parsed.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(900);
    tokens.access_token = access.into();
    tokens.refresh_token = refresh.into();
    tokens.expires_at = now_secs() + expires_in;
    backend.set(TOKENS_ACCOUNT, &serde_json::to_string(&tokens).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(tokens.access_token)
}

fn register_desktop_blocking() -> Result<AccountStatus, String> {
    let origin = origin()?;
    let backend = store()?;
    let access = access_token(&origin, backend.as_ref())?;
    let keys = device_keys(backend.as_ref())?;
    let payload = serde_json::json!({
        "label": hostname_label(),
        "signingKey": keys.signing_public,
        "ecdhKey": keys.ecdh_public,
    });
    let response = ureq::post(&format!("{origin}v1/desktop"))
        .set("authorization", &format!("Bearer {access}"))
        .set("content-type", "application/json")
        .send_string(&payload.to_string());
    match response {
        Ok(_) => {}
        Err(ureq::Error::Status(409, _)) => return Err("This account already has a desktop registered. Replace-desktop is not available yet.".into()),
        Err(ureq::Error::Status(_, r)) => return Err(r.into_string().unwrap_or_else(|_| "The account service refused this desktop.".into())),
        Err(e) => return Err(format!("cannot reach the account service: {e}")),
    }
    status_from(backend.as_ref())
}

fn hostname_label() -> String {
    std::env::var("HOSTNAME").ok().filter(|v| !v.trim().is_empty()).map(|v| v.trim().chars().take(80).collect()).unwrap_or_else(|| "LLM-IDE desktop".into())
}
/// Webview-visible: a boolean and the display email; never a token.
#[tauri::command]
pub async fn account_status() -> Result<AccountStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let backend = store()?;
        status_from(backend.as_ref())
    })
    .await
    .map_err(|e| format!("account task failed: {e}"))?
}

#[tauri::command]
pub async fn account_sign_in() -> Result<AccountStatus, String> {
    tauri::async_runtime::spawn_blocking(sign_in_blocking)
    .await
    .map_err(|e| format!("account task failed: {e}"))?
}

#[tauri::command]
pub async fn account_register_desktop() -> Result<AccountStatus, String> {
    tauri::async_runtime::spawn_blocking(register_desktop_blocking)
        .await
        .map_err(|e| format!("account task failed: {e}"))?
}

#[tauri::command]
pub async fn account_sign_out() -> Result<AccountStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let backend = store()?;
        // Best effort: revoke the refresh family before dropping the local copy. Local sign-out still
        // completes if the account service is unreachable.
        if let Ok(origin) = origin() {
            if let Ok(Some(tokens)) = load_tokens(backend.as_ref()) {
                let _ = ureq::post(&format!("{origin}v1/oauth/revoke"))
                    .set("content-type", "application/x-www-form-urlencoded")
                    .send_form(&[("client_id", CLIENT_ID), ("token", &tokens.refresh_token)]);
            }
        }
        backend.delete(TOKENS_ACCOUNT).map_err(|e| e.to_string())?;
        backend.delete(PROFILE_ACCOUNT).map_err(|e| e.to_string())?;
        status_from(backend.as_ref())
    })
    .await
    .map_err(|e| format!("account task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    #[test]
    fn pkce_matches_the_rfc_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn origin_is_exact_and_loopback_only_over_plain_http() {
        assert_eq!(account_origin(None).unwrap().as_str(), "https://accounts.llm-ide.com/");
        assert!(account_origin(Some("https://accounts.llm-ide.com")).is_ok());
        assert!(account_origin(Some("http://127.0.0.1:3470")).is_ok());
        assert!(account_origin(Some("http://accounts.llm-ide.com")).is_err());
        assert!(account_origin(Some("https://accounts.llm-ide.com/x")).is_err());
        assert!(account_origin(Some("https://user:pw@accounts.llm-ide.com")).is_err());
    }

    #[test]
    fn device_keys_are_generated_once_and_private_halves_stay_in_the_store() {
        let b = MemoryBackend::default();
        let one = device_keys(&b).unwrap();
        let two = device_keys(&b).unwrap();
        assert_eq!(one.signing_public, two.signing_public);
        assert_eq!(one.ecdh_public, two.ecdh_public);
        assert!(!one.signing_secret.is_empty() && !one.ecdh_secret.is_empty());
        assert_ne!(one.signing_secret, one.ecdh_secret);
        assert!(!serde_json::to_string(&status_from(&b).unwrap()).unwrap().contains(&one.signing_secret));
    }

    #[test]
    fn tokens_and_profile_are_kept_out_of_the_status() {
        let b = MemoryBackend::default();
        let tokens = Tokens { access_token: "a".repeat(43), refresh_token: "r".repeat(43), expires_at: 1 };
        b.set(TOKENS_ACCOUNT, &serde_json::to_string(&tokens).unwrap()).unwrap();
        b.set(PROFILE_ACCOUNT, &serde_json::to_string(&Profile { email: "ada@example.com".into() }).unwrap()).unwrap();
        let st = status_from(&b).unwrap();
        assert!(st.signed_in);
        assert_eq!(st.email.as_deref(), Some("ada@example.com"));
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains(&tokens.access_token) && !json.contains(&tokens.refresh_token));
        b.delete(TOKENS_ACCOUNT).unwrap();
        b.delete(PROFILE_ACCOUNT).unwrap();
        assert!(!status_from(&b).unwrap().signed_in);
    }
}
