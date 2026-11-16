//! `llmide-workspace`: serves the Explorer's file, git, search and watch commands for one server folder.
//!
//! It reads one JSON request per line on stdin and writes responses and events on stdout (see `protocol`). It has
//! no network listener and runs as the SSH user. Requests run one at a time in order, except that a search cancel
//! and a clone cancel are answered at once. A clone runs on its own thread, so the other requests are answered while
//! it runs. The process ends when stdin closes, after the watcher, any search and any clone have stopped.

mod clone_credential;
mod dispatch;
mod project_setup;
mod protocol;
mod session;

use std::io::{self, BufRead, BufReader};
use std::sync::{mpsc, Arc};
use std::thread;

use llmide_workspace_core::search::Searches;
use session::Clones;

use protocol::{err_response, parse_request, read_bounded_line, Line, Out, Request, MAX_LINE_BYTES};
use serde_json::Value;

/// How many requests may wait for the worker. When the queue is full the reader blocks, so a flood of requests
/// stops being read instead of piling up in memory. A `project_search_cancel` is answered by the reader only while
/// the reader is not blocked here; behind a full queue it waits its turn, so the cap is kept small.
const QUEUE_CAPACITY: usize = 8;

/// One item for the worker, in the order the lines arrived. Answers to refused lines travel the same queue, so
/// every reply comes out in request order, not ahead of a request still waiting.
enum Job {
    Run(Request),
    Refused(Value),
}

fn main() {
    let clones = Arc::new(Clones::new());
    // A failed write ends the process, so the clone is stopped first: git runs in its own process group and would
    // otherwise outlive the helper.
    let stop_clone = Arc::clone(&clones);
    let out = Arc::new(Out::stdout(Box::new(move || stop_clone.stop_for_exit())));
    let searches = Arc::new(Searches::new());
    let (tx, rx) = mpsc::sync_channel::<Job>(QUEUE_CAPACITY);
    let worker = {
        let out = Arc::clone(&out);
        let searches = Arc::clone(&searches);
        let clones = Arc::clone(&clones);
        thread::spawn(move || {
            let mut session = session::Session::new(Arc::clone(&out), searches, clones);
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
    read_requests(BufReader::new(io::stdin().lock()), &out, &searches, &clones, &tx);
    drop(tx);
    let _ = worker.join();
    std::process::exit(0);
}

/// Reads lines until end of input. A line that is too long is refused and reading goes on.
fn read_requests<R: BufRead>(mut reader: R, out: &Out, searches: &Searches, clones: &Clones, tx: &mpsc::SyncSender<Job>) {
    loop {
        match read_bounded_line(&mut reader, MAX_LINE_BYTES) {
            Ok(Line::Eof) | Err(_) => return,
            Ok(Line::TooLong) => {
                let reply = err_response(0, "bad_request", "the request line is longer than 64 MB");
                let _ = tx.send(Job::Refused(reply));
            }
            Ok(Line::Text(bytes)) if bytes.iter().all(u8::is_ascii_whitespace) => {}
            Ok(Line::Text(bytes)) => route(out, searches, clones, tx, &bytes),
        }
    }
}

fn route(out: &Out, searches: &Searches, clones: &Clones, tx: &mpsc::SyncSender<Job>, bytes: &[u8]) {
    match parse_request(bytes) {
        Err(reply) => {
            let _ = tx.send(Job::Refused(reply));
        }
        Ok(req) if dispatch::is_immediate(&req) => {
            out.send(&dispatch::cancel_now(searches, clones, &req));
        }
        Ok(req) => {
            // The worker only stops after this loop ends, so the send cannot fail while input is still open.
            let _ = tx.send(Job::Run(req));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_queue_blocks_the_reader_without_dropping_requests() {
        let (tx, rx) = mpsc::sync_channel::<Job>(2);
        let input: String = (1..=5).map(|i| format!("{{\"id\":{i},\"cmd\":\"hello\",\"args\":{{}}}}\n")).collect();
        let out = Arc::new(Out::new(Box::new(io::sink()), false));
        let searches = Arc::new(Searches::new());
        let clones = Clones::new();
        let reader_tx = tx.clone();
        let reader = thread::spawn(move || read_requests(io::Cursor::new(input.into_bytes()), &out, &searches, &clones, &reader_tx));
        thread::sleep(std::time::Duration::from_millis(300));
        assert!(!reader.is_finished(), "the reader must wait while the queue is full");
        let ids: Vec<u64> = (0..5)
            .map(|_| match rx.recv().expect("a queued request") {
                Job::Run(req) => req.id,
                Job::Refused(_) => panic!("every line here is a valid request"),
            })
            .collect();
        reader.join().unwrap();
        assert_eq!(ids, [1, 2, 3, 4, 5]);
    }
}
