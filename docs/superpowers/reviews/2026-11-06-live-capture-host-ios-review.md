# Review: live capture, desktop audit fixes, SFTP Task 1, iOS audit fixes (2026-11-06)

Range: 7abe0d7d..f7aea58c (18 commits plus the earlier live-capture Rust commits). Three independent reviewers; findings verified against the code before fixing.

## Verdicts

| Group | Verdict | Tests |
|---|---|---|
| Desktop live capture (plan `2026-11-05-desktop-live-capture.md`) | Approve after 2 Important fixed | cargo `capture` 33/33, ui 59/59, parity fixture 2/2 |
| Desktop audit fixes + SFTP Task 1 (61389e52) | Approve after 1 Important fixed | cargo 578 pass, sftp + lazy 13/13 |
| iOS audit + enrollment hardening | Approve; 1 Important fixed, 1 recorded | SharedProtocol 151/151, iphoneos build OK, Info.plist keys identical |

## Fixed in this review

1. **Read-only revert broke on agent-created files** (`desktop/src-tauri/src/loop_runner.rs`). 76ca1f7b made the host ignore `created`, so any read-only Auto Task / Loop run that created a file failed the whole revert and left the tracked edits in place too. Restored removal, only for paths that are in the run's `createdPaths`, untracked, not a directory, with a parent that canonicalizes inside the worktree; a symlink is removed itself, never its target. Any other untracked path still refuses the whole call. Test updated to assert removal.
2. **No Stop after the Live screen remounts** (`ui/screens/live/LiveScreen.tsx`). A project switch or reload while capturing showed Start (failing `already_recording`) and no Stop. A status read now adopts a running capture (`adoptPhase`), restores the banner state, and shows Stop. The live transcript of the earlier mount is not re-attached; the rows are still in the note.
3. **Finished notes never reached search** (`ui/screens/live/index.tsx`, `RecoveryList.tsx`). `indexNote` (plan Task 10, `POST /kb/index/notes`) is wired for Stop and for Finish from recovery; a failed index says the next Library rebuild will find it. Language now follows the browser, not a hard-coded "en".
4. **IPv6 private check too loose** (`ios_app/SharedProtocol/.../PairingInfo.swift`). `fc::1` / `fe8::1` passed as private. The fc00::/7 and fe80::/10 prefixes now require a full 4-digit first group. Tests added, plus the scheme/PIN/port-floor/oversized-host cases that had none.

## Open (recorded, not fixed)

- **iOS v2 orphaned replies** (`ios_app/MyApp/Services/V2HostConnection.swift`): if the Mac never answers a timed-out request, the next reply of that kind is dropped and every later snapshot/clear times out until reconnect. Relies on the Mac answering every request in order. Fix later: on a timeout, drop the socket so the reconnect resets the count.
- Live capture minors: the spike fixture recorder writes real names unscrubbed with 0644 (dev-only, spike feature); the privacy guard test matches only `print!`/`eprintln!`/`dbg!`; Stop is disabled while the core restarts; a failed read-back leaves the note and a later Finish writes a "-2" copy; no worker-loop test for Stop/Abort/permission-lost; unused re-export warning at `capture_ax_macos.rs:6`.
- SFTP minors: fingerprint compared with `===` (public value, low risk); no timeout on the SFTP subsystem request after `ready` (keepalive bounds a dead link).
- iOS minor: a partial Keychain write on failure in `SyncStore.swift:123-125` (retry works).
- Mac bridge token is now memory-only, so a desktop reload means re-entering the PIN (intended by d9d00e00).

Not checked: real Zoom/Teams AX trees (fixtures are synthetic), a live SFTP server, Windows branches.
