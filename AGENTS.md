# Agent Guidelines — Moved

The content of this file has been split into two locations in the docs site:

- **Operational rules — "do not regress these fixes":** [docs/explanation/invariants.md](docs/explanation/invariants.md)
- **Decisions and rationale:** [docs/decisions/](docs/decisions/) (ADRs 0001–0015)
- **Caption-scraper philosophy and history:** [docs/explanation/caption-capture.md](docs/explanation/caption-capture.md)
- **Skills for Claude / Cursor / Codex / …:** [docs/how-to/install-central-skills.md](docs/how-to/install-central-skills.md) — kit lives in the `.skills` submodule

If you are an automated agent looking for the "do not change these things" list, [invariants.md](docs/explanation/invariants.md) is what you want.

Process skills are **not** edited in this repo. Author them in [dnsmalla/skills](https://github.com/dnsmalla/skills), bump `.skills`, then run `bash scripts/install-skills.sh`.
