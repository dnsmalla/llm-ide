# Roadmap: now, next, later

Updated 2026-10-29. Principle (user, 2026-10-29): **professional quality over speed.** No safety gate is compressed to hit a date. A phase ships only when its exit gate, its independent review and the full pre-push gate are green.

Legend: **[me]** the agent does it, **[you]** needs the user, **[wait]** time-gated (real data must accumulate).

## Now (recent to do)

| # | Task | Who | State |
|---|---|---|---|
| N1 | First-launch check: data moved to Application Support (verified 2026-10-29: live server on the new `data.db`/`agent.db`, `.pre-move` copies removed); shadow mode on. Remaining: confirm chats, settings, OS page, Storage hub look right. | you | data move done |
| N6 | Fixed (3a110360): the moved-kb guard now runs before any secrets or files are created; tests use in-memory secrets. Stray `kb/.dev-secrets.json` from 19:28 awaits your delete. | you | open |
| N2 | Live-then-archive Phase 2 review fixes (reconciler safety: partial scans, sign-out, manifest chunking, compare noise, event-loop bounds). | me | agent running |
| N3 | Live-then-archive Phase 5, extension part (T5.2): draft kept until acked, legacy "copy to Mac", no local chat buffer, "Mac app not running" state. | me | agent running |
| N4 | One independent review of N2 and N3, then the full gate and one push, then rebuild the app. | me | after N2, N3 |
| N5 | Decide the three questions that block code: **Q19** (notes without `platform` frontmatter are invisible), **Q2** (continue an ended normal chat: replay or read-only), **Q16** (search latency at 50k notes). | you | open |

## Next (after the Now list, in order)

| # | Task | Who | Gate |
|---|---|---|---|
| X1 | Phase 4: async quit archive, crash-recovery sweep, delete-everywhere, sign-out/multi-user, phone path. **Built, reviewed twice, pushed (a7a73f05); app rebuilt.** Remaining: the manual quit/relaunch run with `lta.mode=on`. | you + me | manual run |
| X5 | Ledger step B (agent store Stage 2): move budget readers to `usage_calls` only after 7 days of zero mismatches; **fail closed** to the ledger. | me/you | go/no-go by you |
| X6 | Verify and remove leftovers after the first launch: `.pre-move` files are auto-removed on the second healthy boot; confirm they are gone. | me | after N1 |

## Later

**Meetings are not in use yet (user, 2026-10-29).** Everything that needs real meeting notes waits until meetings are recorded in the active project. Shadow mode is on (`lta.mode=shadow`) and costs nothing while there are no meeting notes; the daily compare reports `not-evaluated`.

| # | Task | Notes |
|---|---|---|
| M1 | Phase 5, Mac side: T5.1 ack after verify with the server's `lines`/`hash` + unacked adoption at start + dedupe a re-sent capture by session id; T5.3 meeting-attached chat (`meetingId`, no undo). | when meetings are used |
| M2 | Shadow soak on real meeting notes: 7 days, topK(10) overlap, countDelta 0, drift clean. | needs meeting notes |
| M3 | Phase 3: read-path switch (server reads from `note_index`, extension reads live, token bench guard). | after M2 |
| L1 | Phase 6: delete-path switch and legacy migration (destructive; own gate, export-before-delete, 30-day `VACUUM INTO` backup, rollback drill). | after M2 and M3 are clean |
| L2 | Knowledge-kit K1: files stay the truth, server keeps a rebuildable index. Needs the remaining knowledge questions (Q6, Q7, Q9, Q12, Q13) and the plugin/MCP UI owner (Q4). | after the lifecycle build |
| L3 | Agent-kit K1: chat state per the lifecycle decision; classic engine fate (Q3); SDK surface triage (129 unreviewed items); dead routes (Q7) with API version bump. | after L2 starts |
| L4 | Docs-kit K2-K4 (remove proof, Tauri screens, retire Swift path after one release default-on). | gated by release cadence |
| L5 | Other kits in plan order: work, workspace, capture, automation (job runner first), sync. | plan: kit-by-kit migration |
| L6 | Graph layout in Rust/WASM (spike done: 16% faster, shared kernel). Revisit when the Tauri work starts. | spikes/layout-t0.md |
| L7 | Tauri desktop + relay (ADR 0018). | Phase 0 PoC gate |

## Loose ends (small, schedule with the phase that touches the file)

- Storage hub (graph-kit web page) does not yet render `GET /kb/storage` `shadow` (server side shipped, API 87).
- Settings screen for `lta.mode` (today: `defaults write`).
- Sign-out seam for the note-index reconciler (fixed in N2).
- Clear sheet: add the "older than N days" option (server supports it).
- `LLMIDE_DATA_DIR` line in `.env.example`; decide the `/health` addition's `SERVER_API_VERSION` bump.
- Pin the extension origin (CORS currently allows every `chrome-extension://*`; Q22).
- Quit-time delay verification on macOS logout (Q21); `llmide://` launch from Chrome (Q11).
- Real-corpus checks that fixtures cannot give: platform-less note count, hidden-note semantics, iCloud placeholders.
- Flaky under full-gate load (pass alone): `loop-contract-lab` "project environment inspector" fake-Python probes (7 asserts, 2026-10-29 push), `ExplorerTreeStoreWatchTests.testStartWatchingSeesDeletesAndRenames`. Harden their timeouts instead of re-running.
- Live capture: the Mac must ack with the server's authoritative `lines`/`hash` (`GET /kb/live/unacked`), and dedupe a re-sent capture by session id so it does not write a second note (T5.1).
- Two Macs on one account can flap note-index keys (detected and logged, not prevented; device scoping deferred).

## Quality gates that never get skipped

Independent Sonnet review for data-touching code; `make regression`; contract gates; feature-boundary gate; markdownlint before every push; old-format fixtures for every migration (N-1 readable, rollback tested); real-data checks before any destructive switch; nothing deleted without a verified copy.
