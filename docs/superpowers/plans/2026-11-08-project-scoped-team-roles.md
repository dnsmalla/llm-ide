# Project-scoped team roles — implementation plan

**Status:** in progress. Builds on ADR 0021 (H1/H1.1/H1.2) and API 124 (route policy); API 125 is the
current server version, so this work bumps to **126**. Migration head is `0069`, so the new migration is
`0070`.

## User decisions

- Roles are **per project**. Global team `owner`/`admin` keep team management and override/manage every
  project.
- A team member with **no project role is a viewer** on that project: read/Ask only.
- The same roles and permissions apply on desktop, web and mobile.

## Model

`projects`: `id` (stable, the existing `projectIdFor(root)` id), `name`, `root` (canonical last registration),
`created_by`, `created_at`, `updated_at`.

`project_members`: `(user_id, project_id)` → `role` (`viewer < member < admin < owner`), `max_mode`,
`usd_cap_month`, `granted_by`, `updated_at`. No row = viewer.

`usage_ledger.project_id` (nullable) lets a project USD cap sum that project's spend without changing
older rows.

Effective project authority (pure, one place — `kb/projects.mjs`):

- global team role `owner`/`admin` → that role on every project (override; global grants/mode/cap apply);
- global `viewer` → viewer (H1.2 is never weakened by a project row);
- global `member` → the project row's role, or viewer when there is no row;
- `max_mode` is the tighter of the global and project modes (unassigned → `read_only`);
- the USD cap is the tighter positive global/project cap, checked against the matching spend.

`CLASS_GRANTS` gains `project.admin` (project membership management). All other classes use the effective
project role/mode when a project id is in scope, and the global role otherwise. Global admins/owners pass
`project.admin` on every project.

## API (126)

- `POST /kb/projects/register` (existing, Doc Gen group) also creates/updates the canonical `projects` row
  and gives a creator who registers a **new** project `owner`/`execute`/no-cap membership. Re-registering an
  existing project needs project admin (or global admin/owner).
- `GET /projects` → `{ projects: [{ id, name, role, maxMode, permissions }] }` (self.read).
- `GET /projects/:id/members` → project + members (project.admin).
- `POST /projects/:id/members { email, role, maxMode, usdCapMonth }` (project.admin; adds an existing team
  member by email).
- `PATCH /projects/:id/members/:userId { role?, maxMode?, usdCapMonth? }` (project.admin).
- `DELETE /projects/:id/members/:userId` → `{ removed }` (project.admin; removes the row, returning that
  member to the implicit viewer default).
- `GET /auth/me` gains `projects` (same list shape). Existing `member` block is unchanged.
- Every membership change is audited (`project.member.grant`, `project.member.revoke`,
  `project.register`) with no email body/token.
- Project routes ride `kbWrite` for writes; reads are `self.read` / `project.admin`.

## Enforcement

- `server/route-authority.mjs` resolves a project id from `?project=`/`?projectId=` or `/projects/:id/...`
  and checks the project-effective authority for the route's class. A route with no project id keeps the
  team check. The register route is body-addressed, so its project gate lives in the handler.
- `routes/agent-v2.mjs` resolves `body.projectId` (or `agentContext.projectId`) and uses the same effective
  authority for the viewer clamp, `max_mode`, and the USD cap; every ledger row of a project turn carries
  `project_id`. No project id keeps today's team behavior.
- `routes/host-api/gateway.mjs` adds `projects.list` and an optional `projectId` on the project-scoped
  commands (`chat.send`, `chat.new`, `chat.snapshot`, `chat.history.clear`, `chat.cancel`, `chat.options`,
  `approvals.answer`, `toolApprovals.answer`). The project check runs on **every frame**, against the fresh
  `project_members` row; unassigned = viewer (Ask only). A frame with no `projectId` keeps the old,
  team-scoped behavior so existing pairings/clients do not break.
- Host API `projects.list` returns the same `{ id, name, role, maxMode, permissions }` shape.

## team.yaml

Extend the existing strict YAML with an optional top-level `projects:` section:

```yaml
projects:
  p1234:
    alice@example.com:
      role: admin
      max_mode: execute
      usd_cap_month: 0
```

- `members:` keeps its exact current meaning and file layout.
- A file **without** a `projects:` key keeps today's behavior (project rows untouched) so an existing
  team-level file survives the upgrade. Once a write-through writes `projects:` (after any API membership
  change or a project registration), the section is authoritative: an account not listed for a project has
  no row, hence viewer.
- Generation from the DB includes explicit project rows; invalid YAML, an invalid role/mode/cap, a duplicate
  project/email or bad indentation fails the boot closed, as today.
- Write-through (`PATCH /projects/...`, registration, invite consumption) rewrites `team.yaml` atomically
  after the DB transaction and rolls back on a file failure.
- Unknown project ids and unknown emails are ignored and audited; they never create rows.

## Desktop UI

- Settings → Team gains a **project picker** (`GET /projects`). The global member/invite panels stay
  owner/admin only. The selected project shows its role and, for a project admin/owner (or global
  admin/owner), its member list plus add/edit/remove. A non-admin sees their project role and the gate.
- Chat passes the open project's id to the session and to `/agent/v2/stream`; mode options are filtered by
  the effective project permissions (viewer: Ask only) and the server re-checks.

## Web / iPhone

- Shared Host API schema (`schema/host-api/v1`) gains `projects.list` and optional `projectId`; regenerate
  `scripts/generate-host-api.mjs` outputs (Node, web types, Swift SharedProtocol).
- The web connection carries the selected project id on its project-scoped frames and shows the project's
  role. iOS decodes the new command and passes `projectId` through its existing chat path. Existing pairings
  keep working because every new field/command is additive.

## Tests

- `extension/tests/project-roles.test.mjs`: role matrix, unassigned viewer, per-project differences, global
  admin override, effective mode/cap.
- `extension/tests/project-routes.test.mjs`: register/list/membership CRUD, project-admin gate, audit,
  auth/me.projects, viewer denial.
- `extension/tests/team-yaml-projects.test.mjs`: parse/serialize, generation, boot application, invalid file
  fails closed, write-through.
- `extension/tests/agent-v2-project-clamp.test.mjs`: project viewer Ask clamp, project `max_mode`, project
  USD cap, ledger `project_id`.
- `extension/tests/host-api-project.test.mjs`: `projects.list`, per-frame project check, unassigned viewer,
  project admin/engineer, no-project backward compatibility.
- `ui/screens/settings/tests/team-projects.test.mjs`: project picker/gates; chat mode filtering.
- Contract: `schema/http` project schema + fixtures, OpenAPI/api-types regeneration; migration test.
- `extension/tests/project-e2e.test.mjs`: real server, two accounts, per-project roles over HTTP.
- `make test` / `make regression` / `make test-shared-protocol`.

## Docs

- ADR 0021 amendment "H1.3 project-scoped roles".
- `docs/explanation/invariants.md`, `docs/spec/api-server.md` (new section), `docs/reference/api/overview.md`,
  `docs/how-to/team-yaml.md` (or the existing YAML how-to), `extension/CLAUDE.md`.

## Deliberate limits

- Project invites are not a new token type in this pass: a team invite still creates the account, and the
  project admin adds the new member to the project (or a global admin does both). If time allows, an optional
  `projectId` on `POST /admin/invites` is the follow-up.
- The web/iOS visual project picker is minimal; the wire contract and client pass-through land first.
- Project-scoped background jobs that never name a project keep the team grant (documented).
