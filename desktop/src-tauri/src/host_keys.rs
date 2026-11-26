//! The one place that runs `ssh-keyscan` and reads its answer. Both the SSH server test and the hub deploy scan
//! go through it, so neither can wait forever on a host that accepts the connection and then says nothing, and
//! both parse, fingerprint and spell a known_hosts line the same way. What each trusts stays with its caller:
//! the hub confirms per session, SSH server mode keeps saved pins.

use std::time::Duration;

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::remote::RawOutput;
use crate::ssh_transport::run_hub_program;

/// Seconds `ssh-keyscan` itself waits for the server (its `-T`).
const KEYSCAN_TIMEOUT_SECS: &str = "10";
/// Hard bound on the whole process, in case `-T` is not honoured (a stalled proxy, a dead resolver).
pub(crate) const KEYSCAN_DEADLINE: Duration = Duration::from_secs(60);

/// `ssh-keyscan` argv. `host` and `port` are validated by the callers, so neither can start with '-'.
/// `key_type` narrows the scan to one algorithm (`-t`), as the deploy scan does for a confirmed key.
pub(crate) fn keyscan_args(host: &str, port: u16, key_type: Option<&str>) -> Vec<String> {
    let mut args = vec!["-T".to_string(), KEYSCAN_TIMEOUT_SECS.to_string(), "-p".to_string(), port.to_string()];
    if let Some(key_type) = key_type {
        args.push("-t".to_string());
        args.push(key_type.to_string());
    }
    args.push(host.to_string());
    args
}

/// Runs `ssh-keyscan` with no stdin under [`KEYSCAN_DEADLINE`]. A deadline surfaces as `ErrorKind::TimedOut`.
pub(crate) fn keyscan(host: &str, port: u16, key_type: Option<&str>) -> std::io::Result<RawOutput> {
    run_hub_program("ssh-keyscan", &keyscan_args(host, port, key_type), None, KEYSCAN_DEADLINE)
}

/// The `(key type, key base64)` pairs of `ssh-keyscan` output, in scan order. Blank lines, comments and lines
/// with fewer than three fields are skipped. The scan's host column is ignored: it is untrusted, and callers tie
/// a key only to the endpoint the user typed.
pub(crate) fn parse_scan(scan: &str) -> impl Iterator<Item = (&str, &str)> {
    scan.lines().filter_map(|raw| {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let mut fields = line.split_whitespace();
        let (_scanned_host, key_type, key_b64) = (fields.next()?, fields.next()?, fields.next()?);
        Some((key_type, key_b64))
    })
}

/// OpenSSH SHA256 fingerprint of a base64 key blob: `SHA256:` + unpadded base64.
pub(crate) fn fingerprint_for_key_b64(key_b64: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(key_b64.trim()).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)))
}

/// The known_hosts spelling of a host: bare on port 22, `[host]:port` otherwise (OpenSSH rule).
pub(crate) fn known_host_name(host: &str, port: u16) -> String {
    if port == 22 { host.to_string() } else { format!("[{host}]:{port}") }
}

/// One known_hosts line, re-spelled from the validated endpoint so a scan answer cannot inject another host pattern.
pub(crate) fn known_hosts_line(host: &str, port: u16, key_type: &str, key_b64: &str) -> String {
    format!("{} {key_type} {key_b64}", known_host_name(host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scan_parser_skips_noise_and_ignores_the_host_column() {
        let scan = "# example.com:22 SSH-2.0-x\n\nbroken line\nevil.example ssh-ed25519 AAAA extra\n";
        assert_eq!(parse_scan(scan).collect::<Vec<_>>(), vec![("ssh-ed25519", "AAAA")]);
    }

    #[test]
    fn known_host_names_follow_the_openssh_port_rule() {
        assert_eq!(known_host_name("hub.example.com", 22), "hub.example.com");
        assert_eq!(known_host_name("hub.example.com", 2222), "[hub.example.com]:2222");
        assert_eq!(known_hosts_line("h", 22, "ssh-ed25519", "AAAA"), "h ssh-ed25519 AAAA");
    }

    #[test]
    fn argv_without_a_key_type() {
        assert_eq!(keyscan_args("example.com", 2222, None), vec!["-T", "10", "-p", "2222", "example.com"]);
    }

    #[test]
    fn argv_with_a_key_type_puts_the_host_last() {
        assert_eq!(
            keyscan_args("example.com", 22, Some("ssh-ed25519")),
            vec!["-T", "10", "-p", "22", "-t", "ssh-ed25519", "example.com"]
        );
    }

    #[test]
    fn the_whole_scan_has_a_deadline_longer_than_the_server_wait() {
        assert!(KEYSCAN_DEADLINE > Duration::from_secs(10));
        assert!(KEYSCAN_DEADLINE <= Duration::from_secs(120));
    }
}
