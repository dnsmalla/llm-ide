---
name: add-code
description: Use when adding new features, implementing new code, creating new components, pages, API endpoints, or functionality. Choose this for feature implementation.
---

# Add Code Agent

Specialist for **implementing new features** and **adding code**.

## When to Use

- Adding new pages, components, or screens
- Implementing new API endpoints or services
- Creating new UI elements or flows
- Adding new database entities or migrations
- Implementing business logic
- Integrating new libraries or APIs

## Process

1. **Doc-first** — Update the relevant doc under `.auto_system/docs/` before writing code. See `DOC_GENERATION_FLOW.md`.
2. **Run compliance** — `./.cursorrules compliance` before and after your change.
3. **Use design tokens** — `var(--color-primary)` (web), `DesignSystem.Colors.primary` (iOS), `DesignTokens.Colors.Primary` (Android). Never hardcode hex or px.
4. **Follow the platform structure** — `.auto_system/docs/PROJECT_STRUCTURE.md` for folders; `REUSABLE_PATTERNS.md` for component composition.
5. **Use the 10/10 checklist** — `.auto_system/docs/QUALITY_STANDARDS.md` (press states, skeletons, empty states, image attrs).

## Key References

- `AGENT_GUIDE.md` — Design system, 10/10 checklist, cascade strategy.
- `.auto_system/docs/ESSENTIAL_PAGES_TEMPLATE.md` — Auth, profile, legal, support pages.
- `.auto_system/docs/AUTH_SYSTEM.md` — Default auth API contract.
- `.auto_system/docs/REUSABLE_PATTERNS.md` — Shared components, API layer, empty/loading states.
- `.auto_system/docs/INDEX.md` — Full documentation map.
