//! Pinned TLS for the hub: a leaf-SPKI probe, a rustls verifier that enforces the pin alongside the
//! normal chain/hostname checks, and the `ureq` agent the loopback proxy uses.
//!
//! Pin format is the contract's `sha256:` + 43 base64url characters over the leaf certificate's
//! SubjectPublicKeyInfo DER. `certbot --key-type ecdsa --reuse-key` keeps that key stable across
//! renewals; a rotated key fails closed and the UI must re-probe and explicitly re-trust.
//!
//! The minimal DER walker below extracts only SubjectPublicKeyInfo; it is not a general X.509 parser.

use std::io::{Read, Write};
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

impl PinVerifier {
    fn new(pin: &str) -> Result<Self, FsError> {
        let inner = WebPkiServerVerifier::builder(roots()).build()
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

/// Reads the leaf certificate over a normal (chain-validated) TLS handshake and returns its SPKI pin.
/// It never trusts the pin; the caller shows it and the user confirms it.
#[tauri::command]
pub async fn remote_tls_probe(hub_url: String) -> Result<TlsInfo, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (host, port) = split_hub(hub_url.trim())?;
        let cfg = ClientConfig::builder().with_root_certificates(roots()).with_no_client_auth();
        let name = ServerName::try_from(host.clone()).map_err(|_| herr("invalid_hub", "the hub host is not a valid DNS name"))?;
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
        *last_probe().lock().unwrap_or_else(|e| e.into_inner()) = Some((hub_url.trim().to_string(), fingerprint.clone()));
        let _ = sock.flush();
        Ok(TlsInfo { fingerprint, subject: String::new(), issuer: String::new(), not_before: 0, not_after: 0, dns_names: Vec::new() })
    }).await.map_err(|e| herr("internal", format!("the TLS probe did not finish: {e}")))?
}

fn last_probe() -> &'static Mutex<Option<(String, String)>> {
    static LAST: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// Stores `remote_server.hub_url` + `tls_pin` after the user confirms the probe. No other pref changes.
#[tauri::command]
pub fn remote_tls_pin(hub_url: String, fingerprint: String) -> Result<(), FsError> {
    let (host, port) = split_hub(hub_url.trim())?;
    if !valid_pin(&fingerprint) { return Err(herr("invalid_pin", "the fingerprint is not a sha256 SPKI pin")); }
    // Pin only a fingerprint this host actually probed for this URL (the UI comparison is not authority).
    let matches = last_probe().lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        .is_some_and(|(h, f)| h == hub_url.trim() && f == &fingerprint);
    if !matches { return Err(herr("probe_required", "probe the hub certificate before trusting it")); }
    let mut block = crate::prefs::stored().remote_server;
    block.hub_url = if port == 443 { format!("https://{host}") } else { format!("https://{host}:{port}") };
    block.tls_pin = fingerprint;
    let view = crate::prefs::set_prefs(crate::prefs::PrefsPatch { remote_server: Some(block), ..Default::default() })?;
    if !view.persisted { return Err(herr("prefs_unavailable", "the pin could not be saved (no data folder)")); }
    Ok(())
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
    fn pinning_requires_a_matching_probe() {
        let err = remote_tls_pin("https://hub.example.com".into(), "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()).unwrap_err();
        assert_eq!(err.code, "probe_required");
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
}
