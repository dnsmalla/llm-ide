//! Pinned TLS for the hub: a leaf-SPKI probe, a rustls verifier that enforces the pin alongside the
//! normal chain/hostname checks, and the `ureq` agent the loopback proxy uses.
//!
//! Pin format is the contract's `sha256:` + 43 base64url characters over the leaf certificate's
//! SubjectPublicKeyInfo DER. `certbot --key-type ecdsa --reuse-key` keeps that key stable across
//! renewals; a rotated key fails closed and the UI must re-probe and explicitly re-trust.
//!
//! The minimal DER walker below extracts only SubjectPublicKeyInfo; it is not a general X.509 parser.

use std::io::Write;
use std::net::TcpStream;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, Error, RootCertStore, SignatureScheme};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::confirm::herr;
use crate::fs_ops::FsError;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TlsInfo {
    pub fingerprint: String,
    /// True when the handshake was validated by the public WebPKI roots alone. A public CA
    /// certificate needs no pin; the fingerprint is shown only as an optional fallback.
    pub web_pki: bool,
    pub subject: String,
    pub issuer: String,
    pub not_before: i64,
    pub not_after: i64,
    pub dns_names: Vec<String>,
}

/// `sha256:` + base64url(SPKI) with no padding.
pub fn fingerprint_from_spki(spki: &[u8]) -> String {
    format!("sha256:{}", URL_SAFE_NO_PAD.encode(Sha256::digest(spki)))
}

pub fn valid_pin(pin: &str) -> bool {
    pin.len() == 50 && pin.starts_with("sha256:") && pin[7..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn tlv(buf: &[u8], pos: usize) -> Option<(u8, usize, usize, usize)> {
    let tag = *buf.get(pos)?;
    let first = *buf.get(pos + 1)? as usize;
    let (len, header) = if first & 0x80 == 0 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 { return None; }
        let mut len = 0usize;
        for i in 0..n { len = (len << 8) | *buf.get(pos + 2 + i)? as usize; }
        (len, 2 + n)
    };
    let content = pos + header;
    let end = content.checked_add(len)?;
    if end > buf.len() { return None; }
    Some((tag, content, len, end))
}

fn children(buf: &[u8], start: usize, end: usize) -> Option<Vec<(usize, usize)>> {
    let mut out = Vec::new();
    let mut p = start;
    while p < end {
        let (_, _, _, next) = tlv(buf, p)?;
        if next <= p { return None; }
        out.push((p, next));
        p = next;
    }
    Some(out)
}

/// The full DER TLV of the certificate's SubjectPublicKeyInfo.
pub fn spki_of_certificate(cert: &[u8]) -> Option<&[u8]> {
    let (tag, cs, _len, _) = tlv(cert, 0)?;
    if tag != 0x30 { return None; }
    let (tbs_tag, tbs_start, tbs_len, _) = tlv(cert, cs)?;
    if tbs_tag != 0x30 { return None; }
    let kids = children(cert, tbs_start, tbs_start + tbs_len)?;
    let mut i = 0;
    if cert.get(kids.first()?.0)? == &0xa0 { i = 1; }
    let (start, end) = *kids.get(i + 5)?; // serial, signature, issuer, validity, subject, SPKI
    Some(&cert[start..end])
}

pub fn fingerprint_of_certificate(cert: &[u8]) -> Option<String> {
    spki_of_certificate(cert).map(fingerprint_from_spki)
}

fn roots() -> Arc<RootCertStore> {
    let mut r = RootCertStore::empty();
    r.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(r)
}

#[derive(Debug)]
struct PinVerifier {
    inner: Arc<WebPkiServerVerifier>,
    pin: String,
}

/// The most recent pin mismatch seen by a handshake (fingerprint + unix seconds). The loopback proxy
/// takes it after a transport error so the webview gets HUB_PIN_MISMATCH instead of a generic outage.
fn last_mismatch() -> &'static Mutex<Option<(u64, String)>> {
    static LAST: OnceLock<Mutex<Option<(u64, String)>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn note_mismatch(got: &str) {
    if valid_pin(got) {
        *last_mismatch().lock().unwrap_or_else(|e| e.into_inner()) = Some((now_secs(), got.to_string()));
    }
}

/// Take a pin mismatch seen in the last 10 seconds. Taking clears it, so one failed handshake explains
/// exactly one proxy error and a stale entry cannot label an unrelated outage.
pub fn take_pin_mismatch() -> Option<String> {
    let mut slot = last_mismatch().lock().unwrap_or_else(|e| e.into_inner());
    let (at, got) = slot.take()?;
    if now_secs().saturating_sub(at) > 10 { return None; }
    Some(got)
}

/// Parse the verifier's error text when the global slot was already consumed (a retry / race).
pub fn mismatch_fingerprint(text: &str) -> Option<String> {
    let marker = "REMOTE_TLS_PIN_MISMATCH: the hub now presents ";
    let rest = text.split_once(marker)?.1;
    let got: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_')).collect();
    if valid_pin(&got) { Some(got) } else { None }
}

impl PinVerifier {
    fn new(pin: &str) -> Result<Self, FsError> {
        Self::with_roots(pin, roots())
    }

    /// Test seam: the WebPKI chain is checked against the same store, so a pin never bypasses it.
    fn with_roots(pin: &str, roots: Arc<RootCertStore>) -> Result<Self, FsError> {
        let inner = WebPkiServerVerifier::builder(roots).build()
            .map_err(|e| herr("tls_config", format!("cannot build the TLS verifier: {e}")))?;
        Ok(Self { inner, pin: pin.to_string() })
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>, ocsp_response: &[u8], now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let ok = self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)?;
        let got = fingerprint_of_certificate(end_entity.as_ref())
            .ok_or_else(|| Error::General("the hub certificate has no readable SPKI".into()))?;
        if !constant_eq(got.as_bytes(), self.pin.as_bytes()) {
            note_mismatch(&got);
            return Err(Error::General(format!("REMOTE_TLS_PIN_MISMATCH: the hub now presents {got}")));
        }
        Ok(ok)
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> { self.inner.supported_verify_schemes() }
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b) { d |= x ^ y; }
    d == 0
}

pub fn pinned_agent(pin: &str) -> Result<ureq::Agent, FsError> {
    if !valid_pin(pin) { return Err(herr("invalid_pin", "the TLS pin is not a sha256 SPKI pin")); }
    let verifier = PinVerifier::new(pin)?;
    let cfg = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(ureq::AgentBuilder::new()
        .tls_config(Arc::new(cfg))
        .redirects(0)
        .timeout_connect(Duration::from_secs(10))
        .build())
}

/// Normal WebPKI trust: the public roots only. This is the default for a hub on a public domain;
/// a valid publicly-issued certificate is accepted without the user pinning anything.
pub fn public_agent() -> Result<ureq::Agent, FsError> {
    let cfg = ClientConfig::builder()
        .with_root_certificates(roots())
        .with_no_client_auth();
    Ok(ureq::AgentBuilder::new()
        .tls_config(Arc::new(cfg))
        .redirects(0)
        .timeout_connect(Duration::from_secs(10))
        .build())
}

/// The hub agent for a saved pin: an empty pin means ordinary WebPKI trust, any pin means the
/// explicit fallback. A pin never replaces chain validation (the verifier still runs WebPKI).
pub fn hub_agent(pin: &str) -> Result<ureq::Agent, FsError> {
    if pin.trim().is_empty() { public_agent() } else { pinned_agent(pin.trim()) }
}

pub(crate) fn split_hub(hub: &str) -> Result<(String, u16), FsError> {
    let rest = hub.strip_prefix("https://").ok_or_else(|| herr("invalid_hub", "the hub URL must start with https://"))?;
    if rest.contains('/') || rest.contains('@') || rest.contains('?') || rest.contains('#') || rest.contains(['\r', '\n', ' ']) {
        return Err(herr("invalid_hub", "the hub URL must be https://host[:port] with no path"));
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => (h, p.parse::<u16>().map_err(|_| herr("invalid_hub", "bad port"))?),
        _ => (rest, 443),
    };
    if host.is_empty() || host.len() > 253 || host.starts_with('-') || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err(herr("invalid_hub", "the hub host is not valid"));
    }
    Ok((host.to_string(), port))
}

/// A public DNS name: at least two labels, no IP literal, no localhost/private-only name.
/// The TLD cannot be numeric so a bare IPv4 literal is refused.
pub fn is_public_domain(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h.is_empty() || h.len() > 253 || h.parse::<std::net::Ipv4Addr>().is_ok() || h.parse::<std::net::Ipv6Addr>().is_ok() {
        return false;
    }
    let labels: Vec<&str> = h.split('.').collect();
    if labels.len() < 2 { return false; }
    let Some(tld) = labels.last() else { return false; };
    if tld.chars().all(|c| c.is_ascii_digit()) { return false; }
    // Names reserved for local networks are never a public domain, so a public CA cannot issue them.
    if matches!(*tld, "local" | "localhost" | "internal" | "lan" | "home" | "test" | "invalid" | "onion" | "alt") { return false; }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

pub fn is_dev_localhost(host: &str) -> bool {
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// URL-first validation: `https://<public-domain>[:port]`, no path/query/fragment/userinfo.
/// A localhost name is accepted only when `allow_localhost` (debug builds), never in a release.
/// Returns `(canonical_url, host, port)`, with the default 443 port omitted.
pub fn validate_hub_url(url: &str, allow_localhost: bool) -> Result<(String, String, u16), FsError> {
    let text = url.trim();
    if text.is_empty() || text.len() > 300 {
        return Err(herr("invalid_hub_url", "Enter an https:// URL for the hub."));
    }
    let (host, port) = split_hub(text)?;
    if port == 0 { return Err(herr("invalid_hub_url", "The hub port must be between 1 and 65535.")); }
    let host_l = host.to_ascii_lowercase();
    if is_dev_localhost(&host_l) {
        if !allow_localhost {
            return Err(herr("invalid_hub_url", "Use the hub's public HTTPS domain. localhost is allowed only in a development build."));
        }
    } else if !is_public_domain(&host_l) {
        return Err(herr("invalid_hub_url", "Enter a public domain name (for example hub.example.com), not an IP address or a bare host name."));
    }
    let canonical = if port == 443 { format!("https://{host_l}") } else { format!("https://{host_l}:{port}") };
    Ok((canonical, host_l, port))
}

/// Reads the leaf certificate over a normal (chain-validated) TLS handshake and returns its SPKI pin.
/// It never trusts the pin; the caller shows it and the user confirms it.
#[tauri::command]
pub async fn remote_tls_probe(hub_url: String) -> Result<TlsInfo, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        // The probe validates the chain against the public roots; a valid public CA certificate
        // succeeds and needs no pin. The fingerprint is offered only as an optional fallback.
        let (canonical, host, port) = validate_hub_url(&hub_url, cfg!(debug_assertions))?;
        let cfg = ClientConfig::builder().with_root_certificates(roots()).with_no_client_auth();
        let name = ServerName::try_from(host.clone()).map_err(|_| herr("invalid_hub_url", "the hub host is not a valid DNS name"))?;
        let mut conn = ClientConnection::new(Arc::new(cfg), name).map_err(|e| herr("tls_failed", format!("TLS setup failed: {e}")))?;
        let mut sock = TcpStream::connect((host.as_str(), port)).map_err(|e| herr("tls_unreachable", format!("cannot reach {host}:{port}: {e}")))?;
        sock.set_read_timeout(Some(Duration::from_secs(10))).ok();
        sock.set_write_timeout(Some(Duration::from_secs(10))).ok();
        while conn.is_handshaking() {
            conn.complete_io(&mut sock).map_err(|e| herr("tls_failed", format!("TLS handshake failed: {e}")))?;
        }
        let certs = conn.peer_certificates().ok_or_else(|| herr("tls_failed", "the hub presented no certificate"))?;
        let leaf = certs.first().ok_or_else(|| herr("tls_failed", "the hub presented no leaf certificate"))?;
        let fingerprint = fingerprint_of_certificate(leaf.as_ref()).ok_or_else(|| herr("tls_failed", "the leaf SPKI is unreadable"))?;
        *last_probe().lock().unwrap_or_else(|e| e.into_inner()) = Some((canonical.clone(), fingerprint.clone()));
        let _ = sock.flush();
        Ok(TlsInfo { fingerprint, web_pki: true, subject: String::new(), issuer: String::new(), not_before: 0, not_after: 0, dns_names: Vec::new() })
    }).await.map_err(|e| herr("internal", format!("the TLS probe did not finish: {e}")))?
}

fn last_probe() -> &'static Mutex<Option<(String, String)>> {
    static LAST: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// Stores `remote_server.hub_url` + `tls_pin` after the user confirms the probe. No other pref changes.
#[tauri::command]
pub async fn remote_tls_pin(hub_url: String, fingerprint: String) -> Result<(), FsError> {
    // The native confirm blocks: keep it off the main thread like every other confirm::ask caller.
    tauri::async_runtime::spawn_blocking(move || pin_blocking(hub_url, fingerprint))
        .await
        .map_err(|_| herr("cancelled", "the certificate was not trusted"))?
}

fn pin_blocking(hub_url: String, fingerprint: String) -> Result<(), FsError> {
    let (canonical, _host, _port) = validate_hub_url(&hub_url, cfg!(debug_assertions))?;
    if !valid_pin(&fingerprint) { return Err(herr("invalid_pin", "the fingerprint is not a sha256 SPKI pin")); }
    // Pin only a fingerprint this host actually probed for this URL (the UI comparison is not authority).
    let matches = last_probe().lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        .is_some_and(|(h, f)| h == &canonical && f == &fingerprint);
    if !matches { return Err(herr("probe_required", "probe the hub certificate before trusting it")); }
    // R-034 #11: the final pin is a native decision, not only a webview button.
    if !crate::confirm::ask(
        "Trust this hub certificate?",
        &format!("Pin the certificate now presented by {canonical}? A different certificate later will refuse to connect. Public CA certificates do not need a pin."),
        "Trust certificate",
        true,
    ) {
        return Err(herr("cancelled", "the certificate was not trusted"));
    }
    let view = crate::prefs::set_remote_pin(canonical, fingerprint)?;
    if !view.persisted { return Err(herr("prefs_unavailable", "the pin could not be saved (no data folder)")); }
    Ok(())
}

/// Only the already-stored hub URL may be unpinned.
fn unpin_target_allowed(stored_hub_url: &str, canonical: &str) -> Result<(), FsError> {
    if stored_hub_url.is_empty() || stored_hub_url != canonical {
        return Err(herr("unknown_hub", "that is not the hub this app is configured for; connect to it first"));
    }
    Ok(())
}

/// Drop the optional pin after the user explicitly chooses public-CA trust again. No native
/// prompt is needed: removing a pin only restores ordinary WebPKI validation, never weakens it,
/// and it can only act on the hub URL that is already stored.
#[tauri::command]
pub async fn remote_tls_unpin(hub_url: String) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (canonical, _host, _port) = validate_hub_url(&hub_url, cfg!(debug_assertions))?;
        // Unpin must never introduce a hub URL: the URL is written only by the probe/trust path and the
        // confirmed login, so a webview-chosen URL is refused here.
        unpin_target_allowed(&crate::prefs::stored().remote_server.hub_url, &canonical)?;
        let view = crate::prefs::set_remote_pin(canonical, String::new())?;
        if !view.persisted { return Err(herr("prefs_unavailable", "the pin could not be saved (no data folder)")); }
        Ok(())
    }).await.map_err(|e| herr("internal", format!("the pin removal did not finish: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_shape_and_spki_extraction() {
        assert!(valid_pin("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assert!(!valid_pin("sha256:short"));
        // A minimal certificate-shaped DER is not required here: the fingerprint helper is exercised with
        // a synthesised SPKI, and the parser has a negative test for a non-certificate.
        assert_eq!(fingerprint_from_spki(b"abc").len(), 50);
        assert!(spki_of_certificate(b"not a certificate").is_none());
    }

    #[test]
    fn the_contract_vector_matches_the_spki_fingerprint() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../../schema/host-api/v1/fixtures/security/identity-vector.json")).unwrap();
        let spki = base64::engine::general_purpose::STANDARD.decode(v["spkiDerBase64"].as_str().unwrap()).unwrap();
        assert_eq!(fingerprint_from_spki(&spki), v["fingerprint"].as_str().unwrap());
    }

    #[test]
    fn unpin_refuses_any_url_that_is_not_the_stored_hub() {
        assert_eq!(unpin_target_allowed("", "https://evil.example.com").unwrap_err().code, "unknown_hub");
        assert_eq!(unpin_target_allowed("https://hub.example.com", "https://evil.example.com").unwrap_err().code, "unknown_hub");
        assert!(unpin_target_allowed("https://hub.example.com", "https://hub.example.com").is_ok());
    }

    #[test]
    fn pinning_requires_a_matching_probe() {
        let err = pin_blocking("https://hub.example.com".into(), "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()).unwrap_err();
        assert_eq!(err.code, "probe_required");
    }

    fn test_chain() -> (rcgen::Certificate, rcgen::KeyPair, rcgen::Certificate, rcgen::KeyPair, rcgen::Certificate, rcgen::Certificate) {
        use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
        let mut ca_params = CertificateParams::new(Vec::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca_key = KeyPair::generate().unwrap();
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let mut leaf_params = CertificateParams::new(vec!["hub.example.com".to_string()]).unwrap();
        let leaf_key = KeyPair::generate().unwrap();
        let leaf = leaf_params.signed_by(&leaf_key, &ca, &ca_key).unwrap();
        let mut other_ca_params = CertificateParams::new(Vec::new()).unwrap();
        other_ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let other_ca_key = KeyPair::generate().unwrap();
        let other_ca = other_ca_params.self_signed(&other_ca_key).unwrap();
        let mut other_leaf_params = CertificateParams::new(vec!["hub.example.com".to_string()]).unwrap();
        let other_leaf_key = KeyPair::generate().unwrap();
        let other_leaf = other_leaf_params.signed_by(&other_leaf_key, &other_ca, &other_ca_key).unwrap();
        (ca, ca_key, leaf, leaf_key, other_ca, other_leaf)
    }

    fn verifier_for(ca: &rcgen::Certificate, pin: &str) -> PinVerifier {
        let mut store = RootCertStore::empty();
        store.add(ca.der().clone()).unwrap();
        PinVerifier::with_roots(pin, Arc::new(store)).unwrap()
    }

    fn verify(v: &PinVerifier, leaf: &rcgen::Certificate) -> Result<ServerCertVerified, Error> {
        let name = ServerName::try_from("hub.example.com").unwrap();
        let now = UnixTime::since_unix_epoch(Duration::from_secs(now_secs()));
        v.verify_server_cert(leaf.der(), &[], &name, &[], now)
    }

    #[test]
    fn r034_a_matching_pin_with_a_valid_chain_verifies() {
        let (ca, _ca_key, leaf, _leaf_key, _other_ca, _other_leaf) = test_chain();
        let pin = fingerprint_of_certificate(leaf.der()).unwrap();
        let v = verifier_for(&ca, &pin);
        assert!(verify(&v, &leaf).is_ok());
    }

    #[test]
    fn r034_another_pin_is_a_distinct_mismatch_and_records_the_presented_pin() {
        let (ca, _ca_key, leaf, _leaf_key, _other_ca, _other_leaf) = test_chain();
        let _ = take_pin_mismatch();
        let wrong = fingerprint_from_spki(b"not this key");
        let v = verifier_for(&ca, &wrong);
        let err = verify(&v, &leaf).unwrap_err();
        assert!(format!("{err}").contains("REMOTE_TLS_PIN_MISMATCH"));
        let got = take_pin_mismatch().expect("the verifier records what the hub presented");
        assert_eq!(got, fingerprint_of_certificate(leaf.der()).unwrap());
        assert_eq!(mismatch_fingerprint(&format!("{err}")).as_deref(), Some(got.as_str()));
    }

    #[test]
    fn r034_a_pin_never_bypasses_webpki_chain_validation() {
        let (ca, _ca_key, _leaf, _leaf_key, _other_ca, other_leaf) = test_chain();
        let pin = fingerprint_of_certificate(other_leaf.der()).unwrap();
        let v = verifier_for(&ca, &pin);
        let err = verify(&v, &other_leaf).unwrap_err();
        assert!(!format!("{err}").contains("REMOTE_TLS_PIN_MISMATCH"), "an untrusted chain fails before the pin comparison");
    }

    #[test]
    fn a_mismatched_pin_is_never_constant_equal() {
        assert!(constant_eq(b"abc", b"abc"));
        assert!(!constant_eq(b"abc", b"abd"));
        assert!(!constant_eq(b"abc", b"ab"));
    }

    #[test]
    fn hub_split_accepts_only_https_host_forms() {
        assert_eq!(split_hub("https://hub.example.com").unwrap(), ("hub.example.com".into(), 443));
        assert_eq!(split_hub("https://hub.example.com:8443").unwrap(), ("hub.example.com".into(), 8443));
        for bad in ["http://hub.example.com", "https://hub.example.com/path", "https://u@hub.example.com", "https://hub.example.com?x", "https://-hub.example.com"] {
            assert!(split_hub(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn url_first_validation_requires_a_public_domain_and_trims() {
        assert_eq!(validate_hub_url("  https://Hub.Example.com  ", false).unwrap(), ("https://hub.example.com".into(), "hub.example.com".into(), 443));
        assert_eq!(validate_hub_url("https://hub.example.com:8443", false).unwrap().2, 8443);
        // A bare IP, a private/single-label name and localhost are not public domains.
        for bad in ["https://8.8.8.8", "https://192.168.1.10", "https://hub", "https://hub.local", "http://hub.example.com", "https://hub.example.com/path", "https://user@hub.example.com"] {
            assert!(validate_hub_url(bad, false).is_err(), "{bad}");
        }
        // localhost is the explicit development exception.
        assert!(validate_hub_url("https://localhost", false).is_err());
        assert_eq!(validate_hub_url("https://localhost:3457", true).unwrap(), ("https://localhost:3457".into(), "localhost".into(), 3457));
        assert_eq!(validate_hub_url("https://127.0.0.1", true).unwrap().1, "127.0.0.1");
    }

    #[test]
    fn an_empty_pin_selects_webpki_and_a_pin_is_the_optional_fallback() {
        assert!(hub_agent("").is_ok());
        assert!(hub_agent("   ").is_ok());
        assert!(hub_agent("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_ok());
        assert!(hub_agent("sha256:short").is_err());
    }
}
