# Parity inventory (Swift labels vs desktop code)

Generated 2026-11-02 by `node scripts/parity-inventory.mjs <area> --md` (test: `desktop/scripts/parity-inventory.test.mjs`).
It lists every user-visible literal in the Mac's SwiftUI views (buttons, menus, toggles, fields, section titles,
tooltips, alerts, accessibility text, static text, shortcuts) and checks whether the same text exists in the
matching desktop source. **A miss is a worklist item, not always a bug:** it can be a Mac-only feature (the
git/PR/issue sheets inside Chat, Loop worktrees, Sparkle), a reworded label, or text built at runtime. A hit
proves the label exists, not that it behaves like the Mac. Regenerate after parity work and compare the counts.

| area | Swift labels | exact in desktop | only inside a longer sentence | missing |
|---|---|---|---|---|
| [explorer](explorer.md) | 107 | 35 | 6 | 66 |
| [chat](chat.md) | 253 | 53 | 6 | 194 |
| [library](library.md) | 88 | 27 | 1 | 60 |
| [extensions](extensions.md) | 204 | 50 | 8 | 146 |
| [docgen](docgen.md) | 65 | 23 | 4 | 38 |
| [graph](graph.md) | 26 | 9 | 4 | 13 |
| [issues](issues.md) | 71 | 18 | 3 | 50 |
| [loop](loop.md) | 177 | 35 | 7 | 135 |
| [autotask](autotask.md) | 102 | 30 | 4 | 68 |
| [settings](settings.md) | 186 | 76 | 10 | 100 |
| [shell](shell.md) | 77 | 29 | 4 | 44 |
