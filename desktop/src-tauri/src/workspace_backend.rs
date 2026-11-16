//! Where the Explorer's file, git, search and watch commands run.
//!
//! In local mode and the hub they run against this computer's active project, as before. In SSH server mode they
//! run on the server: each request goes to the workspace helper over one ssh channel (`ssh_workspace`), and the
//! answer is the JSON the local command would have returned. The local closure is never called in SSH mode, so no
//! Explorer action touches this computer's disk.
//!
//! The channel belongs to the attached SSH link. It opens on first use. After a drop, the next call reconnects, the
//! open folder is opened again and watching is re-registered. `reset` closes it; Disconnect, Stop server, Uninstall
//! and app exit reach it through the link's detach.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use llmide_workspace_core::scm::confirm_spec;
use llmide_workspace_core::search::aborted_done;
use llmide_workspace_core::{FsError, R};
use serde::Serialize;
use serde_json::{json, Value};

use crate::confirm::DialogGuard;
use crate::project::ProjectInfo;
use crate::ssh_link::HelperSpawn;
use crate::ssh_workspace::{lost, EventKind, EventSink, WorkspaceClient};

/// The reply the helper gives when a destructive command needs the user's answer first. Its message is the question.
const CONFIRM_REQUIRED: &str = "confirm_required";
/// The helper's code and the app's fixed text for an open folder that was deleted or renamed on the server.
pub const ROOT_MISSING_CODE: &str = "root_missing";
pub const ROOT_MISSING_MESSAGE: &str = "This folder is no longer on the server.";
const CHANGED_MESSAGE: &str = "the files changed while the dialog was open; nothing was changed";
/// The codes that mean the channel itself failed, so the folder stays open and the next call reconnects.
const LOST_CODE: &str = "lost_connection";
const TIMEOUT_CODE: &str = "SSH_TIMEOUT";

/// How many search events may arrive before the start reply names their search. The helper starts the scan before
/// it answers, so a few events can come first; anything past this cap is dropped, which only trims the early ones.
const MAX_EARLY_SEARCH_EVENTS: usize = 4096;

/// Native destructive dialogs: one at a time, and not more often than a person can read them. Local and remote
/// confirmations share it, so a page cannot get around the limit by switching modes.
pub(crate) static DESTRUCTIVE_DIALOGS: DialogGuard = DialogGuard::new(1_500, 10);

/// Receives one event's `data`. The Tauri channels and the tests both sit behind this.
pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// The answer to a destructive command's question: `Ok(true)` only when the user pressed the accept button.
pub type Ask<'a> = &'a dyn Fn(&str, bool, &str) -> R<bool>;

/// The part of a helper channel this module uses. `WorkspaceClient` implements it; tests supply a fake.
pub trait WorkspaceApi: Send + Sync {
    fn call(&self, cmd: &str, args: Value, confirm: Option<&str>) -> Result<Value, FsError>;
    fn subscribe(&self, kind: EventKind, sink: EventSink);
    fn is_closed(&self) -> bool;
    fn close(&self);
    /// What the helper reported about git in `hello`. Read by the live check only.
    #[cfg(test)]
    fn helper_git(&self) -> Option<bool> {
        None
    }
}

impl WorkspaceApi for WorkspaceClient {
    #[cfg(test)]
    fn helper_git(&self) -> Option<bool> {
        Some(WorkspaceClient::git_available(self))
    }

    fn call(&self, cmd: &str, args: Value, confirm: Option<&str>) -> Result<Value, FsError> {
        WorkspaceClient::call(self, cmd, args, confirm)
    }

    fn subscribe(&self, kind: EventKind, sink: EventSink) {
        WorkspaceClient::subscribe(self, kind, sink);
    }

    fn is_closed(&self) -> bool {
        WorkspaceClient::is_closed(self)
    }

    fn close(&self) {
        WorkspaceClient::close(self);
    }
}

/// Starts a helper channel. Production starts it over ssh from the attached link; tests return a fake.
pub trait Connector: Send + Sync {
    fn connect(&self) -> R<Arc<dyn WorkspaceApi>>;
}

/// Production connector. The ssh runner, endpoint and pinned known_hosts come from the attached link, and each
/// spawn gets a fresh one-time password grant, so the password is never stored or placed in an argv.
pub struct LinkConnector;

impl Connector for LinkConnector {
    fn connect(&self) -> R<Arc<dyn WorkspaceApi>> {
        let spawn: HelperSpawn = crate::core_host::attached_helper_spawn()?;
        let client = WorkspaceClient::connect(&*spawn.exec, &spawn.endpoint, &spawn.known_hosts, spawn.grant)?;
        Ok(Arc::new(client))
    }
}

/// Event routing shared with the subscriptions, which run on the reader thread. Its lock is never held while a
/// sink runs or while a request waits for its answer.
#[derive(Default)]
struct Routes {
    search: Option<Sink>,
    /// The id of the search the helper named in its start reply. `None` until that reply arrives.
    search_id: Option<u64>,
    /// Events that arrived before the start reply, kept until their id is known.
    early: Vec<Value>,
    watch: Option<Sink>,
    /// The directories the UI last asked to watch, sent again after a reconnect.
    watch_dirs: Option<Vec<String>>,
}

#[derive(Default)]
struct Session {
    client: Option<Arc<dyn WorkspaceApi>>,
    /// The open server folder, as the helper canonicalised it.
    folder: Option<ProjectInfo>,
    /// Bumped by every `reset`. A connect that started under an older value belongs to a link that is gone, so
    /// the channel it made is closed instead of stored.
    generation: u64,
}

/// The SSH-mode state: the helper channel, the open server folder and the event routes.
pub struct Remote {
    session: Mutex<Session>,
    routes: Arc<Mutex<Routes>>,
    /// Serialises connects, so two calls that find the channel gone do not both start one. Held around a connect
    /// and the re-open only, never while a request waits for its answer.
    connecting: Mutex<()>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn no_project() -> FsError {
    FsError { code: "no_project", message: "no project is open".into() }
}

fn root_missing() -> FsError {
    FsError { code: ROOT_MISSING_CODE, message: ROOT_MISSING_MESSAGE.into() }
}

fn to_json<T: Serialize>(value: &T) -> R<Value> {
    serde_json::to_value(value).map_err(|e| FsError { code: "internal", message: format!("cannot encode the result: {e}") })
}

fn event_id(data: &Value) -> Option<u64> {
    data.get("id").and_then(Value::as_u64)
}

/// Whether a search event ends its search.
fn is_done(data: &Value) -> bool {
    data.get("type").and_then(Value::as_str) == Some("done")
}

/// The search events for the current search go to its sink. Events that arrive before the start reply wait in
/// `early`, and any other search's events are dropped. The search's own `done` ends it: its sink is cleared, so
/// no later reconnect or new search sends a second, synthetic `done` for it.
fn route_search(routes: &Mutex<Routes>, data: Value) {
    let forward = {
        let mut r = locked(routes);
        let current = r.search_id;
        match current {
            None => {
                if r.early.len() < MAX_EARLY_SEARCH_EVENTS {
                    r.early.push(data);
                }
                None
            }
            Some(id) if event_id(&data) == Some(id) => {
                let sink = r.search.clone();
                if is_done(&data) {
                    r.search = None;
                    r.search_id = None;
                }
                sink.map(|sink| (sink, data))
            }
            Some(_) => None,
        }
    };
    if let Some((sink, data)) = forward {
        sink(data);
    }
}

fn route_watch(routes: &Mutex<Routes>, data: Value) {
    let sink = locked(routes).watch.clone();
    if let Some(sink) = sink {
        sink(data);
    }
}

fn dialog_for(cmd: &str, args: &Value) -> Option<(&'static str, bool)> {
    match cmd {
        "git_discard" => Some(("discard", false)),
        "git_discard_all" => Some(("discard_all", false)),
        "git_checkout" => Some(("checkout", false)),
        "git_branch_delete" => Some(("branch_delete", args.get("force").and_then(Value::as_bool).unwrap_or(false))),
        "git_stash_pop" => Some(("stash_pop", false)),
        "git_stash_drop" => Some(("stash_drop", false)),
        "git_merge" => Some(("merge", false)),
        "git_merge_abort" => Some(("merge_abort", false)),
        "git_commit_amend" => Some(("amend", false)),
        _ => None,
    }
}

/// The text a refused confirmation carries. Each matches the local command's own cancel message.
fn cancel_message(cmd: &str) -> &'static str {
    match cmd {
        "git_discard" | "git_discard_all" => "discard cancelled",
        "git_checkout" => "checkout cancelled",
        "git_branch_delete" => "branch delete cancelled",
        "git_stash_pop" => "pop cancelled",
        "git_stash_drop" => "drop cancelled",
        "git_merge" => "merge cancelled",
        "git_merge_abort" => "abort cancelled",
        "git_commit_amend" => "amend cancelled",
        _ => "cancelled",
    }
}

fn cancelled(cmd: &str) -> FsError {
    FsError { code: "cancelled", message: cancel_message(cmd).into() }
}

/// One request, with the two-phase confirmation the native dialog needs. Without `confirm` the helper answers
/// `confirm_required` and changes nothing. The question is shown; only "yes" repeats the request with the question
/// as `confirm`. "No" sends nothing more.
fn call_confirmed(client: &dyn WorkspaceApi, cmd: &str, args: Value, ask: Ask<'_>) -> R<Value> {
    let question = match client.call(cmd, args.clone(), None) {
        Err(e) if e.code == CONFIRM_REQUIRED => e.message,
        other => return other,
    };
    let Some((key, force)) = dialog_for(cmd, &args) else {
        return Err(cancelled(cmd));
    };
    if !ask(key, force, &question)? {
        return Err(cancelled(cmd));
    }
    match client.call(cmd, args, Some(&question)) {
        Err(e) if e.code == CONFIRM_REQUIRED => Err(FsError { code: "changed_since_confirm", message: CHANGED_MESSAGE.into() }),
        other => other,
    }
}

/// The native dialog for a remote confirmation: the same title and accept label as the local path.
fn native_dialog(key: &str, force: bool, question: &str) -> R<bool> {
    let Some(spec) = confirm_spec(key, force) else {
        return Ok(false);
    };
    DESTRUCTIVE_DIALOGS.run(|| Ok(crate::confirm::ask(spec.title, question, spec.accept, true)))
}

/// A channel error means the connection itself went; the folder then stays open for the next reconnect.
fn is_channel_error(e: &FsError) -> bool {
    e.code == LOST_CODE || e.code == TIMEOUT_CODE
}

impl Default for Remote {
    fn default() -> Self {
        Self::new()
    }
}

impl Remote {
    pub fn new() -> Self {
        Self { session: Mutex::new(Session::default()), routes: Arc::new(Mutex::new(Routes::default())), connecting: Mutex::new(()) }
    }

    /// The open server folder, if any. Reads only the stored value; it never touches the channel.
    pub fn folder(&self) -> Option<ProjectInfo> {
        locked(&self.session).folder.clone()
    }

    /// Whether the live helper reported git, or `None` with no live channel. Only the live check reads it.
    #[cfg(test)]
    pub(crate) fn helper_git(&self) -> Option<bool> {
        self.live().and_then(|client| client.helper_git())
    }

    /// The channel if it is up. Never connects and never checks the folder.
    fn live(&self) -> Option<Arc<dyn WorkspaceApi>> {
        // Cloned out first, so the session lock is not held while the channel's own state is read.
        let client = locked(&self.session).client.clone();
        client.filter(|client| !client.is_closed())
    }

    /// A live channel, connecting or reconnecting first when needed.
    fn ensure(&self, connector: &dyn Connector) -> R<Arc<dyn WorkspaceApi>> {
        if let Some(client) = self.live() {
            return Ok(client);
        }
        let _gate = locked(&self.connecting);
        // Another caller may have reconnected while this one waited for the gate.
        if let Some(client) = self.live() {
            return Ok(client);
        }
        self.connect_locked(connector)
    }

    /// A live channel for a request that needs the open folder. Without a folder it fails before any connect, and a
    /// folder that a reconnect found gone fails the same way as a root_missing answer.
    fn folder_client(&self, connector: &dyn Connector) -> R<Arc<dyn WorkspaceApi>> {
        if locked(&self.session).folder.is_none() {
            return Err(no_project());
        }
        let client = self.ensure(connector)?;
        if locked(&self.session).folder.is_none() {
            return Err(root_missing());
        }
        Ok(client)
    }

    /// Starts a new channel. Called with the connect gate held. A channel that was open before has ended, so its
    /// running search has ended too; the open folder and the watch are registered again on the new one.
    fn connect_locked(&self, connector: &dyn Connector) -> R<Arc<dyn WorkspaceApi>> {
        let dead = locked(&self.session).client.take();
        if let Some(dead) = dead {
            dead.close();
        }
        self.abort_search();
        // Read before the connect, which can take up to a minute. A reset in between makes this channel stale.
        let started_in = locked(&self.session).generation;
        let fresh = connector.connect()?;
        self.subscribe_routes(&*fresh);
        {
            let mut session = locked(&self.session);
            if session.generation != started_in {
                drop(session);
                fresh.close();
                return Err(lost());
            }
            session.client = Some(fresh.clone());
        }
        let folder = locked(&self.session).folder.clone();
        if let Some(folder) = folder {
            match fresh.call("open", json!({"root": folder.root}), None) {
                Ok(_) => self.reregister_watch(&*fresh),
                // The channel failed again: this one is not kept, so the next call reconnects.
                Err(e) if is_channel_error(&e) => {
                    self.drop_client(&fresh);
                    return Err(e);
                }
                // The old folder is gone (or no longer reachable). It is forgotten, and the request that caused the
                // reconnect decides what the page sees: folder_client answers root_missing for a folder request, and
                // an open or a picker request carries on.
                Err(_) => self.forget_folder(),
            }
        }
        Ok(fresh)
    }

    /// Closes and forgets `client` if it is still the stored channel.
    fn drop_client(&self, client: &Arc<dyn WorkspaceApi>) {
        let taken = {
            let mut session = locked(&self.session);
            match session.client.as_ref() {
                Some(stored) if Arc::ptr_eq(stored, client) => session.client.take(),
                _ => None,
            }
        };
        if let Some(taken) = taken {
            taken.close();
        }
    }

    /// Makes a root_missing answer from any request forget the folder, so every request behaves the same way.
    fn settle<T>(&self, result: R<T>) -> R<T> {
        if matches!(&result, Err(e) if e.code == ROOT_MISSING_CODE) {
            self.forget_folder();
        }
        result
    }

    /// Both subscriptions are made once per channel. They read the routes at each event, so a start or a stop
    /// never adds a second subscriber.
    fn subscribe_routes(&self, client: &dyn WorkspaceApi) {
        let routes = self.routes.clone();
        client.subscribe(EventKind::Search, Box::new(move |data| route_search(&routes, data)));
        let routes = self.routes.clone();
        client.subscribe(EventKind::Watch, Box::new(move |data| route_watch(&routes, data)));
    }

    /// After a reconnect: start watching again, and send the directories the UI had asked for. Best effort; the
    /// file tree still works without it, and the UI refreshes when the user acts.
    fn reregister_watch(&self, client: &dyn WorkspaceApi) {
        let (wanted, dirs) = {
            let r = locked(&self.routes);
            (r.watch.is_some(), r.watch_dirs.clone())
        };
        if !wanted {
            return;
        }
        if client.call("fs_watch_start", json!({}), None).is_ok() {
            if let Some(dirs) = dirs {
                let _ = client.call("fs_watch_set", json!({"dirs": dirs}), None);
            }
        }
    }

    /// Ends the running search for the UI: its sink gets a closing `done` for the id, so the page is never left
    /// waiting, and the search state is cleared.
    fn abort_search(&self) {
        let (id, sink) = {
            let mut r = locked(&self.routes);
            r.early.clear();
            (r.search_id.take(), r.search.take())
        };
        if let (Some(id), Some(sink)) = (id, sink) {
            if let Ok(done) = to_json(&aborted_done(id)) {
                sink(done);
            }
        }
    }

    fn clear_watch(&self) {
        let mut r = locked(&self.routes);
        r.watch = None;
        r.watch_dirs = None;
    }

    /// The folder is gone or replaced: its search and watch belong to it, so they end too.
    fn forget_folder(&self) {
        locked(&self.session).folder = None;
        self.abort_search();
        self.clear_watch();
    }

    /// Opens a folder on the server and makes it the active one. The helper's canonical root is kept.
    pub fn open(&self, connector: &dyn Connector, path: &str) -> R<ProjectInfo> {
        let client = self.ensure(connector)?;
        let answer = client.call("open", json!({"root": path}), None)?;
        let info = ProjectInfo {
            name: answer.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            root: answer.get("root").and_then(Value::as_str).unwrap_or_default().to_string(),
        };
        // The helper stopped the previous folder's watch and search when it opened this one.
        self.abort_search();
        self.clear_watch();
        locked(&self.session).folder = Some(info.clone());
        Ok(info)
    }

    /// The folder picker's listing. It needs a channel but no open folder.
    pub fn list_dirs(&self, connector: &dyn Connector, path: &str, hidden: bool) -> R<Value> {
        let client = self.ensure(connector)?;
        client.call("list_dirs", json!({"path": path, "hidden": hidden}), None)
    }

    pub fn mkdir(&self, connector: &dyn Connector, path: &str, name: &str) -> R<Value> {
        let client = self.ensure(connector)?;
        client.call("mkdir", json!({"path": path, "name": name}), None)
    }

    /// Runs one Explorer command on the open folder. `root_missing` from the helper clears the folder.
    pub fn call(&self, connector: &dyn Connector, cmd: &str, args: Value, ask: Ask<'_>) -> R<Value> {
        let client = self.folder_client(connector)?;
        self.settle(call_confirmed(&*client, cmd, args, ask))
    }

    /// Starts a search on the server. Its events go to `sink` as they arrive, with the search's own id.
    pub fn search_start(&self, connector: &dyn Connector, req: Value, sink: Sink) -> R<Value> {
        let client = self.folder_client(connector)?;
        self.abort_search();
        locked(&self.routes).search = Some(sink.clone());
        let answer = match self.settle(client.call("project_search_start", json!({"req": req}), None)) {
            Ok(answer) => answer,
            Err(e) => {
                self.abort_search();
                return Err(e);
            }
        };
        let Some(id) = event_id(&answer) else {
            self.abort_search();
            return Err(FsError { code: "bad_response", message: "The server sent an answer this app does not understand.".into() });
        };
        // Events that came before the reply, for this search only, are delivered now and in order. One that is
        // already the search's `done` ends it here, as it would in route_search.
        let early = {
            let mut r = locked(&self.routes);
            r.search_id = Some(id);
            std::mem::take(&mut r.early)
        };
        for data in early.into_iter().filter(|data| event_id(data) == Some(id)) {
            let done = is_done(&data);
            sink(data);
            if done {
                let mut r = locked(&self.routes);
                r.search = None;
                r.search_id = None;
                break;
            }
        }
        Ok(answer)
    }

    /// Cancels a search. Only a live channel is used: cancelling never starts a connection.
    pub fn search_cancel(&self, id: u64) {
        if let Some(client) = self.live() {
            let _ = client.call("project_search_cancel", json!({"id": id}), None);
        }
    }

    /// Starts watching the open folder. Batches go to `sink`; a second start replaces the first.
    pub fn watch_start(&self, connector: &dyn Connector, sink: Sink) -> R<Value> {
        let client = self.folder_client(connector)?;
        {
            let mut r = locked(&self.routes);
            r.watch = Some(sink);
            r.watch_dirs = None;
        }
        let answer = self.settle(client.call("fs_watch_start", json!({}), None));
        if answer.is_err() {
            self.clear_watch();
        }
        answer
    }

    pub fn watch_set(&self, connector: &dyn Connector, dirs: Vec<String>) -> R<Value> {
        let client = self.folder_client(connector)?;
        let answer = self.settle(client.call("fs_watch_set", json!({"dirs": dirs}), None))?;
        locked(&self.routes).watch_dirs = Some(dirs);
        Ok(answer)
    }

    /// Stops watching. Best effort: the local side is cleared even when the channel is already gone.
    pub fn watch_stop(&self) {
        self.clear_watch();
        if let Some(client) = self.live() {
            let _ = client.call("fs_watch_stop", json!({}), None);
        }
    }

    /// Forgets the open folder and closes the channel. It takes no connect gate and never waits for a connect in
    /// progress: a connect that is still running sees the new generation and closes its own channel. Blocks only
    /// while the channel that existed is wound down, so callers off the UI thread use it.
    pub fn reset(&self) {
        let client = {
            let mut session = locked(&self.session);
            session.generation += 1;
            session.folder = None;
            session.client.take()
        };
        self.abort_search();
        self.clear_watch();
        if let Some(client) = client {
            client.close();
        }
    }

    #[cfg(test)]
    pub(crate) fn set_folder_for_test(&self, info: Option<ProjectInfo>) {
        locked(&self.session).folder = info;
    }
}

static REMOTE: OnceLock<Remote> = OnceLock::new();

/// The one SSH-mode state of the process.
pub fn remote() -> &'static Remote {
    REMOTE.get_or_init(Remote::new)
}

/// Whether SSH server mode is on. The local project and its root are not used then.
pub fn is_ssh_mode() -> bool {
    crate::core_host::is_ssh_mode()
}

/// Refuses a command that acts on this computer (a native folder dialog, the system viewer, a local clone or project
/// create) while SSH mode is on. Hub and local mode are not affected; `require_local_mode` would refuse them too.
pub fn refuse_in_ssh_mode() -> R<()> {
    if is_ssh_mode() {
        return Err(FsError { code: "ssh_mode", message: "This action uses the local computer and is unavailable in SSH server mode.".into() });
    }
    Ok(())
}

/// The open server folder for `project_active` in SSH mode.
pub fn project_info() -> Option<ProjectInfo> {
    remote().folder()
}

/// Closes the helper channel and forgets the open folder. Safe to call when nothing is open.
pub fn reset() {
    remote().reset();
}

/// Runs an Explorer command. In SSH mode it goes to the server: `args` builds the UI's argument object from the
/// request, and only on this branch. Otherwise `local` runs with the active project root, exactly as before. The
/// request is moved into whichever branch runs. `needs_local_mode` keeps the file commands' hub-mode refusal; the git,
/// search and watch commands never had it, so they pass `false`.
pub async fn dispatch<Q, T>(
    cmd: &'static str,
    needs_local_mode: bool,
    req: Q,
    args: impl FnOnce(&Q) -> Value + Send + 'static,
    local: impl FnOnce(PathBuf, Q) -> R<T> + Send + 'static,
) -> R<Value>
where
    Q: Send + 'static,
    T: Serialize,
{
    tauri::async_runtime::spawn_blocking(move || {
        if is_ssh_mode() {
            return remote().call(&LinkConnector, cmd, args(&req), &native_dialog);
        }
        if needs_local_mode {
            crate::core_host::require_local_mode()?;
        }
        let root = crate::fs_ops::active_root()?;
        to_json(&local(root, req)?)
    })
    .await
    .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
}

#[cfg(test)]
mod tests;
