# HTTP route inventory, extension/ Node core (for a per-route role policy)

Paths are relative to `/Users/dinsmallade/llm-ide/extension/`. Line numbers are the handler's match line at the time of the sweep.

## How auth works today (read this first)

1. `authenticate()` (server/auth.mjs:66, called server.mjs:819) requires a Bearer JWT for everything except PUBLIC_PATHS (server/auth.mjs:30-44). Token carries userId only; roles are read from the `members` table per request (`requireRole`, server/auth.mjs:89). Role order viewer(0) < member(1) < admin(2) < owner(3) (kb/members.mjs:12).
2. **ROUTE_AUTHORITY table** (server/route-authority.mjs:41-~129) is applied centrally AFTER the rate limiter for every URL (server.mjs:882) and before it for /auth/* and extension routes (server.mjs:831). Each entry = min role + maxMode (`read_only`/`execute`) + monthly USD cap. Cell shorthand used below: `AUTH(role,maxMode,cap)`. `max_mode none` members are denied by every table entry. Unlisted routes get JWT only.
3. Inline `requireRole(db, req, 'admin')` in server.mjs (backup, delete-user, metrics), routes/team-routes.mjs:90, routes/extension-routes.mjs (many).
4. Inline maxMode/USD clamp (not role) in `runV2Turn` (routes/agent-v2.mjs:498, clamp at 575-606), shared by POST /agent/v2/stream and the Host API chat.send.
5. Host proof (`verifyBusHostProof`, core/host-approval.mjs:52; HMAC derived from LLMIDE_HOST_APPROVAL_KEY; fails closed when the key is unset): /kb/sync/*, /kb/self-heal/*, /host-api/*, /kb/issues/{create,comment,close}. The command bus uses host proof only to believe a declared `x-llmide-client` class (routes/bus/client.mjs:41); without proof the class is capped at `extension`.
6. Default role of a self-registered user (server/auth-routes.mjs:~140-150): first user = `owner`; everyone else = `member`, `max_mode=execute`, no USD cap (solo mode). Hub mode (config.hub): `member`, `read_only`, 20 USD/month. Registration is open when `config.registrationOpen` (well-known tells). So in solo mode **every registered account already passes every AUTH(member,...) gate**; only `viewer` / `max_mode none` accounts (created via invite or admin PATCH) are held back.
7. Auth cell vocabulary: `none-public`, `jwt` (JWT only, no role), `jwt+AUTH(...)` (ROUTE_AUTHORITY), `jwt+requireRole(admin)` (admin or owner), `host-proof` (JWT + host proof), `other` (cited).

Effect cell: `primary (+secondary)`. Primary = strongest per the order public < read < write < model < fs < shell < external < admin < host. Counts in section (c) use the primary only.
All plain `model` rows use runClaude/runClaudeStream, which run the Claude CLI with `--tools ''` (no tools, providers/runtime.mjs:~598) or an HTTP API call; if the user has no vault key they **fall back to the operator's Claude CLI login** (providers/runtime.mjs:146-149, 574-600). Tool-capable turns are called out explicitly.

## (0) Dispatch order (server.mjs, request path)

OPTIONS -> authenticate (822) -> [/auth/* + extension routes: authority (831-832), handleAuth (833), handleExtensionRoute (845)] -> rateLimitProfile (server.mjs:856; function at 599-~710) -> enforceRouteAuthority (881-882, skipped when the feature is disabled) -> /bus/* (885) -> /admin/members|invites (891) -> /kb/sync/* (904) -> /kb/self-heal/* (911) -> /host-api/* (918) -> /kb/* and /agent/v2/* via handleKB (936; routes/router.mjs:123) -> GET / /health (947) -> /launch-app (978) -> POST /admin/backup (1059) -> DELETE /admin/users/ (1109) -> GET /metrics (1163) -> feature doc_gen / handleAIRoutes / handleExportRoutes (1188-1190) -> 404.
handleKB order (routes/router.mjs): doc_gen group (150), provider catalog (154), inline handlers (156-1618, interleaved with) code_graph_3d (615), planning (1341), gantt_issues (1348), live (1359), chat (1362), index (1366), lifecycle (1370), agent-history (1374), complete (1378), google (1382), calendar-ical (1386), os (1390), agent (1396), agent-v2 (1401), auto_tasks (1407), review (1518).

## (1) Route table

| method | path | module:line | auth today | effect | feature group | note |
|---|---|---|---|---|---|---|
| GET | / and /health | server.mjs:947 | none-public (auth.mjs:31-32) | public | - | Minimal liveness JSON; sets `x-llmide-nonce` (identity only). collectHealth runs a cached `claude --version` probe (server.mjs:~1276). Not in ALL_ENDPOINTS. |
| GET | /launch-app | server.mjs:978 | none-public (auth.mjs:43) | public | - | 302 to `llmide://<tab>`; tab allow-listed. Not in ALL_ENDPOINTS. |
| POST | /admin/backup | server.mjs:1059 | jwt+requireRole(admin) | admin | - | VACUUM INTO under config.backupDir (`?dir=` must be inside it), then prunes old backups (fs write+delete). Whole-DB copy includes every user's data. |
| DELETE | /admin/users/:userId | server.mjs:1109 | jwt+requireRole(admin) | admin | - | Cascade delete of another user's data. |
| GET | /metrics | server.mjs:1163 | jwt+requireRole(admin) | admin | - | Prometheus + global KB gauges. |
| POST | /generate-notes | server/ai-routes.mjs:89 | jwt+AUTH(member,read_only,cap) | model | - | One model call, no tools; SSE or JSON. Operator CLI fallback. |
| POST | /chat | server/ai-routes.mjs:197 | jwt | read | - | Removed: answers 410. Rate bucket llmFast. |
| POST | /agent-sdk/spike | server/ai-routes.mjs:210 | jwt | model | - | Agent SDK engine, allowedTools only `mcp__llmide__kb_search` (spike-engine.mjs:58); `allowAmbientAuth` defaults false so needs the user's/env key. NOT in ROUTE_AUTHORITY, no cap check. Temporary spike. |
| POST | /code-assist, /code-assist/decision | server/ai-routes.mjs:253 | jwt | read | - | Removed: answer 410 (rate llmFast on /code-assist). |
| POST | /generate-questions | server/ai-routes.mjs:259 | jwt+AUTH(member,read_only,cap) | model | - | No tools. |
| POST | /extract-entities | server/ai-routes.mjs:330 | jwt+AUTH(member,read_only,cap) | model | - | No tools. |
| POST | /generate-docx | server/export-routes.mjs:130 | jwt | model (+write) | - (always-on by design, feature-routes.mjs:8-11) | runClaude (2048 tokens, no tools) + persists a 'doc' source (ingestGeneratedDoc). **Not in ROUTE_AUTHORITY**: a viewer/none member can spend tokens, no USD-cap check. Rate llmFast. |
| POST | /generate-doc | routes/doc-gen.mjs:204 | jwt+AUTH(member,read_only,cap) | model | doc_gen | No tools. Dispatched at server.mjs:1189 (not via handleKB). 404 feature_disabled when off. |
| POST | /kb/ingest | routes/router.mjs:156 | jwt | write | - | Saves a meeting for the caller. |
| POST | /kb/providers/verify | routes/router.mjs:172 | jwt | external (+shell) | - | Live 1-token probe of a body-supplied or vault provider key (spends the user's provider tokens), or mode `cli`: checks the provider CLI binary (providers.mjs execFile). Custom base URL from body (SSRF-guarded). Rate llmFast. |
| GET | /kb/agent-sdk | routes/router.mjs:205 | jwt | external | - | SDK version status; fetches latest from npm (`?force=1`). Reveals active-turn counts. |
| POST | /kb/agent-sdk/update | routes/router.mjs:211 | jwt+AUTH(admin,execute) | admin (+shell,external) | - | `npm install` in the server's own checkout (llm_agent/sdk/updater.mjs:130 execFile + smoke run); replaces the SDK for all users. **Stale comment at router.mjs:212-213 says "every signed-in user may run it"; the table now requires admin, but the handler itself does not call enforceRouteAuthority, only the dispatcher (server.mjs:882) does.** |
| POST | /kb/providers/models | routes/router.mjs:223 | jwt | external (+shell) | - | `anthropic`: listSdkModels spawns the CLI via the SDK (llm_agent/sdk/models.mjs, ambient `claude login` when the user has no key); other providers: GET /models with the vault key. Rate llmFast. |
| POST | /kb/custom-providers | routes/router.mjs:265 (server/custom-providers.mjs) | jwt | write | - | Syncs the caller's custom provider registry (base URLs used for later model egress). |
| POST | /kb/routing-tiers | routes/router.mjs:271 (server/tier-routing.mjs) | jwt | write | - | Per-role tier routing config. |
| GET | /kb/routing-tiers | routes/router.mjs:278 | jwt | shell (+read) | - | May wait for a provider-CLI health probe (spawn). |
| DELETE, POST | /kb/delete | routes/router.mjs:283 | jwt | write | - | Deletes caller's meeting. |
| GET | /kb/search | routes/router.mjs:294 | jwt | read | - | |
| POST | /kb/repos/check-token | routes/router.mjs:328 | jwt | external | - | GET api.github.com/user or `<https base>/api/v4/user` with the vault token; GitLab base URL from body (https only, pinned fetch). Rate dispatch. |
| GET | /kb/issues | routes/router.mjs:379 | jwt | read | - | Always-on (chat grounding). |
| GET | /kb/meeting/:id | routes/router.mjs:431 | jwt | read | - | |
| GET | /kb/entity/:id | routes/router.mjs:454 | jwt | read | - | |
| GET | /kb/project/:id/export | routes/router.mjs:472 | jwt | read | - | |
| POST | /kb/project/install-skills | routes/router.mjs:498 | jwt+AUTH(admin,execute) | shell (+fs) | - | `spawnSync('bash', install.sh)` (kb/install-project-skills.mjs:166) writing into `body.path` (needs system/project.json). Also enforced inline at router.mjs:499. |
| GET | /kb/stats | routes/router.mjs:526 | jwt | read | - | |
| GET | /kb/system/status | routes/router.mjs:531 | jwt | read | - | |
| POST | /kb/connect-git | routes/router.mjs:563 | jwt | fs (+shell) | - | Indexes `body.path` which must be on the caller's repo allow-list; `git ls-files` execFile (connectors/git.mjs:102) and reads file contents into the KB. The allow-list is self-service (POST /auth/me/repos, member+execute), so a viewer can only index repos someone gave them. |
| POST | /kb/ingest-scip | routes/router.mjs:590 | jwt | shell (+fs) | - | `spawn('scip', ['print','--json', body.scipPath])` (connectors/scip-scanner.mjs:152): **scipPath is an arbitrary host path from the body, not contained**; only `repoPath` is allow-listed. No role check. |
| POST | /kb/ingest-code-graph | routes/code-graph.mjs:21 | jwt | write | code_graph_3d | Graph JSON from the Mac app; repoPath must be allow-listed; no fs access. |
| POST | /kb/connect-github-issues | routes/router.mjs:617 | jwt | external | - | Body token or vault github.token. |
| POST | /kb/connect-tickets-json | routes/router.mjs:639 | jwt | write | - | |
| POST | /kb/email/test | routes/router.mjs:659 | jwt | external | - | IMAP connect to a body-supplied host; typed password allowed. Rate dispatch. |
| POST | /kb/email/fetch | routes/router.mjs:659 | jwt | external | - | IMAP fetch, vault password. Rate dispatch. |
| POST | /kb/email/seen | routes/router.mjs:780 | jwt | write | - | Dedup ledger. |
| POST | /kb/email/classify | routes/router.mjs:1250 | jwt+AUTH(member,read_only,cap) | model | - | No tools. (table regex covers email/slack/box/mcp-connector classify) |
| POST | /kb/slack/test | routes/router.mjs:797 | jwt | external | - | Rate dispatch. |
| POST | /kb/slack/fetch | routes/router.mjs:797 | jwt | external | - | |
| GET | /kb/slack/conversations | routes/router.mjs:857 | jwt | external | - | Up to 20 Slack API calls. |
| POST | /kb/slack/seen | routes/router.mjs:871 | jwt | write | - | |
| POST | /kb/box/test | routes/router.mjs:890 | jwt | external | - | |
| POST | /kb/connect-box | routes/router.mjs:890 | jwt | external | - | Full Box crawl (up to ~2000 calls). |
| POST | /kb/mcp-connector/test | routes/router.mjs:946 | jwt | external | - | Opens a real session to a remote MCP server. |
| POST | /kb/mcp-connector/fetch | routes/router.mjs:946 | jwt | external | - | |
| POST | /kb/mcp-connector/seen | routes/router.mjs:946 | jwt | write | - | |
| POST | /kb/mcp-connector/classify | routes/router.mjs:946 | jwt+AUTH(member,read_only,cap) | model | - | No tools. |
| GET | /kb/activity | routes/router.mjs:1053 | jwt | read | - | |
| POST | /kb/activity/seen | routes/router.mjs:1063 | jwt | write | - | |
| POST | /kb/activity | routes/router.mjs:1070 | jwt | write | - | |
| GET | /kb/usage/limits | routes/router.mjs:1092 | jwt | read | - | |
| PUT | /kb/usage/limits | routes/router.mjs:1099 | jwt | write | - | The caller sets its own limits. Does NOT touch the members.usd_cap_month authority cap. |
| GET | /kb/usage/summary | routes/router.mjs:1114 | jwt | read | - | |
| GET | /kb/usage/resolve | routes/router.mjs:1121 | jwt | read | - | |
| GET | /kb/usage/ratelimits | routes/router.mjs:1133 | jwt | read | - | |
| GET | /kb/usage/turn-composition | routes/router.mjs:1142 | jwt | read | - | |
| POST | /kb/usage/record | routes/router.mjs:1148 | jwt | write | - | Client-reported usage rows into the caller's ledger. |
| POST | /kb/summarize | routes/router.mjs:1198 | jwt | model | - | runClaude, no tools, 3 min ceiling. **Not in ROUTE_AUTHORITY** (no role, no max_mode, no USD-cap check). Rate llm. |
| GET | /kb/export-all | routes/router.mjs:1296 | jwt | read | - | NDJSON stream of the caller's whole corpus. Rate kbExport. |
| POST | /kb/outcomes/refresh | routes/router.mjs:1411 | jwt | external | - | Polls GitHub/Linear/Backlog with vault creds or inline creds. Rate outcomePoll. |
| GET | /kb/outcomes/task/:id | routes/router.mjs:1443 | jwt | read | - | |
| GET | /kb/outcomes/stats | routes/router.mjs:1454 | jwt | read | - | |
| POST | /kb/outcomes/retry-failed | routes/router.mjs:1460 | jwt | external | - | `retryFailedDispatches` re-pushes previously failed dispatches to GitHub/Linear/Backlog with no review gate and no role check (the /kb/dispatch review gate is bypassed on this path). Not rate-limited. |
| POST | /kb/notify/slack | routes/router.mjs:1474 | jwt | external | - | Webhook URL from body or vault; posts to Slack. Rate dispatch. |
| POST | /kb/connect-qa | routes/router.mjs:1520 | jwt | write | - | JUnit XML into KB. |
| POST | /kb/conflict-questions | routes/router.mjs:1539 | jwt | model | - | runClaude no tools. **Not in ROUTE_AUTHORITY.** Rate llm. |
| POST | /kb/generate-plan | routes/planning.mjs:34 | jwt+AUTH(member,read_only,cap) | model (+write) | - | Planner + risk pass + saves plan. |
| POST | /kb/analyze-risks | routes/planning.mjs:60 | jwt+AUTH(member,read_only,cap) | model (+write) | - | Persists when planId given. |
| POST | /kb/code-sync | routes/planning.mjs:84 | jwt | write | - | Pure KB compute, no model; saves plan when planId given. Not in table. |
| GET | /kb/plans | routes/planning.mjs:107 | jwt | read | - | |
| GET | /kb/plan/:id | routes/planning.mjs:115 | jwt | read | - | |
| POST | /kb/plan/save | routes/planning.mjs:131 | jwt | write | - | No LLM. |
| DELETE, POST | /kb/plan/delete | routes/planning.mjs:154 | jwt | write | - | |
| PATCH, POST | /kb/plan-task/update | routes/planning.mjs:165 | jwt | write | - | Rate kbWrite. |
| POST | /kb/dispatch | routes/planning.mjs:182 | jwt+AUTH(member,execute) | external | - | Non-preview needs an approved dispatch review whose plan/target/tasks/destination are pinned (planning.mjs:195-270); `preview` needs no review. Pushes to GitHub/Linear/Backlog with vault creds. |
| POST | /kb/generate-code | routes/planning.mjs:324 | jwt+AUTH(member,read_only,cap) | model (+fs) | - | One model call, no tools; reads source files from allow-listed repos for context (agents/codegen.mjs:41). |
| POST | /kb/review/submit | routes/review.mjs:59 | jwt | write | - | Queues a guardrailed action (dispatch or codegen-apply). Credentials held in memory only. |
| GET | /kb/review/list | routes/review.mjs:93 | jwt | read | - | |
| GET | /kb/review/get/:id | routes/review.mjs:102 | jwt | read | - | |
| POST | /kb/review/reject | routes/review.mjs:110 | jwt | write | - | |
| POST | /kb/review/approve | routes/review.mjs:129 | jwt+AUTH(member,execute) | external (+fs,shell) | - | Executes the item: `dispatch` pushes to trackers; `codegen-apply` writes files under `<allow-listed repo>/.llmide-auto/<task>/` (agents/codegen-apply.mjs:69) and, with a GitHub repo+token, `git checkout -b / add / commit / push` + opens a PR (agents/github-pr.mjs:182-267). Guardrails re-run at approval. |
| DELETE, POST | /kb/review/delete | routes/review.mjs:265 | jwt | write | - | |
| GET | /kb/live/unacked | routes/live.mjs:37 | jwt | read | - | |
| POST | /kb/live/:id/ack | routes/live.mjs:45 | jwt | write | - | Rate kbWrite. |
| GET | /kb/live/:id/status | routes/live.mjs:66 | jwt | read | - | |
| GET | /kb/live/:id/capture | routes/live.mjs:74 | jwt | read | - | |
| POST | /kb/live/:id/append | routes/live.mjs:91 | jwt | write | - | In-memory caption buffer. |
| POST | /kb/live/:id/finalize | routes/live.mjs:112 | jwt | write | - | |
| GET | /kb/live/sessions | routes/live.mjs:136 | jwt | read | - | |
| GET | /kb/live/:id/stream | routes/live.mjs:142 | jwt | read | - | SSE with heartbeat timer (live.mjs:206). |
| GET | /kb/live/:id | routes/live.mjs:241 | jwt | read | - | |
| GET | /kb/chat/sessions | routes/chat.mjs:22 | jwt | read | - | |
| POST | /kb/chat/sessions | routes/chat.mjs:34 | jwt | write | - | |
| GET | /kb/chat/sessions/:id | routes/chat.mjs:63 | jwt | read | - | |
| PATCH | /kb/chat/sessions/:id | routes/chat.mjs:87 | jwt | write | - | |
| DELETE | /kb/chat/sessions/:id | routes/chat.mjs:103 | jwt | write | - | |
| POST | /kb/chat/sessions/:id/messages | routes/chat.mjs:114 | jwt | write | - | |
| DELETE | /kb/chat/sessions/:id/messages | routes/chat.mjs:199 | jwt | write | - | |
| POST | /kb/chat/sessions/:id/archive/begin | routes/chat.mjs:139 | jwt | write | - | Rate kbWrite. |
| POST | /kb/chat/sessions/:id/archive/commit | routes/chat.mjs:167 | jwt | write | - | Rate kbWrite. |
| POST | /kb/index/notes | routes/index-routes.mjs:25 | jwt | write | - | Derived note index (DB only). |
| POST | /kb/index/reconcile | routes/index-routes.mjs:32 | jwt | write | - | |
| POST | /kb/index/scan | routes/index-routes.mjs:45 | jwt | write | - | Hash manifests only; no host fs read. |
| DELETE | /kb/index/notes/:key | routes/index-routes.mjs:51 | jwt | write | - | |
| GET | /kb/index/search | routes/index-routes.mjs:58 | jwt | read | - | |
| GET | /kb/index/status | routes/index-routes.mjs:74 | jwt | read | - | |
| GET | /kb/agent/working-state | routes/lifecycle-routes.mjs:111 | jwt | read | - | |
| POST | /agent/v2/sessions/purge | routes/lifecycle-routes.mjs:116 | jwt | write | - | Rate kbWrite. |
| POST | /kb/archive-receipts | routes/lifecycle-routes.mjs:174 | jwt | write | - | |
| POST | /kb/session-purges | routes/lifecycle-routes.mjs:181 | jwt | write | - | |
| GET | /kb/storage | routes/agent-history.mjs:41 | jwt | read | - | |
| GET | /kb/agent-history/settings | routes/agent-history.mjs:45 | jwt | read | - | |
| PUT | /kb/agent-history/settings | routes/agent-history.mjs:49 | jwt | write | - | |
| POST | /kb/agent-history/clear | routes/agent-history.mjs:58 | jwt | write | - | |
| POST | /kb/agent-history/compact | routes/agent-history.mjs:89 | jwt | write | - | |
| POST | /kb/complete | routes/complete.mjs:42 | jwt+AUTH(member,read_only,cap) | model | - | One plain completion, no tools; any provider/model from body. |
| POST | /kb/google/start | routes/google-connectors.mjs:143 | jwt | write | - | Begins OAuth, returns the consent URL. Rate kbWrite. |
| GET | /kb/google/status | routes/google-connectors.mjs:156 | jwt | read | - | |
| GET | /kb/google/accounts | routes/google-connectors.mjs:163 | jwt | read | - | |
| POST | /kb/google/disconnect | routes/google-connectors.mjs:168 | jwt | write | - | |
| POST | /kb/google/options | routes/google-connectors.mjs:179 | jwt | write | - | |
| GET | /kb/google/calendars | routes/google-connectors.mjs:193 | jwt | external | - | Rate dispatch. |
| GET | /kb/google/drive/folders | routes/google-connectors.mjs:199 | jwt | external | - | Rate dispatch. |
| POST | /kb/google/gmail/fetch | routes/google-connectors.mjs:205 | jwt | external | - | Rate dispatch. |
| POST | /kb/google/gmail/seen | routes/google-connectors.mjs:227 | jwt | write | - | |
| POST | /kb/google/sync | routes/google-connectors.mjs:239 | jwt | external | - | Calendar/Drive sync into KB. |
| GET | /kb/calendar-ical/sources | routes/calendar-ical.mjs:120 | jwt | read | - | Feed URL is a write-only secret. |
| POST | /kb/calendar-ical/sources | routes/calendar-ical.mjs:124 | jwt | write | - | |
| DELETE | /kb/calendar-ical/sources/:id | routes/calendar-ical.mjs:147 | jwt | write | - | |
| POST | /kb/calendar-ical/options | routes/calendar-ical.mjs:160 | jwt | write | - | |
| POST | /kb/calendar-ical/sync | routes/calendar-ical.mjs:172 | jwt | external | - | Fetches the feed host. Rate dispatch. |
| GET | /kb/os/stream | routes/os.mjs:181 | jwt | read | - | SSE (heartbeat os.mjs:165). |
| GET | /kb/os/state | routes/os.mjs:184 | jwt | read | - | |
| POST | /kb/agent/dispatch | routes/agent.mjs:71 | jwt+AUTH(member,execute,cap) | model | - | Attaches the meeting agent to a live session; starts a 1.5 s background loop (see section a). runClaude, no tools. |
| POST | /kb/agent/stop | routes/agent.mjs:91 | jwt | write | - | |
| GET | /kb/agent/runs | routes/agent.mjs:103 | jwt | read | - | |
| GET | /kb/agent/diagnose | routes/agent.mjs:109 | jwt | read | - | Not in ALL_ENDPOINTS. |
| GET | /kb/agent/persona | routes/agent.mjs:122 | jwt | read | - | |
| PUT | /kb/agent/persona | routes/agent.mjs:126 | jwt | write | - | |
| GET | /kb/agent/personas | routes/agent.mjs:139 | jwt | read | - | |
| POST | /kb/agent/personas | routes/agent.mjs:143 | jwt | write | - | |
| PUT | /kb/agent/personas/active | routes/agent.mjs:153 | jwt | write | - | |
| PUT | /kb/agent/personas/:id | routes/agent.mjs:163 | jwt | write | - | |
| DELETE | /kb/agent/personas/:id | routes/agent.mjs:174 | jwt | write | - | |
| POST | /kb/agent/ask | routes/agent.mjs:194 | jwt+AUTH(member,read_only,cap) | model | - | runClaude with images, provider/model from body; no tools. |
| GET | /kb/agent/ask/history | routes/agent.mjs:289 | jwt | read | - | |
| DELETE | /kb/agent/ask/history | routes/agent.mjs:300 | jwt | write | - | |
| POST | /kb/agent/feedback | routes/agent.mjs:307 | jwt | write | - | |
| GET | /kb/agent/feedback/stats | routes/agent.mjs:324 | jwt | read | - | |
| GET | /kb/agent/feedback/by-task | routes/agent.mjs:333 | jwt | read | - | |
| GET | /kb/agent/catalog | routes/agent.mjs:343 | jwt | read | - | |
| GET | /kb/agent/commands | routes/agent.mjs:367 | jwt | read | - | |
| GET | /kb/agent/generation-library | routes/agent.mjs:396 | jwt | read | - | |
| GET | /kb/agent/skill-library | routes/agent.mjs:407 | jwt | read | - | |
| GET | /kb/agent/project-memory | routes/agent.mjs:419 | jwt | fs | - | Reads `<root>/…chat-memory` where root = an allow-listed repo or `?workspaceRoot=` from the query (accepted if absolute, no `..`, not `/` or $HOME; graphkit/memory.mjs:188-223). |
| DELETE | /kb/agent/project-memory | routes/agent.mjs:484 | jwt | fs | - | **Writes** (mkdir -p + atomic rewrite, graphkit/memory-writer.mjs:203) the memory file in a body-supplied `workspaceRoot` that only needs to look safe, not be allow-listed. |
| GET | /kb/agent/tool-approvals | routes/agent.mjs:441 | jwt | read | - | Always-allow rules the user granted to agent tools. |
| DELETE | /kb/agent/tool-approvals | routes/agent.mjs:453 | jwt | write | - | |
| GET | /kb/agent/session-memory | routes/agent.mjs:517 | jwt | read | - | |
| DELETE | /kb/agent/session-memory | routes/agent.mjs:537 | jwt | write | - | |
| POST | /agent/v2/stream | routes/agent-v2.mjs:321 (handleV2Stream 450, runV2Turn 498, runV2Stream 639) | jwt (+inline max_mode/USD cap agent-v2.mjs:575-606; no requireRole) | shell (+model,fs,external) | - | The chat engine: Claude Agent SDK, tool-capable. `allowAmbientAuth: true` (agent-v2.mjs:903) so it runs on vault key, then env key, then the **operator's `claude login`**. `agentContext.workspaceRoot` is taken from the body, only guarded by isTooBroadRoot (engine.mjs:1361), not by the repo allow-list; workspace-trust only gates a project's own `.mcp.json`. mode `execute` = Edit/Write/Bash in that dir; `permissionMode` ask/accept-edits/bypass; `bypass` requires a host approval token when LLMIDE_HOST_APPROVAL_KEY is set (agent-v2.mjs:418-446) and is capped to `ask` for non-host origins. max_mode `read_only` clamps to a read-only mode; `none` refuses; no members row = read_only. Role (viewer vs member) is NOT checked here, only max_mode. Rate bucket agentTurn. |
| POST | /agent/v2/decision | routes/agent-v2.mjs:324 | jwt | shell | - | Answers a pending tool-approval / question for a running turn (decisions.mjs): this is the "approve Bash/Edit" click. User-scoped. |
| DELETE | /agent/v2/session | routes/agent-v2.mjs:327 | jwt | write | - | |
| POST | /agent/v2/cancel | routes/agent-v2.mjs:330 | jwt | write | - | |
| GET | /agent/v2/turns | routes/agent-v2.mjs:335 | jwt | read | - | |
| GET | /agent/v2/turns/stream | routes/agent-v2.mjs:339 | jwt | read | - | Re-attach to a running turn's replay buffer. |
| GET | /agent/v2/session/route | routes/agent-v2.mjs:342 | jwt | read | - | |
| PUT | /agent/v2/session/route | routes/agent-v2.mjs:345 | jwt | write | - | Per-chat provider/model/token cap pick. |
| GET | /agent/v2/session/route/history | routes/agent-v2.mjs:348 | jwt | read | - | |
| POST | /kb/loop/agent-run | routes/loop-agent.mjs:112 | jwt+AUTH(member,execute,cap) (also inline enforce at loop-agent.mjs:141) | shell (+model,fs) | auto_tasks | Headless Agent SDK run that edits files; `repoRoot`/`extraRoots` validated against the repo allow-list (validateLoopRepoRoot). `allowAmbientAuth: true` (loop-agent.mjs:207) = operator's claude login. Timeout from body. Rate agentTurn. |
| GET | /kb/providers/catalog | routes/provider-catalog.mjs:87 | jwt | read | - | Also migrates legacy provider keys once. |
| GET | /kb/providers/custom | routes/provider-catalog.mjs:93 | jwt | read | - | |
| GET | /kb/providers/settings | routes/provider-catalog.mjs:97 | jwt | read | - | |
| PUT | /kb/providers/settings | routes/provider-catalog.mjs:101 | jwt | write | - | Includes the "allow tools on provider models" opt-in. |
| POST | /kb/providers/catalog/connect | routes/provider-catalog.mjs:106 | jwt | write | - | Stores a provider key + base URL in the vault. |
| POST | /kb/providers/catalog/disconnect | routes/provider-catalog.mjs:123 | jwt | write | - | |
| POST | /kb/providers/catalog/test | routes/provider-catalog.mjs:128 | jwt | external | - | One GET /models via pinned fetch. |
| POST | /kb/providers/catalog/models | routes/provider-catalog.mjs:128 | jwt | external | - | |
| POST | /kb/providers/turn | routes/provider-catalog.mjs:143 | jwt+AUTH(member,execute,cap) | shell (+model,fs,external) | - | Tool-capable chat turn on a non-Anthropic model (llm_agent/adapter/provider-turn.mjs): mounts file/shell tools (`mode`) and MCP servers (`mountMcpTools`) in `agentContext.workspaceRoot` (body; normalizeWorkspaceRoot only). Tools only if the user opted in (Settings). Uses the user's provider key, not the operator login. |
| POST | /kb/projects/register | routes/docs-routes.mjs:114 | jwt+AUTH(member,execute) | fs | doc_gen | Maps a project id to a `root` directory from the body (validateProjectRoot) in the DB; every later /kb/docs/* write lands there. |
| GET | /kb/docs/templates | routes/docs-routes.mjs:129 | jwt | fs | doc_gen | Reads the registered project folder. |
| GET | /kb/docs/commands | routes/docs-routes.mjs:135 | jwt | fs | doc_gen | |
| POST | /kb/docs/seed | routes/docs-routes.mjs:141 | jwt+AUTH(member,execute) | fs | doc_gen | Writes kit files into the project (write-if-absent). |
| PUT | /kb/docs/templates/:folder | routes/docs-routes.mjs:181 | jwt+AUTH(member,execute) | fs | doc_gen | Writes into the project folder. |
| DELETE | /kb/docs/templates/:folder | routes/docs-routes.mjs:170 | jwt+AUTH(member,execute) | fs | doc_gen | Deletes a project folder entry. |
| PUT | /kb/docs/commands/:folder | routes/docs-routes.mjs:181 | jwt+AUTH(member,execute) | fs | doc_gen | |
| DELETE | /kb/docs/commands/:folder | routes/docs-routes.mjs:170 | jwt+AUTH(member,execute) | fs | doc_gen | |
| GET | /kb/issue-schedule | routes/issue-schedule.mjs:26 | jwt | read | gantt_issues | |
| PUT | /kb/issue-schedule | routes/issue-schedule.mjs:40 | jwt | write | gantt_issues | Rate kbWrite. |
| DELETE | /kb/issue-schedule | routes/issue-schedule.mjs:62 | jwt | write | gantt_issues | |
| POST | /kb/issues/create | routes/issue-writes.mjs:129 (via issue-schedule.mjs:22) | host-proof | host (+external) | gantt_issues | Creates a GitHub/GitLab issue; only for a repo already on the caller's board; vault token, fixed hosts. Rate dispatch. |
| POST | /kb/issues/comment | routes/issue-writes.mjs:129 | host-proof | host (+external) | gantt_issues | |
| POST | /kb/issues/close | routes/issue-writes.mjs:129 | host-proof | host (+external) | gantt_issues | |
| POST | /bus/commands | routes/bus/bus-routes.mjs:152 | jwt + client class (other: x-llmide-client, capped to `extension` without host proof; routes/bus/client.mjs:41) | shell (+model,fs,external) | - | Enqueues a typed command. Registry kinds: `review` (T0, available: read-only review of a registered project on engines claude/adapter, spawns CLI engines via ctx.spawn, `allowAmbientAuth: true, readOnly: true` bus/engines.mjs:115), `sources.update` (T1, external Google/iCal sync, needs desktop approval). issues.from_notes, issues.implement, loop.run, custom.run are `available: false`. Class `extension` may only start R/C tiers; T0 needs ios-native or desktop-ui. Rate kbWrite. |
| GET | /bus/commands | routes/bus/bus-routes.mjs:160 | jwt + client class | read | - | Extension/pwa see only their own class's commands. |
| GET | /bus/commands/:id | routes/bus/bus-routes.mjs:249 | jwt + client class | read | - | |
| GET | /bus/commands/:id/events | routes/bus/bus-routes.mjs:257 | jwt + client class | read | - | SSE. |
| POST | /bus/commands/:id/cancel | routes/bus/bus-routes.mjs:265 | jwt + client class | write | - | |
| POST | /bus/commands/:id/approve | routes/bus/bus-routes.mjs:278 | jwt + host-proven `desktop-ui` class + per-command nonce | host | - | Releases a T1/T2 command (the only approval path); also standing approvals via scheduleId. |
| POST | /bus/commands/:id/deny | routes/bus/bus-routes.mjs:294 | jwt + host-proven `desktop-ui` | host | - | |
| GET | /bus/approvals | routes/bus/bus-routes.mjs:228 | jwt + host-proven `desktop-ui` | host | - | Lists pending commands WITH their approval nonce. |
| GET | /bus/kinds | routes/bus/bus-routes.mjs:173 | jwt + client class | read | - | |
| PUT | /bus/kinds/:kind | routes/bus/bus-routes.mjs:182 | jwt + host-proven `desktop-ui` | host | - | Per-user enable flag for a kind (T0 needs it on). |
| GET | /bus/schedules | routes/bus/bus-routes.mjs:196 | jwt + class rank>=3 (desktop-ui / ios-native) | read | - | |
| POST | /bus/schedules | routes/bus/bus-routes.mjs:201 | jwt + host-proven `desktop-ui` | host | - | Schedule record + optional standing approval; no server timer (the desktop enqueues each run). |
| DELETE | /bus/schedules/:id | routes/bus/bus-routes.mjs:218 | jwt + host-proven `desktop-ui` | host | - | |
| GET | /admin/members | routes/team-routes.mjs:104 | jwt+requireRole(admin) (team-routes.mjs:90, whole module) | admin | - | |
| PATCH | /admin/members/:userId | routes/team-routes.mjs:110 | jwt+requireRole(admin) | admin | - | Changes another user's team_role/max_mode/USD cap; rewrites team.yaml; actor must outrank target (kb/members.mjs:135-139). |
| POST | /admin/invites | routes/team-routes.mjs:141 | jwt+requireRole(admin) | admin | - | Mints a registration token with grants. |
| GET | /admin/invites | routes/team-routes.mjs:160 | jwt+requireRole(admin) | admin | - | |
| DELETE | /admin/invites/:id | routes/team-routes.mjs:166 | jwt+requireRole(admin) | admin | - | |
| GET | /kb/sync/status | routes/sync/http-routes.mjs:90 | host-proof | host | - | server.mjs:904 dispatches before handleKB. |
| POST | /kb/sync/mega | routes/sync/http-routes.mjs:91 | host-proof | host (+external) | - | Stores MEGA creds in the vault. |
| POST | /kb/sync/sftp | routes/sync/http-routes.mjs:110 | host-proof | host (+external) | - | Own-server SFTP host:port from body. |
| POST | /kb/sync/box/start | routes/sync/http-routes.mjs:132 | host-proof | host (+external) | - | |
| POST | /kb/sync/box/poll | routes/sync/http-routes.mjs:139 | host-proof | host (+external) | - | |
| GET | /kb/sync/box/callback | routes/sync/http-routes.mjs:82 | none-public (auth.mjs:40) | public (+external) | - | Box OAuth redirect, public HTML. Handled before the host-proof check. Not in ALL_ENDPOINTS. |
| POST | /kb/sync/enabled | routes/sync/http-routes.mjs:140 | host-proof | host | - | Turns the background sync scheduler on for this user. |
| POST | /kb/sync/test | routes/sync/http-routes.mjs:148 | host-proof | host (+external) | - | Rate dispatch. |
| POST | /kb/sync/publish | routes/sync/http-routes.mjs:148 | host-proof | host (+external) | - | Uploads encrypted notes to the store. |
| POST | /kb/sync/devices/enroll | routes/sync/http-routes.mjs:176 | host-proof | host | - | Enrolls a web/ios device (QR). |
| POST | /kb/sync/devices/enroll/poll | routes/sync/http-routes.mjs:177 | host-proof | host | - | |
| POST | /kb/sync/devices/enroll/confirm | routes/sync/http-routes.mjs:178 | host-proof | host | - | |
| POST | /kb/sync/devices/enroll/cancel | routes/sync/http-routes.mjs:183 | host-proof | host | - | |
| DELETE | /kb/sync/devices/:id | routes/sync/http-routes.mjs:184 | host-proof | host | - | |
| POST | /kb/sync/rotate | routes/sync/http-routes.mjs:190 | host-proof | host | - | |
| GET | /kb/self-heal/incidents | routes/self-heal.mjs:89 | host-proof (config.selfHeal only; else 404 feature_disabled, server.mjs:911) | host | - | Debug desktop builds only. |
| POST | /kb/self-heal/incidents | routes/self-heal.mjs:93 | host-proof | host | - | |
| POST | /kb/self-heal/incidents/:id/ignore | routes/self-heal.mjs:106 | host-proof | host | - | |
| DELETE | /kb/self-heal/incidents | routes/self-heal.mjs:111 | host-proof | host | - | Not in ALL_ENDPOINTS as a bare path. |
| POST | /kb/self-heal/runs | routes/self-heal.mjs:116 | host-proof | host | - | `repoRoot` must be a trusted/allow-listed checkout (buildTrustedRoots); returns a batch for the host to run, the core spawns nothing here. |
| POST | /kb/self-heal/runs/:id/outcome | routes/self-heal.mjs:145 | host-proof | host | - | |
| POST | /kb/self-heal/runs/:id/resolve | routes/self-heal.mjs:145 | host-proof | host | - | |
| POST | /host-api/pin | routes/host-api/http-routes.mjs:70 | host-proof (+404 HOST_API_DISABLED without a v1 listener) | host | - | Mints a 6-digit pairing PIN: whoever redeems it gets a device token that can run read-only chat turns (spends tokens) as this user. Returns LAN addresses. |
| GET | /host-api/devices | routes/host-api/http-routes.mjs:80 | host-proof | host | - | |
| DELETE | /host-api/devices/:id | routes/host-api/http-routes.mjs:84 | host-proof | host | - | |
| POST | /host-api/push/send | routes/host-api/http-routes.mjs:103 | host-proof | host (+external) | - | APNs / web-push fan-out (LLMIDE_HOST_API_PUSH=1). |
| GET | /host-api/push/status | routes/host-api/http-routes.mjs:111 | host-proof | host | - | |
| PUT | /host-api/push/apns | routes/host-api/http-routes.mjs:112 | host-proof | host | - | Stores the APNs .p8 key. |
| DELETE | /host-api/push/apns | routes/host-api/http-routes.mjs:118 | host-proof | host | - | |
| GET (WebSocket upgrade) | /host-api/v1 (separate listener, port 3016+, not the main server) | server/host-api-listener.mjs:34,86 + routes/host-api/gateway.mjs | other: pairing PIN or device token, origin allow-list, 4-session cap, no JWT (gateway.mjs host.auth.pair / host.auth.token) | model | - | Only when config.hostApiMode is tls (0.0.0.0, pinned cert) or dev (loopback). Commands in section (b). Chat is read-only: `startHostTurn` forces auto_read_only, never execute, scratch extension-chat workspace, no Bypass (agent-v2.mjs:1164-1193). Member filter: viewer / max_mode none / no member row get only host+read+push (gateway.mjs:29-37, ~297, ~320). |
| GET | /auth/well-known | server/auth-routes.mjs:99 | none-public | public | - | Reveals registrationOpen and vault key names. |
| POST | /auth/register | server/auth-routes.mjs:111 | none-public (per-IP limiter) | public | - | Open when config.registrationOpen, else needs an invite. Creates the `members` row (see "How auth works" 6). |
| POST | /auth/login | server/auth-routes.mjs:203 | none-public (per-IP limiter) | public | - | |
| POST | /auth/refresh | server/auth-routes.mjs:224 | none-public | public | - | |
| POST | /auth/reset-request | server/auth-routes.mjs:262 | none-public (per-IP limiter) | public | - | |
| POST | /auth/reset-confirm | server/auth-routes.mjs:299 | none-public | public | - | |
| GET | /auth/google/callback | server/auth-routes.mjs:352 | none-public | public (+external) | - | OAuth redirect. |
| GET | /auth/slack/callback | server/auth-routes.mjs:402 | none-public | public (+external) | - | |
| GET | /auth/mcp-connector/callback | server/auth-routes.mjs:447 | none-public | public (+external) | - | |
| POST | /auth/logout | server/auth-routes.mjs:494 | jwt | write | - | |
| POST | /auth/google/start | server/auth-routes.mjs:535 | jwt | write | - | |
| GET | /auth/google/status | server/auth-routes.mjs:583 | jwt | read | - | |
| POST | /auth/slack/start | server/auth-routes.mjs:596 | jwt | write | - | |
| GET | /auth/slack/status | server/auth-routes.mjs:611 | jwt | read | - | |
| POST | /auth/mcp-connector/start | server/auth-routes.mjs:627 | jwt | external | - | Discovery + dynamic client registration against a remote MCP server from the body. |
| GET | /auth/mcp-connector/status | server/auth-routes.mjs:659 | jwt | read | - | |
| GET | /auth/me | server/auth-routes.mjs:676 | jwt | read | - | |
| POST | /auth/me/delete | server/auth-routes.mjs:697 | jwt | write | - | Self-service cascade delete of the caller's own data. |
| POST | /auth/me/password | server/auth-routes.mjs:736 | jwt | write | - | |
| GET | /auth/me/secrets | server/auth-routes.mjs:751 | jwt | read | - | Key names only. |
| POST | /auth/me/secrets | server/auth-routes.mjs:757 | jwt | write | - | Stores vault secrets (provider keys, github/slack tokens, IMAP password). Allowed keys = VAULT_KEYS. |
| GET | /auth/me/repos | server/auth-routes.mjs:789 | jwt | read | - | |
| POST | /auth/me/repos | server/auth-routes.mjs:793 | jwt+AUTH(member,execute) (also inline at 796) | fs | - | Adds a host path to the repo allow-list (`assertNotTooBroad` only). **This is the grant that lets /kb/connect-git, /kb/loop/agent-run, review/approve (codegen-apply), self-heal and bus review touch that path.** |
| DELETE | /auth/me/repos | server/auth-routes.mjs:815 | jwt+AUTH(member,execute) | write | - | |
| GET | /auth/me/prefs | server/auth-routes.mjs:841 | jwt | read | - | |
| PUT | /auth/me/prefs | server/auth-routes.mjs:845 | jwt | write | - | Includes `nativePlugins`. |
| GET | /auth/me/audit | server/auth-routes.mjs:864 | jwt | read | - | Caller's own audit rows. |
| GET | /auth/me/connectors | server/auth-routes.mjs:893 | jwt | read | - | |
| GET | /auth/me/connectors/catalog | server/auth-routes.mjs:906 | jwt | read | - | |
| POST | /auth/me/connectors/add | server/auth-routes.mjs:916 | jwt | write | - | |
| DELETE | /auth/me/connectors/:id | server/auth-routes.mjs:935 | jwt | write | - | |
| GET | /auth/me/plugins | routes/extension-routes.mjs:149 | jwt | read | - | Plugins live in a server-wide registry. |
| POST | /auth/me/plugins/toggle | routes/extension-routes.mjs:155 | jwt | write | - | Per-user enable of an installed plugin (its skills/commands reach this user's turns). |
| POST | /auth/me/plugins/hook-trust | routes/extension-routes.mjs:192 | jwt | shell | - | Per-user grant that lets a plugin's **hook shell commands run during turns** (routes/extension-routes.mjs:186-191). Any member can grant it for any installed plugin. No role check. |
| POST | /auth/me/plugins/reload | routes/extension-routes.mjs:217 | jwt+requireRole(admin) | admin | - | Re-scans the plugin dir. |
| POST | /auth/me/plugins/install-git | routes/extension-routes.mjs:233 | jwt+requireRole(admin) | admin (+external) | - | Shallow-clones a public repo from a body URL, installs the zip bytes server-wide. |
| POST | /auth/me/plugins/install | routes/extension-routes.mjs:281 | jwt+requireRole(admin) | admin | - | Zip upload install. Rate dispatch. |
| DELETE | /auth/me/plugins/uninstall/:name | routes/extension-routes.mjs:355 | jwt+requireRole(admin) | admin | - | |
| GET | /auth/me/claude-plugins/installed | routes/extension-routes.mjs:396 | jwt | fs | - | Scans the **operator's** Claude Code plugin dirs (plugins/claude-adapter.mjs scanInstalled). |
| GET | /auth/me/claude-plugins/marketplace | routes/extension-routes.mjs:409 | jwt | fs | - | Same, marketplace dirs. |
| POST | /auth/me/claude-plugins/import | routes/extension-routes.mjs:425 | jwt+requireRole(admin) | admin | - | Imports an operator-side plugin install-wide. |
| POST | /auth/me/claude-plugins/refresh | routes/extension-routes.mjs:486 | jwt | fs | - | Re-scan of the operator's dirs, returns counts. |
| GET | /auth/me/claude-plugins/updates | routes/extension-routes.mjs:494 | jwt | external | - | `?force=1` open to any user. |
| POST | /auth/me/claude-plugins/update | routes/extension-routes.mjs:508 | jwt+requireRole(admin) | admin | - | |
| GET | /auth/me/codex-plugins/installed | routes/extension-routes.mjs:551 | jwt | fs | - | Operator's Codex plugin dirs. |
| GET | /auth/me/codex-plugins/marketplace | routes/extension-routes.mjs:564 | jwt | fs | - | |
| POST | /auth/me/codex-plugins/import | routes/extension-routes.mjs:580 | jwt+requireRole(admin) | admin | - | |
| POST | /auth/me/codex-plugins/refresh | routes/extension-routes.mjs:631 | jwt | fs | - | |
| GET | /auth/me/codex-plugins/updates | routes/extension-routes.mjs:639 | jwt | external | - | |
| GET | /auth/me/llm-sources | routes/extension-routes.mjs:670 | jwt | read | - | Also seeds the builtin source once. |
| GET | /auth/me/llm-sources/updates | routes/extension-routes.mjs:680 | jwt | external | - | Upstream git checks for every source; `?force=1` open to any user. |
| POST | /auth/me/llm-sources/toggle | routes/extension-routes.mjs:688 | jwt | write | - | Per-user enable of a source. |
| POST | /auth/me/llm-sources/items | routes/extension-routes.mjs:718 | jwt | write | - | Per-user item checkboxes (skills/agents/commands). |
| POST | /auth/me/llm-sources/add | routes/extension-routes.mjs:751 | jwt+requireRole(admin) | admin (+external) | - | Clones a git URL or registers a local path as a skill/agent source for the install. |
| POST | /auth/me/llm-sources/update | routes/extension-routes.mjs:772 | jwt+requireRole(admin) | admin (+external) | - | |
| DELETE | /auth/me/llm-sources/:id | routes/extension-routes.mjs:793 | jwt+requireRole(admin) | admin | - | |
| GET | /auth/me/llm-sources/:id/discovery | routes/extension-routes.mjs:812 | jwt+requireRole(admin) | admin | - | Absolute agent paths and hook/MCP command strings. |
| GET | /auth/me/mcp-plugins | routes/extension-routes.mjs:844 | jwt | read | - | |
| GET | /auth/me/mcp-plugins/catalog | routes/extension-routes.mjs:904 | jwt | read | - | |
| GET | /auth/me/mcp-plugins/claude-sources | routes/extension-routes.mjs:914 | jwt+requireRole(admin) | admin | - | Reads the operator's ~/.claude.json. |
| GET | /auth/me/mcp-plugins/codex-sources | routes/extension-routes.mjs:921 | jwt+requireRole(admin) | admin | - | Reads ~/.codex/config.toml. |
| POST | /auth/me/mcp-plugins/add | routes/extension-routes.mjs:928 | jwt+requireRole(admin) | admin | - | Registers an MCP server (command, args, env) server-wide. |
| POST | /auth/me/mcp-plugins/consent | routes/extension-routes.mjs:995 | jwt | write | - | Per-user consent to a registered MCP server. |
| POST | /auth/me/mcp-plugins/toggle | routes/extension-routes.mjs:1011 | jwt | shell | - | Per-user enable: puts the registered MCP **server process** into this user's CLI `--mcp-config` (needs consent first). Any member. |
| GET | /auth/me/mcp-plugins/updates | routes/extension-routes.mjs:1037 | jwt | external | - | npm/PyPI lookup; `force=1` silently degraded for non-admins. |
| POST | /auth/me/mcp-plugins/:id/update | routes/extension-routes.mjs:1058 | jwt+requireRole(admin) | admin | - | Re-pin version. |
| GET, POST | /auth/me/mcp-plugins/:id/resync | routes/extension-routes.mjs:1058 | jwt+requireRole(admin) | admin | - | |
| DELETE | /auth/me/mcp-plugins/:id | routes/extension-routes.mjs:1125 | jwt+requireRole(admin) | admin | - | |
| GET | /auth/me/workspace-trust | routes/workspace-trust.mjs:25 (dispatched extension-routes.mjs:143) | jwt | read | - | |
| PUT | /auth/me/workspace-trust | routes/workspace-trust.mjs:26 | jwt | shell | - | Marks a folder trusted: a project's own `.mcp.json` (local process) is then loaded into turns run there. Body path (not too broad). Any member. |
| GET | /auth/me/extensions/installed | routes/extensions-catalog.mjs:142 | jwt | read | - | |
| GET | /auth/me/extensions/catalog | routes/extensions-catalog.mjs:145 | jwt | read | - | |
| GET | /auth/me/extensions/active | routes/extensions-catalog.mjs:151 | jwt | read | - | |
| GET | /auth/me/extensions/updates | routes/extensions-catalog.mjs:143 | jwt | read | - | Cached results. |
| GET | /auth/me/extensions/allowlist | routes/extensions-catalog.mjs:144 | jwt | read | - | |
| PUT | /auth/me/extensions/allowlist | routes/extensions-catalog.mjs:124 | jwt+AUTH(admin,execute) | admin | - | Which GitHub sources may be installed. |
| POST | /auth/me/extensions/install | routes/extensions-catalog.mjs:163 | jwt+AUTH(admin,execute) | admin (+external) | - | Downloads from github.com (pinned fetch) and installs skills/plugins/hooks/MCP, pinned commit. Rate dispatch. |
| POST | /auth/me/extensions/catalog/refresh | routes/extensions-catalog.mjs:171 | jwt+AUTH(admin,execute) | admin (+external) | - | |
| POST | /auth/me/extensions/updates/check | routes/extensions-catalog.mjs:184 | jwt | external | - | **Not matched by the ROUTE_AUTHORITY regex** (it lists `update` but not `updates/check`): any member triggers GitHub fetches. Rate dispatch. |
| POST | /auth/me/extensions/update/preview | routes/extensions-catalog.mjs:192 | jwt | external | - | **Also not matched** by the regex (only `update`). Rate dispatch. |
| POST | /auth/me/extensions/update | routes/extensions-catalog.mjs:192 | jwt+AUTH(admin,execute) | admin (+external) | - | |
| POST | /auth/me/extensions/rollback | routes/extensions-catalog.mjs:204 | jwt+AUTH(admin,execute) | admin | - | |
| POST | /auth/me/extensions/repair | routes/extensions-catalog.mjs:210 | jwt+AUTH(admin,execute) | admin (+external) | - | |
| POST | /auth/me/extensions/toggle | routes/extensions-catalog.mjs:216 | jwt+AUTH(admin,execute) | admin | - | Enabling is bound to the pinned commit; executable kinds need consents. |
| POST | /auth/me/extensions/uninstall | routes/extensions-catalog.mjs:230 | jwt+AUTH(admin,execute) | admin | - | |

### Gaps and mismatches worth knowing (found during the sweep)

- Model-spending routes with NO ROUTE_AUTHORITY entry (no role, no max_mode, no USD-cap check): `/generate-docx`, `/kb/summarize`, `/kb/conflict-questions`, `/agent-sdk/spike`; the Host API/`/agent/v2/stream` path has only the inline max_mode + USD-cap clamp (agent-v2.mjs:575-606), no role check.
- Listed in ROUTE_AUTHORITY but the handler relies on the dispatcher: `/kb/agent-sdk/update`, `/kb/dispatch`, `/kb/review/approve`, `/kb/agent/dispatch`, `/kb/providers/turn` (only `/kb/loop/agent-run`, `/kb/project/install-skills`, `/auth/me/repos` also enforce inline). A direct handleKB caller (tests) skips the table.
- Per-user grants that start local code but need only a JWT: `/auth/me/plugins/hook-trust`, `/auth/me/mcp-plugins/toggle` (+`/consent`), `PUT /auth/me/workspace-trust`.
- Path arguments taken from the body without containment: `/kb/ingest-scip` (`scipPath`), `DELETE /kb/agent/project-memory` and `GET ...` (`workspaceRoot`), `/agent/v2/stream` and `/kb/providers/turn` (`agentContext.workspaceRoot`, only isTooBroad checks), `/kb/projects/register` (`root`).
- Routes served but absent from ALL_ENDPOINTS (server.mjs:358-~590): everything under `/auth/*`, `/admin/backup`, `/admin/users/:id`, `/metrics`, `/health`, `/launch-app`, `/kb/agent/diagnose`, `/kb/sync/box/callback`, `DELETE /kb/self-heal/incidents` (bare). `/kb/agent/persona*` and `/kb/agent/personas/:id` are listed.
- `/kb/self-heal/*` is advertised and served only when `config.selfHeal`; feature groups answer 404 `feature_disabled` when off (feature-routes.mjs:125).
- FEATURE_ROUTE_GROUPS (routes/feature-routes.mjs:26-52): `code_graph_3d` -> `/kb/ingest-code-graph`; `gantt_issues` -> `/kb/issue-schedule`, `/kb/issues/create|comment|close`; `doc_gen` -> `/generate-doc`, `/kb/docs/`, `/kb/projects/register`; `auto_tasks` -> `/kb/loop/`. The role-policy relevant bit: ROUTE_AUTHORITY is skipped while a feature is disabled (server.mjs:881-882), but then the route is unreachable anyway.

## (a) Background jobs and schedulers (work with no request in flight)

| what | file:line | trigger and period | acts as | model/shell/external work |
|---|---|---|---|---|
| Background outcome poller | agents/outcome-watcher.mjs:254 (start: server.mjs:1561; loop body 205-249) | setInterval, 5 min default (`LLMIDE_OUTCOME_POLL_MS`, line 201) | **Every user** that has dispatched tasks (`listUsersWithDispatchedTasks`), using each user's vault `github.token` / `linear.apiKey` / `backlog.apiKey` | external (GitHub/Linear/Backlog reads); no model, no shell |
| Sync scheduler | routes/sync/scheduler.mjs:148 (start: server.mjs:1648; not in NODE_ENV=test or LLMIDE_SYNC=off) | setInterval 30 s drain, publish every ~60 s | Every user with sync enabled (`listEnabledSyncUsers`), `syncCycle(userId)` | external (MEGA / SFTP / Box, encrypted notes publish + device-request drain); no model, no shell |
| Command bus job runner | routes/bus/executor.mjs:292 (sweep 60 s; create/start: server.mjs:1566-1567); jobs executed in `runner` lines 103-140 | Runs queued bus commands (enqueued by a request, approved by the desktop) with up to 3 concurrent; the 60 s sweep reaps orphans | `job.userId` of the command | `review`: read-only Agent SDK run on the operator login (`allowAmbientAuth: true`, engines.mjs:115) or a CLI engine spawned in the user's registered project (model+shell+fs); `sources.update`: external Google/iCal sync. Desktop-initiated schedules enqueue from the desktop; the core has no cron (spec: "No server timer") |
| Meeting-agent question loop | agents/meeting-agent.mjs:364 (TICK_MS = 1500, line 29; start from POST /kb/agent/dispatch) | per attached live session, until the capture finalizes or POST /kb/agent/stop | `run.userId` (the user who dispatched) | model: `draftQuestion` -> runClaude (no tools; operator-CLI fallback when the user has no key), gated by cheap checks first |
| Auth GC | server.mjs:1549 | setInterval 6 h (AUTH_GC_INTERVAL_MS, line 1398) + at boot | system | DB cleanup only |
| Auto backup | server.mjs:1555 (runAutoBackup; first at boot) | setInterval BACKUP_INTERVAL_HOURS (server.mjs:1429), 0 disables | system (whole DB) | fs write + prune in config.backupDir |
| Agent store jobs | kb/agent-jobs.mjs:255 (start: server.mjs:1600) | 60 s tick; daily rollup 03:10 local; note-index compare daily | all users (rollups) | DB maintenance only |
| Agent DB queue flush | kb/agent-db.mjs:393 | setInterval QUEUE_FLUSH_MS | system | DB only |
| Warm Claude CLI pool | providers/warm-cli-pool.mjs:82 (spawn), 323 (scheduleRespawn timer) | keeps an idle `claude` process pre-spawned after a turn (isWarmCliEnabled) | the operator process (not per user until a turn uses it) | shell (long-lived child), no tokens until used |
| Engine prewarm / health probe | server.mjs:1645 (prewarmAgentEngine), 1602 (probeClaude), 1276 | once at boot; probe re-run on /health after cache expiry | system | imports Agent SDK; `claude --version` |
| Host API v1 listener | server.mjs:1671 (startHostApiListener), server/host-api-listener.mjs:68 | boot, when config.hostApiMode != off | paired device's user, per frame | chat.send -> read-only agent turn (model) as the paired user |
| Self-Heal orphan reopen | server.mjs:1605 (reopenOrphanedIncidents) | once at boot, config.selfHeal only | all users' incidents | DB only |
| Replay of pending agent purges | kb/agent-jobs.mjs (replayPendingAgentPurges, openAgentStoreAtBoot server.mjs:1533) | once at boot | deleted users | DB only |

Not found anywhere in the core: any server-side Loop / auto-task / cron scheduler that runs an agent or a shell command on its own. Loop and Auto-Task scheduling live in the desktop client, which calls POST /kb/loop/agent-run or enqueues bus commands. `grep setInterval` over non-test code returned only the entries above plus SSE heartbeats (routes/live.mjs:206, routes/os.mjs:165) and the bus event-stream poll (bus-routes.mjs:121).

## (b) Host API v1 commands (schema/host-api/v1/commands.json, generated into routes/host-api/commands.generated.mjs; 20 commands, the file header comment says 17)

Transport: WebSocket on a separate listener (`/host-api/v1`). Capability gate: a command's capability must be served (env flags below), granted to the device token at pairing, and not removed by the member filter (viewer / max_mode none / no member row get only host, read, push; gateway.mjs:30-37). Served capabilities (gateway.mjs:39-45): host, chat, approvals always; tool_approvals needs LLMIDE_HOST_API_TOOL_APPROVALS=1; read needs LLMIDE_HOST_API_READ=1; compose needs LLMIDE_HOST_API_COMPOSE=1; push needs LLMIDE_HOST_API_PUSH=1.

| command | capability | idempotent | core function it calls (gateway.mjs deps) |
|---|---|---|---|
| host.hello | host | yes | `helloRefusal` (routes/host-api/session.mjs); answers hostName, capabilities, certificate fingerprint |
| host.auth.pair | host | no | `consumePin` (routes/host-api/pin.mjs) then `issueDeviceToken` (kb/host-api-devices.mjs) with scopes = served capabilities filtered by `getMember` (minimalFor); `PairingThrottle` |
| host.auth.token | host | yes | `authenticateDeviceToken` (kb/host-api-devices.mjs); scopes re-filtered by `getMember` on every re-auth |
| host.auth.revoke | host | yes | `authenticateDeviceToken` then `revokeDevice` |
| host.ping | host | yes | none (heartbeat) |
| host.snapshot | host | yes | chat topic only: history via `getQuickChatId` + `chat-sessions.getChatSession` |
| chat.snapshot | chat | yes | `history(userId, limit)` -> kb/chat-sessions.mjs `getChatSession` on the user's "Phone chat" session, `messagesOf` clamps |
| chat.send | chat (+compose if mode/model given) | no | `startHostTurn` (routes/agent-v2.mjs:1175) -> `runV2Turn` -> Agent SDK engine; forced `auto_read_only` / HOST_TURN_MODES clamped read-only, extension-chat scratch workspace, no Bypass; `appendChatMessage` saves the lines; per-device turn rate limit |
| chat.cancel | chat | yes | `cancelChatTurn` (agent-v2.mjs) |
| chat.history.clear | chat | yes | `clearChatSessionState` (agent-v2.mjs:~1150); also needs LLMIDE_HOST_API_CHAT_CLEAR=1 |
| approvals.answer | approvals | no | `answerDecision` (llm_agent/sdk/decisions.mjs) for the question/decision the turn raised |
| toolApprovals.answer | tool_approvals | no | `answerDecision` (same module) with a tool approve/deny |
| chat.sessions | read | yes | kb/chat-sessions.mjs `listChatSessions` |
| chat.history | read | yes | kb/chat-sessions.mjs `getChatSession` (session id from the request, user-scoped) |
| usage.get | read | yes | kb/usage.mjs `usageSummary` |
| chat.new | compose | no | kb/chat-sessions.mjs `createChatSession` + `setQuickChatId` |
| chat.options | compose | yes | `listSdkModels` (llm_agent/sdk/models.mjs, may spawn the CLI) + HOST_TURN_MODES |
| push.config | push | yes | routes/host-api/push.mjs `pushConfig` |
| push.register | push | yes | `registerTarget` (push.mjs, validated by push-target.mjs) |
| push.unregister | push | yes | `unregisterTarget` (push.mjs) |

(The HTTP twin routes under /host-api/* are in section 1: pin, devices, push/send, push/status, push/apns.)

## (c) Row counts per effect class (primary class, from the table in section 1)

Total rows: 329 (some rows fold a method pair or a path pair: `/` + `/health`, `/code-assist` + `/code-assist/decision`, `DELETE, POST` aliases, `GET, POST .../resync`; the Host API WebSocket is one row).

| primary effect class | rows |
|---|---|
| public | 12 |
| read | 86 |
| write | 81 |
| model | 17 |
| fs | 18 |
| shell | 11 |
| external | 33 |
| admin | 34 |
| host | 37 |
| total | 329 |

Extra cuts: rows whose effect includes model spend as primary or secondary = 21; rows that are JWT-only with no role/authority/host-proof gate at all = 218 (of which 86 read, 81 write, the rest spend tokens, touch the host or the network).

Ten most dangerous routes with no role check today (JWT only, or only a max_mode clamp):
1. POST /agent/v2/stream (agent-v2.mjs:321): tool-capable agent, Edit/Write/Bash in a body-supplied workspaceRoot, on the operator's `claude login`; only max_mode and USD cap are checked, not role.
2. POST /kb/ingest-scip (router.mjs:590): spawns `scip print` with an arbitrary scipPath.
3. POST /auth/me/plugins/hook-trust (extension-routes.mjs:192): lets plugin hook shell commands run in turns.
4. POST /auth/me/mcp-plugins/toggle and /consent (extension-routes.mjs:1011, 995): starts a registered MCP server process in the user's turns.
5. PUT /auth/me/workspace-trust (workspace-trust.mjs:26): trusts a folder so its `.mcp.json` process loads.
6. POST /agent/v2/decision (agent-v2.mjs:324): approves pending Bash/Edit tool requests.
7. DELETE /kb/agent/project-memory (agent.mjs:484): writes a memory file under a body-supplied, non-allow-listed workspaceRoot.
8. POST /kb/outcomes/retry-failed (router.mjs:1460): re-pushes to GitHub/Linear/Backlog with no review gate.
9. POST /kb/summarize, /generate-docx, /kb/conflict-questions (router.mjs:1198, export-routes.mjs:130, router.mjs:1539): model spend on the operator CLI fallback with no role, max_mode or USD-cap check.
10. POST /kb/connect-git (router.mjs:563): git subprocess and file reads over any allow-listed path (and the allow-list itself is self-service).
