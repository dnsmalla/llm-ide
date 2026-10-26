---
title: API overview
---

# API overview

> Hand-written narrative tour of the API. For per-endpoint detail with schemas, see the [generated reference](index.md) (rendered from `openapi.yaml`).

Human-readable summary of the LLM-IDE server API. For the machine-readable spec see [`openapi.yaml`](openapi.yaml).

- **Base URL** — `http://127.0.0.1:3456`
- **Auth** — `Authorization: Bearer <access_token>` for everything except the public routes below
- **Versioning** — `SERVER_API_VERSION` reported by `GET /health`; the client compares against its `REQUIRED_ENDPOINTS` allowlist and surfaces a "restart server" banner on mismatch. The bump rule is in `schema/http/SCHEMA.md`.
- **Error envelope** — `{ "error": { "code": "...", "message": "...", "details": {} } }`
- **Feature set** — `LLMIDE_FEATURES` (comma-separated enabled feature keys, the Mac app's build features; unset/empty = all) prunes feature-owned route groups. See [Feature-pruned routes](#feature-pruned-routes)

## Error codes

| Code | Meaning |
|---|---|
| `AUTH_REQUIRED` | Missing or invalid bearer token |
| `FORBIDDEN` | Authenticated but the resource isn't yours |
| `NOT_FOUND` | No such resource |
| `VALIDATION_FAILED` | Request body failed schema or range checks |
| `GUARDRAIL_FAILED` | Reserved — not currently emitted by the server |
| `RATE_LIMITED` | Token bucket exhausted — see `Retry-After` header |
| `UPSTREAM_ERROR` | Claude CLI, GitHub, or another upstream failed (emitted via raw `sendJSON` — not an AppError) |
| `INTERNAL_ERROR` | Unhandled — check server logs with `LLMIDE_LOG_LEVEL=debug` |

## Public routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Status, schema version, uptime, endpoint list, enabled `features` |
| `GET` | `/launch-app` | Deep link into the macOS app |
| `POST` | `/auth/register` | Create an account |
| `POST` | `/auth/login` | Exchange password for access + refresh tokens |
| `POST` | `/auth/refresh` | Rotate refresh token, mint new access token |
| `POST` | `/auth/logout` | Revoke refresh token |
| `POST` | `/kb/agent/bot-relay` | Caption relay from a self-hosted bot (signed) |

## Authenticated routes

### Account

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/me` | Current user profile |
| `POST` | `/auth/me/password` | Change password |
| `POST` | `/auth/me/secrets` | Set/delete a vault entry (allow-listed keys only) |
| `POST` | `/auth/me/audit` | Read your own audit log |
| `POST` | `/auth/me/repos` | Manage local-repo allowlist for code-sync / PR generation |

### AI

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/generate-notes` | Structured meeting notes (language-aware) |
| `POST` | `/generate-docx` | DOCX export with the bundled template |
| `POST` | `/generate-questions` | Localised follow-up questions |
| `POST` | `/chat` | Free-form chat grounded in the transcript |
| `POST` | `/extract-entities` | Action / decision / blocker extraction |

### Knowledge base

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/ingest` | Add a meeting and its entities |
| `POST` | `/kb/delete` | Delete by id |
| `GET` | `/kb/search?q=…` | Unified search across all KB types |
| `GET` | `/kb/meeting/:id` | Full meeting + entities |
| `GET` | `/kb/stats` | Counts by table |

### Connectors

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/connect-git` | Index a local repo into `sources` |
| `POST` | `/kb/connect-github-issues` | Pull issues from GitHub into `sources` |
| `POST` | `/kb/connect-tickets-json` | Bulk import tickets from JSON |
| `POST` | `/kb/connect-qa` | Index QA pairs |

### Planning

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/generate-plan` | KB-grounded plan from a meeting or query |
| `POST` | `/kb/analyze-risks` | Annotate plan tasks with risk scores |
| `POST` | `/kb/code-sync` | FTS5 lookup of touched files per task |
| `GET` | `/kb/plans` | List saved plans |

### Action

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/dispatch` | Send a task to GitHub / Backlog / Linear / Slack |
| `POST` | `/kb/generate-code` | Generate a code change for a task (queued for review) |

### Review

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/review/submit` | Add an item to the review queue |
| `POST` | `/kb/review/list` | List queue, optionally filtered |
| `POST` | `/kb/review/approve` | Approve and dispatch |
| `POST` | `/kb/review/reject` | Reject with a reason |
| `POST` | `/kb/review/delete` | Drop an item |

Notes (API v75+):

- `POST /kb/review/approve` accepts optional `config` (target credentials: `token` / `apiKey`) and `pr` (`ghToken`) objects. Precedence: approve body, then credentials held in memory from submit, then the per-user vault (`github.token`, `backlog.apiKey`, `linear.apiKey`). Credentials are never persisted and all `/kb/review/*` responses redact `token` / `apiKey` / `secret` / `password` leaves from `payload`.
- `422 CREDENTIAL_REQUIRED` — the only failing guardrail is the missing credential. The item stays `pending`; retry with `config` / `pr` or save the credential to the vault. Any other guardrail failure is `422 GUARDRAILS_FAILED` and auto-rejects the item.
- `409 REVIEW_CONFIG_MISMATCH` (also on `POST /kb/dispatch`) — the request `config` names a destination different from the approved review's.

### Outcomes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/outcomes/refresh` | Trigger an outcome poll |
| `GET` | `/kb/outcomes/task/:id` | Outcomes for one task |
| `GET` | `/kb/outcomes/stats` | Aggregate outcome stats |

### Live session

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/live/<id>/append` | Append a finalised utterance |
| `POST` | `/kb/live/<id>/finalize` | Close the live session |
| `GET` | `/kb/live/<id>` | Read current state |

### Meeting agent

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/kb/agent/dispatch` | Start the agent against a session |
| `POST` | `/kb/agent/stop` | Stop a running agent |
| `GET` | `/kb/agent/runs` | List agent runs |
| `GET` | `/kb/agent/diagnose` | Layered status check for the side panel |
| `POST` | `/kb/agent/feedback` | 👍 / 👎 / 💤 verdict on an agent question |
| `GET` | `/kb/agent/feedback/stats` | Aggregate feedback |
| `GET` | `/kb/agent/persona` | Read persona prompt |
| `PUT` | `/kb/agent/persona` | Update persona prompt |

## Feature-pruned routes

The macOS app can be built without some features and starts its server with the same list in `LLMIDE_FEATURES` (for example `agent_chat,file_explorer,terminal`). The server then never imports a disabled feature's route module, and that module's paths answer:

```json
{ "error": "feature_disabled", "feature": "auto_tasks" }
```

with status `404`. The body is deliberately not the usual error envelope, so a client can tell a disabled feature from an unknown route.

| Feature key | Paths |
|---|---|
| `auto_tasks` | `/kb/loop/*` (`/kb/loop/agent-run`) |
| `gantt_issues` | `/kb/issue-schedule` |
| `code_graph_3d` | `/kb/ingest-code-graph` |

`GET /health` reports the applied set as `features` (`null` = every feature, otherwise the sorted enabled keys) and leaves the disabled paths out of `endpoints`. The Chrome extension's `REQUIRED_ENDPOINTS` are all always-on, so any feature set satisfies it. `doc_gen` prunes nothing on the server: the Chrome extension also calls `/generate-doc` and `/generate-docx`. Unknown keys are ignored with one warning line. `code_graph_3d`, `gantt_issues` and `doc_gen` are dropped when `file_explorer` is not enabled, the same rule `mac/Package.swift` applies.

## Rate limits

Profiles are tuned per workload. Defaults:

| Profile | Routes | Limit |
|---|---|---|
| `llmHeavy` | `/generate-*`, `/chat` | 3 burst / 30 s |
| `dispatch` | `/kb/dispatch`, `/kb/review/approve` | 4 burst / 10 s |
| `outcomePoll` | `/kb/outcomes/refresh` | 1 / 30 s |
| `kbWrite` | `/kb/ingest`, `/kb/delete`, `/kb/live/*` | 20 / 10 s |
| `authPublic` | `/auth/register`, `/auth/login` | 5 / 60 s per IP |

`429` responses include `Retry-After` in seconds.

## Example: end-to-end ingest + notes

```bash
# 1. Login
TOKEN=$(curl -sX POST http://127.0.0.1:3456/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"…"}' | jq -r .accessToken)

# 2. Ingest a meeting
curl -sX POST http://127.0.0.1:3456/kb/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Sync","segments":[{"speaker":"Alice","text":"Ship by Friday"}]}'

# 3. Generate notes
curl -sX POST http://127.0.0.1:3456/generate-notes \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"transcript":"…","language":"en-US"}'
```
