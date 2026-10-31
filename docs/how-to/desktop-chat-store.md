# Desktop chat store: one copy, live then archive

The desktop app keeps each chat as one file in the Mac app's own format (`sessions/<UUID>.json`), so
there is one stored copy of a chat whichever app wrote it. Code: `desktop/src-tauri/src/chat_store.rs`
(files), `chat_archive.rs` (quit hook and recovery sweep), `chat_cmds.rs` (Tauri commands).
Decision record: [Phase 3 plan, section 4](../superpowers/plans/2026-10-31-tauri-phase3-plan.md).

## Where the files are

| OS | Directory |
|---|---|
| macOS | the Mac app's `~/Library/Application Support/llm-ide/sessions/` in place (the legacy `LLM IDE` folder while only that exists; never created beside it) |
| Windows | `%LOCALAPPDATA%\llm-ide-desktop\chats\<userId>\sessions\` |
| Linux | `$XDG_DATA_HOME` or `~/.local/share` + `/llm-ide-desktop/chats/<userId>/sessions/` |

`LLMIDE_CHAT_STORE_DIR` (absolute) overrides the base for tests and operators. Beside `sessions/`:
`pending-deletes.json` (the Mac's tombstone file, same format) and `chat-store.lock`. The listing
index and the archive journal are Tauri-private and live under `<desktop data dir>/chat-store/<userId>/`.

## File format

One JSON object per chat, written like Swift's default `JSONEncoder`: `storeVersion` (2), `id` (upper-case
UUID, equal to the file name), `scope` (`explorer|conflicts|visual|docGen|quick`), `title`, `createdAt` and
`lastUsedAt` (Double seconds since 2001-01-01 UTC), `messages` (the Mac `ChatMessage` objects, kept verbatim),
optional `engine`, `projectId`, `meetingId`, `ownerUserId`, `origin`, `archive {hash,count}`, `route`.
Unknown keys survive a rewrite. Swift-written fixtures are in `schema/chat-session/`; the Rust tests
read them, list them, page them and write them back without loss. A v1 file (`history`) or a newer
`storeVersion` is left alone and counted as unsupported.

Messages cannot be read in chunks (one JSON object, as on the Mac), so `chat_load` makes one streaming
pass that keeps only the requested page in memory (the newest N, or the N before `before`); a chat file
over 256 MiB is refused, over 64 MiB is read-only. The Mac itself caps a chat at 500 messages.

## Rules the code enforces

- The webview never sends a path or a user id. It binds its signed-in session (`chat_bind_session`);
  the host asks the core (`GET /auth/me`) who the token belongs to and derives the directory from that.
  The token stays in host memory (the quit hook needs it), is never written or logged, and is dropped
  by `chat_unbind_session`.
- Chat ids must be UUIDs, user ids one `[A-Za-z0-9._-]` segment: no traversal.
- A file stamped with another `ownerUserId` is invisible and never overwritten; unowned older files
  are visible, as on the Mac. Saves stamp the owner.
- Overwrites are compare-and-swap on a revision (mtime ns, size, inode) under the lock; the Mac app does
  not take our lock file, so against the Mac the revision check is the protection (a concurrent Mac write
  is a `conflict`, never lost). The lock file records pid and process start time; a dead owner or a
  recycled pid is recovered. Writes are temp file, fsync, rename, directory fsync.
- Delete writes a tombstone to `pending-deletes.json` first, then removes the file, then asks the core
  (`POST /kb/session-purges`). A tombstoned id is hidden, unreadable and unsavable; a resurrected file is
  removed by the sweep. The Mac replays the same entries and vice versa.
- A file that cannot be parsed is renamed `<UUID>.corrupt-<unix ts>` (the Mac's convention), never deleted.
- Chat content is never logged and never appears in an error.

## Quit hook and recovery (live-then-archive)

The chat file is the live and final transcript; the server holds only working state (agent mapping, SDK
transcript, session memory). On quit, for every chat the server still holds working state for: verify the
file (exists, decodes, owned, has messages, not older than the server's last use), record a receipt
(`POST /kb/archive-receipts`, SHA-256 over the file's messages, identical to the server's `archiveHash`),
then purge (`POST /agent/v2/sessions/purge`, `verified: true`). Nothing is purged before its receipt; the
server itself refuses a busy chat or a stale receipt. A hard 6 s cap bounds the run.

A journal (`archive-journal.json`) is written before the first server call. At the next start, right after
the webview binds its session, the sweep replays tombstones and repeats the same steps; it needs no journal
to be correct, the journal only makes an interrupted run visible (`chat_archive_status`).

| | macOS | Windows / Linux |
|---|---|---|
| Cmd-Q, window close, Dock quit | `ExitRequested` runs the archive | `ExitRequested` on last window close |
| SIGTERM / SIGINT | handler runs a 3 s archive | Linux same; Windows has no signal |
| OS shutdown, `TerminateProcess`, crash, power loss | sweep at next start | sweep at next start |

So Windows and Linux are weaker: there is no hook for an OS shutdown, and the sweep carries it. The
extension's server-held chats (`/kb/chat/sessions`, archive begin/commit) are NOT archived by the desktop
app yet; the Mac app does that, and without it those rows stay on the server.
Orphaned working state (file gone, no tombstone) is reported as `fileMissing` and not purged here.

## Commands

`chat_bind_session`, `chat_unbind_session`, `chat_list` (paged, newest first, 10k+ chats via a cached
index keyed by mtime and size), `chat_load` (page), `chat_save` (`replace`, or `append` with the expected
count; the revision is required once the chat exists), `chat_delete`, `chat_archive_status`.
