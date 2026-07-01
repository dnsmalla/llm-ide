---
title: "0013. Multi-session chat store"
status: accepted
date: 2026-05-20
---

# 0013. Multi-session chat store

## Context

The Code Assistant chat originally persisted to a single `chat-history.json` file under `~/Library/Application Support/LLM IDE/`. That worked for a one-chat-per-user world but broke down once users started keeping several work threads in flight (one for a refactor, one for a bug hunt, one for a spec review). Every new question polluted the same transcript; the only "new chat" gesture was Clear History, which threw the previous context away.

Users started asking for Cursor-style chat history — a list of past sessions on a sidebar, each named after its first user turn, switchable with one click.

Two alternative shapes were considered:

1. **Single file with an embedded array of sessions.** Cheap to migrate, but every save rewrites the entire file (which grows linearly with both session count and turn count). Atomicity gets harder as the file gets large.
2. **One JSON file per session, listed via directory enumeration.** Bounded per-file size, deletes are `rm`, no merge logic on save, individual files can be quarantined if corrupt without losing the rest.

## Decision

One JSON file per session under `~/Library/Application Support/LLM IDE/sessions/<uuid>.json`.

- `currentSessionIDString` in `@AppStorage` points to the active session id; sidebar selection writes through to it.
- New sessions start untitled and auto-title from the first user turn (truncated to ~40 chars). Title is rewritable later.
- `lastUsedAt` is bumped on every save; the sidebar lists sessions sorted by it descending.
- `migrateLegacy()` runs once on first launch after upgrade: if the legacy `chat-history.json` exists, fold its turns into a new "Earlier chat" session and delete the legacy file. Idempotent — empty / missing legacy → no-op.
- Corrupt files are renamed `.corrupt-<unix-ts>` on decode failure and skipped, mirroring `ChatHistoryStore`'s defensive pattern.

## Consequences

- **Positive:** bounded per-file size — only the touched session's file is rewritten on each turn.
- **Positive:** delete / rename / quarantine each work in O(1) without touching neighbouring sessions.
- **Positive:** `migrateLegacy` keeps the upgrade path lossless — no user complains "where did my old chat go".
- **Positive:** test-friendly storage (per-file IO, no in-memory hot index) — though see ADR 0013-followup note about adding a baseDir override hook for ChatSessionStoreTests.
- **Negative:** directory enumeration is O(sessions) — fine up to a few hundred, but we'll need a metadata-only index file once anyone crosses that.
- **Negative:** no global "wipe everything except this one" command — Sign Out clears the whole directory via `clear()`.
