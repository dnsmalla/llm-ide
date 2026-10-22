# Testing Checklist

Before merging caption/transcript/LLM changes, run through this against a real meeting:

## Caption Fidelity
- [ ] Short Japanese captions (`はい。`) appear
- [ ] Long multi-sentence captions appear as ONE line
- [ ] Same speaker continuous updates stay on one line
- [ ] Different speakers produce different lines with real names
- [ ] Combined-speaker labels stripped to just speaker
- [ ] UI text does NOT appear (toolbar, clocks, meeting ID, effects)
- [ ] Works when extension loaded AFTER Meet tab opened
- [ ] Works on Teams and Zoom web

## LLM Output
- [ ] Primary language change → Notes/chat respond in that language
- [ ] Questions H2 headings localized (対立/要確認/要説明)
- [ ] DOCX export produces correct font (MS Gothic for JA)
- [ ] Stale server shows yellow "restart" banner

## Security
- [ ] `GET http://evil.example/` does NOT reach server (CORS)
- [ ] Setting `serverUrl` to evil URL rejected by `isSafeServerUrl()`
- [ ] Meeting with `<<<END>>>` spoken does not break AI output

## Feature pruning

The server honours `LLMIDE_FEATURES`, the comma-separated list of ENABLED feature keys the Mac app was built with (`mac/Package.swift`; unset or empty = every feature). `core/config.mjs#parseFeatures` reads it once into `config.features`.

- **Feature-owned routes** live in `routes/feature-routes.mjs` (`FEATURE_ROUTE_GROUPS`): `auto_tasks` → `/kb/loop/*`, `gantt_issues` → `/kb/issue-schedule`, `code_graph_3d` → `/kb/ingest-code-graph`. A disabled group's module is never imported, and its paths answer `404 {"error":"feature_disabled","feature":"<key>"}`.
- **Prune only single-owner routes** — a group may move into the table only when every caller (grep `src/` and the Mac `LlmIdeAPIClient*`) belongs to that feature. `/generate-doc` + `/generate-docx` stay always-on because the Chrome extension calls them.
- **Never import a feature route module statically** from `routes/router.mjs` or `server.mjs`; dispatch through `featureHandlers.<key>?.(…)` at the route's position.
- **The outcome poller stays unconditional** — `/kb/dispatch` and review approvals (always-on) are what write the dispatched tasks it polls.
- Tests: `tests/feature-config.test.mjs`, `tests/feature-routes.test.mjs`, `tests/server-features-health.test.mjs` (spawns `server.mjs`; needs local listen).

