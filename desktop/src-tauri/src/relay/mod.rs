//! Desktop end of the account relay (docs/superpowers/plans/2026-11-05-relay.md, rulings R-4 to R-6).
//! Keys never leave this process; the core only ever sees plain Host API frames over the loopback bridge.
pub mod crypto;
pub mod registry;
pub mod bridge;
pub mod client;

use std::sync::{Arc, Mutex, OnceLock};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::core_host::CoreHost;

static HANDLE: OnceLock<Mutex<Option<client::RelayHandle>>> = OnceLock::new();
fn handle_slot() -> &'static Mutex<Option<client::RelayHandle>> { HANDLE.get_or_init(|| Mutex::new(None)) }

#[tauri::command]
pub async fn relay_status() -> Result<client::RelayStatus, String> {
    Ok(handle_slot().lock().map_err(|_| "relay state is unavailable".to_string())?
        .as_ref().map(|h| h.status()).unwrap_or_default())
}

#[tauri::command]
pub async fn relay_set_enabled(enabled: bool, host: tauri::State<'_, CoreHost>) -> Result<client::RelayStatus, String> {
    let mut store = crate::account_oauth::relay_store()?;
    let mut reg = registry::load(store.as_ref())?;
    if enabled {
        let core = host.verified_url().filter(|_| host.status().trust == "spawned")
            .ok_or("Relay needs the core this app started.")?;
        if reg.desktop_id.is_empty() { return Err("Register this desktop first.".to_string()); }
        reg.enabled = true;
        registry::save(store.as_ref(), &reg)?;
        let (signer, spki) = crate::account_oauth::desktop_signing()?;
        let signing_spki = URL_SAFE_NO_PAD.decode(spki).map_err(|_| "bad signing key".to_string())?;
        let token = Arc::new(crate::account_oauth::relay_access_token);
        let cfg = client::ClientConfig { relay_url: crate::account_oauth::relay_url()?, core_url: core, store,
            token, signer, signing_spki };
        let handle = client::start(cfg);
        let status = handle.status();
        *handle_slot().lock().map_err(|_| "relay state is unavailable".to_string())? = Some(handle);
        Ok(status)
    } else {
        if let Some(old) = handle_slot().lock().map_err(|_| "relay state is unavailable".to_string())?.take() { old.stop(); }
        reg.enabled = false;
        registry::save(store.as_ref(), &reg)?;
        let _ = store;
        Ok(client::RelayStatus::default())
    }
}
