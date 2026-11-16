//! Tests for the SSH-mode routing. They use a fake helper channel, so no ssh process starts; the fake records every
//! request the desktop sends and can end its own channel, the way a dropped connection does.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;

use super::*;
use crate::project::ProjectInfo;

const LOST_TEXT: &str = "The connection to the server was lost.";

/// One request as the fake received it: command, arguments, and the confirmation it carried.
type Recorded = (String, Value, Option<String>);

type Answer = dyn Fn(&str, &Value, Option<&str>) -> Result<Value, FsError> + Send + Sync;

struct FakeApi {
    calls: Mutex<Vec<Recorded>>,
    answer: Box<Answer>,
    closed: AtomicBool,
    sinks: Mutex<Vec<(EventKind, EventSink)>>,
}

impl FakeApi {
    fn new(answer: impl Fn(&str, &Value, Option<&str>) -> Result<Value, FsError> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { calls: Mutex::new(Vec::new()), answer: Box::new(answer), closed: AtomicBool::new(false), sinks: Mutex::new(Vec::new()) })
    }

    fn calls(&self) -> Vec<Recorded> {
        self.calls.lock().unwrap().clone()
    }

    fn commands(&self) -> Vec<String> {
        self.calls().into_iter().map(|(cmd, _, _)| cmd).collect()
    }

    /// Delivers an event the way the reader thread does.
    fn emit(&self, kind: EventKind, data: Value) {
        for (subscribed, sink) in self.sinks.lock().unwrap().iter() {
            if *subscribed == kind {
                sink(data.clone());
            }
        }
    }

    /// Ends the channel as a dropped connection does.
    fn drop_channel(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

impl WorkspaceApi for FakeApi {
    fn call(&self, cmd: &str, args: Value, confirm: Option<&str>) -> Result<Value, FsError> {
        self.calls.lock().unwrap().push((cmd.to_string(), args.clone(), confirm.map(str::to_string)));
        if self.closed.load(Ordering::SeqCst) {
            return Err(FsError { code: "lost_connection", message: LOST_TEXT.into() });
        }
        (self.answer)(cmd, &args, confirm)
    }

    fn subscribe(&self, kind: EventKind, sink: EventSink) {
        self.sinks.lock().unwrap().push((kind, sink));
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// Hands out one fake per connect. `factory` gets the connect's index, so a test can make the second channel
/// behave differently from the first.
struct FakeConnector {
    made: Mutex<Vec<Arc<FakeApi>>>,
    factory: Box<dyn Fn(usize) -> Arc<FakeApi> + Send + Sync>,
}

impl FakeConnector {
    fn new(factory: impl Fn(usize) -> Arc<FakeApi> + Send + Sync + 'static) -> Self {
        Self { made: Mutex::new(Vec::new()), factory: Box::new(factory) }
    }

    fn connects(&self) -> usize {
        self.made.lock().unwrap().len()
    }

    fn channel(&self, index: usize) -> Arc<FakeApi> {
        self.made.lock().unwrap()[index].clone()
    }
}

impl Connector for FakeConnector {
    fn connect(&self) -> R<Arc<dyn WorkspaceApi>> {
        let mut made = self.made.lock().unwrap();
        let api = (self.factory)(made.len());
        made.push(api.clone());
        let dynamic: Arc<dyn WorkspaceApi> = api;
        Ok(dynamic)
    }
}

/// The answers a healthy helper gives. Tests override only the command they are about.
fn respond(cmd: &str, args: &Value, confirm: Option<&str>) -> Result<Value, FsError> {
    match cmd {
        "open" => {
            let root = args["root"].as_str().unwrap_or_default();
            let name = root.rsplit('/').next().unwrap_or_default();
            Ok(json!({"name": name, "root": root}))
        }
        "fs_list_dir" => Ok(json!({"path": "", "entries": [{"name": "a.txt", "kind": "file"}]})),
        "fs_write_file" => Ok(json!({"hash": "new"})),
        "git_discard" => {
            let question = "Discard changes to a.txt?";
            match confirm {
                None => Err(FsError { code: "confirm_required", message: question.into() }),
                Some(text) if text == question => Ok(json!({"discarded": ["a.txt"]})),
                Some(_) => Err(FsError { code: "confirm_required", message: question.into() }),
            }
        }
        "project_search_start" => Ok(json!({"id": 7})),
        "fs_watch_start" => Ok(json!({"mode": "notify"})),
        _ => Ok(Value::Null),
    }
}

fn healthy() -> FakeConnector {
    FakeConnector::new(|_| FakeApi::new(respond))
}

fn yes(_: &str, _: bool, _: &str) -> R<bool> {
    Ok(true)
}

fn no(_: &str, _: bool, _: &str) -> R<bool> {
    Ok(false)
}

fn sink_into(store: Arc<Mutex<Vec<Value>>>) -> Sink {
    Arc::new(move |data| store.lock().unwrap().push(data))
}

#[test]
fn ssh_mode_without_folder_is_no_project() {
    let remote = Remote::new();
    let connector = healthy();
    let err = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &yes).unwrap_err();
    assert_eq!(err.code, "no_project");
    assert_eq!(connector.connects(), 0, "without an open folder no ssh process starts");
}

#[test]
fn remote_list_dir_round_trip() {
    let remote = Remote::new();
    let connector = healthy();
    let info = remote.open(&connector, "/home/u/project").unwrap();
    assert_eq!(info, ProjectInfo { name: "project".into(), root: "/home/u/project".into() });
    let reply = remote.call(&connector, "fs_list_dir", json!({"req": {"path": "src"}}), &no).unwrap();
    assert_eq!(reply["entries"][0]["name"], "a.txt");
    let (cmd, args, confirm) = connector.channel(0).calls().pop().unwrap();
    assert_eq!((cmd.as_str(), confirm), ("fs_list_dir", None));
    assert_eq!(args, json!({"req": {"path": "src"}}), "the helper gets the UI's argument object unchanged");
}

#[test]
fn confirm_required_round_trip() {
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();

    // "No" changes nothing: one request, the cancel text the local command gives, no second request.
    let asked = Mutex::new(Vec::new());
    let ask_no = |key: &str, force: bool, question: &str| {
        asked.lock().unwrap().push((key.to_string(), force, question.to_string()));
        Ok(false)
    };
    let err = remote.call(&connector, "git_discard", json!({"paths": ["a.txt"]}), &ask_no).unwrap_err();
    assert_eq!((err.code, err.message.as_str()), ("cancelled", "discard cancelled"));
    assert_eq!(asked.lock().unwrap().as_slice(), &[("discard".to_string(), false, "Discard changes to a.txt?".to_string())]);
    let discards: Vec<Recorded> = connector.channel(0).calls().into_iter().filter(|(cmd, _, _)| cmd == "git_discard").collect();
    assert_eq!(discards.len(), 1, "a cancelled confirmation sends nothing more");

    // "Yes" repeats the request with the question's text as the confirmation.
    let out = remote.call(&connector, "git_discard", json!({"paths": ["a.txt"]}), &yes).unwrap();
    assert_eq!(out["discarded"][0], "a.txt");
    let discards: Vec<Recorded> = connector.channel(0).calls().into_iter().filter(|(cmd, _, _)| cmd == "git_discard").collect();
    assert_eq!(discards.last().unwrap().2.as_deref(), Some("Discard changes to a.txt?"));
}

#[test]
fn save_during_drop_fails_cleanly() {
    let remote = Remote::new();
    // The first channel loses its connection while the save is waiting for its answer.
    let connector = FakeConnector::new(|index| {
        FakeApi::new(move |cmd, args, confirm| {
            if index == 0 && cmd == "fs_write_file" {
                return Err(FsError { code: "lost_connection", message: LOST_TEXT.into() });
            }
            respond(cmd, args, confirm)
        })
    });
    remote.open(&connector, "/home/u/project").unwrap();
    let err = remote.call(&connector, "fs_write_file", json!({"req": {"path": "a.txt"}}), &no).unwrap_err();
    assert_eq!((err.code, err.message.as_str()), ("lost_connection", LOST_TEXT));
    let writes = connector.channel(0).calls().into_iter().filter(|(cmd, _, _)| cmd == "fs_write_file").count();
    assert_eq!(writes, 1, "a save is not sent a second time on its own");
}

#[test]
fn missing_root_returns_home() {
    let remote = Remote::new();
    let connector = FakeConnector::new(|_| {
        FakeApi::new(|cmd, args, confirm| {
            if cmd == "fs_list_dir" {
                return Err(FsError { code: "root_missing", message: "This folder is no longer on the server.".into() });
            }
            respond(cmd, args, confirm)
        })
    });
    remote.open(&connector, "/home/u/project").unwrap();
    let err = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap_err();
    assert_eq!(err.code, "root_missing");
    assert_eq!(err.message, "This folder is no longer on the server.");
    assert!(remote.folder().is_none(), "the folder is forgotten, so the app shows the server home");
    let again = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap_err();
    assert_eq!(again.code, "no_project");
}

#[test]
fn reconnect_reopens_folder_and_reregisters_watch() {
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();
    remote.watch_start(&connector, Arc::new(|_| {})).unwrap();
    remote.watch_set(&connector, vec!["src".into()]).unwrap();

    connector.channel(0).drop_channel();
    let reply = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap();
    assert_eq!(reply["entries"][0]["name"], "a.txt");

    assert_eq!(connector.connects(), 2, "the dead channel is replaced once");
    assert_eq!(connector.channel(1).commands(), vec!["open", "fs_watch_start", "fs_watch_set", "fs_list_dir"]);
    let (_, args, _) = connector.channel(1).calls().into_iter().find(|(cmd, _, _)| cmd == "open").unwrap();
    assert_eq!(args, json!({"root": "/home/u/project"}), "the same folder is opened again");
    let (_, dirs, _) = connector.channel(1).calls().into_iter().find(|(cmd, _, _)| cmd == "fs_watch_set").unwrap();
    assert_eq!(dirs, json!({"dirs": ["src"]}));
}

#[test]
fn reconnect_when_the_folder_is_gone_returns_home() {
    let remote = Remote::new();
    let connector = FakeConnector::new(|index| {
        FakeApi::new(move |cmd, args, confirm| {
            if index == 1 && cmd == "open" {
                return Err(FsError { code: "io", message: "folder is not available".into() });
            }
            respond(cmd, args, confirm)
        })
    });
    remote.open(&connector, "/home/u/project").unwrap();
    connector.channel(0).drop_channel();
    let err = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap_err();
    assert_eq!(err.code, "root_missing");
    assert!(remote.folder().is_none());
}

#[test]
fn reconnect_without_a_new_password_prompt() {
    // The connector is the only place a password is used, and it is called once per channel: no dialog is shown
    // on the way (`no` would be asked here if the desktop put one up for the reconnect).
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();
    connector.channel(0).drop_channel();
    let refuse_everything = |_: &str, _: bool, _: &str| -> R<bool> { panic!("no confirmation is asked for a reconnect") };
    remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &refuse_everything).unwrap();
    assert_eq!(connector.connects(), 2);
}

#[test]
fn remote_search_events_reach_the_sink_and_cancel_is_forwarded() {
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let answer = remote.search_start(&connector, json!({"query": "needle"}), sink_into(seen.clone())).unwrap();
    assert_eq!(answer["id"], 7);

    connector.channel(0).emit(EventKind::Search, json!({"type": "chunk", "id": 7, "files": []}));
    connector.channel(0).emit(EventKind::Search, json!({"type": "done", "id": 3}));
    let got = seen.lock().unwrap().clone();
    assert_eq!(got, vec![json!({"type": "chunk", "id": 7, "files": []})], "only the running search's events are forwarded");

    remote.search_cancel(7);
    let cancel = connector.channel(0).calls().into_iter().find(|(cmd, _, _)| cmd == "project_search_cancel").unwrap();
    assert_eq!(cancel.1, json!({"id": 7}));
}

#[test]
fn a_search_running_when_the_channel_drops_is_closed_for_the_page() {
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    remote.search_start(&connector, json!({"query": "x"}), sink_into(seen.clone())).unwrap();
    connector.channel(0).drop_channel();
    remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap();
    let got = seen.lock().unwrap().clone();
    assert_eq!(got.len(), 1);
    assert_eq!((got[0]["type"].as_str(), got[0]["id"].as_u64()), (Some("done"), Some(7)), "the page gets a closing done");
}

#[test]
fn watch_events_reach_the_watch_sink() {
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let store = seen.clone();
    remote.watch_start(&connector, Arc::new(move |data| store.lock().unwrap().push(data))).unwrap();
    connector.channel(0).emit(EventKind::Watch, json!({"changed": ["a.txt"]}));
    assert_eq!(seen.lock().unwrap().as_slice(), &[json!({"changed": ["a.txt"]})]);
}

#[test]
fn early_search_events_are_kept_only_for_their_search() {
    let routes = Mutex::new(Routes::default());
    route_search(&routes, json!({"type": "chunk", "id": 7}));
    route_search(&routes, json!({"type": "chunk", "id": 2}));
    let early = std::mem::take(&mut locked(&routes).early);
    assert_eq!(early.len(), 2, "events before the start reply wait for their id");
    let kept: Vec<Value> = early.into_iter().filter(|data| event_id(data) == Some(7)).collect();
    assert_eq!(kept, vec![json!({"type": "chunk", "id": 7})]);
}

#[test]
fn reset_closes_the_channel_and_forgets_the_folder() {
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();
    remote.reset();
    assert!(connector.channel(0).is_closed());
    assert!(remote.folder().is_none());
}

#[test]
fn project_active_reports_server_folder() {
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(true);
    remote().set_folder_for_test(Some(ProjectInfo { name: "api".into(), root: "/home/u/work/api".into() }));
    let active = crate::project::project_active();
    remote().set_folder_for_test(None);
    crate::core_host::set_process_mode(false);
    assert_eq!(active, Some(ProjectInfo { name: "api".into(), root: "/home/u/work/api".into() }));
}

#[test]
fn ssh_mode_dispatch_without_folder_is_no_project() {
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(true);
    remote().set_folder_for_test(None);
    let result = tauri::async_runtime::block_on(dispatch("fs_list_dir", json!({"req": {"path": ""}}), |_root: PathBuf| Ok(0u8)));
    crate::core_host::set_process_mode(false);
    assert_eq!(result.unwrap_err().code, "no_project");
}

#[test]
fn local_mode_without_a_project_is_no_project() {
    // The local branch is unchanged: it still asks for the active project root, and never the server.
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(false);
    let result = tauri::async_runtime::block_on(dispatch("fs_list_dir", json!({"req": {"path": ""}}), |_root: PathBuf| Ok(0u8)));
    if let Err(e) = &result {
        assert_eq!(e.code, "no_project");
    }
}

#[test]
fn open_pdf_stays_local_only() {
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(true);
    let result = tauri::async_runtime::block_on(crate::fs_ops::fs_open_pdf("a.pdf".into()));
    crate::core_host::set_process_mode(false);
    assert_eq!(result.unwrap_err().code, "ssh_mode");
}
