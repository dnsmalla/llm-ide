//! Tests for the SSH-mode routing. They use a fake helper channel, so no ssh process starts; the fake records every
//! request the desktop sends and can end its own channel, the way a dropped connection does.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::json;

use std::path::PathBuf;

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
    crate::core_host::set_process_mode(2);
    remote().set_folder_for_test(Some(ProjectInfo { name: "api".into(), root: "/home/u/work/api".into() }));
    let active = crate::project::project_active();
    remote().set_folder_for_test(None);
    crate::core_host::set_process_mode(0);
    assert_eq!(active, Some(ProjectInfo { name: "api".into(), root: "/home/u/work/api".into() }));
}

#[test]
fn ssh_mode_dispatch_without_folder_is_no_project() {
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(2);
    remote().set_folder_for_test(None);
    let result = tauri::async_runtime::block_on(dispatch("fs_list_dir", true, (), |_| json!({"req": {"path": ""}}), |_root, ()| Ok(0u8)));
    crate::core_host::set_process_mode(0);
    assert_eq!(result.unwrap_err().code, "no_project");
}

#[test]
fn local_mode_without_a_project_is_no_project() {
    // The local branch is unchanged: it still asks for the active project root, and never the server.
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(0);
    let result = tauri::async_runtime::block_on(dispatch("fs_list_dir", true, (), |_| json!({}), |_root, ()| Ok(0u8)));
    if let Err(e) = &result {
        assert_eq!(e.code, "no_project");
    }
}

#[test]
fn open_pdf_stays_local_only() {
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(2);
    let result = tauri::async_runtime::block_on(crate::fs_ops::fs_open_pdf("a.pdf".into()));
    crate::core_host::set_process_mode(0);
    assert_eq!(result.unwrap_err().code, "ssh_mode");
}

/// A connector whose connect waits until the test releases it, so a reset can run while a connect is in progress.
struct GatedConnector {
    started: Mutex<mpsc::Sender<()>>,
    release: Mutex<mpsc::Receiver<()>>,
    api: Arc<FakeApi>,
}

impl Connector for GatedConnector {
    fn connect(&self) -> R<Arc<dyn WorkspaceApi>> {
        let _ = self.started.lock().unwrap().send(());
        let _ = self.release.lock().unwrap().recv();
        let dynamic: Arc<dyn WorkspaceApi> = self.api.clone();
        Ok(dynamic)
    }
}

#[test]
fn reset_during_a_connect_closes_the_late_channel() {
    let remote = Arc::new(Remote::new());
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let api = FakeApi::new(respond);
    let connector = Arc::new(GatedConnector { started: Mutex::new(started_tx), release: Mutex::new(release_rx), api: api.clone() });
    let worker = {
        let (remote, connector) = (remote.clone(), connector.clone());
        std::thread::spawn(move || remote.list_dirs(&*connector, "~", false))
    };
    started_rx.recv().unwrap();
    // The reset must return while the connect is still blocked: it takes no connect gate.
    let (done_tx, done_rx) = mpsc::channel();
    let resetter = {
        let remote = remote.clone();
        std::thread::spawn(move || {
            remote.reset();
            let _ = done_tx.send(());
        })
    };
    done_rx.recv_timeout(Duration::from_secs(5)).expect("reset returned while the connect was blocked");
    release_tx.send(()).unwrap();
    let result = worker.join().unwrap();
    resetter.join().unwrap();
    assert_eq!(result.unwrap_err().code, "lost_connection");
    assert!(api.is_closed(), "the late channel is closed");
    assert!(remote.live().is_none(), "and it is never stored");
}

#[test]
fn a_channel_error_during_the_reopen_is_not_kept() {
    let remote = Remote::new();
    let connector = FakeConnector::new(|index| {
        FakeApi::new(move |cmd, args, confirm| {
            if index == 1 && cmd == "open" {
                return Err(FsError { code: "SSH_TIMEOUT", message: "The server did not answer in time.".into() });
            }
            respond(cmd, args, confirm)
        })
    });
    remote.open(&connector, "/home/u/project").unwrap();
    connector.channel(0).drop_channel();
    let err = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap_err();
    assert_eq!(err.code, "SSH_TIMEOUT");
    assert!(connector.channel(1).is_closed(), "the channel that failed the re-open is closed");
    assert!(remote.live().is_none(), "and it is not kept, so the next call reconnects");
    assert!(remote.folder().is_some(), "the folder stays open for that reconnect");
}

#[test]
fn a_vanished_folder_on_reconnect_does_not_fail_the_next_open() {
    let remote = Remote::new();
    let connector = FakeConnector::new(|index| {
        FakeApi::new(move |cmd, args, confirm| {
            if index == 1 && cmd == "open" && args["root"] == "/home/u/project" {
                return Err(FsError { code: "root_missing", message: "This folder is no longer on the server.".into() });
            }
            respond(cmd, args, confirm)
        })
    });
    remote.open(&connector, "/home/u/project").unwrap();
    connector.channel(0).drop_channel();
    let info = remote.open(&connector, "/home/u/other").unwrap();
    assert_eq!(info.root, "/home/u/other", "the user's open carries on");
    assert_eq!(remote.folder().map(|f| f.root), Some("/home/u/other".to_string()));
    assert!(remote.list_dirs(&connector, "~", false).is_ok());
}

#[test]
fn root_missing_from_search_and_watch_forgets_the_folder() {
    let remote = Remote::new();
    let connector = FakeConnector::new(|_| {
        FakeApi::new(|cmd, args, confirm| {
            if cmd == "project_search_start" || cmd == "fs_watch_start" {
                return Err(FsError { code: "root_missing", message: "This folder is no longer on the server.".into() });
            }
            respond(cmd, args, confirm)
        })
    });
    remote.open(&connector, "/home/u/project").unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let err = remote.search_start(&connector, json!({"query": "x"}), sink_into(seen)).unwrap_err();
    assert_eq!(err.code, "root_missing");
    assert!(remote.folder().is_none(), "a search answer clears the folder like any other request");

    remote.open(&connector, "/home/u/project").unwrap();
    let err = remote.watch_start(&connector, Arc::new(|_| {})).unwrap_err();
    assert_eq!(err.code, "root_missing");
    assert!(remote.folder().is_none(), "a watch answer clears the folder too");
}

#[test]
fn a_finished_search_gets_no_synthetic_done() {
    let remote = Remote::new();
    let connector = healthy();
    remote.open(&connector, "/home/u/project").unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    remote.search_start(&connector, json!({"query": "x"}), sink_into(seen.clone())).unwrap();
    connector.channel(0).emit(EventKind::Search, json!({"type": "done", "id": 7, "cancelled": false}));
    connector.channel(0).drop_channel();
    remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap();
    let got = seen.lock().unwrap().clone();
    assert_eq!(got.len(), 1, "only the helper's own done reached the page");
    assert_eq!(got[0]["type"], "done");
}

#[test]
fn a_timed_out_call_reopens_the_folder_on_the_next_call() {
    let remote = Remote::new();
    let connector = FakeConnector::new(|index| {
        FakeApi::new(move |cmd, args, confirm| {
            if index == 0 && cmd == "fs_list_dir" {
                return Err(FsError { code: "SSH_TIMEOUT", message: "The server did not answer in time.".into() });
            }
            respond(cmd, args, confirm)
        })
    });
    remote.open(&connector, "/home/u/project").unwrap();
    let err = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap_err();
    assert_eq!(err.code, "SSH_TIMEOUT");
    // WorkspaceClient ends a timed-out channel itself; the fake reproduces that end here.
    connector.channel(0).drop_channel();
    assert!(remote.folder().is_some(), "a timeout keeps the folder open");
    let reply = remote.call(&connector, "fs_list_dir", json!({"req": {"path": ""}}), &no).unwrap();
    assert_eq!(reply["entries"][0]["name"], "a.txt");
    assert_eq!(connector.connects(), 2, "the timed-out channel is replaced");
    assert_eq!(connector.channel(1).commands(), vec!["open", "fs_list_dir"], "the saved folder is opened again first");
}

#[test]
fn open_without_a_usable_answer_is_refused_and_ends_the_channel() {
    let remote = Remote::new();
    let connector = FakeConnector::new(|_| {
        FakeApi::new(|cmd, args, confirm| match cmd {
            "open" => Ok(json!({"name": "", "root": ""})),
            _ => respond(cmd, args, confirm),
        })
    });
    let err = remote.open(&connector, "/home/u/project").unwrap_err();
    assert_eq!(err.code, "invalid_path");
    assert!(remote.folder().is_none(), "no folder is kept for an answer without a name or root");
    assert!(connector.channel(0).is_closed(), "the helper that answered is not kept, so the next call starts a new one");
}

#[test]
fn concurrent_opens_do_not_interleave() {
    let in_flight = Arc::new(AtomicUsize::new(0));
    let most_at_once = Arc::new(AtomicUsize::new(0));
    let (flight, most) = (in_flight.clone(), most_at_once.clone());
    let connector = FakeConnector::new(move |_| {
        let (flight, most) = (flight.clone(), most.clone());
        FakeApi::new(move |cmd, args, confirm| {
            if cmd == "open" {
                let now = flight.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                flight.fetch_sub(1, Ordering::SeqCst);
            }
            respond(cmd, args, confirm)
        })
    });
    let remote = Remote::new();
    std::thread::scope(|scope| {
        for path in ["/home/u/a", "/home/u/b"] {
            let (remote, connector) = (&remote, &connector);
            scope.spawn(move || {
                remote.open(connector, path).unwrap();
            });
        }
    });
    assert_eq!(most_at_once.load(Ordering::SeqCst), 1, "the second open waits for the first to finish");
}

fn hub_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llmide-ws-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    dir
}

/// Hub mode with a local project open: the file commands stay refused, and the git, search and watch commands run on
/// the project exactly as they did before the SSH work.
fn in_hub_mode_with_project<T>(name: &str, body: impl FnOnce(&PathBuf) -> T) -> T {
    let _turn = crate::project::ACTIVE_TESTS.lock().unwrap_or_else(|p| p.into_inner());
    let _mode = crate::core_host::process_mode_guard();
    let dir = hub_root(name);
    crate::project::set_active_for_test(Some(dir.clone()));
    crate::core_host::set_process_mode(1);
    let out = body(&dir);
    crate::core_host::set_process_mode(0);
    crate::project::set_active_for_test(None);
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[test]
fn hub_mode_file_commands_stay_refused() {
    let result = in_hub_mode_with_project("hub-fs", |_| tauri::async_runtime::block_on(crate::fs_ops::fs_list_dir(crate::fs_ops::ListReq::default())));
    assert_eq!(result.unwrap_err().code, "remote_mode");
}

#[test]
fn hub_mode_git_runs_on_the_active_project() {
    let result = in_hub_mode_with_project("hub-git", |dir| {
        let init = std::process::Command::new("git").args(["init", "-q"]).current_dir(dir).status();
        assert!(init.is_ok_and(|s| s.success()), "git init for the test");
        tauri::async_runtime::block_on(crate::git::git_status())
    });
    assert!(result.is_ok(), "git had no hub refusal before SSH mode existed: {result:?}");
}

#[test]
fn hub_mode_search_and_watch_run_on_the_active_project() {
    let (search, watch) = in_hub_mode_with_project("hub-search", |_| {
        let query: crate::project_search::Query = serde_json::from_value(json!({"query": "one"})).unwrap();
        let search = tauri::async_runtime::block_on(crate::project_search::project_search_start(query, tauri::ipc::Channel::new(|_| Ok(()))));
        let watch = tauri::async_runtime::block_on(crate::fs_watch::fs_watch_start(tauri::ipc::Channel::new(|_| Ok(()))));
        let _ = tauri::async_runtime::block_on(crate::fs_watch::fs_watch_stop());
        (search, watch)
    });
    assert!(search.is_ok(), "search had no hub refusal before SSH mode existed: {search:?}");
    assert!(watch.is_ok(), "watch had no hub refusal before SSH mode existed: {watch:?}");
}

/// A helper that answers the project-setup commands the way the real one does, on top of the usual answers.
fn project_setup(cmd: &str, args: &Value, confirm: Option<&str>) -> Result<Value, FsError> {
    match cmd {
        "project_paths" => Ok(json!({"root": "/srv/home/proj", "code": "/srv/home/proj/code"})),
        "project_rebuild" => Err(FsError { code: "not_a_project", message: "This folder is not an LLM-IDE project.".into() }),
        "project_create" => Ok(json!({"root": "/srv/home/new", "id": "p1", "name": "new"})),
        "repo_clone" => Ok(json!({"started": true})),
        _ => respond(cmd, args, confirm),
    }
}

fn project_setup_connector() -> Arc<FakeConnector> {
    Arc::new(FakeConnector::new(|_| FakeApi::new(project_setup)))
}

fn open_folder(root: &str) -> ProjectInfo {
    ProjectInfo { name: "proj".into(), root: root.into() }
}

#[test]
fn ssh_project_paths_goes_to_helper() {
    let remote = Remote::new();
    remote.set_folder_for_test(Some(open_folder("/srv/home/proj")));
    let connector = project_setup_connector();
    let answer = remote.call(&*connector, "project_paths", json!({}), &no).expect("paths");
    assert_eq!(answer["root"], "/srv/home/proj");
    assert!(connector.channel(0).commands().contains(&"project_paths".to_string()));
}

#[test]
fn ssh_rebuild_maps_to_project_rebuild() {
    let remote = Remote::new();
    remote.set_folder_for_test(Some(open_folder("/srv/home/plain")));
    let connector = project_setup_connector();
    let err = remote.call(&*connector, "project_rebuild", json!({}), &no).expect_err("plain folder");
    assert_eq!(err.code, "not_a_project");
    assert_eq!(err.message, "This folder is not an LLM-IDE project.");
    assert_eq!(connector.channel(0).commands().last().map(String::as_str), Some("project_rebuild"));
}

#[test]
fn project_create_then_opens() {
    let remote = Remote::new();
    let connector = project_setup_connector();
    let info = remote.project_create(&*connector, "/srv/home", "new").expect("create");
    assert_eq!(info, ProjectInfo { name: "new".into(), root: "/srv/home/new".into() });
    assert_eq!(connector.channel(0).commands(), vec!["project_create".to_string(), "open".to_string()]);
    assert_eq!(remote.folder(), Some(info));
}

/// Runs `clone_repo` on another thread, waits until the request is on the channel, then runs `after` on the channel.
fn clone_while(
    answer: fn(&str, &Value, Option<&str>) -> Result<Value, FsError>,
    cap: Duration,
    after: impl FnOnce(&FakeApi),
) -> (R<Value>, Vec<String>) {
    let remote = Arc::new(Remote::new());
    let connector = Arc::new(FakeConnector::new(move |_| FakeApi::new(answer)));
    let worker = {
        let (remote, connector) = (remote.clone(), connector.clone());
        std::thread::spawn(move || remote.clone_repo(&*connector, json!({"provider": "github", "url": "o/r"}), cap))
    };
    let api = loop {
        if connector.connects() > 0 && connector.channel(0).commands().contains(&"repo_clone".to_string()) {
            break connector.channel(0);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    after(api.as_ref());
    let result = worker.join().expect("worker");
    (result, api.commands())
}

#[test]
fn clone_wait_returns_event_result() {
    let (result, _) = clone_while(project_setup, Duration::from_secs(10), |api| {
        api.emit(EventKind::Clone, json!({"ok": true, "path": "/srv/home/proj/code/r", "name": "r"}));
    });
    assert_eq!(result.expect("clone"), json!({"path": "/srv/home/proj/code/r", "name": "r"}));
}

#[test]
fn clone_wait_returns_the_helper_error() {
    let (result, _) = clone_while(project_setup, Duration::from_secs(10), |api| {
        api.emit(EventKind::Clone, json!({"ok": false, "code": "clone_failed", "message": "git exited with status 128"}));
    });
    let err = result.expect_err("clone failure");
    assert_eq!(err.code, "clone_failed");
    assert_eq!(err.message, "git exited with status 128");
}

#[test]
fn clone_wait_ends_when_channel_closes() {
    let started = Instant::now();
    let (result, commands) = clone_while(project_setup, Duration::from_secs(30 * 60), |api| api.drop_channel());
    let err = result.expect_err("lost channel");
    assert_eq!(err.code, "lost_connection");
    assert!(started.elapsed() < Duration::from_secs(10), "the wait must not run to the cap");
    assert!(!commands.contains(&"clone_cancel".to_string()));
}

#[test]
fn clone_timeout_sends_cancel() {
    let (result, commands) = clone_while(project_setup, Duration::from_millis(300), |_| {});
    assert_eq!(result.expect_err("timeout").code, TIMEOUT_CODE);
    assert!(commands.contains(&"clone_cancel".to_string()));
}

#[test]
fn clone_token_is_sent_only_in_the_request() {
    let remote = Remote::new();
    let connector = project_setup_connector();
    let req = json!({"provider": "github", "url": "o/r", "token": "ghp_secret"});
    let _ = remote.clone_repo(&*connector, req, Duration::from_millis(50));
    let sent = connector.channel(0).calls();
    let repo_clone = sent.iter().find(|(cmd, _, _)| cmd == "repo_clone").expect("repo_clone sent");
    assert_eq!(repo_clone.1["req"]["token"], "ghp_secret");
    assert!(!sent.iter().filter(|(cmd, _, _)| cmd != "repo_clone").any(|(_, args, _)| args.to_string().contains("ghp_secret")));
}

#[test]
fn local_mode_unchanged() {
    let _mode = crate::core_host::process_mode_guard();
    crate::core_host::set_process_mode(0);
    assert!(!is_ssh_mode());
    assert!(refuse_in_ssh_mode().is_ok());
    crate::core_host::set_process_mode(2);
    assert_eq!(refuse_in_ssh_mode().expect_err("ssh refuses").code, "ssh_mode");
    crate::core_host::set_process_mode(0);
}
