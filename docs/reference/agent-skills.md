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
| `comment-gitlab-issue` | `write` |  | `extension/llm_agent/internal/skills/comment-gitlab-issue.md` |
| `create-gitlab-issue` | `write` |  | `extension/llm_agent/internal/skills/create-gitlab-issue.md` |
| `search-kb` | `read` |  | `extension/llm_agent/internal/skills/search-kb.md` |
| `trigger-review-code` | `write` |  | `extension/llm_agent/internal/skills/trigger-review-code.md` |
| `update-file` | `write` |  | `extension/llm_agent/global/update-file.md` |
