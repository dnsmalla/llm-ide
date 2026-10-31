---
title: "0018. Tauri desktop shell over the Node core, with a relay for phone and extension"
status: accepted (conditional, Phase 3 start)
date: 2026-10-24
---

# ADR 0018: Tauri desktop shell over the Node core, with a relay for phone and extension

**Status:** Accepted for the Phase 3 start, conditional (decided by the user,
2026-10-31). It was Proposed (future direction) from 2026-10-24. The condition: the
open Phase 0 measurements (a user-run autobench with the window frontmost; one Windows
run with graph >= 30 fps, sidecar start/quit and installer size; an Accessibility grant
to measure caption cadence) are recorded **before Phase 3 exits**, not before it
starts. If the Windows run fails the gate, work pauses and the plan is revisited. This
is acceptance to begin the Phase 3 screens, not a statement that the Phase 0 gate has
passed: those measurements are still open. See the
[Phase 3 plan](../superpowers/plans/2026-10-31-tauri-phase3-plan.md).
**Date:** 2026-10-24

## Context

About 159k lines of the product are SwiftUI and run only on macOS; the portable parts
(Node server ~50k lines, React UI ~10k lines) are much smaller. The phone reaches the
system only through a WebSocket server inside the Mac app, and the Chrome extension's
server is a child process the Mac app kills on quit, so when the Mac app is off,
nothing else works. Engineers on Windows and Linux cannot use the product at all.

## Decision

1. **Business logic lives in the Node core (TypeScript).** Logic now in Swift (chat
   session state, Library ingest, Issues, Loop, Auto Tasks) moves there.
2. **The desktop app becomes a Tauri 2 app:** React + TypeScript UI, a Rust shell used
   only for platform access and performance-critical work, and the Node core as a
   sidecar. It ships for macOS, Windows and Linux.
3. **The desktop is the main worker.** It holds the company LLM API key and runs all
   LLM calls and code execution.
4. **A small relay** (TypeScript, always on) stores end-to-end-encrypted snapshots and
   an inbox of requests. The phone (a PWA served by the relay) and the extension read
   snapshots and queue requests while the desktop is off. The relay makes no LLM calls
   and runs no code.
5. **One company API key** with per-user caps replaces any notion of sharing a personal
   Claude subscription.

Adoption is gated on a Phase 0 proof of concept with measured go/no-go criteria; see
the [plan](../superpowers/plans/2026-10-24-tauri-desktop-and-relay.md).

## Consequences

- **Positive:** one desktop codebase for three operating systems; one implementation
  of business logic for every client; phone and extension keep working (read + queue)
  without the desktop; the cleartext `:3006` phone link and PIN pairing go away.
- **Positive:** the server stays loopback-bound (ADR 0004); only the relay is public,
  and it holds no plaintext.
- **Negative:** a 9–12 month migration with two desktop apps during the overlap.
- **Negative:** API-key billing replaces personal subscriptions for shared use.
- **Negative:** Linux webview graphics and per-OS accessibility capture are weaker
  than macOS; Linux capture is best-effort.
- **Supersedes:** the Swift-hosted Mobile Control gateway, once the relay reaches parity.
