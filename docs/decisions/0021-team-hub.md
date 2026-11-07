---
title: "0021. Team Hub: the core in hub mode, members by assigned authority"
status: accepted
date: 2026-11-07
amends: "0020 (adds the team path beside sync; sync stays for solo users); 0018 decision 5 (company key) confirmed"
---

# ADR 0021: Team Hub, the core in hub mode, members by assigned authority

**Status:** Accepted. The user approved the five decisions "as recommended" on 2026-11-07.
**Review and plan:** [team hub plan](../superpowers/plans/2026-11-07-team-hub-plan.md).

## Context

After the Mac app's removal, online access dropped (plan §1): every Host API surface is off by default, a
non-loopback peer is refused without TLS, the VPS answers 404 on `/host-api/*`, and with the desktop off only a
read-only sync snapshot remains. The core cannot be exposed to more than one person because the `role` column
and JWT claim are not enforced (`requireAdmin` only checks "logged in"; product decision 2026-08-20). The user
wants the LLM usable from every platform by every group member, each within an assigned authority.

## Decision

1. **The hub is the existing Node core started in hub mode** (`LLMIDE_HUB=1`), on the user's VPS first (D1).
   No new service. Hub mode implies remote bind behind TLS, registration closed, invite only.
2. **Members and authority live in the core and are enforced in one place.** Team roles
   `owner > admin > member > viewer` in a `members` table beside `users` (the `users.role` CHECK stays untouched).
   Per-member grants: highest run mode (`none`, `read_only`, `execute`; `bypass` never remote), monthly USD cap,
   later project grants and features. `requireRole` replaces the empty `requireAdmin`; a turn is clamped to the
   member's `max_mode`; Host API capabilities at pairing derive from the member's grants.
3. **Invite only.** An admin mints a single-use 24-hour invite carrying the new member's role and grants; the
   invitee registers with it even while registration is closed. No public sign-up (ADR 0020's reasons stand).
4. **One company API key in the hub vault with per-member caps** runs team turns (D2; ADR 0018 decision 5,
   UN-051). A member may still use their own vaulted key (ADR 0015).
5. **New member defaults:** `member`, `read_only`, 20 USD/month, no projects until granted (D3).
6. **`execute` only from a desktop connected to the hub**; phones and browsers stay read-only in v1 (D4).
7. **ADR 0020 sync stays** for solo users without a server; a hub member does not need it (D5).

## Consequences

- A solo install changes nothing: its single user becomes `owner` with `execute`.
- The hub is private infrastructure of one team; public invite links wait for the external review (UN-075).
- Phases H1–H6 in the plan; H1 (authority in the core) is `plans/2026-11-07-team-hub-h1-authority.md`.
