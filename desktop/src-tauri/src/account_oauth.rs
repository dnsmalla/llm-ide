//! Desktop sign-in to the public account service: OAuth 2.0 Authorization Code + PKCE in the system
//! browser, loopback callback, token/profile kept in the OS secret store. The webview never sees a
//! token and never supplies the account origin or a redirect URI.
//!
//! The account service is not public yet; `LLMIDE_ACCOUNTS_ORIGIN` exists so a local service can be
//! tested. Production defaults to https://accounts.llm-ide.com.

use std::io::{Read, Write};
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
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

// The desktop nonce chosen by THIS app for each pending link; never trusted from a service reply.
static LINK_NONCES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static LINK_PINS: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
// Serializes every read-modify-write of the account token, device-key and relay registry secrets. Never hold it
// across a call that takes it again (access_token and device_keys both take it).
pub(crate) static STORE_LOCK: Mutex<()> = Mutex::new(());
fn link_nonces() -> &'static Mutex<HashMap<String, String>> { LINK_NONCES.get_or_init(|| Mutex::new(HashMap::new())) }
fn link_pins() -> &'static Mutex<HashMap<String, (String, String)>> { LINK_PINS.get_or_init(|| Mutex::new(HashMap::new())) }

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
    let response = ureq::get(&format!("{origin}v1/desktop/account"))
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
    let stored = fetch_email(&origin, &tokens).and_then(|email| {
        let backend = store()?;
        backend.set(TOKENS_ACCOUNT, &serde_json::to_string(&tokens).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        backend.set(PROFILE_ACCOUNT, &serde_json::to_string(&Profile { email: email.clone() }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(email)
    });
    match stored {
        Ok(email) => Ok(AccountStatus { signed_in: true, email: Some(email) }),
        Err(e) => {
            // Never leave a minted refresh family live on the server when this sign-in is abandoned.
            revoke_refresh(&origin, &tokens.refresh_token);
            Err(e)
        }
    }
}

/// Best effort; the server answers 200 whether or not the token existed.
fn revoke_refresh(origin: &Url, refresh_token: &str) {
    let _ = ureq::post(&format!("{origin}v1/oauth/revoke"))
        .set("content-type", "application/x-www-form-urlencoded")
        .send_form(&[("client_id", CLIENT_ID), ("token", refresh_token)]);
}


#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceKeys {
    signing_secret: String,
    ecdh_secret: String,
    signing_public: String,
    ecdh_public: String,
}

fn b64(bytes: &[u8]) -> String { URL_SAFE_NO_PAD.encode(bytes) }

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

/// The desktop signing key and its SPKI, for relay wraps. Private half stays in the OS store.
pub(crate) fn desktop_signing() -> Result<(SigningKey, String), String> {
    let backend = store()?;
    let keys = device_keys(backend.as_ref())?;
    let der = URL_SAFE_NO_PAD.decode(&keys.signing_secret).map_err(|_| "stored desktop keys are unreadable".to_string())?;
    let signing = SigningKey::from(SecretKey::from_pkcs8_der(&der).map_err(|_| "stored desktop keys are unreadable".to_string())?);
    Ok((signing, keys.signing_public))
}

pub(crate) fn desktop_ecdh_public() -> Result<String, String> {
    let backend = store()?;
    Ok(device_keys(backend.as_ref())?.ecdh_public)
}

pub(crate) fn relay_access_token() -> Result<String, String> {
    let o = origin()?;
    let backend = store()?;
    access_token(&o, backend.as_ref())
}

pub(crate) fn relay_store() -> Result<Box<dyn SecretBackend>, String> { store() }

pub(crate) fn relay_url() -> Result<String, String> {
    let mut u = origin()?;
    let scheme = if u.scheme() == "https" { "wss" } else { "ws" };
    u.set_scheme(scheme).map_err(|_| "bad relay scheme".to_string())?;
    u.set_path("/relay/v1");
    Ok(u.to_string())
}

fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() { return false; }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The registration proof of possession; must match `desktopProofMessage` in
/// account-service/src/devices.mjs (pinned by account-service/tests/fixtures/desktop-proof-vector.json).
fn proof_message(access_token: &str, signing_public: &str, ecdh_public: &str) -> String {
    format!("llmide/desktop/register/v1\n{}\n{signing_public}\n{ecdh_public}", hex(&Sha256::digest(access_token.as_bytes())))
}

/// ECDSA P-256 / SHA-256 (RFC 6979, deterministic) over `proof_message`, raw r||s, base64url.
fn desktop_proof(keys: &DeviceKeys, access_token: &str) -> Result<String, String> {
    let unreadable = || "stored desktop keys are unreadable".to_string();
    let der = URL_SAFE_NO_PAD.decode(&keys.signing_secret).map_err(|_| unreadable())?;
    let signing = SigningKey::from(SecretKey::from_pkcs8_der(&der).map_err(|_| unreadable())?);
    let signature: Signature = signing.sign(proof_message(access_token, &keys.signing_public, &keys.ecdh_public).as_bytes());
    Ok(b64(&signature.to_bytes()))
}

/// Generate once, keep the private halves only in the OS store. The public halves go to the account
/// service; the relay will use the private halves for signed wraps later.
fn device_keys(backend: &dyn SecretBackend) -> Result<DeviceKeys, String> {
    let _store = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(raw) = backend.get(DEVICE_KEYS_ACCOUNT).map_err(|e| e.to_string())? {
        return serde_json::from_str(&raw).map_err(|_| "stored desktop keys are unreadable".to_string());
    }
    let keys = keys_from(&SecretKey::random(&mut OsRng), &SecretKey::random(&mut OsRng))?;
    backend.set(DEVICE_KEYS_ACCOUNT, &serde_json::to_string(&keys).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(keys)
}

fn keys_from(signing: &SecretKey, ecdh: &SecretKey) -> Result<DeviceKeys, String> {
    Ok(DeviceKeys {
        signing_secret: b64(signing.to_pkcs8_der().map_err(|e| e.to_string())?.as_bytes()),
        ecdh_secret: b64(ecdh.to_pkcs8_der().map_err(|e| e.to_string())?.as_bytes()),
        signing_public: b64(signing.public_key().to_public_key_der().map_err(|e| e.to_string())?.as_bytes()),
        ecdh_public: b64(ecdh.public_key().to_public_key_der().map_err(|e| e.to_string())?.as_bytes()),
    })
}

fn access_token(origin: &Url, backend: &dyn SecretBackend) -> Result<String, String> {
    // Held across the refresh, and the tokens are read only after taking it, so a second caller
    // reuses the first caller's refresh instead of spending the same refresh token again.
    let _store = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut tokens = load_tokens(backend)?.ok_or_else(|| "Sign in to LLM-IDE first.".to_string())?;
    if tokens.expires_at > now_secs() + 60 {
        return Ok(tokens.access_token);
    }
    // Bounded: STORE_LOCK is held across this call, so a hung account service must not block every writer.
    let response = ureq::post(&format!("{origin}v1/oauth/token"))
        .timeout(Duration::from_secs(15))
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

/// The UI offers "Replace this account's desktop" when registration fails with this text.
pub const DESKTOP_EXISTS: &str = "This account already has a desktop.";

/// `replace` is design 4.7: a fresh passkey sign-in first (the service requires one under 5 minutes),
/// then the service revokes the old desktop and unlinks every device.
fn register_desktop_blocking(replace: bool) -> Result<AccountStatus, String> {
    let origin = origin()?;
    if replace {
        sign_in_blocking()?;
    }
    let backend = store()?;
    let access = access_token(&origin, backend.as_ref())?;
    let keys = device_keys(backend.as_ref())?;
    let payload = serde_json::json!({
        "label": hostname_label(),
        "signingKey": keys.signing_public,
        "ecdhKey": keys.ecdh_public,
        "proof": desktop_proof(&keys, &access)?,
    });
    let url = if replace { format!("{origin}v1/desktop/replace") } else { format!("{origin}v1/desktop") };
    let response = ureq::post(&url)
        .set("authorization", &format!("Bearer {access}"))
        .set("content-type", "application/json")
        .send_string(&payload.to_string());
    match response {
        Ok(_) => {}
        Err(ureq::Error::Status(409, _)) => return Err(format!("{DESKTOP_EXISTS} Replace it to make this computer the account's desktop.")),
        Err(ureq::Error::Status(403, _)) => return Err("Changing the desktop is held for 72 hours after an email recovery.".into()),
        Err(ureq::Error::Status(_, r)) => return Err(r.into_string().unwrap_or_else(|_| "The account service refused this desktop.".into())),
        Err(e) => return Err(format!("cannot reach the account service: {e}")),
    }
    status_from(backend.as_ref())
}

fn hostname_label() -> String {
    std::env::var("HOSTNAME").ok().filter(|v| !v.trim().is_empty()).map(|v| v.trim().chars().take(80).collect()).unwrap_or_else(|| "LLM-IDE desktop".into())
}
/// Webview-visible: a boolean and the display email; never a token.

/// A pending link request as the Settings card sees it. Only public values and the SAS-derived code;
/// no token, no private key, no account password.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkRequest {
    pub request_id: String,
    pub device_id: String,
    pub state: String,
    pub kind: String,
    pub label: String,
    pub sas: Option<String>,
    pub commitment_ok: Option<bool>,
    pub signing_key: Option<String>,
    pub ecdh_key: Option<String>,
    pub commitment: Option<String>,
    pub device_nonce: Option<String>,
}

fn b64url_bytes(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(value).map_err(|_| "The link request contained an invalid key.".to_string())
}

fn link_commitment(signing_key: &str, ecdh_key: &str, nonce: &str) -> Result<String, String> {
    let mut h = Sha256::new();
    h.update(b"llmide/link/commit/v1");
    h.update(b64url_bytes(signing_key)?);
    h.update(b64url_bytes(ecdh_key)?);
    h.update(b64url_bytes(nonce)?);
    Ok(URL_SAFE_NO_PAD.encode(h.finalize()))
}

fn link_sas(signing_key: &str, ecdh_key: &str, desktop_signing_key: &str, desktop_ecdh_key: &str, device_nonce: &str, desktop_nonce: &str) -> Result<String, String> {
    let mut h = Sha256::new();
    h.update(b"llmide/link/sas/v1");
    for value in [signing_key, ecdh_key, desktop_signing_key, desktop_ecdh_key, device_nonce, desktop_nonce] {
        h.update(b64url_bytes(value)?);
    }
    let digest = h.finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    Ok(format!("{n:06}"))
}

fn account_json(origin: &Url, path: &str, method: &str, access: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let url = format!("{origin}{path}");
    let mut req = match method {
        "GET" => ureq::get(&url),
        "POST" => ureq::post(&url),
        _ => return Err("unsupported account request".into()),
    };
    req = req.set("authorization", &format!("Bearer {access}"));
    let response = match body {
        Some(value) => req.set("content-type", "application/json").send_string(&value.to_string()),
        None => req.call(),
    };
    let text = match response {
        Ok(r) => r.into_string().map_err(|e| format!("cannot read the account reply: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            let code = serde_json::from_str::<serde_json::Value>(&detail).ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("account request failed ({code})"));
            return Err(match code.as_str() {
                "desktop_missing" => "Register this desktop before approving a phone or browser.".into(),
                "not_approved" => "The desktop has not approved this request yet.".into(),
                "not_ready" => "The device has not revealed its keys yet. Refresh in a moment.".into(),
                "already_linked" => "This device is already linked.".into(),
                "commitment_mismatch" => "The device's keys do not match the request commitment.".into(),
                _ => code,
            });
        }
        Err(e) => return Err(format!("cannot reach the account service: {e}")),
    };
    serde_json::from_str(&text).map_err(|_| "the account service returned an invalid link reply".to_string())
}

fn link_requests_blocking() -> Result<Vec<LinkRequest>, String> {
    let origin = origin()?;
    let backend = store()?;
    let access = access_token(&origin, backend.as_ref())?;
    let desktop = device_keys(backend.as_ref())?;
    let reply = account_json(&origin, "v1/link/requests", "GET", &access, None)?;
    let items = reply.get("requests").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let get = |key: &str| item.get(key).and_then(|v| v.as_str()).map(str::to_string);
        let state = get("state").unwrap_or_default();
        let signing = get("signingKey");
        let ecdh = get("ecdhKey");
        let device_nonce = get("deviceNonce");
        let desktop_nonce = get("desktopNonce");
        let commitment = get("commitment");
        let mut sas = None;
        let mut commitment_ok = None;
        if let (Some(signing), Some(ecdh), Some(device_nonce), Some(desktop_nonce), Some(commitment)) = (&signing, &ecdh, &device_nonce, &desktop_nonce, &commitment) {
            let ok = link_commitment(signing, ecdh, device_nonce)?.as_str() == commitment.as_str();
            let our_nonce = link_nonces().lock().ok().and_then(|m| m.get(&get("requestId").unwrap_or_default()).cloned());
            let nonce_ok = our_nonce.as_deref() == Some(desktop_nonce.as_str());
            commitment_ok = Some(ok && nonce_ok);
            if ok && nonce_ok {
                sas = Some(link_sas(signing, ecdh, &desktop.signing_public, &desktop.ecdh_public, device_nonce, desktop_nonce)?);
            }
        }
        out.push(LinkRequest {
            request_id: get("requestId").unwrap_or_default(),
            device_id: get("deviceId").unwrap_or_default(),
            state: if state == "unlinked" { "unlinked".into() } else { state },
            kind: get("kind").unwrap_or_default(),
            label: get("label").unwrap_or_default(),
            sas,
            commitment_ok,
            signing_key: signing,
            ecdh_key: ecdh,
            commitment: get("commitment"),
            device_nonce: get("deviceNonce"),
        });
    }
    Ok(out)
}

fn link_action_blocking(request_id: String, action: &str) -> Result<(), String> {
    let origin = origin()?;
    let backend = store()?;
    let access = access_token(&origin, backend.as_ref())?;
    let body = match action {
        "approve" => {
            let nonce = random_urlsafe(32)?;
            let req = link_requests_blocking()?.into_iter().find(|r| r.request_id == request_id).ok_or("This request is gone.")?;
            let commitment = req.commitment.clone().ok_or("The service did not return a commitment.")?;
            if let Ok(mut m) = link_nonces().lock() { m.insert(request_id.clone(), nonce.clone()); }
            if let Ok(mut m) = link_pins().lock() { m.insert(request_id.clone(), (commitment, nonce.clone())); }
            let (signer, _): (SigningKey, String) = desktop_signing()?;
            let proof = URL_SAFE_NO_PAD.encode(Signer::<Signature>::sign(&signer, format!("llmide/link/approve/v1\n{request_id}\n{nonce}").as_bytes()).to_bytes());
            serde_json::json!({ "requestId": request_id, "desktopNonce": nonce, "proof": proof })
        }
        "confirm" => {
            let (signer, _): (SigningKey, String) = desktop_signing()?;
            let proof = URL_SAFE_NO_PAD.encode(Signer::<Signature>::sign(&signer, format!("llmide/link/confirm/v1\n{request_id}").as_bytes()).to_bytes());
            serde_json::json!({ "requestId": request_id, "proof": proof })
        }
        _ => serde_json::json!({ "requestId": request_id }),
    };
    let result = account_json(&origin, &format!("v1/link/requests/{action}"), "POST", &access, Some(body));
    if action != "approve" { if let Ok(mut m) = link_nonces().lock() { m.remove(&request_id); } }
    result?;
    Ok(())
}

#[tauri::command]
pub async fn account_link_requests() -> Result<Vec<LinkRequest>, String> {
    tauri::async_runtime::spawn_blocking(link_requests_blocking)
        .await
        .map_err(|e| format!("account task failed: {e}"))?
}

#[tauri::command]
pub async fn account_link_approve(request_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || link_action_blocking(request_id, "approve"))
        .await
        .map_err(|e| format!("account task failed: {e}"))?
}

#[tauri::command]
pub async fn account_link_deny(request_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || link_action_blocking(request_id, "deny"))
        .await
        .map_err(|e| format!("account task failed: {e}"))?
}

#[tauri::command]
pub async fn account_link_confirm(request_id: String, sas: String, pin: String, host: tauri::State<'_, crate::core_host::CoreHost>) -> Result<(), String> {
    let core = host.verified_url().filter(|_| host.status().trust == "spawned").ok_or("Relay needs the core this app started.")?;
    tauri::async_runtime::spawn_blocking(move || link_confirm_blocking(request_id, sas, pin, core))
        .await
        .map_err(|e| format!("account task failed: {e}"))?
}

fn link_confirm_message(x: &serde_json::Value) -> String {
    format!("llmide/link/confirm/v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        x["requestId"].as_str().unwrap_or_default(), x["commitment"].as_str().unwrap_or_default(),
        x["signingKey"].as_str().unwrap_or_default(), x["ecdhKey"].as_str().unwrap_or_default(),
        x["desktopSigningKey"].as_str().unwrap_or_default(), x["desktopEcdhKey"].as_str().unwrap_or_default(),
        x["deviceNonce"].as_str().unwrap_or_default(), x["desktopNonce"].as_str().unwrap_or_default(),
        x["tier"].as_str().unwrap_or("web"), x["sas"].as_str().unwrap_or_default())
}

fn link_confirm_blocking(request_id: String, sas: String, pin: String, core: String) -> Result<(), String> {
    let (pinned_commitment, pinned_nonce) = link_pins().lock().ok()
        .and_then(|m| m.get(&request_id).cloned())
        .ok_or("Approve this request from this desktop window first.")?;
    let r = link_requests_blocking()?.into_iter().find(|r| r.request_id == request_id).ok_or("This request is gone.")?;
    if r.state != "keys" || !r.commitment_ok.unwrap_or(false) { return Err("The device's keys do not match its commitment.".into()); }
    if r.commitment.as_deref() != Some(pinned_commitment.as_str()) { return Err("The service changed the commitment after approval.".into()); }
    let signing = r.signing_key.clone().ok_or("missing device signing key")?;
    let ecdh_key = r.ecdh_key.clone().ok_or("missing device key")?;
    let device_nonce = r.device_nonce.clone().ok_or("missing device nonce")?;
    if link_commitment(&signing, &ecdh_key, &device_nonce)? != pinned_commitment { return Err("The revealed keys do not match the pinned commitment.".into()); }
    let desktop_ecdh = desktop_ecdh_public()?;
    let (signer, signing_spki) = desktop_signing()?;
    let expected = link_sas(&signing, &ecdh_key, &signing_spki, &desktop_ecdh, &device_nonce, &pinned_nonce)?;
    if !ct_eq(&expected, &sas) { return Err("The code you confirmed is not this device's code.".into()); }
    let tier = "web"; // never take the tier from the service
    let body = serde_json::json!({
        "requestId": request_id, "sas": expected,
        "commitment": pinned_commitment, "signingKey": signing, "ecdhKey": ecdh_key,
        "desktopSigningKey": signing_spki, "desktopEcdhKey": desktop_ecdh,
        "deviceNonce": device_nonce, "desktopNonce": pinned_nonce, "tier": tier,
    });
    let proof = URL_SAFE_NO_PAD.encode(Signer::<Signature>::sign(&signer, link_confirm_message(&body).as_bytes()).to_bytes());
    let o = origin()?;
    let backend = store()?;
    account_json(&o, "v1/link/requests/confirm", "POST", &access_token(&o, backend.as_ref())?,
        Some(serde_json::json!({ "requestId": request_id, "sas": expected, "proof": proof })))?;
    let token = crate::relay::bridge::pair(&core, tier, &r.label, &pin)
        .map_err(|e| format!("Linked, but this computer could not finish setup ({e}). Revoke the device and link again."))?;
    // Fetched before the store lock: access_token takes that lock itself.
    let acct = if crate::relay::registry::load(backend.as_ref())?.desktop_id.is_empty() {
        Some(account_json(&o, "v1/desktop/account", "GET", &access_token(&o, backend.as_ref())?, None)?)
    } else {
        None
    };
    let _store = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut reg = crate::relay::registry::load(backend.as_ref())?;
    if let Some(acct) = acct.filter(|_| reg.desktop_id.is_empty()) {
        reg.user_id = acct["id"].as_str().unwrap_or_default().to_string();
        reg.desktop_id = acct["desktopId"].as_str().ok_or("Register this desktop first.")?.to_string();
    }
    reg.ensure_root();
    let root = reg.root_bytes()?;
    let device_id = r.device_id.clone();
    let (rq, rp) = crate::relay::crypto::device_keys(&root, &reg.user_id, &reg.desktop_id, &device_id, reg.epoch);
    let wrap = crate::relay::crypto::make_wrap(&crate::relay::crypto::WrapInput {
        user_id: &reg.user_id, desktop_id: &reg.desktop_id, device_id: &device_id, epoch: reg.epoch, tier, seq: now_secs(), issued_at: now_secs() * 1000,
        device_ecdh_spki: &b64url_bytes(&ecdh_key)?, desktop_signing_spki: &b64url_bytes(&signing_spki)?, request: &rq, reply: &rp, host_api_token: &token,
    }, &signer, None, None).map_err(|e| format!("could not build the device key ({e})"))?;
    reg.add(crate::relay::registry::Device {
        device_id, label: r.label.clone(), tier: tier.into(), signing_key: r.signing_key.clone().unwrap_or_default(), ecdh_key: r.ecdh_key.clone().unwrap_or_default(),
        linked_at: now_secs(), confirmed: false, host_api_token: token, wrap_sig: wrap.sig.clone(), wrap: Some(serde_json::to_string(&wrap).map_err(|e| e.to_string())?), reply_count: 0,
    });
    crate::relay::registry::save(backend.as_ref(), &reg)?;
    if let Ok(mut m) = link_pins().lock() { m.remove(&request_id); }
    if let Ok(mut m) = link_nonces().lock() { m.remove(&request_id); }
    Ok(())
}

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
pub async fn account_register_desktop(replace: Option<bool>) -> Result<AccountStatus, String> {
    tauri::async_runtime::spawn_blocking(move || register_desktop_blocking(replace.unwrap_or(false)))
        .await
        .map_err(|e| format!("account task failed: {e}"))?
}

#[tauri::command]
pub async fn account_sign_out() -> Result<AccountStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::relay::stop_running();
        let backend = store()?;
        // Best effort: revoke the refresh family before dropping the local copy. Local sign-out still
        // completes if the account service is unreachable.
        if let Ok(origin) = origin() {
            if let Ok(Some(tokens)) = load_tokens(backend.as_ref()) {
                revoke_refresh(&origin, &tokens.refresh_token);
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
    fn https_account_requests_have_a_tls_backend() {
        let err = account_json(&Url::parse("https://127.0.0.1:1/").unwrap(), "v1/x", "GET", "t", None).unwrap_err();
        assert!(!err.contains("TLS backend"), "{err}");
    }

    #[test]
    fn concurrent_refreshes_spend_the_refresh_token_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = Url::parse(&format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port())).unwrap();
        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                // Read the whole form body (Content-Length) before answering, so the client sees a clean reply.
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                let head_end = loop {
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
                    match stream.read(&mut chunk) { Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]), _ => break buf.len() }
                };
                let head = String::from_utf8_lossy(&buf[..head_end.min(buf.len())]).to_lowercase();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                while buf.len() < head_end + len {
                    match stream.read(&mut chunk) { Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]), _ => break }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let body = r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":900}"#;
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body);
            }
        });
        let backend = MemoryBackend::default();
        backend.set(TOKENS_ACCOUNT, &serde_json::to_string(&Tokens { access_token: "old".into(), refresh_token: "r0".into(), expires_at: 1 }).unwrap()).unwrap();
        let (a, b) = std::thread::scope(|s| {
            let a = s.spawn(|| access_token(&origin, &backend));
            let b = s.spawn(|| access_token(&origin, &backend));
            (a.join().unwrap(), b.join().unwrap())
        });
        assert_eq!(a.unwrap(), "new-access");
        assert_eq!(b.unwrap(), "new-access");
        assert_eq!(hits.load(Ordering::SeqCst), 1, "one refresh for two callers");
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

    /// Pins the proof format to the service verifier (account-service tests read the same file).
    #[test]
    fn proof_matches_the_service_vector() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../../account-service/tests/fixtures/desktop-proof-vector.json")).unwrap();
        let s = |k: &str| v[k].as_str().unwrap().to_string();
        let keys = keys_from(&SecretKey::from_slice(&[1u8; 32]).unwrap(), &SecretKey::from_slice(&[2u8; 32]).unwrap()).unwrap();
        let token = s("accessToken");
        let msg = proof_message(&token, &keys.signing_public, &keys.ecdh_public);
        let proof = desktop_proof(&keys, &token).unwrap();
        if std::env::var("PRINT_PROOF_VECTOR").is_ok() {
            println!("{}", serde_json::json!({ "accessToken": token, "tokenHash": hex(&Sha256::digest(token.as_bytes())), "signingKey": keys.signing_public, "ecdhKey": keys.ecdh_public, "message": msg, "proof": proof }));
        }
        assert_eq!(keys.signing_public, s("signingKey"));
        assert_eq!(keys.ecdh_public, s("ecdhKey"));
        assert_eq!(hex(&Sha256::digest(token.as_bytes())), s("tokenHash"));
        assert_eq!(msg, s("message"));
        assert_eq!(proof, s("proof"));
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
    /// Pins the linking bytes the service checks: raw SPKI DER + nonce, not the base64url text.
    #[test]
    fn link_commitment_and_sas_match_the_service_vector() {
        let signing = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIJ7JKU7uML0jWaO0HouA-rF2Q-N2ElkshbKon2bZ5OiMrS5-SImMneH5FPDSR2PRm49CTpACSI-igZGEq6JPBw";
        let ecdh = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEy-roH-xmwlElK-Hr6ZCG9WMBsiYaSwzoHuWryhyfeOFxeM5FZOKdoMiEGf91_ZrEIg9V20v5SvZshr-CGGNMsA";
        let desktop = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8nQPwarzYqTh25KMR87RTq2QDrTj0ZzBHC4jcUQiHs9WmgwuoN6X6XpUjq_VgH23HZ66bKOKkvcnB4IwRL043Q";
        let nd = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
        let nk = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";
        assert_eq!(link_commitment(signing, ecdh, nd).unwrap(), "Hmrt1CRsIXMxjpr927_sWlrOJCGQnyetTtwFVEXZlFg");
        assert_eq!(link_sas(signing, ecdh, desktop, ecdh, nd, nk).unwrap(), "274406");
        assert!(link_commitment("not-a-key", ecdh, nd).is_err());
    }

}
