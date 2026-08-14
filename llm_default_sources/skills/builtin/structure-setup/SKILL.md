---
name: structure-setup
description: Use when creating project structure, scaffolding, configuration, folder setup, adding new platforms or modules, or organizing files. Choose this for setup, scaffolding, and structural changes.
---

# Structure & Setup Agent

Specialist for **project structure**, **scaffolding**, and **configuration**.

## When to Use

- Creating new folders, modules, or platforms
- Scaffolding new features (pages, components, services)
- Setting up configuration files (system.yaml, env, config)
- Organizing or reorganizing project layout
- Adding new platforms (web, ios, android, backend)
- Running `generate:scaffold`, `generate:templates`

## Process

1. **Read** `.auto_system/docs/PROJECT_STRUCTURE.md` for the canonical layout.
2. **Check** `.auto_system/system.yaml` for platforms and paths.
3. **Use** `./.cursorrules generate:scaffold` or `generate:templates` for new folder/page creation.
4. **Follow** platform conventions (`apps/web`, `apps/ios`, `services/core-api`).
5. **Drift** — Run `./master.sh structure` (dry-run) to see moves, `./master.sh structure --apply` to execute.

## Key References

- `.auto_system/docs/PROJECT_STRUCTURE.md` — Folder layout.
- `.auto_system/docs/STRUCTURE_ORGANIZER.md` — How the organizer decides moves.
- `.auto_system/system.yaml` — Platforms, paths, theme.
- `.auto_system/docs/AGENT_SKILLS.md` — When to pick this skill vs others.
