---
title: "0022. Project-scoped team roles"
status: accepted
date: 2026-11-08
amends: "0021 (adds per-project grants beside the team grant; H1.2 stays the floor)"
---

# ADR 0022: Project-scoped team roles

**Status:** Accepted (user decisions 2026-11-08).
**Builds on:** [ADR 0021](0021-team-hub.md) H1 (team roles), H1.1 (`team.yaml`), H1.2 (every route
within its role). API 126; migration 0070.

## Context

H1.2 gives every account one team role. A team member (`member`, the engineer) can do all work in the
install, including every project folder. The user wants the same four roles **per project**, so an
engineer can be a full member of one project and only read/Ask on another, while team owners/admins
retain team management and can override any project. The role and permission model must be identical
on desktop, web and iPhone.

## Decision

1. **A project is a first-class registry row.** `projects(id, name, root, created_by, created_at,
   updated_at)`; the id is the stable client-derived project id already used by
   `POST /kb/projects/register` / Doc Gen. Registering a project also creates/updates this row. A NEW
   project gives its registering creator `owner`/`execute`/no-cap membership.
2. **`project_members(user_id, project_id, role, max_mode, usd_cap_month, granted_by, updated_at)`** is
   the per-project grant, with the same role order `viewer < member < admin < owner` and the same
   `max_mode` / monthly USD cap vocabulary as `members`.
3. **No row is a viewer.** A team member with no project row can read and Ask on that project, nothing
   more.
4. **Global override, never a weakening of H1.2.** A global team `owner`/`admin` keeps the team grant on
   every project and manages any project. A global team `viewer` stays a viewer even if a project row
   names them higher. A global `member` uses the project row, or the implicit viewer default.
5. **Effective authority is computed once** (`kb/projects.mjs` `computeProjectGrant`): the project role,
   the tighter of the global/project `max_mode`, and the tighter positive USD cap. Every HTTP route,
   chat turn and Host API frame reads that grant at action time; a demotion applies on the next request
   or frame.
6. **Project admin is project membership management, not team admin.** `CLASS_GRANTS` gains
   `project.admin`; it is not the team `admin` class. Project admins manage their project's members;
   `/admin/*` stays with the team owner/admin.
7. **API 126** adds `GET /projects`, project membership CRUD, `projects` on `/auth/me`, and `projects.list`
   plus an optional `projectId` on project-scoped Host API frames. Every new field/command is additive;
   a frame without `projectId` keeps the v1 team behavior so existing pairings keep working.
8. **`team.yaml` carries an optional `projects:` section** (project id → email → role/mode/cap). A file
   without the section leaves project rows alone (upgrade-safe); once present it is authoritative, and
   every API membership change writes it through atomically. Invalid YAML/roles/caps/project ids fail
   the boot closed, as H1.1 already does for `members:`.
9. **A project USD cap sums that project's month**, using the new nullable
   `usage_ledger.project_id`; rows from before the migration, and turns with no project, stay NULL and
   never count against a project cap.

## Consequences

- A solo install is unchanged: its owner is the project owner of every project they register.
- A team engineer opening a new project becomes its project owner; other engineers must be assigned.
- The desktop, web and phone share the role vocabulary and the same server enforcement; the UI only
  hides what the server would refuse.
- Project invites are not a separate token type in this pass: a team invite creates the account, then a
  project admin adds the new member to the project. This is the documented follow-up.
- The project registry is team-wide (one install, one list). The folder path in `projects.root` is only
  used to inherit a project from a desktop workspace; Doc Gen's per-user folder resolution is unchanged.
