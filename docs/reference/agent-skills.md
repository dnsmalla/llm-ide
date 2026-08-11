---
title: Agent skills
source: extension/llm_agent/**/*.md
---

<!-- generated from extension/llm_agent/**/*.md — do not edit by hand -->

# Agent skills

Every skill available to the Code Assistant and internal agent.
A skill is a Markdown file under `extension/llm_agent/` whose
frontmatter declares both `name` and `kind`.

| Name | Kind | Description | File |
|---|---|---|---|
| `ask-internal` | `read` |  | `extension/llm_agent/global/ask-internal.md` |
| `ask-subagent` | `read` |  | `extension/llm_agent/global/ask-subagent.md` |
| `bash` | `write` |  | `extension/llm_agent/global/bash.md` |
| `comment-gitlab-issue` | `write` |  | `extension/llm_agent/internal/skills/comment-gitlab-issue.md` |
| `create-gitlab-issue` | `write` |  | `extension/llm_agent/internal/skills/create-gitlab-issue.md` |
| `fetch-url` | `read` |  | `extension/llm_agent/global/fetch-url.md` |
| `find-code` | `read` | Search the project's code index and graph for a symbol, file, or feature — returns definition sites with file:line, graph-related code (callers, callees, importers), and full-text hits. Use this before any grep. | `extension/llm_agent/global/find-code.md` |
| `git-op` | `write` |  | `extension/llm_agent/global/git-op.md` |
| `list-files` | `read` |  | `extension/llm_agent/global/list-files.md` |
| `read-file` | `read` |  | `extension/llm_agent/global/read-file.md` |
| `run-bash` | `read` |  | `extension/llm_agent/global/run-bash.md` |
| `search-kb` | `read` |  | `extension/llm_agent/global/search-kb.md` |
| `search-kb` | `read` |  | `extension/llm_agent/internal/skills/search-kb.md` |
| `task-create` | `read` |  | `extension/llm_agent/global/task-create.md` |
| `task-list` | `read` |  | `extension/llm_agent/global/task-list.md` |
| `task-update` | `read` |  | `extension/llm_agent/global/task-update.md` |
| `trigger-review-code` | `write` |  | `extension/llm_agent/internal/skills/trigger-review-code.md` |
| `update-file` | `write` |  | `extension/llm_agent/global/update-file.md` |
| `web-search` | `read` |  | `extension/llm_agent/global/web-search.md` |
