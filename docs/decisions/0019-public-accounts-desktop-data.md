---
title: "0019. Public accounts in the cloud, user data on the user's desktop"
status: superseded
superseded_by: "0020"
date: 2026-11-05
amends: "0018 (decisions 3 and 5; the relay's one-organisation scope)"
---

# ADR 0019: Public accounts in the cloud, user data on the user's desktop

**Status:** Superseded by [ADR 0020](0020-box-encrypted-sync.md) on 2026-11-05 (retired in sync SP8, 2026-11-06). The desktop needs no account; phones and browsers reach desktop data through encrypted sync in the user's own storage. The account service and relay code stay in the repository as parked code and refuse to start in production.

_Originally:_ Proposed (design approved by the user in brainstorming, 2026-11-05).
**Date:** 2026-11-05

## Context

[ADR 0018](0018-tauri-desktop-node-core-relay.md) makes the desktop the main worker and
adds a relay for the phone and extension. It assumes one organisation: the desktop
"holds the company LLM API key" (decision 3), "one company API key with per-user caps"
pays for AI (decision 5), and the [relay design](../superpowers/plans/2026-10-31-relay-design.md)
lists "no multi-tenant SaaS: the relay serves one organisation's devices" as a non-goal.
Its open question X1 asks how a user logs in to the relay account at all; the proposal
was "no password at the relay, the account is created by the desktop".

The user now wants anyone to be able to create an account at llm-ide.com. Meanwhile the
VPS proxied `https://llm-ide.com/api/*` to a full core in which every user is an admin
(`extension/server.mjs` warns: "since every user is an admin, run agents, MCP stdio
commands and plugin installs"), which was closed on 2026-11-05 (commit `35d43f2b`). The
local core's login (`extension/server/users.mjs`, `extension/server/jwt.mjs`) was built
for one trusted machine and cannot become a public identity service.

## Decision

1. **Public accounts.** A new top-level `account-service/` (its own Node service, SQLite
   database and unprivileged system user; it never imports `extension/` and contains no
   AI, agent or plugin code) runs identity, profile, devices and the relay at llm-ide.com.
   Anyone may sign up once sign-up is opened after the external review (relay D9).
2. **The data stays on the user's desktop.** The cloud stores email, display name,
   language, time zone, the device list, sign-in settings, and E2E ciphertext. The
   project list travels encrypted. Meetings, code and chats never leave the desktop.
3. **The user's own AI credentials.** AI runs on the desktop with the user's own Claude
   login or API key (ADR 0015 vault). The service makes no model call and has no AI bill.
4. **Sign-in is email plus passkey.** Email is verified by a single-use 15-minute link
   (hash stored); after setup, sign-in is passkey only; the email link is the
   lost-passkey fallback and signs out every other session.
5. **Access to data needs the desktop.** A device that signed in is only _pending_; the
   desktop approves it after the user compares a 6-digit code computed over both sides'
   keys with a commitment, then sends a signed, tier-limited key wrap through the relay.
   One desktop per account in v1; replacing it needs a fresh passkey check and unlinks
   every device.
6. **The desktop signs in with OAuth 2.0 Authorization Code + PKCE** in the system
   browser, returning through a random loopback callback (`llmide://` is a fallback), and
   keeps one outbound relay connection. The SSH tunnel and the public `/api/` path are
   removed. Host API v1 commands travel inside relay envelopes.
7. **The PWA delegates passkeys to the accounts origin and uses a same-origin BFF.**
   A passkey has the RP ID `accounts.llm-ide.com`; it cannot be used on
   `app.llm-ide.com`. The PWA opens the account sign-in page, and an app-origin BFF
   exchanges the code and keeps the refresh token in an `HttpOnly` cookie. The accounts
   API sends no CORS headers.

Full design: [accounts and device linking](../superpowers/specs/2026-11-05-accounts-and-device-linking-design.md).

## Amendments to earlier decisions

| Earlier text | Change |
|---|---|
| ADR 0018 decision 3, "holds the company LLM API key" | The desktop holds **the user's own** Claude login or API key. |
| ADR 0018 decision 5, "one company API key with per-user caps" | Replaced: no shared key; each user pays their own provider. |
| Relay design non-goal "the relay serves one organisation's devices" | Replaced: the relay is **multi-tenant by account**. Per-user scoping (relay D8) already made every object per user; it now applies across unrelated people. |
| Relay open question X1 | **Answered:** a passkey account at the account service, plus desktop approval of every device. The E2E key design (relay sections 4.1 to 4.4 and 4.6 to 4.10) is unchanged. |
| Relay 4.5 QR enrollment | Phones and browsers link with passkey sign-in and the commitment-based 6-digit code instead of a QR secret; the desktop still enforces single use and holds the authoritative registry. |
| Relay D4 printed revoke code | Account holders revoke from the web with a fresh passkey check; the desktop still rotates before its next publish. |
| Relay D6 hosting | The account service and relay run on the existing VPS; the PWA keeps a separate origin and hosting account (D1). |

## Why this is not MASTER-PLAN Q-WEB-1 option C

Option C, "a full hosted web client with its own login and data", was rejected because it
breaks the one-copy rule, the loopback-only core and "no data access" in the cloud. This
decision adds a login in the cloud but **no data**: the service keeps identity rows and
ciphertext, cannot read what it relays, and every answer comes from the desktop. The web
client is still option A, the tiered relay PWA. The core stays bound to `127.0.0.1`
(ADR 0004).

## Consequences

- **Positive:** anyone can use LLM-IDE from a phone or browser without exposing the core;
  a server breach yields email addresses and device labels, not data or credentials.
- **Positive:** no AI cost or AI-key custody for the operator.
- **Positive:** the most dangerous deployment (a public full core) is gone for good.
- **Negative:** the operator now runs a public identity service: mail deliverability,
  abuse handling, terms, privacy policy, data export and deletion, breach procedures.
- **Negative:** with the desktop off, a device can only read the last snapshot and queue
  low-risk requests (relay D1, D2); losing the desktop means re-linking every device.
- **Negative:** one more deployable with its own CI, release and security review.
- **Gate:** public sign-up stays closed until the external review (relay D9) and the legal
  launch gates in the design's section 8 are complete.
