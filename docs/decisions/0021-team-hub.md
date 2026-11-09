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

## Amendment: H1.1 auditable YAML assignments (2026-11-07)

The user decided that authority must be auditable and editable outside the DB, so H1.1 adds one file:

- **`<LLMIDE_DATA_DIR>/team.yaml`** (desktop: `~/Library/Application Support/llm-ide-desktop/core/team.yaml`;
  repo-kb fallback: beside `data.db`) lists **user assignments only**: `email → role, max_mode,
  usd_cap_month`. Role permissions stay in code.
- **An account not listed is a `viewer`** with `max_mode: read_only` and `usd_cap_month: 20`.
- **The first boot with a real account generates the file** from the current `members` rows, so an existing
  solo owner stays owner and every other existing account is listed with its current grants. A fresh install
  (only the synthetic `legacy` user) **defers** generation: an empty file would become authoritative at the
  next boot and demote the first registered owner. A boot never rewrites an existing file.
- **One application per boot**, after migrations and before serving. Every actual change is an `audit_log`
  row with actor `team.yaml` (from/to only, never message text).
- **Write-through (R-013#2)**: because the file is authoritative, an admin grant or an invited member's
  grant would otherwise be reset by the next restart. `PATCH /admin/members` and an invited registration
  therefore rewrite the file atomically (0600, same generation path) after their DB transaction, from the
  current `members` rows. A failed write answers 500 and rolls the grant / registration back, so a completed
  request never leaves the DB and file disagreeing. Entries for emails with no account and the file's
  full-line comments are preserved; the DB wins for an account it lists. An edit made to the file while the
  core runs is replaced by the next API grant change (it applies at the next boot). Write events are
  audited as `team.yaml.write` with actor `team.yaml`; the file itself is never read on a request path.
- **Invalid YAML, an unknown role or an invalid grant fails closed**: the boot is refused with
  `team_yaml_invalid`, so the core never serves with stale or widened grants. Unknown emails are ignored and
  audited; they never create accounts.
- A strict, dependency-free YAML subset parser/serializer is `extension/kb/team-yaml.mjs`; the boot adapter is
  `extension/server/team-boot.mjs`. Enforcement is unchanged: `requireRole`, the turn clamp and the Host API
  gateway filter still read `members`.

## Consequences

- A solo install changes nothing: its single user becomes `owner` with `execute`.
- The hub is private infrastructure of one team; public invite links wait for the external review (UN-075).
- Phases H1–H6 in the plan; H1 (authority in the core) is `plans/2026-11-07-team-hub-h1-authority.md`.

## Amendment: H1.2 — every route within its role (2026-11-08)

**User decision:** "Admin and engineers need all, but others only ask." Mapped onto the ADR 0021 roles:

- **owner, admin, member (= engineer):** every work class — model with tools, files, connectors, pushes,
  installing plugins / MCP servers / extensions / the skills kit. The `member` role id stays; UI copy may
  call it "Engineer".
- **viewer (everyone else):** only Ask — a chat turn forced to the read-only `ask` mode (no edit or command
  tools), within the USD cap, plus their own data. No one-shot model routes, files, connectors or installs.
- **admin and owner only:** team and install management — members, invites, deleting users, backups,
  `metrics`.
- `max_mode` still narrows a member: `read_only` keeps tools off, `none` refuses every model action.

### Classes

One table, `CLASS_GRANTS` in `extension/kb/members.mjs`; one route table, `ROUTE_POLICY` in
`extension/server/route-authority.mjs`. A route, a Host API command or a background job names its class;
nothing else decides who may do what. `cap` = the member's monthly USD cap is checked (`0` = no cap).

| class | min role | min `max_mode` | USD cap checked | used for |
|---|---|---|---|---|
| `public` | — | — | — | pre-auth paths (health, login, register, OAuth callbacks) |
| `self.read` | viewer | none | no | reading the caller's own data |
| `self.write` | viewer | none | no | writing the caller's own data (notes, chats, settings, sessions) |
| `model.ask` | viewer | read_only | yes | Ask: a chat turn forced to the read-only `ask` mode; `/kb/agent/ask`; answering the agent's questions |
| `model.read` | member | read_only | yes | any other model call with no file-editing or command tools (one-shot notes, summaries, plans, classify) |
| `model.exec` | member | execute | yes | an agent that edits files or runs commands |
| `fs.read` | member | read_only | no | reading host files outside the DB (repos, project dirs, plugin dirs) |
| `fs.write` | member | execute | no | writing host files, or adding a path an agent may edit |
| `external.read` | member | read_only | no | fetching from a third-party service with the user's credentials |
| `external.write` | member | execute | no | pushing to a third-party service (GitHub/Linear/Backlog/Slack) |
| `install` | member | execute | no | enabling code that runs on the host (engineers — user decision) |
| `admin` | admin | none | no | team and install management: members, invites, deleting users, backups, metrics |
| `host` | viewer | none | no | desktop-only routes; the host proof is the real gate |

### Decisions D1–D5 (accepted as recommended)

- **D1** — a viewer may spend model tokens on Ask only (chat forced to `ask`, `/kb/agent/ask`, answering
  the agent's own questions), within the USD cap.
- **D2** — an authenticated request that matches no `ROUTE_POLICY` rule answers `404 NOT_FOUND` and logs
  `route_policy_unlisted` at error level with `{ method, path }` (no query string).
- **D3** — engineers enable code that runs on the host (`install` = member + execute); only team
  management (`/admin/*`, `/metrics`) stays admin.
- **D4** — host-proof routes (`/kb/sync/*`, `/kb/self-heal/*`, `/host-api/*`, `/bus` approvals,
  `/kb/issues/*`) are class `host` = any member row; the host proof stays the gate.
- **D5** — background work that moves only the user's own data or is system maintenance (sync scheduler,
  auth GC, backups, agent-store jobs) is not additionally gated.

**Rule:** a new route without a class is refused 404 and fails `extension/tests/route-policy-coverage.test.mjs`.
The Host API (`COMMAND_CLASS`) and the background jobs (bus executor, meeting agent, outcome poller)
re-check the class at the moment they act, so a demotion applies on the next frame or tick.

## Amendment: R-034 #1 / D1 — execute is owner/admin only on a hub (2026-11-09)

**User decision (D1, system re-review 2026-11-09):** on a hub, `execute` is a **team owner/admin** capability
only. Every other member is read-only (Ask) there, whatever their `members.max_mode` or project row says.
A local/solo install is unchanged.

Why now: an execute turn runs agent Bash as the core's own service user, and the core's `/proc/<pid>/environ`
held `LLMIDE_JWT_SECRET` and `LLMIDE_VAULT_KEY`. One Bash command could forge the owner's JWT and decrypt the
vault. The clamp is the fix; the unit also moves both secrets to systemd `LoadCredential=` files and adds
`ProtectProc=invisible` as defence in depth. Offering execute to hub members again requires running agent
commands under a separate OS user first.

- The clamp lives in `authorizeAction` (the route policy) and in the one turn clamp (`runV2Turn`, HTTP and
  Host API alike), both through `hubClampedMode` in `kb/members.mjs`; the effective project grant is clamped
  in `computeProjectGrant` too, so a UI/list reports the mode it will actually get.
- A **project** owner/admin who is only a team member is clamped as well: project management
  (`project.admin`) is not `execute`, and ADR 0022 says a project admin is not a team admin.
- `max_mode: none` still refuses turns; `read_only` still keeps tools off.
- Test: `extension/tests/hub-member-clamp.test.mjs` (engineer read-only, owner/admin execute, project owner
  read-only); `project-roles.test.mjs` pins local execute unchanged.
