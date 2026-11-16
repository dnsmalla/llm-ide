//! End to end over the real binary's stdin and stdout: bad input is answered and the next request still runs, and
//! the process exits 0 when input ends.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn bad_and_oversized_lines_are_answered_and_the_helper_keeps_running() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_llmide-workspace"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the helper starts");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");

    // The oversized request is one line of 64 MB + 1 byte, so it must be refused without being parsed.
    let oversized_pad = "x".repeat(64 * 1024 * 1024);
    let writer = std::thread::spawn(move || {
        writeln!(stdin, r#"{{"id":1,"cmd":"hello","args":{{}}}}"#).unwrap();
        writeln!(stdin, "{{not json").unwrap();
        writeln!(stdin, r#"{{"id":2,"cmd":"hello","args":{{"pad":"{oversized_pad}"}}}}"#).unwrap();
        writeln!(stdin, r#"{{"id":3,"cmd":"hello","args":{{}}}}"#).unwrap();
        // Dropping stdin here is the end of input the desktop sends when it closes.
    });

    let lines: Vec<String> = BufReader::new(stdout).lines().map(Result::unwrap).collect();
    writer.join().unwrap();
    let status = child.wait().expect("the helper ends");
    assert!(status.success(), "the helper exits 0 at end of input");

    let replies: Vec<serde_json::Value> = lines.iter().map(|l| serde_json::from_str(l).expect("one JSON object per line")).collect();
    assert_eq!(replies.len(), 4, "{lines:?}");
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[0]["ok"]["protocol"], 1);
    assert_eq!(replies[1]["id"], 0);
    assert_eq!(replies[1]["err"]["code"], "bad_request");
    assert_eq!(replies[2]["id"], 0);
    assert_eq!(replies[2]["err"]["code"], "bad_request");
    assert_eq!(replies[3]["id"], 3);
    assert_eq!(replies[3]["ok"]["protocol"], 1);
}
