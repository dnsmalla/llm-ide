//! Tauri commands for the desktop chat store (see `chat_store.rs` and `chat_archive.rs`).
//!
//! The webview never supplies a path and never names a user: it binds its signed-in session once
//! (`chat_bind_session`), the host asks the core who that token belongs to (`GET /auth/me`) and
//! uses that user id for the directory and the ownership rule. The token stays in host memory only
//! (it is what the quit hook and the start-up sweep need to call the lifecycle routes); it is never
//! written to disk, logged, or returned. Every command is typed, bounded and returns a stable error
//! code; no chat content is ever logged or put in an error.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::chat_archive::{ArchiveReport, Archiver, HttpRemote, JournalDoc, LifecycleRemote, RemoteError, QUIT_CAP, SWEEP_CAP};
use crate::chat_store::{layout_here, valid_user_id, ChatStore, ListPage, ListQuery, LoadedChat, SaveMode, SaveOutcome, StoreError, StoreLayout, MAX_LIST_PAGE, MAX_PAGE};
use crate::core_host::{CoreHost, Phase};

fn err(code: &'static str, message: &str) -> StoreError {
    StoreError::new(code, message)
}

struct Bound {
    user_id: String,
    token: String,
    core_url: String,
    store: ChatStore,
    journal_path: PathBuf,
    shared_with_mac: bool,
}

#[derive(Default)]
struct Svc {
    bound: Mutex<Option<Bound>>,
    swept: Mutex<HashSet<String>>,
    last_sweep: Mutex<Option<ArchiveReport>>,
    last_quit: Mutex<Option<ArchiveReport>>,
    quit_started: AtomicBool,
}

/// Cheap-to-clone state managed by Tauri.
#[derive(Clone, Default)]
pub struct ChatService(Arc<Svc>);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BindInfo {
    pub user_id: String,
    pub shared_with_mac: bool,
    /// The recovery sweep for this user was started by this call.
    pub sweep_started: bool,
}

impl ChatService {
    pub fn new() -> Self {
        Self::default()
    }

    fn snapshot(&self) -> Result<(ChatStore, String, String), StoreError> {
        let b = lock(&self.0.bound);
        let b = b.as_ref().ok_or_else(|| err("not_bound", "sign in first: no session is bound"))?;
        Ok((b.store.clone(), b.core_url.clone(), b.token.clone()))
    }

    fn store(&self) -> Result<ChatStore, StoreError> {
        self.snapshot().map(|s| s.0)
    }

    /// Binds (or re-binds, refreshing the token) the signed-in session. `core_url` must be loopback.
    pub fn bind(&self, core_url: &str, token: &str, layout_for: &dyn Fn(&str) -> Result<StoreLayout, String>, data_dir: Option<PathBuf>) -> Result<BindInfo, StoreError> {
        let remote = HttpRemote::new(core_url, token).map_err(|_| err("invalid", "core url or token is not acceptable"))?;
        let user_id = match remote.me(Duration::from_secs(3)) {
            Ok(u) => u,
            Err(RemoteError::Unauthorized) => return Err(err("unauthorized", "the core rejected this session")),
            Err(_) => return Err(err("core_unavailable", "could not reach the core")),
        };
        if !valid_user_id(&user_id) {
            return Err(err("invalid_user", "the core returned a user id this store cannot use"));
        }
        let layout = layout_for(&user_id).map_err(|_| err("io", "cannot resolve the chat directory"))?;
        let shared = layout.shared_with_mac;
        let priv_dir = data_dir.map(|d| d.join("chat-store").join(&user_id));
        let index = priv_dir.as_ref().map(|d| d.join("index.json"));
        let journal_path = priv_dir.clone().unwrap_or_else(|| layout.base.join(".chat-private")).join("archive-journal.json");
        let store = ChatStore::open(layout, &user_id, index)?;
        {
            let mut b = lock(&self.0.bound);
            *b = Some(Bound { user_id: user_id.clone(), token: token.to_string(), core_url: core_url.to_string(), store: store.clone(), journal_path: journal_path.clone(), shared_with_mac: shared });
        }
        let first = lock(&self.0.swept).insert(user_id.clone());
        if first {
            let svc = self.clone();
            std::thread::spawn(move || {
                // The sweep reads the token at start; a later re-bind only refreshes it for the quit run.
                if let Ok((store, url, tok)) = svc.snapshot() {
                    if let Ok(remote) = HttpRemote::new(&url, &tok) {
                        let jp = lock(&svc.0.bound).as_ref().map(|b| b.journal_path.clone());
                        let report = Archiver::new(store, remote, jp).with_policy(crate::prefs::archive_policy()).sweep(SWEEP_CAP);
                        *lock(&svc.0.last_sweep) = Some(report);
                    }
                }
            });
        }
        Ok(BindInfo { user_id, shared_with_mac: shared, sweep_started: first })
    }

    /// Forgets the session (sign-out). The token leaves host memory.
    pub fn unbind(&self) {
        *lock(&self.0.bound) = None;
    }

    /// The quit run (once per process). Returns what it did, `None` when no session was bound or it
    /// already ran. Bounded by `cap`.
    pub fn quit_archive(&self, cap: Duration) -> Option<ArchiveReport> {
        // Archiving off (the default): there is no quit run at all.
        if crate::prefs::archive_policy() == crate::chat_archive::ArchivePolicy::Off {
            return None;
        }
        if self.0.quit_started.swap(true, Ordering::SeqCst) {
            return None;
        }
        let (store, url, tok, jp) = {
            let b = lock(&self.0.bound);
            let b = b.as_ref()?;
            (b.store.clone(), b.core_url.clone(), b.token.clone(), b.journal_path.clone())
        };
        let remote = HttpRemote::new(&url, &tok).ok()?;
        let report = Archiver::new(store, remote, Some(jp)).with_policy(crate::prefs::archive_policy()).quit(cap);
        *lock(&self.0.last_quit) = Some(report.clone());
        Some(report)
    }

    pub fn quit_archive_default(&self) -> Option<ArchiveReport> {
        self.quit_archive(QUIT_CAP)
    }
}

// ---- command argument and result types -------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListArgs {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub scope: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadArgs {
    pub id: String,
    /// Return messages with index < `before` (older page); omit for the newest.
    pub before: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveArgs {
    pub session: Value,
    /// `replace` (default) or `append`.
    pub mode: Option<String>,
    /// Required for `append`: the message count the caller last saw.
    pub expected_count: Option<usize>,
    /// Required when the chat already exists: the revision from the last load or save.
    pub expected_revision: Option<String>,
    /// Default true: stamp `lastUsedAt` with now.
    pub touch: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteArgs {
    pub id: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub existed: bool,
    /// `done` (server confirmed) | `queued` (the sweep or the Mac app retries) | `unreachable` | `none` (nothing to send).
    pub tombstone: &'static str,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStatus {
    pub bound: bool,
    pub user_id: Option<String>,
    pub shared_with_mac: bool,
    /// `reliable` | `best_effort`: how dependable the quit hook is on this OS (docs/how-to/desktop-chat-store.md).
    pub quit_hook: &'static str,
    pub journal: Option<JournalDoc>,
    pub last_sweep: Option<ArchiveReport>,
    pub last_quit: Option<ArchiveReport>,
    pub pending_deletes: usize,
    pub quarantined: usize,
}

// ---- commands ----------------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, StoreError> + Send + 'static) -> Result<T, StoreError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| err("io", "chat task failed"))?
}

/// Binds the webview's signed-in session (`token`) to the host. The host verifies it with the core
/// (`GET /auth/me`) and derives the user id itself.
#[tauri::command]
pub async fn chat_bind_session(svc: State<'_, ChatService>, host: State<'_, CoreHost>, token: String) -> Result<BindInfo, StoreError> {
    let svc = svc.inner().clone();
    let status = host.status();
    if status.state != Phase::Ready {
        return Err(err("core_unavailable", "the core is not ready"));
    }
    let url = status.url;
    let data_dir = crate::fsutil::desktop_data_dir().ok();
    blocking(move || svc.bind(&url, &token, &|u| layout_here(u), data_dir)).await
}

/// Forgets the bound session (sign-out).
#[tauri::command]
pub fn chat_unbind_session(svc: State<'_, ChatService>) {
    svc.unbind();
}

#[tauri::command]
pub async fn chat_list(svc: State<'_, ChatService>, args: Option<ListArgs>) -> Result<ListPage, StoreError> {
    let store = svc.store()?;
    let a = args.unwrap_or_default();
    blocking(move || store.list(&ListQuery { offset: a.offset.unwrap_or(0), limit: a.limit.unwrap_or(50).min(MAX_LIST_PAGE), scope: a.scope, project_id: a.project_id })).await
}

#[tauri::command]
pub async fn chat_load(svc: State<'_, ChatService>, args: LoadArgs) -> Result<LoadedChat, StoreError> {
    let store = svc.store()?;
    blocking(move || store.load(&args.id, args.before, args.limit.unwrap_or(100).min(MAX_PAGE))).await
}

#[tauri::command]
pub async fn chat_save(svc: State<'_, ChatService>, args: SaveArgs) -> Result<SaveOutcome, StoreError> {
    let store = svc.store()?;
    let mode = match (args.mode.as_deref(), args.expected_count) {
        (None | Some("replace"), _) => SaveMode::Replace,
        (Some("append"), Some(n)) => SaveMode::Append { expected_count: n },
        (Some("append"), None) => return Err(err("invalid", "append needs expectedCount")),
        _ => return Err(err("invalid", "mode must be replace or append")),
    };
    blocking(move || store.save(args.session, mode, args.expected_revision.as_deref(), args.touch.unwrap_or(true))).await
}

#[tauri::command]
pub async fn chat_delete(svc: State<'_, ChatService>, args: DeleteArgs) -> Result<DeleteResult, StoreError> {
    let (store, url, token) = svc.snapshot()?;
    blocking(move || {
        let existed = store.delete(&args.id)?;
        // Best effort, bounded: the tombstone is already durable, so a miss is retried by the sweep.
        let id = crate::chat_store::canonical_chat_id(&args.id).unwrap_or_default();
        let tombstone = match HttpRemote::new(&url, &token) {
            Ok(remote) => {
                let iso = crate::chat_archive::iso_utc(crate::chat_store::now_unix());
                match remote.session_purge(&id, &iso, Duration::from_secs(2)) {
                    Ok(s) if s == "done" => {
                        let _ = store.remove_tombstone(&id);
                        "done"
                    }
                    Ok(_) => "queued",
                    Err(_) => "unreachable",
                }
            }
            Err(_) => "none",
        };
        Ok(DeleteResult { existed, tombstone })
    })
    .await
}

#[tauri::command]
pub async fn chat_archive_status(svc: State<'_, ChatService>) -> Result<ArchiveStatus, StoreError> {
    let svc = svc.inner().clone();
    blocking(move || {
        let b = lock(&svc.0.bound);
        let hook = if cfg!(target_os = "macos") { "reliable" } else { "best_effort" };
        let (user, shared, journal, pending, quarantined) = match b.as_ref() {
            Some(b) => (
                Some(b.user_id.clone()),
                b.shared_with_mac,
                crate::chat_archive::Journal::new(Some(b.journal_path.clone())).read(),
                b.store.pending_delete_count(),
                b.store.quarantined_count(),
            ),
            None => (None, false, None, 0, 0),
        };
        let bound = b.is_some();
        drop(b);
        Ok(ArchiveStatus { bound, user_id: user, shared_with_mac: shared, quit_hook: hook, journal, last_sweep: lock(&svc.0.last_sweep).clone(), last_quit: lock(&svc.0.last_quit).clone(), pending_deletes: pending, quarantined })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_archive::tests::{serve, FakeCore};
    use crate::chat_store::tests::Tmp;
    use crate::chat_store::{SaveMode, StoreLayout};

    fn layout(t: &Tmp) -> impl Fn(&str) -> Result<StoreLayout, String> + '_ {
        move |u| Ok(StoreLayout { base: t.0.join("chats").join(u), sessions: t.0.join("chats").join(u).join("sessions"), shared_with_mac: false })
    }

    #[test]
    fn nothing_works_before_a_session_is_bound_and_the_user_comes_from_the_core() {
        let t = Tmp::new("svc");
        let svc = ChatService::new();
        assert_eq!(svc.store().err().unwrap().code, "not_bound");
        assert!(svc.quit_archive(Duration::from_secs(1)).is_none());
        let url = serve(FakeCore::default(), "tok", "user-42");
        // wrong token, non-loopback url, junk token
        assert_eq!(svc.bind(&url, "bad", &layout(&t), None).unwrap_err().code, "unauthorized");
        assert_eq!(svc.bind("http://example.com", "tok", &layout(&t), None).unwrap_err().code, "invalid");
        assert_eq!(svc.bind(&url, "a\nb", &layout(&t), None).unwrap_err().code, "invalid");
        assert_eq!(svc.store().err().unwrap().code, "not_bound");
        let info = svc.bind(&url, "tok", &layout(&t), Some(t.0.join("data"))).unwrap();
        assert_eq!((info.user_id.as_str(), info.sweep_started), ("user-42", true));
        // the directory is the core's user id, never anything the caller named
        let store = svc.store().unwrap();
        let sess = crate::chat_store::tests::session("AAAAAAAA-0000-4000-8000-000000000001", 1);
        store.save(sess, SaveMode::Replace, None, true).unwrap();
        assert!(t.0.join("chats/user-42/sessions/AAAAAAAA-0000-4000-8000-000000000001.json").exists());
        // re-bind (token refresh) does not start a second sweep; unbind forgets the session
        assert!(!svc.bind(&url, "tok", &layout(&t), Some(t.0.join("data"))).unwrap().sweep_started);
        svc.unbind();
        assert_eq!(svc.store().err().unwrap().code, "not_bound");
        // a user id that cannot be one path segment is refused
        let evil = serve(FakeCore::default(), "tok", "../../etc");
        assert_eq!(ChatService::new().bind(&evil, "tok", &layout(&t), None).unwrap_err().code, "invalid_user");
    }
}
