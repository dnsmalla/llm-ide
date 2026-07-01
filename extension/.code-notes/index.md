# Codebase Index

| Field | Value |
|-------|-------|
| **Files** | 171 |
| **Languages** | javascript, markdown, typescript |
| **Total lines** | 27653 |

## High-Impact Files
> Files most depended on — change these with care.

| File | Role | Used By | Functions |
|------|------|---------|-----------|
| `db.mjs` | Web | 39 | 41 |
| `config.ts` | Web | 18 | 26 |
| `runtime.mjs` | Web | 12 | 16 |
| `utils.mjs` | Web | 11 | 8 |
| `users.mjs` | Web | 10 | 23 |
| `useTranscript.ts` | Web | 10 | 28 |
| `config.mjs` | Web | 8 | 6 |
| `loader.mjs` | Web | 6 | 12 |
| `vault.mjs` | Web | 6 | 12 |
| `messages.ts` | Web | 6 | 7 |
| `live-sessions.mjs` | Web | 5 | 12 |
| `errors.mjs` | Web | 5 | 8 |
| `rules.mjs` | Web | 5 | 9 |
| `search-kb.mjs` | Web | 5 | 3 |
| `loop.mjs` | Web | 5 | 7 |
| `skill-loader.mjs` | Web | 5 | 6 |
| `platforms.ts` | Web | 5 | 4 |
| `dispatcher.mjs` | Web | 4 | 18 |
| `meeting-agent.mjs` | Web | 4 | 17 |
| `prompt-utils.mjs` | Web | 4 | 2 |

## Files by Role

### Module (16 files)

- `README.md` — 22 lines, 0 functions
- `core/README.md` — 34 lines, 0 functions
- `docs/ARCHITECTURE.md` — 1 lines, 0 functions
- `docs/meeting-agent-plan.md` — 1 lines, 0 functions
- `llm_agent/README.md` — 18 lines, 0 functions
- `llm_agent/global/ask-internal.md` — 24 lines, 0 functions
- `llm_agent/global/ask-subagent.md` — 51 lines, 0 functions
- `llm_agent/global/prompt.md` — 57 lines, 0 functions
- `llm_agent/global/update-file.md` — 49 lines, 0 functions
- `llm_agent/internal/context/app-capabilities.md` — 10 lines, 0 functions
- `llm_agent/internal/prompt.md` — 41 lines, 0 functions
- `llm_agent/internal/skills/_base.md` — 12 lines, 0 functions
- `llm_agent/internal/skills/comment-gitlab-issue.md` — 43 lines, 0 functions
- `llm_agent/internal/skills/create-gitlab-issue.md` — 52 lines, 0 functions
- `llm_agent/internal/skills/search-kb.md` — 40 lines, 0 functions
- `llm_agent/internal/skills/trigger-review-code.md` — 51 lines, 0 functions

### Test (35 files)

- `tests/agent-ask-history.test.mjs` — 101 lines, 2 functions
- `tests/agent-ask-subagent.test.mjs` — 182 lines, 3 functions
- `tests/agent-code-assist.test.mjs` — 76 lines, 4 functions
- `tests/agent-context-renderers.test.mjs` — 75 lines, 0 functions
- `tests/agent-global-internal.test.mjs` — 264 lines, 5 functions
- `tests/agent-global.test.mjs` — 84 lines, 4 functions
- `tests/agent-loop-deadline.test.mjs` — 56 lines, 3 functions
- `tests/agent-personas.test.mjs` — 153 lines, 3 functions
- `tests/agent-prompt.test.mjs` — 244 lines, 8 functions
- `tests/agent-search-kb.test.mjs` — 32 lines, 0 functions
- `tests/agent-skills.test.mjs` — 106 lines, 2 functions
- `tests/agents-runtime-backoff.test.mjs` — 61 lines, 1 functions
- `tests/agents-runtime.test.mjs` — 66 lines, 2 functions
- `tests/auth.test.mjs` — 143 lines, 1 functions
- `tests/claude-adapter.test.mjs` — 314 lines, 6 functions
- `tests/exporter.test.mjs` — 36 lines, 0 functions
- `tests/guardrails.test.mjs` — 125 lines, 3 functions
- `tests/kb-router-path-traversal.test.mjs` — 133 lines, 3 functions
- `tests/kb-router.test.mjs` — 129 lines, 3 functions
- `tests/meeting-agent.test.mjs` — 185 lines, 6 functions
- `tests/migrations.test.mjs` — 83 lines, 2 functions
- `tests/password-reset.test.mjs` — 190 lines, 3 functions
- `tests/plugins-installer.test.mjs` — 252 lines, 4 functions
- `tests/plugins-loader.test.mjs` — 203 lines, 2 functions
- `tests/rate-limit.test.mjs` — 60 lines, 0 functions
- `tests/sanitize.test.mjs` — 66 lines, 0 functions
- `tests/scan.test.mjs` — 54 lines, 1 functions
- `tests/scripts-backup.test.mjs` — 66 lines, 2 functions
- `tests/security-fixes.test.mjs` — 165 lines, 3 functions
- `tests/server-control-plane.test.mjs` — 44 lines, 0 functions
- `tests/slack.test.mjs` — 50 lines, 0 functions
- `tests/summarize.test.mjs` — 64 lines, 4 functions
- `tests/tenancy.test.mjs` — 228 lines, 3 functions
- `tests/user-delete-cascade.test.mjs` — 174 lines, 2 functions
- `tests/vault.test.mjs` — 38 lines, 0 functions

### Web (120 files)

- `agents/agent-prompt.mjs` — 197 lines, 8 functions
- `agents/code-sync.mjs` — 44 lines, 4 functions
- `agents/codegen-apply.mjs` — 115 lines, 4 functions
- `agents/codegen.mjs` — 153 lines, 8 functions
- `agents/dispatcher.mjs` — 384 lines, 18 functions
- `agents/github-pr.mjs` — 218 lines, 5 functions
- `agents/live-sessions.mjs` — 283 lines, 12 functions
- `agents/meeting-agent.mjs` — 515 lines, 17 functions
- `agents/outcome-providers.mjs` — 166 lines, 9 functions
- `agents/outcome-watcher.mjs` — 233 lines, 14 functions
- `agents/planner.mjs` — 132 lines, 5 functions
- `agents/prompt-utils.mjs` — 73 lines, 2 functions
- `agents/risk.mjs` — 130 lines, 8 functions
- `agents/runtime.mjs` — 446 lines, 16 functions
- `agents/slack.mjs` — 137 lines, 11 functions
- `agents/summarize.mjs` — 60 lines, 2 functions
- `connectors/git.mjs` — 141 lines, 3 functions
- `connectors/issues.mjs` — 124 lines, 6 functions
- `connectors/qa.mjs` — 118 lines, 7 functions
- `core/config.mjs` — 152 lines, 6 functions
- `core/errors.mjs` — 72 lines, 8 functions
- `core/logger.mjs` — 64 lines, 3 functions
- `core/p-map.mjs` — 36 lines, 1 functions
- `core/utils.mjs` — 94 lines, 8 functions
- `eslint.config.mjs` — 29 lines, 0 functions
- `guardrails/rules.mjs` — 219 lines, 9 functions
- `guardrails/scan.mjs` — 30 lines, 2 functions
- `kb/db.mjs` — 629 lines, 41 functions
- `kb/exporter.mjs` — 53 lines, 2 functions
- `kb/feedback.mjs` — 118 lines, 5 functions
- `kb/meetings.mjs` — 222 lines, 10 functions
- `kb/migrations.mjs` — 146 lines, 7 functions
- `kb/outcomes.mjs` — 258 lines, 10 functions
- `kb/personas.mjs` — 327 lines, 18 functions
- `kb/plans.mjs` — 278 lines, 10 functions
- `kb/project-export.mjs` — 159 lines, 9 functions
- `kb/reviews.mjs` — 134 lines, 5 functions
- `kb/router.mjs` — 526 lines, 2 functions
- `kb/routes/agent.mjs` — 274 lines, 1 functions
- `kb/routes/live.mjs` — 181 lines, 5 functions
- `kb/routes/planning.mjs` — 259 lines, 1 functions
- `kb/routes/review.mjs` — 235 lines, 1 functions
- `kb/sources.mjs` — 83 lines, 3 functions
- `kb/user.mjs` — 169 lines, 11 functions
- `llm_agent/global/compose-prompt.mjs` — 19 lines, 2 functions
- `llm_agent/internal/context/compose.mjs` — 34 lines, 1 functions
- `llm_agent/internal/context/render-active-project.mjs` — 15 lines, 1 functions
- `llm_agent/internal/context/render-graphify-memory.mjs` — 147 lines, 6 functions
- `llm_agent/internal/context/render-indexed-repos.mjs` — 14 lines, 1 functions
- `llm_agent/internal/context/render-recent-issues.mjs` — 21 lines, 1 functions
- `llm_agent/internal/context/render-recent-meetings.mjs` — 14 lines, 1 functions
- `llm_agent/runtime/fence.mjs` — 82 lines, 2 functions
- `llm_agent/runtime/handlers/ask-internal.mjs` — 53 lines, 1 functions
- `llm_agent/runtime/handlers/ask-subagent.mjs` — 99 lines, 1 functions
- `llm_agent/runtime/handlers/search-kb.mjs` — 31 lines, 3 functions
- `llm_agent/runtime/loop.mjs` — 202 lines, 7 functions
- `llm_agent/runtime/route.mjs` — 335 lines, 7 functions
- `llm_agent/runtime/skill-loader.mjs` — 146 lines, 6 functions
- `plugins/claude-adapter.mjs` — 459 lines, 18 functions
- `plugins/installer.mjs` — 273 lines, 10 functions
- `plugins/loader.mjs` — 411 lines, 12 functions
- `plugins/state.mjs` — 88 lines, 7 functions
- `scripts/backup.mjs` — 113 lines, 6 functions
- `server.mjs` — 724 lines, 11 functions
- `server/ai-routes.mjs` — 467 lines, 16 functions
- `server/audit.mjs` — 105 lines, 4 functions
- `server/auth-routes.mjs` — 715 lines, 12 functions
- `server/auth.mjs` — 61 lines, 3 functions
- `server/control-plane.mjs` — 27 lines, 2 functions
- `server/export-routes.mjs` — 211 lines, 8 functions
- `server/jwt.mjs` — 102 lines, 10 functions
- `server/metrics.mjs` — 190 lines, 11 functions
- `server/rate-limit.mjs` — 192 lines, 6 functions
- `server/users.mjs` — 335 lines, 23 functions
- `server/vault.mjs` — 164 lines, 12 functions
- `src/background/service-worker.ts` — 178 lines, 2 functions
- `src/content/caption-scraper.ts` — 761 lines, 30 functions
- `src/content/floating-overlay.ts` — 128 lines, 3 functions
- `src/content/speaker-detector.ts` — 193 lines, 13 functions
- `src/lib/anthropic.ts` — 142 lines, 9 functions
- `src/lib/config.ts` — 403 lines, 26 functions
- `src/lib/entities.ts` — 30 lines, 0 functions
- `src/lib/export-formats.ts` — 157 lines, 3 functions
- `src/lib/kb.ts` — 214 lines, 17 functions
- `src/lib/messages.ts` — 73 lines, 7 functions
- `src/lib/plan.ts` — 47 lines, 0 functions
- `src/lib/platforms.ts` — 85 lines, 4 functions
- `src/lib/storage.ts` — 67 lines, 3 functions
- `src/sidepanel/App.tsx` — 616 lines, 14 functions
- `src/sidepanel/components/AgentPersonaSettings.tsx` — 128 lines, 3 functions
- `src/sidepanel/components/AgentStatsBadge.tsx` — 57 lines, 2 functions
- `src/sidepanel/components/ChatView.tsx` — 157 lines, 3 functions
- `src/sidepanel/components/ConnectorsSettings.tsx` — 219 lines, 9 functions
- `src/sidepanel/components/ErrorBoundary.tsx` — 31 lines, 0 functions
- `src/sidepanel/components/ExportMenu.tsx` — 165 lines, 12 functions
- `src/sidepanel/components/HelpPanel.tsx` — 1359 lines, 12 functions
- `src/sidepanel/components/LanguageSelector.tsx` — 55 lines, 1 functions
- `src/sidepanel/components/LoginView.tsx` — 112 lines, 2 functions
- `src/sidepanel/components/NotesView.tsx` — 56 lines, 1 functions
- `src/sidepanel/components/QuestionsView.tsx` — 467 lines, 15 functions
- `src/sidepanel/components/RecordingControls.tsx` — 48 lines, 2 functions
- `src/sidepanel/components/RemoteSessionBanner.tsx` — 39 lines, 1 functions
- `src/sidepanel/components/Settings.tsx` — 241 lines, 4 functions
- `src/sidepanel/components/TranscriptView.tsx` — 176 lines, 6 functions
- `src/sidepanel/components/UserAccountSettings.tsx` — 177 lines, 4 functions
- `src/sidepanel/hooks/useAgent.ts` — 189 lines, 6 functions
- `src/sidepanel/hooks/useAgentMirror.ts` — 114 lines, 2 functions
- `src/sidepanel/hooks/useAudioDevices.ts` — 58 lines, 5 functions
- `src/sidepanel/hooks/useChat.ts` — 114 lines, 4 functions
- `src/sidepanel/hooks/useLiveSync.ts` — 202 lines, 7 functions
- `src/sidepanel/hooks/useNotes.ts` — 95 lines, 3 functions
- `src/sidepanel/hooks/usePlan.ts` — 187 lines, 14 functions
- `src/sidepanel/hooks/useQuestions.ts` — 127 lines, 6 functions
- `src/sidepanel/hooks/useRemoteSessions.ts` — 75 lines, 3 functions
- `src/sidepanel/hooks/useRemoteTranscript.ts` — 97 lines, 2 functions
- `src/sidepanel/hooks/useSession.ts` — 88 lines, 6 functions
- `src/sidepanel/hooks/useTranscript.ts` — 577 lines, 28 functions
- `src/sidepanel/main.tsx` — 12 lines, 0 functions
- `src/vite-env.d.ts` — 23 lines, 0 functions
- `vite.config.ts` — 41 lines, 0 functions

---
*Auto-generated by MeetNotes · regenerate from the Code Graph view*