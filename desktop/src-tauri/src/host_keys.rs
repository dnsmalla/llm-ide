//! The one place that runs `ssh-keyscan`. Both the SSH server test and the hub deploy scan go through it, so
//! neither can wait forever on a host that accepts the connection and then says nothing.

use std::time::Duration;

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

#[cfg(test)]
mod tests {
    use super::*;

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
