//! `llmide-workspace`: serves the Explorer's file, git, search and watch commands for one server folder.
//!
//! It reads one JSON request per line on stdin and writes responses and events on stdout (see `protocol`). It has
//! no network listener and runs as the SSH user. Requests run one at a time in order, except that a search cancel
//! is answered at once. The process ends when stdin closes, after the watcher and any search have stopped.

mod dispatch;
mod protocol;
mod session;

use std::io::{self, BufReader};
use std::sync::{mpsc, Arc};
use std::thread;

use llmide_workspace_core::search::Searches;

use protocol::{err_response, parse_request, read_bounded_line, Line, Out, Request, MAX_LINE_BYTES};
use serde_json::Value;

/// One item for the worker, in the order the lines arrived. Answers to refused lines travel the same queue, so
/// every reply comes out in request order, not ahead of a request still waiting.
enum Job {
    Run(Request),
    Refused(Value),
}

fn main() {
    let out = Arc::new(Out::new(Box::new(io::stdout()), true));
    let searches = Arc::new(Searches::new());
    let (tx, rx) = mpsc::channel::<Job>();
    let worker = {
        let out = Arc::clone(&out);
        let searches = Arc::clone(&searches);
        thread::spawn(move || {
            let mut session = session::Session::new(Arc::clone(&out), searches);
            for job in rx {
                let reply = match job {
                    Job::Run(req) => dispatch::handle_request(&mut session, &req),
                    Job::Refused(reply) => reply,
                };
                out.send(&reply);
            }
            session.shutdown();
        })
    };
    read_requests(&out, &searches, &tx);
    drop(tx);
    let _ = worker.join();
    std::process::exit(0);
}

/// Reads lines until end of input. A line that is too long is refused and reading goes on.
fn read_requests(out: &Out, searches: &Searches, tx: &mpsc::Sender<Job>) {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    loop {
        match read_bounded_line(&mut reader, MAX_LINE_BYTES) {
            Ok(Line::Eof) | Err(_) => return,
            Ok(Line::TooLong) => {
                let reply = err_response(0, "bad_request", "the request line is longer than 64 MB");
                let _ = tx.send(Job::Refused(reply));
            }
            Ok(Line::Text(bytes)) if bytes.iter().all(u8::is_ascii_whitespace) => {}
            Ok(Line::Text(bytes)) => route(out, searches, tx, &bytes),
        }
    }
}

fn route(out: &Out, searches: &Searches, tx: &mpsc::Sender<Job>, bytes: &[u8]) {
    match parse_request(bytes) {
        Err(reply) => {
            let _ = tx.send(Job::Refused(reply));
        }
        Ok(req) if dispatch::is_immediate(&req) => {
            out.send(&dispatch::cancel_now(searches, &req));
        }
        Ok(req) => {
            // The worker only stops after this loop ends, so the send cannot fail while input is still open.
            let _ = tx.send(Job::Run(req));
        }
    }
}
