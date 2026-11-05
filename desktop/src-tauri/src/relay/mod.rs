//! Desktop end of the account relay (docs/superpowers/plans/2026-11-05-relay.md, rulings R-4 to R-6).
//! Keys never leave this process; the core only ever sees plain Host API frames over the loopback bridge.
pub mod crypto;
pub mod registry;
pub mod bridge;
