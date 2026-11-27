//! Command routing: each command name the desktop sends goes to the core function its Tauri wrapper calls, with the
//! same arguments. Destructive git commands run in two phases (see `confirmed`), and a panic in any handler becomes
//! an `internal` error so one bad request cannot stop the helper.

use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};

use llmide_workspace_core::commands::{self, is_confirmed_command, is_fs_command, is_git_command};
use llmide_workspace_core::git::git_binary;
use llmide_workspace_core::project::clone::CloneRequest;
use llmide_workspace_core::search::Searches;
use llmide_workspace_core::{err, FsError, R};
use serde_json::Value;

use crate::project_setup;
use crate::protocol::{arg, arg_or_false, err_response, ok_response, Request};
use crate::session::{Clones, Session};

/// Set by the test-only `__two_questions` command when its action runs.
#[cfg(test)]
pub static TWO_QUESTIONS_RAN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const INTERNAL_MESSAGE: &str = "the helper hit an internal error; the request was not completed";

/// Runs one request and returns its response line. Never panics: a panic in a handler is answered as `internal`.
pub fn handle_request(session: &mut Session, req: &Request) -> Value {
    match catch_unwind(AssertUnwindSafe(|| run_command(session, req))) {
        Ok(Ok(value)) => ok_response(req.id, value),
        Ok(Err(e)) => err_response(req.id, e.code, &e.message),
        Err(_) => err_response(req.id, "internal", INTERNAL_MESSAGE),
    }
}

/// `project_search_cancel` and `clone_cancel` are answered at once by the reader, even while a slow command is running,
/// so a search or a clone can be stopped without waiting behind it.
pub fn is_immediate(req: &Request) -> bool {
    req.cmd == "project_search_cancel" || req.cmd == "clone_cancel"
}

pub fn cancel_now(searches: &Searches, clones: &Clones, req: &Request) -> Value {
    if req.cmd == "clone_cancel" {
        return match arg::<u64>(&req.args, "id") {
            Ok(id) => {
                clones.cancel(id);
                ok_response(req.id, Value::Null)
            }
            Err(e) => err_response(req.id, e.code, &e.message),
        };
    }
    match arg::<u64>(&req.args, "id") {
        Ok(id) => {
            searches.cancel(id);
            ok_response(req.id, Value::Null)
        }
        Err(e) => err_response(req.id, e.code, &e.message),
    }
}

fn run_command(session: &mut Session, req: &Request) -> R<Value> {
    let args = &req.args;
    let cmd = req.cmd.as_str();
    match cmd {
        "hello" => Ok(session.hello()),
        // `scaffold` is additive: absent or not a boolean means false, so an older desktop (which never sends it) keeps working.
        "open" => session.open(&arg::<String>(args, "root")?, args.get("scaffold").and_then(Value::as_bool).unwrap_or(false)),
        "list_dirs" => session.list_dirs(&arg::<String>(args, "path")?, arg_or_false(args, "hidden")?),
        "mkdir" => session.mkdir(&arg::<String>(args, "path")?, &arg::<String>(args, "name")?),
        "project_search_start" => session.search_start(arg(args, "req")?),
        "project_search_cancel" => {
            session.searches.cancel(arg(args, "id")?);
            Ok(Value::Null)
        }
        "repo_clone" => session.clone_start(arg::<CloneRequest>(args, "req")?),
        "clone_cancel" => {
            session.clones.cancel(arg::<u64>(args, "id")?);
            Ok(Value::Null)
        }
        "graph_read" => {
            let root = session.root()?;
            let path = arg::<String>(args, "path")?;
            project_setup::graph_read(&root, &path)
        }
        "fs_watch_start" => session.watch_start(),
        "fs_watch_set" => session.watch_set(&arg::<Vec<String>>(args, "dirs")?),
        "fs_watch_stop" => Ok(session.watch_stop()),
        "project_create" => project_setup::create(&arg::<String>(args, "parent")?, &arg::<String>(args, "name")?),
        "project_paths" => project_setup::paths(session),
        "project_memory" => project_setup::memory(session),
        "project_rebuild" => project_setup::rebuild(session),
        #[cfg(test)]
        "__two_questions" => confirmed(req, |ask| {
            if !ask("first question") {
                return err("cancelled", "stopped at the first question");
            }
            if !ask("second question") {
                return err("cancelled", "stopped at the second question");
            }
            TWO_QUESTIONS_RAN.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(Value::Null)
        }),
        "fs_open_pdf" => err("unsupported", "opening a PDF in this computer's viewer is not available for a server folder"),
        "reveal_in_os" => err("unsupported", "showing a file in this computer's file manager is not available for a server folder"),
        #[cfg(test)]
        "__panic" => panic!("the test asked for a panic"),
        _ if is_fs_command(cmd) || is_git_command(cmd) => table_command(session, req),
        _ => err("unsupported", format!("the helper does not run `{cmd}`")),
    }
}

/// The fs and git commands, run by the one table in the core that the desktop's local path calls too. The helper
/// adds what only it can: the open-folder check, the missing-git answer the Changes panel shows, and the two-phase
/// confirmation for the destructive git commands.
fn table_command(session: &Session, req: &Request) -> R<Value> {
    let root = session.root()?;
    let cmd = req.cmd.as_str();
    if is_git_command(cmd) && git_binary().is_none() {
        return err("git_missing", "git is not installed on this server.");
    }
    if is_confirmed_command(cmd) {
        return confirmed(req, |ask| commands::run(&root, cmd, &req.args, &|_spec, question| ask(question), session.trasher()));
    }
    commands::run(&root, cmd, &req.args, &|_spec, _question| false, session.trasher())
}

/// Runs a destructive command in two phases, the way the desktop's native dialog does.
///
/// Without `confirm`, the first question the command asks is recorded and answered no, so the core refuses before
/// it changes anything, and the reply is `confirm_required` carrying that question's text. With `confirm`, a question
/// is answered yes only when its text equals the confirmed text byte for byte; a different question is refused the
/// same way and reported back. The desktop shows the text it got and sends it back unchanged.
fn confirmed<T>(req: &Request, run: impl FnOnce(&dyn Fn(&str) -> bool) -> R<T>) -> R<T> {
    let expected = match req.confirm.as_ref() {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return err("bad_request", "`confirm` must be the text of the question as a string"),
    };
    let first_question: RefCell<Option<String>> = RefCell::new(None);
    let refused: RefCell<Option<String>> = RefCell::new(None);
    let ask = |question: &str| match expected.as_deref() {
        None => {
            first_question.borrow_mut().get_or_insert_with(|| question.to_string());
            false
        }
        Some(text) if text == question => true,
        Some(_) => {
            refused.borrow_mut().get_or_insert_with(|| question.to_string());
            false
        }
    };
    let result = run(&ask);
    let pending = if expected.is_some() { refused.into_inner() } else { first_question.into_inner() };
    match pending {
        Some(question) => Err(FsError { code: llmide_workspace_core::wire::CONFIRM_REQUIRED_CODE, message: question }),
        None => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use crate::protocol::{parse_request, Capture, Out, PROTOCOL};
    use crate::session::SAVED_TOKEN_REFUSED_MESSAGE;
    use llmide_workspace_core::project::layout;
    use llmide_workspace_core::trash::tests::FakeTrash;
    use serde_json::json;

    /// Serialises the tests that set `HOME`, the environment the core reads for `~` and the breadth rule.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// A temp folder removed on drop, which runs on success and on panic alike.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("llmide-helper-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Fixture {
        _tree: TempTree,
        _env: std::sync::MutexGuard<'static, ()>,
        old_home: Option<std::ffi::OsString>,
        home: PathBuf,
        outside: PathBuf,
        trash: PathBuf,
        captured: Arc<Mutex<Vec<u8>>>,
        session: Session,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            match self.old_home.take() {
                Some(old) => std::env::set_var("HOME", old),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let env = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let tree = TempTree::new(tag);
            let home = tree.0.join("home");
            let outside = tree.0.join("outside");
            let trash = tree.0.join("trash");
            for dir in [&home, &outside] {
                std::fs::create_dir_all(dir).unwrap();
            }
            let old_home = std::env::var_os("HOME");
            std::env::set_var("HOME", &home);
            let captured = Arc::new(Mutex::new(Vec::new()));
            let out = Arc::new(Out::new(Box::new(Capture(captured.clone())), false));
            let searches = Arc::new(Searches::new());
            let session = Session::with_trasher(out, searches, Arc::new(Clones::new()), Box::new(FakeTrash::into(&trash)));
            Self { _tree: tree, _env: env, old_home, home, outside, trash, captured, session }
        }

        fn call(&mut self, line: &str) -> Value {
            let req = parse_request(line.as_bytes()).expect("the test request is valid JSON");
            handle_request(&mut self.session, &req)
        }

        fn canonical_home(&self) -> PathBuf {
            std::fs::canonicalize(&self.home).unwrap()
        }

        /// Makes `home/project` with New project (a full scaffold) and opens it as the user would (`scaffold: true`).
        fn open_new_project(&mut self) -> PathBuf {
            ok_of(&self.call(&create_line(1, "~", "project")));
            let project = self.home.join("project");
            let reply = self.call(&json!({"id": 2, "cmd": "open", "args": {"root": project.to_string_lossy(), "scaffold": true}}).to_string());
            assert!(reply.get("ok").is_some(), "open failed: {reply}");
            std::fs::canonicalize(&project).unwrap()
        }

        /// Opens `home/project` as a NON-empty plain folder (one file, no marker), which opening leaves alone.
        fn open_plain_folder(&mut self) -> PathBuf {
            let project = self.home.join("project");
            std::fs::create_dir_all(&project).unwrap();
            std::fs::write(project.join("notes.txt"), "mine notes").unwrap();
            let reply = self.call(&json!({"id": 1, "cmd": "open", "args": {"root": project.to_string_lossy(), "scaffold": true}}).to_string());
            assert!(reply.get("ok").is_some(), "open failed: {reply}");
            std::fs::canonicalize(&project).unwrap()
        }

        /// Opens `home/project` (created here, empty) as the user would (`scaffold: true`), so it is scaffolded as a project.
        fn open_project(&mut self) -> PathBuf {
            let project = self.home.join("project");
            std::fs::create_dir_all(&project).unwrap();
            let reply = self.call(&json!({"id": 1, "cmd": "open", "args": {"root": project.to_string_lossy(), "scaffold": true}}).to_string());
            assert!(reply.get("ok").is_some(), "open failed: {reply}");
            std::fs::canonicalize(&project).unwrap()
        }
    }

    fn code_of(reply: &Value) -> &str {
        reply["err"]["code"].as_str().unwrap_or_else(|| panic!("expected an error, got {reply}"))
    }

    fn ok_of(reply: &Value) -> &Value {
        assert!(reply.get("err").is_none(), "expected success, got {reply}");
        &reply["ok"]
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git runs for the test");
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn hello_reports_version() {
        let mut f = Fixture::new("hello");
        let reply = f.call(r#"{"id":7,"cmd":"hello","args":{}}"#);
        let ok = ok_of(&reply);
        assert_eq!(reply["id"], 7);
        assert_eq!(ok["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(ok["protocol"], 2);
        assert!(ok["git"].is_boolean());
    }

    #[test]
    fn hello_reports_protocol_2() {
        let mut f = Fixture::new("protocol-2");
        assert_eq!(PROTOCOL, 2);
        assert_eq!(ok_of(&f.call(r#"{"id":1,"cmd":"hello","args":{}}"#))["protocol"], 2);
    }

    /// Every path under `dir`, relative and sorted, with a trailing `/` on folders: the state a refused request
    /// must leave exactly as it found it.
    fn tree_listing(dir: &Path) -> Vec<String> {
        fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                let rel = path.strip_prefix(base).unwrap().to_string_lossy().into_owned();
                if path.is_dir() {
                    out.push(format!("{rel}/"));
                    walk(base, &path, out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    fn create_line(id: u64, parent: &str, name: &str) -> String {
        json!({"id": id, "cmd": "project_create", "args": {"parent": parent, "name": name}}).to_string()
    }

    #[test]
    fn create_scaffolds_and_returns_root() {
        let mut f = Fixture::new("create");
        std::fs::create_dir_all(f.home.join("work")).unwrap();
        let reply = f.call(&create_line(1, "~/work", "Alpha"));
        let ok = ok_of(&reply).clone();
        let root = f.canonical_home().join("work").join("Alpha");
        assert_eq!(ok["root"], root.to_string_lossy().as_ref());
        assert_eq!(ok["name"], "Alpha");
        assert!(!ok["id"].as_str().unwrap().is_empty());
        assert!(root.join("system/project.json").is_file());
        assert!(root.join("code").is_dir());
        assert!(root.join("CLAUDE.md").is_file());
    }

    #[test]
    fn create_refuses_existing_name() {
        let mut f = Fixture::new("create-exists");
        let dir = f.home.join("work").join("Taken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("keep.txt"), "mine").unwrap();
        let reply = f.call(&create_line(1, "~/work", "Taken"));
        assert_eq!(code_of(&reply), "already_exists");
        assert_eq!(tree_listing(&dir), ["keep.txt"], "the existing folder holds the same single file");
        assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "mine");
    }

    #[test]
    fn create_allows_home_refuses_outside() {
        let mut f = Fixture::new("create-refused");
        std::fs::create_dir_all(f.home.join("work")).unwrap();
        // A project in the home folder is allowed, as it is locally: `~/Alpha` is the project root.
        let home_root = f.canonical_home();
        let made = ok_of(&f.call(&create_line(1, "~", "Alpha"))).clone();
        assert_eq!(made["root"], home_root.join("Alpha").to_string_lossy().as_ref());
        assert!(home_root.join("Alpha").join("system/project.json").is_file());
        let home_before = tree_listing(&f.home);
        let outside = f.outside.to_string_lossy().into_owned();
        assert_eq!(code_of(&f.call(&create_line(2, &outside, "Alpha"))), "outside_home");
        assert_eq!(code_of(&f.call(&create_line(3, "~/work", ".."))), "invalid_name");
        assert_eq!(tree_listing(&f.home), home_before, "a refused create wrote nothing in the home folder");
        assert!(tree_listing(&f.outside).is_empty(), "nothing was written outside the home folder");
        assert!(tree_listing(&f.home.join("work")).is_empty(), "no project folder was made");
    }

    #[test]
    fn rebuild_scaffolds_a_plain_folder_and_keeps_existing_files() {
        let mut f = Fixture::new("rebuild-plain");
        let project = f.open_plain_folder();
        std::fs::write(project.join("CLAUDE.md"), "mine").unwrap();
        ok_of(&f.call(r#"{"id":1,"cmd":"project_rebuild","args":{}}"#));
        assert!(project.join("system/project.json").is_file(), "the marker is written");
        assert!(project.join("code").is_dir(), "the layout is created");
        assert_eq!(std::fs::read_to_string(project.join("notes.txt")).unwrap(), "mine notes");
        assert_eq!(std::fs::read_to_string(project.join("CLAUDE.md")).unwrap(), "mine", "an existing file is never overwritten");
    }

    #[cfg(unix)]
    #[test]
    fn rebuild_refuses_a_link_out_of_the_folder() {
        let mut f = Fixture::new("rebuild-link-out");
        let project = f.open_plain_folder();
        std::os::unix::fs::symlink(&f.outside, project.join("system")).unwrap();
        let reply = f.call(r#"{"id":1,"cmd":"project_rebuild","args":{}}"#);
        assert_eq!(code_of(&reply), "outside_root");
        assert_eq!(std::fs::read_dir(&f.outside).unwrap().count(), 0, "nothing was written through the link");
    }

    #[cfg(unix)]
    #[test]
    fn clone_refuses_a_code_link_out_of_the_folder() {
        let mut f = Fixture::new("clone-link-out");
        let project = f.open_plain_folder();
        std::os::unix::fs::symlink(&f.outside, project.join("code")).unwrap();
        use_fake_git(&mut f, FAST_GIT);
        // The fake git script itself lives in `outside`, so count what is there before the call.
        let before = std::fs::read_dir(&f.outside).unwrap().count();
        let reply = f.call(&clone_line(1, "o/r", None));
        assert_eq!(code_of(&reply), "clone_refused");
        assert_eq!(std::fs::read_dir(&f.outside).unwrap().count(), before, "nothing was created outside");
    }

    #[test]
    fn opening_an_empty_folder_scaffolds_it() {
        let mut f = Fixture::new("open-empty");
        let project = f.open_project();
        assert!(project.join("system/project.json").is_file());
        assert!(project.join("code").is_dir());
        let paths = ok_of(&f.call(r#"{"id":2,"cmd":"project_paths","args":{}}"#)).clone();
        assert_eq!(paths["isProject"], true);
    }

    #[test]
    fn opening_a_non_empty_plain_folder_writes_nothing() {
        let mut f = Fixture::new("open-plain");
        let project = f.open_plain_folder();
        assert_eq!(tree_listing(&project), vec!["notes.txt".to_string()]);
        assert!(!project.join("system").exists());
        let paths = ok_of(&f.call(r#"{"id":2,"cmd":"project_paths","args":{}}"#)).clone();
        assert_eq!(paths["isProject"], false);
    }

    #[test]
    fn opening_without_the_scaffold_flag_writes_nothing() {
        // The reconnect case: the desktop re-sends a plain `open`, which must never write.
        let mut f = Fixture::new("open-no-flag");
        let project = f.home.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let line = json!({"id": 1, "cmd": "open", "args": {"root": project.to_string_lossy()}}).to_string();
        ok_of(&f.call(&line));
        let bad = json!({"id": 2, "cmd": "open", "args": {"root": project.to_string_lossy(), "scaffold": "yes"}}).to_string();
        ok_of(&f.call(&bad));
        assert!(tree_listing(&project).is_empty(), "a plain open leaves an empty folder empty");
    }

    #[test]
    fn reopening_keeps_the_marker_byte_for_byte() {
        let mut f = Fixture::new("reopen");
        let project = f.open_project();
        let marker = project.join("system/project.json");
        let before = std::fs::read(&marker).unwrap();
        std::fs::remove_file(project.join("README.md")).unwrap();
        let line = json!({"id": 2, "cmd": "open", "args": {"root": project.to_string_lossy(), "scaffold": true}}).to_string();
        ok_of(&f.call(&line));
        assert!(!project.join("README.md").exists(), "a folder with the marker is never touched on open");
        assert_eq!(std::fs::read(&marker).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn a_scaffold_failure_does_not_fail_the_open() {
        use std::os::unix::fs::PermissionsExt;
        let mut f = Fixture::new("open-readonly");
        let project = f.home.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::set_permissions(&project, std::fs::Permissions::from_mode(0o555)).unwrap();
        let probe = project.join(".probe");
        if std::fs::write(&probe, b"x").is_ok() {
            // Running as root: the mode does not stop writes, so the scaffold cannot be made to fail.
            let _ = std::fs::remove_file(&probe);
            std::fs::set_permissions(&project, std::fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let line = json!({"id": 1, "cmd": "open", "args": {"root": project.to_string_lossy(), "scaffold": true}}).to_string();
        let reply = f.call(&line);
        std::fs::set_permissions(&project, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(reply.get("ok").is_some(), "open failed: {reply}");
        assert!(!project.join("system").exists());
    }

    #[test]
    fn rebuild_fills_only_missing_files() {
        let mut f = Fixture::new("rebuild-fill");
        std::fs::create_dir_all(f.home.join("work")).unwrap();
        ok_of(&f.call(&create_line(1, "~/work", "Beta")));
        let root = f.canonical_home().join("work").join("Beta");
        std::fs::write(root.join("CLAUDE.md"), "my edits").unwrap();
        std::fs::remove_file(root.join("README.md")).unwrap();
        std::fs::remove_dir(root.join("code")).unwrap();
        let root_text = root.to_string_lossy().into_owned();
        ok_of(&f.call(&json!({"id": 2, "cmd": "open", "args": {"root": root_text, "scaffold": true}}).to_string()));
        ok_of(&f.call(r#"{"id":3,"cmd":"project_rebuild","args":{}}"#));
        assert_eq!(std::fs::read_to_string(root.join("CLAUDE.md")).unwrap(), "my edits", "an edited file is kept");
        assert!(root.join("README.md").is_file(), "a missing file comes back");
        assert!(root.join("code").is_dir(), "a missing folder comes back");
    }

    #[test]
    fn paths_and_memory_on_open_folder() {
        let mut f = Fixture::new("paths-memory");
        std::fs::create_dir_all(f.home.join("work")).unwrap();
        ok_of(&f.call(&create_line(1, "~/work", "Gamma")));
        let root = f.canonical_home().join("work").join("Gamma");
        let root_text = root.to_string_lossy().into_owned();
        assert_eq!(code_of(&f.call(r#"{"id":2,"cmd":"project_paths","args":{}}"#)), "no_project");
        ok_of(&f.call(&json!({"id": 3, "cmd": "open", "args": {"root": root_text, "scaffold": true}}).to_string()));
        let paths = ok_of(&f.call(r#"{"id":4,"cmd":"project_paths","args":{}}"#)).clone();
        assert_eq!(paths["root"], root_text.as_str());
        assert_eq!(paths["isProject"], true);
        assert_eq!(paths["folders"].as_array().unwrap().len(), layout::LAYOUT.len());
        let memory = ok_of(&f.call(r#"{"id":5,"cmd":"project_memory","args":{}}"#)).clone();
        assert_eq!(memory["root"], root_text.as_str());
        assert!(memory["graph"].is_null());
        let names: Vec<&str> = memory["files"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"project.json"), "the marker is listed under system/: {names:?}");
    }

    #[test]
    fn commands_need_open() {
        let mut f = Fixture::new("needs-open");
        assert_eq!(code_of(&f.call(r#"{"id":1,"cmd":"fs_list_dir","args":{"req":{"path":""}}}"#)), "no_project");
        assert_eq!(code_of(&f.call(r#"{"id":2,"cmd":"git_status","args":{}}"#)), "no_project");
    }

    #[test]
    fn open_canonicalises_and_names() {
        let mut f = Fixture::new("open");
        let project = f.home.join("projects").join("llm-ide");
        std::fs::create_dir_all(&project).unwrap();
        let reply = f.call(r#"{"id":1,"cmd":"open","args":{"root":"~/projects/llm-ide"}}"#);
        let ok = ok_of(&reply);
        assert_eq!(ok["name"], "llm-ide");
        assert_eq!(ok["root"], std::fs::canonicalize(&project).unwrap().to_string_lossy().as_ref());
    }

    #[test]
    fn open_refuses_outside_home() {
        let mut f = Fixture::new("outside");
        assert_eq!(code_of(&f.call(r#"{"id":1,"cmd":"open","args":{"root":"/etc"}}"#)), "outside_home");
    }

    #[test]
    fn open_accepts_odd_names_and_refuses_newline() {
        let mut f = Fixture::new("odd-names");
        for name in ["a b", "日本", "-x"] {
            let dir = f.home.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let line = json!({"id": 1, "cmd": "open", "args": {"root": dir.to_string_lossy()}}).to_string();
            assert!(f.call(&line).get("ok").is_some(), "{name} must open");
        }
        let bad = json!({"id": 2, "cmd": "open", "args": {"root": format!("{}/a\nb", f.home.display())}}).to_string();
        assert_eq!(code_of(&f.call(&bad)), "invalid_path");
        let bad_cr = json!({"id": 3, "cmd": "open", "args": {"root": format!("{}/a\rb", f.home.display())}}).to_string();
        assert_eq!(code_of(&f.call(&bad_cr)), "invalid_path");
    }

    #[test]
    fn list_dirs_marks_links_outside_home() {
        let mut f = Fixture::new("links");
        let home = f.home.clone();
        std::fs::create_dir_all(home.join("keep")).unwrap();
        std::fs::create_dir_all(home.join(".hidden")).unwrap();
        std::fs::write(home.join("file.txt"), "x").unwrap();
        std::os::unix::fs::symlink(home.join("keep"), home.join("inside")).unwrap();
        std::os::unix::fs::symlink(&f.outside, home.join("out")).unwrap();
        std::os::unix::fs::symlink(home.join("missing"), home.join("dangling")).unwrap();
        let reply = f.call(r#"{"id":1,"cmd":"list_dirs","args":{"path":"~","hidden":false}}"#);
        let entries = ok_of(&reply)["entries"].as_array().unwrap().clone();
        let names: Vec<&str> = entries.iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["inside", "keep", "out"], "folders only, hidden and dangling dropped");
        assert_eq!(entries[0]["isLink"], true);
        assert_eq!(entries[0]["outsideHome"], false);
        assert_eq!(entries[2]["isLink"], true);
        assert_eq!(entries[2]["outsideHome"], true);
        let with_hidden = f.call(r#"{"id":2,"cmd":"list_dirs","args":{"path":"~","hidden":true}}"#);
        assert!(ok_of(&with_hidden)["entries"].as_array().unwrap().iter().any(|e| e["name"] == ".hidden"));
        assert_eq!(code_of(&f.call(r#"{"id":3,"cmd":"list_dirs","args":{"path":"/etc","hidden":false}}"#)), "outside_home");
    }

    #[test]
    fn mkdir_validates_names() {
        let mut f = Fixture::new("mkdir");
        let parent = f.home.to_string_lossy().into_owned();
        for bad in ["", ".", "..", "a/b", "a\nb", "a\rb", "a\0b"] {
            let line = json!({"id": 1, "cmd": "mkdir", "args": {"path": parent, "name": bad}}).to_string();
            assert_eq!(code_of(&f.call(&line)), "invalid_path", "{bad:?} must be refused");
        }
        let line = json!({"id": 2, "cmd": "mkdir", "args": {"path": "~", "name": "New folder"}}).to_string();
        let reply = f.call(&line);
        assert_eq!(ok_of(&reply)["path"], f.canonical_home().join("New folder").to_string_lossy().as_ref());
        assert!(f.home.join("New folder").is_dir());
        assert_eq!(code_of(&f.call(&line)), "exists");
    }

    #[test]
    fn fs_round_trip() {
        let mut f = Fixture::new("fs");
        f.open_project();
        let write = r#"{"id":1,"cmd":"fs_write_file","args":{"req":{"path":"a.txt","text":"hello"}}}"#;
        ok_of(&f.call(write));
        let listed = f.call(r#"{"id":2,"cmd":"fs_list_dir","args":{"req":{"path":""}}}"#);
        assert!(ok_of(&listed)["entries"].as_array().unwrap().iter().any(|e| e["name"] == "a.txt"));
        let read = f.call(r#"{"id":3,"cmd":"fs_read_file","args":{"req":{"path":"a.txt"}}}"#);
        assert_eq!(ok_of(&read)["text"], "hello");
        ok_of(&f.call(r#"{"id":4,"cmd":"fs_rename","args":{"req":{"from":"a.txt","to":"b.txt"}}}"#));
        assert!(!f.home.join("project/a.txt").exists());
        ok_of(&f.call(r#"{"id":5,"cmd":"fs_delete","args":{"path":"b.txt"}}"#));
        assert!(!f.home.join("project/b.txt").exists(), "delete moves the file away");
        assert!(f.trash.is_dir(), "delete went through the injected trash");
    }

    #[test]
    fn confirm_required_round_trip() {
        let mut f = Fixture::new("confirm");
        let project = f.open_project();
        std::fs::write(project.join("f.txt"), "one\n").unwrap();
        git(&project, &["init", "-q"]);
        git(&project, &["add", "f.txt"]);
        git(&project, &["commit", "-q", "-m", "init"]);
        std::fs::write(project.join("f.txt"), "two\n").unwrap();

        let first = f.call(r#"{"id":1,"cmd":"git_discard","args":{"paths":["f.txt"]}}"#);
        assert_eq!(code_of(&first), "confirm_required");
        let question = first["err"]["message"].as_str().unwrap().to_string();
        assert!(!question.is_empty());
        assert_eq!(std::fs::read_to_string(project.join("f.txt")).unwrap(), "two\n", "nothing changed yet");

        let confirmed = json!({"id": 2, "cmd": "git_discard", "args": {"paths": ["f.txt"]}, "confirm": question}).to_string();
        ok_of(&f.call(&confirmed));
        assert_eq!(std::fs::read_to_string(project.join("f.txt")).unwrap(), "one\n", "the confirmed discard ran");
    }

    #[test]
    fn wrong_confirm_text_changes_nothing() {
        let mut f = Fixture::new("wrong-confirm");
        let project = f.open_project();
        std::fs::write(project.join("f.txt"), "one\n").unwrap();
        git(&project, &["init", "-q"]);
        git(&project, &["add", "f.txt"]);
        git(&project, &["commit", "-q", "-m", "init"]);
        std::fs::write(project.join("f.txt"), "two\n").unwrap();

        let wrong = json!({"id": 1, "cmd": "git_discard", "args": {"paths": ["f.txt"]}, "confirm": "not the question"}).to_string();
        assert_eq!(code_of(&f.call(&wrong)), "confirm_required");
        assert_eq!(std::fs::read_to_string(project.join("f.txt")).unwrap(), "two\n");
    }

    #[test]
    fn root_swapped_for_a_link_outside_home_is_refused() {
        let mut f = Fixture::new("swap-root");
        let project = f.open_project();
        std::fs::remove_dir_all(&project).unwrap();
        std::os::unix::fs::symlink(&f.outside, &project).unwrap();
        let reply = f.call(r#"{"id":2,"cmd":"fs_list_dir","args":{"req":{"path":""}}}"#);
        assert_eq!(code_of(&reply), "outside_home");
    }

    #[test]
    fn deleted_root_answers_root_missing() {
        let mut f = Fixture::new("root-missing");
        let project = f.open_project();
        std::fs::remove_dir_all(&project).unwrap();
        let reply = f.call(r#"{"id":2,"cmd":"fs_list_dir","args":{"req":{"path":""}}}"#);
        assert_eq!(code_of(&reply), "root_missing");
        assert_eq!(reply["err"]["message"], "This folder is no longer on the server.");
        assert_eq!(code_of(&f.call(r#"{"id":3,"cmd":"git_status","args":{}}"#)), "root_missing");
    }

    #[test]
    fn root_replaced_by_a_file_answers_root_missing() {
        let mut f = Fixture::new("root-file");
        let project = f.open_project();
        std::fs::remove_dir_all(&project).unwrap();
        std::fs::write(&project, "not a folder\n").unwrap();
        assert_eq!(code_of(&f.call(r#"{"id":2,"cmd":"fs_list_dir","args":{"req":{"path":""}}}"#)), "root_missing");
    }

    /// Only a folder that is really gone counts as missing. A folder the server cannot read right now (a permission
    /// change, a flaky network mount) must not close the page's folder, because the app would then drop unsaved work.
    #[cfg(unix)]
    #[test]
    fn unreadable_root_is_not_reported_as_missing() {
        use std::os::unix::fs::PermissionsExt;
        let mut f = Fixture::new("root-denied");
        f.open_project();
        let home = f.home.clone();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o000)).unwrap();
        let reply = f.call(r#"{"id":2,"cmd":"fs_list_dir","args":{"req":{"path":""}}}"#);
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_ne!(code_of(&reply), "root_missing", "an unreadable folder is not a missing one: {reply}");
    }

    #[test]
    fn stale_confirm_after_the_file_set_changed_changes_nothing() {
        let mut f = Fixture::new("stale-confirm");
        let project = f.open_project();
        std::fs::write(project.join("f.txt"), "one\n").unwrap();
        std::fs::write(project.join("g.txt"), "one\n").unwrap();
        git(&project, &["init", "-q"]);
        git(&project, &["add", "f.txt", "g.txt"]);
        git(&project, &["commit", "-q", "-m", "init"]);
        std::fs::write(project.join("f.txt"), "two\n").unwrap();
        let old = f.call(r#"{"id":1,"cmd":"git_discard","args":{"paths":["f.txt"]}}"#);
        let old_question = old["err"]["message"].as_str().unwrap().to_string();
        // The set changes after the dialog text was shown: a second file is now part of the discard.
        std::fs::write(project.join("g.txt"), "two\n").unwrap();
        let stale = json!({"id": 2, "cmd": "git_discard", "args": {"paths": ["f.txt", "g.txt"]}, "confirm": old_question}).to_string();
        let reply = f.call(&stale);
        assert_eq!(code_of(&reply), "confirm_required");
        assert_ne!(reply["err"]["message"], old_question.as_str(), "the new set has its own question");
        assert_eq!(std::fs::read_to_string(project.join("f.txt")).unwrap(), "two\n");
        assert_eq!(std::fs::read_to_string(project.join("g.txt")).unwrap(), "two\n");
    }

    #[test]
    fn a_command_asking_two_questions_stops_at_the_first_unanswered_one() {
        let mut f = Fixture::new("two-questions");
        TWO_QUESTIONS_RAN.store(false, std::sync::atomic::Ordering::SeqCst);
        let none = f.call(r#"{"id":1,"cmd":"__two_questions","args":{}}"#);
        assert_eq!(code_of(&none), "confirm_required");
        assert_eq!(none["err"]["message"], "first question");
        let after_first = json!({"id": 2, "cmd": "__two_questions", "args": {}, "confirm": "first question"}).to_string();
        let second = f.call(&after_first);
        assert_eq!(code_of(&second), "confirm_required");
        assert_eq!(second["err"]["message"], "second question");
        let wrong_first = json!({"id": 3, "cmd": "__two_questions", "args": {}, "confirm": "second question"}).to_string();
        let wrong = f.call(&wrong_first);
        assert_eq!(wrong["err"]["message"], "first question");
        assert!(!TWO_QUESTIONS_RAN.load(std::sync::atomic::Ordering::SeqCst), "the second action never ran");
    }

    #[test]
    fn unsupported_commands_are_refused() {
        let mut f = Fixture::new("unsupported");
        for cmd in ["fs_open_pdf", "reveal_in_os", "no_such_command"] {
            let line = json!({"id": 1, "cmd": cmd, "args": {}}).to_string();
            assert_eq!(code_of(&f.call(&line)), "unsupported", "{cmd}");
        }
    }

    #[test]
    fn search_emits_events_then_done() {
        let mut f = Fixture::new("search");
        let project = f.open_project();
        std::fs::write(project.join("a.txt"), "a needle here\n").unwrap();
        let started = f.call(r#"{"id":1,"cmd":"project_search_start","args":{"req":{"query":"needle"}}}"#);
        let id = ok_of(&started)["id"].as_u64().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let text = String::from_utf8(f.captured.lock().unwrap().clone()).unwrap();
            let done = text.lines().any(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                v["event"] == "search" && v["data"]["type"] == "done" && v["data"]["id"] == id
            });
            if done {
                assert!(text.lines().any(|l| l.contains("\"type\":\"chunk\"") && l.contains("a.txt")));
                break;
            }
            assert!(std::time::Instant::now() < deadline, "no done event in: {text}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn panic_becomes_internal_and_keeps_running() {
        let mut f = Fixture::new("panic");
        let reply = f.call(r#"{"id":9,"cmd":"__panic","args":{}}"#);
        assert_eq!(reply["id"], 9);
        assert_eq!(code_of(&reply), "internal");
        assert!(ok_of(&f.call(r#"{"id":10,"cmd":"hello","args":{}}"#))["protocol"] == 2);
    }

    /// `ETXTBSY` ("Text file busy") on macOS and Linux. A script written while another thread forks can still be open
    /// for writing in that child, so its exec fails until the child execs.
    #[cfg(unix)]
    const ETXTBSY: i32 = 26;

    /// A stand-in git. `body` runs with git's arguments in `$@`. The file is synced and closed before any spawn, and
    /// the probe run (`--llmide-probe`, which exits at once) is retried on `ETXTBSY` a bounded number of times.
    #[cfg(unix)]
    fn fake_git(dir: &Path, body: &str) -> PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-git");
        {
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(format!("#!/bin/sh\n[ \"$1\" = --llmide-probe ] && exit 0\n{body}\n").as_bytes()).unwrap();
            file.sync_all().unwrap();
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        for attempt in 1..=50 {
            match std::process::Command::new(&path).arg("--llmide-probe").status() {
                Ok(status) => {
                    assert!(status.success(), "the fake git probe exits 0");
                    return path;
                }
                Err(e) if e.raw_os_error() == Some(ETXTBSY) && attempt < 50 => std::thread::sleep(std::time::Duration::from_millis(20)),
                Err(e) => panic!("the fake git cannot run: {e}"),
            }
        }
        unreachable!("the last attempt returns or panics")
    }

    /// Creates the destination (the last argument, as a real clone does), then hangs until it is cancelled.
    #[cfg(unix)]
    const SLOW_GIT: &str = "last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"; sleep 30";

    /// Creates the destination (the last argument, as a real clone does) and succeeds.
    #[cfg(unix)]
    const FAST_GIT: &str = "last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"";

    /// Rejects every credential, so the clone fails after its anonymous retry.
    #[cfg(unix)]
    const REFUSING_GIT: &str = "echo \"fatal: Authentication failed for 'https://github.com/o/r.git/'\" >&2; exit 128";

    #[cfg(unix)]
    fn use_fake_git(f: &mut Fixture, body: &str) {
        let git = fake_git(&f.outside, body);
        f.session.git_lookup = Box::new(move || Some(git.clone()));
    }

    fn clone_line(id: u64, url: &str, token: Option<&str>) -> String {
        json!({"id": id, "cmd": "repo_clone", "args": {"req": {"provider": "github", "url": url, "token": token}}}).to_string()
    }

    fn graph_read_line(id: u64, path: &Path) -> String {
        json!({"id": id, "cmd": "graph_read", "args": {"path": path.to_string_lossy()}}).to_string()
    }

    /// The reply to `clone_cancel {id}`, taken the way the reader answers it: outside the serial worker.
    fn cancel_clone(f: &Fixture, id: u64) -> Value {
        let line = json!({"id": 90, "cmd": "clone_cancel", "args": {"id": id}}).to_string();
        let req = parse_request(line.as_bytes()).unwrap();
        cancel_now(&f.session.searches, &f.session.clones, &req)
    }

    /// The `clone` event for clone `id`, if it has been written yet.
    fn clone_event_now(captured: &Arc<Mutex<Vec<u8>>>, id: u64) -> Option<Value> {
        let text = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        text.lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find(|v| v["event"] == "clone" && v["data"]["id"] == id)
            .map(|v| v["data"].clone())
    }

    /// Waits for the `clone` event that ends clone `id`, and returns its data.
    fn clone_event(captured: &Arc<Mutex<Vec<u8>>>, id: u64) -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if let Some(data) = clone_event_now(captured, id) {
                return data;
            }
            let text = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
            assert!(std::time::Instant::now() < deadline, "no clone event for {id} in: {text}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    /// Starts a clone and returns its id from the `started` reply.
    fn start_clone(f: &mut Fixture, id: u64, url: &str) -> u64 {
        let started = ok_of(&f.call(&clone_line(id, url, None))).clone();
        assert_eq!(started["started"], true);
        started["id"].as_u64().expect("started carries the clone id")
    }

    /// Waits until git has created `path`, so a cancel lands while the clone is running.
    #[cfg(unix)]
    fn wait_for_path(path: &Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !path.exists() {
            assert!(std::time::Instant::now() < deadline, "{} was never created", path.display());
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn clone_needs_an_open_folder() {
        let mut f = Fixture::new("clone-no-project");
        assert_eq!(code_of(&f.call(&clone_line(1, "o/r", None))), "no_project");
    }

    #[cfg(unix)]
    #[test]
    fn clone_in_a_plain_folder_lands_in_code() {
        let mut f = Fixture::new("clone-plain");
        let project = f.open_plain_folder();
        use_fake_git(&mut f, FAST_GIT);
        let id = start_clone(&mut f, 1, "o/r");
        let data = clone_event(&f.captured, id);
        assert_eq!(data["ok"], true, "{data}");
        assert!(project.join("code").join("r").is_dir(), "the core created code/r in the plain folder");
        assert!(!project.join("system").exists(), "a clone does not turn the folder into a project");
        assert_eq!(std::fs::read_to_string(project.join("notes.txt")).unwrap(), "mine notes");
    }

    #[test]
    fn missing_git_is_reported() {
        let mut f = Fixture::new("clone-no-git");
        f.open_new_project();
        f.session.git_lookup = Box::new(|| None);
        let reply = f.call(&clone_line(1, "o/r", None));
        assert_eq!(code_of(&reply), "git_missing");
        assert_eq!(reply["err"]["message"], "git is not installed on the server.");
    }

    #[cfg(unix)]
    #[test]
    fn requests_are_answered_while_a_clone_runs() {
        let mut f = Fixture::new("clone-answers");
        let project = f.open_new_project();
        use_fake_git(&mut f, SLOW_GIT);
        let id = start_clone(&mut f, 1, "o/r");
        wait_for_path(&project.join("code").join("r"));
        let timer = std::time::Instant::now();
        let listed = f.call(r#"{"id":2,"cmd":"fs_list_dir","args":{"req":{"path":""}}}"#);
        assert!(timer.elapsed() < std::time::Duration::from_millis(500), "a listing during a clone took {:?}", timer.elapsed());
        ok_of(&listed);
        ok_of(&cancel_clone(&f, id));
        assert_eq!(clone_event(&f.captured, id)["code"], "cancelled");
    }

    #[cfg(unix)]
    #[test]
    fn second_clone_is_busy() {
        let mut f = Fixture::new("clone-busy");
        f.open_new_project();
        use_fake_git(&mut f, SLOW_GIT);
        let id = start_clone(&mut f, 1, "o/one");
        assert_eq!(code_of(&f.call(&clone_line(2, "o/two", None))), "busy");
        ok_of(&cancel_clone(&f, id));
        assert_eq!(clone_event(&f.captured, id)["code"], "cancelled");
    }

    #[cfg(unix)]
    #[test]
    fn started_and_event_carry_the_same_id_and_ids_grow() {
        let mut f = Fixture::new("clone-ids");
        let project = f.open_new_project();
        use_fake_git(&mut f, SLOW_GIT);
        let first = start_clone(&mut f, 1, "o/one");
        wait_for_path(&project.join("code").join("one"));
        ok_of(&cancel_clone(&f, first));
        assert_eq!(clone_event(&f.captured, first)["id"], first);
        let second = start_clone(&mut f, 3, "o/two");
        assert!(second > first, "ids are unique and grow: {first} then {second}");
        ok_of(&cancel_clone(&f, second));
        assert_eq!(clone_event(&f.captured, second)["id"], second);
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_cancel_does_not_stop_a_newer_clone() {
        let mut f = Fixture::new("clone-stale");
        let project = f.open_new_project();
        use_fake_git(&mut f, SLOW_GIT);
        let old = start_clone(&mut f, 1, "o/one");
        ok_of(&cancel_clone(&f, old));
        assert_eq!(clone_event(&f.captured, old)["code"], "cancelled");
        let newer = start_clone(&mut f, 3, "o/two");
        wait_for_path(&project.join("code").join("two"));
        // A late cancel for the finished clone is a no-op that still answers null.
        assert!(ok_of(&cancel_clone(&f, old)).is_null());
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(clone_event_now(&f.captured, newer).is_none(), "the newer clone is still running");
        ok_of(&cancel_clone(&f, newer));
        assert_eq!(clone_event(&f.captured, newer)["code"], "cancelled");
    }

    #[cfg(unix)]
    #[test]
    fn a_request_right_after_an_event_is_not_refused_as_busy() {
        let mut f = Fixture::new("clone-after-event");
        let project = f.open_new_project();
        // Succeeds at once: creates the destination and exits 0.
        use_fake_git(&mut f, "last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"");
        let mut id = start_clone(&mut f, 1, "o/one");
        for round in 2..=4u64 {
            let data = clone_event(&f.captured, id);
            assert_eq!(data["ok"], true, "{data}");
            // The event is already written, so the slot is free: the next start is accepted, never busy.
            id = start_clone(&mut f, round, &format!("o/round{round}"));
        }
        let last = clone_event(&f.captured, id);
        assert_eq!(last["ok"], true, "{last}");
        assert!(project.join("code").join("round4").is_dir());
    }

    /// The exit path (a failed write) stops a running clone: git is killed, the partial folder is removed and the slot
    /// is freed, so nothing is left running when the process ends. `process::exit` itself is not run in a test.
    #[cfg(unix)]
    #[test]
    fn stopping_for_exit_removes_the_partial_clone() {
        let mut f = Fixture::new("clone-exit");
        let project = f.open_new_project();
        use_fake_git(&mut f, SLOW_GIT);
        let id = start_clone(&mut f, 1, "o/r");
        let dest = project.join("code").join("r");
        wait_for_path(&dest);
        f.session.clones.stop_for_exit();
        assert!(!dest.exists(), "the partial folder is removed before the exit");
        let data = clone_event(&f.captured, id);
        assert_eq!(data["code"], "cancelled");
        assert!(f.session.clones.begin().is_some(), "the slot is free once the clone has ended");
    }

    #[cfg(unix)]
    #[test]
    fn cancel_ends_with_clone_event_cancelled() {
        let mut f = Fixture::new("clone-cancel");
        let project = f.open_new_project();
        use_fake_git(&mut f, SLOW_GIT);
        let id = start_clone(&mut f, 1, "o/r");
        let dest = project.join("code").join("r");
        wait_for_path(&dest);
        ok_of(&cancel_clone(&f, id));
        let data = clone_event(&f.captured, id);
        assert_eq!(data["ok"], false);
        assert_eq!(data["code"], "cancelled");
        assert_eq!(data["message"], "clone cancelled");
        assert!(!dest.exists(), "the partial folder is removed before the event");
    }

    #[cfg(unix)]
    #[test]
    fn token_never_appears_in_any_output() {
        let mut f = Fixture::new("clone-token");
        f.open_new_project();
        use_fake_git(&mut f, REFUSING_GIT);
        let marker = "ghp_TOKEN_MARKER_7731";
        let grant_marker = "grant_GRANT_MARKER_4412";
        let key_marker = "fe".repeat(32);
        let key_marker = key_marker.as_str();
        // A refused token: the clone retries anonymously, fails, and the event carries git's error only.
        let started = start_clone(&mut f, 1, "o/r");
        let refused = clone_event(&f.captured, started);
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["code"], "clone_failed");
        // A refused grant: with no state file the redeem fails, the clone runs anonymously and is refused, and the
        // event says the saved token could not be used. The grant itself is never echoed.
        // The key marker is a real key here: the core refuses the redeem, so the key was sent but must not be echoed.
        let (core, sent) = crate::clone_credential::test_server::serve_once(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\n{}".to_vec());
        write_state(&f.home, core.port());
        write_key(&f.home, key_marker);
        let granted = start_grant_clone(&mut f, 3, "o/r", None, grant_marker);
        let granted = clone_event(&f.captured, granted);
        let sent = sent.join().unwrap();
        assert!(sent.contains(&format!("x-llmide-redeem-key: {key_marker}")), "the key was sent to the core: {sent}");
        assert_eq!(granted["code"], "clone_failed");
        assert_eq!(granted["message"], SAVED_TOKEN_REFUSED_MESSAGE);
        // A bad URL with the token set is refused synchronously.
        assert_eq!(code_of(&f.call(&clone_line(2, "https://evil.example/o/r", Some(marker)))), "clone_refused");
        // Every byte the helper wrote, replies and events alike, must lack the token in both forms, and the grant.
        let text = String::from_utf8(f.captured.lock().unwrap().clone()).unwrap();
        assert!(text.contains("Authentication failed"), "the refused run really ran: {text}");
        let github = llmide_workspace_core::project::clone::base64(format!("x-access-token:{marker}").as_bytes());
        let gitlab = llmide_workspace_core::project::clone::base64(format!("oauth2:{marker}").as_bytes());
        for form in [marker.to_string(), github, gitlab, grant_marker.to_string(), key_marker.to_string()] {
            assert!(!text.contains(&form), "the token, its encoded form or the grant reached the helper's output: {text}");
        }
    }

    /// The `repo_clone` line for a request that carries a grant, and optionally a typed token.
    fn grant_clone_line(id: u64, url: &str, token: Option<&str>, grant: &str) -> String {
        json!({"id": id, "cmd": "repo_clone", "args": {"req": {"provider": "github", "url": url, "token": token, "grant": grant}}}).to_string()
    }

    /// Starts a clone with a grant and returns its id from the `started` reply.
    fn start_grant_clone(f: &mut Fixture, id: u64, url: &str, token: Option<&str>, grant: &str) -> u64 {
        let started = ok_of(&f.call(&grant_clone_line(id, url, token, grant))).clone();
        started["id"].as_u64().expect("started carries the clone id")
    }

    /// The redeem key the core writes, as hex. The tests send it to a loopback server and check it reaches the header.
    const KEY_HEX: &str = "9a8b7c6d5e4f30291a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";

    /// Writes the server's state file the way the start script does: owner-only, naming the core's port.
    #[cfg(unix)]
    fn write_state(home: &Path, port: u16) {
        use std::os::unix::fs::PermissionsExt;
        let dir = home.join(".llmide-server");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let text = format!(r#"{{"running":true,"port":{port},"pid":1,"nonce":"health-nonce-is-not-used","version":"test"}}"#);
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// Writes the core's redeem key file: owner-only, one line of 64 hex characters.
    #[cfg(unix)]
    fn write_key(home: &Path, key: &str) {
        use std::os::unix::fs::PermissionsExt;
        let dir = home.join(".llmide-server").join("data");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clone-redeem.key");
        std::fs::write(&path, format!("{key}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// A stand-in git that appends the auth header it was given (or `none`) to `calls`, then creates the destination.
    #[cfg(unix)]
    fn recording_git(calls: &Path) -> String {
        format!(
            "if [ \"$GIT_CONFIG_KEY_0\" = http.https://github.com.extraHeader ]; then echo \"$GIT_CONFIG_VALUE_0\" >> '{0}'; else echo none >> '{0}'; fi; \
             last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"",
            calls.display()
        )
    }

    /// A 200 answer that carries `token` as the redeem body.
    fn token_answer(token: &str) -> Vec<u8> {
        let body = format!(r#"{{"token":"{token}"}}"#);
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
    }

    #[cfg(unix)]
    #[test]
    fn a_grant_is_redeemed_and_the_saved_token_reaches_git_and_no_output() {
        let mut f = Fixture::new("clone-grant-ok");
        f.open_new_project();
        let saved = "ghp_SAVED_TOKEN_5521";
        let (core, seen) = crate::clone_credential::test_server::serve_once(token_answer(saved));
        write_state(&f.home, core.port());
        write_key(&f.home, KEY_HEX);
        let calls = f.outside.join("calls.txt");
        use_fake_git(&mut f, &recording_git(&calls));
        let id = start_grant_clone(&mut f, 1, "o/r", None, "grant_OK_1");
        let data = clone_event(&f.captured, id);
        assert_eq!(data["ok"], true, "{data}");
        let header = std::fs::read_to_string(&calls).unwrap();
        let encoded = llmide_workspace_core::project::clone::base64(format!("x-access-token:{saved}").as_bytes());
        assert!(header.contains(&encoded), "git got the saved token in its header: {header}");
        let request = seen.join().unwrap();
        assert!(request.contains(&format!("x-llmide-redeem-key: {KEY_HEX}")), "{request}");
        assert!(!request.to_ascii_lowercase().contains("x-llmide-core-nonce"), "the health nonce is never sent: {request}");
        assert!(request.ends_with(r#"{"grant":"grant_OK_1"}"#), "{request}");
        let text = String::from_utf8(f.captured.lock().unwrap().clone()).unwrap();
        assert!(!text.contains(saved) && !text.contains(&encoded), "the saved token is in no helper output: {text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_redeem_clones_anonymously() {
        let mut f = Fixture::new("clone-grant-refused");
        f.open_new_project();
        let (core, seen) = crate::clone_credential::test_server::serve_once(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\n{}".to_vec());
        write_state(&f.home, core.port());
        write_key(&f.home, KEY_HEX);
        let calls = f.outside.join("calls.txt");
        use_fake_git(&mut f, &recording_git(&calls));
        let id = start_grant_clone(&mut f, 1, "o/r", None, "grant_BAD_2");
        let data = clone_event(&f.captured, id);
        assert_eq!(data["ok"], true, "the anonymous clone succeeds: {data}");
        assert_eq!(std::fs::read_to_string(&calls).unwrap(), "none\n", "git got no credential");
        seen.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_blank_typed_token_does_not_block_the_grant() {
        let mut f = Fixture::new("clone-blank-typed");
        f.open_new_project();
        let saved = "ghp_BLANK_CASE_6610";
        let (core, seen) = crate::clone_credential::test_server::serve_once(token_answer(saved));
        write_state(&f.home, core.port());
        write_key(&f.home, KEY_HEX);
        let calls = f.outside.join("calls.txt");
        use_fake_git(&mut f, &recording_git(&calls));
        let id = start_grant_clone(&mut f, 1, "o/r", Some("   "), "grant_BLANK_4");
        let data = clone_event(&f.captured, id);
        assert_eq!(data["ok"], true, "{data}");
        let header = std::fs::read_to_string(&calls).unwrap();
        let encoded = llmide_workspace_core::project::clone::base64(format!("x-access-token:{saved}").as_bytes());
        assert!(header.contains(&encoded), "the grant was redeemed and its token used: {header}");
        assert!(seen.join().unwrap().ends_with(r#"{"grant":"grant_BLANK_4"}"#));
    }

    #[cfg(unix)]
    #[test]
    fn a_panic_in_the_redeem_still_ends_the_clone_and_frees_the_slot() {
        let mut f = Fixture::new("clone-panic");
        f.open_new_project();
        use_fake_git(&mut f, "last=\"\"; for a in \"$@\"; do last=\"$a\"; done; mkdir -p \"$last\"");
        let id = start_grant_clone(&mut f, 1, "o/r", None, crate::session::PANIC_GRANT_FOR_TEST);
        let data = clone_event(&f.captured, id);
        assert_eq!(data["ok"], false, "{data}");
        assert_eq!(data["code"], "internal", "{data}");
        // The slot is free again: a later clone starts and finishes.
        let next = start_clone(&mut f, 2, "o/r");
        assert_eq!(clone_event(&f.captured, next)["ok"], true, "the slot was freed");
    }

    #[cfg(unix)]
    #[test]
    fn a_typed_token_skips_the_grant() {
        let mut f = Fixture::new("clone-typed-wins");
        f.open_new_project();
        let (core, seen) = crate::clone_credential::test_server::serve_once(token_answer("ghp_NOT_USED"));
        write_state(&f.home, core.port());
        write_key(&f.home, KEY_HEX);
        let calls = f.outside.join("calls.txt");
        use_fake_git(&mut f, &recording_git(&calls));
        let id = start_grant_clone(&mut f, 1, "o/r", Some("ghp_TYPED_8"), "grant_IGNORED_3");
        let data = clone_event(&f.captured, id);
        assert_eq!(data["ok"], true, "{data}");
        let header = std::fs::read_to_string(&calls).unwrap();
        let typed = llmide_workspace_core::project::clone::base64(b"x-access-token:ghp_TYPED_8");
        assert!(header.contains(&typed), "git got the typed token: {header}");
        assert!(!seen.is_finished(), "no redeem was sent when a token was typed");
    }

    #[test]
    fn graph_read_refuses_over_48_mib() {
        let mut f = Fixture::new("graph-big");
        let project = f.open_project();
        let graph = project.join("graph.json");
        // A sparse file: its length is over the limit, and no 48 MB is written to the disk.
        std::fs::File::create(&graph).unwrap().set_len(48 * 1024 * 1024 + 1).unwrap();
        let reply = f.call(&graph_read_line(1, &graph));
        assert_eq!(code_of(&reply), "too_large");
        assert!(reply["err"]["message"].as_str().unwrap().contains("larger than the size limit"), "{reply}");
    }

    #[test]
    fn graph_answer_must_fit_one_protocol_line() {
        let f = Fixture::new("graph-answer");
        let project = f.canonical_home().join("project");
        std::fs::create_dir_all(&project).unwrap();
        // Eight quotes encode to 18 bytes (each `"` becomes `\"`, plus the outer pair), so a 16-byte cap refuses it.
        std::fs::write(project.join("graph.json"), "\"\"\"\"\"\"\"\"").unwrap();
        let file = project.join("graph.json");
        let refused = crate::project_setup::graph_read_capped(&project, &file.to_string_lossy(), 1000, 16).unwrap_err();
        assert_eq!(refused.code, "too_large");
        let kept = crate::project_setup::graph_read_capped(&project, &file.to_string_lossy(), 1000, 18).unwrap();
        assert_eq!(kept.as_str().unwrap().len(), 8);
    }

    #[test]
    fn graph_read_stays_inside_root() {
        let mut f = Fixture::new("graph-read");
        let project = f.open_new_project();
        let graph = project.join("graph.json");
        std::fs::write(&graph, r#"{"nodes":[]}"#).unwrap();
        assert_eq!(ok_of(&f.call(&graph_read_line(1, &graph))), r#"{"nodes":[]}"#);
        // A graph file outside the root, and a path that climbs out of it.
        let outside = std::fs::canonicalize(&f.outside).unwrap();
        std::fs::write(outside.join("graph.json"), "outside").unwrap();
        let climbing = project.join("..").join("..").join("outside").join("graph.json");
        assert_eq!(code_of(&f.call(&graph_read_line(2, &outside.join("graph.json")))), "graph_read_failed");
        assert_eq!(code_of(&f.call(&graph_read_line(3, &climbing))), "graph_read_failed");
        // A link inside the root that points at a graph file outside it.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("graph.json"), project.join("graph-code.json")).unwrap();
            assert_eq!(code_of(&f.call(&graph_read_line(4, &project.join("graph-code.json")))), "graph_read_failed");
        }
        // Only the known graph file names are read.
        std::fs::write(project.join("notes.json"), "x").unwrap();
        assert_eq!(code_of(&f.call(&graph_read_line(5, &project.join("notes.json")))), "graph_read_failed");
    }
}
