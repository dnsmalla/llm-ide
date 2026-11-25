//! Opt-in end-to-end run of the environment cache against a real project; never part of the normal test run.
//!
//! LLMIDE_E2E_PROJECT=<project root: system/loop.json and the repo under code/<name>> LLMIDE_E2E_LOOP=<loop id>
//! cargo test --lib env_cache_e2e -- --ignored --nocapture
//!
//! It cuts two Factory worktrees the way a run does (`prepare_in`), prepares the environment in each through the real
//! approval and cache code, and prints how long each step took and what the restored environment can import.
use std::path::Path;
use std::time::Instant;

use super::*;
use crate::loop_approval::{approve_loop_with, ApprovalStore};

fn probe(worktree: &Path) -> String {
    let python = worktree.join(".venv/bin/python");
    let out = std::process::Command::new(&python)
        .args(["-c", "import sys, PyQt6, pandas, numpy, openpyxl, pytest; print(sys.prefix); print('imports ok')"])
        .current_dir(worktree)
        .output();
    match out {
        Ok(o) => format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)).trim().replace('\n', " | "),
        Err(e) => format!("cannot run {}: {e}", python.display()),
    }
}

#[test]
#[ignore]
fn env_cache_e2e_on_a_real_project() {
    let (Ok(project), Ok(loop_id)) = (std::env::var("LLMIDE_E2E_PROJECT"), std::env::var("LLMIDE_E2E_LOOP")) else {
        eprintln!("set LLMIDE_E2E_PROJECT and LLMIDE_E2E_LOOP to run this");
        return;
    };
    let project = std::fs::canonicalize(project).unwrap();
    let repo = crate::loop_runner::work_root(&project);
    let store = ApprovalStore::new();
    let token = approve_loop_with(&store, &project, &loop_id, crate::confirm::now_ms(), |_, text| {
        println!("--- approval dialog ---\n{text}\n-----------------------");
        true
    })
    .unwrap()
    .expect("approved")
    .token;

    for run_id in ["e2e-a", "e2e-b", "e2e-c"] {
        let t0 = Instant::now();
        let info = crate::loop_worktree::prepare_in(&project, &repo, run_id, None, "e2e task").unwrap();
        let cut = t0.elapsed();
        let wt = Path::new(&info.worktree);
        let t1 = Instant::now();
        let got = prepare_gated(&project, wt, run_id, &loop_id, Some(1800), &store, Some(&token)).unwrap();
        println!("[{run_id}] worktree {:?}; env {} in {:?}: {}", cut, got.status, t1.elapsed(), got.message);
        if let Some(out) = &got.output {
            println!("[{run_id}] setup output tail: {}", out.lines().rev().take(3).collect::<Vec<_>>().join(" | "));
        }
        println!("[{run_id}] probe: {}", probe(wt));
        let which = crate::loop_runner::run_command_keyed(wt, "command -v pytest python3; echo VIRTUAL_ENV=$VIRTUAL_ENV", Some(30), run_id).unwrap();
        println!("[{run_id}] a stage command resolves: {}", which.stdout.trim().replace('\n', " | "));
    }
    // A resumed run after an app restart: the in-memory registry is lost, the worktree and its marker are not.
    let run_id = "e2e-a";
    let wt_path = project.join("system").join("loop-worktrees").join(run_id);
    forget_env_use(&wt_path);
    let before = crate::loop_runner::run_command_keyed(&wt_path, "command -v pytest", Some(30), run_id).unwrap();
    let t = Instant::now();
    let again = prepare_gated(&project, &wt_path, run_id, &loop_id, Some(1800), &store, None).unwrap();
    let after = crate::loop_runner::run_command_keyed(&wt_path, "command -v pytest", Some(30), run_id).unwrap();
    println!("[resume] before: {} | prepare: {} in {:?} | after: {}", before.stdout.trim(), again.status, t.elapsed(), after.stdout.trim());
    let cache = cache_root(&project);
    for e in std::fs::read_dir(&cache).unwrap().flatten() {
        println!("cache entry: {}", e.file_name().to_string_lossy());
    }
}
