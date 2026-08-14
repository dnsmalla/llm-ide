---
name: documentation
description: Use when writing or updating documentation—README, API docs, guides, inline comments, docstrings, or markdown. Choose this for any documentation task.
---

# Documentation Agent

Specialist for **writing and updating documentation**.

## When to Use

- Writing or updating README, guides, or API docs
- Adding inline comments or docstrings
- Creating or updating docs in `docs/`
- Documenting processes, flows, or architecture
- Updating `.auto_system/docs/` templates
- Doc-first flow: update doc before code

## Process

1. **Start at the index** — `.auto_system/docs/INDEX.md` maps the documentation set; find the closest existing doc before creating a new one.
2. **Format** — Markdown, clear headings, code blocks when needed.
3. **Doc-first** — For code changes, update the doc first, then run `./.cursorrules sync` so generators pick up the new state.
4. **Structure** — Keep host-project docs grouped by topic (auth, deploy, testing, etc.); do not invent numbered folders unless the project already uses them.

## Key References

- `.auto_system/docs/INDEX.md` — Full documentation map.
- `.auto_system/docs/DOC_GENERATION_FLOW.md` — Doc-first flow.
- `.auto_system/docs/GENERATION_CONTROLS.md` — What each generator reads.
