# Assign team roles per project

Team Hub roles (`owner > admin > member > viewer`) can be scoped to a project. The decision and
rationale are in [ADR 0021](../decisions/0021-team-hub.md) (amendment H1.3); the wire contract is
API 126 in [api-server](../spec/api-server.md).

## What a project role means

| Project role | On that project |
|---|---|
| `viewer` (also the default when there is no row) | read + Ask only; no file, command, install or connector work |
| `member` (engineer) | asks with tools; reads/writes project files, runs commands, installs |
| `admin` | `member`, plus manages that project's members |
| `owner` | `admin`, plus can grant/change the project owner |

Two global rules always win:

- A **team owner/admin** overrides every project: they can manage any project and use the team grant.
- A **team viewer** never rises above viewer because of a project row. H1.2 is not weakened.
- A team **member/engineer with no project row is a viewer** on that project.

`max_mode` and `usd_cap_month` on the project row narrow the global grant; the tighter value wins.

## Desktop

1. Open **Settings → Team**. Pick a project in the **Project** picker.
2. A project owner/admin sees the project members and can add an existing team member by email,
   change their role/mode/monthly cap, or remove them (removal means the implicit viewer default).
3. A project admin only manages that project; team-wide members and invites stay with the team
   owner/admin.

Registering a project for the first time (creating/opening it) makes the registering engineer the
project's owner, so the person who opens a project can manage it.

## API

All routes need the normal JWT. Membership reads/writes need project admin (or a global team
admin/owner).

```bash
# Every project the caller can see, with their effective role
curl -s http://127.0.0.1:3456/projects -H "Authorization: Bearer $TOKEN"
# -> { "projects": [{ "id": "p…", "name": "Alpha", "role": "member",
#                     "maxMode": "execute", "usdCapMonth": 20,
#                     "permissions": ["self.read", "self.write", "model.ask", …] }] }

# Project members (project admin)
curl -s http://127.0.0.1:3456/projects/p-123/members -H "Authorization: Bearer $TOKEN"

# Add an existing team member, then change the grant
curl -sX POST http://127.0.0.1:3456/projects/p-123/members \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"email":"eng@example.com","role":"member","maxMode":"execute","usdCapMonth":20}'
curl -sX PATCH http://127.0.0.1:3456/projects/p-123/members/<userId> \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"role":"admin"}'

# Remove: the member becomes an implicit viewer again
curl -sX DELETE http://127.0.0.1:3456/projects/p-123/members/<userId> \
  -H "Authorization: Bearer $TOKEN"
```

`GET /auth/me` also carries `projects` with the same shape, so a client can gate its UI without a
second call. `POST /kb/projects/register { id, root, name? }` creates/updates the canonical project
row (and the registering creator's owner membership on a new project).

Every membership change is audited (`project.member.grant` / `project.member.revoke`) and written
through to `team.yaml` (below) before the request answers. A failed file write rolls the change back.

## team.yaml

The same auditable file that lists team assignments can list project assignments. The `members:`
section is unchanged; add an optional `projects:` section:

```yaml
members:
  owner@example.com:
    role: owner
    max_mode: execute
    usd_cap_month: 0
  eng@example.com:
    role: member
    max_mode: execute
    usd_cap_month: 20

projects:
  p-123:
    owner@example.com:
      role: owner
      max_mode: execute
      usd_cap_month: 0
    eng@example.com:
      role: admin
      max_mode: execute
      usd_cap_month: 5
```

- An account **not listed under a project** is a viewer on that project.
- The project id must be a registered project; an unknown id is ignored and audited, never created.
- A file **without** a `projects:` section (an older team.yaml) leaves the project rows alone. The
  first API membership change writes the section, and from then on it is authoritative.
- Start the core after editing the file. Invalid YAML, an unknown role/mode, an invalid cap, a
  duplicate project/email or bad indentation fails the boot closed.

## Host API / phone / web

`projects.list` returns the paired device's projects and effective roles. A project-scoped frame
(`chat.send`, `chat.new`, `chat.snapshot`, `chat.sessions`, `chat.history`, `chat.history.clear`,
`chat.cancel`, `chat.options`, `approvals.answer`, `toolApprovals.answer`) may carry `projectId`; the
host re-checks the fresh project grant on every frame. An unassigned device is a viewer on that project
(Ask only). A frame without `projectId` keeps the legacy/global chat, so existing pairings keep working.
The web app calls `projects.list` on connect, shows each project with your role, remembers the picker
choice in browser storage, and sends `projectId` on every project-scoped frame, including the History
list (`chat.sessions`) and one chat's history (`chat.history`).

Each project has its own chat history. `chat.new` starts a fresh chat in the selected project; the
project's list never shows another project's chats, and `chat.history` for a chat from another project is
refused (`denied` with `PROJECT_MISMATCH`, the frame's 403 class). On a hub every project-scoped frame
must name a project (`PROJECT_REQUIRED`). See [chat history per project](project-chat-history.md).
